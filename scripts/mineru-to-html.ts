/**
 * 把 MinerU 导出的 Markdown 转成 arXiv 风格的 HTML 文件，用于检查转换效果、测试翻译插件：
 *   npm run mineru -- paper.md [out.html] [--embed]
 *
 * --embed：把图片（MinerU CDN 上的远程图片，或 zip 包里 images/ 下的本地图片）内嵌为 data: URL，
 *          生成的文件不再依赖网络，CDN 链接过期后也能看。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { allBlocks, parseMinerUMarkdown } from '../src/import/mineru';
import { standaloneHtml } from '../src/import/page';

const args = process.argv.slice(2);
const embed = args.includes('--embed');
const [input, output] = args.filter((a) => !a.startsWith('--'));
if (!input) {
  console.error('usage: npm run mineru -- paper.md [out.html] [--embed]');
  process.exit(1);
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

const md = readFileSync(input, 'utf8');
const paper = parseMinerUMarkdown(md);

const images = new Map<string, string>();
if (embed) {
  const srcs = new Set(allBlocks(paper).flatMap((b) => (b.kind === 'figure' ? b.panels.map((p) => p.src) : [])));
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        let buf: Buffer;
        let type: string;
        if (/^https?:/i.test(src)) {
          const res = await fetch(src);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buf = Buffer.from(await res.arrayBuffer());
          type = res.headers.get('content-type')?.split(';')[0] ?? MIME[extname(new URL(src).pathname)] ?? 'image/jpeg';
        } else {
          buf = readFileSync(resolve(dirname(input), src));
          type = MIME[extname(src).toLowerCase()] ?? 'image/jpeg';
        }
        images.set(src, `data:${type};base64,${buf.toString('base64')}`);
      } catch (e) {
        console.warn(`image not embedded: ${src} (${(e as Error).message})`);
      }
    }),
  );
}

const { document } = new JSDOM('').window;
const html = standaloneHtml(document, paper, { resolveImage: (src) => images.get(src) ?? src });
const out = output ?? input.replace(/\.md$/i, '') + '.html';
writeFileSync(out, html);
console.log(`${out}  (${(html.length / 1024).toFixed(0)} KB${embed ? `, ${images.size} images embedded` : ''})`);
