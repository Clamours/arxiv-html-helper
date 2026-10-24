/**
 * 从原 PDF 取图（MinerU 截的 jpg 分辨率低、有压缩损失）。导入时 PDF 就在手里，用 pdf.js：
 *
 * - MinerU 截了图的：按 MinerU 记录的截图位置（页码、区域）在 PDF 里取同一块区域
 * - MinerU 没识别出来的图：MinerU 偶尔会把整张图当成文字区域（只 OCR 出图里的几行字，不输出图片），
 *   Markdown 里只剩下 "Figure N:" 图注。在 PDF 里找到这条图注，取图注所在栏里、图注上方（找不到再看下方）
 *   到最近一行正文之间的图
 *
 * 区域里只有一张嵌入位图、并且它就是整张图时，直接取原图（无损）；否则（矢量图、多张位图拼成的图、
 * 位图上叠加了文字）把这块区域高分辨率渲染成图片。
 *
 * 坐标都是 PDF 用户空间（单位 pt，原点在左下角，y 向上）。定位逻辑是纯函数，方便测试；
 * pdf.js 由调用方传入（浏览器里用带 worker 的版本，测试里用 Node 版）。
 */
import { zlibSync } from 'fflate';
import type * as PdfJs from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import { dataUrl } from './bundle';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextLine extends Box {
  text: string;
  /** 字号 */
  size: number;
  /** 旋转的文字（坐标轴标签等）单独成行，不参与分栏判断 */
  rotated: boolean;
}

export interface PlacedImage extends Box {
  /** pdf.js 里的对象名 */
  name: string;
  flipX: boolean;
  flipY: boolean;
  /** 旋转放置的图片不能直接取原图，只能渲染 */
  rotated: boolean;
}

export interface PageModel {
  view: Box;
  lines: TextLine[];
  images: PlacedImage[];
  /** 描边、填充的路径（不含只用来裁剪的路径） */
  paths: Box[];
}

export interface FigureLocation {
  /** 要截取的区域 */
  crop: Box;
  /** 整张图就是这一张嵌入位图时才有 */
  image?: PlacedImage;
}

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

const width = (b: Box) => b.x1 - b.x0;
const height = (b: Box) => b.y1 - b.y0;
const area = (b: Box) => Math.max(0, width(b)) * Math.max(0, height(b));

function intersect(a: Box, b: Box): Box {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
}

function union(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

const inside = (b: Box, r: Box, tol = 2) => b.x0 >= r.x0 - tol && b.x1 <= r.x1 + tol && b.y0 >= r.y0 - tol && b.y1 <= r.y1 + tol;
const overlapX = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
const grow = (b: Box, d: number): Box => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });
/** 竖直方向相距不超过 d（同一栏里左右并排的内容总是同一张图，水平方向不限） */
const nearV = (a: Box, b: Box, d: number) => a.y0 <= b.y1 + d && b.y0 <= a.y1 + d;

/** 仿射矩阵 a·b（先 b 后 a），和 PDF 的 cm 运算符一致 */
export function mul(a: number[], b: number[]): number[] {
  return [
    a[0]! * b[0]! + a[2]! * b[1]!,
    a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!,
    a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
    a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ];
}

function transformBox(m: number[], b: Box): Box {
  const pts = [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ].map(([x, y]) => [m[0]! * x! + m[2]! * y! + m[4]!, m[1]! * x! + m[3]! * y! + m[5]!] as const);
  return {
    x0: Math.min(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])),
    y1: Math.max(...pts.map((p) => p[1])),
  };
}

// ---------------------------------------------------------------------------
// 文字行
// ---------------------------------------------------------------------------

/** pdf.js getTextContent 的一项 */
export interface RawText {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** 把文字项按行合并：同一基线、从左到右紧挨着的项算一行（两栏之间的大间隔会断开） */
export function buildLines(items: RawText[]): TextLine[] {
  const lines: (TextLine & { base: number })[] = [];
  let cur: (TextLine & { base: number }) | null = null;
  for (const it of items) {
    const str = it.str;
    if (!str.trim()) continue;
    const t = it.transform;
    const h = it.height || Math.hypot(t[2]!, t[3]!);
    const rotated = Math.abs(t[1]!) > 1e-3 || Math.abs(t[2]!) > 1e-3 || t[0]! < 0;
    if (rotated) {
      const n = Math.hypot(t[0]!, t[1]!) || 1;
      const u = [t[0]! / n, t[1]! / n];
      const v = [-u[1]!, u[0]!];
      const xs = [0, it.width * u[0]!, h * v[0]!, it.width * u[0]! + h * v[0]!].map((d) => t[4]! + d);
      const ys = [0, it.width * u[1]!, h * v[1]!, it.width * u[1]! + h * v[1]!].map((d) => t[5]! + d);
      lines.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), text: str, size: h, rotated, base: t[5]! });
      cur = null;
      continue;
    }
    const x0 = t[4]!;
    const base = t[5]!;
    const box = { x0, x1: x0 + it.width, y0: base - 0.22 * h, y1: base + 0.78 * h };
    const tol = Math.max(h, cur?.size ?? 0);
    if (cur && Math.abs(base - cur.base) < 0.5 * tol && x0 >= cur.x1 - 2 && x0 - cur.x1 < 1.5 * tol) {
      cur.text += x0 - cur.x1 > 0.15 * h && !cur.text.endsWith(' ') && !str.startsWith(' ') ? ` ${str}` : str;
      cur.x1 = Math.max(cur.x1, box.x1);
      cur.y0 = Math.min(cur.y0, box.y0);
      cur.y1 = Math.max(cur.y1, box.y1);
      if (h > cur.size) {
        cur.size = h;
        cur.base = base;
      }
    } else {
      cur = { ...box, text: str, size: h, rotated: false, base };
      lines.push(cur);
    }
  }
  return lines.map(({ base: _, ...l }) => ({ ...l, text: l.text.trim() }));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Figure 1:"、"Fig. 1."、"图 1"；"Figure 1" 不会匹配 "Figure 10:" */
export function captionRegex(number: string): RegExp {
  const n = escapeRe(number);
  return new RegExp(String.raw`^(?:Figure|Fig\.?)\s*${n}\s*[:.|：]|^图\s*${n}(?:\s|[:：.]|$)`, 'i');
}

/** 任何图注、表注（用来挡住相邻的另一张图） */
const ANY_CAPTION = /^(?:Figure|Fig\.?|Table|Algorithm)\s*[A-Z]?\.?\d+(?:\.\d+)?\s*[:.|：]|^[图表]\s*\d+/i;
/** 带编号的节标题："4.4 Multi-Game…"、"B.2 Proofs"、"IV. Results" */
const HEADING = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}|[A-Z](?:\.\d{1,2}){1,3}|[IVX]{1,5})\.?\s+\p{Lu}/u;

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------

/** 页面的正文范围和栏 */
function layout(page: PageModel) {
  const flat = page.lines.filter((l) => !l.rotated && width(l) > 20);
  const left = flat.length ? Math.min(...flat.map((l) => l.x0)) : page.view.x0;
  const right = flat.length ? Math.max(...flat.map((l) => l.x1)) : page.view.x1;
  const mid = (left + right) / 2;
  const long = flat.filter((l) => width(l) > 0.25 * (right - left));
  const crossing = long.filter((l) => l.x0 < mid - 10 && l.x1 > mid + 10).length;
  const singleColumn = long.length > 0 && crossing / long.length > 0.5;
  // 正文行的宽度：两端对齐，最常见的宽度
  const counts = new Map<number, number>();
  for (const l of long) {
    const w = Math.round(width(l) / 4) * 4;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const bodyWidth = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? right - left;
  return { left, right, mid, singleColumn, bodyWidth };
}

/** 图注所在的栏（跨栏的图注对应跨栏的图） */
function columnOf(page: PageModel, cap: TextLine, lay: ReturnType<typeof layout>): Box {
  let { x0, x1 } = cap;
  // 图注的第二行能看出图注的真实宽度（第一行可能很短）
  for (const l of page.lines) {
    if (l !== cap && !l.rotated && l.y1 <= cap.y0 + 1 && cap.y0 - l.y1 < cap.size && Math.abs(l.x0 - cap.x0) < cap.size * 3) {
      x0 = Math.min(x0, l.x0);
      x1 = Math.max(x1, l.x1);
    }
  }
  const full = { x0: lay.left, x1: lay.right, y0: page.view.y0, y1: page.view.y1 };
  if (lay.singleColumn || (x0 < lay.mid - 15 && x1 > lay.mid + 15)) return full;
  return (x0 + x1) / 2 < lay.mid ? { ...full, x1: lay.mid } : { ...full, x0: lay.mid };
}

export function locateFigure(page: PageModel, number: string): FigureLocation | null {
  const re = captionRegex(number);
  const lay = layout(page);
  for (const cap of page.lines.filter((l) => !l.rotated && re.test(l.text))) {
    const col = columnOf(page, cap, lay);
    const loc = search(page, cap, col, lay, 'above') ?? search(page, cap, col, lay, 'below');
    if (loc) return loc;
  }
  return null;
}

function search(
  page: PageModel,
  cap: TextLine,
  col: Box,
  lay: ReturnType<typeof layout>,
  dir: 'above' | 'below',
): FigureLocation | null {
  const colW = width(col);
  const inCol = (l: Box) => overlapX(l, col) > 0;
  /** 正文行、其他图注、跨出本栏的行：图不会越过它们 */
  const isBarrier = (l: TextLine) =>
    !l.rotated &&
    l !== cap &&
    (ANY_CAPTION.test(l.text) || HEADING.test(l.text) || l.x0 < col.x0 - 3 || l.x1 > col.x1 + 3 || width(l) >= 0.6 * colW || width(l) >= 0.85 * lay.bodyWidth);
  const flat = page.lines.filter((l) => !l.rotated && inCol(l));

  let region: Box;
  if (dir === 'above') {
    const bottom = cap.y1;
    let barrier = flat.filter((l) => l.y0 > bottom - 1 && isBarrier(l)).sort((a, b) => a.y0 - b.y0)[0];
    // 段落的最后一行可能很短：沿着行距往下，把紧挨着的行也算作正文
    for (let next = barrier; next; ) {
      barrier = next;
      const b = barrier;
      next = flat.find((l) => l.y1 <= b.y0 + 1 && l.y1 > bottom && b.y0 - l.y1 < 0.7 * b.size && Math.abs(l.size - b.size) < 0.6 && Math.abs(l.x0 - b.x0) < 2 * b.size);
    }
    region = { x0: col.x0, x1: col.x1, y0: bottom, y1: barrier ? barrier.y0 : page.view.y1 };
  } else {
    // 图注可能有好几行：从图注段落的最后一行往下找
    let last = cap;
    for (let next: TextLine | undefined = cap; next; ) {
      last = next;
      const b = last;
      next = flat.find((l) => l.y1 <= b.y0 + 1 && b.y0 - l.y1 < 0.7 * b.size && Math.abs(l.size - b.size) < 0.6);
    }
    const top = last.y0;
    const barrier = flat.filter((l) => l.y1 < top + 1 && l !== last && isBarrier(l)).sort((a, b) => b.y1 - a.y1)[0];
    region = { x0: col.x0, x1: col.x1, y0: barrier ? barrier.y1 : page.view.y0, y1: top };
  }
  if (height(region) < 15) return null;

  // 图形：位图和路径（大部分在区域内的）
  const images = page.images.filter((im) => width(im) >= 8 && height(im) >= 8 && area(intersect(im, region)) >= 0.6 * area(im));
  const paths = page.paths.filter((p) => inside(p, region) && (width(p) > 0.5 || height(p) > 0.5));
  if (!images.length && !paths.length) return null;
  // 从离图注最近的图形开始，把上下挨得近的图形和文字（坐标轴、图例、子图注）逐步并进来；
  // 离得远的（页眉、页眉下的横线、区域里别的内容）不算
  const gap = (b: Box) => (dir === 'above' ? b.y0 - region.y0 : region.y1 - b.y1);
  const graphics: Box[] = [...images, ...paths].sort((a, b) => gap(a) - gap(b));
  let crop = graphics[0]!;
  const texts = page.lines.filter((l) => inside(l, region) && !isBarrier(l));
  const reach = Math.max(12, 1.5 * cap.size);
  const pending: { box: Box; reach: number }[] = [
    ...graphics.slice(1).map((box) => ({ box, reach })),
    ...texts.map((box) => ({ box, reach: 1.5 * box.size })),
  ];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const { box, reach: r } = pending[i]!;
      if (!nearV(box, crop, r)) continue;
      crop = union([crop, box]);
      pending.splice(i, 1);
      changed = true;
    }
  }
  crop = intersect(grow(crop, 2), region);
  if (width(crop) < 30 || height(crop) < 20) return null;

  const main = images.filter((im) => area(intersect(im, crop)) > 0);
  const image = main.length === 1 && !main[0]!.rotated && area(intersect(main[0]!, crop)) >= 0.85 * area(crop) ? main[0] : undefined;
  return image ? { crop, image } : { crop };
}

/** MinerU 截图的区域：区域里只有一张嵌入位图、没有别的文字和图形时取原图，否则渲染 */
export function regionFigure(page: PageModel, crop: Box): FigureLocation {
  const hits = page.images.filter((im) => area(intersect(im, crop)) > 0.05 * area(crop));
  const im = hits.length === 1 ? hits[0]! : undefined;
  if (!im || im.rotated) return { crop };
  // 区域只是一张大图的一部分，或者位图只占区域的一小块
  const common = area(intersect(im, crop));
  if (common < 0.85 * area(im) || common < 0.7 * area(crop)) return { crop };
  // 位图旁边的坐标轴、图例，叠加在位图上的文字、标注，原图里都没有；位图的边框、背景不算
  const core = grow(im, -2);
  const touches = (b: Box) => b.x0 < core.x1 && b.x1 > core.x0 && b.y0 < core.y1 && b.y1 > core.y0;
  const text = page.lines.some((l) => area(intersect(l, crop)) > 0.5 * area(l));
  const graphics = page.paths.some((p) => (touches(p) && area(p) < 0.9 * area(im)) || (inside(p, crop, 0) && !inside(p, im)));
  return text || graphics ? { crop } : { crop, image: im };
}

// ---------------------------------------------------------------------------
// 读取页面
// ---------------------------------------------------------------------------

type Lib = Pick<typeof PdfJs, 'getDocument' | 'OPS' | 'ImageKind'>;

/** 只读文字（先用它找图注，找到了再读绘图指令） */
async function pageLines(page: PDFPageProxy): Promise<TextLine[]> {
  const tc = await page.getTextContent();
  return buildLines(tc.items.filter((i) => 'str' in i) as RawText[]);
}

async function pageModel(lib: Lib, page: PDFPageProxy, lines: TextLine[]): Promise<PageModel> {
  const [vx0, vy0, vx1, vy1] = page.view as [number, number, number, number];
  const ops = await page.getOperatorList();
  const O = lib.OPS;
  const images: PlacedImage[] = [];
  const paths: Box[] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    switch (fn) {
      case O.save:
        stack.push(m);
        break;
      case O.restore:
        m = stack.pop() ?? m;
        break;
      case O.transform:
        m = mul(m, args as number[]);
        break;
      case O.paintFormXObjectBegin:
        stack.push(m);
        if (Array.isArray(args[0])) m = mul(m, args[0] as number[]);
        break;
      case O.paintFormXObjectEnd:
        m = stack.pop() ?? m;
        break;
      case O.paintImageXObject: {
        const box = transformBox(m, { x0: 0, y0: 0, x1: 1, y1: 1 });
        images.push({ ...box, name: String(args[0]), flipX: m[0]! < 0, flipY: m[3]! < 0, rotated: Math.abs(m[1]!) > 1e-6 || Math.abs(m[2]!) > 1e-6 });
        break;
      }
      case O.constructPath: {
        // [绘制方式, 路径数据, 外框]；只用来裁剪的路径（endPath）不算
        const mm = args[2] as ArrayLike<number> | null | undefined;
        if (args[0] !== O.endPath && mm && mm.length === 4 && Number.isFinite(mm[0])) {
          paths.push(transformBox(m, { x0: mm[0]!, y0: mm[1]!, x1: mm[2]!, y1: mm[3]! }));
        }
        break;
      }
    }
  }
  return { view: { x0: vx0, y0: vy0, x1: vx1, y1: vy1 }, lines, images, paths };
}

// ---------------------------------------------------------------------------
// 输出图片
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  const view = new DataView(head.buffer);
  view.setUint32(0, data.length);
  const name = new TextEncoder().encode(type);
  head.set(name, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(head);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32([name, data]));
  return out;
}

/**
 * 像素 → PNG（无损；不依赖 canvas，Node 里也能用）。channels：1 灰度、3 RGB、4 RGBA。
 * 每行在 None / Sub / Up / Paeth 里选差值最小的滤波方式
 */
export function encodePng(w: number, h: number, channels: 1 | 3 | 4, data: Uint8Array | Uint8ClampedArray, flipX = false, flipY = false): Uint8Array {
  const stride = w * channels;
  const row = (y: number) => {
    const src = flipY ? h - 1 - y : y;
    const r = data.subarray(src * stride, src * stride + stride);
    if (!flipX) return r;
    const out = new Uint8Array(stride);
    for (let x = 0; x < w; x++) out.set(r.subarray((w - 1 - x) * channels, (w - x) * channels), x * channels);
    return out;
  };
  const raw = new Uint8Array((stride + 1) * h);
  const cand = [0, 1, 2, 4].map(() => new Uint8Array(stride));
  let prev: Uint8Array | Uint8ClampedArray = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const cur = row(y);
    let best = 0;
    let bestSum = Infinity;
    cand.forEach((buf, k) => {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels]! : 0;
        const b = prev[i]!;
        const c = i >= channels ? prev[i - channels]! : 0;
        let pred = 0;
        if (k === 1) pred = a;
        else if (k === 2) pred = b;
        else if (k === 3) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur[i]! - pred) & 0xff;
        buf[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = k;
      }
    });
    raw[y * (stride + 1)] = [0, 1, 2, 4][best]!;
    raw.set(cand[best]!, y * (stride + 1) + 1);
    prev = cur;
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface ImageObject {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
}

/** 取嵌入位图的原始像素，编码成 PNG；拿不到像素（1 位黑白图等）时返回 null，改为渲染 */
async function embeddedPng(lib: Lib, page: PDFPageProxy, im: PlacedImage): Promise<Uint8Array | null> {
  const store = im.name.startsWith('g_') ? page.commonObjs : page.objs;
  const obj = await new Promise<ImageObject | null>((resolve) => {
    try {
      store.get(im.name, (o: unknown) => resolve((o as ImageObject | null) ?? null));
    } catch {
      resolve(null);
    }
  });
  if (!obj?.data || !obj.width || !obj.height) return null;
  const { width: w, height: h, data } = obj;
  let channels: 3 | 4;
  if (obj.kind === lib.ImageKind.RGB_24BPP && data.length === w * h * 3) channels = 3;
  else if (obj.kind === lib.ImageKind.RGBA_32BPP && data.length === w * h * 4) channels = 4;
  else return null;
  if (channels === 4) {
    // 完全不透明时去掉 alpha 通道，文件小一些
    let opaque = true;
    for (let i = 3; i < data.length && opaque; i += 4) opaque = data[i] === 255;
    if (opaque) {
      const rgb = new Uint8Array(w * h * 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) rgb.set(data.subarray(i, i + 3), j);
      return encodePng(w, h, 3, rgb, im.flipX, im.flipY);
    }
  }
  return encodePng(w, h, channels, data, im.flipX, im.flipY);
}

export interface CanvasLike {
  width: number;
  height: number;
  toDataURL(type?: string): string;
}

/** 把页面上的一块区域渲染成 PNG（data: URL） */
async function renderCrop(page: PDFPageProxy, crop: Box, createCanvas: (w: number, h: number) => CanvasLike): Promise<{ url: string; w: number; h: number }> {
  // 至少 216 dpi（MinerU 截图约 200 dpi），宽度一般在 1800 像素左右
  const scale = Math.min(4, Math.max(3, 1800 / width(crop)));
  const base = page.getViewport({ scale });
  const [ax, ay] = base.convertToViewportPoint(crop.x0, crop.y1);
  const [bx, by] = base.convertToViewportPoint(crop.x1, crop.y0);
  const left = Math.min(ax, bx);
  const top = Math.min(ay, by);
  const w = Math.ceil(Math.abs(bx - ax));
  const h = Math.ceil(Math.abs(by - ay));
  const viewport = page.getViewport({ scale, offsetX: -left, offsetY: -top });
  const canvas = createCanvas(w, h);
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
  return { url: canvas.toDataURL('image/png'), w, h };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface RecoveredFigure {
  dataUrl: string;
  width: number;
  height: number;
  /** embedded：PDF 里的原图；rendered：渲染页面区域 */
  how: 'embedded' | 'rendered';
  page: number;
}

export interface RecoverOptions {
  lib: Lib;
  /**
   * pdf.js 的数据文件（以 / 结尾的地址）：未嵌入的标准字体、中日韩字体的 CMap、JPEG 2000 / JBIG2 解码器。
   * 缺少时这类 PDF 的文字、图片画不出来
   */
  dataUrls?: { standardFonts: string; cMaps: string; wasm: string };
  /** 渲染区域用；不提供时只能取嵌入位图 */
  createCanvas?: (w: number, h: number) => CanvasLike;
}

/** MinerU 截图的位置 */
export interface RegionRequest {
  key: string;
  /** 页码，从 0 开始 */
  page: number;
  /** 在页面上的相对位置（0–1），原点在左上角，和页面显示的方向一致 */
  box: Box;
}

export interface FigureRequest {
  regions: RegionRequest[];
  /** MinerU 没识别出来的图的图号 */
  numbers: string[];
}

export interface PdfFigures {
  /** key → 图 */
  regions: Map<string, RecoveredFigure>;
  /** 图号 → 图 */
  numbers: Map<string, RecoveredFigure>;
}

/** 嵌入位图编码后超过这个大小时改为渲染（渲染的分辨率有上限） */
const MAX_EMBEDDED_BYTES = 4 * 1024 * 1024;

/** 相对位置 → PDF 用户空间（考虑页面旋转和裁剪框） */
function pdfBox(page: PDFPageProxy, r: Box): Box {
  const vp = page.getViewport({ scale: 1 });
  const [ax, ay] = vp.convertToPdfPoint(r.x0 * vp.width, r.y0 * vp.height) as [number, number];
  const [bx, by] = vp.convertToPdfPoint(r.x1 * vp.width, r.y1 * vp.height) as [number, number];
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

async function figureAt(page: PDFPageProxy, p: number, loc: FigureLocation, opts: RecoverOptions): Promise<RecoveredFigure | null> {
  if (loc.image) {
    const png = await embeddedPng(opts.lib, page, loc.image).catch(() => null);
    if (png && png.length <= MAX_EMBEDDED_BYTES) {
      const size = new DataView(png.buffer, png.byteOffset + 16, 8);
      return { dataUrl: dataUrl(png, 'image/png'), width: size.getUint32(0), height: size.getUint32(4), how: 'embedded', page: p };
    }
  }
  if (!opts.createCanvas) return null;
  const r = await renderCrop(page, loc.crop, opts.createCanvas).catch(() => null);
  return r && { dataUrl: r.url, width: r.w, height: r.h, how: 'rendered', page: p };
}

/** 按截图位置、图号在 PDF 里取图；取不到的不在结果里 */
export async function extractFigures(pdf: Uint8Array, req: FigureRequest, opts: RecoverOptions): Promise<PdfFigures> {
  const out: PdfFigures = { regions: new Map(), numbers: new Map() };
  const wanted = new Set(req.numbers);
  const byPage = new Map<number, RegionRequest[]>();
  for (const r of req.regions) byPage.set(r.page + 1, [...(byPage.get(r.page + 1) ?? []), r]);
  if (!wanted.size && !byPage.size) return out;
  // getDocument 会转移 data 的 ArrayBuffer，传一份副本
  const doc = await opts.lib.getDocument({
    data: new Uint8Array(pdf),
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: 0,
    ...(opts.dataUrls
      ? { standardFontDataUrl: opts.dataUrls.standardFonts, cMapUrl: opts.dataUrls.cMaps, cMapPacked: true, wasmUrl: opts.dataUrls.wasm }
      : {}),
  }).promise;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const regions = byPage.get(p) ?? [];
      if (!regions.length && !wanted.size) continue;
      const page = await doc.getPage(p);
      const lines = await pageLines(page);
      const here = [...wanted].filter((n) => lines.some((l) => !l.rotated && captionRegex(n).test(l.text)));
      if (!regions.length && !here.length) continue;
      const model = await pageModel(opts.lib, page, lines);
      for (const r of regions) {
        const fig = await figureAt(page, p, regionFigure(model, grow(pdfBox(page, r.box), 1)), opts);
        if (fig) out.regions.set(r.key, fig);
      }
      for (const n of here) {
        const loc = locateFigure(model, n);
        const fig = loc && (await figureAt(page, p, loc, opts));
        if (fig) {
          out.numbers.set(n, fig);
          wanted.delete(n);
        }
      }
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
