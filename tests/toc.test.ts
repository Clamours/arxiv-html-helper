import { beforeEach, describe, expect, it } from 'vitest';
import { collectToc, mountToc, type TocEntry } from '../src/content/toc';
import { renderArticle } from '../src/import/latexml';
import { parseMinerUMarkdown } from '../src/import/mineru';

const MD = `# A Paper

Jane Doe

## ABSTRACT

We study things.

## 1 INTRODUCTION

Intro.

## 2 METHOD WITH $x^2$

### 2.1 Setup

Setup.

### 2.2 Training

Training.

## REFERENCES

[1] A. Author. A book. 2020.

## A PROOFS

More.
`;

const outline = (es: TocEntry[]): unknown[] =>
  es.map((e) => {
    const text = `${e.number ? `${e.number} ` : ''}${e.title.textContent}`.trim();
    return e.children.length ? [text, outline(e.children)] : text;
  });

let article: HTMLElement;
beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}; // jsdom 没有实现
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.className = '';
  for (const el of document.documentElement.querySelectorAll('arxiv-notes-toc')) el.remove();
  article = renderArticle(document, parseMinerUMarkdown(MD));
  document.body.append(article);
});

describe('目录', () => {
  it('摘要、各级节、参考文献、附录，按页面顺序', () => {
    const toc = collectToc(article);
    expect(outline(toc)).toEqual([
      'Abstract',
      '1 INTRODUCTION',
      ['2 METHOD WITH x2', ['2.1 Setup', '2.2 Training']],
      'References',
      'A PROOFS',
    ]);
    expect(toc[1]!.target.id).toBe('S1');
    expect(toc[2]!.children.map((c) => c.target.id)).toEqual(['S2.SS1', 'S2.SS2']);
    expect(toc[4]!.target.classList.contains('ltx_appendix')).toBe(true);
  });

  it('标题里的公式保留为 <math>，编号单独给出', () => {
    const [, , method] = collectToc(article);
    expect(method!.number).toBe('2');
    expect(method!.title.querySelector('math')?.getAttribute('alttext')).toBe('x^2');
    expect(method!.title.querySelector('.ltx_tag')).toBeNull();
  });

  it('跳过译文', () => {
    const h = article.querySelector('#S1 > h2')!;
    const wrapper = h.appendChild(document.createElement('font'));
    wrapper.className = 'immersive-translate-target-wrapper';
    wrapper.textContent = '引言';
    const skip = (n: Node) => n instanceof Element && !!n.closest('.immersive-translate-target-wrapper');
    expect(collectToc(article, skip)[1]!.title.textContent).toBe('INTRODUCTION');
  });

  it('挂在 <article> 之外，不改动正文；点击不冒泡到页面', () => {
    const before = article.outerHTML;
    const toc = mountToc(article, () => false)!;
    expect(toc).not.toBeNull();
    expect(article.outerHTML).toBe(before);
    expect(article.contains(toc.host)).toBe(false);
    expect(toc.host.getAttribute('translate')).toBe('no');

    const links = Array.from(toc.host.shadowRoot!.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([null, '#S1', '#S2', '#S2.SS1', '#S2.SS2', '#bib', '#A1']);
    let bubbled = false;
    document.addEventListener('click', () => (bubbled = true), { once: true });
    links[1]!.click();
    expect(bubbled).toBe(false);
    expect(location.hash).toBe('#S1');
    expect(links[1]!.classList.contains('active')).toBe(true);
  });

  it('跟随滚动高亮当前所在的节，并展开它的父节', async () => {
    const tops: Record<string, number> = { S1: -900, S2: -500, 'S2.SS1': -200, 'S2.SS2': 400, bib: 1200, A1: 1500 };
    for (const id of Object.keys(tops)) {
      document.getElementById(id)!.getBoundingClientRect = () => ({ top: tops[id]!, bottom: tops[id]! + 100 }) as DOMRect;
    }
    const toc = mountToc(article, () => false)!;
    const root = toc.host.shadowRoot!;
    await new Promise((r) => requestAnimationFrame(r));
    expect(root.querySelector('a.active')?.getAttribute('href')).toBe('#S2.SS1');
    expect(root.querySelector('a[href="#S2"]')!.closest('li')!.classList.contains('open')).toBe(true);

    tops.bib = 50;
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(r));
    expect(root.querySelector('a.active')?.getAttribute('href')).toBe('#bib');
    expect(root.querySelector('a[href="#S2"]')!.closest('li')!.classList.contains('open')).toBe(false);
  });

  it('没有节时不加目录', () => {
    const bare = renderArticle(document, parseMinerUMarkdown('# Title\n\nJust text.\n'));
    expect(mountToc(bare, () => false)).toBeNull();
  });
});
