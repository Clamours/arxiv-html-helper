/**
 * 把导入论文的页面写成本地 .html 文件并以 file:// 打开（翻译插件在扩展自己的页面里不工作，在 file:// 页面上可以）。
 *
 * 文件通过 chrome.downloads 写到"下载/arxiv-html-helper/"，内容和 IndexedDB 里的完全相同。
 * 需要 downloads 权限（可选权限，导入时申请），并且要在扩展详情页打开"允许访问文件网址"。
 */
import { browser } from 'wxt/browser';
import { loadDoc, saveDoc, type StoredDoc } from './docs';

export const FILE_FOLDER = 'arxiv-html-helper';

/** 本地路径 → file:// URL（macOS / Linux 的 /a/b，Windows 的 C:\a\b 和 \\server\share） */
export function fileUrl(path: string): string {
  const enc = (parts: string[]) => parts.map(encodeURIComponent).join('/');
  if (path.startsWith('\\\\')) {
    const [host, ...rest] = path.slice(2).split('\\');
    return `file://${host}/${enc(rest)}`;
  }
  if (/^[a-zA-Z]:[\\/]/.test(path)) {
    const [drive, ...rest] = path.split(/[\\/]/);
    return `file:///${drive}/${enc(rest)}`;
  }
  return `file://${enc(path.split('/'))}`;
}

/** 文件名：标题（去掉文件系统不允许的字符）+ id 的一段，避免同名 */
export function pageFileName(title: string, id: string): string {
  const clean = title
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim();
  return `${clean || 'paper'} [${id.slice(4, 12)}].html`;
}

export async function hasFileAccess(): Promise<boolean> {
  return browser.extension.isAllowedFileSchemeAccess();
}

/** 扩展详情页（"允许访问文件网址"开关所在页面） */
export function openExtensionSettings(): void {
  void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
}

/**
 * downloads.search 返回的 exists 可能是旧的：Chrome 不监视文件删除，search 只是触发一次检查，
 * 检查结果通过 onChanged 回来。所以 search 之后再等一小会儿
 */
async function stillExists(downloadId: number): Promise<boolean> {
  let onChanged: ((d: { id: number; exists?: { current?: boolean } }) => void) | undefined;
  const gone = new Promise<false>((resolve) => {
    onChanged = (d) => {
      if (d.id === downloadId && d.exists?.current === false) resolve(false);
    };
    browser.downloads.onChanged.addListener(onChanged);
  });
  try {
    const [item] = await browser.downloads.search({ id: downloadId });
    if (!item || item.state !== 'complete' || !item.exists || !item.filename) return false;
    const ok = await Promise.race([gone, new Promise<true>((r) => setTimeout(() => r(true), 400))]);
    return ok;
  } finally {
    browser.downloads.onChanged.removeListener(onChanged!);
  }
}

function waitForDownload(downloadId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const check = async () => {
      const [item] = await browser.downloads.search({ id: downloadId });
      if (item?.state === 'complete' && item.filename) done(() => resolve(item.filename));
      else if (item?.state === 'interrupted') done(() => reject(new Error(`写入本地文件失败（${item.error ?? '未知原因'}）`)));
    };
    const listener = (d: { id: number; state?: { current?: string } }) => {
      if (d.id === downloadId && d.state) void check();
    };
    const done = (fn: () => void) => {
      browser.downloads.onChanged.removeListener(listener);
      fn();
    };
    browser.downloads.onChanged.addListener(listener);
    void check(); // 很小的文件可能在加监听之前就完成了
  });
}

/** 确保本地文件存在（不存在就从 IndexedDB 写出），返回本地路径 */
export async function ensureLocalFile(doc: StoredDoc, title: string): Promise<string> {
  if (doc.localFile && (await stillExists(doc.localFile.downloadId))) {
    const [item] = await browser.downloads.search({ id: doc.localFile.downloadId });
    if (item?.filename) return item.filename;
  }
  const url = URL.createObjectURL(new Blob([doc.html], { type: 'text/html;charset=utf-8' }));
  try {
    const downloadId = await browser.downloads.download({
      url,
      filename: `${FILE_FOLDER}/${pageFileName(title, doc.id)}`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    const path = await waitForDownload(downloadId);
    // 旧文件的下载记录已经没用了
    if (doc.localFile) await browser.downloads.erase({ id: doc.localFile.downloadId }).catch(() => {});
    await saveDoc({ ...doc, localFile: { downloadId, path } });
    return path;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class OpenError extends Error {
  constructor(
    message: string,
    readonly kind: 'no-file-access' | 'no-doc' | 'no-permission' | 'failed',
  ) {
    super(message);
  }
}

/** 打开导入的论文：需要 downloads 权限和文件网址访问权限 */
export async function openImportedPaper(id: string, title: string): Promise<void> {
  if (!(await browser.permissions.contains({ permissions: ['downloads'] }))) {
    throw new OpenError('需要允许扩展管理下载内容，才能把论文页面保存为本地文件', 'no-permission');
  }
  if (!(await hasFileAccess())) {
    throw new OpenError('需要在扩展详情页打开"允许访问文件网址"，论文页面才能以本地文件打开', 'no-file-access');
  }
  const doc = await loadDoc(id);
  if (!doc) throw new OpenError('这台电脑上没有这篇论文的页面，请重新导入 PDF', 'no-doc');
  let path: string;
  try {
    path = await ensureLocalFile(doc, title);
  } catch (e) {
    throw new OpenError(e instanceof Error ? e.message : String(e), 'failed');
  }
  await browser.tabs.create({ url: fileUrl(path) });
}

/** 从论文库移除导入的论文时：删掉本地文件和 IndexedDB 里的页面 */
export async function removeLocalFile(doc: StoredDoc): Promise<void> {
  if (!doc.localFile || !(await browser.permissions.contains({ permissions: ['downloads'] }))) return;
  const id = doc.localFile.downloadId;
  await browser.downloads.removeFile(id).catch(() => {});
  await browser.downloads.erase({ id }).catch(() => {});
}
