import { browser } from 'wxt/browser';
import type { Request, TranslationRequest } from '@/core/messages';
import { TOMB_PREFIX, toPaperTomb } from '@/core/tombstones';
import { emptyTranslations, toSavedBlock, type SavedBlock } from '@/core/translations';
import { localTranslations, mergeLocal } from './db';

/**
 * background 里的译文存档服务：替内容脚本读写本机存档（见 db.ts）。
 * 本机存档有变化时调用 onLocalChange（安排云同步）。
 */
export function initTranslationService(onLocalChange: () => void): void {
  browser.runtime.onMessage.addListener((msg: TranslationRequest, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'ahh:tr-load':
        void localTranslations.get(msg.paperId).then((rec) => sendResponse(rec ?? emptyTranslations(msg.paperId)));
        return true;
      case 'ahh:tr-put': {
        const blocks = (Array.isArray(msg.blocks) ? msg.blocks : []).map(toSavedBlock).filter((b): b is SavedBlock => !!b);
        const rec = { ...emptyTranslations(msg.paperId), blocks: Object.fromEntries(blocks.map((b, i) => [i, b])) };
        void mergeLocal(rec).then(({ rec, changed }) => {
          if (changed) onLocalChange();
          sendResponse(rec);
        });
        return true;
      }
      case 'ahh:tr-clear':
        void mergeLocal({ ...emptyTranslations(msg.paperId), clearedAt: Date.now() }).then(({ rec }) => {
          onLocalChange();
          // 同一篇论文开在其他标签页里时也要更新
          void broadcastTranslationsChanged([msg.paperId]);
          sendResponse(rec);
        });
        return true;
    }
  });

  // 从论文库移除论文（包括在其他电脑上移除、同步过来的）：作废这篇论文的译文存档
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
      if (!key.startsWith(TOMB_PREFIX)) continue;
      const at = toPaperTomb(newValue).paper;
      if (!at || at === toPaperTomb(oldValue).paper) continue;
      void clearIfSaved(key.slice(TOMB_PREFIX.length), at, onLocalChange);
    }
  });
}

async function clearIfSaved(paperId: string, at: number, onLocalChange: () => void): Promise<void> {
  if (!(await localTranslations.get(paperId))) return;
  const { changed } = await mergeLocal({ ...emptyTranslations(paperId), clearedAt: at });
  if (!changed) return;
  onLocalChange();
  void broadcastTranslationsChanged([paperId]);
}

/** 通知打开着这些论文的页面重新读取存档 */
export async function broadcastTranslationsChanged(paperIds: string[]): Promise<void> {
  const msg: Request = { type: 'ahh:tr-changed', paperIds };
  for (const tab of await browser.tabs.query({})) {
    if (tab.id !== undefined) browser.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
}
