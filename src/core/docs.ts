import { groupLibrary } from './library';
import { isImportedId } from './paper';
import { TOMB_PREFIX, toPaperTomb } from './tombstones';

/**
 * 导入论文的页面（导入 PDF 生成的 HTML）。本机存在 IndexedDB（src/imported/db.ts）；
 * 开启云同步时每篇页面另有一份在云端（src/sync/docs.ts），手动导出的备份里也有。
 * 这里只放纯逻辑：页面记录的校验、云端文件的格式、按论文库算出哪些页面要同步或删除。
 */

export interface StoredDoc {
  id: string;
  html: string;
  /** html 按 UTF-8 编码的 SHA-256；论文库元数据的 doc.sha256 记录的就是它 */
  sha256: string;
}

/** 导入任务在 storage 里的键前缀（任务见 src/import/jobs.ts） */
export const JOB_PREFIX = 'import:job:';

const SHA256 = /^[0-9a-f]{64}$/;

/** 校验来自云端或备份文件的页面；格式不对时返回 null。内容和 sha256 是否相符由调用方校验（要用 crypto.subtle） */
export function toStoredDoc(x: unknown): StoredDoc | null {
  if (!isObj(x) || typeof x.id !== 'string' || !isImportedId(x.id)) return null;
  if (typeof x.sha256 !== 'string' || !SHA256.test(x.sha256) || typeof x.html !== 'string' || !x.html) return null;
  return { id: x.id, html: x.html, sha256: x.sha256 };
}

export interface LibraryDocs {
  /** 论文库里导入的论文 → 元数据记录的页面 SHA-256（多台电脑各自导入过时是先导入的那份；早期导入的没有记录） */
  wanted: Record<string, string | null>;
  /** 已从论文库移除的导入论文：有整篇删除记录、论文库里已经没有、也没有在重新导入 */
  removed: string[];
}

export function libraryDocs(all: Record<string, unknown>): LibraryDocs {
  const wanted: Record<string, string | null> = {};
  for (const e of groupLibrary(all)) {
    if (!isImportedId(e.id)) continue;
    const sha = e.meta?.doc?.sha256;
    wanted[e.id] = typeof sha === 'string' && SHA256.test(sha) ? sha : null;
  }
  const removed: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(TOMB_PREFIX)) continue;
    const id = key.slice(TOMB_PREFIX.length);
    if (isImportedId(id) && !(id in wanted) && toPaperTomb(value).paper && !(JOB_PREFIX + id in all)) removed.push(id);
  }
  return { wanted, removed: removed.sort() };
}

// ---------------------------------------------------------------------------
// 云端文件
// ---------------------------------------------------------------------------

export const DOC_FILE_FORMAT = 'arxiv-html-notes-page';
export const DOC_INDEX_FORMAT = 'arxiv-html-notes-pages-index';
export const DOC_FILE_VERSION = 1;

export class DocFileError extends Error {
  constructor(
    message: string,
    /** 文件来自更新版本的插件：不能当作损坏的文件覆盖 */
    readonly newer = false,
  ) {
    super(message);
  }
}

export function toDocFile(doc: StoredDoc) {
  return { format: DOC_FILE_FORMAT, version: DOC_FILE_VERSION, id: doc.id, sha256: doc.sha256, html: doc.html };
}

export function parseDocFile(text: string, id: string): StoredDoc {
  const data = parseJson(text);
  if (!isObj(data) || data.format !== DOC_FILE_FORMAT) throw new DocFileError('不是论文页面文件');
  checkVersion(data.version);
  const doc = toStoredDoc(data);
  if (!doc || doc.id !== id) throw new DocFileError('论文页面文件已损坏');
  return doc;
}

/** 云端索引：论文 id → 云端那份页面的 SHA-256。同步时只下载本机没有的页面 */
export function toDocIndexFile(docs: Record<string, string>) {
  const sorted = Object.fromEntries(Object.keys(docs).sort().map((k) => [k, docs[k]!]));
  return { format: DOC_INDEX_FORMAT, version: DOC_FILE_VERSION, docs: sorted };
}

export function parseDocIndexFile(text: string): Record<string, string> {
  const data = parseJson(text);
  if (!isObj(data) || data.format !== DOC_INDEX_FORMAT || !isObj(data.docs)) throw new DocFileError('不是论文页面索引');
  checkVersion(data.version);
  const out: Record<string, string> = {};
  for (const [id, h] of Object.entries(data.docs)) if (isImportedId(id) && typeof h === 'string' && SHA256.test(h)) out[id] = h;
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DocFileError('文件不是有效的 JSON');
  }
}

function checkVersion(v: unknown): void {
  if (typeof v !== 'number') throw new DocFileError('文件缺少版本号');
  if (v > DOC_FILE_VERSION) throw new DocFileError('文件来自更新版本的插件，请先升级插件', true);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
