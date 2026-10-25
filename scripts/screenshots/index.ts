/**
 * 生成 Chrome 应用商店截图（store/screenshots/）和项目主页的配图（site/img/）：
 *   npm run screenshots                构建商店版扩展，截图，再合成
 *   npm run screenshots -- --compose   不重新截图，只按 store/screenshots.html 重新合成（改了标题时用）
 *
 * 截图在联网打开的 arxiv.org 论文页上现场操作扩展，见 capture.ts；侧边栏、论文库用示例数据，见 fixtures.ts。
 * 需要 macOS（用 sips 缩小图片）和 Google Chrome（可以用环境变量 CHROME 指定路径）。中间文件在 .output/screenshots/
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from './capture';
import { launchChrome, serve, type Page } from './cdp';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** 用单独的 mode 构建，不覆盖其他构建产物 */
const BUILD = join(ROOT, '.output/chrome-mv3-screenshots-store');
const OUT = join(ROOT, '.output/screenshots');
const RAW = join(OUT, 'raw');

/** 主页配图：名称 → 从左到右拼起来的截图，第二张起是侧边栏 */
const SITE_IMAGES: Record<string, string[]> = {
  hero: ['site-hero-page', 'site-hero-panel'],
  translation: ['site-translation'],
  library: ['site-library'],
};

if (process.platform !== 'darwin') {
  console.error('需要 macOS：缩小商店截图用的是 sips');
  process.exit(1);
}
const composeOnly = process.argv.includes('--compose');
if (composeOnly && !existsSync(RAW)) {
  console.error('还没有截图，先运行一次 npm run screenshots');
  process.exit(1);
}
if (!composeOnly) build();

const server = await serve({ '/repo/': ROOT, '/': BUILD });
const profile = join(OUT, 'chrome-profile');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const browser = await launchChrome(profile);
try {
  if (!composeOnly) {
    rmSync(RAW, { recursive: true, force: true });
    mkdirSync(RAW, { recursive: true });
    const manifest: unknown = JSON.parse(readFileSync(join(BUILD, 'manifest.json'), 'utf8'));
    for (const theme of ['light', 'dark'] as const) {
      console.log(`截图（${theme === 'light' ? '浅色' : '深色'}）…`);
      await capture({ browser, origin: server.origin, buildDir: BUILD, rawDir: RAW, manifest }, theme);
    }
  }
  const page = await browser.newPage('合成');
  await composeStore(page);
  await composeSite(page);
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

/** 商店版构建：正式的名称和红色图标 */
function build(): void {
  console.log('构建扩展…');
  const r = spawnSync(join(ROOT, 'node_modules/.bin/wxt'), ['build', '--mode', 'screenshots'], {
    cwd: ROOT,
    env: { ...process.env, STORE_BUILD: '1' },
    encoding: 'utf8',
  });
  if (r.status !== 0 || !existsSync(join(BUILD, 'manifest.json'))) {
    process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    console.error('构建失败');
    process.exit(1);
  }
}

/** 商店截图：按 store/screenshots.html 的版式以 2 倍渲染，再用 sips 缩小到 1280×800 */
async function composeStore(page: Page): Promise<void> {
  console.log('合成商店截图…');
  const template = `${server.origin}/repo/store/screenshots.html`;
  const big = join(OUT, 'store-2x');
  mkdirSync(big, { recursive: true });
  await page.viewport(1280, 800);
  await page.goto(template);
  const names = await page.evaluate<string[]>('Object.keys(SHOTS)');
  for (const name of names) {
    await page.goto(`${template}?shot=${name}`);
    await checkImages(page);
    await page.screenshot(join(big, `${name}.png`));
    const file = `store/screenshots/${name}.png`;
    execFileSync('sips', ['-z', '800', '1280', join(big, `${name}.png`), '--out', join(ROOT, file)], { stdio: 'ignore' });
    console.log(`  ${file}`);
  }
}

/** 主页配图：浅色、深色各一张，2 倍像素的 WebP。拼图的页面写到 .output/screenshots/site/ 再打开 */
async function composeSite(page: Page): Promise<void> {
  console.log('合成主页配图…');
  const dir = join(OUT, 'site');
  mkdirSync(dir, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    const divider = theme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.09)';
    for (const [name, parts] of Object.entries(SITE_IMAGES)) {
      const images = parts.map((part, i) => {
        const img = `<img srcset="../raw/${part}-${theme}.png 2x">`;
        return i ? `<span class="side">${img}</span>` : img;
      });
      const html = `<!doctype html><meta charset="utf-8"><style>
        body { margin: 0; display: flex; align-items: flex-start; width: max-content; }
        img { display: block; }
        .side { position: relative; }
        .side::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 1px; background: ${divider}; }
      </style>${images.join('')}`;
      writeFileSync(join(dir, `${name}-${theme}.html`), html);
      await page.viewport(1600, 1000);
      await page.goto(`${server.origin}/repo/.output/screenshots/site/${name}-${theme}.html`);
      await checkImages(page);
      const size = await page.evaluate<{ width: number; height: number }>('({ width: document.body.offsetWidth, height: document.body.offsetHeight })');
      await page.viewport(size.width, size.height);
      const file = `site/img/${name}-${theme}.webp`;
      await page.screenshot(join(ROOT, file), { format: 'webp', quality: 86 });
      console.log(`  ${file}`);
    }
  }
}

async function checkImages(page: Page): Promise<void> {
  const missing = await page.evaluate<string[]>('[...document.images].filter((img) => !img.naturalWidth).map((img) => img.srcset)');
  if (missing.length) throw new Error(`缺少截图：${missing.join('，')}`);
}
