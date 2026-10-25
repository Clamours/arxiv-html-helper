import { browser } from 'wxt/browser';
import { libraryDocs } from '@/core/docs';
import type { SyncNowRequest } from '@/core/messages';
import { fingerprint, fromStorage, isSyncedKey } from '@/core/sync';
import { localDocs } from '@/imported/db';
import { localTranslations } from '@/translations/db';
import { broadcastTranslationsChanged } from '@/translations/service';
import {
  googleDriveAvailable,
  loadSyncConfig,
  loadSyncStatus,
  SYNC_CONFIG_KEY,
  SYNC_FILE_NAME,
  SYNC_STATUS_KEY,
  type SyncConfig,
  type SyncStatus,
} from './config';
import { syncDocs } from './docs';
import { syncOnce, type LocalStore } from './engine';
import { gdriveProvider } from './gdrive';
import { SyncError, type SyncProvider } from './provider';
import { syncTranslations } from './translations';
import { webdavProvider } from './webdav';

/**
 * background 里的同步调度。触发时机：
 * - 本地数据有改动：等几秒（合并连续的改动）后同步；数据和上次同步后一样时跳过。
 *   译文存档不在 storage 里，有改动时由译文存档服务调用 markTranslationsDirty；
 *   导入论文的页面也不在 storage 里，但导入、移除时论文库同时改变，会一起同步
 * - 定时：按设置的间隔拉取其他电脑的改动
 * - 浏览器启动；论文库页、论文页打开时（最近半分钟内同步过就跳过）；手动"立即同步"
 * 同一时间只有一次同步在进行，排队中的请求合并为一次。
 */

const ALARM = 'ahh-sync';
const DEBOUNCE_MS = 4000;
const QUIET_GAP_MS = 30_000;

type Mode = 'push' | 'full';

const store: LocalStore = {
  getAll: () => browser.storage.local.get(null),
  get: (keys) => browser.storage.local.get(keys),
  set: (items) => browser.storage.local.set(items),
  remove: (keys) => browser.storage.local.remove(keys),
};

/** 上次同步后本地数据的指纹；service worker 重启后丢失，此时做一次完整同步 */
let lastFingerprint: string | null = null;
let pending: { mode: Mode; promise: Promise<SyncStatus> } | null = null;
let tail: Promise<unknown> = Promise.resolve();
let debounce: ReturnType<typeof setTimeout> | undefined;
/** 本机译文存档有还没上传的改动；service worker 重启后丢失，下一次定时同步会补上 */
let translationsDirty = false;

/** 本机译文存档有改动：几秒后同步 */
export function markTranslationsDirty(): void {
  translationsDirty = true;
  clearTimeout(debounce);
  debounce = setTimeout(() => void requestSync('push'), DEBOUNCE_MS);
}

export function initSyncService(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void requestSync('full');
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (SYNC_CONFIG_KEY in changes) {
      lastFingerprint = null;
      void setupAlarm();
    }
    if (Object.keys(changes).some(isSyncedKey)) {
      clearTimeout(debounce);
      debounce = setTimeout(() => void requestSync('push'), DEBOUNCE_MS);
    }
  });
  browser.runtime.onStartup.addListener(() => void requestSync('full'));
  browser.runtime.onMessage.addListener((msg: SyncNowRequest, _sender, sendResponse) => {
    if (msg?.type !== 'ahh:sync-now') return;
    void (msg.quiet ? quietSync() : requestSync('full')).then(sendResponse);
    return true; // 异步回复
  });
  // 浏览器重启后定时器不一定还在
  void setupAlarm();
}

async function setupAlarm(): Promise<void> {
  const config = await loadSyncConfig();
  if (!enabled(config)) {
    await browser.alarms.clear(ALARM);
    return;
  }
  const cur = await browser.alarms.get(ALARM);
  if (cur?.periodInMinutes !== config.intervalMinutes) {
    await browser.alarms.create(ALARM, { periodInMinutes: config.intervalMinutes });
  }
}

const enabled = (c: SyncConfig) => c.provider === 'webdav' || (c.provider === 'gdrive' && googleDriveAvailable());

async function quietSync(): Promise<SyncStatus> {
  const status = await loadSyncStatus();
  if (Date.now() - status.lastAttemptAt < QUIET_GAP_MS) return status;
  return requestSync('full');
}

function requestSync(mode: Mode): Promise<SyncStatus> {
  if (pending) {
    // 还没开始的请求会读到最新数据，合并即可
    if (mode === 'full') pending.mode = 'full';
    return pending.promise;
  }
  const entry: { mode: Mode; promise: Promise<SyncStatus> } = { mode, promise: Promise.resolve(null as never) };
  entry.promise = tail.then(() => {
    pending = null;
    return run(entry.mode);
  });
  pending = entry;
  tail = entry.promise.catch(() => {});
  return entry.promise;
}

async function run(mode: Mode): Promise<SyncStatus> {
  const config = await loadSyncConfig();
  const prev = await loadSyncStatus();
  if (!enabled(config)) return prev;
  // 笔记等数据和上次同步后一样时，主同步文件不用动
  const notesClean =
    mode === 'push' && !!lastFingerprint && fingerprint(fromStorage(await store.getAll())) === lastFingerprint;
  if (notesClean && !translationsDirty) return prev;

  const startedAt = Date.now();
  await writeStatus({ ...prev, state: 'syncing', lastAttemptAt: startedAt });
  let status: SyncStatus;
  const file = filesFor(config);
  try {
    let changes = prev.changes;
    if (!notesClean) {
      const out = await syncOnce(file(SYNC_FILE_NAME), store, browser.runtime.getManifest().version);
      lastFingerprint = out.fingerprint;
      changes = out.changes;
    }
    translationsDirty = false;
    try {
      const updated = await syncTranslations(file, localTranslations);
      if (updated.length) void broadcastTranslationsChanged(updated);
    } catch (e) {
      translationsDirty = true;
      throw e;
    }
    await syncDocs(file, localDocs, async () => libraryDocs(await store.getAll()));
    status = { state: 'idle', lastSuccessAt: Date.now(), lastAttemptAt: startedAt, ...(changes ? { changes } : {}) };
  } catch (e) {
    lastFingerprint = null;
    const auth = e instanceof SyncError && e.kind === 'auth';
    status = {
      state: 'error',
      lastSuccessAt: prev.lastSuccessAt,
      lastAttemptAt: startedAt,
      error: e instanceof SyncError ? e.message : `同步失败：${e instanceof Error ? e.message : String(e)}`,
      ...(auth && config.provider === 'gdrive' ? { needsAuth: true } : {}),
    };
  }
  await writeStatus(status);
  return status;
}

/** 云端的某个文件 */
function filesFor(config: SyncConfig): (name: string) => SyncProvider {
  return config.provider === 'gdrive' ? (name) => gdriveProvider(name) : (name) => webdavProvider(config.webdav, name);
}

async function writeStatus(s: SyncStatus): Promise<void> {
  await browser.storage.local.set({ [SYNC_STATUS_KEY]: s });
}
