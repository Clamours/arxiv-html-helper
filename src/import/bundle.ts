/**
 * MinerU 结果 zip → 单文件 HTML（图片内嵌为 data: URL）。
 * 生成的 HTML 就是这篇论文的最终版本：之后原样保存、写成本地文件、云同步，不再重新生成。
 */
import { unzipSync } from 'fflate';
import { allBlocks, parseMinerUMarkdown, type Block, type MinerUPaper } from './mineru';
import { standaloneHtml } from './page';

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

export interface BuiltPage {
  html: string;
  paper: MinerUPaper;
  /** 没能内嵌的图片（页面上不显示） */
  missingImages: number;
  /** MinerU 没识别出图片、从原 PDF 补回的图 */
  recoveredFigures: number;
  /** 补不回来、只显示图注的图 */
  missingFigures: number;
}

export interface BuildOptions {
  paperId: string;
  /** 结果里引用了远程图片时用来下载；返回 null 表示下载失败 */
  fetchImage?: (url: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** 按图号从原 PDF 里取 MinerU 没识别出来的图；返回 图号 → data: URL，找不到的图号不在结果里 */
  recoverFigures?: (numbers: string[]) => Promise<Map<string, string>>;
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

  // 只有图注、没有图片的图：MinerU 把这张图当成了文字。从原 PDF 里补回来（补不回来就只显示图注）
  const orphans = allBlocks(paper).filter(
    (b): b is Extract<Block, { kind: 'figure' }> => b.kind === 'figure' && !b.panels.length && !!b.number,
  );
  let recoveredFigures = 0;
  if (orphans.length && opts.recoverFigures) {
    const found = await opts.recoverFigures([...new Set(orphans.map((b) => b.number!))]).catch(() => new Map<string, string>());
    for (const b of orphans) {
      const url = found.get(b.number!);
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
  return { html, paper, missingImages: srcs.size - images.size, recoveredFigures, missingFigures: orphans.length - recoveredFigures };
}
