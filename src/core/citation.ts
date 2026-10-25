import { absUrl, type PaperMeta } from './paper';

/**
 * 复制引用：arXiv 论文的 BibTeX。格式参照 arXiv 摘要页的 "Export BibTeX Citation"（@misc + eprint），
 * 另外带上 DOI；年份取首个版本的发布年份。
 * 引用键仿照 Google Scholar：第一作者的姓 + 年份 + 标题里第一个实词，如 vaswani2017attention。
 */

/** 生成引用键时跳过的标题开头虚词 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'on', 'of', 'in', 'for', 'to', 'and', 'with', 'from', 'by', 'at', 'is', 'are', 'be',
  'towards', 'toward', 'via', 'do', 'does', 'how', 'what', 'why', 'when', 'can',
]);

/** 去掉重音符号、转小写，"Łukasz" 这类没有分解形式的字母之后会被当作非字母去掉 */
const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function citeKey(meta: PaperMeta): string {
  const surname = ascii(meta.authors[0]?.trim().split(/\s+/).pop() ?? '').replace(/[^a-z]/g, '');
  const year = /^\d{4}/.exec(meta.published ?? '')?.[0] ?? '';
  const word = ascii(meta.title.replace(/\$[^$]*\$/g, ' '))
    .split(/[^a-z0-9]+/)
    .find((w) => /[a-z]/.test(w) && !STOP_WORDS.has(w)) ?? '';
  return `${surname || 'arxiv'}${year}${word}`;
}

/** BibTeX 里 & % # 要转义；标题里的 $...$ 公式等 LaTeX 原样保留 */
const escapeTex = (s: string) => s.replace(/(?<!\\)([&%#])/g, '\\$1');

export function toBibtex(meta: PaperMeta): string {
  const fields: [string, string | undefined][] = [
    ['title', escapeTex(meta.title)],
    ['author', escapeTex(meta.authors.join(' and '))],
    ['year', /^\d{4}/.exec(meta.published ?? '')?.[0]],
    ['eprint', meta.id],
    ['archivePrefix', 'arXiv'],
    ['primaryClass', meta.category],
    ['doi', meta.doi],
    ['url', absUrl(meta.id)],
  ];
  const width = Math.max(...fields.map(([k]) => k.length));
  const body = fields.filter(([, v]) => v).map(([k, v]) => `  ${k.padEnd(width)} = {${v}},`);
  return [`@misc{${citeKey(meta)},`, ...body, '}'].join('\n');
}
