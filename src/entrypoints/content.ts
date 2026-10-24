import { startApp } from '@/content/app';
import { isSupported } from '@/content/highlighter';
import { fillReaderPage } from '@/content/reader';
import { parseImportedPage, parsePaper, readerPaperId } from '@/core/paper';

export default defineContentScript({
  // 导入的 PDF 生成的论文页面在阅读页（https）上打开，阅读页的权限是可选的，
  // 所以那里的内容脚本由 import/reader.ts 动态注册，不写在这里；
  // file:///*：早期版本把导入的论文写成本地文件打开（需要用户打开"允许访问文件网址"），这些文件仍然可以划线，
  // 只在带有论文 id 的页面上启用，其他本地文件不受影响
  matches: ['https://arxiv.org/html/*', 'https://ar5iv.labs.arxiv.org/html/*', 'https://ar5iv.org/html/*', 'file:///*'],
  runAt: 'document_idle',
  async main() {
    const readerId = readerPaperId(location.href);
    if (readerId && !(await fillReaderPage(readerId))) return;
    const paper = parsePaper(location.href) ?? parseImportedPage(document, location.href);
    if (!paper) return;
    if (!isSupported()) {
      console.warn('[arxiv-notes] 当前浏览器不支持 CSS Custom Highlight API（需要 Chrome 105+）');
      return;
    }
    void startApp(paper);
  },
});
