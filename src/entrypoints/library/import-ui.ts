import { browser } from 'wxt/browser';
import { loadMeta } from '@/core/storage';
import { FILE_PLUS_ICON } from '@/shared/icons';
import {
  loadJobs,
  loadToken,
  removeImportedPage,
  removeJob,
  resumeJobs,
  retryJob,
  saveToken,
  startImport,
  watchJobs,
  type ImportJob,
  type Runner,
} from '@/import/jobs';
import { hasFileAccess, openExtensionSettings, OpenError, openImportedPaper } from '@/import/local-file';
import { MINERU_ORIGINS } from '@/import/mineru-api';
import { toast } from './toast';

/**
 * 论文库页的"导入 PDF"：PDF 交给 MinerU 解析，生成 arXiv 风格的论文页面，保存在本机并以 file:// 打开。
 * 流程见 src/import/jobs.ts。
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface ImportUi {
  /** 打开导入的论文（在点击事件里调用：可能需要申请权限） */
  open(paperId: string, title: string): Promise<void>;
  /** 从论文库移除时删除本机的页面 */
  remove(paperId: string): Promise<void>;
}

export function initImportUi(): ImportUi {
  const btn = $<HTMLButtonElement>('import-pdf');
  const dialog = $<HTMLDialogElement>('dialog');
  const jobsEl = $('jobs');
  btn.innerHTML = `${FILE_PLUS_ICON}<span>导入 PDF</span>`;
  btn.addEventListener('click', () => void openDialog());

  const runner: Runner = {
    onDone(paperId, title, note) {
      toast(`已导入「${title}」${note ? `（${note}）` : ''}`);
      void openPaper(paperId, title, false);
    },
  };

  watchJobs(() => void renderJobs());
  void renderJobs();
  void resumeJobs(runner);

  async function openDialog(error?: string): Promise<void> {
    const box = el('div', 'dlg');
    box.tabIndex = -1;
    box.autofocus = true;
    box.append(el('h2', '', '导入 PDF'), el('div', 'file', '用 MinerU 解析 PDF，生成可以划线、可以用沉浸式翻译 / 陪读蛙翻译的论文页面'));

    const form = el('div', 'form');
    const tokenField = el('label', 'field');
    const token = document.createElement('input');
    token.type = 'password';
    token.value = await loadToken();
    // 在这里读好：点击"开始导入"后第一个 await 必须是申请权限
    const authFailed = (await loadJobs()).filter((j) => j.step === 'failed' && j.errorKind === 'auth');
    token.placeholder = '在 mineru.net 的 API 管理页面创建';
    token.autocomplete = 'off';
    token.spellcheck = false;
    tokenField.append(el('span', '', 'MinerU Token'), token);

    const fileField = el('label', 'field');
    const files = document.createElement('input');
    files.type = 'file';
    files.accept = '.pdf,application/pdf';
    files.multiple = true;
    fileField.append(el('span', '', 'PDF 文件（可多选）'), files);

    const tokenHint = el('p', 'hint');
    const link = document.createElement('a');
    link.href = 'https://mineru.net/apiManage';
    link.target = '_blank';
    link.textContent = 'mineru.net → API 管理';
    tokenHint.append('Token 在 ', link, ' 创建，有效期 90 天，过期后需要换一个新的。Token 只保存在这台电脑的浏览器里。');
    form.append(tokenField, tokenHint, fileField);

    const privacy = el('p', 'hint', 'PDF 会上传到 MinerU 的服务器解析，未公开的稿件请注意。同一个 PDF 只解析一次：再次导入时直接打开已生成的页面。');
    const access = el('div', 'notice');
    access.hidden = await hasFileAccess();
    access.append(
      el('p', '', '论文页面以本地文件打开，需要先在扩展详情页打开"允许访问文件网址"。'),
      button('打开扩展详情页', 'btn', openExtensionSettings),
    );
    const errorLine = el('p', 'error', error ?? '');
    errorLine.hidden = !error;

    const actions = el('div', 'dlg-actions');
    const cancel = button('取消', 'btn plain', () => dialog.close());
    const start = button('开始导入', 'btn primary', () => void onStart());
    actions.append(cancel, start);
    box.append(form, privacy, access, errorLine, actions);
    dialog.replaceChildren(box);
    dialog.showModal();

    async function onStart(): Promise<void> {
      const setError = (msg: string) => {
        errorLine.textContent = msg;
        errorLine.hidden = false;
      };
      const picked = Array.from(files.files ?? []);
      if (!token.value.trim()) return setError('请填写 MinerU Token');
      // 只换了 Token：重试因 Token 失败的任务（不需要申请权限）
      if (!picked.length && authFailed.length) {
        await saveToken(token.value);
        for (const j of authFailed) await retryJob(j.paperId, runner);
        dialog.close();
        toast('已更新 Token，正在重试');
        return;
      }
      if (!picked.length) return setError('请选择 PDF 文件');
      // 必须在点击后立即申请权限，中间不能有其他 await
      let granted = false;
      try {
        granted = await browser.permissions.request({ permissions: ['downloads'], origins: MINERU_ORIGINS });
      } catch (e) {
        return setError(permissionError(e));
      }
      if (!granted) return setError('需要允许访问 MinerU 的服务器、管理下载内容，才能导入');
      start.disabled = cancel.disabled = true;
      await saveToken(token.value);
      const results = await Promise.all(
        picked.map((f) =>
          startImport(f, runner).catch((e: unknown) => {
            toast(`${f.name}：${e instanceof Error ? e.message : String(e)}`);
            return null;
          }),
        ),
      );
      dialog.close();
      const existing = results.filter((r) => r?.status === 'exists');
      const started = results.filter((r) => r?.status === 'started').length;
      if (started) toast(started > 1 ? `已开始导入 ${started} 个 PDF` : '已开始导入，解析通常需要一到几分钟');
      if (existing.length) {
        toast(existing.length > 1 ? `${existing.length} 个 PDF 之前已经导入过` : '这个 PDF 之前已经导入过，直接打开');
        if (existing.length === 1) void openPaper(existing[0]!.paperId, '', false);
      }
    }
  }

  async function renderJobs(): Promise<void> {
    const jobs = await loadJobs();
    jobsEl.hidden = !jobs.length;
    jobsEl.replaceChildren(...jobs.map(jobCard));
  }

  function jobCard(job: ImportJob): HTMLElement {
    const card = el('article', `paper job${job.step === 'failed' ? ' failed' : ''}`);
    const text = el('div', 'paper-text');
    text.append(el('h2', '', job.fileName));
    const meta = el('div', 'meta');
    meta.append(el('span', '', job.step === 'failed' ? '导入失败' : '正在导入'), el('span', '', `${(job.size / 1048576).toFixed(1)} MB`));
    text.append(meta, el('div', 'job-status', statusText(job)));
    if (job.step === 'parsing' && job.progress) {
      const bar = document.createElement('progress');
      bar.max = job.progress.total;
      bar.value = job.progress.done;
      text.append(bar);
    }

    const actions = el('div', 'job-actions');
    if (job.step === 'failed') {
      if (job.errorKind === 'auth') actions.append(button('修改 Token', 'btn', () => void openDialog(job.error)));
      else if (job.errorKind === 'permission' && job.origin) {
        actions.append(
          button('允许访问并重试', 'btn', async () => {
            // 点击后立即申请
            if (await browser.permissions.request({ origins: [job.origin!] })) await retryJob(job.paperId, runner);
          }),
        );
      } else if (job.errorKind !== 'file' || job.batchId) actions.append(button('重试', 'btn', () => void retryJob(job.paperId, runner)));
    }
    actions.append(button(job.step === 'failed' ? '移除' : '取消', 'btn plain', () => void removeJob(job.paperId)));
    const head = el('div', 'paper-head');
    head.append(text, actions);
    card.append(head);
    return card;
  }

  async function openPaper(paperId: string, title: string, fromClick: boolean): Promise<void> {
    try {
      // 点击时顺便申请下载权限（已有权限时不会弹出提示）；必须在点击后立即调用
      if (fromClick) await browser.permissions.request({ permissions: ['downloads'] });
      await openImportedPaper(paperId, title || (await loadMeta(paperId))?.title || '');
    } catch (e) {
      if (e instanceof OpenError && e.kind === 'no-file-access') return showAccessDialog();
      toast(permissionError(e));
    }
  }

  function showAccessDialog(): void {
    const box = el('div', 'dlg');
    box.tabIndex = -1;
    box.autofocus = true;
    box.append(
      el('h2', '', '需要允许访问文件网址'),
      el('p', 'hint', '论文页面保存在"下载/arxiv-html-helper/"文件夹里，以本地文件打开（这样翻译插件才能工作）。请在扩展详情页打开"允许访问文件网址"，然后回到论文库再点一次论文标题。'),
    );
    const actions = el('div', 'dlg-actions');
    actions.append(
      button('关闭', 'btn plain', () => dialog.close()),
      button('打开扩展详情页', 'btn primary', () => {
        openExtensionSettings();
        dialog.close();
      }),
    );
    box.append(actions);
    dialog.replaceChildren(box);
    dialog.showModal();
  }

  return {
    open: (paperId, title) => openPaper(paperId, title, true),
    remove: removeImportedPage,
  };
}

/**
 * 申请权限失败的说明。"加载已解压的扩展程序"时，Chrome 会直接读取磁盘上新的页面代码，
 * 但 manifest 要点"重新加载"才更新；新版本声明的权限这时还申请不了
 */
function permissionError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/specified in the manifest/i.test(msg)) return '扩展已更新但还没有重新加载：请在 chrome://extensions 里点一下本扩展的"重新加载"按钮，再刷新论文库';
  return msg;
}

function statusText(job: ImportJob): string {
  switch (job.step) {
    case 'uploading':
      return '正在上传 PDF…';
    case 'building':
      return '正在生成论文页面…';
    case 'failed':
      return job.error ?? '导入失败';
    case 'parsing':
      switch (job.parse) {
        case 'waiting-file':
          return '等待 MinerU 接收文件…';
        case 'running':
          return job.progress ? `正在解析：${job.progress.done} / ${job.progress.total} 页` : '正在解析…';
        case 'converting':
          return '正在整理解析结果…';
        default:
          return 'MinerU 排队中…';
      }
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}
