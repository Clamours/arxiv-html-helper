import { browser } from 'wxt/browser';
import { SYNC_FILE_NAME } from './config';
import { request, SyncError, type RemoteFile, type SyncProvider } from './provider';

/**
 * Google Drive：文件放在应用专用文件夹（appDataFolder）里，用户在云端硬盘里看不到，
 * 扩展也只能访问这个文件夹（drive.appdata 权限）。授权用 chrome.identity，需要 Chrome 登录 Google 账号。
 */

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
/** 连接时申请的访问权限 */
export const GDRIVE_ORIGINS = ['https://www.googleapis.com/*'];

const unreachable = '无法连接到 Google Drive，请检查网络';

/** 获取访问令牌；interactive 为 true 时必要时弹出 Google 授权窗口 */
export async function getToken(interactive: boolean): Promise<string> {
  let token: string | undefined;
  try {
    token = (await browser.identity.getAuthToken({ interactive })).token;
  } catch (e) {
    if (interactive) throw new SyncError(`Google 授权失败：${e instanceof Error ? e.message : String(e)}`, 'auth');
  }
  if (!token) throw new SyncError('Google 账号授权已失效，请在同步设置里重新连接', 'auth');
  return token;
}

/** 断开：清除 Chrome 缓存的令牌和授权状态 */
export async function disconnectGoogle(): Promise<void> {
  await browser.identity.clearAllCachedAuthTokens();
}

async function call(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await getToken(false);
  const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` };
  const res = await request(url, { ...init, headers }, unreachable);
  if (res.status === 401) {
    // 令牌过期：清掉缓存再试一次
    await browser.identity.removeCachedAuthToken({ token });
    if (retry) return call(url, init, false);
    throw new SyncError('Google 账号授权已失效，请在同步设置里重新连接', 'auth');
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
    } catch {
      // 忽略
    }
    throw new SyncError(`Google Drive 返回错误（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, 'remote');
  }
  return res;
}

export function gdriveProvider(): SyncProvider {
  return {
    async read(): Promise<RemoteFile> {
      const q = encodeURIComponent(`name = '${SYNC_FILE_NAME}' and trashed = false`);
      const res = await call(`${FILES}?spaces=appDataFolder&q=${q}&fields=files(id)&orderBy=createdTime&pageSize=10`);
      const ids = ((await res.json()) as { files?: { id: string }[] }).files?.map((f) => f.id) ?? [];
      const texts = await Promise.all(ids.map(async (id) => (await call(`${FILES}/${id}?alt=media`)).text()));
      return { texts, version: ids };
    },

    async write(text, prev) {
      // Drive 不支持条件写入；两台电脑同时写入时，下一次同步会把被覆盖的改动合并回来
      const ids = Array.isArray(prev.version) ? (prev.version as string[]) : [];
      if (ids[0]) {
        await call(`${UPLOAD}/${ids[0]}?uploadType=media`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: text,
        });
      } else {
        const boundary = `ahh${crypto.randomUUID()}`;
        const metadata = { name: SYNC_FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' };
        const body = [
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          JSON.stringify(metadata),
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          text,
          `--${boundary}--`,
          '',
        ].join('\r\n');
        await call(`${UPLOAD}?uploadType=multipart`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        });
      }
      // 多余的同名文件已经合并进来了
      for (const id of ids.slice(1)) await call(`${FILES}/${id}`, { method: 'DELETE' }).catch(() => {});
    },
  };
}
