import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAPER_PREFIX } from '../../src/core/library';
import type { PageState } from '../../src/core/messages';
import type { HighlightColor } from '../../src/core/types';
import { sleep, type Browser, type Page } from './cdp';
import { libraryStorage, PAPER_ID, pageStorage, syncStatus } from './fixtures';

/**
 * 截图：联网打开 arxiv.org 上的论文页，在隔离环境里运行扩展的内容脚本（和真实安装时一样），
 * 现场划线、写笔记、插入模拟的沉浸式翻译译文；再用这篇论文的数据打开侧边栏、论文库页面。
 *
 * 截图一律按 2 倍像素存到 rawDir/<名称>-<light|dark>.png，合成时按一半尺寸显示：
 * - store-*：商店截图用，只截浅色。尺寸都是商店截图里浏览器窗口内容区的 1120×588（论文页 + 侧边栏是 760 + 360）
 * - site-*：主页配图用，浅色、深色各截一张
 */

const ARXIV_URL = `https://arxiv.org/html/${PAPER_ID}v7`;
const PAPER_KEY = PAPER_PREFIX + PAPER_ID;

/** 摘要和引言里的划线：[原文, 颜色, 笔记] */
const HIGHLIGHTS: [string, HighlightColor, string?][] = [
  ['based solely on attention mechanisms, dispensing with recurrence and convolutions entirely', 'yellow', '核心贡献：只用注意力，不要循环和卷积'],
  ['28.4 BLEU', 'green'],
  ['41.8', 'green'],
  ['This inherently sequential nature precludes parallelization within training examples', 'pink', 'RNN 的根本瓶颈：时间步之间无法并行'],
  ['relying entirely on an attention mechanism to draw global dependencies between input and output', 'blue'],
  ['twelve hours on eight P100 GPUs', 'purple'],
  ['Multi-head attention allows the model to jointly attend to information from different representation subspaces at different positions', 'purple', '多头 = 在多个子空间里并行地关注不同位置'],
];

/** 引言第 2–4 段的译文，按沉浸式翻译双语对照的结构插在段落末尾 */
const TRANSLATIONS: Record<string, string> = {
  'S1.p2':
    '循环模型通常沿输入和输出序列的符号位置分解计算。把位置与计算的时间步对齐，它们生成一系列隐藏状态 <i>h<sub>t</sub></i>，每个都是前一个隐藏状态 <i>h<sub>t−1</sub></i> 和位置 <i>t</i> 输入的函数。这种固有的顺序性使训练样本内部无法并行，序列较长时尤为关键，因为内存限制了跨样本的批处理。近期工作通过分解技巧 [21] 和条件计算 [32] 显著提升了计算效率，后者还同时提升了模型性能。然而，顺序计算这一根本限制依然存在。',
  'S1.p3':
    '注意力机制已成为各类任务中出色的序列建模和转导模型不可或缺的一部分，它能够建模依赖关系而不受其在输入或输出序列中距离的影响 [2, 19]。不过，除少数情况 [27] 外，这类注意力机制都是与循环网络结合使用的。',
  'S1.p4':
    '本文提出 Transformer，一种摒弃循环、完全依靠注意力机制来建立输入与输出之间全局依赖关系的模型架构。Transformer 的并行度显著更高，在八块 P100 GPU 上只需训练十二小时，翻译质量就能达到新的最高水平。',
};

/** 译文上的划线 */
const TRANSLATION_HIGHLIGHTS: [string, HighlightColor, string?][] = [
  ['建模依赖关系而不受其在输入或输出序列中距离的影响', 'green', '自注意力的关键优势：任意两个位置之间一步可达'],
  ['完全依靠注意力机制来建立输入与输出之间全局依赖关系', 'blue'],
];

/** 截图时选中、弹出划词工具栏的句子 */
const SELECTED = 'more parallelizable and requiring significantly less time to train';
/** 截图时打开笔记编辑框的划线 */
const EDITED = TRANSLATION_HIGHLIGHTS[0]![0];

const ABSTRACT = '.ltx_abstract';
const INTRODUCTION = '[id="S1.p2"]';

/** arXiv 页顶的公告条不属于论文页面，截图时藏起来 */
const HIDE_BANNER = `document.head.append(Object.assign(document.createElement('style'), { textContent: '.ds-announcement { display: none !important; }' }))`;

const CHROME_MOCK = readFileSync(new URL('./chrome-mock.js', import.meta.url), 'utf8');
const PAGE_HELPERS = readFileSync(new URL('./page-helpers.js', import.meta.url), 'utf8');

export type Theme = 'light' | 'dark';

export interface CaptureEnv {
  browser: Browser;
  /** 本地服务器的地址，根目录是扩展的构建产物 */
  origin: string;
  buildDir: string;
  rawDir: string;
  /** 构建出的 manifest.json */
  manifest: unknown;
}

const js = (value: unknown) => JSON.stringify(value);

export async function capture(env: CaptureEnv, theme: Theme): Promise<void> {
  const dark = theme === 'dark';
  /** 商店截图只要浅色 */
  const store = !dark;
  const shot = (page: Page, name: string) => page.screenshot(join(env.rawDir, `${name}-${theme}.png`));
  const now = Date.now();

  // ---- 论文页 ----
  const paper = await env.browser.newPage('论文页');
  await paper.viewport(1120, 588, { dark });
  await paper.goto(ARXIV_URL);
  await paper.evaluate(HIDE_BANNER);
  const world = await startContentScript(paper, env, now);
  const run = <T = unknown>(expression: string) => paper.evaluate<T>(expression, world);

  const highlight = async ([text, color, note]: [string, HighlightColor, string?]) => {
    await run(`__shots.highlight(${js(text)}, ${js(color)}, ${js(note ?? '')})`);
  };
  for (const h of HIGHLIGHTS) await highlight(h);
  for (const [id, html] of Object.entries(TRANSLATIONS)) await run(`__shots.translate(${js(id)}, ${js(html)})`);
  // 内容脚本在页面变化后防抖一会儿才重新定位、采集译文
  await sleep(800);
  for (const h of TRANSLATION_HIGHLIGHTS) await highlight(h);

  /** 换窗口尺寸，滚动到 target */
  const view = async (width: number, height: number, target: string) => {
    await paper.viewport(width, height, { dark });
    await sleep(300);
    await run(`__shots.scrollTo(${js(target)})`);
  };
  if (store) {
    // 1：摘要，选中一句话弹出划词工具栏
    await view(1120, 588, ABSTRACT);
    await run(`__shots.select(${js(SELECTED)})`);
    await shot(paper, 'store-1');
    await run('__shots.clear()');
    // 3：引言的双语译文，译文上那条划线的笔记编辑框
    await view(1120, 588, INTRODUCTION);
    await run(`__shots.openEditor(${js(EDITED)})`);
    await shot(paper, 'store-3');
    await run('__shots.clear()');
    // 2：右边要放侧边栏，论文页窄一些
    await view(760, 588, ABSTRACT);
    await shot(paper, 'store-2-page');
  }
  // 主页首屏：论文页 + 划词工具栏，右边放侧边栏
  await view(860, 660, ABSTRACT);
  await run(`__shots.select(${js(SELECTED)})`);
  await shot(paper, 'site-hero-page');
  await run('__shots.clear()');
  // 主页的"译文"一节
  await view(1040, 620, INTRODUCTION);
  await run(`__shots.openEditor(${js(EDITED)})`);
  await shot(paper, 'site-translation');

  const pageState = await run<PageState>('__shots.pageState()');
  const storage = await run<Record<string, unknown>>('__shots.storage()');
  paper.close();

  // ---- 侧边栏：这篇论文的笔记 ----
  const panel = await extensionPage(env, '侧边栏', { storage, pageState });
  const openPanel = async (height: number) => {
    await panel.viewport(360, height, { dark });
    await panel.goto(`${env.origin}/sidepanel.html`);
    await panel.waitFor(`!!document.querySelector('.card')`);
  };
  if (store) {
    await openPanel(588);
    await shot(panel, 'store-2-panel');
  }
  await openPanel(660);
  await shot(panel, 'site-hero-panel');
  panel.close();

  // ---- 论文库：示例论文，加上刚在论文页上做的划线 ----
  const library = await extensionPage(env, '论文库', {
    storage: { ...libraryStorage(now), [PAPER_KEY]: storage[PAPER_KEY] },
    syncStatus: syncStatus(now),
  });
  const openLibrary = async (width: number, height: number, scale = 2) => {
    await library.viewport(width, height, { dark, scale });
    await library.goto(`${env.origin}/library.html`);
    await library.waitFor(`!!document.querySelector('.paper')`);
  };
  if (store) {
    await openLibrary(1120, 588);
    await shot(library, 'store-4');
  }
  await openLibrary(1120, 700);
  await shot(library, 'site-library');
  if (store) {
    // 5：云同步设置。弹窗比窗口高，按 1.15 倍的窗口截，像素尺寸和其他截图相同，相当于整体缩小到 1/1.15
    await openLibrary(1288, 676, 2 / 1.15);
    await library.evaluate(`document.getElementById('sync').click()`);
    await library.waitFor(`document.getElementById('dialog').open`);
    await sleep(400); // 弹窗的出现动画
    await shot(library, 'store-5');
  }
  library.close();
}

/** 在页面的隔离环境里运行扩展的内容脚本，返回这个环境的 id */
async function startContentScript(page: Page, env: CaptureEnv, now: number): Promise<number> {
  const { frameTree } = await page.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
  const { executionContextId } = await page.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'arxiv-html-helper',
  });
  const seed = { storage: pageStorage(now), manifest: env.manifest };
  await page.evaluate(`globalThis.__screenshotSeed = ${js(seed)};\n${CHROME_MOCK}\n${PAGE_HELPERS}`, executionContextId);
  await page.evaluate(readFileSync(join(env.buildDir, 'content-scripts/content.js'), 'utf8'), executionContextId);
  await page.waitFor(`!!document.querySelector('arxiv-notes-ui')`, executionContextId);
  return executionContextId;
}

/** 新标签页，之后打开的扩展页面在页面脚本之前装上 chrome.* 的模拟（数据来自 seed） */
async function extensionPage(env: CaptureEnv, label: string, seed: { storage: Record<string, unknown>; pageState?: PageState; syncStatus?: unknown }): Promise<Page> {
  const page = await env.browser.newPage(label);
  await page.addInitScript(`globalThis.__screenshotSeed = ${js({ ...seed, manifest: env.manifest })};\n${CHROME_MOCK}`);
  return page;
}
