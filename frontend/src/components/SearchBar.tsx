// SearchBar —— 全文搜索条（借鉴 PdfCraft 的 find-as-you-type + find→comment）
// Ctrl/⌘+F 唤出；Enter 下一条、Shift+Enter 上一条、Esc 收起。
// 命中数来自 PdfViewer 的跨页索引；「批注」直接把当前命中交给 AnnoComposer。
import { useEffect, useRef } from 'react'

interface SearchBarProps {
  query: string
  onQuery: (q: string) => void
  count: number
  /** 0-based；无命中为 -1 */
  active: number
  searching: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  onAnno: () => void
}

export function SearchBar({ query, onQuery, count, active, searching, onPrev, onNext, onClose, onAnno }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="pv-searchbar" onClick={(e) => e.stopPropagation()}>
      <span className="pv-search-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.4-3.4" />
        </svg>
      </span>
      <input
        ref={inputRef}
        className="pv-search-input"
        value={query}
        placeholder="搜索全文…"
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="pv-search-count">
        {searching ? '搜索中…' : count > 0 ? `${active + 1} / ${count}` : query.trim() ? '0' : ''}
      </span>
      <button className="pv-mini" onClick={onPrev} disabled={count === 0} title="上一条（Shift+Enter）">
        ↑
      </button>
      <button className="pv-mini" onClick={onNext} disabled={count === 0} title="下一条（Enter）">
        ↓
      </button>
      <button className="pv-mini" onClick={onAnno} disabled={count === 0} title="用当前命中的原文创建批注">
        批注
      </button>
      <button className="pv-card-close" onClick={onClose} title="关闭（Esc）">
        ×
      </button>
    </div>
  )
}
