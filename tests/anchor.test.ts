import { beforeEach, describe, expect, it } from 'vitest';
import { anchorAnnotation, anchorSegment, describeRange } from '../src/core/anchor';
import { elementKey, resolveElementKey } from '../src/core/blocks';
import { parsePaper } from '../src/core/paper';
import type { Annotation, Layer, Segment } from '../src/core/types';
import { $, injectTranslation, loadFixture, makeCtx, rangeBetween, translateInPlace, type Tool } from './helpers';

let root: Element;
beforeEach(() => {
  root = loadFixture();
});

function ann(layer: Layer, segments: Segment[]): Annotation {
  return { id: 'a', paperId: 'x', paperVersion: '', layer, segments, color: 'yellow', note: '', createdAt: 0, updatedAt: 0 };
}

describe('parsePaper', () => {
  it.each([
    ['https://arxiv.org/html/1706.03762v7', { id: '1706.03762', version: 'v7' }],
    ['https://arxiv.org/html/2401.12345v2/', { id: '2401.12345', version: 'v2' }],
    ['https://arxiv.org/html/2401.12345#S3', { id: '2401.12345', version: '' }],
    ['https://ar5iv.labs.arxiv.org/html/1706.03762', { id: '1706.03762', version: '' }],
    ['https://arxiv.org/abs/1706.03762', null],
    ['https://example.com/html/1706.03762', null],
  ])('%s', (url, expected) => {
    expect(parsePaper(url)).toEqual(expected);
  });
});

describe('块 key', () => {
  it('有 id 的元素直接用 id，没有 id 的用祖先 id + 序号', () => {
    const ctx = makeCtx(root);
    const cases: [Element, string][] = [
      [$('S1.p1.1'), '#S1.p1.1'],
      [root.querySelector('figcaption')!, '#S1.F1>figcaption:0'],
      [root.querySelector('h2')!, '#S1>h2:0'],
      [root.querySelectorAll('.ltx_bibblock')[1]!, '#bib.bib1>span:2'],
    ];
    for (const [el, key] of cases) {
      expect(elementKey(el, root, ctx.isForeign)).toBe(key);
      expect(resolveElementKey(key, root, ctx.isForeign)).toBe(el);
    }
  });

  it('序号计算忽略译文里的同名标签', () => {
    const ctx = makeCtx(root);
    const cap = root.querySelector('figcaption')!;
    const key = elementKey(cap, root, ctx.isForeign);
    injectTranslation($('S1.F1'), '<figcaption>假的</figcaption>');
    $('S1.F1').prepend($('S1.F1').lastElementChild!);
    ctx.resetCache();
    expect(resolveElementKey(key, root, ctx.isForeign)).toBe(cap);
  });
});

describe('文本规范化', () => {
  it('折叠空白，公式记为 $alttext$', () => {
    const ctx = makeCtx(root);
    const { text } = ctx.textMap($('S1.p1.1'), 'source');
    expect(text).toContain('output sequences. They generate');
    expect(text).toContain('hidden states $h_{t}$, as a function');
    expect(text).not.toMatch(/\s{2}/);
  });
});

describe('原文层', () => {
  it('describe → anchor 往返一致，公式作为整体', () => {
    const ctx = makeCtx(root);
    const r = rangeBetween($('S1.p1.1'), 'hidden states', $('S1.p1.1'), 'previous');
    const d = describeRange(r, ctx)!;
    expect(d.layer).toBe('source');
    expect(d.segments).toHaveLength(1);
    expect(d.segments[0]!.quote.exact).toBe('hidden states $h_{t}$, as a function of the previous');

    const res = anchorSegment(d.segments[0]!, 'source', ctx);
    expect(res.status).toBe('anchored');
    if (res.status === 'anchored') {
      expect(res.how).toBe('position');
      expect(res.range.compareBoundaryPoints(Range.START_TO_START, r)).toBe(0);
      expect(res.range.compareBoundaryPoints(Range.END_TO_END, r)).toBe(0);
    }
  });

  it('选区端点落在公式内部时扩展到整个公式', () => {
    const ctx = makeCtx(root);
    const mi = $('S1.p1.m1').querySelector('mi')!; // "h"
    const r = rangeBetween($('S1.p1.1'), 'states');
    r.setEnd(mi.firstChild!, 1);
    expect(describeRange(r, ctx)!.segments[0]!.quote.exact).toBe('states $h_{t}$');
  });

  it('跨段落选区按块拆分', () => {
    const ctx = makeCtx(root);
    const r = rangeBetween($('S1.p1.1'), 'and the input', $('S1.p2.1'), 'Attention mechanisms');
    const d = describeRange(r, ctx)!;
    expect(d.segments.map((s) => s.blockKey)).toEqual(['#S1.p1.1', '#S1.p2.1']);
    expect(d.segments[0]!.quote.exact).toBe('and the input [1].');
    expect(d.segments[1]!.quote.exact).toBe('Attention mechanisms');
    expect(anchorAnnotation(ann('source', d.segments), ctx).status).toBe('anchored');
  });

  it('译文插入到段落内部后，原文偏移不变', () => {
    const ctx = makeCtx(root);
    const r = rangeBetween($('S1.p2.1'), 'integral part');
    const seg = describeRange(r, ctx)!.segments[0]!;
    const before = ctx.textMap($('S1.p2.1'), 'source').text;

    injectTranslation($('S1.p2.1'), '注意力机制已经成为<b>序列建模</b>中不可或缺的一部分。');
    ctx.resetCache();
    expect(ctx.textMap($('S1.p2.1'), 'source').text).toBe(before);
    const res = anchorSegment(seg, 'source', ctx);
    expect(res.status === 'anchored' && res.how).toBe('position');
  });

  it('论文改版、块 id 变化后，在全文中重新找到', () => {
    const ctx = makeCtx(root);
    const seg = describeRange(rangeBetween($('S1.p2.1'), 'integral part'), ctx)!.segments[0]!;
    $('S1.p2.1').id = 'S1.p3.1';
    ctx.resetCache();
    const res = anchorSegment(seg, 'source', ctx);
    expect(res.status === 'anchored' && res.how).toBe('relocated');
  });

  it('原文措辞小改时模糊匹配', () => {
    const ctx = makeCtx(root);
    const seg = describeRange(rangeBetween($('S1.p2.1'), 'an integral part of compelling'), ctx)!.segments[0]!;
    $('S1.p2.1').textContent = 'Attention mechanisms have become an essential part of compelling sequence modeling.';
    ctx.resetCache();
    const res = anchorSegment(seg, 'source', ctx);
    expect(res.status === 'anchored' && res.how).toBe('fuzzy');
    if (res.status === 'anchored') expect(res.range.toString()).toBe('an essential part of compelling');
  });
});

describe('译文层', () => {
  const ZH = '注意力机制已经成为<b>序列建模</b>中不可或缺的一部分，出现在各种任务中。';

  it('选中译文 → 记录为译文层，挂靠到原文段落', () => {
    const ctx = makeCtx(root);
    const tr = injectTranslation($('S1.p2.1'), ZH);
    const d = describeRange(rangeBetween(tr, '序列建模', tr, '不可或缺'), ctx)!;
    expect(d.layer).toBe('translation');
    expect(d.segments).toHaveLength(1);
    const seg = d.segments[0]!;
    expect(seg.blockKey).toBe('#S1.p2.1');
    expect(seg.quote.exact).toBe('序列建模中不可或缺');
    expect(seg.translation).toEqual({ provider: 'immersive-translate', snapshot: '注意力机制已经成为序列建模中不可或缺的一部分，出现在各种任务中。' });
    expect(anchorSegment(seg, 'translation', ctx).status).toBe('anchored');
  });

  it('选区从译文开始、延伸到原文时，只保留译文部分', () => {
    const ctx = makeCtx(root);
    const tr = injectTranslation($('S1.p1.1'), '循环模型通常沿着输入和输出序列的符号位置进行计算。');
    const r = rangeBetween(tr, '输出序列', $('S1.p2.1'), 'Attention');
    const d = describeRange(r, ctx)!;
    expect(d.layer).toBe('translation');
    expect(d.segments.map((s) => s.quote.exact)).toEqual(['输出序列的符号位置进行计算。']);
  });

  it('关闭翻译 → waiting；重新翻译且措辞略变 → 模糊匹配回来', () => {
    const ctx = makeCtx(root);
    const tr = injectTranslation($('S1.p2.1'), ZH);
    const seg = describeRange(rangeBetween(tr, '不可或缺的一部分'), ctx)!.segments[0]!;

    tr.remove();
    ctx.resetCache();
    expect(anchorAnnotation(ann('translation', [seg]), ctx).status).toBe('waiting');

    injectTranslation($('S1.p2.1'), '注意力机制已成为序列建模里不可或缺的组成部分，出现在各种任务中。');
    ctx.resetCache();
    const res = anchorSegment(seg, 'translation', ctx);
    expect(res.status === 'anchored' && res.how).toBe('fuzzy');
  });

  it('重新翻译后完全不同 → orphaned', () => {
    const ctx = makeCtx(root);
    const tr = injectTranslation($('S1.p2.1'), ZH);
    const seg = describeRange(rangeBetween(tr, '不可或缺的一部分'), ctx)!.segments[0]!;
    tr.remove();
    injectTranslation($('S1.p2.1'), 'Les mécanismes d’attention sont devenus essentiels.');
    ctx.resetCache();
    expect(anchorSegment(seg, 'translation', ctx).status).toBe('orphaned');
  });
});

describe.each<Tool>(['immersive', 'read-frog'])('%s', (tool) => {
  const ZH = '注意力机制已经成为<b>序列建模</b>中不可或缺的一部分。';

  it('双语模式下划的译文，切到仅译文模式后仍能定位', () => {
    const ctx = makeCtx(root);
    const p = $('S1.p2.1');
    const tr = injectTranslation(p, ZH, tool);
    const d = describeRange(rangeBetween(tr, '不可或缺'), ctx)!;
    expect(d.layer).toBe('translation');

    tr.remove();
    translateInPlace(p, ZH, tool);
    ctx.resetCache();
    const res = anchorSegment(d.segments[0]!, 'translation', ctx);
    expect(res.status === 'anchored' && res.range.toString()).toBe('不可或缺');
  });

  it('仅译文模式：原地替换的文字算译文层，原文层笔记变为 waiting', () => {
    const ctx = makeCtx(root);
    const p = $('S1.p2.1');
    const srcSeg = describeRange(rangeBetween(p, 'integral part'), ctx)!.segments[0]!;

    translateInPlace(p, ZH, tool);
    ctx.resetCache();
    expect(anchorSegment(srcSeg, 'source', ctx).status).toBe('waiting');

    const d = describeRange(rangeBetween(p, '序列建模'), ctx)!;
    expect(d.layer).toBe('translation');
    expect(d.segments[0]!.blockKey).toBe('#S1.p2.1');
  });

  it('加载占位元素不影响原文', () => {
    const ctx = makeCtx(root);
    const p = $('S1.p2.1');
    const before = ctx.textMap(p, 'source').text;
    const spinner = document.createElement('span');
    if (tool === 'immersive') spinner.setAttribute('data-immersive-translate-loading-id', '1');
    else spinner.className = 'read-frog-spinner';
    spinner.textContent = 'loading…';
    p.append(spinner);
    ctx.resetCache();
    expect(ctx.textMap(p, 'source').text).toBe(before);
  });
});

it('陪读蛙把仅译文标记打在段落内的行内元素上时，整段按译文处理', () => {
  const ctx = makeCtx(root);
  const p = $('S1.p1.1');
  translateInPlace(p, '循环模型沿着符号位置计算 <cite class="ltx_cite">[<a href="#bib.bib1">1</a>]</cite>。', 'read-frog', 'cite');
  ctx.resetCache();
  const d = describeRange(rangeBetween(p, '循环模型'), ctx)!;
  expect(d.layer).toBe('translation');
  expect(d.segments[0]!.blockKey).toBe('#S1.p1.1');
  expect(ctx.textMap(p, 'translation').text).toBe('循环模型沿着符号位置计算 [1]。');
});
