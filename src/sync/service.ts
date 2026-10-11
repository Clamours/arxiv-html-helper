import { browser } from 'wxt/browser';
import type { SyncNowRequest } from '@/core/messages';
import { fingerprint, fromStorage, isSyncedKey } from '@/core/sync';
import {
  googleDriveAvailable,
  loadSyncConfig,
  loadSyncStatus,
  SYNC_CONFIG_KEY,
  SYNC_STATUS_KEY,
  type SyncConfig,
  type SyncStatus,
} from './config';
import { syncOnce, type LocalStore } from './engine';
import { gdriveProvider } from './gdrive';
import { SyncError, type SyncProvider } from './provider';
import { webdavProvider } from './webdav';

/**
 * background 里的同步调度。触发时机：
 * - 本地数据有改动：等几秒（合并连续的改动）后同步；数据和上次同步后一样时跳过
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
  if (mode === 'push' && lastFingerprint && fingerprint(fromStorage(await store.getAll())) === lastFingerprint) return prev;

  const startedAt = Date.now();
  await writeStatus({ ...prev, state: 'syncing', lastAttemptAt: startedAt });
  let status: SyncStatus;
  try {
    const out = await syncOnce(providerFor(config), store, browser.runtime.getManifest().version);
    lastFingerprint = out.fingerprint;
    status = { state: 'idle', lastSuccessAt: Date.now(), lastAttemptAt: startedAt, changes: out.changes };
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

function providerFor(config: SyncConfig): SyncProvider {
  return config.provider === 'gdrive' ? gdriveProvider() : webdavProvider(config.webdav);
}

async function writeStatus(s: SyncStatus): Promise<void> {
  await browser.storage.local.set({ [SYNC_STATUS_KEY]: s });
}
