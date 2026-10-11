import { stableStringify } from './sync';

/**
 * 译文存档：把翻译插件显示过的译文按段落保存下来，之后由本扩展自己显示（见 src/content/translations.ts）。
 * 换电脑、关掉翻译插件、翻译插件重新翻译出不同措辞时，页面上的译文和译文层笔记都保持不变。
 *
 * - 每段译文以"原文块 key + 原文哈希"为标识：论文改版、原文变了的段落不再套用旧译文
 * - 同一段存档优先：已有存档时不再覆盖；两台电脑各自存了同一段时，先存的一份胜出
 * - 清除存档（或从论文库移除论文）时记下 clearedAt，此前采集的译文在所有电脑上作废
 *
 * 这里只放纯逻辑；本机存储在 src/translations/，云同步在 src/sync/translations.ts。
 */

export interface SavedBlock {
  /** 原文块的 key（见 blocks.ts） */
  blockKey: string;
  /** 采集时原文块规范化文本的哈希 */
  sourceHash: string;
  /** 采集自哪个翻译插件（适配器 id） */
  provider: string;
  /** 清洗后的译文 HTML，只含白名单里的标签和属性（见 sanitizeTranslation） */
  html: string;
  capturedAt: number;
}

export interface PaperTranslations {
  paperId: string;
  /** entryKey → 译文 */
  blocks: Record<string, SavedBlock>;
  /** 清除存档的时间；不晚于它采集的译文作废。从未清除过时为 0 */
  clearedAt: number;
}

/** 当前页面的存档情况，显示在侧边栏 */
export interface SavedSummary {
  /** 本篇论文存档的段落数 */
  total: number;
  /** 当前页面上由存档显示的段落数 */
  shown: number;
  /** 本机是否显示存档 */
  visible: boolean;
}

export const SAVED_WRAPPER_CLASS = 'ahh-saved-translation';

export const entryKey = (b: Pick<SavedBlock, 'blockKey' | 'sourceHash'>) => `${b.sourceHash}:${b.blockKey}`;

export const emptyTranslations = (paperId: string): PaperTranslations => ({ paperId, blocks: {}, clearedAt: 0 });

/** 两份存档合并；与顺序无关，重复合并不变 */
export function mergeTranslations(a: PaperTranslations, b: PaperTranslations): PaperTranslations {
  const clearedAt = Math.max(a.clearedAt, b.clearedAt);
  const blocks: Record<string, SavedBlock> = {};
  for (const x of [...Object.values(a.blocks), ...Object.values(b.blocks)]) {
    if (x.capturedAt <= clearedAt) continue;
    const k = entryKey(x);
    const prev = blocks[k];
    blocks[k] = prev ? earlier(prev, x) : x;
  }
  return { paperId: a.paperId, blocks, clearedAt };
}

/** 先存的胜出；时间相同时按内容取一个确定的，保证两台电脑结果一致 */
function earlier(a: SavedBlock, b: SavedBlock): SavedBlock {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? a : b;
  return stableStringify(a) <= stableStringify(b) ? a : b;
}

/** 存档内容的指纹，用于判断两边是否一致 */
export function translationsHash(p: PaperTranslations): string {
  return hashText(stableStringify({ blocks: p.blocks, clearedAt: p.clearedAt }));
}

/** cyrb53：快速的 53 位字符串哈希，十六进制。只用于判断内容是否相同，不用于安全 */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// ---------------------------------------------------------------------------
// 校验（来自本机数据库、云端文件、内容脚本的消息）
// ---------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

export function toSavedBlock(x: unknown): SavedBlock | null {
  if (!isObj(x)) return null;
  const { blockKey, sourceHash, provider, html, capturedAt } = x;
  if (typeof blockKey !== 'string' || !blockKey.startsWith('#')) return null;
  if (typeof sourceHash !== 'string' || !sourceHash || typeof html !== 'string' || !isTime(capturedAt)) return null;
  return { blockKey, sourceHash, provider: typeof provider === 'string' ? provider : 'unknown', html, capturedAt };
}

/** blocks 可以是对象（本机存储）或数组（云端文件） */
export function toPaperTranslations(x: unknown, paperId: string): PaperTranslations {
  const out = emptyTranslations(paperId);
  if (!isObj(x)) return out;
  if (isTime(x.clearedAt)) out.clearedAt = x.clearedAt;
  const list = Array.isArray(x.blocks) ? x.blocks : isObj(x.blocks) ? Object.values(x.blocks) : [];
  const valid = list.map(toSavedBlock).filter((b): b is SavedBlock => !!b);
  // 走一遍合并：按 entryKey 去重，去掉已作废的
  return mergeTranslations(out, { paperId, blocks: Object.fromEntries(valid.map((b, i) => [i, b])), clearedAt: 0 });
}

// ---------------------------------------------------------------------------
// 云端文件
// ---------------------------------------------------------------------------

export const TRANSLATION_FILE_FORMAT = 'arxiv-html-notes-translations';
export const TRANSLATION_INDEX_FORMAT = 'arxiv-html-notes-translations-index';
export const TRANSLATION_FILE_VERSION = 1;

export class TranslationFileError extends Error {}

export function toTranslationFile(p: PaperTranslations) {
  return {
    format: TRANSLATION_FILE_FORMAT,
    version: TRANSLATION_FILE_VERSION,
    paperId: p.paperId,
    clearedAt: p.clearedAt,
    blocks: Object.keys(p.blocks).sort().map((k) => p.blocks[k]!),
  };
}

export function parseTranslationFile(text: string, paperId: string): PaperTranslations {
  const data = parseJson(text);
  if (!isObj(data) || data.format !== TRANSLATION_FILE_FORMAT) throw new TranslationFileError('不是译文存档文件');
  checkVersion(data.version);
  return toPaperTranslations(data, paperId);
}

/** 云端索引：论文 id → 存档指纹。同步时只下载指纹和本机不同的论文 */
export function toIndexFile(papers: Record<string, string>) {
  const sorted = Object.fromEntries(Object.keys(papers).sort().map((k) => [k, papers[k]!]));
  return { format: TRANSLATION_INDEX_FORMAT, version: TRANSLATION_FILE_VERSION, papers: sorted };
}

export function parseIndexFile(text: string): Record<string, string> {
  const data = parseJson(text);
  if (!isObj(data) || data.format !== TRANSLATION_INDEX_FORMAT || !isObj(data.papers)) throw new TranslationFileError('不是译文存档索引');
  checkVersion(data.version);
  const out: Record<string, string> = {};
  for (const [id, h] of Object.entries(data.papers)) if (id && typeof h === 'string') out[id] = h;
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TranslationFileError('文件不是有效的 JSON');
  }
}

function checkVersion(v: unknown): void {
  if (typeof v !== 'number' || v > TRANSLATION_FILE_VERSION) throw new TranslationFileError('文件来自更新版本的插件，请先升级插件');
}

// ---------------------------------------------------------------------------
// 清洗：存档的 HTML 会插回页面，而且可能来自云端，必须只保留无害的标签和属性
// ---------------------------------------------------------------------------

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/** 整棵子树丢弃 */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed', 'svg', 'img', 'picture', 'video',
  'audio', 'canvas', 'button', 'input', 'textarea', 'select', 'form', 'link', 'meta', 'base', 'annotation-xml',
]);

/** 保留的 HTML 行内标签；其他标签去掉外壳、保留内容（翻译插件的 font、span 等 wrapper） */
const HTML_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small', 'code', 'cite', 'q', 'span', 'br']);

const MATH_TAGS = new Set([
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mspace', 'msub', 'msup', 'msubsup',
  'munder', 'mover', 'munderover', 'mmultiscripts', 'mprescripts', 'none', 'mfrac', 'msqrt', 'mroot', 'mstyle',
  'mpadded', 'mphantom', 'menclose', 'merror', 'mtable', 'mtr', 'mlabeledtr', 'mtd', 'maligngroup', 'malignmark',
]);

const MATH_ATTRS = new Set([
  'alttext', 'display', 'mathvariant', 'mathsize', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent',
  'accentunder', 'movablelimits', 'largeop', 'symmetric', 'minsize', 'maxsize', 'linethickness', 'columnalign',
  'rowalign', 'columnspacing', 'rowspacing', 'columnspan', 'rowspan', 'displaystyle', 'scriptlevel', 'width',
  'height', 'depth', 'voffset', 'notation', 'encoding', 'form', 'bevelled',
]);

/** 块级的 LaTeXML 类名会让译文里的元素被当成原文块（见 blocks.ts），去掉 */
const BLOCK_CLASSES = new Set(['ltx_para', 'ltx_bibblock', 'ltx_note_content', 'ltx_abstract', 'ltx_authors']);

function safeClass(el: Element): string {
  return Array.from(el.classList)
    .filter((c) => /^ltx_[\w-]+$/.test(c) && !BLOCK_CLASSES.has(c))
    .join(' ');
}

/**
 * 把节点（翻译插件的译文、或从存档解析出来的 HTML）复制成只含白名单内容的片段。
 * 新建元素而不是在原节点上删改，任何没列出的属性（id、事件、样式）都不会带过来。
 */
export function sanitizeTranslation(nodes: Iterable<Node>, doc: Document): DocumentFragment {
  const out = doc.createDocumentFragment();
  const copy = (node: Node, parent: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(doc.createTextNode((node as Text).data));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.localName;
    if (DROP_TAGS.has(tag)) return;
    let next: Element | null = null;
    if (el.namespaceURI === MATHML_NS) {
      if (MATH_TAGS.has(tag)) {
        next = doc.createElementNS(MATHML_NS, tag);
        for (const a of Array.from(el.attributes)) if (MATH_ATTRS.has(a.name)) next.setAttribute(a.name, a.value);
      }
    } else if (HTML_TAGS.has(tag)) {
      next = doc.createElement(tag);
      const href = el.getAttribute('href')?.trim();
      if (tag === 'a' && href && /^(https?:|#)/i.test(href)) next.setAttribute('href', href);
    }
    if (next) {
      const cls = safeClass(el);
      if (cls) next.setAttribute('class', cls);
      parent.appendChild(next);
    }
    for (let c = el.firstChild; c; c = c.nextSibling) copy(c, next ?? parent);
  };
  for (const n of nodes) copy(n, out);
  trimEdges(out);
  return out;
}

/** 去掉开头和结尾的 <br> 与空白（翻译插件在原文和译文之间插的换行） */
function trimEdges(frag: DocumentFragment): void {
  const blank = (n: Node | null) =>
    !!n &&
    ((n.nodeType === Node.TEXT_NODE && !(n as Text).data.trim()) ||
      (n.nodeType === Node.ELEMENT_NODE && (n as Element).localName === 'br'));
  while (blank(frag.firstChild)) frag.firstChild!.remove();
  while (blank(frag.lastChild)) frag.lastChild!.remove();
}

/** 解析存档 HTML 并清洗。用 <template> 解析，过程中不会执行脚本、加载图片 */
export function parseSavedHtml(html: string, doc: Document): DocumentFragment {
  const t = doc.createElement('template');
  t.innerHTML = html;
  return sanitizeTranslation(Array.from(t.content.childNodes), doc);
}

export function fragmentToHtml(frag: DocumentFragment, doc: Document): string {
  const div = doc.createElement('div');
  div.append(frag);
  return div.innerHTML;
}
