import { startApp } from '@/content/app';
import { isSupported } from '@/content/highlighter';
import { parseImportedPage, parsePaper } from '@/core/paper';

export default defineContentScript({
  // file:///*：导入的 PDF 生成的论文页面以本地文件打开（需要用户打开"允许访问文件网址"）；
  // 只在带有论文 id 的页面上启用，其他本地文件不受影响
  matches: ['https://arxiv.org/html/*', 'https://ar5iv.labs.arxiv.org/html/*', 'https://ar5iv.org/html/*', 'file:///*'],
  runAt: 'document_idle',
  main() {
    const paper = parsePaper(location.href) ?? parseImportedPage(document, location.href);
    if (!paper) return;
    if (!isSupported()) {
      console.warn('[arxiv-notes] 当前浏览器不支持 CSS Custom Highlight API（需要 Chrome 105+）');
      return;
    }
    void startApp(paper);
  },
});
