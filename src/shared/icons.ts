/**
 * 线条图标：24×24 网格、1.75 描边、圆角端点，颜色跟随 currentColor。页面浮层、侧边栏、论文库共用。
 *
 * 图形来自 Lucide（https://lucide.dev），ISC 许可：
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
 * All other copyright (c) for Lucide are held by Lucide Contributors 2022.
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee
 * is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
 */

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** 笔 + 横线：记笔记 / 编辑 */
export const PENCIL_ICON = svg(`
  <path d="M13 21h8"/>
  <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>`);

/** 垃圾桶：删除 */
export const TRASH_ICON = svg(`
  <path d="M3 6h18"/>
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  <path d="M10 11v6M14 11v6"/>`);

/** 两张叠放的纸：复制 */
export const COPY_ICON = svg(`
  <rect width="14" height="14" x="8" y="8" rx="2"/>
  <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>`);

/** 一本书和一本斜靠的书：论文库 */
export const LIBRARY_ICON = svg(`
  <rect width="8" height="18" x="3" y="3" rx="1"/>
  <path d="M7 3v18"/>
  <path d="M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"/>`);

/** 对勾：操作成功 */
export const CHECK_ICON = svg(`
  <path d="M20 6 9 17l-5-5"/>`);

/** 荧光笔：空状态插图 */
export const HIGHLIGHTER_ICON = svg(`
  <path d="m9 11-6 6v3h9l3-3"/>
  <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>`);

/** 放大镜：搜索 */
export const SEARCH_ICON = svg(`
  <circle cx="11" cy="11" r="7.5"/>
  <path d="m20.5 20.5-4.2-4.2"/>`);

/** 向下的折角：展开 */
export const CHEVRON_ICON = svg(`
  <path d="m6 9 6 6 6-6"/>`);

/** 托盘 + 向下箭头：导出 / 下载 */
export const DOWNLOAD_ICON = svg(`
  <path d="M12 15V3"/>
  <path d="m7 10 5 5 5-5"/>
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>`);

/** 文档 + 加号：导入 PDF */
export const FILE_PLUS_ICON = svg(`
  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/>
  <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
  <path d="M9 15h6M12 18v-6"/>`);

/** 托盘 + 向上箭头：导入 / 上传 */
export const UPLOAD_ICON = svg(`
  <path d="M12 3v12"/>
  <path d="m17 8-5-5-5 5"/>
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>`);

/** 旗帜：标记。旗面带 class="fill"，标记后填充 */
export const FLAG_ICON = svg(`
  <path class="fill" d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
  <path d="M4 22v-7"/>`);

/** 五角星：评分。星形带 class="fill"，选中后填充 */
export const STAR_ICON = svg(`
  <path class="fill" d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>`);

/** 标签：分组 */
export const TAG_ICON = svg(`
  <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>
  <circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>`);

/** 托盘：未分组 */
export const INBOX_ICON = svg(`
  <path d="M22 12h-6l-2 3h-4l-2-3H2"/>
  <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`);

/** 加号：新建 */
export const PLUS_ICON = svg(`
  <path d="M5 12h14M12 5v14"/>`);

/** 三个点：更多操作 */
export const MORE_ICON = svg(`
  <circle cx="5" cy="12" r="1"/>
  <circle cx="12" cy="12" r="1"/>
  <circle cx="19" cy="12" r="1"/>`);

/** 云：云同步 */
export const CLOUD_ICON = svg(`
  <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>`);

/** 云 + 对勾：已同步 */
export const CLOUD_CHECK_ICON = svg(`
  <path d="m17 15-5.5 5.5L9 18"/>
  <path d="M5 17.743A7 7 0 1 1 15.71 10h1.79a4.5 4.5 0 0 1 1.5 8.742"/>`);

/** 带斜线的云：同步出错 */
export const CLOUD_OFF_ICON = svg(`
  <path d="m2 2 20 20"/>
  <path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/>
  <path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/>`);

/** 侧栏 + 向右箭头：展开目录 */
export const PANEL_OPEN_ICON = svg(`
  <rect width="18" height="18" x="3" y="3" rx="2"/>
  <path d="M9 3v18"/>
  <path d="m14 9 3 3-3 3"/>`);

/** 侧栏 + 向左箭头：收起目录 */
export const PANEL_CLOSE_ICON = svg(`
  <rect width="18" height="18" x="3" y="3" rx="2"/>
  <path d="M9 3v18"/>
  <path d="m16 15-3-3 3-3"/>`);

/** 引号：复制引用 */
export const QUOTE_ICON = svg(`
  <path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>
  <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>`);
