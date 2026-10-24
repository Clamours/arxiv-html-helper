import { browser } from 'wxt/browser';
import type { ReaderDocRequest } from '@/core/messages';

/** 空壳页面自己的元素（site/reader.html） */
const SHELL = '[data-ahh-shell]';

/**
 * 把导入论文的页面填进阅读页，返回是否填入；这台电脑上没有这篇论文时在页面上说明。
 * 只删掉空壳自己的元素，<html>、<head>、<body> 本身和其他扩展插入的内容都保留：
 * 翻译插件可能已经往 <head> 里加了样式、在监视 <body> 的变化
 */
export async function fillReaderPage(paperId: string): Promise<boolean> {
  const msg: ReaderDocRequest = { type: 'ahh:reader-doc', paperId };
  const html: unknown = await browser.runtime.sendMessage(msg).catch(() => null);
  if (typeof html !== 'string') {
    const main = document.querySelector<HTMLElement>(`main${SHELL}`);
    if (main) {
      main.textContent = '这台电脑上没有这篇论文的页面，请在论文库里重新导入 PDF。';
      main.style.animationDelay = '0s';
    }
    return false;
  }
  // 论文页面没有脚本，图片都内嵌为 data: URL
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of document.querySelectorAll(SHELL)) el.remove();
  for (const [to, from] of [
    [document.documentElement, doc.documentElement],
    [document.body, doc.body],
  ] as const) {
    for (const { name, value } of Array.from(from.attributes)) to.setAttribute(name, value);
  }
  document.head.append(...doc.head.childNodes);
  document.body.prepend(...doc.body.childNodes);
  return true;
}
