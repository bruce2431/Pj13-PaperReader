// AnnoComposer —— 批注的编辑卡：新建（选中区块 → 右键「创建批注」）与改写已存批注共用
// 位置：贴近所选区块（新建）或批注气泡（编辑），夹在视口内；滚动远离自动收起
// 正文是 markdown 源文本，保存后由 AnnoLayer 的卡片渲染（md.ts）
import { useEffect, useRef, useState } from 'react'

export interface AnnoDraft {
  /** 锚点页（选区末行所在页） */
  page: number
  /** 选中区块末行的页面归一化矩形 (x, y, w, h) */
  rect: [number, number, number, number]
  /** 引用原文 */
  quote: string
  /** 选区末行（或批注气泡）屏幕矩形（定位编辑卡用） */
  x: number
  y: number
}

interface AnnoComposerProps {
  draft: AnnoDraft
  author: string
  busy?: boolean
  error?: string
  /** 编辑已存批注时的初始正文（新建留空） */
  initialText?: string
  /** 卡片标题（缺省「新建批注」） */
  title?: string
  onSave: (text: string) => void
  onCancel: () => void
}

const CARD_W = 360
const DISMISS_MARGIN = 24

function cardStyle(x: number, y: number): React.CSSProperties {
  const placeRight = x < window.innerWidth / 2
  let left = placeRight ? x + 18 : x - 18 - CARD_W
  left = Math.max(12, Math.min(left, window.innerWidth - CARD_W - 12))
  const top = Math.max(12, Math.min(y - 12, window.innerHeight - 300))
  return { left, top }
}

export function AnnoComposer({ draft, author, busy, error, initialText = '', title = '新建批注', onSave, onCancel }: AnnoComposerProps) {
  const [text, setText] = useState(initialText)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 自动聚焦并把光标落到末尾：改写既有批注时直接接着敲
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }, [])

  // Esc 取消 / Ctrl(⌘)+Enter 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (text.trim()) onSave(text)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [text, onSave, onCancel])

  // PDF 滚动远离所选区块即收起（编辑卡钉在屏幕上不动）
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>('.pv-scroll')
    if (!scroller) return
    const top0 = scroller.scrollTop
    const left0 = scroller.scrollLeft
    const onScroll = () => {
      if (Math.abs(scroller.scrollTop - top0) > DISMISS_MARGIN || Math.abs(scroller.scrollLeft - left0) > DISMISS_MARGIN)
        onCancel()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [onCancel])

  return (
    <div className="pv-composer" ref={rootRef} style={cardStyle(draft.x, draft.y)}>
      <div className="pv-composer-head">
        <span className="pv-composer-title">{title}</span>
        <span className="pv-composer-meta">
          {author} · 第 {draft.page} 页
        </span>
        <button className="pv-card-close" onClick={onCancel} title="取消（Esc）">
          ×
        </button>
      </div>
      {draft.quote && <div className="pv-composer-quote">{draft.quote}</div>}
      <textarea
        ref={taRef}
        className="pv-composer-input"
        value={text}
        placeholder="写下批注…支持 Markdown（**粗体**、`代码`、- 列表、> 引用）"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="pv-composer-err">{error}</div>}
      <div className="pv-composer-foot">
        <span className="pv-composer-hint">⌘/Ctrl + Enter 保存 · Esc 取消</span>
        <button className="pv-btn" onClick={onCancel}>
          取消
        </button>
        <button className="pv-btn pv-btn-primary" disabled={busy || !text.trim()} onClick={() => onSave(text)}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
