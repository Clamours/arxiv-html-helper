import { browser } from 'wxt/browser';
import type { LocalChanges } from '@/core/sync';

/**
 * 云同步的设置和状态，存在 chrome.storage.local（不参与同步，也不进备份）。
 * 设置由论文库页的同步设置写入；状态由 background 写入，论文库页监听它显示同步状态。
 */

export const SYNC_CONFIG_KEY = 'sync:config';
export const SYNC_STATUS_KEY = 'sync:status';
/** 云端文件名；WebDAV 放在设置的文件夹里，Google Drive 放在应用专用文件夹里 */
export const SYNC_FILE_NAME = 'arxiv-notes-sync.json';

export type ProviderId = 'off' | 'webdav' | 'gdrive';

export interface WebdavConfig {
  /** 服务器地址，如 https://dav.jianguoyun.com/dav/ */
  url: string;
  username: string;
  /** 坚果云等需要填"应用密码"，不是登录密码 */
  password: string;
  /** 服务器上存放同步文件的文件夹，可以有多级 */
  folder: string;
}

export interface SyncConfig {
  provider: ProviderId;
  /** 定时拉取的间隔；本地有改动时另外会在几秒后同步 */
  intervalMinutes: number;
  webdav: WebdavConfig;
}

export const INTERVAL_OPTIONS = [1, 5, 15, 60];

export const DEFAULT_CONFIG: SyncConfig = {
  provider: 'off',
  intervalMinutes: 5,
  webdav: { url: '', username: '', password: '', folder: 'arxiv-notes' },
};

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error';
  /** 最近一次成功的时间；0 表示还没成功过 */
  lastSuccessAt: number;
  lastAttemptAt: number;
  /** state 为 error 时的说明 */
  error?: string;
  /** Google 授权失效等，需要用户重新连接 */
  needsAuth?: boolean;
  /** 最近一次成功同步对本地的改动 */
  changes?: LocalChanges;
}

export const IDLE_STATUS: SyncStatus = { state: 'idle', lastSuccessAt: 0, lastAttemptAt: 0 };

export async function loadSyncConfig(): Promise<SyncConfig> {
  const stored = (await browser.storage.local.get(SYNC_CONFIG_KEY))[SYNC_CONFIG_KEY] as Partial<SyncConfig> | undefined;
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    webdav: { ...DEFAULT_CONFIG.webdav, ...stored?.webdav },
  };
}

export async function saveSyncConfig(config: SyncConfig): Promise<void> {
  await browser.storage.local.set({ [SYNC_CONFIG_KEY]: config });
}

export async function loadSyncStatus(): Promise<SyncStatus> {
  return ((await browser.storage.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY] as SyncStatus | undefined) ?? IDLE_STATUS;
}

export function watchSyncStatus(cb: (s: SyncStatus) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && SYNC_STATUS_KEY in changes) cb((changes[SYNC_STATUS_KEY]!.newValue as SyncStatus | undefined) ?? IDLE_STATUS);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** 构建时配置了 Google OAuth client ID 才能用 Google Drive，见 docs/sync.md */
export function googleDriveAvailable(): boolean {
  return !!browser.runtime.getManifest().oauth2?.client_id;
}

/** WebDAV 文件夹的完整地址，以 / 结尾 */
export function webdavFolderUrl(c: WebdavConfig): string {
  const base = c.url.trim().replace(/\/+$/, '');
  const parts = c.folder.split('/').map((s) => s.trim()).filter(Boolean).map(encodeURIComponent);
  return `${[base, ...parts].join('/')}/`;
}

/** 申请 WebDAV 服务器的访问权限时用的匹配模式；不带端口，匹配该主机的所有端口 */
export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

/** 同步进行中时 service worker 被结束，状态会停在 syncing；超过这个时间视为已结束 */
export const STALE_SYNCING_MS = 2 * 60 * 1000;

export const isSyncing = (s: SyncStatus, now = Date.now()) => s.state === 'syncing' && now - s.lastAttemptAt < STALE_SYNCING_MS;

/** 校验 WebDAV 设置，返回错误说明；没问题时返回 null */
export function checkWebdavConfig(c: WebdavConfig): string | null {
  let u: URL;
  try {
    u = new URL(c.url.trim());
  } catch {
    return '服务器地址格式不对，应以 https:// 开头';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '服务器地址应以 https:// 开头';
  if (!c.username.trim()) return '请填写用户名';
  if (!c.password) return '请填写密码';
  return null;
}
