import { mergeTranslations, toPaperTranslations, translationsHash, type PaperTranslations } from '@/core/translations';

/**
 * 本机的译文存档，存在扩展自己的 IndexedDB 里（一篇论文的译文有几百 KB，不适合放 chrome.storage.local：
 * 云同步每次都要读出 storage 的全部内容）。内容脚本在 arXiv 的源里，读写都通过 background 的消息。
 *
 * - papers：论文 id → PaperTranslations
 * - hashes：论文 id → 存档指纹，云同步时只需读这个就知道哪些论文要比对
 */

export interface TranslationStore {
  hashes(): Promise<Record<string, string>>;
  get(paperId: string): Promise<PaperTranslations | null>;
  /** 与本机存档合并后保存，返回合并结果 */
  merge(rec: PaperTranslations): Promise<PaperTranslations>;
}

const DB_NAME = 'ahh-translations';
const PAPERS = 'papers';
const HASHES = 'hashes';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(PAPERS);
      req.result.createObjectStore(HASHES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('无法打开译文存档数据库'));
    };
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  const t = (await db()).transaction([PAPERS, HASHES], mode);
  const req = fn(t);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(req ? req.result : (undefined as T));
    t.onerror = t.onabort = () => reject(t.error ?? new Error('译文存档读写失败'));
  });
}

async function get(paperId: string): Promise<PaperTranslations | null> {
  const raw = await tx('readonly', (t) => t.objectStore(PAPERS).get(paperId));
  return raw ? toPaperTranslations(raw, paperId) : null;
}

// 读-合并-写串行化，避免内容脚本的写入和云同步交错
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

/** 合并并保存；changed 表示本机存档是否有变化 */
export function mergeLocal(rec: PaperTranslations): Promise<{ rec: PaperTranslations; changed: boolean }> {
  return serial(async () => {
    const cur = await get(rec.paperId);
    const merged = cur ? mergeTranslations(cur, rec) : mergeTranslations(rec, rec);
    const hash = translationsHash(merged);
    if (cur && translationsHash(cur) === hash) return { rec: cur, changed: false };
    await tx('readwrite', (t) => {
      t.objectStore(PAPERS).put(merged, rec.paperId);
      t.objectStore(HASHES).put(hash, rec.paperId);
    });
    return { rec: merged, changed: true };
  });
}

export const localTranslations: TranslationStore = {
  async hashes() {
    const out: Record<string, string> = {};
    await tx('readonly', (t) => {
      const req = t.objectStore(HASHES).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        out[String(c.key)] = String(c.value);
        c.continue();
      };
    });
    return out;
  },
  get,
  async merge(rec) {
    return (await mergeLocal(rec)).rec;
  },
};
