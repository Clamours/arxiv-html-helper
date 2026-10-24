import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { toMeta } from '../src/core/backup';
import { toMarkdown } from '../src/core/library';
import {
  importedPaperId,
  isImportedId,
  mergePageMeta,
  parseImportedPage,
  pickDoc,
  type PaperDoc,
  type PaperMeta,
} from '../src/core/paper';
import { fromStorage, mergeSync } from '../src/core/sync';
import { buildPageFromZip } from '../src/import/bundle';
import { ImportError, MINERU_API, MinerUClient } from '../src/import/mineru-api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

describe('MinerU API', () => {
  it('申请上传地址：带 Token，不重复 Bearer 前缀，不上传原文件名', async () => {
    const f = fakeFetch(() => json({ code: 0, msg: 'ok', data: { batch_id: 'b1', file_urls: ['https://oss.example/u?sig=1'] } }));
    const client = new MinerUClient(' Bearer tok123 ', f.fn);
    expect(await client.createUpload('pdf-0123456789abcdef0123')).toEqual({ batchId: 'b1', uploadUrl: 'https://oss.example/u?sig=1' });
    const { url, init } = f.calls[0]!;
    expect(url).toBe(`${MINERU_API}/file-urls/batch`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok123');
    const body = JSON.parse(init.body as string);
    expect(body.files).toEqual([{ name: 'pdf-0123456789abcdef0123.pdf', data_id: 'pdf-0123456789abcdef0123' }]);
    expect(body.model_version).toBe('vlm');
  });

  it('上传用 ArrayBuffer，不设置 Content-Type', async () => {
    const f = fakeFetch(() => new Response(null, { status: 200 }));
    const pdf = new Uint8Array([37, 80, 68, 70]).buffer;
    await new MinerUClient('t', f.fn).upload('https://oss.example/u', pdf);
    const { init } = f.calls[0]!;
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(pdf);
    expect(init.headers).toBeUndefined();
  });

  it('解析进度：等待、运行中、完成、失败', async () => {
    const results = [
      { extract_result: [] },
      { extract_result: [{ state: 'running', extract_progress: { extracted_pages: 3, total_pages: 26 } }] },
      { extract_result: [{ state: 'done', full_zip_url: 'https://cdn.example/r.zip' }] },
      { extract_result: [{ state: 'failed', err_msg: 'bad pdf' }] },
    ];
    let i = 0;
    const f = fakeFetch(() => json({ code: 0, data: results[i++] }));
    const client = new MinerUClient('t', f.fn);
    expect(await client.result('b1')).toEqual({ state: 'waiting-file' });
    expect(await client.result('b1')).toEqual({ state: 'running', progress: { done: 3, total: 26 } });
    expect(await client.result('b1')).toEqual({ state: 'done', zipUrl: 'https://cdn.example/r.zip' });
    expect(await client.result('b1')).toEqual({ state: 'failed', error: 'bad pdf' });
    expect(f.calls[0]!.url).toBe(`${MINERU_API}/extract-results/batch/b1`);
  });

  it('错误码：Token 过期是 auth，页数超限是 file，HTTP 401 是 auth', async () => {
    const cases: [Response, string, string][] = [
      [json({ code: 'A0211', msg: 'token expired' }), 'auth', '过期'],
      [json({ code: -60006, msg: 'too many pages' }), 'file', '200 页'],
      [json({ code: -12345, msg: 'weird' }), 'remote', 'weird'],
      [new Response('nope', { status: 401 }), 'auth', 'Token'],
    ];
    for (const [res, kind, text] of cases) {
      const err = await new MinerUClient('t', async () => res).createUpload('x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportError);
      expect((err as ImportError).kind).toBe(kind);
      expect((err as ImportError).message).toContain(text);
    }
  });

  it('连不上时是 network 错误，并带上要访问的地址（可能只是缺少访问权限）', async () => {
    const err = (await new MinerUClient('t', async () => {
      throw new TypeError('Failed to fetch');
    })
      .upload('https://mineru.oss-cn-shanghai.aliyuncs.com/x?y', new ArrayBuffer(1))
      .catch((e: unknown) => e)) as ImportError;
    expect(err.kind).toBe('network');
    expect(err.origin).toBe('https://mineru.oss-cn-shanghai.aliyuncs.com/*');
  });
});

describe('结果 zip → 论文页面', () => {
  const MD = '# A Paper\n\nAlice\n\n## 1 INTRO\n\nText $x$.\n\n![image](images/a.jpg)\n\nFigure 1: Local.\n\n![image](https://cdn.example/b.png)\n\nFigure 2: Remote.\n\n![image](images/missing.jpg)\n\nFigure 3: Missing.\n';
  const zip = zipSync({
    'res/full.md': strToU8(MD),
    'res/images/a.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
    'res/layout.json': strToU8('{}'),
  });

  it('图片内嵌、带论文 id，远程图片按需下载，缺失的图片计数', async () => {
    const fetched: string[] = [];
    const built = await buildPageFromZip(document, zip, {
      paperId: 'pdf-0123456789abcdef0123',
      fetchImage: async (url) => (fetched.push(url), { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }),
    });
    expect(fetched).toEqual(['https://cdn.example/b.png']);
    expect(built.missingImages).toBe(1);
    const doc = new DOMParser().parseFromString(built.html, 'text/html');
    const srcs = Array.from(doc.querySelectorAll('img'), (i) => i.getAttribute('src'));
    expect(srcs).toEqual(['data:image/jpeg;base64,/9j/', 'data:image/png;base64,AQID']);
    expect(parseImportedPage(doc, 'file:///Users/me/Downloads/a.html')).toEqual({ id: 'pdf-0123456789abcdef0123', version: '' });
    expect(doc.querySelector('meta[name="generator"]')!.getAttribute('content')).toMatch(/mineru-import\/\d+/);
  });

  it('同样的输入生成完全相同的 HTML', async () => {
    const a = await buildPageFromZip(document, zip, { paperId: 'pdf-0123456789abcdef0123' });
    const b = await buildPageFromZip(document, zip, { paperId: 'pdf-0123456789abcdef0123' });
    expect(a.html).toBe(b.html);
  });

  it('没有 full.md 或不是 zip 时报错', async () => {
    await expect(buildPageFromZip(document, zipSync({ 'x.txt': strToU8('') }), { paperId: 'p' })).rejects.toThrow('full.md');
    await expect(buildPageFromZip(document, strToU8('not a zip'), { paperId: 'p' })).rejects.toThrow('zip');
  });
});

describe('导入论文的 id 与页面识别', () => {
  it('id 由 PDF 内容决定', async () => {
    const a = await importedPaperId(strToU8('%PDF-1.7 a'));
    expect(a).toMatch(/^pdf-[0-9a-f]{20}$/);
    expect(await importedPaperId(strToU8('%PDF-1.7 a'))).toBe(a);
    expect(await importedPaperId(strToU8('%PDF-1.7 b'))).not.toBe(a);
    expect(isImportedId(a)).toBe(true);
    expect(isImportedId('1706.03762')).toBe(false);
  });

  it('只认 file:// 页面上格式正确的 id', () => {
    document.head.innerHTML = '<meta name="ahh-paper-id" content="pdf-0123456789abcdef0123">';
    expect(parseImportedPage(document, 'file:///tmp/a.html')).toEqual({ id: 'pdf-0123456789abcdef0123', version: '' });
    expect(parseImportedPage(document, 'https://evil.example/a.html')).toBeNull();
    document.head.innerHTML = '<meta name="ahh-paper-id" content="../../x">';
    expect(parseImportedPage(document, 'file:///tmp/a.html')).toBeNull();
  });
});

describe('导入信息（PaperDoc）的合并', () => {
  const doc = (importedAt: number, c = 'a'): PaperDoc => ({ sha256: c.repeat(64), size: 10, importedAt, fileName: 'x.pdf' });
  const meta = (d?: PaperDoc, extra: Partial<PaperMeta> = {}): PaperMeta => ({
    id: 'pdf-0123456789abcdef0123',
    version: '',
    title: 'T',
    authors: [],
    lastOpenedAt: 1,
    ...(d ? { doc: d } : {}),
    ...extra,
  });

  it('取先导入的一份，与顺序无关', () => {
    expect(pickDoc(doc(2), doc(1, 'b'))).toEqual(doc(1, 'b'));
    expect(pickDoc(doc(1, 'b'), doc(2))).toEqual(doc(1, 'b'));
    expect(pickDoc(doc(1, 'b'), doc(1, 'a'))).toEqual(doc(1, 'a'));
    expect(pickDoc(undefined, doc(3))).toEqual(doc(3));
  });

  it('打开页面时保留导入信息', () => {
    expect(mergePageMeta(meta(doc(1)), meta(undefined, { lastOpenedAt: 5 })).doc).toEqual(doc(1));
  });

  it('备份 / 同步文件里的导入信息原样保留，格式不对的丢弃', () => {
    expect(toMeta(meta(doc(1)), 'x')!.doc).toEqual(doc(1));
    expect(toMeta({ ...meta(), doc: { sha256: 'nope', size: 1, importedAt: 1 } }, 'x')!.doc).toBeUndefined();
  });

  it('两台电脑各自导入同一个 PDF：同步后都用先导入的一份', () => {
    const id = 'pdf-0123456789abcdef0123';
    const a = fromStorage({ [`meta:${id}`]: meta(doc(2, 'a'), { lastOpenedAt: 9 }) });
    const b = fromStorage({ [`meta:${id}`]: meta(doc(1, 'b')) });
    expect(mergeSync(a, b, 10).papers.get(id)!.meta!.doc).toEqual(doc(1, 'b'));
    expect(mergeSync(b, a, 10).papers.get(id)!.meta!.doc).toEqual(doc(1, 'b'));
  });

  it('导出 Markdown：导入的论文没有 arXiv 链接', () => {
    const md = toMarkdown({ id: 'pdf-0123456789abcdef0123', version: '', title: 'T' }, []);
    expect(md).toBe('# T（导入的 PDF） 笔记\n');
    expect(md).not.toContain('arxiv.org');
  });
});
