import type { HighlightColor } from '@/core/types';

/** 高亮颜色的色块：划词工具栏、侧边栏、分组颜色共用。页面上的高亮本身是半透明的，见 src/content/highlighter.ts */
export const COLOR_SWATCH: Record<HighlightColor, string> = {
  yellow: '#ffd60a',
  green: '#34c759',
  blue: '#0a84ff',
  pink: '#ff375f',
  purple: '#af52de',
};
