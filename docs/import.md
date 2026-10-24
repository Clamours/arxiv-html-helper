# 导入 PDF

不在 arXiv 上、或者没有 HTML 版本的论文，可以导入 PDF：由 [MinerU](https://mineru.net) 解析，生成一个和 arXiv HTML 结构相同的论文页面，在上面划线、写笔记，并用沉浸式翻译 / 陪读蛙翻译。

## 使用

1. 在 [mineru.net](https://mineru.net/apiManage) 的 API 管理页面创建一个 Token（有效期 90 天，过期后换一个新的）
2. 在扩展详情页（`chrome://extensions` → 本扩展 → 详情）打开 **"允许访问文件网址"**
3. 论文库右上角点"导入 PDF"，填 Token，选择 PDF（可多选），点"开始导入"。第一次导入时 Chrome 会询问是否允许访问 MinerU 的服务器、管理下载内容，需要允许
4. 论文库顶部显示导入进度。解析通常要一到几分钟；完成后论文自动加入论文库，并在新标签页打开

之后在论文库点论文标题即可打开。

- **PDF 会上传到 MinerU 的服务器**，未公开的稿件请注意。Token 只保存在这台电脑的浏览器里，不会同步，也不进备份
- MinerU 的限制：单个文件不超过 200 MB、200 页；每个账号每天 1000 页高优先级额度，超出的部分排队更久
- 导入过程中可以关掉论文库，下次打开时继续（PDF 在导入期间暂存在扩展的 IndexedDB 里，导入完成或移除任务后删除）
- 同一个 PDF 只解析一次：论文 id 由 PDF 内容决定（`pdf-` + SHA-256 前 20 位），再次导入时直接打开已有的页面

## 图片

MinerU 输出的图片是按 200 dpi 左右截的 jpg，不够清晰。生成页面时所有的图都从原 PDF 里重新取（用 pdf.js，`src/import/pdf-figures.ts`）：

- **MinerU 截了图的**：结果 zip 里的 `layout.json`（`pdf_info[页].page_size` 和带 `image_path`、`bbox` 的 span）记录了每张截图所在的页和区域，没有时用 `*_content_list.json`（`page_idx`、`bbox`，0–1000）。在 PDF 里取同一块区域：区域里只有一张嵌入位图、没有别的文字和图形时直接取原图（无损 PNG）；否则（矢量图、多张位图拼成的图、位图旁边或上面有坐标轴、标注文字）把这块区域渲染成图片（至少 216 dpi，宽度一般在 1800 像素左右）。找不到截图位置、或者 PDF 里取不到时，用 MinerU 的截图
- **MinerU 漏掉的图**：MinerU 偶尔会把整张图当成文字区域：只 OCR 出图里的几行字（混进正文段落），不输出图片，Markdown 里只剩下 "Figure N:" 图注。这时按图注在 PDF 里找图：
  1. 在 PDF 的文字层里找到 "Figure N:" 图注所在的页和位置，判断它在哪一栏（跨栏的图注对应跨栏的图）
  2. 取图注上方（找不到再看下方）到最近的边界之间的区域。边界是：正文行（宽度接近栏宽、或跨出本栏）、其他图注 / 表注、带编号的节标题
  3. 从离图注最近的图形（位图、矢量路径）开始，把上下挨得近的图形和文字（坐标轴、图例、子图注）逐步并进来，离得远的（页眉、区域里别的内容）不算
  4. 结果只有一张嵌入位图时取原图，否则渲染这块区域

  补不回来的图仍然只显示图注和一个虚线框。

导入完成的提示里会说明补回了几张图、还有几张没能识别、几张没能从 PDF 中取出（用的是 MinerU 的截图）。从 PDF 取的图是 PNG，页面文件比用 MinerU 的 jpg 时大。

限制：混进正文的那几行 OCR 文字不会去掉；扫描版 PDF 没有文字层，找不到图注，不会补图（MinerU 截了图的仍然按区域取）；早期版本创建、没有暂存 PDF 的导入任务只能用 MinerU 的截图。

pdf.js 的数据文件（未嵌入的标准字体、中日韩字体的 CMap、JPEG 2000 / JBIG2 解码器，约 3.8 MB）在构建时复制到扩展的 `pdfjs/` 目录（`wxt.config.ts` 的 `build:publicAssets`），只在用到时加载。测试：`tests/pdf-figures.test.ts`（合成的页面布局、截图位置的解析），`FIGURE_PDF=paper.pdf FIGURE_NUMBERS=1,2 npm test`（真实 PDF 按图注找图，Node 里只能测嵌入位图的图）。

## 引用链接

### 文献引用

MinerU 输出的引用只是普通文字。生成页面时把正文、图注、表格、伪代码里的引用认出来，和 arXiv HTML 一样换成指向参考文献的链接（`<cite class="ltx_cite"><a class="ltx_ref" href="#bib.bibN">`，`src/import/citations.ts`）。点击跳到参考文献条目（条目高亮），鼠标悬停显示条目全文：

- **数字引用**：`[3]`、`[1, 4–6]`。只在参考文献条目带 `[N]` / `N.` 编号时识别，编号必须都在参考文献里（`[0, 1]` 这类区间不算）
- **作者-年份引用**：`(Liu et al., 2024a)`、`(e.g., Chen et al., 2024; Zhang et al., 2025a;c)`、`Chen et al. (2026)`、`(Giorlandino & Goldt, 2026)`。第一作者的姓要出现在条目开头（第一个逗号 / and 之前），年份要出现在条目里；同一作者同一年有多篇时按年份后的字母区分（条目里印着字母时按字母配，没印时按条目顺序，a 是第一篇）

配不上任何条目的不加链接，原样作为文字。上标形式的数字引用（和脚注分不开）、被斜体等标签拆开的引用不识别。

### 图、表、节、公式、定理

对文档里其他部分的引用也换成链接（`<a class="ltx_ref" href="#S2.F1">Figure 1</a>`，`src/import/crossrefs.ts`），在正文、图注、表格里识别：

- 图 `Figure 3`、`Fig. 3`，子图 `Figure 9(b)`（链到子图；没有这个子图时链到整个图）；表 `Table 2`、`Tab. 2`；算法 `Algorithm 1`
- 节 `Section 4.1`、`Sec. 4`、`§4`，附录 `Appendix B`、`App. B.2`
- 公式 `Eq. (2)`、`Equation 2`（公式要有 `\tag` 编号）
- 定理类 `Theorem 1`、`Lemma 2`、`Proposition`、`Corollary`、`Definition`、`Assumption` 等：链到以 "Theorem 1 (…)." 开头的段落
- 复数后面的多个编号：`Figures 3 and 4`、`Tables 1–3`、`Theorems 1 and 2`。单数不往后接（"Table 2, 3 methods" 里的 3 不算）

编号要在文档里存在，否则不加链接；重复的编号链到第一个。引用所在的元素自身不加链接（定理标题、图注里提到自己的图）。整篇渲染完再加链接，所以引用后面才出现的图表也能链上。

转换规则版本 5 之前导入的论文没有这些链接，要有的话需要从论文库移除后重新导入（笔记会随论文一起删除）。

## 目录

导入论文的页面左侧有和 arXiv HTML 一样的目录：摘要、各级节、参考文献、附录，点击跳转，跟随滚动高亮当前所在的节并展开它的子节（带三角的条目也可以手动展开 / 收起）。

- 窗口够宽（1220 像素以上）时停靠在左侧，正文往右让出位置；点目录右上角的箭头收起，收起后左上角留一个按钮。收起状态记在本机，所有导入论文共用
- 窗口较窄时只显示左上角的按钮，点开后目录浮在页面上，选了条目、点页面其他地方或按 Esc 时关闭

目录由内容脚本在打开页面时从节结构生成（`src/content/toc.ts`），不写进页面文件，所以之前导入的论文也有目录，页面文件本身不变。目录放在 `<article>` 之外的 Shadow DOM 里，标记了 `notranslate`：不影响划线定位，也不会被翻译插件翻译（显示原文标题）。只在导入的论文上显示，arXiv 页面用它自带的目录。

## 页面保存在哪里

翻译插件不能在其他扩展的页面（`chrome-extension://`）里工作，但可以在本地文件（`file://`）上工作，所以论文页面以本地文件的形式打开：

- 生成的 HTML 是单个文件，图片内嵌，不依赖网络。权威副本存在扩展的 IndexedDB 里
- 打开时写到 **"下载/arxiv-html-helper/"** 文件夹（`chrome.downloads`），再以 `file://` 打开。这个文件被删除或移走后，下次打开会从 IndexedDB 重新写出
- 从论文库移除这篇论文时，IndexedDB 里的页面和下载文件夹里的文件一起删除
- 内容脚本会注入所有 `file://` 页面，但只在 `<head>` 里有 `<meta name="ahh-paper-id" content="pdf-…">` 的页面上启用

**页面一经生成不再改变**：划线定位依赖页面的结构和文字，所以即使以后转换规则改进了，已导入的论文也不会重新生成。页面里的 `<meta name="generator">` 记录了生成时的转换规则版本。

## 云同步

导入论文的笔记、分组、标记和其他论文一样同步。论文页面本身还不同步：在另一台电脑上能看到这篇论文和笔记，但要打开页面需要在那台电脑上也导入同一个 PDF。

论文库的元数据里记录了页面的 SHA-256 和导入时间（`meta:<id>` 的 `doc` 字段）。两台电脑各自导入过同一个 PDF 时（MinerU 两次的结果可能略有不同），同步后以**先导入的一份**为准。

## 实现

```
src/import/
  mineru-api.ts  MinerU 精准解析 API（v4）：申请上传地址 → PUT 上传 → 轮询 → 下载 zip
  jobs.ts        导入任务：状态存在 chrome.storage.local（import:job:<id>），Web Locks 保证只有一个标签页在处理
  bundle.ts      结果 zip → 单文件 HTML（解析 full.md 和截图位置，图片从原 PDF 取、内嵌为 data: URL）
  pdf-figures.ts 从原 PDF 找图：定位（纯函数）、取原图编码 PNG、渲染区域
  pdf-loader.ts  在论文库页里加载 pdf.js（worker、数据文件地址）
  mineru.ts      MinerU Markdown 的解析，见 README
  citations.ts   识别正文里的文献引用、对应到参考文献条目
  crossrefs.ts   识别对图、表、节、公式、定理的引用
  latexml.ts     渲染成 arXiv（LaTeXML）结构
  page.ts        完整页面：样式、<html lang>、论文 id
  docs.ts        IndexedDB：页面 HTML 和本地文件的位置；导入期间暂存的 PDF
  local-file.ts  写出本地文件、以 file:// 打开
```

权限：`downloads` 是可选权限，导入时才申请；MinerU 接口（`mineru.net`）、上传地址（阿里云 OSS）、结果 CDN（`cdn-mineru.openxlab.org.cn`）的访问权限同样在导入时申请。MinerU 改了上传或结果的域名时，导入会失败并提示"允许访问并重试"。

上传时请求体用 `ArrayBuffer` 而不是 `File`：传 `File` / `Blob` 时浏览器会自动加上 `Content-Type: application/pdf`，而 MinerU 的预签名上传地址要求不带 Content-Type。
