/**
 * 抓取翻译插件在 arXiv HTML 页面上注入的真实 DOM，用于核对 src/adapters 里的选择器。
 *
 * 用法：打开 arxiv.org/html/…，用沉浸式翻译或陪读蛙翻译几段（双语、仅译文模式各试一次），
 * 然后把本文件全部内容粘贴到 DevTools Console 回车。会下载一个 JSON 文件。
 */
(() => {
  const article = document.querySelector('article.ltx_document') ?? document.body;
  const PATTERN = /immersive|imt|read-frog|notranslate/i;

  // 1. 统计所有与翻译插件相关的类名和属性
  const classes = {};
  const attrs = {};
  for (const el of article.querySelectorAll('*')) {
    for (const c of el.classList) if (PATTERN.test(c)) classes[c] = (classes[c] ?? 0) + 1;
    for (const a of el.attributes) if (PATTERN.test(a.name)) attrs[`${el.localName}[${a.name}]`] = (attrs[`${el.localName}[${a.name}]`] ?? 0) + 1;
  }

  // 2. 取几个被翻译过的段落，公式缩成 alttext 以减小体积
  const shrink = (el) => {
    const c = el.cloneNode(true);
    for (const m of c.querySelectorAll('math')) m.innerHTML = `<!--${m.getAttribute('alttext') ?? ''}-->`;
    return c.outerHTML;
  };
  const markers = [
    '.immersive-translate-target-wrapper',
    '[data-imt-translation-only]',
    '.read-frog-translated-content-wrapper',
    '[data-read-frog-translation-only]',
  ];
  const samples = {};
  for (const sel of markers) {
    const hits = [...article.querySelectorAll(sel)].slice(0, 3);
    samples[sel] = hits.map((h) => {
      const para = h.closest('.ltx_para') ?? h.parentElement;
      return { parentChain: chain(h), html: shrink(para) };
    });
  }
  function chain(el) {
    const out = [];
    for (let e = el; e && e !== article; e = e.parentElement) {
      out.push(e.localName + (e.id ? `#${e.id}` : '') + [...e.classList].map((c) => `.${c}`).join(''));
    }
    return out.join(' < ');
  }

  // 3. 页面根上的状态属性（如 imt-state）
  const rootAttrs = [...document.documentElement.attributes, ...document.body.attributes]
    .filter((a) => PATTERN.test(a.name) || PATTERN.test(a.value))
    .map((a) => `${a.name}=${a.value}`);

  const report = { url: location.href, time: new Date().toISOString(), rootAttrs, classes, attrs, samples };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `translator-dom-${Date.now()}.json`;
  a.click();
  console.log('[capture-dom]', report);
})();
