# 开发指南

扩展用 [WXT](https://wxt.dev) 和 TypeScript 开发，界面是原生 DOM，没有用前端框架。

## 常用命令

```bash
npm install
npm run dev      # 启动开发模式，自动打开一个装好扩展的 Chrome
npm run build    # 产物在 .output/chrome-mv3，可在 chrome://extensions "加载已解压的扩展程序"
npm run zip      # 打包上传 Chrome 应用商店（不含 manifest 的 key）
npm run zip:github  # GitHub Release 包（带 key，需要 .env.local 里的 EXTENSION_KEY），平时由 CI 构建
npm run screenshots  # 重新生成商店截图和主页配图（需要 macOS 和 Chrome），见 store-listing.md
npm run compile  # 类型检查
npm test
```

`dev` 和 `build` 出的是开发版：名字带 "(Dev)"、图标是蓝色封面，和商店安装的正式版（红色封面）装在一起也分得清。`zip` 和 `zip:github` 出的是正式版，分别构建到 `.output/chrome-mv3-store` 和 `.output/chrome-mv3-github`，不影响本地加载的 `.output/chrome-mv3`。

构建配置放在 `.env.local`（参照 `.env.example`）：`EXTENSION_KEY` 用来固定扩展 ID，`GOOGLE_CLIENT_ID` 用来启用 Google Drive 同步。两项都可以不填，详见 [sync.md](sync.md)。

## 用真实论文测试

单元测试在 `tests/`。下面几组测试要用到不入库的真实文件，没有提供时会跳过：

```bash
curl -sL https://arxiv.org/html/1706.03762v7 -o /tmp/attn.html
ARXIV_HTML=/tmp/attn.html npm test   # 在真实的 arXiv 页面上划线、定位的往返测试
```

MinerU 导出的论文（Markdown 格式）和 PDF：

```bash
MINERU_MD=/path/to/MinerU_markdown_xxx.md npm test          # 转换后做同样的往返测试
npm run mineru -- /path/to/MinerU_markdown_xxx.md out.html --embed   # 生成 HTML 文件查看效果；--embed 把图片内嵌
FIGURE_PDF=/path/to/paper.pdf FIGURE_NUMBERS=1,2 npm test   # 从 PDF 补图（只检查嵌入位图的图）
```

## 发布新版本

1. 改 `package.json` 的 `version`，提交
2. `npm run zip`，把 `.output/arxiv-html-helper-<版本>-chrome.zip` 上传到 Chrome 应用商店开发者后台并提交审核。界面有变化时，先用 `npm run screenshots` 更新截图，一起上传。商店各项资料见 [store-listing.md](store-listing.md)
3. 打 tag 并推送：`git tag -a v<版本> -m "<版本>" && git push origin main v<版本>`。[release.yml](../.github/workflows/release.yml) 会检查 tag 与 `version` 一致、跑测试、构建带 key 的包并创建 GitHub Release

`site/` 下的项目主页推送到 main 后由 [pages.yml](../.github/workflows/pages.yml) 部署到 GitHub Pages。README 和主页用的是 `site/img/` 里的截图，同样由 `npm run screenshots` 生成。

## 设计要点

- **不修改页面 DOM**：用 CSS Custom Highlight API 渲染高亮，不会干扰翻译插件，翻译插件重建 DOM 时也不会破坏高亮。
- **分层文本**：每条笔记属于原文层或译文层。原文层提取文本时跳过译文 wrapper，所以译文插入与否不影响原文偏移。
- **双重锚点**：每个片段记录块 key（LaTeXML id）、块内偏移，以及引文（exact + 前后各 32 字）。定位顺序是：偏移校验 → 精确搜索 → 模糊匹配 → 原文层全文搜索。
- **译文会变**：译文层笔记挂靠在对应的原文块上，并保存划线时的整段译文。关闭翻译时状态是 `waiting`；重新翻译后措辞略有变化时靠模糊匹配找回；完全找不到时是 `orphaned`，侧边栏仍然显示引文。
- **译文存档**：为了让译文本身不变，扩展把翻译插件的译文清洗后存档，再以自己的 wrapper 插回页面（这是唯一会修改页面 DOM 的地方）。存档被当作第三个"翻译插件"适配器，分层和定位逻辑不用改；存档显示时同一段里翻译插件的译文被隐藏。详见 [saved-translations.md](saved-translations.md)
- **适配器**：各翻译插件的差异都在 `src/adapters/index.ts` 的选择器配置里，详见 [translators.md](translators.md)。

## 代码结构

```
src/
  core/          数据模型和纯逻辑，不调用扩展 API，在 jsdom 里单测。
                 例外：storage.ts 读写 chrome.storage.local，arxiv-api.ts 请求 arXiv API
    定位           blocks.ts（块和稳定 key）→ text.ts（DOM ↔ 规范化文本）→ context.ts（原文层 / 译文层）
                   → anchor.ts（选区 ↔ 片段，模糊匹配）
    数据           types.ts（笔记、片段、颜色）、paper.ts（论文 id、元数据、阅读页网址）、
                   messages.ts（各页面、background、内容脚本之间的消息）
    存储           storage.ts：paper:<id> 存笔记，meta:<id> 存标题、作者、摘要等，shelf:<id> 存所属分组、标记和评分，
                   note:<id> 存论文笔记，groups 存全部分组的定义，tomb:<id> 和 groups-deleted 存删除记录（云同步用）
    论文库         library.ts（汇总、过滤、排序、搜索、论文笔记）、groups.ts（分组、标记、评分）、citation.ts（BibTeX）
    合并规则       sync.ts（云同步）、backup.ts（备份）、tombstones.ts（删除记录）、
                   translations.ts（译文存档，含 HTML 清洗）、docs.ts（导入论文的页面）
  content/       内容脚本：app.ts 把各部分串起来；highlighter.ts 渲染高亮，ui.ts 是划词工具栏和笔记编辑框，
                 translations.ts 采集、显示译文存档，toc.ts 是导入论文的目录，reader.ts 把论文填进阅读页
  adapters/      翻译插件的选择器（见 translators.md）
  translations/  译文存档的本机存储（IndexedDB）和 background 里替内容脚本读写的服务
  import/        导入 PDF：MinerU 解析 → arXiv（LaTeXML）风格的 HTML。各文件的分工见 import.md
  imported/      导入论文的本机存储（IndexedDB，也暂存导入中的 PDF），以及在阅读页里打开论文
  sync/          云同步：设置、WebDAV / Google Drive、同步流程、background 里的调度
  shared/        侧边栏、论文库和内容脚本共用的界面：主题、图标、色块、弹出层、分组菜单、评分、复制引用
  entrypoints/   WXT 入口：content、background、sidepanel、library（论文库页，含详情面板和同步、备份、导入 PDF 的界面）
tests/                     单元测试（Vitest + jsdom），fixtures/ 是测试用的页面和 API 响应
scripts/capture-dom.js     在真实页面上抓取翻译插件的 DOM，用于核对选择器
scripts/mineru-to-html.ts  把 MinerU 导出的 Markdown 转成 HTML 文件（npm run mineru）
scripts/render-icons.sh    把 src/assets/icon.svg 导出为扩展图标（public/icon/）、开发版图标（src/assets/icon-dev/）、主页图标和商店宣传图
scripts/screenshots/       生成商店截图（store/screenshots/）和主页配图（site/img/）（npm run screenshots）
site/                      项目主页、隐私政策和导入论文的阅读页，推送后由 GitHub Actions 部署到 GitHub Pages
store/                     Chrome 应用商店的截图、宣传图和 Google OAuth 同意屏幕的徽标（都要手动上传）
```

依赖方向：`core/` 不依赖其他目录；`shared/` 只依赖 `core/`；`content/`、`sync/`、`translations/`、`import/`、`imported/` 在中间；`entrypoints/` 在最上层。

译文存档和导入论文的页面体积大，不放在 chrome.storage.local，都分三层：`core/` 里的数据模型和合并规则（`translations.ts`、`docs.ts`）→ 本机的 IndexedDB 存储（`translations/db.ts`、`imported/db.ts`）→ 云同步（`sync/translations.ts`、`sync/docs.ts`）。

## 其他文档

- [translators.md](translators.md)：翻译插件的 DOM 结构，以及怎样核对适配器的选择器
- [saved-translations.md](saved-translations.md)、[sync.md](sync.md)、[import.md](import.md)：各功能的行为和实现
- [store-listing.md](store-listing.md)：Chrome 应用商店的上架资料、权限说明和截图
