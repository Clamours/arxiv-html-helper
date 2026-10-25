/** 云端存储：只需要读、写、删除一个文件 */
export interface SyncProvider {
  read(): Promise<RemoteFile>;
  /**
   * 覆盖写入。prev 是之前 read 的结果，没有读过时传 { texts: [] }（只能直接覆盖）。
   * conditional 为 true 时，云端在 read 之后被其他电脑改过就抛出 kind 为 conflict 的 SyncError
   * （服务器不支持时退化为直接覆盖，下一次同步会把对方的改动合并回来）
   */
  write(text: string, prev: RemoteFile, conditional: boolean): Promise<void>;
  /** 删除；文件不存在时什么也不做 */
  remove(): Promise<void>;
}

export interface RemoteFile {
  /** 文件内容；文件不存在时为空数组。Google Drive 偶尔会出现多个同名文件，全部读出来合并 */
  texts: string[];
  /** 写入时需要的版本信息（ETag、文件 id 等），由各 provider 自己解释 */
  version?: unknown;
}

export type SyncErrorKind = 'auth' | 'network' | 'conflict' | 'remote';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly kind: SyncErrorKind,
  ) {
    super(message);
  }
}

/** fetch 失败（断网、DNS、证书、CORS 等）统一成网络错误 */
export async function request(url: string, init: RequestInit, unreachable: string): Promise<Response> {
  try {
    return await fetch(url, { cache: 'no-store', credentials: 'omit', ...init });
  } catch {
    throw new SyncError(unreachable, 'network');
  }
}
