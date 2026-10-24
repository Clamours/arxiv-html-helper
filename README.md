# arXiv HTML Helper

Chrome 扩展：在 arXiv HTML 论文页（`arxiv.org/html/…`、ar5iv）上划线、高亮、写笔记。原文和沉浸式翻译 / 陪读蛙显示的译文都可以划。

项目主页：<https://clamours.github.io/arxiv-html-helper/> · [隐私政策](https://clamours.github.io/arxiv-html-helper/privacy.html)

## 安装

推荐从 [Chrome 应用商店](https://chromewebstore.google.com/detail/hckjdjhkldddjpaecpkpicfmpfggpfie) 安装，可以自动更新。

### 从 GitHub 安装

访问不了 Chrome 应用商店时，可以用 [Releases](https://github.com/Clamours/arxiv-html-helper/releases) 里的 zip：

1. 下载最新版本的 `arxiv-html-helper-<版本>.zip`，解压到一个固定的文件夹（之后不要删除或移动）
2. 打开 `chrome://extensions`，开启右上角的"开发者模式"
3. 点"加载已解压的扩展程序"，选择这个文件夹

这个包和商店版代码相同、扩展 ID 相同，但不会自动更新：

- **升级**：清空原文件夹，解压新版本进去，再在 `chrome://extensions` 点扩展卡片上的刷新按钮，笔记都会保留。不要点"移除"，移除会删掉扩展的数据
- **换成商店版**：两者 ID 相同，不能同时安装。先在论文库导出备份（或开启云同步），移除 GitHub 版，从商店安装后再导入

## 使用

```bash
npm install
npm run dev      # 启动开发模式，自动打开一个装好扩展的 Chrome
npm run build    # 产物在 .output/chrome-mv3，可在 chrome://extensions "加载已解压的扩展程序"
npm run zip      # 打包上传 Chrome 应用商店（不含 manifest 的 key）
npm run zip:github  # GitHub Release 包（带 key，需要 .env.local 里的 EXTENSION_KEY），平时由 CI 构建
npm test
```

`dev` 和 `build` 出的是开发版：名字带 "(Dev)"、图标是蓝色封面，和商店安装的正式版（红色封面）装在一起也分得清。`zip` 和 `zip:github` 出的是正式版，分别构建到 `.output/chrome-mv3-store` 和 `.output/chrome-mv3-github`，不影响本地加载的 `.output/chrome-mv3`。

### 发布新版本

1. 改 `package.json` 的 `version`，提交
2. `npm run zip`，把 `.output/arxiv-html-helper-<版本>-chrome.zip` 上传到 Chrome 应用商店开发者后台并提交审核
3. 打 tag 并推送：`git tag -a v<版本> -m "<版本>" && git push origin main v<版本>`。[release.yml](.github/workflows/release.yml) 会检查 tag 与 `version` 一致、跑测试、构建带 key 的包并创建 GitHub Release

构建配置放在 `.env.local`（参照 `.env.example`）：`EXTENSION_KEY` 用来固定扩展 ID，`GOOGLE_CLIENT_ID` 用来启用 Google Drive 同步。两项都可以不填，详见 [docs/sync.md](docs/sync.md)。

- 选中文字后会弹出工具栏：点颜色直接高亮，点"笔记"高亮并打开编辑框
- 点击已有的高亮可以改颜色、写笔记、删除
- 点击工具栏里的扩展图标打开侧边栏：按文档顺序列出所有笔记，点击跳转，可导出 Markdown
- 侧边栏顶部会显示当前论文所在的分组（可加入 / 移出、标记）和检测到的译文段落数（用来判断适配器是否生效）
- **译文存档**：翻译插件显示过的译文会按段落自动存档。之后打开这篇论文时，有存档的段落始终显示存档的译文：不开翻译插件、换一台电脑、插件重新翻译出不同措辞时都不变，译文层笔记也就不会漂移。侧边栏可以隐藏存档（本机设置）或清除本篇的存档（清除后会重新存档当前显示的译文）。详见 [docs/saved-translations.md](docs/saved-translations.md)
- 侧边栏右上角的"论文库"会打开一个新标签页，列出所有浏览过的论文（标题、作者、年份从 arXiv API 自动获取）：可按最近笔记 / 最近打开 / 最近加入 / 笔记数 / 标题排序，搜索标题、作者、id、划线和笔记内容，复制 Markdown 或从论文库移除
- **分组**：一篇论文可以属于多个分组（相当于标签）。浏览过的论文自动加入论文库，默认不属于任何分组。左侧栏按 全部 / 已标记 / 未分组 / 各分组 筛选；分组可以新建、重命名、改颜色、删除，或把整个分组的笔记复制为 Markdown
- 论文库右上角可以**导出备份 / 导入备份**：导出为一个 JSON 文件（全部论文、划线、笔记、分组和标记，含译文层）；导入时先预览，笔记按 id 合并、保留修改时间较新的一份，论文的分组取两边的并集，只增不删，可用于换电脑迁移或定期备份
- **导入 PDF**：论文库右上角的"导入 PDF"用 MinerU 解析 PDF，生成和 arXiv HTML 结构相同的论文页面（以本地文件打开，翻译插件可用），同样可以划线、写笔记，左侧有和 arXiv 一样的目录。需要 MinerU Token，并在扩展详情页打开"允许访问文件网址"，详见 [docs/import.md](docs/import.md)
- **云同步**：论文库右上角的"云同步"可以通过 WebDAV（坚果云等）或 Google Drive 在多台电脑之间自动同步笔记、论文库、分组和译文存档，删除也会同步。设置方法和合并规则见 [docs/sync.md](docs/sync.md)

## 设计要点

- **不修改页面 DOM**：用 CSS Custom Highlight API 渲染高亮，不会干扰翻译插件，翻译插件重建 DOM 时也不会破坏高亮。
- **分层文本**：每条笔记属于原文层或译文层。原文层提取文本时跳过译文 wrapper，所以译文插入与否不影响原文偏移。
- **双重锚点**：每个片段记录块 key（LaTeXML id）、块内偏移，以及引文（exact + 前后各 32 字）。定位顺序是：偏移校验 → 精确搜索 → 模糊匹配 → 原文层全文搜索。
- **译文会变**：译文层笔记挂靠在对应的原文块上，并保存划线时的整段译文。关闭翻译时状态是 `waiting`；重新翻译后措辞略有变化时靠模糊匹配找回；完全找不到时是 `orphaned`，侧边栏仍然显示引文。
- **译文存档**：为了让译文本身不变，扩展把翻译插件的译文清洗后存档，再以自己的 wrapper 插回页面（这是唯一会修改页面 DOM 的地方）。存档被当作第三个"翻译插件"适配器，分层和定位逻辑不用改；存档显示时同一段里翻译插件的译文被隐藏。
- **适配器**：各翻译插件的差异都在 `src/adapters/index.ts` 的选择器配置里，详见 [docs/translators.md](docs/translators.md)。

## 目录

```
src/
  core/        与浏览器扩展无关的逻辑（可单测）
    blocks.ts    块的识别和稳定 key
    text.ts      DOM → 规范化文本的双向映射（空白折叠、公式视为整体）
    context.ts   分层：哪些节点是译文、译文属于哪个原文块
    anchor.ts    选区 ↔ 片段（describe / anchor / 模糊匹配）
    storage.ts   chrome.storage.local：paper:<id> 存笔记，meta:<id> 存标题、作者等，
                 shelf:<id> 存所属分组和标记，groups 存全部分组的定义，
                 tomb:<id> 和 groups-deleted 存删除记录（云同步用）
    library.ts   论文库的汇总、视图过滤、排序、搜索、Markdown 导出
    groups.ts    分组与标记的数据模型、导入时的合并规则
    arxiv-api.ts 从 arXiv 官方 API 批量获取标题、作者（论文库页调用）
    backup.ts    备份文件的生成、校验与合并规则
    tombstones.ts 删除记录
    sync.ts      云同步的数据模型与合并规则
    translations.ts 译文存档的数据模型、合并规则、HTML 清洗
  sync/        云同步：设置、WebDAV / Google Drive、同步流程（含译文存档）、background 里的调度
  translations/ 译文存档的本机存储（扩展的 IndexedDB）和 background 里的读写服务
  adapters/    翻译插件选择器
  import/      导入 PDF（见 docs/import.md）：MinerU 解析 → arXiv（LaTeXML）风格的 HTML → 本地文件
    mineru-api.ts MinerU 精准解析 API：上传、轮询、下载结果
    jobs.ts      导入任务的状态和流程
    bundle.ts    结果 zip → 单文件 HTML（图片内嵌）
    pdf-figures.ts 图片从原 PDF 取（pdf.js），含 MinerU 漏掉的图
    mineru.ts    解析 Markdown：按编号推断标题层级，把图片、子图注、图注 / 表注配对
    latexml.ts   渲染成 LaTeXML 结构（id、类名与 arXiv 一致），公式由 Temml 转成带 alttext 的 MathML
    page.ts      完整页面：样式、<html lang>、论文 id
    docs.ts      IndexedDB 里的论文页面
    local-file.ts 写到"下载"文件夹并以 file:// 打开
  content/     内容脚本：高亮渲染、浮动 UI、MutationObserver、译文存档的采集与显示、导入论文的目录
  shared/      侧边栏和论文库共用的主题、图标、弹出层、分组菜单
  entrypoints/ WXT 入口：content、background、sidepanel、library（论文库页，含导入 PDF 的界面）
scripts/capture-dom.js   在真实页面上抓取翻译插件的 DOM，用于核对选择器
scripts/mineru-to-html.ts  把 MinerU 导出的 Markdown 转成 HTML 文件（npm run mineru）
scripts/render-icons.sh    把 src/assets/icon.svg 导出为扩展图标（public/icon/）、开发版图标（src/assets/icon-dev/）和主页图标
site/                      项目主页和隐私政策，推送后由 GitHub Actions 部署到 GitHub Pages
```

## 用真实论文测试

```bash
curl -sL https://arxiv.org/html/1706.03762v7 -o /tmp/attn.html
ARXIV_HTML=/tmp/attn.html npm test
```

MinerU 导出的论文（Markdown 格式）：

```bash
MINERU_MD=/path/to/MinerU_markdown_xxx.md npm test          # 转换后做同样的往返测试
npm run mineru -- /path/to/MinerU_markdown_xxx.md out.html --embed   # 生成 HTML 文件查看效果；--embed 把图片内嵌
```

## 许可

[MIT](LICENSE)
