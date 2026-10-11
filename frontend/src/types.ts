// Pj13 预览前端 · 共享类型
// 后端仅保留接口契约：这些类型同时定义后端 API 的 payload/response 形状。

/** PDF 锚点坐标（anchor.sel，占位 0,0,0,0 = 页级） */
export interface VocabAnchor {
  pdf: string
  page: number
  sel: [number, number, number, number]
}

/** 一条生词卡（库表 vocab_notes 一行；(pdf, term) 唯一定位） */
export interface VocabNote {
  /** 关键词 lemma（小写，如 mitigate） */
  term: string
  /** 论文里实际出现的词形（原句 **加粗** 段，如 mitigating），用于文本层定位 */
  surface: string
  /** 原文句子（surface 以 ** ** 包裹） */
  sentence: string
  /** 词根拆解后的中文释义 */
  meaning: string
  /** 词根词缀逐条解析 */
  roots: string[]
  /** PDF 锚点 */
  anchor: VocabAnchor | null
  createdAt?: string
  /** 人工改过释义/词根的时间（生成时无此字段） */
  updatedAt?: string
}

/** 生词卡可改字段（PUT /api/vocab）：锚点与词形是标色/定位依据，不开放修改 */
export interface VocabPatch {
  meaning?: string
  roots?: string[]
}

/** 一条批注：用户选中区块 → 手写 markdown 正文。
 *  锚点 rect = 选中区块【末行】在页面上的归一化矩形 (x, y, w, h)（除以页宽/页高，
 *  与缩放无关）→ 右侧卡片按当前渲染页宽乘回去，即得红线起点（句子末尾）。 */
export interface AnnoNote {
  id: string
  pdf: string
  page: number
  rect: [number, number, number, number]
  /** 选中区块原文（引用，卡片里以引文样式显示） */
  quote: string
  /** 用户手写正文（markdown 源文本） */
  text: string
  author: string
  createdAt: string
  /** 人工改过正文的时间（新建时无此字段） */
  updatedAt?: string
}

/** 新建批注请求（后端 POST /api/anno） */
export interface AnnoPayload {
  pdf: string
  page: number
  rect: [number, number, number, number]
  quote: string
  text: string
  author?: string
}

/** 素材库（项目根 assests/）里的一项：只有子目录与 PDF 两类，其它文件不出现 */
export interface FsEntry {
  /** 显示名（文件/目录名，不含路径） */
  name: string
  /** 相对素材库根的 POSIX 路径（如 杨振宁相关理论专题/相变讲义.pdf），同时用作阅读/笔记的键 */
  path: string
  type: 'dir' | 'pdf'
  /** 仅 pdf：可直接喂给 pdfjs 的 URL（相对页面基址，兼容网关前缀托管） */
  url?: string
  /** 仅 pdf：字节大小 */
  size?: number
  /** 仅 pdf：修改时间（ISO） */
  mtime?: string
  /** 仅 dir：目录内递归的 PDF 数量 */
  pdfCount?: number
}

/** 一次目录列举的返回（GET /api/fs/list?path=） */
export interface FsListing {
  /** 当前目录相对路径（'' = 素材库根） */
  path: string
  /** 上级目录相对路径；已处根目录时为 null */
  parent: string | null
  entries: FsEntry[]
}

/** 屏幕坐标矩形（viewport 坐标，position: fixed 用） */
export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

/** 生成单词卡请求（后端 POST /api/vocab/generate） */
export interface GeneratePayload {
  /** 右键命中的词形（文本层原词，如 mitigating） */
  word: string
  /** 词所在原句（文本层提取，无加粗） */
  sentence?: string
  /** 当前 PDF 的相对路径（如 杨振宁相关理论专题/相变讲义.pdf）：笔记落同目录同名 .jsonl */
  pdf: string
  /** 词所在页码 */
  page?: number
  /** 点击点页面归一化坐标 [xRatio, yRatio]（服务端存入 anchor.sel，标记时精确锚定该次出现） */
  point?: [number, number]
}
