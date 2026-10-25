import { initReaderService } from '@/imported/reader';
import { initSyncService, markTranslationsDirty } from '@/sync/service';
import { initTranslationService } from '@/translations/service';

export default defineBackground(() => {
  // 点击工具栏图标打开、收起当前标签页的侧边栏
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  initTabPanels();
  initSyncService();
  initTranslationService(markTranslationsDirty);
  initReaderService();
});

/** WXT 由 entrypoints/sidepanel/ 生成 */
const PANEL_PATH = 'sidepanel.html';

/**
 * 侧边栏按标签页打开：在哪个标签页点开就只在那里显示，切到其他标签页时不跟过去（和 ChatGPT 侧边栏一样）。
 * 全局面板会在整个窗口的标签页里保持打开，所以关掉它，给每个标签页单独启用面板，各自是独立的页面。
 * 只有当前标签页上能点图标，标签页被激活时启用就够了
 */
function initTabPanels(): void {
  const ready = browser.sidePanel.setOptions({ enabled: false });
  const enable = async (tabId: number) => {
    try {
      await ready;
      // 已经启用的不再设置，免得打断已经打开的面板
      if ((await browser.sidePanel.getOptions({ tabId })).enabled) return;
      await browser.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true });
    } catch {
      // 标签页已经关闭
    }
  };
  const enableActive = async () => {
    for (const tab of await browser.tabs.query({ active: true })) if (tab.id !== undefined) await enable(tab.id);
  };
  browser.tabs.onActivated.addListener(({ tabId }) => void enable(tabId));
  browser.tabs.onReplaced.addListener((tabId) => void enable(tabId));
  // 浏览器启动、扩展安装或更新时已经打开的标签页
  browser.runtime.onStartup.addListener(() => void enableActive());
  void enableActive();
}
