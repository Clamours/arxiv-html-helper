import { browser } from 'wxt/browser';
import { ADAPTERS, LIVE_ADAPTERS } from '@/adapters';
import { anchorAnnotation, describeRange, type Anchored } from '@/core/anchor';
import { DocContext } from '@/core/context';
import type { PageState, Request, SyncNowRequest, TranslationRequest } from '@/core/messages';
import { extractMeta, isImportedId, type PaperRef } from '@/core/paper';
import {
  addAnnotation,
  deleteAnnotation,
  loadAnnotations,
  loadSavedVisible,
  recordPageMeta,
  updateAnnotation,
  watchAnnotations,
  watchSavedVisible,
} from '@/core/storage';
import { toPaperTranslations, type PaperTranslations, type SavedBlock } from '@/core/translations';
import type { Annotation, HighlightColor } from '@/core/types';
import { Highlighter } from './highlighter';
import { mountToc } from './toc';
import { injectSavedStyle, isSavedWrapper, SavedTranslations } from './translations';
import { PageUi } from './ui';

const REANCHOR_DEBOUNCE_MS = 250;
/** 新存档的译文攒一会儿再写入 */
const PERSIST_DEBOUNCE_MS = 1000;

export async function startApp(paper: PaperRef): Promise<void> {
  const root = document.querySelector('article.ltx_document') ?? document.body;
  const ui = new PageUi();
  const ctx = new DocContext(root, ADAPTERS, (n) => ui.contains(n));
  const hl = new Highlighter();
  // 导入的论文没有 arXiv 页面自带的目录；在翻译插件改写标题之前生成
  if (isImportedId(paper.id) && root.localName === 'article') mountToc(root, ctx.isForeign);

  // ---- 译文存档：先在翻译插件改写原文之前记下原文哈希，再读取存档 ----
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  let toPersist: SavedBlock[] = [];
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const saved = new SavedTranslations(ctx, paper.id, {
    persist(blocks) {
      toPersist.push(...blocks);
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => void flushSaved(), PERSIST_DEBOUNCE_MS);
    },
    recheckIn(ms) {
      recheckTimer ??= setTimeout(() => {
        recheckTimer = undefined;
        reanchor();
      }, ms + 50);
    },
  });
  saved.prime();
  injectSavedStyle(document, LIVE_ADAPTERS);

  async function translationRequest(msg: TranslationRequest): Promise<PaperTranslations | null> {
    try {
      const rec: unknown = await browser.runtime.sendMessage(msg);
      return rec ? toPaperTranslations(rec, paper.id) : null;
    } catch {
      return null; // 扩展刚更新、background 不可用
    }
  }

  async function flushSaved(): Promise<void> {
    const blocks = toPersist;
    toPersist = [];
    const rec = await translationRequest({ type: 'ahh:tr-put', paperId: paper.id, blocks });
    // 写入失败时这些译文只在本次页面里显示，下次打开页面会重新采集
    if (!rec) return;
    saved.acknowledge(blocks);
    if (saved.setRecord(rec)) reanchor();
  }

  async function reloadSaved(): Promise<void> {
    const rec = await translationRequest({ type: 'ahh:tr-load', paperId: paper.id });
    if (rec && saved.setRecord(rec)) reanchor();
  }

  const [initialAnnotations, initialSaved, visible] = await Promise.all([
    loadAnnotations(paper.id),
    translationRequest({ type: 'ahh:tr-load', paperId: paper.id }),
    loadSavedVisible(),
  ]);
  let annotations: Annotation[] = initialAnnotations;
  if (initialSaved) saved.setRecord(initialSaved);
  saved.setVisible(visible);
  // 浏览过的论文自动加入论文库（不属于任何分组）；每次打开时刷新标题、版本和最近打开时间。
  // 没有正文（如"该论文没有 HTML 版本"的错误页）时不收录
  const recordMeta = () => void recordPageMeta(extractMeta(document, paper)).catch(() => {});
  if (annotations.length || document.querySelector('.ltx_document')) recordMeta();
  let anchored = new Map<string, Anchored>();
  let editingId: string | null = null;

  function reanchor(): void {
    ctx.resetCache();
    // 采集新译文、插入或移除存档；改动了页面就重建缓存
    if (saved.update()) ctx.resetCache();
    anchored = new Map(annotations.map((a) => [a.id, anchorAnnotation(a, ctx)]));
    hl.setAll([...anchored.values()].map((x) => ({ id: x.annotation.id, color: x.annotation.color, ranges: x.ranges })));
    if (editingId) hl.setFocus(editingId);
    browser.runtime.sendMessage({ type: 'ahh:state-changed' }).catch(() => {});
  }

  // ---- DOM 变化（翻译插件插入/删除译文）后重新定位 ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 只是插入了存档的 wrapper（reanchor 自己做的）时不用再来一遍
  const ownChange = (r: MutationRecord) =>
    ui.contains(r.target) || (r.type === 'childList' && !r.removedNodes.length && Array.from(r.addedNodes).every(isSavedWrapper));
  const observer = new MutationObserver((records) => {
    if (records.every(ownChange)) return;
    clearTimeout(timer);
    timer = setTimeout(reanchor, REANCHOR_DEBOUNCE_MS);
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });

  watchAnnotations(paper.id, (list) => {
    annotations = list;
    reanchor();
  });
  // 侧边栏里切换了"显示译文存档"
  watchSavedVisible((v) => {
    saved.setVisible(v);
    reanchor();
  });
  // 开启了云同步时顺便拉取其他电脑上的改动；写入本地后 watchAnnotations 会更新高亮
  const syncNow: SyncNowRequest = { type: 'ahh:sync-now', quiet: true };
  browser.runtime.sendMessage(syncNow).catch(() => {});

  // ---- 划词 → 工具栏 ----

  async function create(color: HighlightColor): Promise<Annotation | null> {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const described = describeRange(sel.getRangeAt(0), ctx);
    if (!described) return null;
    const now = Date.now();
    const ann: Annotation = {
      id: crypto.randomUUID(),
      paperId: paper.id,
      paperVersion: paper.version,
      layer: described.layer,
      segments: described.segments,
      color,
      note: '',
      createdAt: now,
      updatedAt: now,
    };
    sel.removeAllRanges();
    annotations = [...annotations, ann];
    reanchor();
    await addAnnotation(ann);
    recordMeta();
    return ann;
  }

  function openEditor(id: string, at: DOMRect): void {
    const x = anchored.get(id);
    if (!x) return;
    editingId = id;
    hl.setFocus(id);
    const quote = x.annotation.segments.map((s) => s.quote.exact).join(' … ');
    ui.showEditor(at, x.annotation, quote, {
      onColor: (color) => void updateAnnotation(paper.id, id, { color }),
      onNote: (note) => void updateAnnotation(paper.id, id, { note }),
      onDelete: () => {
        ui.hide();
        void deleteAnnotation(paper.id, id);
      },
      onClose: () => {
        editingId = null;
        hl.setFocus(null);
      },
    });
  }

  function lastRect(range: Range): DOMRect {
    const rects = range.getClientRects();
    return rects[rects.length - 1] ?? range.getBoundingClientRect();
  }

  function onSelectionDone(e: Event): void {
    if (ui.isInside(e)) return;
    // 等浏览器更新完选区
    setTimeout(() => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        if (!ui.isEditorOpen) ui.hide();
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer) || !describeRange(range, ctx)) return;
      ui.showToolbar(lastRect(range), {
        onColor: (c) => void create(c).then(() => ui.hide()),
        onNote: () =>
          void create('yellow').then((ann) => {
            if (ann) openEditor(ann.id, lastRect(range));
          }),
      });
    });
  }

  document.addEventListener('mouseup', onSelectionDone);
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Shift') onSelectionDone(e);
  });

  // ---- 点击已有高亮 → 编辑框 ----
  document.addEventListener('click', (e) => {
    if (ui.isInside(e)) return;
    if (!document.getSelection()?.isCollapsed) return;
    if ((e.target as Element | null)?.closest?.('a')) return; // 引用链接照常跳转
    const id = hl.hitTest(e.clientX, e.clientY);
    if (id) openEditor(id, new DOMRect(e.clientX, e.clientY, 0, 0));
    else if (ui.isEditorOpen) ui.hide();
  });

  // ---- 侧边栏通信 ----
  browser.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
    switch (msg.type) {
      case 'ahh:get-state':
        sendResponse(pageState());
        return;
      case 'ahh:scroll-to': {
        const r = anchored.get(msg.id)?.ranges[0];
        if (!r) return;
        const rect = r.getBoundingClientRect();
        window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: 'smooth' });
        hl.setFocus(msg.id);
        setTimeout(() => editingId !== msg.id && hl.setFocus(editingId), 1500);
        return;
      }
      case 'ahh:update':
        void updateAnnotation(paper.id, msg.id, msg.patch);
        return;
      case 'ahh:delete':
        void deleteAnnotation(paper.id, msg.id);
        return;
      case 'ahh:saved-clear':
        // 清除后，页面上翻译插件当前的译文会重新存档
        void translationRequest({ type: 'ahh:tr-clear', paperId: paper.id }).then((rec) => {
          if (rec) saved.setRecord(rec);
          reanchor();
          sendResponse(pageState());
        });
        return true;
      case 'ahh:tr-changed':
        if (msg.paperIds.includes(paper.id)) void reloadSaved();
        return;
    }
  });

  function pageState(): PageState {
    const all = [...anchored.values()];
    const placed = all.filter((x) => x.ranges.length);
    const unplaced = all.filter((x) => !x.ranges.length).sort((a, b) => a.annotation.createdAt - b.annotation.createdAt);
    placed.sort((a, b) => a.ranges[0]!.compareBoundaryPoints(Range.START_TO_START, b.ranges[0]!));
    const roots = ctx.translationRootsIn(root);
    const providers = LIVE_ADAPTERS.map((a) => ({
      id: a.id,
      name: a.name,
      count: new Set(roots.filter((t) => t.adapter === a).map((t) => t.source)).size,
    }));
    return {
      paper,
      pageTitle: extractMeta(document, paper).title,
      items: [...placed, ...unplaced].map((x) => ({ annotation: x.annotation, status: x.status })),
      providers,
      saved: saved.summary(),
    };
  }

  reanchor();
}
