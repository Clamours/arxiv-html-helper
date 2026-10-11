export interface PaperRef {
  /** 不含版本号，作为存储 key */
  id: string;
  version: string;
}

// 新式 id：2401.12345 / 1706.03762；旧式：hep-th/9901001
const ID = String.raw`(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})`;
const HTML_PATH = new RegExp(String.raw`^\/html\/${ID}(v\d+)?(?:\/|$)`);

/**
 * 论文库里展示用的元数据。
 * 标题、作者优先来自 arXiv API；API 不可用时退回从论文页提取（可能被翻译插件改写、作者不全）。
 */
export interface PaperMeta {
  id: string;
  /** 最近一次打开的版本；从未打开过时为空串 */
  version: string;
  title: string;
  authors: string[];
  lastOpenedAt: number;
  /** 首个版本的发布时间（ISO），仅 API 提供 */
  published?: string;
  /** 标题和作者的来源；旧数据没有此字段，视为 page */
  source?: 'page' | 'api';
  /** 导入的 PDF 才有：生成的论文页面 */
  doc?: PaperDoc;
}

/**
 * 导入的论文页面（PDF 经 MinerU 解析后生成的 HTML）。页面生成后不再改变，划线依赖它的结构；
 * 多台电脑各自导入过同一个 PDF 时，以先导入的一份为准（见 pickDoc）。
 */
export interface PaperDoc {
  /** HTML（UTF-8）的 SHA-256，十六进制 */
  sha256: string;
  size: number;
  importedAt: number;
  /** 原 PDF 的文件名，只用于显示 */
  fileName: string;
}

/** 两份页面信息里取先导入的一份；与参数顺序无关 */
export function pickDoc(a: PaperDoc | undefined, b: PaperDoc | undefined): PaperDoc | undefined {
  if (!a || !b) return a ?? b;
  if (a.importedAt !== b.importedAt) return a.importedAt < b.importedAt ? a : b;
  return a.sha256 <= b.sha256 ? a : b;
}

/** 导入论文的 id：PDF 内容 SHA-256 的前 20 位，同一个 PDF 在任何电脑上都得到同一个 id */
const IMPORTED_ID = /^pdf-[0-9a-f]{20}$/;
export const isImportedId = (id: string) => IMPORTED_ID.test(id);

export async function importedPaperId(pdf: BufferSource): Promise<string> {
  return `pdf-${(await sha256Hex(pdf)).slice(0, 20)}`;
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 导入论文的页面在 <head> 里用这个 meta 标明论文 id */
export const IMPORTED_META = 'ahh-paper-id';

/** 本地打开的导入论文页面（file://）；其他本地文件返回 null */
export function parseImportedPage(doc: Document, url: string): PaperRef | null {
  if (!url.startsWith('file:')) return null;
  const id = doc.querySelector(`meta[name="${IMPORTED_META}"]`)?.getAttribute('content') ?? '';
  return isImportedId(id) ? { id, version: '' } : null;
}

/** 打开论文页时：已有 API 数据就只更新版本和打开时间，否则用页面上提取的 */
export function mergePageMeta(cur: PaperMeta | null, fromPage: PaperMeta): PaperMeta {
  if (cur?.source !== 'api') {
    // 页面上提取不到导入信息，保留已有的
    const doc = pickDoc(cur?.doc, fromPage.doc);
    return { ...fromPage, source: 'page', ...(doc ? { doc } : {}) };
  }
  return { ...cur, version: fromPage.version || cur.version, lastOpenedAt: fromPage.lastOpenedAt };
}

/** 拿到 API 数据时：覆盖标题、作者，保留打开记录 */
export function mergeApiMeta(
  cur: PaperMeta | null,
  api: { id: string; title: string; authors: string[]; published: string },
): PaperMeta {
  return {
    version: '',
    lastOpenedAt: 0,
    ...cur,
    id: api.id,
    title: api.title || cur?.title || api.id,
    authors: api.authors.length ? api.authors : (cur?.authors ?? []),
    published: api.published || cur?.published,
    source: 'api',
  };
}

export function paperUrl(id: string, version = ''): string {
  return `https://arxiv.org/html/${id}${version}`;
}

/** 元素的可读文本：去掉脚注，公式换成 TeX，空白折叠 */
function cleanText(el: Element): string {
  const c = el.cloneNode(true) as Element;
  for (const n of c.querySelectorAll('.ltx_note, .ltx_note_mark, sup, .ltx_tag')) n.remove();
  for (const m of c.querySelectorAll('math')) m.replaceWith(`$${m.getAttribute('alttext') ?? m.textContent ?? ''}$`);
  for (const br of c.querySelectorAll('br')) br.replaceWith('\n');
  return c.textContent ?? '';
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function extractMeta(doc: Document, paper: PaperRef, now = Date.now()): PaperMeta {
  const h1 = doc.querySelector('h1.ltx_title_document');
  const title = oneLine(h1 ? cleanText(h1) : doc.title) || paper.id;
  const authors = Array.from(doc.querySelectorAll('.ltx_authors .ltx_personname'))
    // 有的模板把"姓名 + 单位 + 邮箱"都放在一个 personname 里，用换行分开，只取第一行
    .map((p) => oneLine(cleanText(p).trim().split('\n')[0] ?? ''))
    .filter((s) => s && !s.includes('@'));
  return { id: paper.id, version: paper.version, title, authors, lastOpenedAt: now };
}

/** 从 arXiv HTML / ar5iv 的 URL 解析论文 id；无法识别时退回用路径作 id */
export function parsePaper(url: string): PaperRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)(arxiv\.org|ar5iv\.org)$/.test(u.hostname)) return null;
  const m = HTML_PATH.exec(u.pathname);
  if (m) return { id: m[1]!, version: m[2] ?? '' };
  if (u.pathname.startsWith('/html/')) return { id: u.pathname.slice(6).replace(/\/$/, ''), version: '' };
  return null;
}
