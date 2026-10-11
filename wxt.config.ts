import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'wxt';

/**
 * pdf.js 的数据文件（导入 PDF 时从原 PDF 补图要用，见 src/import/pdf-loader.ts）：
 * 未嵌入的标准字体、中日韩字体的 CMap、JPEG 2000 / JBIG2 / ICC 解码器。只在用到时加载
 */
const PDFJS_DATA: [dir: string, keep: (file: string) => boolean][] = [
  ['standard_fonts', () => true],
  ['cmaps', () => true],
  ['wasm', (f) => !f.startsWith('quickjs')],
];

/**
 * 构建时从 .env.local 读取（见 .env.example 和 docs/sync.md）：
 * - EXTENSION_KEY：Chrome 应用商店给的公钥。本地"加载已解压的扩展程序"时让扩展 ID 与商店版一致，
 *   这样 Google OAuth 客户端两边通用，从本地版换成商店版时数据也还在。商店不接受带 key 的包，
 *   所以 `npm run zip`（STORE_BUILD=1）时不写入
 * - GOOGLE_CLIENT_ID：Google Drive 同步用的 OAuth 客户端 ID；不填时同步设置里不提供 Google Drive
 */
export default defineConfig({
  srcDir: 'src',
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      const root = resolve('node_modules/pdfjs-dist');
      for (const [dir, keep] of PDFJS_DATA) {
        for (const file of readdirSync(join(root, dir)).filter(keep)) {
          files.push({ absoluteSrc: join(root, dir, file), relativeDest: `pdfjs/${dir}/${file}` });
        }
      }
    },
  },
  manifest: () => {
    const key = process.env.EXTENSION_KEY?.trim();
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const forStore = process.env.STORE_BUILD === '1';
    return {
      name: 'arXiv HTML 划线笔记',
      description: '在 arXiv HTML 页面上划线、高亮、做笔记，支持沉浸式翻译 / 陪读蛙的译文。',
      permissions: ['storage', 'unlimitedStorage', 'sidePanel', 'alarms', ...(clientId ? ['identity'] : [])],
      // 论文库从 arXiv API 获取标题和作者
      host_permissions: ['https://export.arxiv.org/*'],
      // 云同步：开启时只申请所填 WebDAV 服务器（或 Google Drive 接口）的访问权限；
      // 导入 PDF：开始导入时申请 MinerU 接口、上传地址和结果 CDN 的访问权限
      optional_host_permissions: ['https://*/*', 'http://*/*'],
      // 导入 PDF：把生成的论文页面保存为本地文件（导入时才申请）
      optional_permissions: ['downloads'],
      ...(clientId ? { oauth2: { client_id: clientId, scopes: ['https://www.googleapis.com/auth/drive.appdata'] } } : {}),
      ...(key && !forStore ? { key } : {}),
      action: { default_title: '打开笔记侧边栏' },
    };
  },
});
