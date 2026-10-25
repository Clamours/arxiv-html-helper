import { GROUPS_KEY, SHELF_PREFIX, type Group, type GroupColor, type Shelf } from '../../src/core/groups';
import { META_PREFIX, NOTE_PREFIX, PAPER_PREFIX, type PaperNote } from '../../src/core/library';
import type { PaperMeta } from '../../src/core/paper';
import { COLORS, type Annotation } from '../../src/core/types';
import { SYNC_CONFIG_KEY, SYNC_STATUS_KEY, type SyncConfig, type SyncStatus } from '../../src/sync/config';

/**
 * 截图用的示例数据：分组、论文库里的其他论文、详情面板里那篇论文的 arXiv 信息和论文笔记、云同步设置。
 * 截图里那篇论文的划线和笔记是在论文页上现场做的，见 capture.ts。
 * 时间都相对于截图时刻，论文库里显示的"3小时前"等每次都一样
 */

export const PAPER_ID = '1706.03762';
/** 论文库截图里打开详情面板的论文：arXiv 上 DOI、发表信息都有 */
export const DETAIL_PAPER_ID = '2501.12948';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const GROUP_DEFS: [id: string, name: string, color: GroupColor][] = [
  ['g1', '模型架构', 'purple'],
  ['g2', '推理', 'green'],
  ['g3', '对齐与 RLHF', 'pink'],
  ['g4', 'MoE', 'blue'],
  ['g5', '组会待读', 'yellow'],
];

interface PaperDef {
  id: string;
  version: string;
  title: string;
  /** 前几位作者；不足 authorCount 的部分用占位名补齐，论文库只显示前三位和总人数 */
  authors: string[];
  authorCount: number;
  year: number;
  groups: string[];
  flagged?: boolean;
  rating?: number;
  highlights: number;
  notes: number;
  /** 多久之前打开过 / 写过笔记 */
  ago: number;
}

/** 论文库里的论文。第一篇是截图里打开的论文，它的划线来自论文页 */
const PAPERS: PaperDef[] = [
  { id: PAPER_ID, version: 'v7', title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'], authorCount: 8, year: 2017, groups: ['g1', 'g5'], flagged: true, rating: 5, highlights: 0, notes: 0, ago: MINUTE },
  { id: DETAIL_PAPER_ID, version: 'v2', title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning', authors: ['DeepSeek-AI', 'Daya Guo', 'Dejian Yang', 'Haowei Zhang', 'Junxiao Song', 'Peiyi Wang', 'Qihao Zhu', 'Runxin Xu', 'Ruoyu Zhang', 'Shirong Ma', 'Xiao Bi'], authorCount: 200, year: 2025, groups: ['g2', 'g3'], flagged: true, rating: 4, highlights: 14, notes: 5, ago: 3 * HOUR },
  { id: '2402.03300', version: 'v3', title: 'DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models', authors: ['Zhihong Shao', 'Peiyi Wang', 'Qihao Zhu'], authorCount: 11, year: 2024, groups: ['g2'], rating: 4, highlights: 9, notes: 3, ago: 1.1 * DAY },
  { id: '2405.04434', version: 'v5', title: 'DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model', authors: ['DeepSeek-AI', 'Aixin Liu', 'Bei Feng'], authorCount: 157, year: 2024, groups: ['g1', 'g4'], highlights: 11, notes: 2, ago: 2.2 * DAY },
  { id: '2401.04088', version: 'v1', title: 'Mixtral of Experts', authors: ['Albert Q. Jiang', 'Alexandre Sablayrolles', 'Antoine Roux'], authorCount: 26, year: 2024, groups: ['g4'], highlights: 6, notes: 1, ago: 3.1 * DAY },
  { id: '2312.00752', version: 'v2', title: 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces', authors: ['Albert Gu', 'Tri Dao'], authorCount: 2, year: 2023, groups: ['g1'], flagged: true, rating: 3, highlights: 17, notes: 6, ago: 4.2 * DAY },
  { id: '2305.18290', version: 'v3', title: 'Direct Preference Optimization: Your Language Model is Secretly a Reward Model', authors: ['Rafael Rafailov', 'Archit Sharma', 'Eric Mitchell'], authorCount: 6, year: 2023, groups: ['g3'], rating: 5, highlights: 7, notes: 2, ago: 7.5 * DAY },
  { id: '2203.02155', version: 'v1', title: 'Training language models to follow instructions with human feedback', authors: ['Long Ouyang', 'Jeff Wu', 'Xu Jiang'], authorCount: 20, year: 2022, groups: ['g3', 'g5'], highlights: 5, notes: 0, ago: 15 * DAY },
  { id: '2201.11903', version: 'v6', title: 'Chain-of-Thought Prompting Elicits Reasoning in Large Language Models', authors: ['Jason Wei', 'Xuezhi Wang', 'Dale Schuurmans'], authorCount: 9, year: 2022, groups: ['g2'], rating: 4, highlights: 4, notes: 1, ago: 21 * DAY },
  { id: '2106.09685', version: 'v2', title: 'LoRA: Low-Rank Adaptation of Large Language Models', authors: ['Edward J. Hu', 'Yelong Shen', 'Phillip Wallis'], authorCount: 8, year: 2021, groups: [], highlights: 0, notes: 0, ago: 5 * DAY },
];

/** 详情面板里的 arXiv 信息，取自 arXiv API（2026-10-26） */
const DETAIL_META: Partial<PaperMeta> = {
  published: '2025-01-22T15:19:35Z',
  updated: '2026-01-04T08:20:18Z',
  latestVersion: 'v2',
  category: 'cs.CL',
  doi: '10.1038/s41586-025-09422-z',
  journalRef: 'Nature volume 645, pages 633-638 (2025)',
  abstract:
    "General reasoning represents a long-standing and formidable challenge in artificial intelligence. Recent breakthroughs, exemplified by large language models (LLMs) and chain-of-thought prompting, have achieved considerable success on foundational reasoning tasks. However, this success is heavily contingent upon extensive human-annotated demonstrations, and models' capabilities are still insufficient for more complex problems. Here we show that the reasoning abilities of LLMs can be incentivized through pure reinforcement learning (RL), obviating the need for human-labeled reasoning trajectories. The proposed RL framework facilitates the emergent development of advanced reasoning patterns, such as self-reflection, verification, and dynamic strategy adaptation. Consequently, the trained model achieves superior performance on verifiable tasks such as mathematics, coding competitions, and STEM fields, surpassing its counterparts trained via conventional supervised learning on human demonstrations. Moreover, the emergent reasoning patterns exhibited by these large-scale models can be systematically harnessed to guide and enhance the reasoning capabilities of smaller models.",
};

const DETAIL_NOTE = 'R1-Zero 不做 SFT，直接用 GRPO + 规则奖励训练，反思、验证等推理行为自己涌现出来。\nR1 先用少量长 CoT 数据冷启动，解决可读性差、中英混杂的问题。\n待看：蒸馏到 Qwen / Llama 小模型的实验设置。';

/** 导入的 PDF（没有 arXiv HTML 版本的论文） */
const IMPORTED_ID = 'pdf-0123456789abcdef0123';

function groups(now: number): Group[] {
  return GROUP_DEFS.map(([id, name, color], order) => ({ id, name, color, order, createdAt: now - 30 * DAY, updatedAt: now - 30 * DAY }));
}

function shelf(paper: PaperDef, now: number): Shelf {
  const at = now - paper.ago;
  return { groups: paper.groups, flagged: paper.flagged ?? false, rating: paper.rating ?? 0, addedAt: at - 10 * DAY, updatedAt: at };
}

const authorList = (paper: PaperDef) => [...paper.authors, ...Array.from({ length: paper.authorCount - paper.authors.length }, (_, i) => `Author ${i + 1}`)];

/** 第 i 条划线：最新的一条在 at，往前每条早一小时；前 notes 条带笔记 */
function annotation(paperId: string, version: string, i: number, at: number, withNote: boolean): Annotation {
  const quote = `Highlighted passage ${i + 1}`;
  const time = at - i * HOUR;
  return {
    id: `${paperId}-${i + 1}`,
    paperId,
    paperVersion: version,
    layer: 'source',
    segments: [{ blockKey: `S${i + 1}.p1`, position: { start: 0, end: quote.length }, quote: { exact: quote, prefix: '', suffix: '' } }],
    color: COLORS[i % COLORS.length]!,
    note: withNote ? '笔记' : '',
    createdAt: time - MINUTE,
    updatedAt: time,
  };
}

/** 论文页上：分组定义和这篇论文的分组、标记、评分 */
export function pageStorage(now: number): Record<string, unknown> {
  return { [GROUPS_KEY]: groups(now), [SHELF_PREFIX + PAPER_ID]: shelf(PAPERS[0]!, now) };
}

/** 论文库：全部示例论文和云同步设置。截图时再把论文页上做的划线（paper:<PAPER_ID>）放进来 */
export function libraryStorage(now: number): Record<string, unknown> {
  const out: Record<string, unknown> = { [GROUPS_KEY]: groups(now) };
  for (const p of PAPERS) {
    const at = now - p.ago;
    // 带上获取时间和最新版本，论文库页不会再去请求 arXiv API
    const meta: PaperMeta = {
      id: p.id, version: p.version, title: p.title, authors: authorList(p), lastOpenedAt: at,
      published: `${p.year}-06-12T00:00:00Z`, source: 'api', apiAt: now - DAY, latestVersion: p.version,
      ...(p.id === DETAIL_PAPER_ID ? DETAIL_META : {}),
    };
    out[META_PREFIX + p.id] = meta;
    out[SHELF_PREFIX + p.id] = shelf(p, now);
    if (p.highlights) out[PAPER_PREFIX + p.id] = Array.from({ length: p.highlights }, (_, i) => annotation(p.id, p.version, i, at, i < p.notes));
  }

  const importedAt = now - 9 * DAY;
  const imported: PaperMeta = {
    id: IMPORTED_ID,
    version: '',
    title: 'Scaling Laws for Neural Language Models',
    authors: ['Jared Kaplan', 'Sam McCandlish', 'Tom Henighan', ...Array.from({ length: 7 }, (_, i) => `Author ${i + 1}`)],
    lastOpenedAt: importedAt,
    source: 'page',
    doc: { sha256: '0'.repeat(64), size: 1, importedAt, fileName: 'kaplan2020_scaling_laws.pdf' },
  };
  out[META_PREFIX + IMPORTED_ID] = imported;
  out[NOTE_PREFIX + DETAIL_PAPER_ID] = { text: DETAIL_NOTE, updatedAt: now - 2 * HOUR } satisfies PaperNote;
  out[SHELF_PREFIX + IMPORTED_ID] = { groups: [], flagged: false, rating: 0, addedAt: importedAt, updatedAt: 0 } satisfies Shelf;
  out[PAPER_PREFIX + IMPORTED_ID] = [0, 1, 2].map((i) => annotation(IMPORTED_ID, '', i, importedAt, false));

  const sync: SyncConfig = {
    provider: 'webdav',
    intervalMinutes: 5,
    webdav: { url: 'https://dav.jianguoyun.com/dav/', username: 'researcher@example.com', password: 'app-password-example', folder: 'arxiv-html-helper' },
  };
  out[SYNC_CONFIG_KEY] = sync;
  out[SYNC_STATUS_KEY] = syncStatus(now);
  return out;
}

/** 两分钟前同步过 */
export function syncStatus(now: number): SyncStatus {
  return { state: 'idle', lastSuccessAt: now - 2 * MINUTE, lastAttemptAt: now - 2 * MINUTE };
}
