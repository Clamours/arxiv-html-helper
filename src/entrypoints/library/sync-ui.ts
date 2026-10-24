import { browser } from 'wxt/browser';
import type { SyncNowRequest } from '@/core/messages';
import { CLOUD_ICON, CLOUD_OFF_ICON } from '@/shared/icons';
import {
  checkWebdavConfig,
  DEFAULT_CONFIG,
  googleDriveAvailable,
  IDLE_STATUS,
  INTERVAL_OPTIONS,
  isSyncing,
  loadSyncConfig,
  loadSyncStatus,
  originPattern,
  saveSyncConfig,
  SYNC_CONFIG_KEY,
  watchSyncStatus,
  type ProviderId,
  type SyncConfig,
  type SyncStatus,
} from '@/sync/config';
import { disconnectGoogle, GDRIVE_ORIGINS, getToken } from '@/sync/gdrive';
import { toast } from './toast';

/**
 * 论文库页头的"云同步"按钮（显示同步状态）和同步设置弹窗。
 * 同步本身在 background 里进行，见 src/sync/service.ts。
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initSyncUi(): void {
  const btn = $<HTMLButtonElement>('sync');
  const dialog = $<HTMLDialogElement>('dialog');
  let config: SyncConfig = DEFAULT_CONFIG;
  let status: SyncStatus = IDLE_STATUS;
  /** 弹窗打开时，状态变化后刷新弹窗里的状态行 */
  let onStatus: (() => void) | null = null;

  void Promise.all([loadSyncConfig(), loadSyncStatus()]).then(([c, s]) => {
    config = c;
    status = s;
    renderButton();
  });
  watchSyncStatus((s) => {
    status = s;
    renderButton();
    onStatus?.();
  });
  // 其他论文库标签页改了设置
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(SYNC_CONFIG_KEY in changes)) return;
    void loadSyncConfig().then((c) => {
      config = c;
      renderButton();
    });
  });
  btn.addEventListener('click', () => void openDialog());
  dialog.addEventListener('close', () => (onStatus = null));
  renderButton();
  // 打开论文库时拉取一次其他电脑上的改动
  void syncNow(true);

  function renderButton(): void {
    const on = config.provider !== 'off';
    const error = on && status.state === 'error';
    let label = '云同步';
    let title = '在多台电脑之间自动同步笔记、论文库和分组';
    if (on && isSyncing(status)) label = '同步中…';
    else if (error) {
      label = status.needsAuth ? '需要重新连接' : '同步出错';
      title = status.error ?? '';
    } else if (on && status.lastSuccessAt) {
      label = '已同步';
      title = `上次同步：${formatTime(status.lastSuccessAt)}`;
    }
    btn.innerHTML = `${error ? CLOUD_OFF_ICON : CLOUD_ICON}<span>${label}</span>`;
    btn.title = title;
    btn.classList.toggle('warn', error);
  }

  async function openDialog(): Promise<void> {
    config = await loadSyncConfig();
    const draft: SyncConfig = { ...config, webdav: { ...config.webdav } };
    const gdriveOk = googleDriveAvailable();
    let connected = false;

    const box = el('div', 'dlg');
    box.tabIndex = -1;
    box.autofocus = true;
    box.append(el('h2', '', '云同步'), el('div', 'file', '在多台电脑之间自动同步笔记、论文库和分组'));

    // ---- 存储位置 ----
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', '存储位置');
    const choices: [ProviderId, string][] = [['off', '不同步'], ['webdav', 'WebDAV'], ['gdrive', 'Google Drive']];
    for (const [value, text] of choices) {
      const label = el('label', '');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'sync-provider';
      input.value = value;
      input.checked = draft.provider === value;
      input.disabled = value === 'gdrive' && !gdriveOk;
      input.addEventListener('change', () => {
        draft.provider = value;
        setError(null);
        update();
      });
      label.append(input, el('span', '', text));
      if (input.disabled) label.title = '这个版本没有配置 Google OAuth 客户端，见 docs/sync.md';
      seg.append(label);
    }

    // ---- WebDAV ----
    const webdav = el('div', 'form');
    const w = draft.webdav;
    webdav.append(
      field('服务器地址', 'url', w.url, 'https://dav.jianguoyun.com/dav/', (v) => (w.url = v)),
      field('用户名', 'text', w.username, '坚果云填登录邮箱', (v) => (w.username = v), 'username'),
      field('密码', 'password', w.password, '坚果云填"应用密码"', (v) => (w.password = v), 'current-password'),
      field('文件夹', 'text', w.folder, 'arxiv-html-helper', (v) => (w.folder = v)),
      el(
        'p',
        'hint',
        '坚果云：网页版右上角 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用，用生成的应用密码。密码只保存在这台电脑的浏览器里。',
      ),
    );

    // ---- Google Drive ----
    const gdrive = el('div', 'form');
    const gState = el('div', 'gstate');
    const connectBtn = button('连接 Google 账号', 'btn', () => void connect());
    const disconnectBtn = button('断开', 'btn plain', () => void disconnect());
    gdrive.append(
      gState,
      el('p', 'hint', '数据保存在你 Google Drive 的应用专用文件夹里：在云端硬盘中看不到，扩展也无法访问你的其他文件。需要 Chrome 已登录 Google 账号，并且网络能访问 Google。'),
    );
    if (gdriveOk) {
      getToken(false)
        .then(() => {
          connected = true;
          update();
        })
        .catch(() => {});
    }

    async function connect(): Promise<void> {
      connectBtn.disabled = true;
      try {
        // 必须在点击后立即申请权限
        if (!(await browser.permissions.request({ origins: GDRIVE_ORIGINS }))) throw new Error('需要允许访问 Google Drive 接口');
        await getToken(true);
        connected = true;
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      connectBtn.disabled = false;
      update();
    }

    async function disconnect(): Promise<void> {
      await disconnectGoogle();
      connected = false;
      update();
    }

    // ---- 关闭 ----
    const off = el('p', 'hint', '不同步时，各台电脑的数据互不影响。关闭同步不会删除本机或云端的数据。');

    // ---- 间隔、状态 ----
    const interval = el('label', 'field');
    const select = document.createElement('select');
    for (const m of INTERVAL_OPTIONS) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = m === 60 ? '每小时' : `每 ${m} 分钟`;
      select.append(o);
    }
    select.value = String(INTERVAL_OPTIONS.includes(draft.intervalMinutes) ? draft.intervalMinutes : DEFAULT_CONFIG.intervalMinutes);
    select.addEventListener('change', () => (draft.intervalMinutes = Number(select.value)));
    interval.append(el('span', '', '检查其他电脑的改动'), select);
    const intervalHint = el('p', 'hint', '本机有改动时会在几秒后自动上传；打开论文库或论文页时也会检查一次。');
    const statusLine = el('p', 'sync-state');
    const errorLine = el('p', 'error');
    errorLine.hidden = true;

    const actions = el('div', 'dlg-actions');
    const cancel = button('取消', 'btn plain', () => dialog.close());
    const save = button('保存并同步', 'btn primary', () => void onSave());
    actions.append(cancel, save);

    box.append(seg, webdav, gdrive, off, interval, intervalHint, statusLine, errorLine, actions);
    dialog.replaceChildren(box);
    onStatus = renderStatus;
    update();
    dialog.showModal();

    function update(): void {
      const p = draft.provider;
      webdav.hidden = p !== 'webdav';
      gdrive.hidden = p !== 'gdrive';
      off.hidden = p !== 'off';
      interval.hidden = intervalHint.hidden = p === 'off';
      gState.replaceChildren(
        el('span', connected ? 'ok' : '', connected ? '已连接 Google 账号' : '尚未连接'),
        connected ? disconnectBtn : connectBtn,
      );
      save.textContent = p === 'off' ? '保存' : '保存并同步';
      renderStatus();
    }

    function renderStatus(): void {
      // 只在当前已启用的存储上显示同步状态
      const show = draft.provider !== 'off' && draft.provider === config.provider;
      const syncing = isSyncing(status);
      statusLine.hidden = !show || (!status.lastSuccessAt && !syncing);
      statusLine.textContent = syncing ? '正在同步…' : status.lastSuccessAt ? `上次同步：${formatTime(status.lastSuccessAt)}` : '';
      if (show && status.state === 'error') setError(status.error ?? '同步失败');
    }

    function setError(msg: string | null): void {
      errorLine.hidden = !msg;
      errorLine.textContent = msg ?? '';
    }

    async function onSave(): Promise<void> {
      setError(null);
      if (draft.provider === 'webdav') {
        const err = checkWebdavConfig(draft.webdav);
        if (err) return setError(err);
        // 必须在点击后立即申请权限，中间不能有其他 await
        let granted = false;
        try {
          granted = await browser.permissions.request({ origins: [originPattern(draft.webdav.url.trim())] });
        } catch (e) {
          return setError(e instanceof Error ? e.message : String(e));
        }
        if (!granted) return setError('需要允许访问这个服务器才能同步');
      }
      if (draft.provider === 'gdrive' && !connected) return setError('请先连接 Google 账号');

      save.disabled = cancel.disabled = true;
      await saveSyncConfig(draft);
      config = draft;
      renderButton();
      if (draft.provider === 'off') {
        dialog.close();
        toast('已关闭云同步');
        return;
      }
      const s = await syncNow(false);
      save.disabled = cancel.disabled = false;
      if (!s || s.state === 'error') {
        setError(s?.error ?? '同步失败');
        save.textContent = '重试';
        return;
      }
      dialog.close();
      toast(describe(s));
    }
  }
}

async function syncNow(quiet: boolean): Promise<SyncStatus | null> {
  const msg: SyncNowRequest = { type: 'ahh:sync-now', quiet };
  try {
    return ((await browser.runtime.sendMessage(msg)) as SyncStatus | undefined) ?? null;
  } catch {
    return null;
  }
}

function describe(s: SyncStatus): string {
  const c = s.changes;
  if (!c) return '同步完成';
  const parts = [
    c.added && `新增 ${c.added} 条划线`,
    c.updated && `更新 ${c.updated} 条`,
    c.removed && `删除 ${c.removed} 条`,
  ].filter(Boolean);
  if (parts.length) return `同步完成：从云端${parts.join('，')}`;
  return c.other ? '同步完成：论文库已更新' : '同步完成';
}

const formatTime = (t: number) => new Date(t).toLocaleString('zh-CN');

function field(
  label: string,
  type: string,
  value: string,
  placeholder: string,
  onInput: (v: string) => void,
  autocomplete = 'off',
): HTMLElement {
  const wrap = el('label', 'field');
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = autocomplete as AutoFill;
  input.spellcheck = false;
  input.addEventListener('input', () => onInput(input.value));
  wrap.append(el('span', '', label), input);
  return wrap;
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
