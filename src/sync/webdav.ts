import { SYNC_FILE_NAME, webdavFolderUrl, type WebdavConfig } from './config';
import { request, SyncError, type RemoteFile, type SyncProvider } from './provider';

/**
 * WebDAV（坚果云、Nextcloud、群晖等）：设置的文件夹里的一个 JSON 文件（默认是同步文件，译文存档和导入论文的页面另有文件）。
 * 用 ETag + If-Match 检测两台电脑同时写入；服务器不支持时退化为直接覆盖。
 */
export function webdavProvider(config: WebdavConfig, name = SYNC_FILE_NAME): SyncProvider {
  const folder = webdavFolderUrl(config);
  const file = folder + encodeURIComponent(name);
  const auth = `Basic ${base64(`${config.username.trim()}:${config.password}`)}`;
  const unreachable = '无法连接到 WebDAV 服务器，请检查地址和网络';

  async function call(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
    const res = await request(url, { method, headers: { Authorization: auth, ...headers }, body }, unreachable);
    if (res.status === 401) throw new SyncError('WebDAV 用户名或密码错误（坚果云需要使用"应用密码"）', 'auth');
    if (res.status === 403) throw new SyncError('WebDAV 服务器拒绝访问（403），请检查账号权限和文件夹', 'auth');
    return res;
  }

  /** 逐级创建文件夹；已存在时服务器返回 405 */
  async function ensureFolder(): Promise<void> {
    let url = config.url.trim().replace(/\/+$/, '');
    const parts = config.folder.split('/').map((s) => s.trim()).filter(Boolean).map(encodeURIComponent);
    for (const part of parts) {
      url += `/${part}`;
      const res = await call('MKCOL', `${url}/`);
      if (!res.ok && res.status !== 405) throw new SyncError(`无法在服务器上创建文件夹（HTTP ${res.status}）`, 'remote');
    }
  }

  async function put(text: string, etag: string | null): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (etag) headers['If-Match'] = etag;
    return call('PUT', file, headers, text);
  }

  return {
    async read(): Promise<RemoteFile> {
      const res = await call('GET', file);
      // 文件夹不存在时坚果云返回 409（AncestorsNotFound），等同于文件不存在；写入时再创建文件夹
      if (res.status === 404 || res.status === 409) return { texts: [] };
      if (!res.ok) throw new SyncError(`读取云端文件失败（HTTP ${res.status}）`, 'remote');
      return { texts: [await res.text()], version: res.headers.get('ETag') };
    },

    async write(text, prev, conditional) {
      // 弱 ETag（W/"…"）不能用于 If-Match
      const tag = typeof prev.version === 'string' && !prev.version.startsWith('W/') ? prev.version : null;
      let res = await put(text, conditional ? tag : null);
      if (res.status === 404 || res.status === 409) {
        // 文件夹不存在
        await ensureFolder();
        res = await put(text, null);
      }
      if (res.status === 412) throw new SyncError('云端文件刚被其他电脑修改过', 'conflict');
      if (!res.ok) throw new SyncError(`上传到 WebDAV 失败（HTTP ${res.status}）`, 'remote');
    },

    async remove() {
      const res = await call('DELETE', file);
      // 404：文件不存在；409：文件夹不存在
      if (!res.ok && res.status !== 404 && res.status !== 409) throw new SyncError(`删除 WebDAV 上的文件失败（HTTP ${res.status}）`, 'remote');
    },
  };
}

function base64(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}
