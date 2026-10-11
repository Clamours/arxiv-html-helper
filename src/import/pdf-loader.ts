/**
 * 在论文库页里加载 pdf.js（带 worker），从原 PDF 补图。只在导入时按需加载。
 * pdf.js 的数据文件（字体、CMap、解码器）在构建时复制到扩展的 pdfjs/ 目录，见 wxt.config.ts。
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { recoverFigures } from './pdf-figures';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 扩展里 pdf.js 数据文件所在的目录 */
const dataDir = (name: string) => new URL(`/pdfjs/${name}/`, location.origin).href;

/** 返回 图号 → data: URL */
export async function recoverFiguresFromPdf(pdf: ArrayBuffer, numbers: string[]): Promise<Map<string, string>> {
  const found = await recoverFigures(new Uint8Array(pdf), numbers, {
    lib: pdfjs,
    dataUrls: { standardFonts: dataDir('standard_fonts'), cMaps: dataDir('cmaps'), wasm: dataDir('wasm') },
    createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
  });
  return new Map([...found].map(([n, f]) => [n, f.dataUrl]));
}
