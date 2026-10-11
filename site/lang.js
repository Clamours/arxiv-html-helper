// 中英文切换。页面里每段文字写两份（lang="zh" / lang="en"），按 <html data-lang> 只显示一份。
// 语言的来源依次是：网址的 ?lang= 参数、上次的选择、浏览器语言。
// 这个脚本在 <head> 里同步加载，页面渲染前就定好语言，不会先闪一下另一种语言
(function () {
  var root = document.documentElement;
  var KEY = 'lang';
  function load() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function valid(v) { return v === 'zh' || v === 'en'; }

  var param = new URLSearchParams(location.search).get('lang');
  var lang = valid(param) ? param : load();
  if (!valid(lang)) lang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  if (valid(param)) save(param);

  function apply(v) {
    lang = v;
    root.setAttribute('data-lang', v);
    root.lang = v === 'zh' ? 'zh-CN' : 'en';
    var title = root.getAttribute('data-title-' + v);
    if (title) document.title = title;
  }
  apply(lang);

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('lang-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      apply(lang === 'zh' ? 'en' : 'zh');
      save(lang);
      // 地址栏同步成当前语言，复制出去的链接打开就是这种语言
      var url = new URL(location.href);
      url.searchParams.set('lang', lang);
      history.replaceState(null, '', url);
    });
  });
})();
