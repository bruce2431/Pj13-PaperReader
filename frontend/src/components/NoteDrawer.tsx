// NoteDrawer —— 左侧生词笔记抽屉（覆盖在 PDF 之上，可开关）
import { useEffect, useState } from 'react'
import type { VocabNote } from '../types'
import { backendKind } from '../api'

interface NoteDrawerProps {
  notes: VocabNote[]
  onPick: (note: VocabNote) => void
  onClose: () => void
}

export function NoteDrawer({ notes, onPick, onClose }: NoteDrawerProps) {
  // 页脚要报「实际在用哪个后端」：旧版按 VITE_API_BASE 环境变量判定，本机直连容器
  // 后端时会误报 mock（数据其实就是后端来的）→ 改走与本页请求同一套探测
  const [kind, setKind] = useState<'real' | 'mock' | null>(null)
  useEffect(() => {
    let alive = true
    backendKind().then((k) => {
      if (alive) setKind(k)
    })
    return () => {
      alive = false
    }
  }, [])
  return (
    <div className="pv-drawer">
      <div className="pv-drawer-head">
        <span className="pv-drawer-title">生词笔记</span>
        <span className="pv-drawer-count">{notes.length}</span>
        <button className="pv-drawer-close" onClick={onClose} title="收起笔记">
          ›
        </button>
      </div>
      <div className="pv-drawer-body">
        {notes.length === 0 && <div className="pv-drawer-empty">本篇暂无生词笔记</div>}
        {notes.map((n) => (
          <button key={n.term} className="pv-note" onClick={() => onPick(n)}>
            <div className="pv-note-term">{n.term}</div>
            <div className="pv-note-meaning">{n.meaning}</div>
            {n.anchor && (
              <div className="pv-note-anchor">
                P{n.anchor.page} · {n.anchor.pdf}
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="pv-drawer-foot">
        {kind === 'real' ? '数据源 容器后端' : kind === 'mock' ? '数据源 mock（本地样例）' : '数据源 探测中…'}
      </div>
    </div>
  )
}
