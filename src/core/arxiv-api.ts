/**
 * 从 arXiv 官方 API 获取论文元数据（与 abs 页的 citation_* 标签同源，但能批量查询）。
 * https://info.arxiv.org/help/api/user-manual.html
 *
 * 需要 host_permissions: https://export.arxiv.org/*，且只能在有 DOMParser 的页面里调用
 * （扩展页可以，service worker 不行）。
 */

export interface ApiMeta {
  id: string;
  title: string;
  authors: string[];
  /** 首个版本的发布时间（ISO） */
  published: string;
  abstract: string;
  /** 主分类，如 cs.CL */
  category: string;
  /** 最新版本，如 v7 */
  latestVersion: string;
  /** 最新版本的发布时间（ISO） */
  updated: string;
  /** 以下几项作者没填时为空串 */
  doi: string;
  /** 正式发表的期刊、会议 */
  journalRef: string;
  /** 作者的备注，常写页数、录用的会议 */
  comment: string;
}

const API = 'https://export.arxiv.org/api/query';
const ATOM = 'http://www.w3.org/2005/Atom';
const ARXIV = 'http://arxiv.org/schemas/atom';
/** 单次请求的 id 数；arXiv 要求连续请求间隔至少 3 秒 */
const BATCH = 50;
const INTERVAL_MS = 3000;

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** 解析 API 返回的 Atom。无效 id 不会出现在结果里。 */
export function parseArxivFeed(xml: string): ApiMeta[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: ApiMeta[] = [];
  for (const entry of Array.from(doc.getElementsByTagNameNS(ATOM, 'entry'))) {
    const child = (name: string, ns = ATOM) => entry.getElementsByTagNameNS(ns, name)[0]?.textContent;
    // <id>http://arxiv.org/abs/2305.10403v3</id>，旧式 id 形如 abs/hep-th/9901001v3
    const m = /\/abs\/(.+?)(v\d+)?$/.exec(oneLine(child('id')));
    if (!m) continue;
    const authors = Array.from(entry.getElementsByTagNameNS(ATOM, 'author'))
      .map((a) => oneLine(a.getElementsByTagNameNS(ATOM, 'name')[0]?.textContent))
      .filter(Boolean);
    out.push({
      id: m[1]!,
      title: oneLine(child('title')),
      authors,
      published: oneLine(child('published')),
      abstract: oneLine(child('summary')),
      category: entry.getElementsByTagNameNS(ARXIV, 'primary_category')[0]?.getAttribute('term')?.trim() ?? '',
      latestVersion: m[2] ?? '',
      updated: oneLine(child('updated')),
      doi: oneLine(child('doi', ARXIV)),
      journalRef: oneLine(child('journal_ref', ARXIV)),
      comment: oneLine(child('comment', ARXIV)),
    });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 批量获取；某一批失败时跳过该批继续，返回成功拿到的部分 */
export async function fetchArxivMeta(ids: string[], signal?: AbortSignal): Promise<{ found: ApiMeta[]; failed: boolean }> {
  const found: ApiMeta[] = [];
  let failed = false;
  for (let i = 0; i < ids.length; i += BATCH) {
    if (i > 0) await sleep(INTERVAL_MS);
    const batch = ids.slice(i, i + BATCH);
    const url = `${API}?id_list=${batch.map(encodeURIComponent).join(',')}&max_results=${batch.length}`;
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      found.push(...parseArxivFeed(await res.text()));
    } catch (e) {
      if (signal?.aborted) throw e;
      failed = true;
    }
  }
  return { found, failed };
}
