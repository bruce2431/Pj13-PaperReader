// PdfViewer —— pdf.js 渲染 + 文本层 + 生词标色层 + 鼠标交互
// 交互约定（用户定案）：
//   被标记的生词 = 其它颜色的底（叠加层矩形，floria 蓝）
//   点击生词 → 打开锚定批注卡（AnnotationCard，按词在页面位置选左右侧）
//   选中文本 / 长按取词并松开 → 自报宿主官方引用浮窗 floria-quote-open（宿主承载
//   生成单词卡 / 创建批注 / 发送给 AI 三动作；Pj13 自建右键菜单已于 2026-09-28 删除）
//   批注卡 = 右侧空白区的悬浮卡，句尾牵红线连出（AnnoLayer）
// 性能（2026-08-24）：页懒渲染（IntersectionObserver，仅渲染视口附近页）修复启动慢；
//   Ctrl+滚轮缩放 + fit-width 提供独立 PDF 放大。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { AnnoNote, VocabNote, ScreenRect } from '../types'
import { isTouchUI } from '../touch'
import { AnnoLayer } from './AnnoLayer'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfViewerHandle {
  scrollToPage(page: number): void
  fitWidth(): void
}

/** 生成中的词（App 的 busy 卡对应，可多个并行）：带生成语境（原句 + 页码 + 点击点
 *  归一化坐标），橘标与蓝标同一套语境锚定管线，只标生成它的那次出现 */
export interface PendingWord {
  word: string
  sentence: string
  page?: number
  sel?: [number, number] | null
}

/** 批注锚点：选中区块的引用原文 + 【末行】的页面归一化矩形（红线起点=句尾）。
 *  无选区 / 选区不在文本层上 → null，调用方回退到取词矩形。 */
export interface AnnoAnchor {
  quote: string
  page: number
  rect: [number, number, number, number]
  /** 末行屏幕矩形（编辑卡定位用） */
  screen: ScreenRect
}

/** 预览页选区快照（2026-09-28 三动作迁官方引用浮窗）：发 floria-quote-open 与
 *  回执 floria-quote-action 的分发**共用这一份**。宿主只回发动作 id，业务数据必须
 *  在开窗那一刻就地快照——点浮窗行会让 iframe 选区失效，事后取不回来。 */
export interface QuoteSnap {
  /** 选区原文（引用浮窗 payload + 批注 quote） */
  text: string
  /** 选区起页 / 止页（跨页 → 引用令牌 #p<s>-<e>） */
  page: number
  pageEnd: number
  /** 选区末行在 **iframe 视口**的矩形（宿主叠 .preview-frame 偏移后定位浮窗） */
  rect: { x: number; y: number; w: number; h: number }
  /** 生成单词卡：选区起点词形 + 原句 */
  word: string
  sentence: string
  /** 词锚点页面归一化点击点（标记端精确锚定该次出现） */
  point?: [number, number]
  /** 词屏幕矩形（生成卡贴词定位） */
  wordRect?: ScreenRect
  /** 创建批注锚点；选区未落在文本层上时为 null（该动作不可用） */
  anno: AnnoAnchor | null
}

interface PdfViewerProps {
  src: string
  notes: VocabNote[]
  /** 本篇已有批注（右侧悬浮卡，AnnoLayer 渲染） */
  annos: AnnoNote[]
  scale: number
  /** 载入后页宽超视口自动缩到适宽；已有保存缩放（pj13.scale）时 App 传 false，尊重用户缩放 */
  shrinkToFitOnLoad?: boolean
  /** 生成中的词（App 的 busy 卡对应，可多个并行）：完成/取消即清 */
  pendingWords?: PendingWord[]
  onScaleChange: (s: number) => void
  onWordOpen: (note: VocabNote, rect: ScreenRect) => void
  /** 选区快照 → App 转发 floria-quote-open 请宿主开官方引用浮窗（三动作自建菜单已废） */
  onQuote: (snap: QuoteSnap) => void
  /** 帧内点击/滚动 → 通知宿主关窗（iframe 内事件不冒泡到宿主 document，宿主自有关窗策略失效） */
  onQuoteClose: () => void
  onPageChange?: (page: number) => void
  onPageCount?: (count: number) => void
  onLoadState?: (state: 'loading' | 'ready' | 'error') => void
  /** 批注气泡「编辑」：把批注与气泡屏幕位置交给 App 打开编辑卡 */
  onAnnoEdit: (anno: AnnoNote, at: { x: number; y: number }) => void
  /** 批注气泡「删除」（气泡内已二次确认） */
  onAnnoDelete: (anno: AnnoNote) => void
}

/** 词字符判定（词界 = 非词字符）：字母/数字 + ASCII 连字符。连字符必须算词字符——
 *  intra-attention / self-attention 这类连字符复合词才整体成词，否则词界扩展在 '-'
 *  处截断：标记只盖前半（user 反馈「intra-attention 无法标记整个词汇」）、取词
 *  补全与选区吸附同样短一截。/i 不可少：大写字母不是词界（旧版把 ConvS2S 的尾 S
 *  判成边界，hit 只包前缀）。本文件三处（highlightTerms / marksFromLines /
 *  locateWordFrag）必须同源，改这里即可（历史上三份各自为政，加 /i 时漏了连字符）。 */
const isWordChar = (c: string | undefined): boolean => !!c && /[a-z0-9-]/i.test(c)

/** 在文本层 span 内把生词词形包成行内高亮元素。
 *  不用「测量 range → 绝对定位矩形」的快照方案：iPad/iOS 的布局时序与桌面不同，
 *  量出的矩形与最终渲染词形错位且大小不符（用户反馈）；行内包裹与词同流，
 *  任何平台/缩放下都逐像素贴合。必须从后往前 splitText，避免 offset 失效。 */
function highlightTerms(textLayer: HTMLElement, notes: VocabNote[]): void {
  const spans = Array.from(textLayer.querySelectorAll('span'))
  // /i 不可少：早期版本只测 [a-z0-9]，大写字母被判成词界 → surface 后紧跟大写字母时
  // （ConvS2S 的尾 S、ByteNet 等）pv-hit 只包到前缀，tap 找不到 hit（user 反馈点不出卡）
  const wb = (c: string | undefined) => !isWordChar(c) // 含连字符：见 isWordChar
  for (const note of notes) {
    const term = note.surface.toLowerCase()
    if (!term) continue
    for (const span of spans) {
      // span 可能已被更早的 note 包裹（嵌套），只处理纯文本节点
      const tn = span.firstChild
      if (!tn || tn.nodeType !== Node.TEXT_NODE) continue
      const textNode = tn as Text
      const text = tn.textContent || ''
      const hits: Array<{ start: number; end: number }> = []
      let from = 0
      while (true) {
        const idx = text.toLowerCase().indexOf(term, from)
        if (idx === -1) break
        if (wb(text[idx - 1]) && wb(text[idx + term.length])) {
          hits.push({ start: idx, end: idx + term.length })
        }
        from = idx + term.length
      }
      for (let i = hits.length - 1; i >= 0; i--) {
        const { start, end } = hits[i]
        textNode.splitText(end)
        const mid = textNode.splitText(start)
        const hit = document.createElement('span')
        hit.className = 'pv-hit'
        hit.dataset.term = note.term
        hit.textContent = mid.textContent
        mid.parentNode?.replaceChild(hit, mid)
      }
    }
  }
}

/** canvas fillText 采样（终极标色方案）：
 *  pdf.js 画每个字形都单独调一次 ctx.fillText，位置含 PDF 内容流的逐字 TJ 调整
 *  （TeX 两端对齐的词间距伸缩也在其中）。DOM 只对字符串做普通排版，换任何字体
 *  都复现不了这些逐字偏移（user 反馈桌面半字符 / iPad 一字符残余的根因）→
 *  直接在 canvas 侧记录每个字形的真实落点，用同一坐标系画标记矩形。 */
interface PaintChunk {
  t: string
  x: number
  y: number
  w: number
  s: number
}
interface WordMark {
  term: string
  left: number
  top: number
  width: number
  height: number
  /** 盒子来自「item 内近似映射」（本 item 无 canvas 字形采样，如整页位图的扫描件）：
   *  位置与真实墨迹有 1~5pt 漂移，交给 snapMarksToInk 用位图墨迹校正 */
  approx?: boolean
}

const pvOrigFillText = CanvasRenderingContext2D.prototype.fillText

/** 包一层 ctx.fillText 记录所有字形落点（设备像素；fillText 入参是字形局部坐标，
 *  乘 ctx 当前矩阵映射到设备像素）。render 前安装，返回本次渲染的采样数组。 */
function paintRecorder(ctx: CanvasRenderingContext2D): PaintChunk[] {
  const arr: PaintChunk[] = []
  ctx.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number) {
    const m = this.getTransform()
    const px = m.a * x + m.c * y + m.e
    const py = m.b * x + m.d * y + m.f
    const pw = this.measureText(text).width * Math.abs(m.a)
    const ps = (parseFloat(this.font) || 0) * Math.abs(m.a)
    // 非有限采样会以 NaN 污染下游字符盒（词尾盒 x1=NaN → 选区/mark 宽 NaN，样式
    // 拒收后高亮隐身，user 反馈 inherently 无法选中）→ 坏采样不入列
    if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pw) && Number.isFinite(ps)) {
      arr.push({ t: String(text), x: px, y: py, w: pw, s: ps })
    } else {
      console.warn('[pv] 非有限字形采样已丢弃', JSON.stringify(String(text)), px, py, pw, ps)
    }
    pvOrigFillText.call(this, text, x, y)
  } as unknown as typeof ctx.fillText
  return arr
}

/** 采样重建出的一行字符流：text 与 boxes 一一对应（含合成空格的盒） */
interface Line {
  y: number
  s: number
  text: string
  boxes: Array<{ x0: number; x1: number; s: number; approx?: boolean }>
}

/** 无字形采样时给 item 铺宽用的字符宽度表（按字号缓存，单字符 advance）。
 *  用浏览器自身字体度量量单个字符：比「非空格字符均分」准得多——均分把空格算成 0 宽、
 *  把 i/l 与 m/w 当等宽，行内累积右偏（扫描件 OCR item 整个是一行时尤其明显）。
 *  没有 DOM（单测环境）时退化成全部 1 → 等价于旧的均分。 */
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
      if (!(w > 0)) w = 1 // 零宽字形（组合符等）退化按窄字符算，防 tot=0 整 item 塌成一点
      tab.set(ch, w)
    }
    out.push(w)
  }
  return out
}

/** 上标引用号边界（buildLines 行组装用）：两字符字号比 <0.8 且小字号一方基线抬高
 *  （视口 y 更小）>0.1×大字号 → 两者之间是词界。Nature 式无括号引用号（fs≈0.57×、
 *  抬 ~0.24em）必拆；同字号数字（ConvS2S）与降低基线的下标（H2O、h_t）不是引用，
 *  不拆（词内下标是词形的一部分）。只拆「抬高」：x² 类上标数学一并拆出，可接受。 */
function isCiteBoundary(p: { y: number; s: number }, c: { y: number; s: number }): boolean {
  const hi = Math.max(p.s, c.s)
  if (!(hi > 0) || Math.min(p.s, c.s) >= 0.8 * hi) return false
  const dy = c.s < p.s ? p.y - c.y : c.y - p.y // 小字号一方相对大字号的抬升量
  return dy > 0.1 * hi
}

/** 词尾引用号修剪（仅用于词形/term 推导；mark 几何与选区高亮不动）。isCiteBoundary
 *  拆出 "piperazines 25," 后，locateWordFrag 的整词扩展仍会把 "25,"（句逗同小字号、
 *  与 25 粘连）带进 frag → term 成 "piperazines25,"。从词尾反向吃掉「字号明显小于
 *  行主字号 && 字符 ∈ 引用号字符类（数字/括号/引号/逗号/空格）」的盒子，遇主字号
 *  词字符即停；至少保留 1 字符（首盒字号作 ref，纯引用号选段自身不再缩）。 */
function trimCiteTail(line: Line, s: number, e: number): number {
  const ref = line.boxes[s]?.s ?? line.s
  let end = e
  while (end > s + 1) {
    const b = line.boxes[end - 1]
    const ch = line.text[end - 1]
    if (b && b.s < 0.8 * Math.max(ref, 1) && /[0-9\])('’，, ]/.test(ch)) end--
    else break
  }
  return end
}

/** 从「canvas 采样位置 + textContent Unicode 文本」重建每字符盒（CSS 像素）。
 *  canvas 的 fillText 只画可见字形，且内嵌字体下入参是字体私有编码（PUA），读不出
 *  文本 → 文本取 textContent.items（Unicode），位置取 paints（canvas 真实落点）。
 *  item ↔ paints 按几何关联（基线一致 + x 落在 item 宽度范围 ±0.25em），item 内
 *  非空格字符与格子按「段」映射（字符段=按空格切、格子组=按 >0.15em 间隙切；格数
 *  ==字符数精确对位，连字共享格、重音并格自动兼容；个别字形整支未画出时缺格不再
 *  摊给全 item → 词尾不短字母）。
 *  行内 x 间隙 > 0.15em 处补合成空格（跨 item 词间隙，TeX 的空格是位置而非字符）。 */
function buildLines(
  items: Array<{ str?: string; width?: number; transform?: number[] }>,
  paints: PaintChunk[],
  dpr: number,
  viewport: { convertToViewportPoint(x: number, y: number): number[]; scale: number },
): Line[] {
  type Box = { ch: string; x0: number; x1: number; y: number; s: number; approx?: boolean }
  const cells = paints
    .filter((p) => p.t.trim())
    .map((p) => ({ x0: p.x / dpr, x1: (p.x + p.w) / dpr, y: p.y / dpr, s: p.s / dpr }))
  const all: Box[] = []
  for (const item of items) {
    const str = item.str
    if (!str || !item.transform) continue
    const [ix, iy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
    // 旋转文本（|b|>|d|，竖排 arXiv sidebar 等）：无正常水平基线，格子关联不上，
    // 字符按 y 排序后会散进正文行之间把行序打散（句子定位/匹配全坏）→ 整体跳过
    if (Math.abs(item.transform[1]) > Math.abs(item.transform[3])) continue
    const iw = (item.width || 0) * viewport.scale
    const fs = Math.abs(item.transform[3]) * viewport.scale
    const tol = 0.25 * fs
    const mine = iw > 0
      ? cells
          .filter((c) => Math.abs(c.y - iy) <= tol && c.x0 >= ix - tol && c.x1 <= ix + iw + tol)
          .sort((a, b) => a.x0 - b.x0)
      : []
    const M = mine.length
    const nsIdx: number[] = []
    for (let i = 0; i < str.length; i++) if (str[i] !== ' ') nsIdx.push(i)
    const N = nsIdx.length
    if (!N) continue
    const boxes: Array<{ x0: number; x1: number; approx?: boolean }> = new Array(str.length)
    if (!M) {
      // 整 item 零格子（字形整支未被 fillText 画出/被容差过滤/零宽）→ 按「各字符宽度
      // 比例」铺开 item 全宽。绝不能丢字符：丢一个字符词就被截断（user 反馈 inherently
      // 尾 y 缺失 → surface 残成 inherentl、mark 缺尾字母、选区定位失败三连）。
      // 曾按「非空格字符均分」：OCR 的 item 常是一整行，空格在均分里不占宽 → 每个字符
      // 被摊宽、行内越靠后的词起点越右偏（user 反馈「标记了两个词」：inhibition 的框
      // 爬过后一个词 in）。按宽度比例铺开后词首词尾落在正确字形上，位置仍是近似的。
      const adv = charAdvances(fs, str)
      let tot = 0
      for (let i = 0; i < str.length; i++) tot += adv[i]
      const k = tot > 0 ? iw / tot : 0
      let x = ix
      for (let i = 0; i < str.length; i++) {
        const nx = x + adv[i] * k
        boxes[i] = { x0: x, x1: nx, approx: true }
        x = nx
      }
    } else {
      // 分段映射：字符段（str 按空格切）↔ 格子组（cells 按 >0.15em x 间隙切，间隙 =
      // 未画出的空格 advance）。item 内部分字形可能整支未被 fillText 画出（pdf.js 走
      // 其它绘制路径）→ 全局比例映射把缺格摊给全 item，后文所有词的格子整体左移、
      // 词尾短一字母（user 反馈 hallucination 缺尾 n：词段之前的两个缺格使其尾 n 映
      // 到倒数第二格）。分段后缺格只影响所在段：格数==字符数精确 1:1，否则段内比例；
      // 段数对不上（异常 item）→ 旧全局比例兜底。
      const charSegs: number[][] = []
      let curChars: number[] = []
      for (let i = 0; i < str.length; i++) {
        if (str[i] === ' ') {
          if (curChars.length) charSegs.push(curChars)
          curChars = []
        } else curChars.push(i)
      }
      if (curChars.length) charSegs.push(curChars)
      const cellSegs: Array<typeof mine> = []
      let cc: typeof mine = []
      for (let j = 0; j < M; j++) {
        if (cc.length && mine[j].x0 - cc[cc.length - 1].x1 > 0.15 * fs) {
          cellSegs.push(cc)
          cc = []
        }
        cc.push(mine[j])
      }
      if (cc.length) cellSegs.push(cc)
      if (charSegs.length === cellSegs.length) {
        for (let sg = 0; sg < charSegs.length; sg++) {
          const cs = charSegs[sg]
          const cg = cellSegs[sg]
          const K = cs.length
          const C = cg.length
          for (let k = 0; k < K; k++) {
            if (C === K) boxes[cs[k]] = { x0: cg[k].x0, x1: cg[k].x1 }
            else {
              const j0 = Math.floor((k * C) / K)
              const j1 = Math.max(j0, Math.min(C - 1, Math.floor(((k + 1) * C) / K) - 1))
              boxes[cs[k]] = { x0: cg[j0].x0, x1: cg[j1].x1, approx: true }
            }
          }
        }
      } else {
        for (let k = 0; k < N; k++) {
          const j0 = Math.floor((k * M) / N)
          const j1 = Math.max(j0, Math.min(M - 1, Math.floor(((k + 1) * M) / N) - 1))
          boxes[nsIdx[k]] = { x0: mine[j0].x0, x1: mine[j1].x1, approx: true }
        }
      }
    }
    for (let i = 0; i < str.length; i++) {
      if (boxes[i]) continue
      const prev = boxes[i - 1]
      const next = boxes[i + 1]
      boxes[i] = { x0: prev?.x1 ?? next?.x0 ?? ix, x1: next?.x0 ?? prev?.x1 ?? ix }
    }
    // 首末字符盒钳到 item 全宽 [ix, ix+iw]：边缘字形常因 ±0.25em 容差被过滤
    // （末字形 x1 略超 item.width）→ 比例映射把末字符压到倒数第二格，mark 短
    // 一个字母（user 反馈 sectors 缺尾 s）。item 起止是字符流的真实范围。
    boxes[0].x0 = Math.min(boxes[0].x0, ix)
    boxes[str.length - 1].x1 = Math.max(boxes[str.length - 1].x1, ix + iw)
    // 终检：任何非有限盒（NaN/±Infinity 混进映射或钳位链）就地修复——带病盒一旦
    // 进行数据，选区/mark 宽即 NaN（样式拒收 → 高亮隐身，user 反馈 inherently 无法
    // 选中、其 mark 缺宽）。x0 坏 → 回落 item 起点 ix；x1 坏 → 收缩到 x0（零宽但
    // 有限，视觉短一点好过整词隐身）；warn 留痕以便溯源真凶字段
    const badBoxes: number[] = []
    for (let i = 0; i < str.length; i++) {
      const b = boxes[i]
      if (!Number.isFinite(b.x0)) {
        badBoxes.push(i)
        b.x0 = ix
      }
      if (!Number.isFinite(b.x1)) {
        badBoxes.push(i)
        b.x1 = b.x0
      }
    }
    if (badBoxes.length)
      console.warn('[pv] 非有限字符盒已修复', JSON.stringify(str), badBoxes.join(','))
    // approx 必须随盒带出：行组装靠 it.approx 判「本行有近似盒」，丢了它
    // snapMarksToInk 的入口门就不成立（整条吸附链是死代码）
    for (let i = 0; i < str.length; i++)
      all.push({ ch: str[i], x0: boxes[i].x0, x1: boxes[i].x1, y: iy, s: fs, approx: boxes[i].approx })
  }
  all.sort((a, b) => a.y - b.y || a.x0 - b.x0)
  const clustered: Box[][] = []
  for (const b of all) {
    const last = clustered[clustered.length - 1]
    if (last && Math.abs(b.y - last[0].y) <= 0.3 * Math.max(b.s, 1)) last.push(b)
    else clustered.push([b])
  }
  const lines: Line[] = []
  for (const cl of clustered) {
    // 簇内按 x 重排：TeX 下标基线略低（Δy≈0.29em，在 0.3em 聚簇容差内并入本行），
    // 但上面的 (y,x) 主排序把下标甩到本行所有正文之后 → 文本序成 "…inherently"+"t t−1"
    //（user 反馈 inherently 选中后词界扩展吞下标 → 末盒在行首 → 宽度为负 → 高亮隐身）。
    // 视觉行内按 x 排序才是阅读序（下标回位 h_t / h_t−1）。
    cl.sort((a, b) => a.x0 - b.x0)
    let text = ''
    const boxes: { x0: number; x1: number; s: number; approx?: boolean }[] = []
    let prev: { x0: number; x1: number; y: number; s: number; approx?: boolean } | null = null
    for (const it of cl) {
      // 跨 item 的词间空格不会出现在字符流里 → x 间隙 > 0.15em 处补合成空格。
      // 另一处词界：上标引用号（Nature 式 25）字号小且基线抬高，x 上却紧贴前词
      //（studies22）→ 不补空格行文本就粘成 "studies22"，选词/定位全脏。见 isCiteBoundary。
      if (prev) {
        const gapSplit = it.x0 - prev.x1 > 0.15 * it.s
        const citeSplit = isCiteBoundary(prev, it)
        if (gapSplit || citeSplit) {
          text += ' '
          boxes.push({ x0: prev.x1, x1: it.x0, s: it.s, approx: it.approx })
        }
      }
      text += it.ch
      boxes.push({ x0: it.x0, x1: it.x1, s: it.s, approx: it.approx })
      prev = it
    }
    lines.push({ y: cl[0].y, s: cl[0].s, text, boxes })
  }
  return lines
}

/** 匹配生词 → mark 矩形。匹配在「全部行去空格展平」的文本上进行（每字符映射回
 *  原行/原索引，可取回字符盒）：行文本的空格是合成猜测（x 间隙 > 0.15em），斜体
 *  字距（f inance）会被误劈成词间空格 → 原文匹配漏词/短词；去空格后词内合成空格
 *  自动愈合，同一视觉行被拆成多簇的词（inherentl|y）也能拼回完整词形。
 *  词界规则（user 反馈 art 误标 part）：匹配起点必须真实处于词首（前一原始字符
 *  非词字符），词中子串（art ⊂ part、ration ⊂ generation）一律跳过——旧的
 *  「终点沾词尾就左扩到词首」逻辑废除（art ⊂ part 正是栽在它手里）；起点在词首
 *  时向右扩到词尾（surface 为片段/屈折词干：mitigat → mitigating）。
 *  语境锚定（user 反馈同词全文乱标，不同语境词义不同）——三级收窄：
 *    1. anchor.sel 点击点（生成时存入的页面归一化坐标）→ 在采样几何上取离点最近
 *       的字符 → 扩到整词 = 生成它的那一次出现，最精确；
 *    2. note.sentence 原句：归一化（剔除加粗星号、去空白、连字折叠）后在展平文本中定位
 *       （整句优先，失败再试词形 ±48 字符局部窗口——旧句含内容流序的页缘杂字，
 *       整句按几何序对不上）；词形出现位置限定在句窗口内；
 *    3. 回退：仅在 anchor.page 锚定页内做全部词首匹配（旧数据保可用性）。
 *  每级都要求本页 (page 参数) 匹配得上，其它页一律不标。 */
function marksFromLines(
  lines: Line[],
  entries: Array<{ surface: string; term: string; sentence?: string; page?: number; sel?: [number, number] | null }>,
  page?: number,
  pageSize?: { w: number; h: number } | null,
): WordMark[] {
  const marks: WordMark[] = []
  if (!lines.length || !entries.length) return marks
  const foldLig = (s: string) =>
    s
      .replace(/\uFB00/g, 'ff')
      .replace(/\uFB01/g, 'fi')
      .replace(/\uFB02/g, 'fl')
      .replace(/\uFB03/g, 'ffi')
      .replace(/\uFB04/g, 'ffl')
  const norm = (s: string) => foldLig(String(s || '').replace(/\*\*/g, '').toLowerCase()).replace(/\s+/g, '')
  // 展平所有行的非空格字符 → 归一化匹配文本 doc + 每字符回指（行、原始索引）。
  // 归一化可能变长（ﬁ → fi），spans 记录每个原字符在 doc 中的 [off, off+len)。
  const spans: Array<{ off: number; len: number; line: number; idx: number }> = []
  let doc = ''
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li].text
    for (let i = 0; i < text.length; i++) {
      const n = norm(text[i])
      if (!n) continue
      spans.push({ off: doc.length, len: n.length, line: li, idx: i })
      doc += n
    }
  }
  if (!doc) return marks
  const spanAt = (off: number): number => {
    let lo = 0
    let hi = spans.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (spans[mid].off + spans[mid].len <= off) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  // 展平字符的原始邻居（跨行补位）：词界校验用原始字符（含合成空格）。
  // 仅「同一视觉行的拆簇续片」补位（Δy ≤ 0.8em，如独立 y 簇/inherentl|y）；
  // 真正的下一行（行距 ≥1.2em）视作词界——否则行尾词会吞掉下一行首词
  //（inherently 行尾 → 词界扩展爬进下一行 sequential）。
  const charBefore = (si: number): string | undefined => {
    const sp = spans[si]
    if (sp.idx > 0) return lines[sp.line].text[sp.idx - 1]
    if (sp.line > 0) {
      const prv = lines[sp.line - 1]
      if (Math.abs(lines[sp.line].y - prv.y) <= 0.8 * Math.max(prv.s, lines[sp.line].s))
        return prv.text.slice(-1) || undefined
    }
    return undefined
  }
  const charAfter = (si: number): string | undefined => {
    const sp = spans[si]
    const t = lines[sp.line].text
    if (sp.idx + 1 < t.length) return t[sp.idx + 1]
    if (sp.line + 1 < lines.length) {
      const nxt = lines[sp.line + 1]
      if (Math.abs(nxt.y - lines[sp.line].y) <= 0.8 * Math.max(nxt.s, lines[sp.line].s))
        return nxt.text[0]
    }
    return undefined
  }
  const wb = (c: string | undefined) => !isWordChar(c) // 含连字符：见 isWordChar
  // span 所在词的完整区间（向两侧扩到词界）
  const wordSpanRange = (si: number): [number, number] => {
    let a = si
    let b = si
    while (!wb(charAfter(b))) b++
    while (a > 0 && !wb(charBefore(a))) a--
    return [a, b]
  }
  const seen = new Set<string>()
  // [词首 span, 词尾 span] → 矩形（参与字符按行分组：同一视觉行拆多簇时画多段，
  // 拼起来即完整词形）
  const pushRange = (term: string, c0: number, c1: number) => {
    const byLine = new Map<number, { a: number; b: number }>()
    for (let ci = c0; ci <= c1; ci++) {
      const sp = spans[ci]
      const g = byLine.get(sp.line)
      if (g) {
        if (sp.idx < g.a) g.a = sp.idx
        if (sp.idx > g.b) g.b = sp.idx
      } else byLine.set(sp.line, { a: sp.idx, b: sp.idx })
    }
    for (const [li, g] of byLine) {
      const bs = lines[li].boxes.slice(g.a, g.b + 1)
      if (!bs.length) continue
      const sAvg = bs.reduce((acc, x) => acc + x.s, 0) / bs.length
      const left = bs[0].x0
      const top = lines[li].y - 0.86 * sAvg
      const key = `${term}|${left.toFixed(1)}|${top.toFixed(1)}`
      if (seen.has(key)) continue
      seen.add(key)
      const width = bs[bs.length - 1].x1 - bs[0].x0
      if (!Number.isFinite(width) || width <= 0) continue // 非有限/零宽 mark 隐身无意义，宁缺毋滥
      marks.push({
        term,
        left,
        top,
        width,
        height: 1.14 * sAvg,
        // 只在「本词自己的字母盒是近似映射」时才需要按墨迹吸附：按整行判会把
        // 数字版 PDF 里恰好与近似盒同行的精确词也拖进吸附（实测 Attention 一页
        // 的 parallelizable 被并入尾随标点、右伸 13px）
        approx: bs.some((x) => x.approx),
      })
    }
  }
  // Tier 1：anchor.sel 点击点 → 采样几何上离点最近的字符 → 所在词区间
  const anchorOcc = (xr: number, yr: number): [number, number] | null => {
    if (!pageSize || !(pageSize.w > 0) || !(pageSize.h > 0)) return null
    const px = xr * pageSize.w
    const py = yr * pageSize.h
    let best: Line | null = null
    let bestD = Infinity
    for (const l of lines) {
      const d = Math.abs(py - (l.y - 0.29 * l.s)) // 锚点同 locateWordFrag：视觉中心 ≈ 基线上方 0.29em
      if (d < bestD) {
        bestD = d
        best = l
      }
    }
    if (!best || bestD > 0.7 * best.s) return null
    let idx = -1
    let bestDx = Infinity
    for (let i = 0; i < best.text.length; i++) {
      if (best.text[i] === ' ') continue
      const b = best.boxes[i]
      if (!Number.isFinite(b.x0) || !Number.isFinite(b.x1)) continue // 带病盒 dx=NaN 反而像完美命中，必跳过
      const dx = px < b.x0 ? b.x0 - px : px > b.x1 ? px - b.x1 : 0
      if (dx < bestDx) {
        bestDx = dx
        idx = i
      }
    }
    if (idx < 0 || bestDx > 1.0 * best.s) return null
    const li = lines.indexOf(best)
    const si = spans.findIndex((sp) => sp.line === li && sp.idx === idx)
    if (si < 0) return null
    return wordSpanRange(si)
  }
  for (const note of entries) {
    // 语境句在别的页：本页不标（句定位本身就是按页文本，这里提前省掉无效匹配）
    if (note.page && page && note.page !== page) continue
    const terms = [...new Set([norm(note.surface), norm(note.term)].filter(Boolean))]
    if (!terms.length) continue
    let placed = false
    const sel = note.sel
    if (sel && sel[0] > 0 && sel[0] < 1 && sel[1] > 0 && sel[1] < 1) {
      const occ = anchorOcc(sel[0], sel[1])
      if (occ) {
        pushRange(note.term, occ[0], occ[1])
        placed = true
      }
    }
    if (!placed) {
      const sentN = norm(note.sentence ?? '')
      if (sentN) {
        // 语境范围：整句优先；失败再试词形 ±48 字符局部窗口（旧句首尾带内容流序
        // 页缘杂字，整句按几何序对不上，但词形周边的局部窗口是连续正文，对得上）
        const ranges: Array<[number, number]> = []
        const pushSentRange = (s: string) => {
          if (!s || ranges.length) return
          for (let i = doc.indexOf(s); i !== -1; i = doc.indexOf(s, i + 1))
            ranges.push([i, i + s.length])
        }
        pushSentRange(sentN)
        if (!ranges.length) {
          for (const t of terms) {
            for (let k = sentN.indexOf(t); k !== -1; k = sentN.indexOf(t, k + 1)) {
              pushSentRange(sentN.slice(Math.max(0, k - 48), Math.min(sentN.length, k + t.length + 48)))
            }
          }
        }
        if (ranges.length) {
          placed = true
          const done = new Set<number>()
          for (const t of terms) {
            for (const [rs, re] of ranges) {
              for (let k = doc.indexOf(t, rs); k !== -1 && k + t.length <= re; k = doc.indexOf(t, k + 1)) {
                const c0 = spanAt(k)
                if (done.has(c0)) continue
                if (!wb(charBefore(c0))) continue // 词首校验：句内词中子串同样跳过
                done.add(c0)
                const [a, b] = wordSpanRange(c0)
                pushRange(note.term, a, b)
              }
            }
          }
        }
      }
    }
    // Tier 3 回退：仅在锚定页内做全部词首匹配（老数据无点击点、句定位失败时保可用性）
    if (!placed && (!note.page || !page || note.page === page)) {
      for (const t of terms) {
        for (let k = doc.indexOf(t); k !== -1; k = doc.indexOf(t, k + 1)) {
          const c0 = spanAt(k)
          if (!wb(charBefore(c0))) continue
          const [a, b] = wordSpanRange(c0)
          pushRange(note.term, a, b)
        }
      }
    }
  }
  return marks
}

/** 把「近似」标记吸附到 canvas 位图的墨迹上。
 *  整页位图的 PDF（扫描件 + OCR 文本层，Nature 老刊、复印本等）里 pdf.js 只 drawImage
 *  画位图，同一页没有一次可采样的 ctx.fillText → buildLines 拿不到字形落点，字符盒只能
 *  按 item 全宽均分（近似）。OCR 的 item 盒子与位图墨迹本身差 1~3pt，item 内均分再叠一层
 *  误差 → 词在 item 里的位置越靠后偏得越多，独占一个 item 的词反而看着是准的
 *  （user 反馈「偶发标记偏移」：同页有的词贴合、有的词右偏半个字还多出半个空格）。
 *  这里以位图墨迹为唯一真源：按行带读一条水平墨迹条，按列切出词块（间隙 > 0.25em 断开），
 *  取与标记重叠的词块并集作为新矩形。采样精确的标记（approx 未置位）原样返回。 */
function snapMarksToInk(canvas: HTMLCanvasElement, marks: WordMark[], dpr: number): WordMark[] {
  if (!marks.some((m) => m.approx)) return marks
  const g = canvas.getContext('2d')
  if (!g) return marks
  const CW = canvas.width
  const CH = canvas.height
  const isInk = (d: Uint8ClampedArray, i: number) =>
    d[i + 3] > 128 && d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 160
  // 同一视觉行（band top 相同）的标记共享一条墨迹条，避免逐标记 getImageData
  const bands = new Map<number, WordMark[]>()
  for (const m of marks) {
    if (!m.approx) continue
    const key = Math.round(m.top / 2)
    const arr = bands.get(key)
    if (arr) arr.push(m)
    else bands.set(key, [m])
  }
  const replaced = new Map<WordMark, WordMark>()
  for (const group of bands.values()) {
    const bandTop = group[0].top
    const bandH = group[0].height
    const y0 = Math.max(0, Math.round((bandTop + 0.09 * bandH) * dpr))
    const y1 = Math.min(CH - 1, Math.round((bandTop + 0.93 * bandH) * dpr))
    if (y1 <= y0) continue
    // 行带整条读入（1em 高 × 页宽，几十 KB），后续列扫描全在内存里做
    let strip: Uint8ClampedArray
    try {
      strip = g.getImageData(0, y0, CW, y1 - y0 + 1).data
    } catch {
      continue // 画布被污染/跨源（理论上不会）→ 放弃吸附，保留原标记
    }
    const rows = y1 - y0 + 1
    const inkCol = (x: number) => {
      if (x < 0 || x >= CW) return false
      for (let r = 0; r < rows; r++) if (isInk(strip, (r * CW + x) * 4)) return true
      return false
    }
    for (const m of group) {
      const em = m.height / 1.14 // 字号（CSS px）
      const gapMax = Math.max(1, Math.round(0.25 * em * dpr)) // 词内字距 << 词间空格
      const lo = Math.max(0, Math.round((m.left - 1.2 * em) * dpr))
      const hi = Math.min(CW - 1, Math.round((m.left + m.width + 1.2 * em) * dpr))
      const ml = Math.round(m.left * dpr)
      const mr = Math.round((m.left + m.width) * dpr)
      // 窗口内按列切词块
      const runs: Array<{ a: number; b: number }> = []
      let cur: { a: number; b: number } | null = null
      let gap = 0
      for (let x = lo; x <= hi; x++) {
        if (inkCol(x)) {
          if (cur) cur.b = x
          else cur = { a: x, b: x }
          gap = 0
        } else if (cur && ++gap > gapMax) {
          runs.push(cur)
          cur = null
        }
      }
      if (cur) runs.push(cur)
      // 与本标记重叠 ≥1/3 的词块（多词术语会命中多个）取并集
      const hitRuns = runs.filter((r) => Math.min(r.b, mr) - Math.max(r.a, ml) >= (r.b - r.a + 1) / 3)
      if (!hitRuns.length) continue
      const a = hitRuns[0].a
      const b = hitRuns[hitRuns.length - 1].b
      const width = (b - a + 1) / dpr
      // 防御：并集过宽（误吞邻词/串行）或窄到不成词 → 保留原标记
      if (width > 2.5 * m.width + 2 * em || width < 0.4 * Math.min(m.width, em)) continue
      // 只许微调、不许爬出本词：扫描件背景有噪点，相邻词的墨迹块会连成一片，
      // 按墨迹无约束地取并集会骑到后一个词上（user 反馈 inhibition 的框盖住后面的 in）
      const slack = 0.3 * em
      if (a / dpr < m.left - slack || (b + 1) / dpr > m.left + m.width + slack) continue
      replaced.set(m, { ...m, left: a / dpr, width, approx: false })
    }
  }
  return replaced.size ? marks.map((m) => replaced.get(m) ?? m) : marks
}

/** 在采样行文本中定位选区/取词片段 → 词界精确范围（行 + 起止字符索引）。
 *  流程：剔除两端非词字符（拖选带上的引号/标点，hallucination" → hallucination）
 *  → 按竖直锚点选最近行 → 片段在行文本中定位（精确 indexOf + 几何最近消歧同词
 *  多现；二级去空格匹配兼容 TeX「空格是位置非字符」与 DOM 空格策略不一致）
 *  → 命中后向两侧扩到词界（没选全的片段 hallucinatio 补全成整词 hallucination，
 *  词中子串同理；user 要求选词不规范时自动标记完整词形）。未命中（跨行片段等）
 *  返回 null，调用方自行回退。y = 竖直锚点（选区传矩形竖直中心，取词传点击点）。 */
function locateWordFrag(
  frag: string,
  lines: Line[],
  x: number,
  y: number,
): { line: Line; s: number; e: number } | null {
  const raw = frag.replace(/^[^A-Za-z0-9'-]+|[^A-Za-z0-9'-]+$/g, '')
  if (!raw) return null
  let best: Line | null = null
  let bestDist = Infinity
  for (const l of lines) {
    // DOM rect 竖直中心 ≈ 基线上方 0.29em（mark 盒 top=y-0.86s、高 1.14s 的中点）
    const d = Math.abs(y - (l.y - 0.29 * l.s))
    if (d < bestDist) {
      bestDist = d
      best = l
    }
  }
  if (!best || bestDist > 0.7 * best.s) return null
  const lower = best.text.toLowerCase()
  const f = raw.toLowerCase()
  let hit: { s: number; e: number } | null = null
  let bestDx = Infinity
  const consider = (s0: number, e0: number) => {
    const dx = Math.abs(best!.boxes[s0].x0 - x)
    if (dx < bestDx) {
      bestDx = dx
      hit = { s: s0, e: e0 }
    }
  }
  for (let i = lower.indexOf(f); i !== -1; i = lower.indexOf(f, i + 1)) consider(i, i + f.length)
  if (!hit) {
    const strip: number[] = []
    let flat = ''
    for (let i = 0; i < lower.length; i++) {
      if (lower[i] !== ' ') {
        flat += lower[i]
        strip.push(i)
      }
    }
    const f2 = f.replace(/ /g, '')
    if (f2)
      for (let i = flat.indexOf(f2); i !== -1; i = flat.indexOf(f2, i + 1))
        consider(strip[i], strip[i + f2.length - 1] + 1)
  }
  const h = hit as { s: number; e: number } | null
  if (!h) return null
  // /i：与 marksFromLines 的词界判定一致（大写字母不是词界，否则 ConvS2S→ConvS2）
  const wb = (c: string | undefined) => !isWordChar(c) // 含连字符：见 isWordChar
  let a = h.s
  let b = h.e
  while (b < best.text.length && !wb(best.text[b])) b++
  while (a > 0 && !wb(best.text[a - 1])) a--
  return { line: best, s: a, e: b }
}

/** 把 DOM 选区矩形吸附到 canvas 采样字符盒（选区蓝底的视觉替代）。
 *  DOM 文本层字形与 canvas 存在固有偏差（通用字体 + 整 item scaleX 补偿复现不了
 *  内容流逐字 TJ 定位，实测词级 ~2-6px ≈ 1.5 字符）→ 原生 ::selection 蓝底偏离
 *  PDF 词形（user 反馈）。选中字符串经 locateWordFrag 定位（含端点标点剔除 +
 *  词界补全）→ 精确词形矩形；未命中（跨行片段等）→ 回退 DOM 矩形原样画。 */
function snapSelectionRect(
  local: { x: number; y: number; w: number; h: number },
  frag: string,
  lines: Line[],
): WordMark {
  const raw: WordMark = { term: '', left: local.x, top: local.y, width: local.w, height: local.h }
  const loc = locateWordFrag(frag, lines, local.x, local.y + local.h / 2)
  if (!loc) return raw
  const bs = loc.line.boxes.slice(loc.s, loc.e)
  if (!bs.length) return raw
  const sAvg = bs.reduce((acc, b) => acc + b.s, 0) / bs.length
  const snapped: WordMark = {
    term: '',
    left: bs[0].x0,
    top: loc.line.y - 0.86 * sAvg,
    width: bs[bs.length - 1].x1 - bs[0].x0,
    height: 1.14 * sAvg,
  }
  // 吸附结果退化（宽/高非有限或 ≤0 → 样式拒收，选区隐身）→ 回退 DOM 原矩形，
  // 保证选区永远可见（user 反馈 inherently 无法选中）
  if (Number.isFinite(snapped.width) && snapped.width > 0 && Number.isFinite(snapped.height) && snapped.height > 0)
    return snapped
  return raw
}

/** 选区某一条 client rect 实际覆盖的文本片段。多行选区的整段文本在单行里找不到 →
 *  吸附必然失败、退回 DOM 矩形，而 DOM 文本层字形与 canvas 有 2~6px 固有偏差
 *  （user 反馈「选中的选框和标色一样偏移」）→ 用 caretRangeFromPoint 取本 rect
 *  两端之间的那一句，交给 locateWordFrag 按本行几何吸附。取不到就沿用整段。 */
function rectFrag(r: DOMRect, fallback: string): string {
  const d = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  if (!d.caretRangeFromPoint) return fallback
  const y = r.top + r.height / 2
  const a = d.caretRangeFromPoint(r.left + 1, y)
  const b = d.caretRangeFromPoint(Math.max(r.left + 1, r.right - 1), y)
  if (!a || !b) return fallback
  const rg = document.createRange()
  try {
    rg.setStart(a.startContainer, a.startOffset)
    rg.setEnd(b.startContainer, b.startOffset)
  } catch {
    return fallback // 端点不在同一文本树（跨 span 异常）→ 沿用整段
  }
  const t = rg.toString().replace(/\s+/g, ' ').trim()
  return t || fallback
}

/** 采样字符盒 → 页面归一化矩形（批注锚点用：与缩放无关，卡片按当前页宽乘回去） */
function normBox(
  box: { x: number; y: number; w: number; h: number },
  pr: DOMRect,
): [number, number, number, number] {
  return [box.x / pr.width, box.y / pr.height, box.w / pr.width, box.h / pr.height]
}

/** 采样行上的片段 → 吸附盒（文本层 DOM 字形与 canvas 有固有偏差，吸附后红线才贴住句尾） */
function fragBox(
  frag: string,
  lines: Line[] | undefined,
  x: number,
  y: number,
): { x: number; y: number; w: number; h: number } | null {
  const loc = lines && frag ? locateWordFrag(frag, lines, x, y) : null
  if (!loc) return null
  const bs = loc.line.boxes.slice(loc.s, loc.e)
  if (!bs.length) return null
  const sAvg = bs.reduce((acc, b) => acc + b.s, 0) / bs.length
  const w = bs[bs.length - 1].x1 - bs[0].x0
  if (!Number.isFinite(w) || w <= 0) return null
  return { x: bs[0].x0, y: loc.line.y - 0.86 * sAvg, w, h: 1.14 * sAvg }
}

/** 选区锚点（创建批注用）：DOM 选区 → 引用原文 + 【末行】页面归一化矩形。
 *  末行即所选内容的最后一行 = 句尾，红线从它的右端连向右侧卡片。选区跨页时取末行
 *  所在页；末行尾词吸附到采样字符盒（与生词标色同一套几何），保证红线起点贴住
 *  真正的末字符。无选区/选区不在文本层上 → null（调用方回退取词矩形）。 */
function selectionAnchor(
  scroller: HTMLElement | null,
  linesFor: (page: number) => Line[] | undefined,
): AnnoAnchor | null {
  if (!scroller) return null
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null
  const quote = sel.toString().replace(/\s+/g, ' ').trim()
  if (!quote) return null
  const range = sel.getRangeAt(0)
  const found: Array<{ r: DOMRect; pageEl: HTMLElement }> = []
  for (const pageEl of Array.from(scroller.querySelectorAll<HTMLElement>('.pv-page'))) {
    const layer = pageEl.querySelector('.pv-textlayer')
    if (!layer || !range.intersectsNode(layer)) continue
    const pr = pageEl.getBoundingClientRect()
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue
      // 只收落在本页范围内的矩形（选区可能跨页，其它页由各自的页元素认领）
      if (r.bottom < pr.top || r.top > pr.bottom) continue
      found.push({ r, pageEl })
    }
  }
  if (!found.length) return null
  found.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
  const last = found[found.length - 1]
  const pr = last.pageEl.getBoundingClientRect()
  if (!(pr.width > 0 && pr.height > 0)) return null
  const page = Number(last.pageEl.getAttribute('data-page')) || 1
  const dom = { x: last.r.left - pr.left, y: last.r.top - pr.top, w: last.r.width, h: last.r.height }
  const tail = (quote.match(/[A-Za-z0-9][A-Za-z0-9'’-]*$/) || [''])[0]
  const box = fragBox(tail, linesFor(page), dom.x + dom.w - 1, dom.y + dom.h / 2) ?? dom
  return {
    quote,
    page,
    rect: normBox(box, pr),
    screen: { x: last.r.left, y: last.r.top, w: last.r.width, h: last.r.height },
  }
}

/** 无选区时的批注锚点兜底：取词矩形（同样先吸附到采样字符盒） */
function wordAnchor(
  word: string,
  domRect: ScreenRect,
  pageEl: HTMLElement | null,
  page: number,
  lines: Line[] | undefined,
): AnnoAnchor | null {
  if (!pageEl) return null
  const pr = pageEl.getBoundingClientRect()
  if (!(pr.width > 0 && pr.height > 0)) return null
  const dom = { x: domRect.x - pr.left, y: domRect.y - pr.top, w: domRect.w, h: domRect.h }
  const box = fragBox(word, lines, dom.x + dom.w / 2, dom.y + dom.h / 2) ?? dom
  return { quote: word, page, rect: normBox(box, pr), screen: domRect }
}

/** 几何兜底取词（坐标为页内 CSS 像素）：caretRangeFromPoint 在部分 WebKit 版本对
 *  user-select:none 内容可能返回 null → 直接在 canvas 采样行上定位：竖直最近行
 *  （锚点同 locateWordFrag：DOM rect 竖直中心 ≈ 基线上方 0.29em）→ 离 x 最近的
 *  字符盒（容差 0.6em）→ 词界扩展（含连字符，大写字母不算词界）。 */
function wordFromLines(lines: Line[] | undefined, x: number, y: number): string | null {
  if (!lines || !lines.length) return null
  let best: Line | null = null
  let bestDist = Infinity
  for (const l of lines) {
    const d = Math.abs(y - (l.y - 0.29 * l.s))
    if (d < bestDist) {
      bestDist = d
      best = l
    }
  }
  if (!best || bestDist > 0.7 * best.s) return null
  let idx = -1
  let bestDx = Infinity
  for (let i = 0; i < best.text.length; i++) {
    if (best.text[i] === ' ') continue
    const b = best.boxes[i]
    if (!Number.isFinite(b.x0) || !Number.isFinite(b.x1)) continue // 带病盒 dx=NaN 反而像完美命中，必跳过
    const dx = x < b.x0 ? b.x0 - x : x > b.x1 ? x - b.x1 : 0
    if (dx < bestDx) {
      bestDx = dx
      idx = i
    }
  }
  if (idx < 0 || bestDx > 0.6 * best.s) return null
  const wb = (c: string | undefined) => !isWordChar(c) // 含连字符：见 isWordChar
  let a = idx
  let e = idx + 1
  while (e < best.text.length && !wb(best.text[e])) e++
  while (a > 0 && !wb(best.text[a - 1])) a--
  return best.text.slice(a, e).replace(/ /g, '')
}

/** 取光标下的单词及其屏幕矩形（caretRangeFromPoint / caretPositionFromPoint 兼容）。
 *  range = 整词 DOM Range（触屏长按程序化选区用，setBaseAndExtent/addRange 不触发
 *  iOS 系统 callout） */
function wordAtPoint(x: number, y: number): { word: string; rect: ScreenRect; range: Range } | null {
  let caret: Range | null = null
  const anyDoc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  if (document.caretRangeFromPoint) {
    caret = document.caretRangeFromPoint(x, y)
  } else if (anyDoc.caretPositionFromPoint) {
    const pos = anyDoc.caretPositionFromPoint(x, y)
    if (pos) {
      const r = document.createRange()
      r.setStart(pos.offsetNode, pos.offset)
      caret = r
    }
  }
  if (!caret) return null
  const node = caret.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const txt = node.textContent || ''
  const off = caret.startOffset
  // 数字也算词字符：旧版只收 [A-Za-z]，光标落在数字后时右侧不匹配、左侧又被数字截断
  // → ConvS2S 取成 "ConvS"（user 反馈的字卡开不出/生成词形不全）
  const left = (txt.slice(0, off).match(/[A-Za-z0-9][A-Za-z0-9'-]*$/) || [''])[0]
  const right = (txt.slice(off).match(/^[A-Za-z0-9][A-Za-z0-9'-]*/) || [''])[0]
  const word = left + right
  if (!word) return null
  // 扩展到整词 range，取包围盒（锚定批注卡用）
  const wr = document.createRange()
  wr.setStart(node, off - left.length)
  wr.setEnd(node, off + right.length)
  const r = wr.getBoundingClientRect()
  return { word, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, range: wr }
}

/** 触屏长按链诊断角标（临时脚手架，问题定位后删）：iPad 无控制台可看，把每次触摸的
 *  关键判断直接写到屏幕左下角，用户截图即可定位「哪一步断的」。 */
function touchDbg(line: string) {
  try {
    let el = document.getElementById('pv-touch-dbg')
    if (!el) {
      el = document.createElement('div')
      el.id = 'pv-touch-dbg'
      el.style.cssText =
        'position:fixed;left:6px;bottom:6px;z-index:99999;background:rgba(0,0,0,.82);color:#7fe07f;' +
        'font:11px/1.4 ui-monospace,Menlo,monospace;padding:4px 7px;border-radius:6px;max-width:92vw;' +
        'white-space:pre-wrap;pointer-events:none'
      document.body.appendChild(el)
    }
    const prev = (window as unknown as { __pvTouchLog?: string[] }).__pvTouchLog || []
    prev.push(line)
    if (prev.length > 4) prev.shift()
    ;(window as unknown as { __pvTouchLog?: string[] }).__pvTouchLog = prev
    el.textContent = prev.join('\n')
  } catch {
    /* 诊断本身不得影响功能 */
  }
}

/** 拼接文本层顶层 span 的文本（items 的 str 自带词间空格；.pv-hit 嵌在 leaf 内，
 *  父 span.textContent 已含其文本，只取 :scope > span 不会重复计数） */
function layerText(el: Element | null): string {
  if (!el) return ''
  let out = ''
  for (const s of el.querySelectorAll(':scope > span')) out += s.textContent || ''
  return out
}

/** 取 word 所在的完整句子（以 .!? 为句界，向前回退到句号后、向后推进到句号止） */
function sentenceAround(text: string, word: string): string {
  if (!text) return ''
  const i = text.toLowerCase().indexOf(word.toLowerCase())
  if (i === -1) return ''
  const punct = /[.!?]/
  let s = i
  while (s > 0 && !punct.test(text[s - 1])) s--
  let e = i + word.length
  while (e < text.length && !punct.test(text[e])) e++
  if (e < text.length) e++
  return text.slice(s, e).replace(/\s+/g, ' ').trim()
}

/** 单页：懒渲染 —— 滚动到视口附近才真正 render canvas + 文本层，其余占位 */
function PageView({
  pdf,
  pageNumber,
  scale,
  notes,
  linesMap,
  pendingWords,
  manualSel,
}: {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  notes: VocabNote[]
  linesMap: Map<number, Line[]>
  pendingWords?: PendingWord[]
  manualSel?: { page: number; rects: WordMark[] } | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const renderSeq = useRef(0)
  const linesRef = useRef<Line[]>([])
  const selRaf = useRef(0)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const [marks, setMarks] = useState<WordMark[]>([])
  const [selRects, setSelRects] = useState<WordMark[]>([])
  const [pendingMarks, setPendingMarks] = useState<WordMark[]>([])

  // 生成中的词标橘（用户要求生成期可视反馈）：与蓝标同一套语境锚定匹配管线，只是
  // 换了词源和配色。重算时机 = pendingWords 变化 或 页面重渲染（marks 状态更新时
  // lines 必然刚重建过）；生成完成入 notes 后蓝标接管，橘标随 pendingWords 移除消失
  useEffect(() => {
    const canvas = canvasRef.current
    const pending = pendingWords?.length
      ? marksFromLines(
          linesRef.current,
          pendingWords.map((w) => ({
            surface: w.word,
            term: w.word,
            sentence: w.sentence,
            page: w.page,
            sel: w.sel ?? null,
          })),
          pageNumber,
          size,
        )
      : []
    setPendingMarks(canvas && pending.length ? snapMarksToInk(canvas, pending, window.devicePixelRatio || 1) : pending)
  }, [pendingWords, marks, pageNumber, size])

  // 选区高亮重算：矩形吸附到 canvas 采样字符盒（snapSelectionRect），rAF 节流
  const recomputeSel = useCallback(() => {
    const pageEl = pageRef.current
    const layer = textRef.current
    if (!pageEl || !layer) return
    const out: WordMark[] = []
    const sel = window.getSelection()
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const pageRect = pageEl.getBoundingClientRect()
      const lines = linesRef.current
      for (let ri = 0; ri < sel.rangeCount; ri++) {
        const range = sel.getRangeAt(ri)
        if (!range.intersectsNode(layer)) continue
        const fragAll = (range.toString() || '').replace(/\s+/g, ' ').trim()
        const rects = range.getClientRects()
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]
          // 只处理落在本页范围内的矩形（选区可能跨页，其它页由各自 PageView 画）
          if (r.width < 1 || r.height < 1) continue
          if (r.bottom < pageRect.top || r.top > pageRect.bottom) continue
          // 逐矩形取「本行那一段」文本：多行选区用整段文本吸附必然落空（见 rectFrag）
          out.push(
            snapSelectionRect(
              { x: r.x - pageRect.x, y: r.y - pageRect.y, w: r.width, h: r.height },
              rectFrag(r, fragAll),
              lines,
            ),
          )
        }
      }
    }
    const dedup: WordMark[] = []
    for (const m of out) {
      if (!dedup.some((d) => Math.abs(d.left - m.left) < 1.5 && Math.abs(d.top - m.top) < 1.5))
        dedup.push(m)
    }
    setSelRects(dedup)
  }, [])

  // 原生 ::selection 蓝底画在 DOM 字形上（与 canvas 固有偏差，user 反馈偏移）——
  // CSS 已隐藏，选区视觉由本组件监听 selectionchange 用采样坐标重画
  useEffect(() => {
    if (!visible) return
    const onSel = () => {
      if (selRaf.current) return
      selRaf.current = requestAnimationFrame(() => {
        selRaf.current = 0
        recomputeSel()
      })
    }
    document.addEventListener('selectionchange', onSel)
    return () => {
      document.removeEventListener('selectionchange', onSel)
      if (selRaf.current) cancelAnimationFrame(selRaf.current)
      selRaf.current = 0
    }
  }, [visible, recomputeSel])

  // 占位尺寸（只需 getPage 元数据，便宜）
  useEffect(() => {
    let cancelled = false
    pdf
      .getPage(pageNumber)
      .then((p) => {
        const vp = p.getViewport({ scale })
        if (!cancelled) setSize({ w: vp.width, h: vp.height })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pdf, pageNumber, scale])

  // 视口相交才渲染（滚动到附近触发）。等 size 就位再观察：占位期页面高 1px，
  // 直接观察会把所有页都判为「相交」→ 启动时也就全渲染了（user 反馈慢）。
  useEffect(() => {
    if (!size) return
    const el = pageRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true)
            io.disconnect()
            break
          }
        }
      },
      { root: null, rootMargin: '200px 0px 200px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [size])

  // 实际渲染（可见时）
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const seq = ++renderSeq.current
    const canvas = canvasRef.current
    const textDiv = textRef.current
    if (!canvas || !textDiv) return
    // 渲染序号守卫：缩放快速连续变化时，只允许最新一次 render 写文本层。
    // seq 必须在 effect 同步阶段落基准，否则 async 里 dataset.seq 尚为 undefined 会误判过期
    textDiv.dataset.seq = String(seq)
    const stale = () => cancelled || textDiv.dataset.seq !== String(seq)
    ;(async () => {
      const page: PDFPageProxy = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale })
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      setSize({ w: viewport.width, h: viewport.height })
      const ctx = canvas.getContext('2d')!
      const paints = paintRecorder(ctx)
      await page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise
      if (stale()) return
      const textContent = await page.getTextContent()
      // pdf.js 文本层用 calc(var(--scale-factor)*Npx) 设 span 字号；未设该变量则字号无效
      // → 文本层字形位置漂移，生词标色随水平位移到相邻词（user 反馈偏移根因）。
      textDiv.style.setProperty('--scale-factor', String(scale))
      // TextLayer 不清空容器，由调用方负责：scale 变化重渲染时若不清空，
      // 旧文本层+旧 .pv-hit 残留并与新层叠加 → 高亮叠成"实心"、旧缩放布局错位（user 反馈）
      textDiv.textContent = ''
      // 文本层保持 pdf.js 标准形态（通用字体 + scaleX 补宽）：只承担选择/caret/.pv-hit
      // 交互锚。曾实验换 PDF 内嵌字体对齐（08-28），但视觉标色已改走 canvas fillText
      // 采样（同坐标系天然贴合），内嵌字体的注册竞态反致个别环境选区框大幅偏移
      // （user 反馈 08-30），已回退，勿再启用。
      const textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textDiv, viewport })
      await textLayer.render()
      if (stale()) return
      highlightTerms(textDiv, notes)
      if (stale()) return
      const tc = textContent as unknown as { items: Array<{ str?: string; width?: number; transform?: number[] }> }
      const lines = buildLines(tc.items, paints, dpr, viewport)
      linesRef.current = lines
      linesMap.set(pageNumber, lines)
      setMarks(
        snapMarksToInk(
          canvas,
          marksFromLines(
            lines,
            notes.map((n) => ({
              surface: n.surface,
              term: n.term,
              sentence: n.sentence,
              page: n.anchor?.page,
              sel: n.anchor?.sel ? [n.anchor.sel[0], n.anchor.sel[1]] : null,
            })),
            pageNumber,
            { w: viewport.width, h: viewport.height },
          ),
          dpr,
        ),
      )
      // 缩放/换页重渲染后选区若仍在，按新几何重画
      recomputeSel()
    })().catch((e) => {
      if (!cancelled) console.error(`page ${pageNumber} render failed`, e)
    })
    return () => {
      cancelled = true
    }
  }, [visible, pdf, pageNumber, scale, notes, recomputeSel])

  return (
    <div
      ref={pageRef}
      className={`pv-page${visible ? ' pv-page-rendered' : ''}`}
      data-page={pageNumber}
      style={{ width: size ? size.w : 1, height: size ? size.h : 1 }}
    >
      {visible && size && (
        <div className="pv-page-holder" style={{ position: 'absolute', inset: 0 }}>
          {pageNumber}
        </div>
      )}
      {visible && (
        <>
          <canvas ref={canvasRef} />
          {/* 选区高亮层（z1，canvas 之上）：矩形由 snapSelectionRect 吸附到采样字符盒，
              替代原生 ::selection 蓝底（DOM 字形偏离 canvas，user 反馈）。纯视觉层。
              manualSel = 触屏长按 caret 失败时的几何兜底选区（无 DOM selection 可吸附）。 */}
          <div className="pv-selection">
            {selRects.map((m, i) => (
              <div key={i} style={{ left: m.left, top: m.top, width: m.width, height: m.height }} />
            ))}
            {manualSel && manualSel.page === pageNumber
              ? manualSel.rects.map((m, i) => (
                  <div
                    key={`m${i}`}
                    style={{ left: m.left, top: m.top, width: m.width, height: m.height }}
                  />
                ))
              : null}
          </div>
          {/* 标记层：坐标来自 canvas fillText 采样（与 canvas 同一坐标系 → 逐像素贴合）。
              纯视觉层（pointer-events:none），交互锚点仍是文本层内的 .pv-hit */}
          <div className="pv-marks">
            {marks.map((m, i) => (
              <div
                key={i}
                className="pv-mark"
                data-term={m.term}
                style={{ left: m.left, top: m.top, width: m.width, height: m.height }}
              />
            ))}
            {/* 橘标（生成中）后渲染：与蓝标重叠时盖在其上 */}
            {pendingMarks.map((m, i) => (
              <div
                key={`p${i}`}
                className="pv-mark pv-mark-pending"
                style={{ left: m.left, top: m.top, width: m.width, height: m.height }}
              />
            ))}
          </div>
          {/* lang=en：pdf.js 量宽用隐藏 canvas（lang=""→默认西文解析），
              span 的 fontFamily 恒为通用族（本文=sans-serif）。若容器继承 html 的
              zh-CN，iPad Safari 会用苹方等 CJK 字体的拉丁字形排版 span，与量宽
              字体(Helvetica)不一致 → scaleX 补偿失准 → 生词标色词内漂移（桌面
              Windows 恒 Arial 无此差异）。en 使两端解析一致，回归逐像素贴合 */}
          <div ref={textRef} className="pv-textlayer" lang="en" />
        </>
      )}
    </div>
  )
}

export const PdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>(function PdfViewer(
  { src, notes, annos, scale, shrinkToFitOnLoad = true, pendingWords, onScaleChange, onWordOpen, onQuote, onQuoteClose, onPageChange, onPageCount, onLoadState, onAnnoEdit, onAnnoDelete },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const linesMap = useRef(new Map<number, Line[]>()) // 页码 → 采样行（右键取词补全用）
  const scaleRef = useRef(scale) // 载入适宽 effect 读最新 scale，不进依赖（防缩放重跑）
  scaleRef.current = scale
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState<number[]>([])
  // 触屏长按的几何兜底选区（caret 不可用时按采样几何直接画蓝底，页码 + 页内矩形）
  const [manualSel, setManualSel] = useState<{ page: number; rects: WordMark[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    setPdf(null)
    setPages([])
    setManualSel(null)
    linesMap.current.clear() // 换 PDF：旧文档的行文本对新文档是脏数据
    onLoadState?.('loading')
    if (!src) return
    pdfjsLib
      .getDocument({ url: src })
      .promise.then((doc) => {
        if (cancelled) return
        setPdf(doc)
        setPages(Array.from({ length: doc.numPages }, (_, i) => i + 1))
        onPageCount?.(doc.numPages)
        onLoadState?.('ready')
      })
      .catch((e) => {
        if (!cancelled) {
          console.error('pdf load failed', e)
          onLoadState?.('error')
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  // 载入后防横向溢出（user 反馈 iPad 上 PDF 可左右滑）：iPad 竖屏减去 320px 生词
  // 抽屉后 PDF 区常不足 612px（letter @1x 页宽）→ 页面真实横向溢出、可左右滑。
  // 页宽超出可视区则自动缩到适宽；只缩不放大，桌面宽视口默认 1x 行为不变。
  // 已有持久化缩放（pj13.scale，shrinkToFitOnLoad=false）则跳过：用户缩放偏好
  // （含主动放大后的横向滑动）优先于适宽
  useEffect(() => {
    if (!pdf) return
    if (!shrinkToFitOnLoad) return
    const el = scrollRef.current
    if (!el) return
    let cancelled = false
    pdf
      .getPage(1)
      .then((p) => {
        if (cancelled) return
        const vw = p.getViewport({ scale: 1 }).width
        const w = el.clientWidth - 4
        if (w > 0 && vw * scaleRef.current > w) {
          onScaleChange(
            Math.max(0.4, Math.min(scaleRef.current, Math.floor((w / vw) * 100) / 100)),
          )
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // 仅换 PDF 时执行一次；scale/onScaleChange 经 ref 读最新值，避免每次缩放重跑
    // 把用户主动放大（横向滑动此时是合法需求）拽回适宽
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf])

  // 缩放变化：旧 manualSel 矩形是旧 scale 坐标，作废（下次长按重建）
  useEffect(() => {
    setManualSel(null)
  }, [scale])

  // 滚动时上报当前页
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      if (!onPageChange) return
      const pagesEls = Array.from(el.querySelectorAll<HTMLElement>('.pv-page'))
      let best = 1
      let bestDist = Infinity
      for (const p of pagesEls) {
        const d = Math.abs(p.offsetTop - el.scrollTop)
        if (d < bestDist) {
          bestDist = d
          best = Number(p.dataset.page) || 1
        }
      }
      onPageChange(best)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [onPageChange])

  // Ctrl + 滚轮 → 独立 PDF 缩放
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      onScaleChange(Math.min(5, Math.max(0.4, scale * factor)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, onScaleChange])

  // ---------- 选区 → 官方引用浮窗（floria-quote-open）----------
  // 三动作（生成单词卡 / 创建批注 / 发送给 AI）自 2026-09-28 起全部由宿主官方引用浮窗
  // （web-src §48）承载，Pj13 自建右键菜单已删除。宿主看不到 iframe 内选区（跨文档
  // getSelection 不达）⇒ 本页自报：mouseup（主键）时选区非空且落在文本层上 → 快照 →
  // onQuote → App 发消息开窗；宿主点申报动作行回发 floria-quote-action{id}，业务动作
  // 在**本页运行上下文**里执行（要调 Pj13 的 API 与 pdf 状态，宿主不代执行）。
  // 关窗同样自报：帧内 mousedown / 滚动都不冒泡到宿主 document，宿主那两条关窗策略对
  // 帧内事件失效（浮窗靠宿主 document mousedown 关、滚动即关）。
  const sentenceOf = (pageEl: HTMLElement | null, word: string): string =>
    pageEl ? sentenceAround(layerText(pageEl.querySelector('.pv-textlayer')), word) : ''

  /** 选区（或触屏几何兜底 fb）→ 快照；空选区 / 不落在任何页上 → null */
  const buildQuoteSnap = useCallback(
    (fb?: { word: string; page: number; pageEl: HTMLElement; rect: ScreenRect; point?: [number, number] }): QuoteSnap | null => {
      const scroller = scrollRef.current
      if (!scroller) return null
      const sel = window.getSelection()
      const hasSel = !!sel && sel.rangeCount > 0 && !sel.isCollapsed && !!sel.toString().trim()
      if (!hasSel) {
        // 触屏 caret 不可用时的几何兜底（程序化选区建不起来，只有采样盒）：整词即选区
        if (!fb) return null
        return {
          text: fb.word,
          page: fb.page,
          pageEnd: fb.page,
          rect: { x: fb.rect.x, y: fb.rect.y, w: fb.rect.w, h: fb.rect.h },
          word: fb.word,
          sentence: sentenceOf(fb.pageEl, fb.word),
          point: fb.point,
          wordRect: fb.rect,
          anno: wordAnchor(fb.word, fb.rect, fb.pageEl, fb.page, linesMap.current.get(fb.page)),
        }
      }
      const text = sel!.toString().replace(/\s+/g, ' ').trim()
      const range = sel!.getRangeAt(0)
      const rects = Array.from(range.getClientRects()).filter((r) => r.width >= 1 && r.height >= 1)
      if (!rects.length) return null
      // 选区落页：按页元素竖直区间认领（跨页 → page..pageEnd）
      const perPage = Array.from(scroller.querySelectorAll<HTMLElement>('.pv-page'))
        .map((el) => {
          const pr = el.getBoundingClientRect()
          return {
            el,
            pr,
            rects: rects.filter((r) => !(r.bottom < pr.top || r.top > pr.bottom)),
            page: Number(el.getAttribute('data-page')) || 1,
          }
        })
        .filter((x) => x.rects.length)
      if (!perPage.length) return null
      perPage.sort((a, b) => a.page - b.page)
      const first = perPage[0]
      const last = perPage[perPage.length - 1]
      const r0 = first.rects[0]
      // 词形 = 选区起点处的采样词（与标色/取词同一套几何）：选区没选全或带标点时自动整词。
      // 单字选区优先用「选中的文本本身」在采样行里定位（locateWordFrag：端点标点剔除 +
      // 词界补全 + 几何消歧），**不**按左端点 x 取最近字符盒：DOM 文本层与 canvas 采样
      // 有 2~6px 固有偏差（≈一个空格宽），左端点会越过边界落进前一个词尾
      //（user 反馈：选 convolution 却生成 or——「aligned RNNs or convolution.」左端点落进 or）
      const lines = linesMap.current.get(first.page)
      const lx = r0.left - first.pr.left
      const ly = r0.top - first.pr.top + r0.height / 2
      const loc = lines && !/\s/.test(text) ? locateWordFrag(text, lines, lx, ly) : null
      // 词尾引用号修剪：整词扩展会把拆出来的 " 25,"（引用号+粘连句逗）一并算进词形
      // → term 成 "piperazines25,"（user 反馈 10-13）。修剪后词形与锚点都只算主词本体。
      const eTrim = loc ? trimCiteTail(loc.line, loc.s, loc.e) : 0
      const word = loc
        ? loc.line.text.slice(loc.s, eTrim).replace(/ /g, '')
        : (wordFromLines(lines, lx, ly) ?? text)
      // 锚点必须与 word 同源：命中词时取该词几何中心，否则点击点仍停在 DOM 选区左端
      //（会落进前一个词的边界）→ 标记端 Tier1 anchorOcc 按点取最近词，会把标记打到
      // 隔壁词（user 反馈：卡是 convolution 却把 or 标蓝）。未命中才回退选区左端。
      let ax = lx
      let ay = ly
      if (loc) {
        const bs = loc.line.boxes.slice(loc.s, eTrim)
        if (bs.length) {
          ax = (bs[0].x0 + bs[bs.length - 1].x1) / 2
          ay = loc.line.y - 0.29 * loc.line.s
        }
      }
      const point: [number, number] | undefined =
        first.pr.width > 0 && first.pr.height > 0 ? [ax / first.pr.width, ay / first.pr.height] : undefined
      const tail = last.rects[last.rects.length - 1]
      return {
        text,
        page: first.page,
        pageEnd: last.page,
        // 落点取末行矩形：宿主按 bottom + 6 摆浮窗（与宿主内选区同一算法）
        rect: { x: tail.left, y: tail.top, w: tail.width, h: tail.height },
        word,
        sentence: sentenceOf(first.el, word),
        point,
        wordRect: { x: r0.left, y: r0.top, w: r0.width, h: r0.height },
        anno: selectionAnchor(scroller, (p) => linesMap.current.get(p)),
      }
    },
    [],
  )

  // 开窗/关窗唯一出口（成对）。宽限：iOS 抬手会合成鼠标事件、惯性滚动与 soft keyboard/缩放
  // 触发的 scroll 也可能紧跟开窗到达，那一下若被当成「点外部 / 滚动」立刻回报 close，用户看到
  // 的就是浮窗一闪或干脆不出现（宿主侧同类前例 rowMenuGuard=+600ms）。刚开窗 500ms 内不许关。
  const lastQuoteAt = useRef(0)
  const fireQuote = useCallback(
    (snap: QuoteSnap) => {
      lastQuoteAt.current = Date.now()
      onQuote(snap)
    },
    [onQuote],
  )
  const fireQuoteClose = useCallback(() => {
    if (Date.now() - lastQuoteAt.current < 500) return
    onQuoteClose()
  }, [onQuoteClose])

  // iPad/触屏：原生长按选择必弹系统 callout（拷贝/查询/分享，网页无法隐藏或插入
  // 自定义项，user 反馈「苹果套件劫持」）→ 触屏端选择完全程序化接管：
  //   CSS 禁原生选择（styles.css，媒体查询 + `.pv-touch` 类两条同源规则）
  //   长按 350ms → 取词（caret 兜底 canvas 采样几何）→ addRange 程序化选区（不触发
  //   系统菜单，selectionchange 照常触发 → 蓝底吸附重画管线原样工作）→ 松手弹宿主
  //   官方引用浮窗（与桌面 mouseup 同一条 buildQuoteSnap 流）。快速 tap 清程序化选区
  //   （无原生手势能清它）。触屏无 mouseup 可用（长按的 touchend 已 preventDefault），
  //   故这条链是触屏唯一入口，不能删。
  // React 合成 touch 事件是 passive 的 → 原生监听；桌面鼠标不受影响。
  // **判据走 isTouchUI()（src/touch.ts），不是裸 `(pointer: coarse)`**：iPadOS Safari 谎报
  // pointer:fine/hover:hover，裸判会让整条触屏链在 iPad 上根本不挂（user 反馈的 iPad 失效根因）。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!isTouchUI()) return
    let timer = 0
    let sx = 0
    let sy = 0
    let fired = false
    // 松手兜底长按用的轨迹量：单指按住但计时器被小漂移清掉时的补救（见 onTouchEnd）
    let armed = false
    let startedAt = 0
    let lastX = 0
    let lastY = 0
    let moved = 0
    // 长按命中后延后到松手（touchend）再弹菜单：菜单若在按压期间出现于指下，抬手
    // 即误触「＋生成」且 busy 卡原本不可取消（user 反馈自动生成无法取消）；
    // 长按期间只出蓝底选区作为反馈，菜单在手指离开屏幕后才出现
    let pendingOpen: (() => void) | null = null
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = 0
      }
    }
    const longPress = (x: number, y: number) => {
      fired = true
      const t = document.elementFromPoint(x, y) as HTMLElement | null
      const pageEl = t?.closest<HTMLElement>('.pv-page')
      if (!t || !pageEl) return
      const page = Number(pageEl.getAttribute('data-page')) || 1
      const pr = pageEl.getBoundingClientRect()
      const lines = linesMap.current.get(page)
      const lx = x - pr.left
      const ly = y - pr.top
      const hit = wordAtPoint(x, y)
      let frag = hit?.word ?? ''
      let loc: ReturnType<typeof locateWordFrag> = null
      if (frag && lines) {
        loc = locateWordFrag(frag, lines, lx, ly)
        // 只修 frag（词形/term）；manualSel 蓝底仍用完整 loc 范围（视觉反馈不缩水）
        if (loc)
          frag = loc.line.text.slice(loc.s, trimCiteTail(loc.line, loc.s, loc.e)).replace(/ /g, '')
      }
      if (!frag) {
        frag = wordFromLines(lines, lx, ly) ?? ''
        if (frag && lines && !loc) loc = locateWordFrag(frag, lines, lx, ly)
      }
      // 程序化选区蓝底：caret 可用 → DOM 整词 range（蓝底由 snapSelectionRect 吸附到
      // 采样字符盒，不依赖 DOM 字形精度）；caret 不可用（部分 WebKit 对
      // user-select:none 内容 caretRangeFromPoint 返回 null，user 反馈 inherently
      // 长按无选区标识）→ 直接按采样几何画蓝底（manualSel），保证长按始终有反馈
      if (hit) {
        setManualSel(null)
        const sel = window.getSelection()
        if (sel) {
          sel.removeAllRanges()
          sel.addRange(hit.range)
        }
      } else if (loc) {
        const bs = loc.line.boxes.slice(loc.s, loc.e)
        if (bs.length) {
          const sAvg = bs.reduce((acc, b) => acc + b.s, 0) / bs.length
          setManualSel({
            page,
            rects: [
              {
                term: '',
                left: bs[0].x0,
                top: loc.line.y - 0.86 * sAvg,
                width: bs[bs.length - 1].x1 - bs[0].x0,
                height: 1.14 * sAvg,
              },
            ],
          })
        } else setManualSel(null)
      } else setManualSel(null)
      // 点击点页面归一化坐标（缩放不变量）：生成卡存入 anchor.sel，标记端据此精确
      // 锚定「这一次出现」（同词多语境只标生成语境，user 反馈全文乱标）
      const point: [number, number] | undefined =
        pr.width > 0 && pr.height > 0 ? [lx / pr.width, ly / pr.height] : undefined
      // 三动作自 2026-09-28 起由宿主官方引用浮窗承载（自建长按菜单已废）：长按期间只出
      // 蓝底反馈，松手（touchend）才开窗——浮窗若出现在指下会被抬手误触（与旧菜单同理）。
      // **几何兜底 fb 必须无条件携带**（旧版「caret 命中就不带」是 iPad 上「蓝底出现、松手
      // 无浮窗」的根因）：iOS 抬手时会静默清掉程序化选区（addRange 建的选区不被列为用户
      // 选区），到 touchend 再调 buildQuoteSnap 时 getSelection 已 collapsed → 旧版直接
      // return null（无任何反馈）。带 fb 后 buildQuoteSnap 两条路都能出快照：选区还在用选区
      // （原文完整、可跨行），选区没了退回整词（至少动作可用）。
      const anchor: ScreenRect = hit?.rect ?? { x, y, w: 0, h: 0 }
      const fb = frag ? { word: frag, page, pageEl, rect: anchor, point } : undefined
      pendingOpen =
        hit || fb
          ? () => {
              const snap = buildQuoteSnap(fb)
              if (snap) {
                fireQuote(snap)
                touchDbg(`open ok text="${snap.text.slice(0, 18)}" p${snap.page}`)
              } else {
                touchDbg(`open FAILED（无选区且无兜底）word="${frag}"`)
              }
            }
          : null
      touchDbg(`lp word="${frag}" hit=${hit ? 1 : 0} loc=${loc ? 1 : 0}`)
    }
    const onTouchStart = (e: TouchEvent) => {
      clearTimer()
      fired = false
      armed = false
      startedAt = 0
      moved = 0
      pendingOpen = null
      setManualSel(null) // 新触摸开始即清几何兜底选区（新长按会重建）
      if (e.touches.length !== 1) return // 多指=捏合缩放，不算长按
      touchDbg(`start coarse=1 touch=1`)
      const t = e.touches[0]
      sx = t.clientX
      sy = t.clientY
      armed = true
      startedAt = Date.now()
      lastX = sx
      lastY = sy
      moved = 0
      timer = window.setTimeout(() => {
        timer = 0
        longPress(sx, sy)
      }, 350)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!armed || e.touches.length !== 1) return
      const t = e.touches[0]
      lastX = t.clientX
      lastY = t.clientY
      const d = Math.hypot(t.clientX - sx, t.clientY - sy)
      if (d > moved) moved = d
      if (timer && d > 12) clearTimer() // 移动=滚动
    }
    // 松手兜底长按：计时器在 >12px 漂移时已被清掉，但手指实际几乎没动且按够了时长（iPad 上
    // 指尖微抖/预滚动常落在 13~20px，正好跨过 12px 阈值）⇒ 在松手点补一次长按。这条是治
    // 「有时弹有时不弹」的偶发：同样的长按手势，只因漂移几像素就整条链静默失败。
    // 门槛与 350ms 计时器对齐（held>=340）且**只在计时器确被漂移清掉时**生效（moved>12）：
    // 否而会把 300ms 级的「慢一点的 tap」也算成长按（实测 327ms 的 tap 曾被误判开卡）。
    const endLongPressFallback = (held: number) => {
      if (fired || !armed || held < 340 || moved <= 12 || moved > 20) return false
      touchDbg(`兜底长按 held=${held}ms moved=${Math.round(moved)}px`)
      longPress(lastX, lastY)
      return fired
    }
    const onTouchEnd = (e: TouchEvent) => {
      clearTimer()
      const held = startedAt ? Date.now() - startedAt : 0
      if (endLongPressFallback(held)) {
        e.preventDefault() // 拦掉长按抬手后的合成 click
      }
      armed = false
      if (fired) {
        // 长按后松手：拦掉合成 click（防止误触页面元素），再弹出延后的取词菜单
        e.preventDefault()
        const open = pendingOpen
        pendingOpen = null
        touchDbg(`end fired=1 held=${held}ms`)
        open?.()
        return
      }
      touchDbg(`end fired=0 held=${held}ms moved=${Math.round(moved)}px`)
      // 快速 tap：清程序化选区
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) sel.removeAllRanges()
    }
    const onTouchCancel = () => {
      // iOS 常在长按后以 touchcancel 收尾（系统接管手势 / 抬起被判定为打断），旧版在这里
      // 直接丢弃 pendingOpen ⇒ 蓝底留在屏上、浮窗永不出现。长按已成立（fired）时按同样的
      // 「松手开窗」处理：意图已由蓝底表达，手指已离屏故无误触风险。
      clearTimer()
      const held = startedAt ? Date.now() - startedAt : 0
      endLongPressFallback(held)
      armed = false
      const open = pendingOpen
      pendingOpen = null
      touchDbg(`cancel fired=${fired ? 1 : 0} held=${held}ms`)
      if (fired) open?.()
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: false })
    el.addEventListener('touchcancel', onTouchCancel)
    return () => {
      clearTimer()
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [buildQuoteSnap, fireQuote])

  useImperativeHandle(ref, () => ({
    scrollToPage(page: number) {
      const el = scrollRef.current?.querySelector<HTMLElement>(`.pv-page[data-page="${page}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
    fitWidth() {
      const el = scrollRef.current
      if (!el || !pdf) return
      const w = el.clientWidth - 4
      if (w <= 0) return
      pdf
        .getPage(1)
        .then((p) => {
          const vp = p.getViewport({ scale: 1 })
          // floor 到两位小数（勿四舍五入）：舍入向上会让页宽超出容器 1~2px，
          // 适宽状态下仍剩横向微滑（user 反馈 iPad 可左右滑的次生根因）
          const next = Math.min(3, Math.max(0.4, Math.floor((w / vp.width) * 100) / 100))
          onScaleChange(next)
        })
        .catch(() => {})
    },
  }))

  // 松开鼠标（主键）= 宿主的唤出手势：有选区即请宿主开浮窗
  const handleMouseUp = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const snap = buildQuoteSnap()
    if (snap) fireQuote(snap)
  }

  // 帧内按下即关窗（宿主的「点浮窗外关窗」对帧内事件不生效）；紧随的 mouseup 若有选区会重开
  useEffect(() => {
    const onDown = () => fireQuoteClose()
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [fireQuoteClose])

  // 帧内滚动同样关窗（fixed 浮窗会漂离锚点）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', fireQuoteClose, { passive: true })
    return () => el.removeEventListener('scroll', fireQuoteClose)
  }, [fireQuoteClose])

  // 点词 → 开生词批注卡（文本层 z3 在标色层之上，tap 命中透明 span，经 caret 取词）
  const handleTap = (e: React.MouseEvent) => {
    const sel = window.getSelection()
    if (sel && sel.toString().trim()) return // 拖选/长按选词不算点击
    // 主路径：按标记层几何命中。蓝标坐标来自 canvas 采样（整词、与视觉严格一致），
    // data-term 即 note.term；而文本层的 .pv-hit 要求「某个 DOM span 恰好含整词」——
    // pdf.js 把词拆进多个 item（logarithmically）、词形屈折（gate→gated）、surface
    // 被截断（ConvS2S→ConvS2）时都没有 .pv-hit，旧代码于是静默 return（user 反馈
    // 「点不出单词卡」）。容差 3px 吸收指尖偏移，命中点最近的标。
    let mark: { note: VocabNote; rect: ScreenRect } | null = null
    let bestGap = Infinity
    for (const el of document.querySelectorAll<HTMLElement>('.pv-mark[data-term]')) {
      const r = el.getBoundingClientRect()
      if (r.width <= 0) continue
      const gap = Math.max(r.left - e.clientX, 0, e.clientX - r.right, r.top - e.clientY, 0, e.clientY - r.bottom)
      if (gap > 3 || gap >= bestGap) continue
      const n = notes.find((x) => x.term === el.dataset.term)
      if (n) {
        mark = { note: n, rect: { x: r.left, y: r.top, w: r.width, h: r.height } }
        bestGap = gap
      }
    }
    const hit = wordAtPoint(e.clientX, e.clientY)
    if (mark) {
      onWordOpen(mark.note, hit?.rect ?? mark.rect)
      return
    }
    if (!hit) return
    const w = hit.word.toLowerCase()
    const note = notes.find((n) => n.surface.toLowerCase() === w || n.term.toLowerCase() === w)
    if (note) onWordOpen(note, hit.rect)
  }

  return (
    <div className="pv-scroll" ref={scrollRef} onMouseUp={handleMouseUp} onClick={handleTap}>
      {pages.length === 0 && <div className="pv-hint">正在加载 PDF…</div>}
      {pages.map((n) => (
        <PageView
          key={`${src}-${n}`}
          pdf={pdf!}
          pageNumber={n}
          scale={scale}
          notes={notes}
          linesMap={linesMap.current}
          pendingWords={pendingWords}
          manualSel={manualSel}
        />
      ))}
      {/* 批注层：绝对定位在滚动内容坐标系里（随 PDF 一起滚动），渲染在页之上 */}
      <AnnoLayer annos={annos} scrollerRef={scrollRef} scale={scale} onEdit={onAnnoEdit} onDelete={onAnnoDelete} />
    </div>
  )
})
