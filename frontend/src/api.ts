// Pj13 预览前端 · 后端接口契约
//
// 后端实现于 .claude/preview/backend/server.mjs（笔记存 SQLite：assests/notes.db）：
//   GET    {base}/api/fs/list?path=<相对路径> → FsListing（素材库目录页数据源）
//   GET    {base}/api/vocab?pdf=<相对路径>    → VocabNote[]
//   POST   {base}/api/vocab/generate          → VocabNote（body: GeneratePayload）
//   PUT    {base}/api/vocab                   → VocabNote（改释义/词根：{pdf, term, meaning?, roots?}）
//   DELETE {base}/api/vocab?pdf=&term=        → {ok:true}
//   GET    {base}/api/anno?pdf=<相对路径>     → AnnoNote[]
//   POST   {base}/api/anno                    → AnnoNote（body: AnnoPayload）
//   PUT    {base}/api/anno                    → AnnoNote（改正文：{id, text}）
//   DELETE {base}/api/anno?id=                → {ok:true}
// 前端被 web 容器托管时同源命中 /api/fs/list → realBackend，否则回退 mock。

import type { AnnoNote, AnnoPayload, FsListing, VocabNote, VocabPatch, GeneratePayload } from './types'
import { mockBackend } from './api/mock'

export interface PreviewBackend {
  /** 列举素材库某目录（path='' 为根）：只含子目录与 PDF */
  listDir(path: string): Promise<FsListing>
  getVocabNotes(pdf: string): Promise<VocabNote[]>
  generateCard(payload: GeneratePayload): Promise<VocabNote>
  /** 改释义/词根；返回更新后的卡 */
  updateVocab(pdf: string, term: string, patch: VocabPatch): Promise<VocabNote>
  deleteVocab(pdf: string, term: string): Promise<void>
  /** 某篇 PDF 的全部批注 */
  getAnnos(pdf: string): Promise<AnnoNote[]>
  createAnno(payload: AnnoPayload): Promise<AnnoNote>
  /** 改批注正文；返回更新后的批注 */
  updateAnno(id: string, text: string): Promise<AnnoNote>
  deleteAnno(id: string): Promise<void>
}

/** 写请求统一出口：非 2xx 时优先透传后端的 {error} 文案 */
async function send(path: string, method: 'PUT' | 'DELETE', body?: unknown): Promise<any> {
  const r = await fetch(withToken(apiUrl(path)), {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `${method} ${path} HTTP ${r.status}`)
  return d
}

// API 地址解析：优先 VITE_API_BASE（显式配置）；缺省用「相对页面基址」——
// 不能写死绝对路径 /api/*：本机 iframe 直连 http://127.0.0.1:<port>/ 时没问题，
// 但经网关同源代理 /backend/<label>/ 托管（floria.local / iPad 等非 localhost 宿主）
// 时绝对路径会逃出代理前缀、打到网关自身 /api（token 校验 401）→ 探测失败锁 mock。
const configuredBase = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '')
const token = new URLSearchParams(window.location.search).get('token') || ''

function apiUrl(path: string): string {
  return configuredBase ? `${configuredBase}/${path}` : new URL(path, document.baseURI).href
}

function withToken(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return token ? `${url}${sep}token=${encodeURIComponent(token)}` : url
}

const realBackend: PreviewBackend = {
  async listDir(path) {
    const r = await fetch(withToken(apiUrl(`api/fs/list?path=${encodeURIComponent(path)}`)))
    if (!r.ok) throw new Error(`fs list HTTP ${r.status}`)
    return r.json()
  },
  async getVocabNotes(pdf) {
    const r = await fetch(withToken(apiUrl(`api/vocab?pdf=${encodeURIComponent(pdf)}`)))
    if (!r.ok) throw new Error(`vocab HTTP ${r.status}`)
    return r.json()
  },
  async generateCard(payload) {
    const r = await fetch(withToken(apiUrl('api/vocab/generate')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || `generate HTTP ${r.status}`)
    return d as VocabNote
  },
  async updateVocab(pdf, term, patch) {
    return (await send('api/vocab', 'PUT', { pdf, term, ...patch })) as VocabNote
  },
  async deleteVocab(pdf, term) {
    await send(`api/vocab?pdf=${encodeURIComponent(pdf)}&term=${encodeURIComponent(term)}`, 'DELETE')
  },
  async getAnnos(pdf) {
    const r = await fetch(withToken(apiUrl(`api/anno?pdf=${encodeURIComponent(pdf)}`)))
    if (!r.ok) throw new Error(`anno HTTP ${r.status}`)
    return r.json()
  },
  async createAnno(payload) {
    const r = await fetch(withToken(apiUrl('api/anno')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || `anno HTTP ${r.status}`)
    return d as AnnoNote
  },
  async updateAnno(id, text) {
    return (await send('api/anno', 'PUT', { id, text })) as AnnoNote
  },
  async deleteAnno(id) {
    await send(`api/anno?id=${encodeURIComponent(id)}`, 'DELETE')
  },
}

// 运行时探测：前端被 web 容器（preview.json backend）托管时同源必有 /api/*，
// 用一次轻量探测切到 realBackend；否则（容器外静态预览 / vite 单独跑）本次回退 mock。
// 只缓存「探测成功」：页面若在容器重启空窗期加载，mock 不落缓存，
// 下一次 api 调用会重新探测自愈（否则整页锁死 mock，user 遇过）。
let activeBackend: PreviewBackend | null = null
async function resolveBackend(): Promise<PreviewBackend> {
  if (activeBackend) return activeBackend
  try {
    const r = await fetch(withToken(apiUrl('api/fs/list?path=')), {
      headers: { Accept: 'application/json' },
    })
    if (r.ok) {
      const d = await r.json()
      if (d && Array.isArray(d.entries)) {
        activeBackend = realBackend
        return activeBackend
      }
    }
  } catch {
    /* 后端未就绪 → 本次走 mock，不缓存 */
  }
  return mockBackend
}

export const api: PreviewBackend = {
  async listDir(path: string) {
    return (await resolveBackend()).listDir(path)
  },
  async getVocabNotes(pdf: string) {
    return (await resolveBackend()).getVocabNotes(pdf)
  },
  async generateCard(payload: GeneratePayload) {
    return (await resolveBackend()).generateCard(payload)
  },
  async updateVocab(pdf: string, term: string, patch: VocabPatch) {
    return (await resolveBackend()).updateVocab(pdf, term, patch)
  },
  async deleteVocab(pdf: string, term: string) {
    return (await resolveBackend()).deleteVocab(pdf, term)
  },
  async getAnnos(pdf: string) {
    return (await resolveBackend()).getAnnos(pdf)
  },
  async createAnno(payload: AnnoPayload) {
    return (await resolveBackend()).createAnno(payload)
  },
  async updateAnno(id: string, text: string) {
    return (await resolveBackend()).updateAnno(id, text)
  },
  async deleteAnno(id: string) {
    return (await resolveBackend()).deleteAnno(id)
  },
}

/** 当前实际在用哪个后端（走同一套探测，不另立判据）——给抽屉页脚之类的地方显示真实来源 */
export async function backendKind(): Promise<'real' | 'mock'> {
  return (await resolveBackend()) === realBackend ? 'real' : 'mock'
}
