import { fetchArxivMeta } from '@/core/arxiv-api';
import { toBibtex } from '@/core/citation';
import { loadMeta, recordApiMeta } from '@/core/storage';

/**
 * 论文库和侧边栏共用：一篇 arXiv 论文的 BibTeX。
 * 还没有 arXiv API 的数据（或是旧版本获取的、没有分类和 DOI）时先获取：页面上提取的标题可能被翻译插件改写，
 * 作者也可能不全。获取失败时返回 null。
 */
export async function citationOf(paperId: string): Promise<string | null> {
  let meta = await loadMeta(paperId);
  if (meta?.source !== 'api' || !meta.apiAt) {
    const { found } = await fetchArxivMeta([paperId]);
    if (!found.length) return null;
    await recordApiMeta(found);
    meta = await loadMeta(paperId);
  }
  return meta ? toBibtex(meta) : null;
}
