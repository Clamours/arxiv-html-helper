import { browser } from 'wxt/browser';
import { BackupError, backupFileName, createBackup, parseBackup, planImport, type ImportSummary } from '@/core/backup';
import type { StoredDoc } from '@/core/docs';
import { sha256Hex } from '@/core/paper';
import { readAll, writeMany } from '@/core/storage';
import { listDocs, localDocs } from '@/imported/db';
import { DOWNLOAD_ICON, MORE_ICON, UPLOAD_ICON } from '@/shared/icons';
import { closePopover, openPopover } from '@/shared/popover';
import { toast } from './toast';

/**
 * 论文库页头"更多"菜单里的"导出备份 / 导入备份"：导出为 JSON 文件下载（含导入论文的页面）；
 * 导入时先预览合并结果，确认后一次性写入。本机已有的论文页面不替换。
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function initBackupUi(): { setHasData(has: boolean): void } {
  const menuBtn = $<HTMLButtonElement>('backup');
  const fileInput = $<HTMLInputElement>('import-file');
  const dialog = $<HTMLDialogElement>('dialog');
  let hasData = false;
  menuBtn.innerHTML = MORE_ICON;

  menuBtn.addEventListener('click', () => {
    const box = el('div', 'menu');
    box.setAttribute('role', 'menu');
    const exportItem = menuItem(DOWNLOAD_ICON, '导出备份', '把全部论文、划线、笔记、分组和导入论文的页面保存为一个 JSON 文件，用于备份或迁移到其他电脑', () => {
      closePopover();
      void exportBackup();
    });
    exportItem.disabled = !hasData;
    const importItem = menuItem(UPLOAD_ICON, '导入备份', '从备份文件恢复，与现有内容合并', () => {
      closePopover();
      fileInput.click();
    });
    box.append(exportItem, importItem);
    openPopover('backup-menu', menuBtn, box, { align: 'end' })?.el.querySelector<HTMLElement>('.menu-item:enabled')?.focus();
  });

  async function exportBackup(): Promise<void> {
    let backup;
    try {
      backup = createBackup(await readAll(), browser.runtime.getManifest().version, new Date(), await listDocs());
    } catch (e) {
      // 少了页面的备份不能悄悄导出
      toast(`导出失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const n = backup.papers.reduce((sum, p) => sum + p.annotations.length, 0);
    download(backupFileName(), JSON.stringify(backup, null, 2));
    const pages = backup.docs?.length ? `、${backup.docs.length} 篇导入论文的页面` : '';
    toast(`已导出 ${backup.papers.length} 篇论文、${n} 条划线、${backup.groups.length} 个分组${pages}`);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // 允许重复选择同一个文件
    if (file) await preview(file);
  });

  async function preview(file: File): Promise<void> {
    let parsed;
    try {
      parsed = parseBackup(await file.text());
    } catch (e) {
      showDialog('无法导入', [file.name], [], e instanceof BackupError ? e.message : '读取文件失败');
      return;
    }
    const { summary, writes } = planImport(await readAll(), parsed);
    let docs: StoredDoc[];
    try {
      docs = await missingDocs(parsed.docs);
    } catch (e) {
      showDialog('无法导入', [file.name], [], e instanceof Error ? e.message : String(e));
      return;
    }
    const nothing = Object.keys(writes).length === 0 && !docs.length;
    const when = parsed.exportedAt ? `导出于 ${new Date(parsed.exportedAt).toLocaleString('zh-CN')}` : '';
    const rows = summaryRows(summary);
    if (docs.length) rows.push(['论文页面（本机没有的）', docs.length, false]);
    showDialog('导入备份', [file.name, when], rows, null, nothing ? null : async () => {
      // 确认时基于最新的本地数据重新计算，避免预览之后本地又有改动
      const fresh = planImport(await readAll(), parsed);
      // 先存页面：论文出现在论文库里时，页面已经在了
      const pages = await restoreDocs(await missingDocs(parsed.docs));
      await writeMany(fresh.writes);
      const { added, updated, newPapers, newGroups, shelvesChanged } = fresh.summary;
      const parts = [
        newPapers && `新增论文 ${newPapers} 篇`,
        added && `新增划线 ${added} 条`,
        updated && `更新划线 ${updated} 条`,
        newGroups && `新增分组 ${newGroups} 个`,
        shelvesChanged && `${shelvesChanged} 篇论文的分组有变化`,
        pages.restored && `恢复论文页面 ${pages.restored} 篇`,
        pages.damaged && `${pages.damaged} 篇页面已损坏，已跳过`,
      ].filter(Boolean);
      toast(parts.length ? `已导入：${parts.join('，')}` : '没有需要导入的内容');
    });
  }

  function showDialog(
    title: string,
    /** 副标题的几段，每段内部不断行 */
    sub: string[],
    rows: [string, number, boolean][],
    error: string | null,
    onConfirm?: (() => Promise<void>) | null,
  ): void {
    const box = el('div', 'dlg');
    // 打开时让弹窗本身获得焦点，而不是第一个按钮（否则"取消"会显示焦点框）
    box.tabIndex = -1;
    box.autofocus = true;
    const subEl = el('div', 'file');
    sub.filter(Boolean).forEach((part, i) => {
      if (i) subEl.append(' · ');
      subEl.append(el('span', 'nowrap', part));
    });
    box.append(el('h2', '', title), subEl);
    if (error) box.append(el('p', 'error', error));
    if (rows.length) {
      const ul = el('ul', 'stats-list');
      for (const [label, n, dim] of rows) {
        const li = el('li', dim ? 'dim' : '');
        li.append(el('span', '', label), el('span', 'n', String(n)));
        ul.append(li);
      }
      box.append(ul);
    }
    if (!error) {
      box.append(
        el('p', 'hint', onConfirm ? '导入只会新增和更新，不会删除本地已有的内容。同一条笔记两边都有时，保留修改时间较新的一份；论文的分组取两边的并集。' : '备份里的内容本地都已经有了，无需导入。'),
      );
    }

    const actions = el('div', 'dlg-actions');
    const close = button(onConfirm ? '取消' : '关闭', 'btn plain', () => dialog.close());
    actions.append(close);
    if (onConfirm) {
      const ok = button('导入', 'btn primary', async () => {
        ok.disabled = close.disabled = true;
        try {
          await onConfirm();
          dialog.close();
        } catch {
          ok.disabled = close.disabled = false;
          toast('导入失败，请重试');
        }
      });
      actions.append(ok);
    }
    box.append(actions);
    dialog.replaceChildren(box);
    dialog.showModal();
  }

  return {
    setHasData(has) {
      hasData = has;
    },
  };
}

function menuItem(svg: string, label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'menu-item') as HTMLButtonElement;
  b.setAttribute('role', 'menuitem');
  b.title = hint;
  b.innerHTML = svg;
  b.append(el('span', '', label));
  b.addEventListener('click', onClick);
  return b;
}

function summaryRows(s: ImportSummary): [string, number, boolean][] {
  const rows: [string, number, boolean][] = [
    [`涉及论文${s.newPapers ? `（其中 ${s.newPapers} 篇是新的）` : ''}`, s.papers, false],
    ['新增划线', s.added, false],
    ['更新划线（备份中的更新）', s.updated, false],
  ];
  if (s.newGroups) rows.push(['新增分组', s.newGroups, false]);
  if (s.shelvesChanged) rows.push(['分组或标记有变化的论文', s.shelvesChanged, false]);
  if (s.keptLocal) rows.push(['保留本地（本地的更新）', s.keptLocal, true]);
  if (s.unchanged) rows.push(['已存在，无需改动', s.unchanged, true]);
  if (s.invalid) rows.push(['格式有误，已跳过', s.invalid, true]);
  return rows;
}

/** 备份里本机还没有的论文页面 */
async function missingDocs(docs: StoredDoc[]): Promise<StoredDoc[]> {
  if (!docs.length) return [];
  const have = await localDocs.hashes();
  return docs.filter((d) => !have[d.id]);
}

/** 校验内容和 sha256 相符后保存（本机已有的不替换） */
async function restoreDocs(docs: StoredDoc[]): Promise<{ restored: number; damaged: number }> {
  let restored = 0;
  let damaged = 0;
  for (const doc of docs) {
    if ((await sha256Hex(new TextEncoder().encode(doc.html))) !== doc.sha256) damaged++;
    else if (await localDocs.add(doc)) restored++;
  }
  return { restored, damaged };
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}
