import { strToU8, unzlibSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildPageFromZip, imageRegions } from '../src/import/bundle';
import {
  buildLines,
  captionRegex,
  encodePng,
  locateFigure,
  regionFigure,
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

describe('MinerU 截图的区域', () => {
  const fig = image(320, 343, 567, 563);

  it('区域就是一张嵌入位图：取原图（MinerU 的框比位图略大或略小都行）', () => {
    expect(regionFigure(page({ images: [fig] }), box(318, 340, 569, 566)).image).toBe(fig);
    expect(regionFigure(page({ images: [fig] }), box(325, 350, 560, 560)).image).toBe(fig);
  });

  it('区域里还有坐标轴文字、多张位图，或者只是大图的一部分：渲染', () => {
    const withAxis = page({ images: [fig], lines: [line('Accuracy', 300, 450, 318, 8)] });
    expect(regionFigure(withAxis, box(290, 340, 569, 566)).image).toBeUndefined();
    const two = page({ images: [image(320, 343, 440, 563, 'a'), image(447, 343, 567, 563, 'b')] });
    expect(regionFigure(two, box(318, 340, 569, 566)).image).toBeUndefined();
    expect(regionFigure(page({ images: [fig] }), box(320, 343, 440, 563)).image).toBeUndefined();
  });

  it('位图上叠加了文字或标注：渲染；边框、背景不算', () => {
    const crop = box(318, 340, 569, 566);
    expect(regionFigure(page({ images: [fig], lines: [line('(a)', 400, 500, 415, 8)] }), crop).image).toBeUndefined();
    expect(regionFigure(page({ images: [fig], paths: [box(400, 450, 480, 450)] }), crop).image).toBeUndefined();
    expect(regionFigure(page({ images: [fig], paths: [box(320, 343, 567, 563), box(0, 0, 612, 792)] }), crop).image).toBe(fig);
  });

  it('没有位图（矢量图）：渲染整个区域', () => {
    const loc = regionFigure(page({ paths: [box(330, 400, 550, 560)] }), box(320, 390, 560, 570));
    expect(loc).toEqual({ crop: box(320, 390, 560, 570) });
  });
});

describe('读取 MinerU 截图的位置', () => {
  const json = (v: unknown) => strToU8(JSON.stringify(v));
  const span = (path: string, bbox: number[]) => ({ type: 'image_body', bbox, lines: [{ bbox, spans: [{ type: 'image', bbox, image_path: path }] }] });

  it('layout.json：坐标按 page_size 换算；同一张图出现多次取第一次', () => {
    const files = {
      'r/layout.json': json({
        pdf_info: [
          { page_idx: 0, page_size: [612, 792], para_blocks: [{ type: 'image', blocks: [span('a.jpg', [61.2, 79.2, 306, 396])] }] },
          { page_idx: 1, page_size: [612, 792], preproc_blocks: [span('b.jpg', [0, 0, 612, 396])], para_blocks: [span('b.jpg', [0, 0, 612, 396])] },
        ],
      }),
    };
    const r = imageRegions(files);
    expect([...r.keys()]).toEqual(['a.jpg', 'b.jpg']);
    expect(r.get('a.jpg')!.page).toBe(0);
    expect(r.get('a.jpg')!.box.x0).toBeCloseTo(0.1);
    expect(r.get('a.jpg')!.box.y1).toBeCloseTo(0.5);
    expect(r.get('b.jpg')).toEqual({ page: 1, box: { x0: 0, y0: 0, x1: 1, y1: 0.5 } });
  });

  it('content_list.json：bbox 是 0–1000；像素坐标（早期版本）不用', () => {
    const item = (bbox: number[]) => ({ type: 'image', img_path: 'images/c.jpg', page_idx: 2, bbox });
    expect(imageRegions({ 'x_content_list.json': json([item([100, 200, 900, 600])]) }).get('c.jpg')).toEqual({ page: 2, box: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.6 } });
    expect(imageRegions({ 'x_content_list.json': json([item([100, 200, 1200, 1600])]) }).size).toBe(0);
  });

  it('文件损坏或格式不认识时忽略', () => {
    expect(imageRegions({ 'layout.json': strToU8('{'), 'a_content_list.json': json({ pages: [] }) }).size).toBe(0);
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

describe('生成页面时从 PDF 取图', () => {
  const md = '# T\n\n## 1 X\n\n(1) Curriculum label\n\nFigure 1: Missing in MinerU.\n\nFigure 2: Also missing.\n\n![](images/a.jpg)\n\nFigure 3: Cropped.\n\n![](images/b.jpg)\n\nFigure 4: Not in PDF.\n\n![](images/c.jpg)\n\nFigure 5: No region.\n\nText.';
  const item = (name: string, page: number) => ({ type: 'image', img_path: `images/${name}`, page_idx: page, bbox: [100, 100, 900, 500] });
  const zip = zipSync({
    'out/full.md': strToU8(md),
    'out/images/a.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
    'out/images/b.jpg': new Uint8Array([0xff, 0xd8, 0xfe]),
    'out/images/c.jpg': new Uint8Array([0xff, 0xd8, 0xfd]),
    'out/x_content_list.json': strToU8(JSON.stringify([item('a.jpg', 0), item('b.jpg', 1)])),
  });
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const imgOf = (html: string, id: string) => new DOMParser().parseFromString(html, 'text/html').getElementById(id)!.querySelector('img')?.getAttribute('src');

  it('MinerU 截的图换成 PDF 里的图，取不到时用截图；漏掉的图按图号补回', async () => {
    const asked: unknown[] = [];
    const built = await buildPageFromZip(document, zip, {
      paperId: 'pdf-0123456789abcdef0123',
      fromPdf: async (req) => {
        asked.push(req);
        return { regions: new Map([['images/a.jpg', PNG]]), numbers: new Map([['1', PNG]]) };
      },
    });
    expect(asked).toEqual([
      {
        regions: [
          { key: 'images/a.jpg', page: 0, box: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5 } },
          { key: 'images/b.jpg', page: 1, box: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5 } },
        ],
        numbers: ['1', '2'],
      },
    ]);
    expect(built).toMatchObject({ pdfImages: 1, mineruImages: 2, recoveredFigures: 1, missingFigures: 1, missingImages: 0 });
    expect(imgOf(built.html, 'S1.F1')).toBe(PNG);
    expect(imgOf(built.html, 'S1.F2')).toBeUndefined();
    expect(imgOf(built.html, 'S1.F3')).toBe(PNG);
    expect(imgOf(built.html, 'S1.F4')).toBe('data:image/jpeg;base64,/9j+');
    expect(imgOf(built.html, 'S1.F5')).toBe('data:image/jpeg;base64,/9j9');
  });

  it('取图失败不影响生成页面，全部用 MinerU 的截图', async () => {
    const built = await buildPageFromZip(document, zip, {
      paperId: 'pdf-0123456789abcdef0123',
      fromPdf: () => Promise.reject(new Error('pdf.js failed')),
    });
    expect(built).toMatchObject({ pdfImages: 0, mineruImages: 3, recoveredFigures: 0, missingFigures: 2 });
    expect(imgOf(built.html, 'S1.F3')).toBe('data:image/jpeg;base64,/9j/');
  });
});
