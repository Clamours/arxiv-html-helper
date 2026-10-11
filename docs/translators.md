# 翻译插件的 DOM 结构

`src/adapters/index.ts` 里的选择器依据。结论来自对插件发布包的静态分析（2026-09-28），**尚未在真实页面上逐项核对**；用 `scripts/capture-dom.js` 抓取真实 DOM 后更新本文。

| | 沉浸式翻译 1.33.3 | 陪读蛙 1.48.1（源码 1.49.0） |
|---|---|---|
| 译文 wrapper | `font.notranslate.immersive-translate-target-wrapper` | `span.notranslate.read-frog-translated-content-wrapper` |
| wrapper 位置 | 原文段落内部，最后一个原文节点之后 | 原文段落内部末尾 |
| 仅译文模式（首选） | 原地改写原文文本节点，段落加 `data-imt-translation-only="1"` | 原地改写原文文本节点，"最后一个原文节点的父元素"加 `data-read-frog-translation-only` |
| 仅译文模式（兜底） | 插入 wrapper，移除原文节点 | 插入 `display: contents` 的 wrapper，移除原文节点 |
| 公式 | 复制进译文（可能保留 id，导致 id 重复） | 深拷贝进译文，去掉 id，加 `read-frog-inline-atom` |
| 加载/错误元素 | `[data-immersive-translate-loading-id]` | `.read-frog-spinner`、`.read-frog-translation-error-container` |
| Shadow DOM | 只用于弹窗和提示，页面内译文不用 | 只用于错误框 |
| arXiv 专用规则 | `bodySelector: article`；排除目录、作者、参考文献；开启 rich translate | 排除部分元素，调整公式样式 |

## 双语模式示意

沉浸式翻译：

```html
<p class="ltx_p" data-imt-p="1">原文 <math>…</math> 原文
  <font class="notranslate immersive-translate-target-wrapper" lang="zh-CN">
    <br>
    <font class="notranslate immersive-translate-target-translation-block-wrapper" data-immersive-translate-translation-element-mark="1">
      <font class="notranslate immersive-translate-target-inner" data-immersive-translate-translation-element-mark="1">译文 <math>…</math> 译文</font>
    </font>
  </font>
</p>
```

陪读蛙：

```html
<p class="ltx_p" data-read-frog-paragraph="">原文 <math>…</math> 原文
  <span class="notranslate read-frog-translated-content-wrapper" data-read-frog-translation-mode="bilingual">
    <br>
    <span class="notranslate read-frog-translated-block-content">译文 <math class="read-frog-inline-atom">…</math> 译文</span>
  </span>
</p>
```

短段落时两者都会把 `<br>` + 块级容器换成两个空格 + 行内容器，外层 wrapper 不变。

## 对本扩展的影响

- **wrapper 模式**：wrapper 所在的最近块就是它对应的原文块。原文层文本跳过 wrapper，所以译文出现与否不影响原文偏移。
- **原地替换模式**：原文节点里装的已经是译文。被标记的块整体算译文层，原文层笔记显示为 `waiting`（原文未显示）。陪读蛙的标记可能打在 `<cite>` 这类行内元素上，因此判断以块为单位。
- **不能当作"已翻译"信号的属性**：`data-read-frog-walked`、`data-read-frog-paragraph`（只表示"可翻译"）。沉浸式翻译 1.33.3 的 `data-immersive-translate-walked` / `-paragraph` 不再写到 DOM 上。

## 译文存档

扩展自己的译文存档（见 [saved-translations.md](saved-translations.md)）也按双语模式的结构插入：`span.notranslate.ahh-saved-translation[translate=no]` 追加到原文块内部末尾。存档显示时，同一段里翻译插件的 wrapper 加上 `data-ahh-superseded` 隐藏。

## 待在真实页面上确认

- 两个插件是否都跳过 `notranslate` / `translate="no"` 的存档 wrapper，不会把存档的中文再翻一遍
- 段落里插入存档 wrapper 后，插件是否会认为段落内容变了而重新翻译
- 沉浸式翻译的加载元素 `[data-immersive-translate-loading-id]` 是否在段落内部（存档时据此跳过还没翻完的段落）

- 含公式的 arXiv 段落在仅译文模式下，实际走的是原地替换还是兜底
- 沉浸式翻译把哪些段落当作行内、哪些当作块级
- 沉浸式翻译复制进译文的公式是否保留 id
