import type { ApiMeta } from './arxiv-api';

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
  /**
   * 以下来自 arXiv API，apiAt 是获取时间。旧版本扩展获取的数据没有这些字段，论文库页会重新获取（见 needsApiMeta）；
   * doi、journalRef、comment 作者没填时没有
   */
  apiAt?: number;
  abstract?: string;
  /** 主分类，如 cs.CL */
  category?: string;
  /** 获取时的最新版本，如 v7 */
  latestVersion?: string;
  /** 最新版本的发布时间（ISO） */
  updated?: string;
  doi?: string;
  /** 正式发表的期刊、会议 */
  journalRef?: string;
  /** 作者的备注，常写页数、录用的会议 */
  comment?: string;
}

/** 随 API 数据整体更新的字段 */
export const API_DETAILS = ['abstract', 'category', 'latestVersion', 'updated', 'doi', 'journalRef', 'comment'] as const;

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

/**
 * 导入论文的阅读页：项目主页上的空壳页面（site/reader.html），内容脚本把本机的论文页面填进去。
 * 以 https 网址打开，ChatGPT 侧边栏等只读 http/https 页面的扩展才能读到正文
 */
export const READER_PAGE = 'https://clamours.github.io/arxiv-html-helper/reader.html';

export const readerUrl = (id: string) => `${READER_PAGE}?id=${id}`;

/** 阅读页网址里的论文 id；不是阅读页时返回 null */
export function readerPaperId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const id = u.searchParams.get('id') ?? '';
  return u.origin + u.pathname === READER_PAGE && isImportedId(id) ? id : null;
}

/**
 * 导入论文的页面：填好的阅读页，或早期版本写到"下载"文件夹、以 file:// 打开的本地文件；
 * 其他页面（包括其他本地文件）返回 null
 */
export function parseImportedPage(doc: Document, url: string): PaperRef | null {
  if (!url.startsWith('file:') && !readerPaperId(url)) return null;
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

/** 拿到 API 数据时：覆盖标题、作者、摘要等，保留打开记录 */
export function mergeApiMeta(cur: PaperMeta | null, api: ApiMeta, now = Date.now()): PaperMeta {
  const out: PaperMeta = {
    version: '',
    lastOpenedAt: 0,
    ...cur,
    id: api.id,
    title: api.title || cur?.title || api.id,
    authors: api.authors.length ? api.authors : (cur?.authors ?? []),
    published: api.published || cur?.published,
    source: 'api',
    apiAt: now,
  };
  // 作者后来删掉的 DOI 等不保留旧值
  for (const key of API_DETAILS) {
    if (api[key]) out[key] = api[key];
    else delete out[key];
  }
  return out;
}

/** 需要（重新）从 arXiv API 获取：还没获取过、旧版本扩展获取的（没有摘要等），或打开过比已知最新版本更新的版本 */
export function needsApiMeta(m: PaperMeta | null): boolean {
  if (m?.source !== 'api' || !m.apiAt) return true;
  return versionNumber(m.version) > versionNumber(m.latestVersion);
}

const versionNumber = (v = '') => Number(/^v(\d+)$/.exec(v)?.[1] ?? 0);

export function paperUrl(id: string, version = ''): string {
  return `https://arxiv.org/html/${id}${version}`;
}

/** 摘要页；不带版本时总是最新版本 */
export function absUrl(id: string, version = ''): string {
  return `https://arxiv.org/abs/${id}${version}`;
}

/** 元素的可读文本：去掉脚注（标题里的上标也当作脚注标记）、drop 选中的元素，公式换成 TeX */
function cleanText(el: Element, drop = '.ltx_note, .ltx_note_mark, sup, .ltx_tag'): string {
  const c = el.cloneNode(true) as Element;
  for (const n of c.querySelectorAll(drop)) n.remove();
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

/**
 * 页面上的摘要，各段之间空一行；没有摘要时为空串。导入论文的页面和 arXiv 页面结构相同，
 * 但只有 MinerU 识别出了摘要（"Abstract" 标题或 "Abstract—" 开头的段落）时才有
 */
export function extractAbstract(doc: Document): string {
  const abs = doc.querySelector('.ltx_abstract');
  if (!abs) return '';
  const paras = Array.from(abs.querySelectorAll('.ltx_p'));
  return (paras.length ? paras : [abs])
    .map((p) => {
      const c = p.cloneNode(true) as Element;
      // 正文里的上标（如 10<sup>6</sup>）写成 10^6；脚注标记照常去掉
      for (const s of c.querySelectorAll('sup:not(.ltx_note_mark)')) s.replaceWith(`^${s.textContent ?? ''}`);
      return oneLine(cleanText(c, '.ltx_note, .ltx_note_mark, .ltx_tag, .ltx_title_abstract'));
    })
    .filter(Boolean)
    .join('\n\n');
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
