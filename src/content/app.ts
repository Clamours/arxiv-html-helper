import { browser } from 'wxt/browser';
import { ADAPTERS } from '@/adapters';
import { anchorAnnotation, describeRange, type Anchored } from '@/core/anchor';
import { DocContext } from '@/core/context';
import type { PageState, Request, SyncNowRequest } from '@/core/messages';
import { extractMeta, type PaperRef } from '@/core/paper';
import {
  addAnnotation,
  deleteAnnotation,
  loadAnnotations,
  recordPageMeta,
  updateAnnotation,
  watchAnnotations,
} from '@/core/storage';
import type { Annotation, HighlightColor } from '@/core/types';
import { Highlighter } from './highlighter';
import { PageUi } from './ui';

const REANCHOR_DEBOUNCE_MS = 250;

export async function startApp(paper: PaperRef): Promise<void> {
  const root = document.querySelector('article.ltx_document') ?? document.body;
  const ui = new PageUi();
  const ctx = new DocContext(root, ADAPTERS, (n) => ui.contains(n));
  const hl = new Highlighter();

  let annotations: Annotation[] = await loadAnnotations(paper.id);
  // 浏览过的论文自动加入论文库的「待读」；每次打开时刷新标题、版本和最近打开时间。
  // 没有正文（如"该论文没有 HTML 版本"的错误页）时不收录
  const recordMeta = () => void recordPageMeta(extractMeta(document, paper)).catch(() => {});
  if (annotations.length || document.querySelector('.ltx_document')) recordMeta();
  let anchored = new Map<string, Anchored>();
  let editingId: string | null = null;

  function reanchor(): void {
    ctx.resetCache();
    anchored = new Map(annotations.map((a) => [a.id, anchorAnnotation(a, ctx)]));
    hl.setAll([...anchored.values()].map((x) => ({ id: x.annotation.id, color: x.annotation.color, ranges: x.ranges })));
    if (editingId) hl.setFocus(editingId);
    browser.runtime.sendMessage({ type: 'ahh:state-changed' }).catch(() => {});
  }

  // ---- DOM 变化（翻译插件插入/删除译文）后重新定位 ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver((records) => {
    if (records.every((r) => ui.contains(r.target))) return;
    clearTimeout(timer);
    timer = setTimeout(reanchor, REANCHOR_DEBOUNCE_MS);
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });

  watchAnnotations(paper.id, (list) => {
    annotations = list;
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
    }
  });

  function pageState(): PageState {
    const all = [...anchored.values()];
    const placed = all.filter((x) => x.ranges.length);
    const unplaced = all.filter((x) => !x.ranges.length).sort((a, b) => a.annotation.createdAt - b.annotation.createdAt);
    placed.sort((a, b) => a.ranges[0]!.compareBoundaryPoints(Range.START_TO_START, b.ranges[0]!));
    const roots = ctx.translationRootsIn(root);
    const providers = ADAPTERS.map((a) => ({
      id: a.id,
      name: a.name,
      count: new Set(roots.filter((t) => t.adapter === a).map((t) => t.source)).size,
    }));
    return {
      paper,
      pageTitle: extractMeta(document, paper).title,
      items: [...placed, ...unplaced].map((x) => ({ annotation: x.annotation, status: x.status })),
      providers,
    };
  }

  reanchor();
}
