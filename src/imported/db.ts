import type { StoredDoc } from '@/core/docs';

/**
 * 导入论文的页面存在 IndexedDB（chrome.storage.local 适合放小的键值，一篇页面有 1 MB 左右）。
 * 打开论文时，阅读页的内容脚本从这里取 HTML 填进页面（见 reader.ts）。开启云同步时每篇页面另有一份在云端
 * （src/sync/docs.ts），导出的备份里也有；没开同步、也没导出过备份时，这是唯一的副本。
 *
 * 导入进行中时，PDF 也暂存在这里（上传、从 PDF 补图要用），导入完成或任务移除后删除。
 */

const DB_NAME = 'ahh-docs';
const STORE = 'docs';
const PDF_STORE = 'pdfs';
/** docs 上按 sha256 建的索引：云同步时只读出 id 和指纹，不用读出整篇页面 */
const BY_HASH = 'sha256';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      const docs = names.contains(STORE) ? req.transaction!.objectStore(STORE) : req.result.createObjectStore(STORE, { keyPath: 'id' });
      if (!docs.indexNames.contains(BY_HASH)) docs.createIndex(BY_HASH, 'sha256');
      if (!names.contains(PDF_STORE)) req.result.createObjectStore(PDF_STORE);
    };
    req.onsuccess = () => {
      // 以后再升级数据库时让出连接，免得卡住新版本
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    // 还开着旧版本代码的页面（扩展刚更新、论文库页没刷新）：不干等，报错后下次再试
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('本地数据库正在升级，请刷新或关闭其他论文库页面后重试'));
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('无法打开本地数据库'));
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('本地数据库读写失败'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const tx = (await db()).transaction(store, mode);
  const req = fn(tx.objectStore(store));
  await done(tx);
  return req.result;
}

export async function loadDoc(id: string): Promise<StoredDoc | null> {
  return ((await run('readonly', (s) => s.get(id))) as StoredDoc | undefined) ?? null;
}

export async function saveDoc(doc: StoredDoc): Promise<void> {
  await run('readwrite', (s) => s.put(doc));
}

export async function deleteDoc(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

/** 本机的全部页面（导出备份用） */
export async function listDocs(): Promise<StoredDoc[]> {
  return (await run('readonly', (s) => s.getAll())) as StoredDoc[];
}

/** 云同步读写本机页面用的接口（测试里换成内存实现） */
export interface DocStore {
  /** 论文 id → 本机页面的 SHA-256 */
  hashes(): Promise<Record<string, string>>;
  get(id: string): Promise<StoredDoc | null>;
  /** 本机还没有这篇论文的页面时保存；已有时不替换（页面一经生成不再改变，划线定位依赖它）。返回是否保存了 */
  add(doc: StoredDoc): Promise<boolean>;
  remove(id: string): Promise<void>;
}

export const localDocs: DocStore = {
  async hashes() {
    const out: Record<string, string> = {};
    await run('readonly', (s) => {
      const req = s.index(BY_HASH).openKeyCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        out[String(c.primaryKey)] = String(c.key);
        c.continue();
      };
      return req;
    });
    return out;
  },
  get: loadDoc,
  async add(doc) {
    const tx = (await db()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let added = false;
    const req = store.getKey(doc.id);
    req.onsuccess = () => {
      if (req.result !== undefined) return;
      store.put(doc);
      added = true;
    };
    await done(tx);
    return added;
  },
  remove: deleteDoc,
};

export async function savePdf(id: string, pdf: ArrayBuffer): Promise<void> {
  await run('readwrite', (s) => s.put(pdf, id), PDF_STORE);
}

export async function loadPdf(id: string): Promise<ArrayBuffer | null> {
  return ((await run('readonly', (s) => s.get(id), PDF_STORE)) as ArrayBuffer | undefined) ?? null;
}

export async function deletePdf(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id), PDF_STORE);
}
