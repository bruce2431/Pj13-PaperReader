// Pj13 预览前端 · mock 数据（后端未连上时的兜底，vite 单独跑调试目录页用）
// 词汇卡对应 assests/notes.db 中 Towards Agentic RAG with Deep Reasoning - A Survey of RAG-Reasoning Systems in LLMs 这篇的条目。

import type { AnnoNote, AnnoPayload, FsEntry, FsListing, VocabNote, VocabPatch, GeneratePayload } from '../types'

const pdfBase = `${import.meta.env.BASE_URL}pdfs/`
const DIR = '示例专题'

// dev 下的 PDF 实体只有 public/pdfs/ 这几份平铺副本：子目录条目借用其中两份，
// 仅为验证「目录页层级 + 面包屑」的布局，不是真实文件对应关系
function pdf(name: string, mirror: string, size = 1234567, mtime = '2026-09-01T10:00:00.000Z'): FsEntry {
  return { name, path: name, type: 'pdf', url: `${pdfBase}${mirror}`, size, mtime }
}

const RAG1 = 'Towards Agentic RAG with Deep Reasoning - A Survey of RAG-Reasoning Systems in LLMs.pdf'
const RAG2 = 'Graph-based Approaches and Functionalities in Retrieval-Augmented Generation - A Comprehensive Survey.pdf'
const RAG3 = 'Graph Retrieval-Augmented Generation - A Survey.pdf'
const RAG4 = 'Ask in Any Modality - A Comprehensive Survey on Multimodal Retrieval-Augmented Generation.pdf'

const TREE: Record<string, FsEntry[]> = {
  '': [
    { name: DIR, path: DIR, type: 'dir', pdfCount: 2 },
    pdf(RAG1, RAG1, 8401234),
    pdf(RAG2, RAG2, 5120000),
    pdf(RAG3, RAG3, 3980000),
    pdf(RAG4, RAG4, 6210000),
  ],
  [DIR]: [
    { ...pdf('相变讲义.pdf', RAG3, 2201651), path: `${DIR}/相变讲义.pdf` },
    { ...pdf('A1李杨相变定理.pdf', RAG4, 981234), path: `${DIR}/A1李杨相变定理.pdf` },
  ],
}

const VOCAB: VocabNote[] = [
  {
    term: 'mitigate',
    surface: 'mitigating',
    sentence:
      'By referencing an external knowledge base, RAG refines LLM outputs, effectively **mitigating** issues such as "hallucination", lack of domain-specific knowledge, and outdated information.',
    meaning: '"减轻"、"缓和"或"缓解"',
    roots: ['mit：拉丁语 = soften，意为"变软"、"使温和"'],
    anchor: { pdf: 'Towards Agentic RAG with Deep Reasoning - A Survey of RAG-Reasoning Systems in LLMs.pdf', page: 1, sel: [40, 66, 42, 36] },
  },
  {
    term: 'encompass',
    surface: 'encompassing',
    sentence:
      'We formalize the GraphRAG workflow, **encompassing** Graph-Based Indexing, Graph-Guided Retrieval, and Graph-Enhanced Generation.',
    meaning: '"围绕"',
    roots: [],
    anchor: { pdf: 'Towards Agentic RAG with Deep Reasoning - A Survey of RAG-Reasoning Systems in LLMs.pdf', page: 1, sel: [47, 36, 48, 65] },
  },
  {
    term: 'unprecedented',
    surface: 'unprecedented',
    sentence:
      'These models, built on Transformer architectures and trained on diverse and extensive datasets, have demonstrated **unprecedented** capabilities in understanding, interpreting, and generating human language.',
    meaning: '"史无前例的"、"空前的"',
    roots: [
      'un-：否定前缀 = not，表示"无"',
      'pre-：拉丁语前缀 = before，表示"在...之前"',
      'ced：拉丁语 cedere = to go，意为"走、行进"',
      '-ent / -ed：形容词后缀',
    ],
    anchor: { pdf: 'Towards Agentic RAG with Deep Reasoning - A Survey of RAG-Reasoning Systems in LLMs.pdf', page: 2, sel: [33, 53, 33, 66] },
  },
  {
    term: 'sectors',
    surface: 'sectors',
    sentence:
      'The impact of these advancements is profound, stretching across various **sectors** including healthcare, finance, and education, where they facilitate more nuanced and efficient interactions between humans and machines.',
    meaning: '"领域、行业"',
    roots: [
      'sect：拉丁语 secare = to cut，意为"切割、划分"',
      '-or：名词后缀，表示"做…的事物"',
    ],
    anchor: { pdf: 'Towards Agentic RAG with Deep Reasoning - A Survey of RAG-Reasoning Systems in LLMs.pdf', page: 2, sel: [35, 26, 35, 33] },
  },
]

/** mock 的生词卡仓库：初始为样例，生成/改/删都在内存里生效（刷新即回样例） */
const VOCAB_STORE: VocabNote[] = [...VOCAB]

export async function mockListDir(path: string): Promise<FsListing> {
  const cur = TREE[path] ? path : ''
  const parent = cur ? cur.split('/').slice(0, -1).join('/') : null
  return { path: cur, parent, entries: TREE[cur] ?? [] }
}

export async function mockGetVocabNotes(pdf: string): Promise<VocabNote[]> {
  return VOCAB_STORE.filter((n) => !n.anchor || n.anchor.pdf === pdf || pdf.endsWith(n.anchor.pdf))
}

export async function mockUpdateVocab(pdf: string, term: string, patch: VocabPatch): Promise<VocabNote> {
  const n = VOCAB_STORE.find((x) => x.anchor?.pdf === pdf && x.term === term)
  if (!n) throw new Error('该生词卡不存在')
  if (patch.meaning !== undefined) n.meaning = patch.meaning
  if (patch.roots !== undefined) n.roots = patch.roots
  n.updatedAt = new Date().toLocaleString('sv-SE')
  return n
}

export async function mockDeleteVocab(pdf: string, term: string): Promise<void> {
  const i = VOCAB_STORE.findIndex((x) => x.anchor?.pdf === pdf && x.term === term)
  if (i < 0) throw new Error('该生词卡不存在')
  VOCAB_STORE.splice(i, 1)
}

export async function mockGenerateCard(payload: GeneratePayload): Promise<VocabNote> {
  // mock：无后端（vite 单独跑）时返回合成卡，只在内存里留一份
  await new Promise((r) => setTimeout(r, 300))
  const surface = payload.word
  const term = surface.toLowerCase()
  const sentence = payload.sentence
    ? payload.sentence.replace(new RegExp(`\\b${surface}\\b`, 'i'), (m) => `**${m}**`)
    : surface
  const card: VocabNote = {
    term,
    surface,
    sentence,
    meaning: `（占位卡）后端未连接，这是本地 mock 数据`,
    roots: [`刷新页面重连后端后，右键重新生成即得真卡（AI 拆解 + 写入笔记 md）`],
    anchor: { pdf: payload.pdf, page: payload.page || 1, sel: [0, 0, 0, 0] },
  }
  if (!VOCAB_STORE.some((n) => n.anchor?.pdf === payload.pdf && n.term === term)) VOCAB_STORE.push(card)
  return card
}

// mock 批注：无后端时不落盘，仅内存 retained（vite 单独跑调试挂载/悬停用）
const MOCK_ANNOS: AnnoNote[] = []

export async function mockGetAnnos(pdf: string): Promise<AnnoNote[]> {
  return MOCK_ANNOS.filter((a) => a.pdf === pdf)
}

export async function mockCreateAnno(payload: AnnoPayload): Promise<AnnoNote> {
  const rec: AnnoNote = {
    id: `mock${Date.now().toString(36)}`,
    pdf: payload.pdf,
    page: payload.page,
    rect: payload.rect,
    quote: payload.quote,
    text: payload.text,
    author: payload.author || 'ADMIN',
    createdAt: new Date().toLocaleString('sv-SE'),
  }
  MOCK_ANNOS.push(rec)
  return rec
}

export async function mockUpdateAnno(id: string, text: string): Promise<AnnoNote> {
  const a = MOCK_ANNOS.find((x) => x.id === id)
  if (!a) throw new Error('该批注不存在')
  a.text = text
  a.updatedAt = new Date().toLocaleString('sv-SE')
  return a
}

export async function mockDeleteAnno(id: string): Promise<void> {
  const i = MOCK_ANNOS.findIndex((x) => x.id === id)
  if (i < 0) throw new Error('该批注不存在')
  MOCK_ANNOS.splice(i, 1)
}

export const mockBackend = {
  listDir: mockListDir,
  getVocabNotes: mockGetVocabNotes,
  generateCard: mockGenerateCard,
  updateVocab: mockUpdateVocab,
  deleteVocab: mockDeleteVocab,
  getAnnos: mockGetAnnos,
  createAnno: mockCreateAnno,
  updateAnno: mockUpdateAnno,
  deleteAnno: mockDeleteAnno,
}
