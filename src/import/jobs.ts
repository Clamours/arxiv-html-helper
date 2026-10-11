/**
 * PDF 导入任务：上传到 MinerU → 等待解析 → 下载结果、生成页面 → 存入本机并加入论文库。
 *
 * 任务在论文库页里运行（生成页面要用 DOM）。状态存在 chrome.storage.local（不同步、不进备份），
 * 关掉论文库再打开时继续；同一任务用 Web Locks 保证只有一个标签页在处理。
 * PDF 在任务进行期间暂存在 IndexedDB：上传和从 PDF 补图（MinerU 漏掉的图）都要用，任务结束后删除。
 */
import { browser } from 'wxt/browser';
import { extractMeta, importedPaperId, sha256Hex, type PaperMeta } from '@/core/paper';
import { recordPageMeta } from '@/core/storage';
import { deleteDoc, deletePdf, loadDoc, loadPdf, saveDoc, savePdf } from './docs';
import { removeLocalFile } from './local-file';
import { ImportError, MinerUClient, originOf, type ImportErrorKind, type ParseResult } from './mineru-api';

export const JOB_PREFIX = 'import:job:';
export const TOKEN_KEY = 'import:mineru-token';

export interface ImportJob {
  paperId: string;
  fileName: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  step: 'uploading' | 'parsing' | 'building' | 'failed';
  /** 上传完成后才有 */
  batchId?: string;
  parse?: ParseResult['state'];
  progress?: { done: number; total: number };
  error?: string;
  errorKind?: ImportErrorKind;
  /** errorKind 为 permission 时需要申请的地址 */
  origin?: string;
}

const POLL_MS = 3000;
/** 轮询时连续这么多次网络错误才算失败 */
const MAX_POLL_ERRORS = 5;

export async function loadToken(): Promise<string> {
  return ((await browser.storage.local.get(TOKEN_KEY))[TOKEN_KEY] as string | undefined) ?? '';
}

export async function saveToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token.trim() });
}

export async function loadJobs(): Promise<ImportJob[]> {
  const all = await browser.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(JOB_PREFIX))
    .map(([, v]) => v as ImportJob)
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function saveJob(job: ImportJob): Promise<void> {
  await browser.storage.local.set({ [JOB_PREFIX + job.paperId]: { ...job, updatedAt: Date.now() } });
}

export async function removeJob(paperId: string): Promise<void> {
  await browser.storage.local.remove(JOB_PREFIX + paperId);
  await deletePdf(paperId).catch(() => {});
}

export function watchJobs(cb: () => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(JOB_PREFIX))) cb();
  });
}

export interface Runner {
  /** 导入完成（页面已保存、已加入论文库）后调用；note 是需要告诉用户的情况（如从 PDF 补回了几张图） */
  onDone(paperId: string, title: string, note: string): void;
}

export type StartResult = { status: 'exists' | 'running' | 'started'; paperId: string };

export async function startImport(file: File, runner: Runner): Promise<StartResult> {
  const pdf = await file.arrayBuffer();
  const paperId = await importedPaperId(pdf);
  // 同一个 PDF 已经导入过：沿用已有页面，不再解析（页面一经生成不再改变）
  if (await loadDoc(paperId)) return { status: 'exists', paperId };
  const cur = (await browser.storage.local.get(JOB_PREFIX + paperId))[JOB_PREFIX + paperId] as ImportJob | undefined;
  if (cur && cur.step !== 'failed') return { status: 'running', paperId };
  const now = Date.now();
  await savePdf(paperId, pdf);
  await saveJob({ paperId, fileName: file.name, size: file.size, createdAt: now, updatedAt: now, step: 'uploading' });
  void process(paperId, runner);
  return { status: 'started', paperId };
}

/** 重试失败的任务（不会重复上传已经上传成功的 PDF） */
export async function retryJob(paperId: string, runner: Runner): Promise<void> {
  const job = await getJob(paperId);
  if (!job) return;
  await saveJob({ ...job, step: job.batchId ? 'parsing' : 'uploading', error: undefined, errorKind: undefined, origin: undefined });
  void process(paperId, runner);
}

/** 论文库打开时继续处理未完成的任务 */
export async function resumeJobs(runner: Runner): Promise<void> {
  for (const job of await loadJobs()) if (job.step !== 'failed') void process(job.paperId, runner);
}

async function getJob(paperId: string): Promise<ImportJob | null> {
  return ((await browser.storage.local.get(JOB_PREFIX + paperId))[JOB_PREFIX + paperId] as ImportJob | undefined) ?? null;
}

async function ensureOrigin(url: string): Promise<void> {
  const origin = originOf(url);
  if (!(await browser.permissions.contains({ origins: [origin] }))) {
    throw new ImportError(`需要允许访问 ${new URL(url).host}`, 'permission', origin);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 任务在处理过程中被用户移除 */
class Cancelled extends Error {}

function process(paperId: string, runner: Runner): Promise<void> {
  return navigator.locks.request(`ahh-import:${paperId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return; // 另一个论文库标签页正在处理
    let job = await getJob(paperId);
    if (!job || job.step === 'failed') return;
    const alive = async () => {
      if (!(await getJob(paperId))) throw new Cancelled();
    };
    const update = async (patch: Partial<ImportJob>) => {
      await alive();
      job = { ...job!, ...patch };
      await saveJob(job);
    };
    try {
      const client = new MinerUClient(await loadToken());
      if (!job.batchId) {
        const pdf = await loadPdf(paperId);
        if (!pdf) throw new ImportError('找不到要上传的 PDF，请移除这个任务后重新导入', 'file');
        const { batchId, uploadUrl } = await client.createUpload(paperId);
        await ensureOrigin(uploadUrl);
        await client.upload(uploadUrl, pdf);
        await update({ step: 'parsing', batchId, parse: 'pending' });
      }

      let zipUrl = '';
      for (let errors = 0; !zipUrl; ) {
        await alive();
        let r: ParseResult;
        try {
          r = await client.result(job.batchId!);
          errors = 0;
        } catch (e) {
          if (!(e instanceof ImportError && e.kind === 'network') || ++errors >= MAX_POLL_ERRORS) throw e;
          await sleep(POLL_MS);
          continue;
        }
        if (r.state === 'failed') throw new ImportError(r.error ?? 'MinerU 解析失败', 'remote');
        if (r.state === 'done') zipUrl = r.zipUrl!;
        else {
          if (r.state !== job.parse || r.progress?.done !== job.progress?.done) await update({ parse: r.state, progress: r.progress });
          await sleep(POLL_MS);
        }
      }

      await update({ step: 'building', progress: undefined });
      await ensureOrigin(zipUrl);
      const zip = await client.download(zipUrl);
      // 转换器（含 Temml、fflate）只在生成页面时加载，论文库页打开时不需要
      const { buildPageFromZip } = await import('./bundle').catch(() => {
        // 扩展重新构建 / 更新后，旧页面里记着的代码文件名已经不存在了
        throw new ImportError('扩展已更新，请刷新论文库页面后点"重试"（不会重新上传和解析）', 'remote');
      });
      // 早期版本创建的任务没有暂存 PDF，这时不补图
      const pdf = await loadPdf(paperId);
      const built = await buildPageFromZip(document, zip, {
        paperId,
        recoverFigures: pdf
          ? async (numbers) => {
              const { recoverFiguresFromPdf } = await import('./pdf-loader');
              return recoverFiguresFromPdf(pdf, numbers);
            }
          : undefined,
        fetchImage: async (url) => {
          if (!(await browser.permissions.contains({ origins: [originOf(url)] }))) return null;
          const res = await fetch(url, { credentials: 'omit' });
          if (!res.ok) return null;
          return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] || 'image/jpeg' };
        },
      });
      const bytes = new TextEncoder().encode(built.html);
      const sha256 = await sha256Hex(bytes);
      const now = Date.now();
      await alive();
      await saveDoc({ id: paperId, html: built.html, sha256 });
      // 标题和作者按内容脚本在页面上提取的方式取，两边一致
      const fromPage = extractMeta(new DOMParser().parseFromString(built.html, 'text/html'), { id: paperId, version: '' }, now);
      const meta: PaperMeta = { ...fromPage, doc: { sha256, size: bytes.length, importedAt: now, fileName: job.fileName } };
      await recordPageMeta(meta);
      await removeJob(paperId);
      const notes = [
        built.recoveredFigures && `MinerU 漏掉的 ${built.recoveredFigures} 张图已从 PDF 补回`,
        built.missingFigures && `${built.missingFigures} 张图没能识别，只显示图注`,
      ].filter(Boolean);
      runner.onDone(paperId, meta.title, notes.join('；'));
    } catch (e) {
      if (e instanceof Cancelled) return;
      const err = e instanceof ImportError ? e : new ImportError(e instanceof Error ? e.message : String(e), 'remote');
      // 连不上的服务器可能只是还没有访问权限（没有权限时请求会被 CORS 拦下，看起来像网络错误）
      let kind = err.kind;
      if (kind === 'network' && err.origin && !(await browser.permissions.contains({ origins: [err.origin] }))) kind = 'permission';
      const error = kind === 'permission' && err.origin ? `需要允许访问 ${err.origin.replace(/^https?:\/\/|\/\*$/g, '')}` : err.message;
      await update({ step: 'failed', error, errorKind: kind, origin: err.origin }).catch(() => {});
    }
  });
}

/** 从论文库移除导入的论文时，一并删除本机的页面和本地文件 */
export async function removeImportedPage(paperId: string): Promise<void> {
  const doc = await loadDoc(paperId);
  if (doc) await removeLocalFile(doc);
  await deleteDoc(paperId);
}
