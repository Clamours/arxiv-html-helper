import { describe, expect, it } from 'vitest';
import { libraryDocs, parseDocIndexFile, toDocFile, toDocIndexFile, type LibraryDocs, type StoredDoc } from '../src/core/docs';
import { sha256Hex } from '../src/core/paper';
import type { DocStore } from '../src/imported/db';
import { docFileName, DOC_INDEX_NAME, syncDocs } from '../src/sync/docs';
import { SyncError, type SyncProvider } from '../src/sync/provider';

const X = 'pdf-0123456789abcdef0123';
const Y = 'pdf-fedcba9876543210fedc';

async function page(id: string, html: string): Promise<StoredDoc> {
  return { id, html, sha256: await sha256Hex(new TextEncoder().encode(html)) };
}

const lib = (wanted: LibraryDocs['wanted'], removed: string[] = []) => async (): Promise<LibraryDocs> => ({ wanted, removed });

function memoryDocs(init: StoredDoc[] = []): DocStore & { data: Map<string, StoredDoc> } {
  const data = new Map(init.map((d) => [d.id, d]));
  return {
    data,
    async hashes() {
      return Object.fromEntries([...data].map(([id, d]) => [id, d.sha256]));
    },
    async get(id) {
      return data.get(id) ?? null;
    },
    async add(doc) {
      if (data.has(doc.id)) return false;
      data.set(doc.id, doc);
      return true;
    },
    async remove(id) {
      data.delete(id);
    },
  };
}

function fakeFiles() {
  const files = new Map<string, { text: string; version: number }>();
  const log: string[] = [];
  let interfere: (() => Promise<unknown>) | null = null;
  const file = (name: string): SyncProvider => ({
    async read() {
      log.push(`read ${name}`);
      const f = files.get(name);
      const out = { texts: f ? [f.text] : [], version: f?.version ?? 0 };
      if (name === DOC_INDEX_NAME && interfere) {
        const run = interfere;
        interfere = null;
        await run();
      }
      return out;
    },
    async write(text, prev, conditional) {
      const cur = files.get(name)?.version ?? 0;
      if (conditional && prev.version !== cur) throw new SyncError('conflict', 'conflict');
      files.set(name, { text, version: cur + 1 });
      log.push(`write ${name}`);
    },
    async remove() {
      files.delete(name);
      log.push(`remove ${name}`);
    },
  });
  return {
    files,
    file,
    log,
    index: () => parseDocIndexFile(files.get(DOC_INDEX_NAME)!.text),
    set interfere(fn: () => Promise<unknown>) {
      interfere = fn;
    },
  };
}

describe('syncDocs', () => {
  it('本机有、云端没有的上传，另一台电脑下载；都已是最新时只读索引', async () => {
    const cloud = fakeFiles();
    const p = await page(X, '<p>X</p>');
    const a = memoryDocs([p]);
    const b = memoryDocs();
    const want = lib({ [X]: p.sha256 });

    expect(await syncDocs(cloud.file, a, want)).toEqual([]);
    expect(cloud.index()).toEqual({ [X]: p.sha256 });
    expect(await syncDocs(cloud.file, b, want)).toEqual([X]);
    expect(b.data.get(X)).toEqual(p);

    cloud.log.length = 0;
    await syncDocs(cloud.file, a, want);
    await syncDocs(cloud.file, b, want);
    expect(cloud.log).toEqual([`read ${DOC_INDEX_NAME}`, `read ${DOC_INDEX_NAME}`]);
  });

  it('不在论文库里的页面不上传；云端没有索引、也没有页面要记时不建空索引', async () => {
    const cloud = fakeFiles();
    await syncDocs(cloud.file, memoryDocs([await page(X, 'x')]), lib({}));
    expect(cloud.files.size).toBe(0);
  });

  it('两台电脑各自导入过同一个 PDF：云端换成先导入的那份，本机已有的页面不替换', async () => {
    const cloud = fakeFiles();
    const first = await page(X, 'A 先导入');
    const second = await page(X, 'B 后导入');
    const a = memoryDocs([first]);
    const b = memoryDocs([second]);

    // B 还没合并到 A 的元数据，以为自己这份就是要保留的
    await syncDocs(cloud.file, b, lib({ [X]: second.sha256 }));
    // 元数据合并之后，两边记录的都是先导入的那份
    await syncDocs(cloud.file, a, lib({ [X]: first.sha256 }));
    expect(cloud.index()).toEqual({ [X]: first.sha256 });
    expect(JSON.parse(cloud.files.get(docFileName(X))!.text).html).toBe('A 先导入');

    cloud.log.length = 0;
    expect(await syncDocs(cloud.file, b, lib({ [X]: first.sha256 }))).toEqual([]);
    expect(b.data.get(X)).toEqual(second);
    expect(cloud.log).toEqual([`read ${DOC_INDEX_NAME}`]);

    const c = memoryDocs();
    await syncDocs(cloud.file, c, lib({ [X]: first.sha256 }));
    expect(c.data.get(X)).toEqual(first);
  });

  it('从论文库移除：删除云端的文件和索引项，以及其他电脑上的页面', async () => {
    const cloud = fakeFiles();
    const p = await page(X, 'x');
    const q = await page(Y, 'y');
    const a = memoryDocs([p, q]);
    const b = memoryDocs();
    const both = lib({ [X]: p.sha256, [Y]: q.sha256 });
    await syncDocs(cloud.file, a, both);
    await syncDocs(cloud.file, b, both);
    expect([...b.data.keys()].sort()).toEqual([X, Y].sort());

    // A 上移除 X：论文库页会一并删除本机的页面
    await a.remove(X);
    const after = lib({ [Y]: q.sha256 }, [X]);
    await syncDocs(cloud.file, a, after);
    expect(cloud.index()).toEqual({ [Y]: q.sha256 });
    expect(cloud.files.has(docFileName(X))).toBe(false);
    await syncDocs(cloud.file, b, after);
    expect([...b.data.keys()]).toEqual([Y]);
  });

  it('云端的页面损坏或不在了：不保存，从索引里去掉，持有页面的电脑下次重新上传', async () => {
    const cloud = fakeFiles();
    const p = await page(X, 'x');
    const a = memoryDocs([p]);
    const b = memoryDocs();
    const want = lib({ [X]: p.sha256 });
    await syncDocs(cloud.file, a, want);

    // 内容和 sha256 对不上
    cloud.files.set(docFileName(X), { text: JSON.stringify(toDocFile({ ...p, html: 'x 被截断' })), version: 9 });
    expect(await syncDocs(cloud.file, b, want)).toEqual([]);
    expect(b.data.size).toBe(0);
    expect(cloud.index()).toEqual({});
    await syncDocs(cloud.file, a, want);
    expect(await syncDocs(cloud.file, b, want)).toEqual([X]);
    expect(b.data.get(X)).toEqual(p);

    // 文件不在了
    cloud.files.delete(docFileName(X));
    expect(await syncDocs(cloud.file, memoryDocs(), want)).toEqual([]);
    expect(cloud.index()).toEqual({});
    await syncDocs(cloud.file, a, want);
    expect(cloud.index()).toEqual({ [X]: p.sha256 });
  });

  it('索引被另一台电脑同时改写：重来一次，两边的页面都在索引里', async () => {
    const cloud = fakeFiles();
    const p = await page(X, 'x');
    const q = await page(Y, 'y');
    const a = memoryDocs([p]);
    const b = memoryDocs([q]);
    const want = lib({ [X]: p.sha256, [Y]: q.sha256 });
    cloud.interfere = () => syncDocs(cloud.file, b, want);
    // A 写索引时冲突，重来时顺便取回了 B 的页面
    expect(await syncDocs(cloud.file, a, want)).toEqual([Y]);
    expect(Object.keys(cloud.index()).sort()).toEqual([X, Y].sort());
    expect(await syncDocs(cloud.file, b, want)).toEqual([X]);
  });

  it('云端的索引读不懂时报错，什么都不写', async () => {
    const cloud = fakeFiles();
    cloud.files.set(DOC_INDEX_NAME, { text: '{"format":"arxiv-html-notes-pages-index","version":99,"docs":{}}', version: 1 });
    const p = await page(X, 'x');
    await expect(syncDocs(cloud.file, memoryDocs([p]), lib({ [X]: p.sha256 }))).rejects.toThrow('已暂停同步');
    expect(cloud.log.filter((l) => !l.startsWith('read'))).toEqual([]);
  });

  it('页面文件来自更新版本的插件：报错，不当作损坏的文件从索引里去掉', async () => {
    const cloud = fakeFiles();
    const p = await page(X, 'x');
    cloud.files.set(DOC_INDEX_NAME, { text: JSON.stringify(toDocIndexFile({ [X]: p.sha256 })), version: 1 });
    cloud.files.set(docFileName(X), { text: JSON.stringify({ ...toDocFile(p), version: 2 }), version: 1 });
    await expect(syncDocs(cloud.file, memoryDocs(), lib({ [X]: p.sha256 }))).rejects.toThrow('已暂停同步');
    expect(cloud.index()).toEqual({ [X]: p.sha256 });
  });
});

describe('libraryDocs', () => {
  it('论文库里的导入论文对应元数据记录的页面；移除了、也没在重新导入的列为已移除', () => {
    const sha = 'a'.repeat(64);
    const removed = 'pdf-00000000000000000000';
    const reimporting = 'pdf-11111111111111111111';
    const notesOnly = 'pdf-22222222222222222222';
    const all = {
      [`meta:${X}`]: { id: X, version: '', title: 'X', authors: [], lastOpenedAt: 2, doc: { sha256: sha, size: 1, importedAt: 1, fileName: 'x.pdf' } },
      [`tomb:${X}`]: { paper: 1, annotations: {} },
      // 早期导入的论文：元数据里没有页面的记录
      [`shelf:${Y}`]: { groups: [], flagged: false, rating: 0, addedAt: 1, updatedAt: 0 },
      'meta:2401.00001': { id: '2401.00001', version: 'v1', title: 'arXiv', authors: [], lastOpenedAt: 1 },
      [`tomb:${removed}`]: { paper: 5, annotations: {} },
      [`tomb:${reimporting}`]: { paper: 5, annotations: {} },
      [`import:job:${reimporting}`]: { paperId: reimporting, step: 'parsing' },
      [`tomb:${notesOnly}`]: { annotations: { a: 5 } },
    };
    expect(libraryDocs(all)).toEqual({ wanted: { [X]: sha, [Y]: null }, removed: [removed] });
  });
});
