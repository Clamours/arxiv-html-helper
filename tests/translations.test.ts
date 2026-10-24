import { beforeEach, describe, expect, it } from 'vitest';
import { STABLE_MS, SavedTranslations } from '../src/content/translations';
import { anchorSegment, describeRange } from '../src/core/anchor';
import { elementKey } from '../src/core/blocks';
import type { DocContext } from '../src/core/context';
import {
  emptyTranslations,
  entryKey,
  fragmentToHtml,
  mergeTranslations,
  parseIndexFile,
  parseSavedHtml,
  parseTranslationFile,
  sanitizeTranslation,
  toTranslationFile,
  translationsHash,
  type PaperTranslations,
  type SavedBlock,
} from '../src/core/translations';
import { SyncError, type SyncProvider } from '../src/sync/provider';
import { syncTranslations, translationFileName, TRANSLATION_INDEX_NAME } from '../src/sync/translations';
import type { TranslationStore } from '../src/translations/db';
import { $, injectTranslation, loadFixture, makeCtx, rangeBetween, translateInPlace } from './helpers';

const block = (over: Partial<SavedBlock> = {}): SavedBlock => ({
  blockKey: '#S1.p2.1', sourceHash: 'h1', provider: 'immersive-translate', html: '译文', capturedAt: 10, ...over,
});
const rec = (blocks: SavedBlock[], clearedAt = 0, paperId = 'P'): PaperTranslations => ({
  paperId, clearedAt, blocks: Object.fromEntries(blocks.map((b) => [entryKey(b), b])),
});
const htmlOf = (frag: DocumentFragment) => fragmentToHtml(frag, document);

describe('合并', () => {
  it('同一段先存的胜出；与顺序无关、重复合并不变', () => {
    const a = rec([block({ html: 'A', capturedAt: 5 }), block({ blockKey: '#x', html: 'X' })]);
    const b = rec([block({ html: 'B', capturedAt: 3 }), block({ blockKey: '#y', html: 'Y' })]);
    const ab = mergeTranslations(a, b);
    expect(Object.values(ab.blocks).map((x) => x.html).sort()).toEqual(['B', 'X', 'Y']);
    expect(translationsHash(ab)).toBe(translationsHash(mergeTranslations(b, a)));
    expect(translationsHash(mergeTranslations(ab, a))).toBe(translationsHash(ab));
  });

  it('原文变了（哈希不同）的同一块各存一份', () => {
    const m = mergeTranslations(rec([block({ sourceHash: 'v1' })]), rec([block({ sourceHash: 'v2', capturedAt: 99 })]));
    expect(Object.keys(m.blocks).sort()).toEqual(['v1:#S1.p2.1', 'v2:#S1.p2.1']);
  });

  it('清除时间之前采集的作废，之后的保留', () => {
    const m = mergeTranslations(rec([block({ capturedAt: 10 }), block({ blockKey: '#new', capturedAt: 30 })]), rec([], 20));
    expect(m.clearedAt).toBe(20);
    expect(Object.values(m.blocks).map((b) => b.blockKey)).toEqual(['#new']);
  });
});

describe('清洗', () => {
  it('去掉翻译插件的外壳、开头的换行和 id，保留行内格式、链接和公式', () => {
    loadFixture();
    const p = $('S1.p1.1');
    const w = injectTranslation(p, '隐藏状态 <b>序列</b><cite class="ltx_cite">[<a href="#bib.bib1" class="ltx_ref" onclick="x()">1</a>]</cite>', 'immersive');
    w.querySelector('.immersive-translate-target-inner')!.append($('S1.p1.m1').cloneNode(true));
    const html = htmlOf(sanitizeTranslation(w.childNodes, document));
    expect(html).toMatch(/^隐藏状态 <b>序列<\/b><cite class="ltx_cite">\[<a href="#bib.bib1" class="ltx_ref">1<\/a>\]<\/cite><math alttext="h_\{t\}" display="inline" class="ltx_Math">/);
    expect(html).not.toMatch(/font|id=|onclick|<br>/);
    expect(html).toContain('<annotation encoding="application/x-tex">h_{t}</annotation>');
  });

  it('丢弃脚本、图片、事件属性、危险链接，块级类名', () => {
    const html = htmlOf(parseSavedHtml(
      '<script>alert(1)</script><img src=x onerror="alert(1)"><span class="ltx_bibblock ltx_font_bold" style="color:red">字</span>' +
        '<a href="javascript:alert(1)">链</a><svg><circle/></svg><math><annotation-xml>x</annotation-xml><mi onclick="1">h</mi></math>',
      document,
    ));
    expect(html).toBe('<span class="ltx_font_bold">字</span><a>链</a><math><mi>h</mi></math>');
  });
});

describe('云端文件', () => {
  it('往返不变；读不懂的版本报错', () => {
    const r = rec([block(), block({ blockKey: '#a' })], 3);
    const back = parseTranslationFile(JSON.stringify(toTranslationFile(r)), 'P');
    expect(translationsHash(back)).toBe(translationsHash(r));
    expect(() => parseTranslationFile(JSON.stringify({ ...toTranslationFile(r), version: 99 }), 'P')).toThrow('升级');
    expect(() => parseIndexFile('{}')).toThrow();
  });

  it('旧式 id 的文件名', () => {
    expect(translationFileName('hep-th/9901001')).toBe('arxiv-notes-tr-hep-th_9901001.json');
  });
});

// ---------------------------------------------------------------------------
// 页面上的采集和显示
// ---------------------------------------------------------------------------

const ZH = '注意力机制已经成为<b>序列建模</b>中不可或缺的一部分。';

interface Harness {
  ctx: DocContext;
  saved: SavedTranslations;
  persisted: SavedBlock[];
  rechecks: number;
  clock: { t: number };
  /** 模拟 app.ts 的 reanchor：重置缓存后更新 */
  update(): boolean;
}

function harness(root: Element, record?: PaperTranslations): Harness {
  const ctx = makeCtx(root);
  const h: Harness = {
    ctx,
    persisted: [],
    rechecks: 0,
    clock: { t: 1000 },
    saved: null!,
    update() {
      ctx.resetCache();
      const changed = h.saved.update();
      ctx.resetCache();
      return changed;
    },
  };
  h.saved = new SavedTranslations(
    ctx,
    'P',
    { persist: (b) => h.persisted.push(...b), recheckIn: () => h.rechecks++ },
    () => h.clock.t,
  );
  h.saved.prime();
  if (record) h.saved.setRecord(record);
  return h;
}

/** 在页面 A 上采集 S1.p2.1 的译文，返回存档 */
function captureOnce(tool: 'immersive' | 'read-frog' = 'immersive', html = ZH): PaperTranslations {
  const root = loadFixture();
  const h = harness(root);
  injectTranslation($('S1.p2.1'), html, tool);
  h.update();
  h.clock.t += STABLE_MS;
  h.update();
  expect(h.persisted).toHaveLength(1);
  return rec(h.persisted, 0);
}

let root: Element;
beforeEach(() => {
  root = loadFixture();
});

describe('采集', () => {
  it('译文稳定一段时间后才存档；已有存档的段落不再采集', () => {
    const h = harness(root);
    const w = injectTranslation($('S1.p2.1'), '注意力', 'immersive');
    h.update();
    expect(h.persisted).toEqual([]);
    expect(h.rechecks).toBe(1);

    // 流式输出：文本还在变，重新计时
    h.clock.t += STABLE_MS;
    w.querySelector('.immersive-translate-target-inner')!.innerHTML = ZH;
    h.update();
    expect(h.persisted).toEqual([]);

    h.clock.t += STABLE_MS;
    h.update();
    expect(h.persisted).toHaveLength(1);
    const b = h.persisted[0]!;
    expect(b).toMatchObject({ blockKey: '#S1.p2.1', provider: 'immersive-translate', capturedAt: h.clock.t, html: ZH });

    h.clock.t += STABLE_MS * 3;
    h.update();
    expect(h.persisted).toHaveLength(1);
  });

  it('有加载动画时不采集', () => {
    const h = harness(root);
    injectTranslation($('S1.p2.1'), ZH);
    const spinner = document.createElement('span');
    spinner.setAttribute('data-immersive-translate-loading-id', '1');
    $('S1.p2.1').append(spinner);
    h.update();
    h.clock.t += STABLE_MS;
    h.update();
    expect(h.persisted).toEqual([]);
  });

  it('仅译文模式也能采集：原文哈希取自翻译之前', () => {
    const bilingual = captureOnce();
    root = loadFixture();
    const h = harness(root);
    translateInPlace($('S1.p2.1'), ZH, 'read-frog');
    h.update();
    h.clock.t += STABLE_MS;
    h.update();
    expect(h.persisted).toHaveLength(1);
    expect(entryKey(h.persisted[0]!)).toBe(Object.keys(bilingual.blocks)[0]);
    expect(h.persisted[0]!.html).toBe(ZH);
  });
});

describe('显示（存档优先）', () => {
  it('没有翻译插件时显示存档；译文层笔记按偏移定位；块 key 不受影响', () => {
    const archive = captureOnce();
    // 划线：在 A 上对翻译插件的译文划线
    root = loadFixture();
    const a = harness(root, archive);
    const keyBefore = elementKey(root.querySelector('figcaption')!, root, a.ctx.isForeign);
    expect(a.update()).toBe(true);
    const w = root.querySelector('.ahh-saved-translation')!;
    expect(w.parentElement).toBe($('S1.p2.1'));
    expect(w.innerHTML).toBe(ZH);
    expect(a.update()).toBe(false); // 幂等
    expect(a.saved.summary()).toEqual({ total: 1, shown: 1, visible: true });
    expect(elementKey(root.querySelector('figcaption')!, root, a.ctx.isForeign)).toBe(keyBefore);
    expect(a.ctx.textMap($('S1.p2.1'), 'source').text).toBe('Attention mechanisms have become an integral part of compelling sequence modeling.');

    const d = describeRange(rangeBetween(w, '序列建模'), a.ctx)!;
    expect(d.layer).toBe('translation');
    expect(d.segments[0]!.translation!.provider).toBe('saved');

    // B：另一台电脑，翻译插件翻出了不同的措辞 → 隐藏插件的译文，显示存档，笔记按偏移定位
    root = loadFixture();
    const b = harness(root, archive);
    const live = injectTranslation($('S1.p2.1'), '注意力机制已成为序列建模里的重要组成部分。', 'read-frog');
    b.update();
    expect(live.hasAttribute('data-ahh-superseded')).toBe(true);
    expect(b.ctx.textMap($('S1.p2.1'), 'translation').text).toBe('注意力机制已经成为序列建模中不可或缺的一部分。');
    const res = anchorSegment(d.segments[0]!, 'translation', b.ctx);
    expect(res.status === 'anchored' && res.how).toBe('position');
    expect(b.persisted).toEqual([]); // 已有存档，不再采集
  });

  it('翻译插件的译文与存档一致时照常显示插件的译文', () => {
    const archive = captureOnce();
    root = loadFixture();
    const h = harness(root, archive);
    const live = injectTranslation($('S1.p2.1'), ZH, 'read-frog');
    h.update();
    expect(root.querySelector('.ahh-saved-translation')).toBeNull();
    expect(live.hasAttribute('data-ahh-superseded')).toBe(false);
    expect(h.saved.summary().shown).toBe(0);
  });

  it('已经显示着存档的段落，插件重翻后与存档一致也不移除存档（避免与陪读蛙来回切换）', () => {
    const archive = captureOnce();
    root = loadFixture();
    const h = harness(root, archive);
    // 插件的译文与存档不同 → 显示存档
    let live = injectTranslation($('S1.p2.1'), '另一种译文', 'read-frog');
    expect(h.update()).toBe(true);
    // 陪读蛙看到段落变了，删掉译文重翻，这次与存档一字不差
    live.remove();
    live = injectTranslation($('S1.p2.1'), ZH, 'read-frog');
    expect(h.update()).toBe(false);
    expect(root.querySelectorAll('.ahh-saved-translation')).toHaveLength(1);
    expect(live.hasAttribute('data-ahh-superseded')).toBe(true);
    expect(h.saved.summary().shown).toBe(1);
  });

  it('原文变了（论文改版）不套用旧存档，重新采集', () => {
    const archive = captureOnce();
    root = loadFixture();
    $('S1.p2.1').textContent = 'Attention mechanisms are now an integral part of sequence modeling.';
    const h = harness(root, archive);
    h.update();
    expect(root.querySelector('.ahh-saved-translation')).toBeNull();
    injectTranslation($('S1.p2.1'), '新译文');
    h.update();
    h.clock.t += STABLE_MS;
    h.update();
    expect(h.persisted.map((b) => b.html)).toEqual(['新译文']);
  });

  it('仅译文模式的段落不显示存档', () => {
    const archive = captureOnce();
    root = loadFixture();
    const h = harness(root, archive);
    translateInPlace($('S1.p2.1'), '别的译文');
    h.update();
    expect(root.querySelector('.ahh-saved-translation')).toBeNull();
  });

  it('隐藏存档：移除存档、恢复插件的译文；清除存档后重新采集', () => {
    const archive = captureOnce();
    root = loadFixture();
    const h = harness(root, archive);
    const live = injectTranslation($('S1.p2.1'), '另一种译文');
    h.update();
    expect(live.hasAttribute('data-ahh-superseded')).toBe(true);

    h.saved.setVisible(false);
    expect(h.update()).toBe(true);
    expect(root.querySelector('.ahh-saved-translation')).toBeNull();
    expect(live.hasAttribute('data-ahh-superseded')).toBe(false);

    h.saved.setVisible(true);
    h.update();
    // 清除：清除时间晚于存档的采集时间
    h.clock.t = archive.blocks[Object.keys(archive.blocks)[0]!]!.capturedAt + 1000;
    expect(h.saved.setRecord(mergeTranslations(archive, rec([], h.clock.t)))).toBe(true);
    h.update();
    expect(root.querySelector('.ahh-saved-translation')).toBeNull();
    h.clock.t += 1;
    h.update();
    h.clock.t += STABLE_MS;
    h.update();
    expect(h.persisted.map((b) => b.html)).toEqual(['另一种译文']);
  });
});

// ---------------------------------------------------------------------------
// 云同步
// ---------------------------------------------------------------------------

function memoryTranslations(init: PaperTranslations[] = []): TranslationStore & { data: Map<string, PaperTranslations> } {
  const data = new Map(init.map((r) => [r.paperId, structuredClone(r)]));
  return {
    data,
    async hashes() {
      return Object.fromEntries([...data].map(([id, r]) => [id, translationsHash(r)]));
    },
    async get(id) {
      return structuredClone(data.get(id) ?? null);
    },
    async merge(r) {
      const merged = mergeTranslations(data.get(r.paperId) ?? emptyTranslations(r.paperId), r);
      data.set(r.paperId, merged);
      return structuredClone(merged);
    },
  };
}

function fakeFiles() {
  const files = new Map<string, { text: string; version: number }>();
  let writes = 0;
  let interfere: (() => Promise<unknown>) | null = null;
  const file = (name: string): SyncProvider => ({
    async read() {
      const f = files.get(name);
      const out = { texts: f ? [f.text] : [], version: f?.version ?? 0 };
      if (name === TRANSLATION_INDEX_NAME && interfere) {
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
      writes++;
    },
  });
  return {
    files,
    file,
    get writes() {
      return writes;
    },
    set interfere(fn: () => Promise<unknown>) {
      interfere = fn;
    },
  };
}

describe('syncTranslations', () => {
  it('两台电脑之间同步；都已是最新时不再上传', async () => {
    const cloud = fakeFiles();
    const a = memoryTranslations([rec([block({ html: 'A1' })], 0, 'P1')]);
    const b = memoryTranslations([rec([block({ html: 'B2' })], 0, 'P2'), rec([block({ html: 'B1', capturedAt: 99 })], 0, 'P1')]);

    expect(await syncTranslations(cloud.file, a)).toEqual([]);
    expect(await syncTranslations(cloud.file, b)).toEqual(['P1']);
    expect(await syncTranslations(cloud.file, a)).toEqual(['P2']);
    // P1 两边各存了一份：先存的（A1）胜出
    for (const pc of [a, b]) {
      expect(Object.values(pc.data.get('P1')!.blocks).map((x) => x.html)).toEqual(['A1']);
      expect(Object.values(pc.data.get('P2')!.blocks).map((x) => x.html)).toEqual(['B2']);
    }
    expect([...cloud.files.keys()].sort()).toEqual([TRANSLATION_INDEX_NAME, translationFileName('P1'), translationFileName('P2')].sort());

    const writes = cloud.writes;
    expect(await syncTranslations(cloud.file, a)).toEqual([]);
    expect(await syncTranslations(cloud.file, b)).toEqual([]);
    expect(cloud.writes).toBe(writes);
  });

  it('清除存档同步到另一台电脑', async () => {
    const cloud = fakeFiles();
    const a = memoryTranslations([rec([block()], 0, 'P')]);
    const b = memoryTranslations();
    await syncTranslations(cloud.file, a);
    await syncTranslations(cloud.file, b);
    expect(Object.keys(b.data.get('P')!.blocks)).toHaveLength(1);
    await b.merge(rec([], 50, 'P'));
    await syncTranslations(cloud.file, b);
    expect(await syncTranslations(cloud.file, a)).toEqual(['P']);
    expect(a.data.get('P')).toEqual({ paperId: 'P', blocks: {}, clearedAt: 50 });
  });

  it('索引被另一台电脑同时改写：重来一次，两边的论文都在索引里', async () => {
    const cloud = fakeFiles();
    const a = memoryTranslations([rec([block()], 0, 'A')]);
    const b = memoryTranslations([rec([block()], 0, 'B')]);
    cloud.interfere = () => syncTranslations(cloud.file, b);
    // A 写索引时冲突，重来时顺便取回了 B 的存档
    expect(await syncTranslations(cloud.file, a)).toEqual(['B']);
    expect(Object.keys(parseIndexFile(cloud.files.get(TRANSLATION_INDEX_NAME)!.text)).sort()).toEqual(['A', 'B']);
    expect(await syncTranslations(cloud.file, b)).toEqual(['A']);
  });

  it('云端文件读不懂时报错，不覆盖', async () => {
    const cloud = fakeFiles();
    cloud.files.set(TRANSLATION_INDEX_NAME, { text: '{"format":"arxiv-html-notes-translations-index","version":99,"papers":{}}', version: 1 });
    await expect(syncTranslations(cloud.file, memoryTranslations([rec([block()])]))).rejects.toThrow('已暂停同步');
    expect(cloud.writes).toBe(0);
  });
});
