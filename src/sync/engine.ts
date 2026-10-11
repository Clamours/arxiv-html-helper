import { BackupError, parseBackup } from '@/core/backup';
import {
  emptySyncData,
  fingerprint,
  fromBackup,
  fromStorage,
  mergeSync,
  planLocalWrites,
  stableStringify,
  toSyncFile,
  type LocalChanges,
} from '@/core/sync';
import { SyncError, type SyncProvider } from './provider';

/**
 * 一次同步：下载云端文件 → 与本地合并 → 写回本地（只写有变化的键）→ 云端内容不同则上传。
 * 不直接依赖 chrome.storage，方便用内存里的假存储测试两台电脑的同步。
 */

export interface LocalStore {
  getAll(): Promise<Record<string, unknown>>;
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface SyncOutcome {
  changes: LocalChanges;
  uploaded: boolean;
  /** 同步后本地数据的指纹；本地改动后与它相同说明不需要再同步 */
  fingerprint: string;
}

/** 本地在同步过程中被改动、或云端被其他电脑同时写入时，最多重来几次 */
const MAX_ATTEMPTS = 3;

export async function syncOnce(
  provider: SyncProvider,
  store: LocalStore,
  extensionVersion: string,
  now: () => number = Date.now,
): Promise<SyncOutcome> {
  const changes: LocalChanges = { added: 0, updated: 0, removed: 0, other: 0 };
  for (let attempt = 1; ; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    const t = now();
    const file = await provider.read();
    let remote = emptySyncData();
    for (const text of file.texts) {
      try {
        remote = mergeSync(remote, fromBackup(parseBackup(text)), t);
      } catch (e) {
        if (!(e instanceof BackupError)) throw e;
        // 不覆盖读不懂的文件，以免丢数据
        throw new SyncError(`云端的同步文件无法读取（${e.message}），已暂停同步`, 'remote');
      }
    }

    const all = await store.getAll();
    const merged = mergeSync(fromStorage(all), remote, t);
    const plan = planLocalWrites(all, merged);
    const keys = [...Object.keys(plan.set), ...plan.remove];
    if (keys.length) {
      // 合并期间本地又有改动（如正在写笔记）时不覆盖，重新来过
      const fresh = await store.get(keys);
      if (keys.some((k) => stableStringify(fresh[k]) !== stableStringify(all[k]))) {
        if (last) throw new SyncError('本地数据正在变化，稍后会自动重试', 'conflict');
        continue;
      }
      if (Object.keys(plan.set).length) await store.set(plan.set);
      if (plan.remove.length) await store.remove(plan.remove);
      for (const k of Object.keys(changes) as (keyof LocalChanges)[]) changes[k] += plan.changes[k];
    }

    const fp = fingerprint(merged);
    const uploaded = file.texts.length !== 1 || fingerprint(remote) !== fp;
    if (uploaded) {
      try {
        // 最后一次不再检测冲突，直接覆盖
        await provider.write(JSON.stringify(toSyncFile(merged, extensionVersion, new Date(t))), file, !last);
      } catch (e) {
        if (e instanceof SyncError && e.kind === 'conflict' && !last) continue;
        throw e;
      }
    }
    return { changes, uploaded, fingerprint: fp };
  }
}
