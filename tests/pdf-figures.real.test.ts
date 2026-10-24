// @vitest-environment node
/**
 * 用真实 PDF 测试从 PDF 补图（PDF 不入库）。Node 里没有 canvas，只检查嵌入位图的图：
 *   FIGURE_PDF=/path/to/paper.pdf FIGURE_NUMBERS=1,2 npm test
 * 渲染矢量图要在浏览器里测（导入一篇这样的 PDF）。
 */
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { extractFigures } from '../src/import/pdf-figures';

const file = process.env.FIGURE_PDF;
const numbers = (process.env.FIGURE_NUMBERS ?? '1').split(',').map((s) => s.trim());

describe.skipIf(!file)('真实 PDF 补图', () => {
  it('找到图注旁边的嵌入位图', async () => {
    const dir = 'node_modules/pdfjs-dist/';
    const { numbers: found } = await extractFigures(new Uint8Array(readFileSync(file!)), { regions: [], numbers }, {
      lib: pdfjs as never,
      dataUrls: { standardFonts: `${dir}standard_fonts/`, cMaps: `${dir}cmaps/`, wasm: `${dir}wasm/` },
    });
    for (const [n, f] of found) console.log(`Figure ${n}: page ${f.page}, ${f.width}x${f.height}, ${(f.dataUrl.length / 1024).toFixed(0)} KB`);
    expect([...found.keys()].sort()).toEqual([...numbers].sort());
    for (const f of found.values()) expect(f.dataUrl).toMatch(/^data:image\/png;base64,/);
  }, 60_000);
});
