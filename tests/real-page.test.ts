/**
 * 用真实 arXiv HTML 页面做往返测试（页面不入库）：
 *   curl -sL https://arxiv.org/html/1706.03762v7 -o /tmp/attn.html
 *   ARXIV_HTML=/tmp/attn.html npm test
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { roundTripRandomSelections } from './helpers';

const file = process.env.ARXIV_HTML;

describe.skipIf(!file)('真实页面往返', () => {
  it('每个块内随机选区 describe → anchor 结果一致', () => {
    document.documentElement.innerHTML = readFileSync(file!, 'utf8');
    const root = document.querySelector('article.ltx_document')!;
    const checked = roundTripRandomSelections(root);
    console.log(`checked ${checked} segments`);
    expect(checked).toBeGreaterThan(100);
  });
});
