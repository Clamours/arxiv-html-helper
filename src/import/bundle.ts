/**
 * MinerU 结果 zip → 单文件 HTML（图片内嵌为 data: URL）。
 * 生成的 HTML 就是这篇论文的最终版本：之后原样保存、写成本地文件、云同步，不再重新生成。
 */
import { unzipSync } from 'fflate';
import { allBlocks, parseMinerUMarkdown, type Block, type MinerUPaper } from './mineru';
import { standaloneHtml } from './page';
import type { Box, FigureRequest, RegionRequest } from './pdf-figures';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function dataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

const extOf = (path: string) => /\.([a-z0-9]+)(?:[?#]|$)/i.exec(path)?.[1]?.toLowerCase() ?? '';

/** 把 dir 下的相对路径规范化（去掉 ./ 和 ..） */
function joinPath(dir: string, rel: string): string {
  const out = dir ? dir.split('/') : [];
  for (const part of decodeURIComponent(rel).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/** 图片路径（含远程地址）的文件名，MinerU 用内容的哈希命名 */
const baseName = (path: string) => path.split(/[?#]/)[0]!.split('/').pop() ?? '';

const isNums = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

function walk(v: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) for (const x of v) walk(x, visit);
  else if (v && typeof v === 'object') {
    visit(v as Record<string, unknown>);
    for (const x of Object.values(v)) walk(x, visit);
  }
}

function parseJson(bytes: Uint8Array | undefined): unknown {
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * MinerU 截图在 PDF 里的位置：文件名 → 页码（从 0 开始）和相对位置（0–1，原点在左上角）。
 * - layout.json（middle.json）：pdf_info[页].page_size 是页面大小，image_path + bbox 的 span 是截图（单位和 page_size 相同）
 * - *_content_list.json：img_path、page_idx、bbox（0–1000）。早期版本的 bbox 是像素，有大于 1000 的值时整个文件不用
 */
export function imageRegions(files: Record<string, Uint8Array>): Map<string, Omit<RegionRequest, 'key'>> {
  const out = new Map<string, Omit<RegionRequest, 'key'>>();
  const add = (path: unknown, page: unknown, b: number[], w: number, h: number) => {
    if (typeof path !== 'string' || typeof page !== 'number' || !(page >= 0) || !(w > 0 && h > 0)) return;
    const box: Box = { x0: Math.max(0, b[0]! / w), y0: Math.max(0, b[1]! / h), x1: Math.min(1, b[2]! / w), y1: Math.min(1, b[3]! / h) };
    const name = baseName(path);
    if (name && box.x1 - box.x0 > 0.005 && box.y1 - box.y0 > 0.005 && !out.has(name)) out.set(name, { page, box });
  };
  const paths = Object.keys(files);
  for (const p of paths.filter((p) => /(^|\/)(layout|middle)\.json$/.test(p))) {
    const pages = (parseJson(files[p]) as { pdf_info?: unknown } | undefined)?.pdf_info;
    if (!Array.isArray(pages)) continue;
    pages.forEach((pg: { page_idx?: unknown; page_size?: unknown }, i) => {
      if (!isNums(pg?.page_size, 2)) return;
      const [w, h] = pg.page_size;
      const page = typeof pg.page_idx === 'number' ? pg.page_idx : i;
      walk(pg, (o) => {
        if (isNums(o.bbox, 4)) add(o.image_path, page, o.bbox, w!, h!);
      });
    });
  }
  for (const p of paths.filter((p) => /content_list\.json$/.test(p))) {
    const items = parseJson(files[p]);
    if (!Array.isArray(items)) continue;
    const boxes = items.filter((o: { img_path?: unknown; bbox?: unknown }) => typeof o?.img_path === 'string' && isNums(o.bbox, 4));
    if (boxes.some((o: { bbox: number[] }) => o.bbox.some((x) => x > 1000))) continue;
    for (const o of boxes) add(o.img_path, o.page_idx, o.bbox, 1000, 1000);
  }
  return out;
}

export interface BuiltPage {
  html: string;
  paper: MinerUPaper;
  /** 没能内嵌的图片（页面上不显示） */
  missingImages: number;
  /** 从原 PDF 重新取的图片 */
  pdfImages: number;
  /** 仍然用 MinerU 截图的图片（没有截图位置、或者 PDF 里取不到） */
  mineruImages: number;
  /** MinerU 没识别出图片、从原 PDF 补回的图 */
  recoveredFigures: number;
  /** 补不回来、只显示图注的图 */
  missingFigures: number;
}

export interface BuildOptions {
  paperId: string;
  /** 结果里引用了远程图片时用来下载；返回 null 表示下载失败 */
  fetchImage?: (url: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  /**
   * 从原 PDF 里取图：MinerU 截图所在区域的图（key 是图片路径），MinerU 没识别出来的图（按图号）。
   * 返回 key / 图号 → data: URL，取不到的不在结果里
   */
  fromPdf?: (req: FigureRequest) => Promise<{ regions: Map<string, string>; numbers: Map<string, string> }>;
}

export async function buildPageFromZip(doc: Document, zip: Uint8Array, opts: BuildOptions): Promise<BuiltPage> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new Error('解析结果不是有效的 zip 文件');
  }
  // full.md 可能在 zip 根目录，也可能在一层文件夹里；取路径最短的
  const mdPath = Object.keys(files)
    .filter((p) => p === 'full.md' || p.endsWith('/full.md'))
    .sort((a, b) => a.length - b.length)[0];
  if (!mdPath) throw new Error('解析结果里没有 full.md');
  const base = mdPath.slice(0, mdPath.lastIndexOf('/') + 1).replace(/\/$/, '');
  const paper = parseMinerUMarkdown(new TextDecoder().decode(files[mdPath]));

  // MinerU 截的图都换成从原 PDF 里取的（更清晰），取不到时用 MinerU 的截图。
  // 只有图注、没有图片的图：MinerU 把这张图当成了文字，也从原 PDF 里补回来（补不回来就只显示图注）
  const figures = allBlocks(paper).filter((b): b is Extract<Block, { kind: 'figure' }> => b.kind === 'figure');
  const panels = figures.flatMap((b) => b.panels);
  const orphans = figures.filter((b) => !b.panels.length && !!b.number);
  const located = imageRegions(files);
  const regions = new Map<string, RegionRequest>();
  for (const p of panels) {
    const r = located.get(baseName(p.src));
    if (r && !/^data:/i.test(p.src)) regions.set(p.src, { key: p.src, ...r });
  }
  let pdfImages = 0;
  let recoveredFigures = 0;
  if ((regions.size || orphans.length) && opts.fromPdf) {
    const found = await opts.fromPdf({ regions: [...regions.values()], numbers: [...new Set(orphans.map((b) => b.number!))] }).catch(() => null);
    for (const p of panels) {
      const url = found?.regions.get(p.src);
      if (!url) continue;
      p.src = url;
      pdfImages++;
    }
    for (const b of orphans) {
      const url = found?.numbers.get(b.number!);
      if (!url) continue;
      b.panels = [{ src: url, alt: '' }];
      recoveredFigures++;
    }
  }

  const images = new Map<string, string>();
  const srcs = new Set(allBlocks(paper).flatMap((b) => (b.kind === 'figure' ? b.panels.map((p) => p.src) : [])));
  await Promise.all(
    [...srcs].map(async (src) => {
      if (/^data:image\//i.test(src)) return images.set(src, src);
      if (/^https?:\/\//i.test(src)) {
        const got = await opts.fetchImage?.(src).catch(() => null);
        if (got) images.set(src, dataUrl(got.bytes, got.mime));
        return;
      }
      const bytes = files[joinPath(base, src)];
      if (bytes) images.set(src, dataUrl(bytes, MIME[extOf(src)] ?? 'image/jpeg'));
    }),
  );

  const html = standaloneHtml(doc, paper, { paperId: opts.paperId, resolveImage: (src) => images.get(src) ?? null });
  return {
    html,
    paper,
    missingImages: srcs.size - images.size,
    pdfImages,
    mineruImages: panels.length - pdfImages,
    recoveredFigures,
    missingFigures: orphans.length - recoveredFigures,
  };
}
