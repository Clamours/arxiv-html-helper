# 云同步

在论文库右上角点"云同步"，选择存储位置：

- **WebDAV**：坚果云、Nextcloud、群晖等。填服务器地址、用户名、密码即可，不需要额外配置，国内网络可用
- **Google Drive**：用 Chrome 登录的 Google 账号授权。需要先在构建时配置 OAuth 客户端（见下文），网络要能访问 Google

两台电脑选同一个存储（同一个 WebDAV 账号和文件夹，或同一个 Google 账号）就会互相同步。

## 何时同步

- 本机有改动（划线、笔记、分组、标记、删除）后几秒自动上传
- 按设置的间隔（默认 5 分钟）检查其他电脑的改动
- 浏览器启动、打开论文库、打开论文页时检查一次（半分钟内同步过则跳过）
- 同步设置里点"保存并同步"

两台电脑同时开着时，一边的改动通常在几秒到一个检查间隔之内出现在另一边。

## 合并规则

笔记、论文库和分组在一个文件 `arxiv-notes-sync.json` 里。它就是备份文件的格式，可以直接下载下来用"导入备份"导入。每次同步：下载 → 与本地合并 → 写回本地和云端。

译文存档比笔记大得多，单独存放：每篇论文一个 `arxiv-notes-tr-<论文 id>.json`，另有索引 `arxiv-notes-translations.json`，同步时只下载有变化的论文。合并规则见 [saved-translations.md](saved-translations.md)。

- 同一条笔记、同一个分组、同一篇论文的分组和标记：保留修改时间较新的一份
- 删除也会同步：删除笔记、从论文库移除论文、删除分组时会记下删除时间（`tomb:<paperId>`、`groups-deleted`）。删除之后另一台电脑又改过的内容会保留
- 两台电脑各自新建的同名分组合并为一个
- 删除记录保留半年。一台电脑超过半年没同步过，它上面已经在别处删掉的内容可能会被同步回来
- 修改时间取各台电脑的本地时钟，电脑时间相差很大时"较新"的判断可能不准

手动"导入备份"仍然只增不删。导入时如果恢复了本机删除过的内容，这些内容的修改时间会改成导入时间，避免同步时又被删掉。

实现：合并规则在 `src/core/sync.ts`、`src/core/tombstones.ts`，同步流程在 `src/sync/engine.ts`（译文存档在 `src/sync/translations.ts`），调度在 `src/sync/service.ts`（background）。

## WebDAV（以坚果云为例）

1. 登录坚果云网页版 → 右上角账户名 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用，生成一个**应用密码**
2. 在同步设置里填：
   - 服务器地址：`https://dav.jianguoyun.com/dav/`
   - 用户名：坚果云登录邮箱
   - 密码：上一步生成的应用密码
   - 文件夹：默认 `arxiv-html-helper`，不存在时会自动创建
3. 点"保存并同步"。Chrome 会询问是否允许访问该服务器，需要允许

密码以明文保存在本机的 `chrome.storage.local` 里，不会上传，也不会进备份文件。

坚果云免费版对 WebDAV 有请求频率限制（每 30 分钟数百次），按默认设置使用远远达不到。

## Google Drive

数据放在 Google Drive 的应用专用文件夹（appDataFolder）里。用户在云端硬盘里看不到它，扩展也只能访问这个文件夹（`drive.appdata` 权限）。授权通过 `chrome.identity.getAuthToken` 完成，所以只能在 Chrome 里用，Edge 等其他浏览器不支持。

### 一次性配置（开发者）

OAuth 客户端绑定扩展 ID，所以要先固定扩展 ID（见下一节）。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，新建一个项目
2. API 和服务 → 库 → 启用 **Google Drive API**
3. API 和服务 → OAuth 同意屏幕（Google Auth Platform）：
   - 用户类型选"外部"，填应用名称、支持邮箱
   - 数据访问 → 添加范围 `https://www.googleapis.com/auth/drive.appdata`
   - 发布前处于"测试"状态，只有加入"测试用户"的 Google 账号能授权，自己用时把自己的账号加进去即可
4. API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID，应用类型选 **Chrome 扩展程序**，"项目 ID"（Item ID）填扩展 ID
5. 把得到的客户端 ID 填进 `.env.local` 的 `GOOGLE_CLIENT_ID`，重新 `npm run build`

公开发布给其他人用时，需要在 OAuth 同意屏幕里把应用发布为"正式版"。`drive.appdata` 不属于受限范围（restricted scope），不需要第三方安全评估，但 Google 仍可能要求完成应用验证（填写隐私政策链接等）。

## 固定扩展 ID 与发布到 Chrome 应用商店

"加载已解压的扩展程序"时，扩展 ID 由目录路径决定，换台电脑或换个目录 ID 就会变。这会带来两个问题：

- Google OAuth 客户端绑定的是扩展 ID，ID 变了 Google Drive 就无法授权
- 每个扩展 ID 的 `chrome.storage.local` 是分开的，以后从本地版换成商店版，本地数据不会自动带过去

解决办法是让本地版和商店版用同一个 ID：

1. 注册 [Chrome 应用商店开发者账号](https://chrome.google.com/webstore/devconsole)（一次性费用 5 美元）
2. `npm run zip` 生成 `.output/*-chrome.zip`，在开发者后台"新建项"上传。只需上传，不必提交审核，此时就已经分配好正式的扩展 ID
3. 在该项的"软件包"页点"查看公钥"，把 `-----BEGIN PUBLIC KEY-----` 和 `-----END PUBLIC KEY-----` 之间的内容合成一行，填进 `.env.local` 的 `EXTENSION_KEY`
4. `npm run build`，在两台电脑上重新加载 `.output/chrome-mv3`。扩展 ID 应该和商店后台显示的一致
5. 用这个 ID 创建上一节的 OAuth 客户端

注意：

- 改变扩展 ID 相当于换了一个新扩展，本地数据不会带过去。启用 `EXTENSION_KEY` 之前，先用旧版导出备份，在新 ID 的扩展里导入。开启云同步之后，换 ID、换电脑都只要重新连上同一个存储就行
- 商店不接受 manifest 里带 `key` 的包。`npm run zip` 会设置 `STORE_BUILD=1`，自动去掉 `key`；`GOOGLE_CLIENT_ID` 照常写入
- 提交审核时需要说明权限用途：`alarms` 用于定时同步；`identity` 用于 Google Drive 授权；`optional_host_permissions` 用于访问用户自己填写的 WebDAV 服务器和 Google Drive 接口，开启同步时才向用户申请，以及导入 PDF 时访问 MinerU 的接口、上传地址和结果 CDN；`downloads`（可选权限）用于把导入 PDF 生成的论文页面保存为本地文件；内容脚本匹配 `file:///*` 是为了在这些本地论文页面上划线（只在带论文 id 的页面上启用），见 [import.md](import.md)
- 隐私说明：数据只存在本机和用户自己选择的 WebDAV 或 Google Drive 里，扩展没有自己的服务器
