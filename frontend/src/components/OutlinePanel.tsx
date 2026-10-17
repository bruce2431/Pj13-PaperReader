// OutlinePanel —— PDF 自带书签/目录侧栏（借鉴 PdfCraft 的 Bookmarks 面板）
// 条目由 PdfViewer 在文档载入时解析（getOutline → named dest → page index）。
import { useEffect } from 'react'

export interface OutlineItem {
  title: string
  /** 1-based；解析失败为 null（仍展示标题） */
  page: number | null
  /** 目标在该页内的归一化纵坐标（0=页顶）；缺省/不可解析为 null */
  top?: number | null
  depth: number
}

interface OutlinePanelProps {
  items: OutlineItem[]
  loading: boolean
  onPick: (page: number, top?: number | null) => void
  onClose: () => void
}

export function OutlinePanel({ items, loading, onPick, onClose }: OutlinePanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="pv-outline" onClick={(e) => e.stopPropagation()}>
      <div className="pv-outline-head">
        <span className="pv-outline-title">目录</span>
        <span className="pv-outline-count">{items.length || ''}</span>
        <button className="pv-card-close" onClick={onClose} title="收起目录（Esc）">
          ×
        </button>
      </div>
      <div className="pv-outline-body">
        {loading && <div className="pv-outline-empty">正在读取目录…</div>}
        {!loading && !items.length && <div className="pv-outline-empty">本篇没有内置目录</div>}
        {items.map((it, i) => (
          <button
            key={`${i}-${it.title}`}
            className={`pv-outline-item${it.page == null ? ' disabled' : ''}`}
            style={{ paddingLeft: 8 + Math.min(6, it.depth) * 12 }}
            disabled={it.page == null}
            title={it.title}
            onClick={() => it.page != null && onPick(it.page, it.top)}
          >
            {it.title || '(未命名条目)'}
          </button>
        ))}
      </div>
    </div>
  )
}
