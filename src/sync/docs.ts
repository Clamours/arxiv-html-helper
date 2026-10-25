import {
  DocFileError,
  parseDocFile,
  parseDocIndexFile,
  toDocFile,
  toDocIndexFile,
  type LibraryDocs,
  type StoredDoc,
} from '@/core/docs';
import { sha256Hex } from '@/core/paper';
import { stableStringify } from '@/core/sync';
import type { DocStore } from '@/imported/db';
import { SyncError, type SyncProvider } from './provider';

/**
 * 导入论文的页面的云同步。页面一篇 1 MB 左右，和译文存档一样每篇一个文件，另有一个索引记录云端每篇页面的 SHA-256。
 * 每次同步（主同步文件合并之后，论文库已是最新）：
 * - 论文库里的导入论文：本机有、云端没有就上传；本机没有、云端有就下载
 * - 两台电脑各自导入过同一个 PDF（MinerU 两次的结果可能略有不同）：云端换成元数据记录的那份（先导入的），
 *   由持有它的电脑上传覆盖。本机已有的页面不替换：页面一经生成不再改变，本机的划线是在它上面定位的
 * - 已从论文库移除的论文：删除云端和本机的页面
 *
 * 只有索引用条件写入。下载时校验内容的 SHA-256；对不上（被同时覆盖、损坏）或文件已经不在时，
 * 从索引里去掉这一项，持有页面的电脑下次同步时会重新上传。
 */

export const DOC_INDEX_NAME = 'arxiv-notes-pages.json';

export const docFileName = (paperId: string) => `arxiv-notes-page-${paperId}.json`;

const MAX_ATTEMPTS = 3;

/**
 * library 在读完云端索引之后调用，取的是那一刻的论文库：要据此删除页面，读得越晚，越不会误删刚重新加入的论文。
 * 返回本机新增了页面的论文 id
 */
export async function syncDocs(
  file: (name: string) => SyncProvider,
  local: DocStore,
  library: () => Promise<LibraryDocs>,
): Promise<string[]> {
  const added = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    const indexFile = file(DOC_INDEX_NAME);
    const index = await indexFile.read();
    const remote: Record<string, string> = {};
    for (const text of index.texts) {
      for (const [id, h] of Object.entries(readable(() => parseDocIndexFile(text)))) {
        // Google Drive 偶尔有多个同名文件：对不上的当作不知道云端是哪一份，下面会重新上传
        remote[id] = remote[id] === undefined || remote[id] === h ? h : '';
      }
    }

    const { wanted, removed } = await library();
    const mine = await local.hashes();
    for (const id of removed) if (mine[id]) await local.remove(id);

    const next = { ...remote };
    for (const [id, want] of Object.entries(wanted)) {
      const have = mine[id];
      const cloud = remote[id];
      if (have) {
        // 只在云端没有，或者本机这份是该保留的（先导入的）而云端不是时上传
        if (cloud && (cloud === have || have !== want)) continue;
        const doc = await local.get(id);
        if (!doc) continue;
        await file(docFileName(id)).write(JSON.stringify(toDocFile(doc)), { texts: [] }, false);
        next[id] = doc.sha256;
      } else if (cloud !== undefined) {
        const doc = await download(file(docFileName(id)), id, cloud);
        if (!doc) {
          delete next[id];
          continue;
        }
        if (await local.add(doc)) added.add(id);
        next[id] = doc.sha256;
      }
    }
    const gone = removed.filter((id) => id in next);
    for (const id of gone) delete next[id];

    // 云端还没有索引、也没有页面要记时不建空索引
    if (index.texts.length <= 1 && stableStringify(next) === stableStringify(remote)) return [...added];
    try {
      // 最后一次不再检测冲突，直接覆盖
      await indexFile.write(JSON.stringify(toDocIndexFile(next)), index, !last);
    } catch (e) {
      if (e instanceof SyncError && e.kind === 'conflict' && !last) continue;
      throw e;
    }
    // 索引里已经去掉，再删文件；删不掉也不要紧，同一篇论文以后再上传时会覆盖
    for (const id of gone) await file(docFileName(id)).remove().catch(() => {});
    return [...added];
  }
}

/** 下载并校验一篇页面，文件不在或已损坏时返回 null。Google Drive 有多个同名文件时，优先取和索引一致的那份 */
async function download(f: SyncProvider, id: string, expected: string): Promise<StoredDoc | null> {
  const got = await f.read();
  const valid: StoredDoc[] = [];
  for (const text of got.texts) {
    let doc: StoredDoc;
    try {
      doc = parseDocFile(text, id);
    } catch (e) {
      // 更新版本的插件写的文件读不懂，但不能当作损坏的文件，等升级
      if (e instanceof DocFileError && e.newer) throw new SyncError(`云端的论文页面无法读取（${e.message}），已暂停同步`, 'remote');
      if (e instanceof DocFileError) continue;
      throw e;
    }
    if ((await sha256Hex(new TextEncoder().encode(doc.html))) === doc.sha256) valid.push(doc);
  }
  return valid.find((d) => d.sha256 === expected) ?? valid[0] ?? null;
}

/** 读不懂的索引不覆盖，以免丢数据 */
function readable<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    if (e instanceof DocFileError) throw new SyncError(`云端的论文页面索引无法读取（${e.message}），已暂停同步`, 'remote');
    throw e;
  }
}
