/**
 * 导入的论文在阅读页（core/paper.ts 的 READER_PAGE）里打开：页面 HTML 只存在本机 IndexedDB，
 * 阅读页上的内容脚本向 background 要来填进页面，论文内容不经过网络。
 *
 * 阅读页的访问权限是可选权限（导入或打开论文时申请），所以阅读页的内容脚本不写在 manifest 里，
 * 有权限时才用 chrome.scripting 注册。写进 manifest 会新增权限提示，已安装的用户更新后扩展会被停用
 */
import { browser } from 'wxt/browser';
import type { ReaderDocRequest } from '@/core/messages';
import { isImportedId, READER_PAGE, readerUrl } from '@/core/paper';
import { loadDoc } from './db';

/** 阅读页的访问权限（Chrome 按网站授权，路径不起作用） */
export const READER_ORIGINS = [`${new URL(READER_PAGE).origin}/*`];

const SCRIPT_ID = 'reader';
/** 和 arXiv 页面共用 entrypoints/content.ts，它自己识别阅读页 */
const SCRIPT_FILE = 'content-scripts/content.js';

export const hasReaderAccess = () => browser.permissions.contains({ origins: READER_ORIGINS });

/** 有阅读页的访问权限时注册内容脚本，没有时注销 */
export async function syncReaderScript(): Promise<void> {
  const access = await hasReaderAccess();
  const registered = (await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0;
  try {
    if (access && !registered) {
      await browser.scripting.registerContentScripts([
        { id: SCRIPT_ID, matches: [`${READER_PAGE}*`], js: [SCRIPT_FILE], runAt: 'document_idle' },
      ]);
    } else if (!access && registered) {
      await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    }
  } catch (e) {
    // 论文库页和 background 可能同时注册，后到的一方报 "Duplicate script ID"
    if (!/duplicate/i.test(String(e))) throw e;
  }
}

export class OpenError extends Error {
  constructor(
    message: string,
    readonly kind: 'no-permission' | 'no-doc',
  ) {
    super(message);
  }
}

/** 打开导入的论文：需要阅读页的访问权限（在点击事件里先申请） */
export async function openImportedPaper(id: string): Promise<void> {
  if (!(await hasReaderAccess())) throw new OpenError('需要允许访问阅读页所在的 clamours.github.io，才能打开导入的论文', 'no-permission');
  if (!(await loadDoc(id))) throw new OpenError('这台电脑上还没有这篇论文的页面。开着云同步的话，同步后会自动下载；也可以导入含页面的备份，或重新导入 PDF', 'no-doc');
  // 刚授予权限时 background 可能还没注册好
  await syncReaderScript();
  await browser.tabs.create({ url: readerUrl(id) });
}

/** background：替阅读页取论文 HTML，并让内容脚本的注册跟着权限走 */
export function initReaderService(): void {
  browser.runtime.onMessage.addListener((msg: ReaderDocRequest, _sender, sendResponse) => {
    if (msg?.type !== 'ahh:reader-doc' || !isImportedId(msg.paperId)) return;
    void loadDoc(msg.paperId).then(
      (doc) => sendResponse(doc?.html ?? null),
      () => sendResponse(null),
    );
    return true;
  });
  // 扩展更新后补注册；在扩展详情页里授予、收回权限后跟着变
  void syncReaderScript();
  browser.permissions.onAdded.addListener(() => void syncReaderScript());
  browser.permissions.onRemoved.addListener(() => void syncReaderScript());
}
