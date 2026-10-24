/**
 * 在论文库页里加载 pdf.js（带 worker），从原 PDF 取图。只在导入时按需加载。
 * pdf.js 的数据文件（字体、CMap、解码器）在构建时复制到扩展的 pdfjs/ 目录，见 wxt.config.ts。
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { extractFigures, type FigureRequest, type RecoveredFigure } from './pdf-figures';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 扩展里 pdf.js 数据文件所在的目录 */
const dataDir = (name: string) => new URL(`/pdfjs/${name}/`, location.origin).href;

const urls = (m: Map<string, RecoveredFigure>) => new Map([...m].map(([k, f]) => [k, f.dataUrl]));

/** 返回 截图 key / 图号 → data: URL */
export async function figuresFromPdf(pdf: ArrayBuffer, req: FigureRequest): Promise<{ regions: Map<string, string>; numbers: Map<string, string> }> {
  const found = await extractFigures(new Uint8Array(pdf), req, {
    lib: pdfjs,
    dataUrls: { standardFonts: dataDir('standard_fonts'), cMaps: dataDir('cmaps'), wasm: dataDir('wasm') },
    createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
  });
  return { regions: urls(found.regions), numbers: urls(found.numbers) };
}
