import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

/**
 * 截图脚本的基础设施：本地静态服务器，以及通过 Chrome DevTools Protocol 控制无头 Chrome 的最小封装
 * （不依赖 Puppeteer / Playwright）。
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>;

/** 反复调用 fn，直到返回真值；出错视为还没准备好 */
export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeout = 15_000): Promise<Truthy<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as Truthy<T>;
    } catch {
      // 继续等
    }
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------
// 静态服务器
// ---------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

export interface Server {
  readonly origin: string;
  close(): void;
}

/** 只监听 127.0.0.1 的静态文件服务器。mounts 是 { 网址前缀: 目录 }，前缀长的优先 */
export async function serve(mounts: Record<string, string>): Promise<Server> {
  const prefixes = Object.keys(mounts).sort((a, b) => b.length - a.length);
  const server = createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const prefix = prefixes.find((p) => path.startsWith(p));
      if (prefix === undefined) throw new Error('not found');
      const dir = resolve(mounts[prefix]!);
      const file = resolve(dir, path.slice(prefix.length));
      // 不允许跳出目录
      if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) throw new Error('not found');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地服务器启动失败');
  return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

// ---------------------------------------------------------------------------
// 无头 Chrome
// ---------------------------------------------------------------------------

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface Browser {
  /** 打开一个新标签页；label 用在出错信息里 */
  newPage(label: string): Promise<Page>;
  close(): Promise<void>;
}

/** 启动无头 Chrome。profileDir 要是空目录，用完由调用方删除 */
export async function launchChrome(profileDir: string): Promise<Browser> {
  const bin = process.env.CHROME || DEFAULT_CHROME;
  if (!existsSync(bin)) throw new Error(`找不到 Chrome：${bin}（可以用环境变量 CHROME 指定）`);
  const proc = spawn(
    bin,
    [
      '--headless',
      // 端口填 0：Chrome 自己挑一个空闲端口，写进 profileDir/DevToolsActivePort
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--hide-scrollbars',
      // 截图按 sRGB 输出，不随显示器的色彩配置变化
      '--force-color-profile=srgb',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=zh-CN',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  try {
    const portFile = join(profileDir, 'DevToolsActivePort');
    const port = await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0], '启动 Chrome');
    const base = `http://127.0.0.1:${port}`;
    return {
      async newPage(label) {
        const target = (await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
        return Page.connect(target.webSocketDebuggerUrl, label);
      },
      async close() {
        proc.kill();
        await exited;
      },
    };
  } catch (e) {
    proc.kill();
    throw e;
  }
}

export interface ViewportOptions {
  /** 设备像素比，默认 2 */
  scale?: number;
  dark?: boolean;
}

/** CDP 的消息：命令的回复（带 id）或事件（带 method），字段随命令 / 事件不同 */
interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: unknown;
  error?: { message: string };
}

interface ExceptionDetails {
  text: string;
  exception?: { description?: string };
}

/** 一个标签页 */
export class Page {
  private seq = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly waiters: { method: string; resolve(): void }[] = [];

  private constructor(
    private readonly ws: WebSocket,
    readonly label: string,
  ) {
    ws.addEventListener('message', (e) => this.receive(JSON.parse(String(e.data)) as Message));
  }

  static async connect(url: string, label: string): Promise<Page> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`连接不上标签页：${label}`)), { once: true });
    });
    const page = new Page(ws, label);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  private receive(msg: Message): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`[${this.label}] ${msg.error.message}`));
      else p?.resolve(msg.result);
      return;
    }
    for (const w of this.waiters.filter((x) => x.method === msg.method)) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve();
    }
    // 页面里（包括内容脚本）的脚本出错时打印出来，方便排查
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails as ExceptionDetails;
      console.error(`[${this.label}] ${d.exception?.description ?? d.text}`);
    }
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private once(method: string): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ method, resolve }));
  }

  /** 执行一段表达式，等它的 Promise 完成，返回结果（要能 JSON 序列化）。contextId 指定执行环境，默认是页面本身 */
  async evaluate<T = unknown>(expression: string, contextId?: number): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: ExceptionDetails }>('Runtime.evaluate', {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(`[${this.label}] ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** 等表达式的值为真 */
  async waitFor(expression: string, contextId?: number): Promise<void> {
    await waitFor(() => this.evaluate(expression, contextId), `[${this.label}] ${expression}`);
  }

  async viewport(width: number, height: number, { scale = 2, dark = false }: ViewportOptions = {}): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  }

  /** 打开网址，等页面加载完、字体就绪 */
  async goto(url: string): Promise<void> {
    const loaded = this.once('Page.loadEventFired');
    const { errorText } = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (errorText) throw new Error(`[${this.label}] 打不开 ${url.slice(0, 100)}：${errorText}`);
    await loaded;
    await this.evaluate('document.fonts.ready.then(() => true)');
  }

  /** 以后每次加载页面时，在页面自己的脚本之前运行这段代码 */
  async addInitScript(source: string): Promise<void> {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async screenshot(file: string, { format = 'png', quality }: { format?: 'png' | 'webp'; quality?: number } = {}): Promise<void> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format, quality });
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  close(): void {
    this.ws.close();
  }
}
