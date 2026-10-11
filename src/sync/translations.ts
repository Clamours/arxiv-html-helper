import { stableStringify } from '@/core/sync';
import {
  emptyTranslations,
  mergeTranslations,
  parseIndexFile,
  parseTranslationFile,
  toIndexFile,
  toTranslationFile,
  TranslationFileError,
  translationsHash,
  type PaperTranslations,
} from '@/core/translations';
import type { TranslationStore } from '@/translations/db';
import { SyncError, type SyncProvider } from './provider';

/**
 * 译文存档的云同步。存档比笔记大得多，不放进主同步文件，而是每篇论文一个文件，另有一个索引文件
 * 记录每篇论文存档的指纹。每次同步：
 * 读索引 → 指纹与本机不同的论文：下载该论文的文件、与本机合并、写回本机，云端不同则上传 → 更新索引。
 *
 * 只有索引用条件写入（检测两台电脑同时同步）。论文文件被同时覆盖时，下一次同步会因为指纹不一致重新合并，
 * 合并只增不减（清除靠 clearedAt），所以最终两边一致。
 */

export const TRANSLATION_INDEX_NAME = 'arxiv-notes-translations.json';

/** 旧式 arXiv id 含 "/"（hep-th/9901001），换成 "_"（id 里不会出现） */
export const translationFileName = (paperId: string) => `arxiv-notes-tr-${paperId.replace(/\//g, '_')}.json`;

const MAX_ATTEMPTS = 3;

/** 返回本机存档有变化的论文 id */
export async function syncTranslations(file: (name: string) => SyncProvider, local: TranslationStore): Promise<string[]> {
  const changed = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    const indexFile = file(TRANSLATION_INDEX_NAME);
    const index = await indexFile.read();
    const remote: Record<string, string> = {};
    for (const text of index.texts) {
      for (const [id, h] of Object.entries(readable(() => parseIndexFile(text)))) {
        // Google Drive 偶尔有多个同名文件：指纹对不上的一律重新比对
        remote[id] = remote[id] === undefined || remote[id] === h ? h : '';
      }
    }

    const before = await local.hashes();
    const next = { ...remote };
    for (const id of new Set([...Object.keys(remote), ...Object.keys(before)])) {
      if (remote[id] && remote[id] === before[id]) continue;
      const paperFile = file(translationFileName(id));
      const got = await paperFile.read();
      let incoming: PaperTranslations = emptyTranslations(id);
      for (const text of got.texts) incoming = mergeTranslations(incoming, readable(() => parseTranslationFile(text, id)));
      const merged = await local.merge(incoming);
      const hash = translationsHash(merged);
      if (hash !== before[id]) changed.add(id);
      if (got.texts.length !== 1 || translationsHash(incoming) !== hash) {
        await paperFile.write(JSON.stringify(toTranslationFile(merged)), got, false);
      }
      next[id] = hash;
    }

    if (index.texts.length === 1 && stableStringify(next) === stableStringify(remote)) return [...changed];
    try {
      // 最后一次不再检测冲突，直接覆盖
      await indexFile.write(JSON.stringify(toIndexFile(next)), index, !last);
      return [...changed];
    } catch (e) {
      if (e instanceof SyncError && e.kind === 'conflict' && !last) continue;
      throw e;
    }
  }
}

/** 读不懂的云端文件不覆盖，以免丢数据 */
function readable<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    if (e instanceof TranslationFileError) throw new SyncError(`云端的译文存档无法读取（${e.message}），已暂停同步`, 'remote');
    throw e;
  }
}
