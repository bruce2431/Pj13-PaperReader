// 全文搜索索引 —— 借鉴 PdfCraft 的 find→comment 链路
//
// 不依赖页面是否已经渲染：直接用 pdfjs 的 textContent 建「字符流 + 每字符盒」，
// 命中结果按页归一化（0~1），缩放时不必重算。几何口径与 PdfViewer 的采样行一致
// （基线 y、字高 1.14em、top = y - 0.86em），高亮层因此能贴住 canvas 墨迹。
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface SearchHit {
  page: number
  /** 命中原文（保留大小写，空白折叠） */
  quote: string
  /** 页面归一化矩形（x, y, w, h）；按阅读顺序，最后一条是命中末行（批注锚点） */
  rects: Array<[number, number, number, number]>
}

interface CharBox {
  /** 归一化后的单字符（小写；空白统一成 ' '） */
  ch: string
  /** 原始字符（拼回 quote 用） */
  orig: string
  x: number
  y: number
  w: number
  h: number
  /** 基线（保留 1 位小数）——同一行合并矩形用 */
  line: number
}

export interface PageText {
  page: number
  width: number
  height: number
  /** 归一化文本：小写、空白折叠成单个空格 */
  doc: string
  /** 与 doc 一一对应 */
  chars: CharBox[]
}

// 无 DOM（单测/SSR）时退化为等宽；浏览器里按 sans-serif 量单字符 advance
const advCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
const advTables = new Map<string, Map<string, number>>()

function charAdvances(fs: number, str: string): number[] {
  const key = fs.toFixed(2)
  let tab = advTables.get(key)
  if (!tab) {
    tab = new Map()
    advTables.set(key, tab)
  }
  if (advCtx) advCtx.font = `${fs}px sans-serif`
  const out: number[] = []
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    let w = tab.get(ch)
    if (w === undefined) {
      w = advCtx ? advCtx.measureText(ch).width : 1
      if (!(w > 0)) w = 1
      tab.set(ch, w)
    }
    out.push(w)
  }
  return out
}

function foldLigatures(s: string): string {
  return s
    .replace(/\uFB00/g, 'ff')
    .replace(/\uFB01/g, 'fi')
    .replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi')
    .replace(/\uFB04/g, 'ffl')
}

/** 搜索用的归一化：连字折叠 + 小写 + 空白折叠 */
export function normalizeSearch(s: string): string {
  return foldLigatures(s).toLowerCase().replace(/\s+/g, ' ').trim()
}

interface RawChar {
  ch: string
  x: number
  y: number
  w: number
  h: number
  line: number
}

/** 提取一页的字符流与几何（scale=1 的页面坐标系）。结果可缓存，与缩放无关。 */
export async function extractPageText(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageText> {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const tc = (await page.getTextContent()) as unknown as {
    items: Array<{ str?: string; width?: number; height?: number; transform?: number[]; hasEOL?: boolean }>
  }
  const raw: RawChar[] = []
  let prev: { endX: number; y: number; fs: number } | null = null

  for (const item of tc.items) {
    const str = item.str
    if (!str || !item.transform) continue
    // 旋转文本（竖排 sidebar 等）没有正常水平基线，混进来会把行序打散
    if (Math.abs(item.transform[1]) > Math.abs(item.transform[3])) continue
    const [ix, iy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
    const fs = Math.abs(item.transform[3]) || item.height || 10
    const iw = (item.width || 0) * viewport.scale
    const line = Math.round(iy * 10) / 10
    // 跨 item 的词间空格不写在字符流里：几何间隙 > 0.15em 或 hasEOL 时补一个空格
    if (prev) {
      const newLine = item.hasEOL || Math.abs(iy - prev.y) > 0.5 * Math.max(fs, prev.fs)
      const gap = ix - prev.endX
      if (newLine || gap > 0.15 * Math.max(fs, prev.fs)) {
        raw.push({ ch: ' ', x: prev.endX, y: iy, w: Math.max(0, gap), h: 1.14 * fs, line })
      }
    }
    const adv = charAdvances(fs, str)
    let tot = 0
    for (const a of adv) tot += a
    const k = iw > 0 && tot > 0 ? iw / tot : 1
    let x = ix
    for (let i = 0; i < str.length; i++) {
      const w = adv[i] * k
      raw.push({ ch: str[i], x, y: iy - 0.86 * fs, w, h: 1.14 * fs, line })
      x += w
    }
    prev = { endX: x, y: iy, fs }
  }

  // 归一化：小写、空白折叠；chars 与 doc 一一对应
  let doc = ''
  const chars: CharBox[] = []
  let pendingSpace: RawChar | null = null
  const pushChar = (r: RawChar, ch: string, orig: string) => {
    doc += ch
    chars.push({ ch, orig, x: r.x, y: r.y, w: r.w, h: r.h, line: r.line })
  }
  for (const r of raw) {
    const low = foldLigatures(r.ch).toLowerCase()
    if (!low) continue
    if (/^\s+$/.test(low)) {
      if (doc) pendingSpace = r
      continue
    }
    if (pendingSpace) {
      pushChar(pendingSpace, ' ', ' ')
      pendingSpace = null
    }
    for (const ch of low) pushChar(r, ch, r.ch)
  }

  return { page: pageNumber, width: viewport.width, height: viewport.height, doc, chars }
}

/** 在已提取的页文本中查找 query 的全部命中。 */
export function findHits(pt: PageText, query: string, page = pt.page): SearchHit[] {
  const q = normalizeSearch(query)
  if (!q || !pt.doc) return []
  const hits: SearchHit[] = []
  for (let start = pt.doc.indexOf(q); start !== -1; start = pt.doc.indexOf(q, start + 1)) {
    const end = start + q.length
    const groups = new Map<number, { x0: number; x1: number; top: number; bottom: number }>()
    let quote = ''
    for (let i = start; i < end; i++) {
      const c = pt.chars[i]
      if (!c) continue
      quote += c.orig
      if (c.ch === ' ') continue
      const g = groups.get(c.line)
      if (g) {
        g.x0 = Math.min(g.x0, c.x)
        g.x1 = Math.max(g.x1, c.x + c.w)
        g.top = Math.min(g.top, c.y)
        g.bottom = Math.max(g.bottom, c.y + c.h)
      } else {
        groups.set(c.line, { x0: c.x, x1: c.x + c.w, top: c.y, bottom: c.y + c.h })
      }
    }
    if (!groups.size || !(pt.width > 0 && pt.height > 0)) continue
    const rects: Array<[number, number, number, number]> = []
    for (const g of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const r: [number, number, number, number] = [
        g[1].x0 / pt.width,
        g[1].top / pt.height,
        (g[1].x1 - g[1].x0) / pt.width,
        (g[1].bottom - g[1].top) / pt.height,
      ]
      if (r[2] > 0 && r[3] > 0) rects.push(r)
    }
    if (!rects.length) continue
    hits.push({ page, quote: quote.replace(/\s+/g, ' ').trim(), rects })
  }
  return hits
}
