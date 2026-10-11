/**
 * 用真实 arXiv HTML 页面做往返测试（页面不入库）：
 *   curl -sL https://arxiv.org/html/1706.03762v7 -o /tmp/attn.html
 *   ARXIV_HTML=/tmp/attn.html npm test
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SavedTranslations, STABLE_MS } from '../src/content/translations';
import { anchorSegment, describeRange } from '../src/core/anchor';
import { entryKey, type SavedBlock } from '../src/core/translations';
import { injectTranslation, makeCtx, roundTripRandomSelections } from './helpers';

const file = process.env.ARXIV_HTML;

function load(): Element {
  document.documentElement.innerHTML = readFileSync(file!, 'utf8');
  return document.querySelector('article.ltx_document')!;
}

describe.skipIf(!file)('真实页面往返', () => {
  it('每个块内随机选区 describe → anchor 结果一致', () => {
    const root = load();
    const checked = roundTripRandomSelections(root);
    console.log(`checked ${checked} segments`);
    expect(checked).toBeGreaterThan(100);
  });

  it('整篇译文存档 → 在新页面上显示，译文层笔记按偏移定位，原文层不受影响', () => {
    // 页面 A：给每个段落注入"译文"（原文内容加前缀，含公式和引用），全部存档
    let root = load();
    let ctx = makeCtx(root);
    const persisted: SavedBlock[] = [];
    let t = 0;
    const a = new SavedTranslations(ctx, 'P', { persist: (b) => persisted.push(...b), recheckIn: () => {} }, () => t);
    a.prime();
    const paras = Array.from(root.querySelectorAll('p.ltx_p'));
    for (const p of paras) injectTranslation(p, `译：${p.innerHTML}`);
    ctx.resetCache();
    a.update();
    t += STABLE_MS;
    ctx.resetCache();
    let started = performance.now();
    a.update();
    console.log(`captured ${persisted.length}/${paras.length} paragraphs in ${(performance.now() - started).toFixed(0)} ms`);
    expect(persisted.length).toBeGreaterThan(paras.length * 0.95);

    // 页面 B：没有翻译插件
    root = load();
    ctx = makeCtx(root);
    const b = new SavedTranslations(ctx, 'P', { persist: () => {}, recheckIn: () => {} });
    b.prime();
    b.setRecord({ paperId: 'P', clearedAt: 0, blocks: Object.fromEntries(persisted.map((x) => [entryKey(x), x])) });
    ctx.resetCache();
    started = performance.now();
    b.update();
    console.log(`rendered ${b.summary().shown} paragraphs in ${(performance.now() - started).toFixed(0)} ms`);
    expect(b.summary().shown).toBe(persisted.length);
    ctx.resetCache();
    started = performance.now();
    expect(b.update()).toBe(false);
    console.log(`idle update in ${(performance.now() - started).toFixed(0)} ms`);

    ctx.resetCache();
    let checked = 0;
    for (const w of Array.from(root.querySelectorAll('.ahh-saved-translation'))) {
      const text = w.firstChild!;
      if (text.nodeType !== Node.TEXT_NODE || (text as Text).data.length < 4) continue;
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(text, 4);
      const d = describeRange(r, ctx)!;
      expect(d.layer).toBe('translation');
      const res = anchorSegment(d.segments[0]!, 'translation', ctx);
      expect(res.status === 'anchored' && res.how).toBe('position');
      checked++;
    }
    expect(checked).toBeGreaterThan(b.summary().shown * 0.9);
    expect(roundTripRandomSelections(root)).toBeGreaterThan(100);
  });
});
