// 截图脚本注入到页面里、在扩展代码之前运行：用 globalThis.__screenshotSeed 里的数据模拟扩展用到的 chrome.* 接口。
// 截图时侧边栏、论文库当作普通网页打开；论文页上的内容脚本也跑在这套接口上（见 capture.ts）。
//   storage     chrome.storage.local 的初始内容
//   manifest    构建出的 manifest.json（runtime.getManifest）
//   pageState   侧边栏向论文页要的页面状态（tabs.sendMessage ahh:get-state 的回复）
//   syncStatus  论文库请求立即同步时的回复（runtime.sendMessage ahh:sync-now）
(() => {
  const seed = globalThis.__screenshotSeed;
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const store = clone(seed.storage ?? {});
  const storageListeners = new Set();
  const messageListeners = [];
  const keysOf = (keys) => (keys == null ? Object.keys(store) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys));
  const notify = (changes) => queueMicrotask(() => storageListeners.forEach((l) => l(changes, 'local')));
  const noEvent = { addListener() {}, removeListener() {}, hasListener: () => false };

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    writable: true,
    value: {
      runtime: {
        id: 'screenshots',
        getURL: (path) => path,
        getManifest: () => clone(seed.manifest),
        sendMessage: async (msg) => (msg?.type === 'ahh:sync-now' ? clone(seed.syncStatus) : undefined),
        onMessage: { addListener: (l) => messageListeners.push(l), removeListener() {}, hasListener: () => false },
      },
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const k of keysOf(keys)) if (k in store) out[k] = clone(store[k]);
            return out;
          },
          async set(items) {
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
              changes[k] = { oldValue: store[k], newValue: clone(v) };
              store[k] = clone(v);
            }
            notify(changes);
          },
          async remove(keys) {
            const changes = {};
            for (const k of keysOf(keys)) {
              if (!(k in store)) continue;
              changes[k] = { oldValue: store[k] };
              delete store[k];
            }
            notify(changes);
          },
        },
        onChanged: {
          addListener: (l) => storageListeners.add(l),
          removeListener: (l) => storageListeners.delete(l),
          hasListener: (l) => storageListeners.has(l),
        },
      },
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async (_tabId, msg) => (msg?.type === 'ahh:get-state' ? clone(seed.pageState) : undefined),
        create: async () => ({}),
        onUpdated: noEvent,
        onActivated: noEvent,
      },
      permissions: { request: async () => true, contains: async () => true },
    },
  });

  /** 给本页的 onMessage 监听器发一条消息（像侧边栏发给内容脚本那样），等它回复 */
  globalThis.__screenshotDispatch = (msg) =>
    new Promise((resolve) => {
      for (const l of messageListeners) l(msg, {}, resolve);
    });
})();
