import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn();
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: (msg: unknown) => sendMessage(msg) } } }));

import { fillReaderPage } from '../src/content/reader';
import { parseImportedPage, READER_PAGE, readerPaperId, readerUrl } from '../src/core/paper';

const ID = 'pdf-0123456789abcdef0123';

describe('阅读页网址', () => {
  it('从网址取论文 id，忽略锚点和其他参数', () => {
    expect(readerUrl(ID)).toBe(`${READER_PAGE}?id=${ID}`);
    expect(readerPaperId(readerUrl(ID))).toBe(ID);
    expect(readerPaperId(`${readerUrl(ID)}#S2.SS1`)).toBe(ID);
    expect(readerPaperId(`${READER_PAGE}?lang=en&id=${ID}`)).toBe(ID);
  });

  it('不是阅读页或 id 格式不对时返回 null', () => {
    expect(readerPaperId(`https://clamours.github.io/arxiv-html-helper/?id=${ID}`)).toBeNull();
    expect(readerPaperId(`https://evil.example/arxiv-html-helper/reader.html?id=${ID}`)).toBeNull();
    expect(readerPaperId(`${READER_PAGE}?id=../../x`)).toBeNull();
    expect(readerPaperId(READER_PAGE)).toBeNull();
    expect(readerPaperId('not a url')).toBeNull();
  });
});

describe('填入阅读页', () => {
  const PAPER = `<!DOCTYPE html><html lang="en"><head><meta name="ahh-paper-id" content="${ID}"><title>Paper</title><style>.p{}</style></head><body class="paper"><article><p>Hello</p></article></body></html>`;

  beforeEach(() => {
    sendMessage.mockReset();
    document.documentElement.setAttribute('lang', 'zh-CN');
    document.head.innerHTML = '<title data-ahh-shell>shell</title><style data-ahh-shell>main{}</style><style id="ext-style"></style>';
    document.body.removeAttribute('class');
    document.body.innerHTML = '<main data-ahh-shell><p>说明</p></main><div id="ext-ui"></div>';
  });

  it('换掉空壳，保留其他扩展插入的内容', async () => {
    sendMessage.mockResolvedValue(PAPER);
    expect(await fillReaderPage(ID)).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'ahh:reader-doc', paperId: ID });
    expect(document.querySelector('[data-ahh-shell]')).toBeNull();
    expect(document.title).toBe('Paper');
    expect(document.documentElement.lang).toBe('en');
    expect(document.body.className).toBe('paper');
    expect(document.getElementById('ext-style')).not.toBeNull();
    expect(Array.from(document.body.children, (e) => e.localName)).toEqual(['article', 'div']);
    expect(parseImportedPage(document, `${readerUrl(ID)}#S1`)).toEqual({ id: ID, version: '' });
  });

  it('这台电脑上没有这篇论文时留在空壳上说明', async () => {
    sendMessage.mockResolvedValue(null);
    expect(await fillReaderPage(ID)).toBe(false);
    expect(document.querySelector('main')!.textContent).toContain('重新导入');
    expect(parseImportedPage(document, readerUrl(ID))).toBeNull();
  });
});
