/**
 * 导入论文的页面存在 IndexedDB（chrome.storage.local 适合放小的键值，一篇页面有 1 MB 左右）。
 * 这是本机唯一的副本：打开论文时，阅读页的内容脚本从这里取 HTML 填进页面（见 reader.ts）。
 *
 * 导入进行中时，PDF 也暂存在这里（上传、从 PDF 补图要用），导入完成或任务移除后删除。
 */

export interface StoredDoc {
  id: string;
  html: string;
  sha256: string;
}

const DB_NAME = 'ahh-docs';
const STORE = 'docs';
const PDF_STORE = 'pdfs';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      if (!names.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      if (!names.contains(PDF_STORE)) req.result.createObjectStore(PDF_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('无法打开本地数据库'));
    };
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const tx = (await db()).transaction(store, mode);
  const req = fn(tx.objectStore(store));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('本地数据库读写失败'));
  });
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

export async function savePdf(id: string, pdf: ArrayBuffer): Promise<void> {
  await run('readwrite', (s) => s.put(pdf, id), PDF_STORE);
}

export async function loadPdf(id: string): Promise<ArrayBuffer | null> {
  return ((await run('readonly', (s) => s.get(id), PDF_STORE)) as ArrayBuffer | undefined) ?? null;
}

export async function deletePdf(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id), PDF_STORE);
}
