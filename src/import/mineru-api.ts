/**
 * MinerU 精准解析 API（v4），文档：https://mineru.net/apiManage/docs
 *
 * 流程：申请上传地址 → PUT 上传 PDF（上传完成后 MinerU 自动开始解析）→ 轮询结果 → 下载 zip。
 * fetch 由调用方传入，方便测试。扩展页面有对应的 host 权限时不受 CORS 限制。
 */

export const MINERU_API = 'https://mineru.net/api/v4';

/**
 * 需要访问的服务器：接口、上传地址（阿里云 OSS）、结果 zip（CDN）。
 * 上传地址、结果地址的主机以接口返回为准，变了的话按 ImportError.origin 另行申请
 */
export const MINERU_ORIGINS = [
  'https://mineru.net/*',
  'https://mineru.oss-cn-shanghai.aliyuncs.com/*',
  'https://cdn-mineru.openxlab.org.cn/*',
];

export type ImportErrorKind = 'auth' | 'permission' | 'file' | 'network' | 'remote';

export class ImportError extends Error {
  constructor(
    message: string,
    readonly kind: ImportErrorKind,
    /** kind 为 permission 时：需要申请访问权限的地址模式 */
    readonly origin?: string,
  ) {
    super(message);
  }
}

/** 一个文件的解析进度 */
export interface ParseResult {
  state: 'waiting-file' | 'pending' | 'running' | 'converting' | 'done' | 'failed';
  error?: string;
  zipUrl?: string;
  /** running 时才有 */
  progress?: { done: number; total: number };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** 访问权限的匹配模式：https://host/* */
export const originOf = (url: string) => `${new URL(url).origin}/*`;

/** MinerU 的错误码 → 说明（见文档"错误码"一节） */
const ERRORS: Record<string, [string, ImportErrorKind]> = {
  A0202: ['MinerU Token 不正确，请检查后重新填写', 'auth'],
  A0211: ['MinerU Token 已过期，请在 mineru.net 的 API 管理页面创建新的 Token', 'auth'],
  '-60002': ['无法识别文件类型，请确认是 PDF 文件', 'file'],
  '-60003': ['PDF 读取失败，请检查文件是否损坏', 'file'],
  '-60004': ['PDF 是空文件', 'file'],
  '-60005': ['PDF 超过 200 MB，MinerU 无法解析', 'file'],
  '-60006': ['PDF 超过 200 页，MinerU 无法解析，请拆分后重试', 'file'],
  '-60007': ['MinerU 模型服务暂时不可用，请稍后重试', 'remote'],
  '-60009': ['MinerU 任务队列已满，请稍后重试', 'remote'],
  '-60010': ['MinerU 解析失败，请稍后重试', 'remote'],
};

export function mineruError(code: unknown, msg: unknown): ImportError {
  const known = ERRORS[String(code)];
  if (known) return new ImportError(known[0], known[1]);
  return new ImportError(`MinerU 返回错误（${String(code)}）${msg ? `：${String(msg)}` : ''}`, 'remote');
}

export class MinerUClient {
  private token: string;

  constructor(
    token: string,
    private fetchFn: Fetch = (url, init) => fetch(url, init),
  ) {
    this.token = token.trim().replace(/^Bearer\s+/i, '');
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { cache: 'no-store', credentials: 'omit', ...init });
    } catch {
      throw new ImportError(`无法连接到 ${new URL(url).host}，请检查网络`, 'network', originOf(url));
    }
  }

  /** 调用接口，返回 data 字段 */
  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(`${MINERU_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...init.headers },
    });
    type Body = { code?: unknown; msg?: unknown; data?: T };
    let body: Body | null = null;
    try {
      body = (await res.json()) as Body;
    } catch {
      // 非 JSON 响应，按 HTTP 状态处理
    }
    if (body && body.code !== undefined && body.code !== 0) throw mineruError(body.code, body.msg);
    if (res.status === 401 || res.status === 403) throw new ImportError('MinerU Token 不正确或已过期，请重新填写', 'auth');
    if (!res.ok || !body?.data) throw new ImportError(`MinerU 接口返回错误（HTTP ${res.status}）`, 'remote');
    return body.data;
  }

  /** 申请上传地址；dataId 会原样出现在结果里 */
  async createUpload(dataId: string): Promise<{ batchId: string; uploadUrl: string }> {
    const data = await this.api<{ batch_id?: string; file_urls?: string[] }>('/file-urls/batch', {
      method: 'POST',
      body: JSON.stringify({
        // 文件名只用来判断格式，不上传原文件名
        files: [{ name: `${dataId}.pdf`, data_id: dataId }],
        model_version: 'vlm',
        enable_formula: true,
        enable_table: true,
      }),
    });
    const uploadUrl = data.file_urls?.[0];
    if (!data.batch_id || !uploadUrl) throw new ImportError('MinerU 没有返回上传地址', 'remote');
    return { batchId: data.batch_id, uploadUrl };
  }

  /**
   * 上传 PDF。body 用 ArrayBuffer：传 File / Blob 时浏览器会自动加上 Content-Type，
   * 而文档要求不设置 Content-Type（预签名地址的签名不包含它）
   */
  async upload(uploadUrl: string, pdf: ArrayBuffer): Promise<void> {
    const res = await this.send(uploadUrl, { method: 'PUT', body: pdf });
    if (!res.ok) throw new ImportError(`上传 PDF 失败（HTTP ${res.status}）`, 'remote');
  }

  async result(batchId: string): Promise<ParseResult> {
    const data = await this.api<{ extract_result?: RawResult[] }>(`/extract-results/batch/${encodeURIComponent(batchId)}`);
    const r = data.extract_result?.[0];
    // 上传完成到 MinerU 扫描到文件之间，结果列表可能是空的
    if (!r) return { state: 'waiting-file' };
    const state = STATES.includes(r.state as ParseResult['state']) ? (r.state as ParseResult['state']) : 'pending';
    const out: ParseResult = { state };
    if (state === 'failed') out.error = r.err_msg || 'MinerU 解析失败';
    if (state === 'done') {
      if (!r.full_zip_url) throw new ImportError('MinerU 没有返回解析结果的下载地址', 'remote');
      out.zipUrl = r.full_zip_url;
    }
    const p = r.extract_progress;
    if (state === 'running' && p && typeof p.total_pages === 'number' && p.total_pages > 0) {
      out.progress = { done: p.extracted_pages ?? 0, total: p.total_pages };
    }
    return out;
  }

  /** 下载结果 zip（不需要 Token） */
  async download(url: string): Promise<Uint8Array> {
    const res = await this.send(url, {});
    if (!res.ok) throw new ImportError(`下载解析结果失败（HTTP ${res.status}）`, 'remote');
    return new Uint8Array(await res.arrayBuffer());
  }
}

const STATES: ParseResult['state'][] = ['waiting-file', 'pending', 'running', 'converting', 'done', 'failed'];

interface RawResult {
  state?: string;
  err_msg?: string;
  full_zip_url?: string;
  extract_progress?: { extracted_pages?: number; total_pages?: number };
}
