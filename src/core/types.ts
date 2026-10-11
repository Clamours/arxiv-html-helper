/** 文本所在的层：arXiv 原文，或翻译插件注入的译文 */
export type Layer = 'source' | 'translation';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

export const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];

/**
 * 一条笔记在某一个块里的片段。跨段落的划线会拆成多个 Segment。
 *
 * 定位时先用 position（快），校验失败再用 quote 搜索（稳）。
 */
export interface Segment {
  /** 原文块的稳定 key（见 blocks.ts）。译文层也记录它所对应的原文块。 */
  blockKey: string;
  /** 在该块、该层的规范化文本中的偏移 */
  position: { start: number; end: number };
  quote: { exact: string; prefix: string; suffix: string };
  /** 仅译文层：划线时的上下文，用于重新翻译后的模糊匹配和孤立笔记展示 */
  translation?: {
    provider: string;
    /** 划线时整段译文的文本 */
    snapshot: string;
  };
}

export interface Annotation {
  id: string;
  /** arXiv id，不含版本号，如 "1706.03762" */
  paperId: string;
  /** 划线时的版本，如 "v7"；URL 不带版本时为空串 */
  paperVersion: string;
  layer: Layer;
  segments: Segment[];
  color: HighlightColor;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 运行时定位状态，不持久化。
 * - waiting：该层当前不可见——译文层笔记但段落没有显示译文（未翻译 / 已关闭翻译），
 *   或原文层笔记但段落处于"仅译文"模式
 * - orphaned：找不到了（论文改版、译文大幅变化），侧边栏仍按引文展示
 */
export type AnchorStatus = 'anchored' | 'partial' | 'waiting' | 'orphaned';
