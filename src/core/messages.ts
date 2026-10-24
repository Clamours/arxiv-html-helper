import type { PaperRef } from './paper';
import type { SavedBlock, SavedSummary } from './translations';
import type { AnchorStatus, Annotation, HighlightColor } from './types';

/** 侧边栏、background → 内容脚本 */
export type Request =
  | { type: 'ahh:get-state' }
  | { type: 'ahh:scroll-to'; id: string }
  | { type: 'ahh:update'; id: string; patch: { color?: HighlightColor; note?: string } }
  | { type: 'ahh:delete'; id: string }
  /** 侧边栏：清除本篇论文的译文存档 */
  | { type: 'ahh:saved-clear' }
  /** background：这些论文的译文存档变了（云同步、其他标签页清除了存档） */
  | { type: 'ahh:tr-changed'; paperIds: string[] };

/** 内容脚本 → background：译文存档的读写，回复 PaperTranslations */
export type TranslationRequest =
  | { type: 'ahh:tr-load'; paperId: string }
  | { type: 'ahh:tr-put'; paperId: string; blocks: SavedBlock[] }
  | { type: 'ahh:tr-clear'; paperId: string };

/** 阅读页的内容脚本 → background：取导入论文的页面 HTML，回复 string | null */
export interface ReaderDocRequest {
  type: 'ahh:reader-doc';
  paperId: string;
}

/** 内容脚本 → 侧边栏（广播） */
export interface StateChanged {
  type: 'ahh:state-changed';
}

export interface PageState {
  paper: PaperRef;
  /** 从页面提取的标题；可能已被翻译插件改写，侧边栏优先用存储里的元数据 */
  pageTitle: string;
  /** 已按文档顺序排好，定位不到的排在最后 */
  items: { annotation: Annotation; status: AnchorStatus }[];
  /** 当前页面检测到的翻译插件及译文段落数，用于诊断适配器是否生效 */
  providers: { id: string; name: string; count: number }[];
  /** 译文存档 */
  saved: SavedSummary;
}

/**
 * 论文库页、内容脚本 → background：立即同步，回复同步后的状态（SyncStatus）。
 * quiet：打开页面时顺便拉取一次，最近半分钟内同步过就跳过；没有开启同步时什么也不做
 */
export interface SyncNowRequest {
  type: 'ahh:sync-now';
  quiet?: boolean;
}
