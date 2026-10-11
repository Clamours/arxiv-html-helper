# 导入 PDF

不在 arXiv 上、或者没有 HTML 版本的论文，可以导入 PDF：由 [MinerU](https://mineru.net) 解析，生成一个和 arXiv HTML 结构相同的论文页面，在上面划线、写笔记，并用沉浸式翻译 / 陪读蛙翻译。

## 使用

1. 在 [mineru.net](https://mineru.net/apiManage) 的 API 管理页面创建一个 Token（有效期 90 天，过期后换一个新的）
2. 在扩展详情页（`chrome://extensions` → 本扩展 → 详情）打开 **"允许访问文件网址"**
3. 论文库右上角点"导入 PDF"，填 Token，选择 PDF（可多选），点"开始导入"。第一次导入时 Chrome 会询问是否允许访问 MinerU 的服务器、管理下载内容，需要允许
4. 论文库顶部显示导入进度。解析通常要一到几分钟；完成后论文自动加入「待读」，并在新标签页打开

之后在论文库点论文标题即可打开。

- **PDF 会上传到 MinerU 的服务器**，未公开的稿件请注意。Token 只保存在这台电脑的浏览器里，不会同步，也不进备份
- MinerU 的限制：单个文件不超过 200 MB、200 页；每个账号每天 1000 页高优先级额度，超出的部分排队更久
- 导入过程中可以关掉论文库，下次打开时继续（PDF 在导入期间暂存在扩展的 IndexedDB 里，导入完成或移除任务后删除）
- 同一个 PDF 只解析一次：论文 id 由 PDF 内容决定（`pdf-` + SHA-256 前 20 位），再次导入时直接打开已有的页面

## MinerU 漏掉的图

MinerU 偶尔会把整张图当成文字区域：只 OCR 出图里的几行字（混进正文段落），不输出图片，Markdown 里只剩下 "Figure N:" 图注。生成页面时会从原 PDF 里把这些图补回来（用 pdf.js，`src/import/pdf-figures.ts`）：

1. 在 PDF 的文字层里找到 "Figure N:" 图注所在的页和位置，判断它在哪一栏（跨栏的图注对应跨栏的图）
2. 取图注上方（找不到再看下方）到最近的边界之间的区域。边界是：正文行（宽度接近栏宽、或跨出本栏）、其他图注 / 表注、带编号的节标题
3. 从离图注最近的图形（位图、矢量路径）开始，把上下挨得近的图形和文字（坐标轴、图例、子图注）逐步并进来，离得远的（页眉、区域里别的内容）不算
4. 结果只有一张嵌入位图时，直接取 PDF 里的原图（无损 PNG，通常比 MinerU 截的图清晰）；否则把这块区域渲染成图片（矢量图、多张位图拼成的图）

补不回来的图仍然只显示图注和一个虚线框。导入完成的提示里会说明补回了几张、还有几张没能识别。

限制：混进正文的那几行 OCR 文字不会去掉；扫描版 PDF 没有文字层，找不到图注，不会补图。

pdf.js 的数据文件（未嵌入的标准字体、中日韩字体的 CMap、JPEG 2000 / JBIG2 解码器，约 3.8 MB）在构建时复制到扩展的 `pdfjs/` 目录（`wxt.config.ts` 的 `build:publicAssets`），只在用到时加载。测试：`tests/pdf-figures.test.ts`（合成的页面布局），`FIGURE_PDF=paper.pdf FIGURE_NUMBERS=1,2 npm test`（真实 PDF，Node 里只能测嵌入位图的图）。

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
  bundle.ts      结果 zip → 单文件 HTML（解析 full.md，图片内嵌为 data: URL，补回 MinerU 漏掉的图）
  pdf-figures.ts 从原 PDF 找图：定位（纯函数）、取原图编码 PNG、渲染区域
  pdf-loader.ts  在论文库页里加载 pdf.js（worker、数据文件地址）
  mineru.ts      MinerU Markdown 的解析，见 README
  latexml.ts     渲染成 arXiv（LaTeXML）结构
  page.ts        完整页面：样式、<html lang>、论文 id
  docs.ts        IndexedDB：页面 HTML 和本地文件的位置；导入期间暂存的 PDF
  local-file.ts  写出本地文件、以 file:// 打开
```

权限：`downloads` 是可选权限，导入时才申请；MinerU 接口（`mineru.net`）、上传地址（阿里云 OSS）、结果 CDN（`cdn-mineru.openxlab.org.cn`）的访问权限同样在导入时申请。MinerU 改了上传或结果的域名时，导入会失败并提示"允许访问并重试"。

上传时请求体用 `ArrayBuffer` 而不是 `File`：传 `File` / `Blob` 时浏览器会自动加上 `Content-Type: application/pdf`，而 MinerU 的预签名上传地址要求不带 Content-Type。
