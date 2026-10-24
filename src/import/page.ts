/**
 * 导入论文的完整页面：<article class="ltx_document"> 外面套上 arXiv HTML 的页面骨架和样式。
 * <html lang> 要设对，翻译插件靠它判断源语言。
 */
import { IMPORTED_META } from '@/core/paper';
import { renderArticle, type RenderOptions } from './latexml';
import { allBlocks, parseMinerUMarkdown, type MinerUPaper } from './mineru';

const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;

/** 粗略判断正文语言：汉字明显多于拉丁字母时为中文 */
export function detectLang(paper: MinerUPaper): 'zh' | 'en' {
  const sample = [paper.title, ...paper.abstract, ...allBlocks(paper).map((b) => (b.kind === 'para' ? b.text : ''))]
    .join(' ')
    .slice(0, 20000);
  const cjk = sample.match(CJK)?.length ?? 0;
  const latin = sample.match(LATIN)?.length ?? 0;
  return cjk * 3 > latin ? 'zh' : 'en';
}

export const PAGE_CSS = `
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fff; --muted: #555; --rule: #999; --link: #2b59c3; --target: #fff3c4; }
@media (prefers-color-scheme: dark) { :root { --fg: #ddd; --bg: #1c1c1e; --muted: #aaa; --rule: #666; --link: #8ab4f8; --target: #3d3620; } }
html { background: var(--bg); color: var(--fg); }
body { margin: 0; font: 17px/1.6 "Noto Serif", "Source Serif 4", Georgia, "Songti SC", serif; }
.ltx_page_main { max-width: 52em; margin: 0 auto; padding: 2em 1.5em 6em; }
a { color: var(--link); }
.ltx_ref { text-decoration: none; }
.ltx_ref:hover { text-decoration: underline; }
math { font-family: "Latin Modern Math", "STIX Two Math", "Cambria Math", math; }
.ltx_title_document { font-size: 1.9em; line-height: 1.25; text-align: center; margin: 0.5em 0; }
.ltx_authors { text-align: center; color: var(--muted); margin: 1em 0 2em; }
.ltx_abstract { margin: 0 2.5em 2em; }
.ltx_title_abstract { font-size: 1em; text-align: center; margin: 0 0 0.5em; }
section > .ltx_title { line-height: 1.3; margin: 1.6em 0 0.6em; }
.ltx_tag_section, .ltx_tag_subsection, .ltx_tag_subsubsection, .ltx_tag_appendix { margin-right: 0.4em; }
.ltx_para { margin: 0.8em 0; }
.ltx_p { margin: 0; text-align: justify; hyphens: auto; }
.ltx_font_bold { font-weight: bold; }
.ltx_font_italic { font-style: italic; }
table.ltx_equation { width: 100%; margin: 0.8em 0; border-collapse: collapse; }
.ltx_eqn_cell { padding: 0; }
.ltx_eqn_center_padleft, .ltx_eqn_center_padright { width: 50%; }
.ltx_eqn_eqno { padding-left: 1em; white-space: nowrap; }
td.ltx_align_center > math[display="block"] { overflow-x: auto; overflow-y: hidden; max-width: 100%; }
figure { margin: 1.5em 0; }
.ltx_graphics { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.ltx_flex_figure { display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-end; gap: 0.5em 1em; }
.ltx_flex_cell { flex: 1 1 14em; min-width: 0; }
.ltx_figure_panel { margin: 0; }
.ltx_caption { font-size: 0.92em; margin-top: 0.6em; text-align: justify; }
.ltx_figure_panel .ltx_caption { text-align: center; }
.ltx_tag_figure, .ltx_tag_table { font-weight: bold; }
.ltx_transformed_outer { overflow-x: auto; }
.ltx_tabular { border-collapse: collapse; margin: 0.5em auto; font-size: 0.9em; border-top: 2px solid var(--rule); border-bottom: 2px solid var(--rule); }
.ltx_tabular tr:first-child > .ltx_td { border-bottom: 1px solid var(--rule); }
.ltx_tabular .ltx_td { padding: 0.25em 0.6em; }
.ltx_table .ltx_caption { margin: 0 0 0.4em; }
.ltx_algorithm { border-top: 2px solid var(--rule); border-bottom: 2px solid var(--rule); padding: 0.2em 0 0.4em; }
.ltx_algorithm > .ltx_caption { margin: 0 0 0.3em; padding-bottom: 0.2em; border-bottom: 1px solid var(--rule); text-align: left; }
.ltx_tag_float { font-weight: bold; }
.ltx_listingline { text-align: left; padding-left: 2.2em; text-indent: -2.2em; font-size: 0.95em; }
.ltx_tag_listingline { display: inline-block; width: 2.2em; text-indent: 0; color: var(--muted); font-variant-numeric: tabular-nums; }
.ltx_figure_missing { padding: 2.5em 1em; border: 1px dashed var(--rule); border-radius: 6px; text-align: center; color: var(--muted); font-size: 0.9em; }
.ltx_biblist { list-style: none; padding: 0; font-size: 0.92em; }
.ltx_bibitem { margin: 0.4em 0; padding-left: 1.5em; text-indent: -1.5em; }
.ltx_bibitem .ltx_tag { margin-right: 0.3em; }
.ltx_bibitem:target { background: var(--target); }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** 转换规则的版本，写在页面里便于排查问题。页面生成后不会因为这个版本变化而重新生成 */
export const CONVERTER_VERSION = 5;

export interface PageOptions extends RenderOptions {
  /** 导入论文的 id，写进 <meta>，内容脚本据此识别本地打开的论文页面 */
  paperId?: string;
}

/** 完整的 HTML 文档（字符串），可以存成文件打开 */
export function standaloneHtml(doc: Document, paper: MinerUPaper, opts: PageOptions = {}): string {
  const article = renderArticle(doc, paper, opts);
  // 标签页标题里的公式显示为 TeX
  const title = paper.title.replace(/\$([^$]+)\$/g, '$1').trim() || 'Untitled';
  return `<!DOCTYPE html>
<html lang="${detectLang(paper)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="arxiv-html-helper mineru-import/${CONVERTER_VERSION}">
${opts.paperId ? `<meta name="${IMPORTED_META}" content="${escapeHtml(opts.paperId)}">\n` : ''}
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="ltx_page_main">
<div class="ltx_page_content">
${article.outerHTML}
</div>
</div>
</body>
</html>
`;
}

export function mineruToHtml(doc: Document, md: string, opts: PageOptions = {}): string {
  return standaloneHtml(doc, parseMinerUMarkdown(md), opts);
}
