import { initSyncService } from '@/sync/service';

export default defineBackground(() => {
  // 点击工具栏图标打开侧边栏
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  initSyncService();
});
