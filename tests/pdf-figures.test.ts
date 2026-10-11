import { strToU8, unzlibSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildPageFromZip } from '../src/import/bundle';
import {
  buildLines,
  captionRegex,
  encodePng,
  locateFigure,
  type Box,
  type PageModel,
  type PlacedImage,
  type TextLine,
} from '../src/import/pdf-figures';

// 合成页面：US Letter 两栏（左栏 54–292，右栏 320–558），坐标原点在左下角
const line = (text: string, x0: number, y: number, x1: number, size = 10): TextLine => ({
  text,
  x0,
  x1,
  y0: y - 0.22 * size,
  y1: y + 0.78 * size,
  size,
  rotated: false,
});
const image = (x0: number, y0: number, x1: number, y1: number, name = 'img'): PlacedImage => ({ x0, y0, x1, y1, name, flipX: false, flipY: false, rotated: false });
const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });

/** 每栏若干行正文（两端对齐，宽度相同） */
function body(col: 'left' | 'right', fromY: number, toY: number): TextLine[] {
  const [x0, x1] = col === 'left' ? [54, 292] : [320, 558];
  const out: TextLine[] = [];
  for (let y = fromY; y >= toY; y -= 11) out.push(line('body text body text body text body text', x0, y, x1));
  return out;
}

const page = (p: Partial<PageModel>): PageModel => ({
  view: box(0, 0, 612, 792),
  lines: [],
  images: [],
  paths: [],
  ...p,
});

describe('图注匹配', () => {
  it.each([
    ['Figure 1: Overview.', '1', true],
    ['Fig. 1. Overview', '1', true],
    ['FIGURE 1 | Overview', '1', true],
    ['图 1 系统结构', '1', true],
    ['Figure 10: Overview.', '1', false],
    ['Figure 1 shows the pipeline', '1', false],
    ['As shown in Figure 1: x', '1', false],
    ['Figure A.1: Extra.', 'A.1', true],
  ])('%s', (text, n, ok) => {
    expect(captionRegex(n).test(text)).toBe(ok);
  });
});

describe('文字行', () => {
  const item = (str: string, x: number, y: number, w: number, h = 10) => ({ str, transform: [h, 0, 0, h, x, y], width: w, height: h });

  it('同一基线、紧挨着的项合成一行；两栏之间断开；上标并进来', () => {
    const lines = buildLines([
      item('Figure 1: Comparison', 320, 325, 150),
      item('Top:', 474, 325, 20),
      item('left column text', 54, 325, 200),
      item('Zishang Jiang', 130, 646, 72, 12),
      item('1', 202, 650, 4, 8),
      item(', Jinyi Han', 206, 646, 56, 12),
      item('   ', 300, 100, 5),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Figure 1: Comparison Top:', 'left column text', 'Zishang Jiang1, Jinyi Han']);
    expect(lines[0]).toMatchObject({ x0: 320, x1: 494 });
  });

  it('旋转的文字单独成行', () => {
    const [l] = buildLines([{ str: 'Accuracy (%)', transform: [0, 10, -10, 0, 60, 100], width: 50, height: 10 }]);
    expect(l).toMatchObject({ rotated: true, x0: 50, x1: 60, y0: 100, y1: 150 });
  });
});

describe('定位图', () => {
  it('两栏论文：右栏图注上方的嵌入位图，直接取原图（作者行跨栏，挡住上方）', () => {
    const fig = image(320, 343, 567, 563);
    const p = page({
      lines: [line('zsjiang24@m.fudan.edu.cn, liangjiaqing@fudan.edu.cn', 195, 575, 417), ...body('left', 536, 290), line('Figure 1: Comparison of different curriculum. Top: (1)', 320, 325, 558), ...body('right', 314, 100)],
      images: [fig],
    });
    const loc = locateFigure(p, '1')!;
    expect(loc.image).toBe(fig);
    expect(loc.crop.y0).toBeGreaterThanOrEqual(325);
    expect(loc.crop.y1).toBeLessThan(575);
  });

  it('矢量图：路径 + 坐标轴文字；离得远的页眉不算', () => {
    const p = page({
      lines: [
        line('Preprint. Under review.', 320, 740, 420, 8),
        ...body('left', 700, 100),
        line('Accuracy', 330, 500, 370, 8),
        line('Steps', 420, 395, 450, 8),
        line('Figure 2: Results.', 320, 370, 420),
        ...body('right', 350, 100),
      ],
      paths: [box(340, 405, 550, 600), box(340, 405, 550, 406), box(500, 560, 520, 580)],
    });
    const loc = locateFigure(p, '2')!;
    expect(loc.image).toBeUndefined();
    expect(loc.crop.y1).toBeLessThan(620); // 不含页眉
    expect(loc.crop.x0).toBeLessThanOrEqual(330); // 含坐标轴文字
    expect(loc.crop.y0).toBeLessThanOrEqual(395 - 0.22 * 8);
  });

  it('同一栏上下两张图：另一张图的图注挡住它', () => {
    const p = page({
      lines: [...body('left', 700, 100), line('Figure 2: Short.', 380, 560, 470), line('Figure 3: Also short.', 380, 380, 500), ...body('right', 360, 100)],
      paths: [box(330, 575, 550, 720), box(330, 395, 550, 545)],
    });
    const loc = locateFigure(p, '3')!;
    expect(loc.crop.y1).toBeLessThan(560);
  });

  it('节标题挡住上方的表格', () => {
    const p = page({
      lines: [line('Table 2: Scores.', 100, 740, 300), line('Beamrider 8672.4', 150, 700, 300), line('4.4 Multi-Game Results', 72, 640, 300, 12), line('Freeway Pong', 250, 600, 350, 8), line('Figure 4: Multi-game.', 200, 400, 400), line('A full width body line of text that spans the whole page', 72, 380, 540)],
      paths: [box(150, 690, 460, 691), box(150, 720, 460, 721), box(150, 420, 460, 590)],
    });
    const loc = locateFigure(p, '4')!;
    expect(loc.crop.y1).toBeLessThan(630);
  });

  it('段落的最后一行很短也算正文，不截进图里', () => {
    const p = page({
      lines: [...body('right', 700, 600), line('end.', 320, 589, 345), line('Figure 5: Fig.', 320, 380, 420), ...body('left', 700, 100)],
      paths: [box(330, 400, 550, 560)],
    });
    expect(locateFigure(p, '5')!.crop.y1).toBeLessThan(585);
  });

  it('图注在图上方时往下找', () => {
    const p = page({
      lines: [...body('left', 700, 100), ...body('right', 700, 600), line('Figure 6: Caption above.', 320, 580, 500), ...body('right', 380, 100)],
      paths: [box(330, 400, 550, 565)],
    });
    const loc = locateFigure(p, '6')!;
    expect(loc.crop.y1).toBeLessThan(580);
    expect(loc.crop.y0).toBeGreaterThan(380);
  });

  it('跨栏的大图：两栏的正文都是边界', () => {
    const p = page({
      lines: [...body('left', 700, 620), ...body('right', 700, 620), line('Figure 7: A figure spanning both columns, with a caption that crosses the gutter.', 54, 330, 558), ...body('left', 300, 100)],
      paths: [box(60, 350, 550, 600)],
    });
    const loc = locateFigure(p, '7')!;
    expect(loc.crop.x0).toBeLessThan(100);
    expect(loc.crop.x1).toBeGreaterThan(500);
    expect(loc.crop.y1).toBeLessThan(615);
  });

  it('没有图形、或者没有这条图注时返回 null', () => {
    expect(locateFigure(page({ lines: [...body('left', 700, 100), line('Figure 8: Nothing.', 320, 400, 420)] }), '8')).toBeNull();
    expect(locateFigure(page({ lines: [line('Figure 1 shows things.', 320, 400, 420)], paths: [box(330, 420, 550, 600)] }), '1')).toBeNull();
  });
});

/** 解码自己生成的 PNG（只支持 encodePng 用到的滤波方式），检查无损 */
function decodePng(png: Uint8Array): { w: number; h: number; channels: number; data: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset);
  let at = 8;
  let w = 0;
  let h = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = view.getUint32(at + 8);
      h = view.getUint32(at + 12);
      channels = { 0: 1, 2: 3, 6: 4 }[data[9]!]!;
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = unzlibSync(new Uint8Array(idat.flatMap((d) => [...d])));
  const stride = w * channels;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels]! : 0;
      const b = y ? out[(y - 1) * stride + i]! : 0;
      const c = y && i >= channels ? out[(y - 1) * stride + i - channels]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, 0, paeth][f]!;
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + pred) & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

describe('PNG', () => {
  it('无损，支持翻转', () => {
    const w = 37;
    const h = 23;
    const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 7 + (i % 13) * 31) & 0xff);
    const png = encodePng(w, h, 3, rgb);
    expect(Array.from(png.subarray(1, 4), (c) => String.fromCharCode(c)).join('')).toBe('PNG');
    expect(decodePng(png)).toEqual({ w, h, channels: 3, data: rgb });

    const flipped = decodePng(encodePng(w, h, 3, rgb, true, true)).data;
    const px = (d: Uint8Array, x: number, y: number) => Array.from(d.subarray((y * w + x) * 3, (y * w + x) * 3 + 3));
    expect(px(flipped, 0, 0)).toEqual(px(rgb, w - 1, h - 1));
    expect(px(flipped, 5, 2)).toEqual(px(rgb, w - 6, h - 3));

    const rgba = new Uint8Array(4 * 4 * 4).map((_, i) => i * 3);
    expect(decodePng(encodePng(4, 4, 4, rgba)).data).toEqual(rgba);
  });
});

describe('生成页面时补图', () => {
  const md = '# T\n\n## 1 X\n\n(1) Curriculum label\n\nFigure 1: Missing in MinerU.\n\nFigure 2: Also missing.\n\nText.';
  const zip = zipSync({ 'out/full.md': strToU8(md) });

  it('按图号补回图片；补不回来的仍只显示图注', async () => {
    const asked: string[][] = [];
    const built = await buildPageFromZip(document, zip, {
      paperId: 'pdf-0123456789abcdef0123',
      recoverFigures: async (numbers) => {
        asked.push(numbers);
        return new Map([['1', 'data:image/png;base64,iVBORw0KGgo=']]);
      },
    });
    expect(asked).toEqual([['1', '2']]);
    expect(built).toMatchObject({ recoveredFigures: 1, missingFigures: 1 });
    const doc = new DOMParser().parseFromString(built.html, 'text/html');
    expect(doc.getElementById('S1.F1')!.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(doc.getElementById('S1.F1')!.querySelector('.ltx_figure_missing')).toBeNull();
    expect(doc.getElementById('S1.F2')!.querySelector('.ltx_figure_missing')).not.toBeNull();
  });

  it('补图失败不影响生成页面', async () => {
    const built = await buildPageFromZip(document, zip, {
      paperId: 'pdf-0123456789abcdef0123',
      recoverFigures: () => Promise.reject(new Error('pdf.js failed')),
    });
    expect(built).toMatchObject({ recoveredFigures: 0, missingFigures: 2 });
  });
});
