/**
 * 块：划线定位的基本单位，大致对应翻译插件的"段落"。
 *
 * LaTeXML 的段落 <p class="ltx_p"> 大多带 id（如 "S1.p2.1"），但图注、
 * 标题、参考文献条目等没有，只能用"最近带 id 的祖先 + 同标签序号"来标识。
 */
export const BLOCK_SELECTOR = [
  'p',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'figcaption',
  'li',
  'td', 'th',
  'dt', 'dd',
  'blockquote',
  'pre',
  '.ltx_bibblock',
  '.ltx_note_content',
  '.ltx_para',
  '.ltx_abstract',
  '.ltx_authors',
].join(',');

/** 判断节点是否不属于原文（译文、我们自己的 UI 等） */
export type ForeignPredicate = (node: Node) => boolean;

export function isBlock(el: Element): boolean {
  return el.matches(BLOCK_SELECTOR);
}

/** 节点所属的原文块：最近的块祖先（含自身） */
export function blockOf(node: Node, root: Element): Element | null {
  const el = node instanceof Element ? node : node.parentElement;
  const block = el?.closest(BLOCK_SELECTOR) ?? null;
  return block && root.contains(block) ? block : null;
}

const KEY_SEP = '>';

/**
 * 元素的稳定 key：
 * - 有 id：`#S1.p2.1`
 * - 无 id：`#S3.F1>figcaption:0`（最近带 id 的祖先下第 n 个同标签元素）
 * - 连祖先都没有 id：`#>h1:0`（相对 root）
 */
export function elementKey(el: Element, root: Element, isForeign: ForeignPredicate): string {
  if (el.id) return `#${el.id}`;
  let anc = el.parentElement;
  while (anc && anc !== root && !anc.id) anc = anc.parentElement;
  const scope = anc && anc !== root ? anc : root;
  const tag = el.tagName.toLowerCase();
  const peers = sameTagDescendants(scope, tag, isForeign);
  const scopeId = scope === root ? '' : scope.id;
  return `#${scopeId}${KEY_SEP}${tag}:${peers.indexOf(el)}`;
}

export function resolveElementKey(key: string, root: Element, isForeign: ForeignPredicate): Element | null {
  if (!key.startsWith('#')) return null;
  const sep = key.lastIndexOf(KEY_SEP);
  if (sep < 0) return byId(root, key.slice(1));
  const scopeId = key.slice(1, sep);
  const scope = scopeId ? byId(root, scopeId) : root;
  const m = /^([a-z0-9]+):(\d+)$/.exec(key.slice(sep + 1));
  if (!scope || !m) return null;
  return sameTagDescendants(scope, m[1]!, isForeign)[Number(m[2])] ?? null;
}

function byId(root: Element, id: string): Element | null {
  const el = root.ownerDocument.getElementById(id);
  return el && root.contains(el) ? el : null;
}

function sameTagDescendants(scope: Element, tag: string, isForeign: ForeignPredicate): Element[] {
  return Array.from(scope.getElementsByTagName(tag)).filter((e) => !isForeign(e));
}
