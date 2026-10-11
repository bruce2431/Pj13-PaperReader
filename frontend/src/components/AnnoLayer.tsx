// AnnoLayer —— PDF 右侧批注层（悬浮批注卡）
//
// 位置语义（用户定案）：批注卡落在 PDF 纸张之外的右侧空白区，与所注句子的【末行】
// 竖向对齐。折叠态只是一个极小的气泡标记（不渲染正文），鼠标悬停（触屏为点按）
// 才展开渲染 markdown 正文。
//
// 展开方向（用户定案）：卡片【一律向右展开】（贴在气泡标记右侧），按右侧净空收窄
// 宽度以填满页边空白；净空不足时整体左滑到贴住可视右缘，不再翻到标记左侧去盖正文。
// 卡片与句子之间不画引线，只靠竖向对齐对应。
//
// 几何：卡片锚点坐标是页面归一化矩形（与缩放无关），渲染时按当前页元素的实测像素
// 尺寸乘回去 → 任何缩放/窗口宽度下都贴住句尾；层本身是 .pv-scroll 的绝对定位子节点，
// 与 PDF 内容同一坐标系（随滚动一起移动，无需在滚动时重算）。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AnnoNote } from '../types'
import { renderMarkdown } from '../md'

/** 展开后的卡片宽度上限（折叠态仅 MARK 高的气泡标记） */
const CARD_W = 320
/** 卡片宽度下限：右侧净空不足时最多收到这么窄，再窄就没法读了 */
const CARD_MIN_W = 260
const MARK = 22
/** 标记与展开卡之间的间距 */
const CARD_GAP = MARK + 10
/** 悬停可用时才挂 hover 展开（触屏改点按，避免 tap 派发的 mouseenter 立刻被 click 关掉） */
const CAN_HOVER = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches

interface Pos {
  anno: AnnoNote
  /** 气泡标记左上角（层内坐标） */
  left: number
  top: number
  /** 可视右缘（层内坐标）：展开卡右缘不许越过它 */
  visRight: number
}

interface AnnoLayerProps {
  annos: AnnoNote[]
  /** 滚动容器（.pv-scroll）：页元素几何与可视宽度的测量基准 */
  scrollerRef: React.RefObject<HTMLDivElement>
  /** 缩放：变化即页元素尺寸变化 → 重算（与 ResizeObserver 双保险） */
  scale: number
  /** 改正文：把批注与其气泡的屏幕位置交给 App 打开编辑卡 */
  onEdit: (anno: AnnoNote, at: { x: number; y: number }) => void
  /** 删批注（气泡内已二次确认） */
  onDelete: (anno: AnnoNote) => void
}

export function AnnoLayer({ annos, scrollerRef, scale, onEdit, onDelete }: AnnoLayerProps) {
  const [pos, setPos] = useState<Pos[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [open, setOpen] = useState<string | null>(null)
  const raf = useRef(0)

  const measure = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    setSize({ w: scroller.scrollWidth, h: scroller.scrollHeight })
    if (!annos.length) {
      setPos([])
      return
    }
    const sr = scroller.getBoundingClientRect()
    const items: Pos[] = []
    for (const a of annos) {
      const pageEl = scroller.querySelector<HTMLElement>(`.pv-page[data-page="${a.page}"]`)
      if (!pageEl) continue
      const pr = pageEl.getBoundingClientRect()
      if (!(pr.width > 0 && pr.height > 0)) continue
      const [, yr, wr, hr] = a.rect
      if (!(wr > 0)) continue
      const pageLeft = pr.left - sr.left + scroller.scrollLeft
      const pageTop = pr.top - sr.top + scroller.scrollTop
      const endY = pageTop + (yr + hr / 2) * pr.height
      // 标记贴纸张右侧 14px：位置固定不随展开变，展开卡由 Balloon 向右贴住标记排布
      const visRight = scroller.clientWidth + scroller.scrollLeft - 4
      const left = pageLeft + pr.width + 14
      items.push({ anno: a, left, top: endY - MARK / 2, visRight })
    }
    // 同侧相邻批注竖向避让（折叠态只有 22px 高，密排时按顺序下推）
    items.sort((a, b) => a.top - b.top || a.left - b.left)
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]
      const cur = items[i]
      if (Math.abs(cur.left - prev.left) < 2 && cur.top - prev.top < MARK + 6) cur.top = prev.top + MARK + 6
    }
    setPos(items)
  }, [annos, scrollerRef])

  // 页元素尺寸/位置变化（懒渲染从占位 1px 变实尺寸、缩放、换篇）与窗口变化都要重算
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    measure()
    const ro = new ResizeObserver(() => measure())
    ro.observe(scroller)
    for (const el of Array.from(scroller.querySelectorAll('.pv-page'))) ro.observe(el)
    const onScroll = () => {
      // 内容坐标不随纵向滚动变，但横向滚动（放大后）会改变可视右缘的夹取基准
      if (raf.current) return
      raf.current = requestAnimationFrame(() => {
        raf.current = 0
        measure()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', measure)
    // 懒渲染页在滚动中才建 DOM：观察器建好后再补挂新出现的页元素
    const mo = new MutationObserver(() => {
      for (const el of Array.from(scroller.querySelectorAll('.pv-page'))) ro.observe(el)
      measure()
    })
    mo.observe(scroller, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', measure)
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    }
  }, [measure, scale, scrollerRef])

  return (
    <div className="pv-anno-layer" style={{ width: size.w, height: size.h }}>
      {pos.map((p) => (
        <Balloon
          key={p.anno.id}
          pos={p}
          open={open === p.anno.id}
          onToggle={(v) => setOpen(v ? p.anno.id : null)}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

function Balloon({
  pos,
  open,
  onToggle,
  onEdit,
  onDelete,
}: {
  pos: Pos
  open: boolean
  onToggle: (v: boolean) => void
  onEdit: (anno: AnnoNote, at: { x: number; y: number }) => void
  onDelete: (anno: AnnoNote) => void
}) {
  const a = pos.anno
  const markRef = useRef<HTMLDivElement | null>(null)
  // 删除二次确认：点「删除」先变成「确认删除？」，4s 无后续动作自动复原（不弹原生 confirm）
  const [confirmDel, setConfirmDel] = useState(false)
  useEffect(() => {
    if (!confirmDel) return
    const t = setTimeout(() => setConfirmDel(false), 4000)
    return () => clearTimeout(t)
  }, [confirmDel])
  // 一律向右展开：先按标记右侧的净空定宽度（不够就让卡片收窄，最低 CARD_MIN_W），
  // 再让卡片右缘贴住可视右缘；净空实在太窄就整体左滑（保持完整可见，宁可压一点正文边缘，
  // 也不翻到标记左侧去盖住正文）。
  const avail = pos.visRight - (pos.left + CARD_GAP)
  const width = Math.max(CARD_MIN_W, Math.min(CARD_W, avail))
  const offLeft = Math.min(CARD_GAP, pos.visRight - pos.left - width)
  return (
    <div
      className={`pv-anno${open ? ' open' : ''}`}
      style={{ left: pos.left, top: pos.top, width: MARK }}
      onMouseEnter={CAN_HOVER ? () => onToggle(true) : undefined}
      onMouseLeave={CAN_HOVER ? () => onToggle(false) : undefined}
      onClick={(e) => {
        e.stopPropagation()
        // 有 hover 的设备：展开由 mouseenter 负责，点击只做「确保打开」——
        // 否则 mouseenter 先置 open、紧接着 click 又 toggle 回 false（点了反而关掉）
        onToggle(CAN_HOVER ? true : !open)
      }}
    >
      <div className="pv-anno-mark" ref={markRef} title="批注">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.4 9.4 0 0 1-2.9-.5L3 21l1.6-4.9A8.4 8.4 0 0 1 3.6 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8.4 8.4z" />
        </svg>
      </div>
      {open && (
        <div className="pv-anno-body" style={{ left: offLeft, width }}>
          <div className="pv-anno-head">
            <span className="pv-anno-author">{a.author}</span>
            <span className="pv-anno-sep">·</span>
            <span>第 {a.page} 页</span>
            {a.updatedAt && <span className="pv-anno-edited">已编辑</span>}
            <span className="pv-anno-time">{a.createdAt}</span>
          </div>
          {a.quote && <div className="pv-anno-quote">{a.quote}</div>}
          <div className="pv-anno-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.text) }} />
          <div className="pv-anno-actions">
            <button
              className="pv-mini"
              onClick={(e) => {
                e.stopPropagation()
                const r = markRef.current?.getBoundingClientRect()
                onEdit(a, { x: r ? r.right : 0, y: r ? r.top : 0 })
              }}
            >
              编辑
            </button>
            <button
              className={`pv-mini${confirmDel ? ' danger' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                if (confirmDel) onDelete(a)
                else setConfirmDel(true)
              }}
              onBlur={() => setConfirmDel(false)}
            >
              {confirmDel ? '确认删除？' : '删除'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
