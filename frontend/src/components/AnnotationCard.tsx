// AnnotationCard —— 生词批注卡（floria 极简风：黑白线条 + 唯一蓝）
// 有 rect → 锚定在词左侧/右侧（按词在屏幕左右半区自动选侧）
// 无 rect → 固定右侧（抽屉点词 / 生成模式）
// card.busy = 正在调 /api/vocab/generate；card.error = 生成失败原因
// 锚定卡（rect 存在）：PDF 滚动使原文离开原位超过 DISMISS_MARGIN 自动关闭
// 通用：点击卡片以外区域（空白/其他词/抽屉/顶栏）自动关闭
import { useEffect, useRef, useState } from 'react'
import type { VocabNote, VocabPatch, ScreenRect } from '../types'

export interface CardState {
  note: VocabNote | null
  word: string
  rect?: ScreenRect
  busy?: boolean
  error?: string
}

interface AnnotationCardProps {
  card: CardState
  onClose: () => void
  /** 改释义/词根（锚点、词形不可改）；抛错则卡片就地显示 */
  onSaveNote?: (patch: VocabPatch) => Promise<void>
  /** 删这张卡（卡内二次确认后调用） */
  onDeleteNote?: () => Promise<void>
}

const CARD_W = 344
const DISMISS_MARGIN = 24

function cardStyle(rect?: ScreenRect): React.CSSProperties {
  if (!rect) return { right: 20, top: 20 }
  const centerX = rect.x + rect.w / 2
  const placeRight = centerX < window.innerWidth / 2
  let left = placeRight ? rect.x + rect.w + 14 : rect.x - 14 - CARD_W
  left = Math.max(12, Math.min(left, window.innerWidth - CARD_W - 12))
  const top = Math.max(12, Math.min(rect.y - 10, window.innerHeight - 320))
  return { left, top }
}

// 词根行拆「词素 + 释义」：GLM 约定格式 `mit：拉丁语 = soften，意为"变软"`
// （容错半角冒号；无法拆分的整体说明行无冒号 → 不出 chip，整行作释义）
function splitRoot(r: string): [string, string] {
  const i = r.search(/[：:]/)
  return i === -1 ? ['', r] : [r.slice(0, i).trim(), r.slice(i + 1).trim()]
}

// 单词发音：浏览器自带 Web Speech API（免费无 key，iPad Safari 支持）。
// speak 前先 cancel 打断上一次；iOS/iPadOS 要求用户手势内调用（按钮点击满足）

export function AnnotationCard({ card, onClose, onSaveNote, onDeleteNote }: AnnotationCardProps) {
  const note = card.note
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [speaking, setSpeaking] = useState(false)
  // 编辑态：释义一行 + 词根每行一条（与卡片展示一一对应，保存即覆盖）
  const [editing, setEditing] = useState(false)
  const [meaning, setMeaning] = useState('')
  const [roots, setRoots] = useState('')
  const [saving, setSaving] = useState(false)
  const [editErr, setEditErr] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)

  // 换卡/关卡时打断还在播的读音，避免旧词读音串进新卡；顺带复位编辑/确认态
  useEffect(() => {
    setEditing(false)
    setEditErr('')
    setConfirmDel(false)
    return () => window.speechSynthesis?.cancel()
  }, [card])

  // 删除二次确认：4s 无后续动作自动复原
  useEffect(() => {
    if (!confirmDel) return
    const t = setTimeout(() => setConfirmDel(false), 4000)
    return () => clearTimeout(t)
  }, [confirmDel])

  const startEdit = () => {
    if (!note) return
    setMeaning(note.meaning)
    setRoots(note.roots.join('\n'))
    setEditErr('')
    setEditing(true)
  }

  const saveEdit = async () => {
    if (!onSaveNote) return
    setSaving(true)
    setEditErr('')
    try {
      await onSaveNote({
        meaning,
        roots: roots
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      })
      setEditing(false)
    } catch (e) {
      setEditErr(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async () => {
    if (!onDeleteNote) return
    setSaving(true)
    setEditErr('')
    try {
      await onDeleteNote()
    } catch (e) {
      setEditErr(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setSaving(false)
      setConfirmDel(false)
    }
  }

  const handleSpeak = () => {
    const synth = window.speechSynthesis
    if (!synth) return
    // 只在有播放时 cancel：Chrome 上无播放也 cancel 紧跟 speak 有丢音竞态
    if (synth.speaking || synth.pending) synth.cancel()
    const u = new SpeechSynthesisUtterance(card.word)
    u.lang = 'en-US'
    u.rate = 0.9
    u.onstart = () => setSpeaking(true)
    u.onend = () => setSpeaking(false)
    u.onerror = () => setSpeaking(false)
    synth.speak(u)
  }

  // 锚定卡随原文位置远离自动关闭：卡片钉在屏幕上不动，.pv-scroll 滚动（上滑/下滑/横滚）
  // 累计超过 DISMISS_MARGIN 视为原文已离开原位，自动关。busy 生成中也启用——
  // 迟到的响应由 App 的取消计数（pendingGen.closed）静默吸收，不会重弹卡
  useEffect(() => {
    if (!card.rect) return
    const scroller = document.querySelector<HTMLElement>('.pv-scroll')
    if (!scroller) return
    const top0 = scroller.scrollTop
    const left0 = scroller.scrollLeft
    const onScroll = () => {
      if (Math.abs(scroller.scrollTop - top0) > DISMISS_MARGIN || Math.abs(scroller.scrollLeft - left0) > DISMISS_MARGIN) {
        onClose()
      }
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [card.rect, onClose])

  // 点击卡外自动关闭：用 pointerdown（先于 click）判定——点其他词/抽屉项时先关旧卡，
  // 随后 click 再开新卡，时序天然正确不会闪断。busy 生成中也启用（取消路径之一，
  // 迟到响应由 App 取消计数吸收，不重弹）
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [card, onClose])

  return (
    <div className="pv-card" ref={rootRef} style={cardStyle(card.rect)}>
      <div className="pv-card-head">
        <div className="pv-card-title">
          <span className="pv-card-term">{card.word}</span>
          {note?.meaning && <div className="pv-card-mean">{note.meaning}</div>}
        </div>
        <button className={`pv-card-speak${speaking ? ' speaking' : ''}`} onClick={handleSpeak} title="朗读发音">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </svg>
        </button>
        <button className="pv-card-close" onClick={onClose} title="关闭">
          ×
        </button>
      </div>

      {editing && note ? (
        <div className="pv-card-body pv-card-edit">
          <div className="pv-card-overline">释义</div>
          <textarea
            className="pv-edit-meaning"
            value={meaning}
            rows={2}
            spellCheck={false}
            onChange={(e) => setMeaning(e.target.value)}
          />
          <div className="pv-card-overline">词根拆解（每行一条，格式「词素：说明」）</div>
          <textarea
            className="pv-edit-roots"
            value={roots}
            rows={Math.max(3, Math.min(8, note.roots.length || 3))}
            spellCheck={false}
            onChange={(e) => setRoots(e.target.value)}
          />
          {editErr && <div className="pv-card-hint pv-card-err">{editErr}</div>}
          <div className="pv-card-actions">
            <button className="pv-mini" disabled={saving} onClick={() => setEditing(false)}>
              取消
            </button>
            <button className="pv-btn pv-btn-primary" disabled={saving || !meaning.trim()} onClick={saveEdit}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      ) : card.busy ? (
        <div className="pv-card-body">
          <div className="pv-card-loading">
            <span className="pv-spin" />
            <span>正在生成「{card.word}」的单词卡</span>
          </div>
          <div className="pv-card-hint">AI 正在拆解词根词缀，约需数秒</div>
        </div>
      ) : card.error ? (
        <div className="pv-card-body">
          <div className="pv-card-muted">生成失败</div>
          <div className="pv-card-hint">{card.error}</div>
        </div>
      ) : note ? (
        <>
          {note.roots.length > 0 && (
            <div className="pv-card-roots">
              <div className="pv-card-overline">词根拆解</div>
              <ul>
                {note.roots.map((r) => {
                  const [m, d] = splitRoot(r)
                  return (
                    <li key={r}>
                      {m && <span className="pv-root-chip">{m}</span>}
                      <span className="pv-root-desc">{d}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {editErr && <div className="pv-card-hint pv-card-err">{editErr}</div>}
          <div className="pv-card-foot-row">
            {note.anchor ? (
              <div className="pv-card-foot">
                <span>{note.anchor.pdf.replace(/\.pdf$/i, '')}</span>
                <span className="pv-card-foot-sep">·</span>
                <span>第 {note.anchor.page} 页</span>
                {note.updatedAt && <span className="pv-card-edited">已编辑</span>}
              </div>
            ) : (
              <span />
            )}
            {note.anchor && (onSaveNote || onDeleteNote) && (
              <div className="pv-card-actions">
                {onSaveNote && (
                  <button className="pv-mini" onClick={startEdit}>
                    编辑
                  </button>
                )}
                {onDeleteNote && (
                  <button
                    className={`pv-mini${confirmDel ? ' danger' : ''}`}
                    onClick={() => (confirmDel ? doDelete() : setConfirmDel(true))}
                    onBlur={() => setConfirmDel(false)}
                  >
                    {confirmDel ? '确认删除？' : '删除'}
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="pv-card-body">
          <div className="pv-card-muted">生词卡待生成</div>
          <div className="pv-card-hint">右键单词 → 生成单词卡</div>
        </div>
      )}
    </div>
  )
}
