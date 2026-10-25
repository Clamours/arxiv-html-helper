// 截图脚本注入到 arXiv 论文页的隔离环境里（和扩展的内容脚本在同一个环境），在 chrome-mock.js 之后运行：
// 提供划线、写笔记、模拟沉浸式翻译译文等操作，挂在 globalThis.__shots 上，由 capture.ts 调用
(() => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 划词工具栏、笔记编辑框所在的 Shadow DOM（见 src/content/ui.ts） */
  const ui = () => document.querySelector('arxiv-notes-ui')?.shadowRoot;
  /** 工具栏色块的 aria-label */
  const COLOR_LABEL = { yellow: '黄色高亮', green: '绿色高亮', blue: '蓝色高亮', pink: '粉色高亮', purple: '紫色高亮' };

  /** 在正文里找一段文字，返回 Range。页面上连续的空白按一个空格匹配，跳过公式 */
  function find(needle) {
    const root = document.querySelector('article') ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('math, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let text = '';
    const at = [];
    let space = true;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (let i = 0; i < n.data.length; i++) {
        const ws = /\s/.test(n.data[i]);
        if (ws && space) continue;
        text += ws ? ' ' : n.data[i];
        at.push([n, i]);
        space = ws;
      }
    }
    const start = text.indexOf(needle);
    if (start < 0) throw new Error(`正文里没有找到：${needle}`);
    const [endNode, endOffset] = at[start + needle.length - 1];
    const range = document.createRange();
    range.setStart(...at[start]);
    range.setEnd(endNode, endOffset + 1);
    return range;
  }

  /** 选中一段文字，像松开鼠标那样触发划词工具栏 */
  async function select(text) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(find(text));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await tick(300);
  }

  /** 划线；note 不为空时再写上笔记 */
  async function highlight(text, color, note) {
    await select(text);
    const dot = ui()?.querySelector(`.dot[aria-label="${COLOR_LABEL[color]}"]`);
    if (!dot) throw new Error(`没有弹出划词工具栏：${text}`);
    dot.click();
    await tick(250);
    if (note) await setNote(text, note);
  }

  /** 给包含这段文字的划线写笔记：和侧边栏一样，发消息给内容脚本 */
  async function setNote(text, note) {
    const { items } = await globalThis.__screenshotDispatch({ type: 'ahh:get-state' });
    const ann = items.map((it) => it.annotation).find((a) => a.segments.some((s) => s.quote.exact.includes(text)));
    if (!ann) throw new Error(`没有找到划线：${text}`);
    // 内容脚本不回复这条消息，不用等
    void globalThis.__screenshotDispatch({ type: 'ahh:update', id: ann.id, patch: { note } });
    await tick(300);
  }

  /** 像沉浸式翻译的双语对照那样，把译文追加到段落末尾（结构见 src/adapters/index.ts） */
  function translate(paragraphId, html) {
    const p = document.getElementById(paragraphId)?.querySelector('p');
    if (!p) throw new Error(`没有找到段落：${paragraphId}`);
    p.setAttribute('data-imt-p', '1');
    const wrapper = document.createElement('font');
    wrapper.className = 'notranslate immersive-translate-target-wrapper';
    wrapper.lang = 'zh-CN';
    wrapper.innerHTML =
      '<br><font class="notranslate immersive-translate-target-translation-theme-none immersive-translate-target-translation-block-wrapper-theme-none immersive-translate-target-translation-block-wrapper">' +
      `<font class="notranslate immersive-translate-target-inner immersive-translate-target-translation-theme-none-inner">${html}</font></font>`;
    p.append(wrapper);
  }

  /** 点一下包含这段文字的划线，打开笔记编辑框 */
  async function openEditor(text) {
    getSelection().removeAllRanges();
    const rect = find(text).getClientRects()[0];
    const x = rect.left + rect.width * 0.6;
    const y = rect.top + rect.height / 2;
    document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    await tick(300);
    if (!ui()?.querySelector('textarea')) throw new Error(`没有打开笔记编辑框：${text}`);
  }

  /** 取消选区，关掉工具栏和编辑框 */
  async function clear() {
    getSelection().removeAllRanges();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
    await tick(150);
  }

  /** 滚动到元素，留出 arXiv 吸顶页头的高度 */
  function scrollToElement(selector, gap = 20) {
    let top = 0;
    for (const el of document.querySelectorAll('body *')) {
      const { position } = getComputedStyle(el);
      if (position !== 'sticky' && position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.top <= 0.5 && r.height < 120 && r.width > innerWidth / 2) top = Math.max(top, r.bottom);
    }
    const el = document.querySelector(selector);
    if (!el) throw new Error(`没有找到：${selector}`);
    window.scrollTo(0, scrollY + el.getBoundingClientRect().top - top - gap);
  }

  globalThis.__shots = {
    select,
    highlight,
    translate,
    openEditor,
    clear,
    scrollTo: scrollToElement,
    /** 页面状态，和侧边栏向内容脚本要的一样 */
    pageState: () => globalThis.__screenshotDispatch({ type: 'ahh:get-state' }),
    /** 存储里的全部数据 */
    storage: () => chrome.storage.local.get(null),
  };
})();
