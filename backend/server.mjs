// Pj13 精读预览 · Web 容器后端
//
// 无依赖 node 静态服务器：托管 ../frontend/dist，并提供：
//   GET    /api/fs/list?path=<相对路径> → FsListing（素材库目录树：只出目录与 PDF）
//   GET    /pdfs/<相对路径>.pdf         → PDF 文件本体（项目根 assests/ 下）
//   GET    /api/vocab?pdf=<相对路径>    → VocabNote[]（生词卡）
//   POST   /api/vocab/generate          → VocabNote（LLM 拆词 → 入库）
//   PUT    /api/vocab                   → VocabNote（改释义/词根：{pdf, term, meaning?, roots?}）
//   DELETE /api/vocab?pdf=&term=        → {ok:true}
//   GET    /api/anno?pdf=<相对路径>     → AnnoNote[]
//   POST   /api/anno                    → AnnoNote（用户手写批注）
//   PUT    /api/anno                    → AnnoNote（改正文：{id, text}）
//   DELETE /api/anno?id=                → {ok:true}
//
// 笔记（生词卡 + 批注）存 SQLite：assests/notes.db，见 store.mjs（旧 <pdf名>.jsonl
// 只在首次启动导入一次，随后移入项目 .trash/）。
//
// 素材库根 = 项目根 assests/：目录页镜像其真实层级（子目录可进、面包屑可回退），
// 非目录非 .pdf 的文件（notes.db/.zip/.pptx/.md 等）一律不出现在列举里。
//
// 端口来源：网关 spawn 时设置 PORT 环境变量（preview.json backend.port=0 →
// 网关分配空闲端口并注入）；就绪探测路径 readyPath=/index.html（200 即就绪）。
// AI 配置：backend/config.json（相对本文件）OpenAI 兼容端点：
//   { "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "...", "model": "glm-5.3-flash" }
//   任何 OpenAI 兼容端点都可用（智谱 / OpenAI / DeepSeek / 本地 Ollama…），key 自备；缺 config.json 时仅
//   /api/vocab/generate 返回 503，其余功能（目录、阅读、批注、已有卡片）不受影响。

import { createServer } from 'node:http'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, posix, resolve, sep } from 'node:path'
import {
  deleteAnno,
  deleteVocab,
  findVocab,
  importJsonlOnce,
  insertAnno,
  insertVocab,
  listAnnos,
  listVocab,
  openStore,
  updateAnno,
  updateVocab,
} from './store.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(__dirname, '../frontend/dist')
// 素材库根（backend → preview → .claude → 项目根/assests）：PDF 与同名 .jsonl 生词笔记都在这里，
// 目录页按它的真实层级浏览；越界访问一律拒绝
const ASSETS = resolve(__dirname, '../../../assests')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
}

// ---- 素材库路径 ----
// 前端传的都是相对 assests 的 POSIX 路径（'' = 根，子目录如 '杨振宁相关理论专题'）；
// 统一归一后再判越界（resolve 会吃掉 .. 与重复分隔符）
function toRel(p) {
  const s = posix
    .normalize(String(p || '').replace(/\\/g, '/').replace(/^\/+/, ''))
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
  return s === '.' ? '' : s // 根目录统一用空串（normalize('') 会给出 '.'）
}

function safeResolve(rel) {
  const abs = resolve(ASSETS, toRel(rel))
  if (abs !== ASSETS && !abs.startsWith(ASSETS + sep)) throw new Error('路径越界')
  return abs
}

// 目录下递归数 PDF（目录行显示「N 个 PDF」；素材库体量小，实时数即可）
async function countPdfs(abs, depth = 0) {
  if (depth > 6) return 0
  let dirents = []
  try {
    dirents = await readdir(abs, { withFileTypes: true })
  } catch {
    return 0
  }
  let n = 0
  for (const d of dirents) {
    if (d.isDirectory()) n += await countPdfs(join(abs, d.name), depth + 1)
    else if (d.isFile() && extname(d.name).toLowerCase() === '.pdf') n += 1
  }
  return n
}

// 列举一个素材库目录：只出【子目录】与【.pdf】，其它文件（.jsonl/.zip/.pptx/.md…）忽略；
// 排序 = 目录优先，再按名称本地化排序（中文目录名与英文论文名混排时更符合直觉）
async function listDir(rel) {
  const abs = safeResolve(rel)
  const info = await stat(abs)
  if (!info.isDirectory()) throw new Error('不是目录')
  const dirents = await readdir(abs, { withFileTypes: true })
  const entries = []
  for (const d of dirents) {
    const child = posix.join(toRel(rel), d.name)
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: child, type: 'dir', pdfCount: await countPdfs(join(abs, d.name)) })
    } else if (d.isFile() && extname(d.name).toLowerCase() === '.pdf') {
      let st = null
      try {
        st = await stat(join(abs, d.name))
      } catch {}
      entries.push({
        name: d.name,
        path: child,
        type: 'pdf',
        // 相对 URL：经网关前缀托管时也能命中（前端按页面基址解析）
        url: `./pdfs/${child.split('/').map(encodeURIComponent).join('/')}`,
        size: st?.size ?? 0,
        mtime: st ? st.mtime.toISOString() : '',
      })
    }
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.type === 'dir' ? -1 : 1,
  )
  const cur = toRel(rel)
  const parent = cur ? posix.dirname(cur).replace(/^\.$/, '') || '' : null
  return { path: cur, parent, entries }
}

// 笔记存储 = SQLite（assests/notes.db，见 store.mjs）。pdf 相对路径（含子目录）就是表里的键；
// 路径仍过一遍 safeResolve 做越界校验：非法路径回 403，与旧 jsonl 时代口径一致
function pdfKey(pdf) {
  const rel = toRel(pdf)
  safeResolve(rel)
  return rel
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 原句中首个（不分大小写、整词）word 包上 ** **
function boldWord(sentence, word) {
  if (!sentence) return word
  const re = new RegExp(`\\b${escapeRe(word)}\\b`, 'i')
  return sentence.replace(re, (m) => `**${m}**`)
}

// ---- LLM 单词拆解（OpenAI 兼容 /chat/completions；GLM/DeepSeek 等经 config.json 切换） ----
const WORD_SYSTEM_PROMPT = `你是英语词汇学助手，分析学术论文中出现的英文单词。只输出一个 JSON 对象，不要输出其它内容：
{"lemma":"单词原形（小写）","hyphenated":"连字符拆分形态，如 un-pre-ced-ent-ed","meaning":"该词在此语境下的核心中文释义","roots":["逐词素解析，每条格式：词素：来源语或类型 = 原义，意为\\"中文\\""]}
roots 按前缀/词根/后缀顺序，每条一个词素，拉丁/希腊来源注明语源；无法拆分的普通词给一条整体说明。`

/** 从模型回复中提取 JSON（容忍 ```json 围栏与前后杂文本） */
function extractJson(s) {
  const t = String(s).replace(/```(?:json)?/gi, '').trim()
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i === -1 || j === -1 || j <= i) throw new Error(`AI 返回非 JSON：${t.slice(0, 120)}`)
  return t.slice(i, j + 1)
}

// 单次生成的总耗时上限：网关代理对上游「180s 无数据」即掐断连接
//（gateway.log 实测：2026-09-21 ConvS2S 请求 176s，落库 4s 后被掐，响应体其实已收全却没能回到浏览器
//  → 前端报「生成失败」而笔记已在库里）。
// 120s 留足余量（浏览器→网关→后端每跳都有开销），超时即失败、绝不落库。
const LLM_DEADLINE_MS = 120000
// 单次请求上限：防某一次连接挂死吃光整个预算（fetch 默认无超时）
const LLM_TRY_TIMEOUT_MS = 25000

async function llmWord(cfg, word, sentence) {
  const base = String(cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '')
  const startedAt = Date.now()
  const remain = () => LLM_DEADLINE_MS - (Date.now() - startedAt)
  const messages = [
    { role: 'system', content: WORD_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `单词：${word}\n原句：${sentence || '（未提供，按常见学术语境分析）'}`,
    },
  ]
  const body = (jsonMode) =>
    JSON.stringify({
      model: cfg.model || 'glm-5.3-flash',
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.3,
      messages,
    })
  // 单次请求：吃「剩余预算」与「单次超时」两个上限（取小），超时转成干净文案，别把 AbortError 抛给用户
  const attempt = async (jsonMode) => {
    const left = remain()
    if (left < 3000) throw new Error(`AI 生成超时（${LLM_DEADLINE_MS / 1000}s 内未取到结果，LLM 侧过载）`)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), Math.min(LLM_TRY_TIMEOUT_MS, left))
    try {
      return await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: body(jsonMode),
        signal: ac.signal,
      })
    } catch (e) {
      if (ac.signal.aborted) throw new Error('AI 生成超时（单次请求无响应）')
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
  // 429「访问量过大」(code 1305，智谱侧过载) → 退避重试；档位压缩到 5+10+15+20=50s 空闲，
  // 且每次退避前先看预算够不够（宁可少退一次，也不许突破全局截止）；
  // 重试收在 attempt 之上，json 请求与 400 降级请求都吃到超时与预算
  let r = await attempt(true)
  for (const wait of [5000, 10000, 15000, 20000]) {
    if (r.status !== 429) break
    if (remain() - wait < 3000) break // 预算不够这一次退避：就此收手，交给下面的 !r.ok 报错
    await new Promise((resolve) => setTimeout(resolve, wait))
    r = await attempt(true)
  }
  // 个别模型/供应商不支持 response_format=json_object（400）→ 降级重试，靠提示词约束
  if (r.status === 400) {
    r = await attempt(false)
  }
  if (!r.ok) throw new Error(`LLM HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const d = await r.json()
  const parsed = JSON.parse(extractJson(d.choices?.[0]?.message?.content))
  if (!Array.isArray(parsed.roots)) parsed.roots = parsed.roots ? [String(parsed.roots)] : []
  return parsed
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  // 归一化并阻止路径穿越
  const filePath = normalize(join(DIST, pathname))
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not file')
    const ext = extname(filePath).toLowerCase()
    const body = await readFile(filePath)
    // 缓存策略：/assets/ 内容带 hash 可永久缓存；index.html 等必须 no-cache，
    // 否则 iPad Safari 启发式缓存旧壳 → 加载旧 bundle，发版后"没变化"
    const immutable = pathname.startsWith('/assets/')
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(body)
  } catch {
    // SPA fallback：非文件路径一律回 index.html（本前端单页无路由，均回壳）
    try {
      const body = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      })
      res.end(body)
    } catch {
      res.writeHead(404).end('Not Found')
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  // 素材库目录列举（目录页数据源）
  if (p === '/api/fs/list') {
    const rel = url.searchParams.get('path') || ''
    try {
      return sendJson(res, 200, await listDir(rel))
    } catch (e) {
      return sendJson(res, /越界/.test(e.message) ? 403 : 404, { error: `目录读取失败：${e.message}` })
    }
  }
  // PDF 文件本体从 assests 直读：/pdfs/<相对路径>（safeResolve 拦路径穿越，保留子目录层级）
  if (p.startsWith('/pdfs/')) {
    const rel = decodeURIComponent(p.slice('/pdfs/'.length))
    if (!rel.toLowerCase().endsWith('.pdf')) {
      res.writeHead(404).end('Not Found')
      return
    }
    try {
      const body = await readFile(safeResolve(rel))
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-cache' })
      res.end(body)
    } catch {
      res.writeHead(404).end('Not Found')
    }
    return
  }
  if (p === '/api/vocab') {
    if (req.method === 'GET') {
      const raw = url.searchParams.get('pdf') || ''
      if (!toRel(raw)) return sendJson(res, 200, [])
      let pdf
      try {
        pdf = pdfKey(raw)
      } catch {
        return sendJson(res, 403, { error: '非法的 pdf 路径' })
      }
      return sendJson(res, 200, listVocab(pdf))
    }
    // 改释义 / 改词根（锚点、词形是标色与定位依据，不开放修改）
    if (req.method === 'PUT') {
      const { pdf = '', term = '', meaning, roots = null } = await readJson(req)
      if (!pdf || !term) return sendJson(res, 400, { error: '缺少 pdf 或 term' })
      let key
      try {
        key = pdfKey(pdf)
      } catch {
        return sendJson(res, 400, { error: '非法的 pdf 路径' })
      }
      const patch = {}
      if (typeof meaning === 'string') patch.meaning = meaning
      if (Array.isArray(roots)) patch.roots = roots.map((s) => String(s))
      if (!('meaning' in patch) && !('roots' in patch)) return sendJson(res, 400, { error: '没有可更新的字段' })
      let rec
      try {
        rec = updateVocab(key, String(term), patch)
      } catch (e) {
        return sendJson(res, 500, { error: `笔记更新失败：${e.message}` })
      }
      if (!rec) return sendJson(res, 404, { error: '该生词卡不存在' })
      return sendJson(res, 200, rec)
    }
    if (req.method === 'DELETE') {
      const raw = url.searchParams.get('pdf') || ''
      const term = url.searchParams.get('term') || ''
      if (!raw || !term) return sendJson(res, 400, { error: '缺少 pdf 或 term' })
      let key
      try {
        key = pdfKey(raw)
      } catch {
        return sendJson(res, 400, { error: '非法的 pdf 路径' })
      }
      let ok = false
      try {
        ok = deleteVocab(key, term)
      } catch (e) {
        return sendJson(res, 500, { error: `笔记删除失败：${e.message}` })
      }
      if (!ok) return sendJson(res, 404, { error: '该生词卡不存在' })
      return sendJson(res, 200, { ok: true })
    }
    return sendJson(res, 405, { error: '方法不支持' })
  }
  if (p === '/api/anno' && req.method === 'GET') {
    const raw = url.searchParams.get('pdf') || ''
    if (!toRel(raw)) return sendJson(res, 200, [])
    let pdf
    try {
      pdf = pdfKey(raw)
    } catch {
      return sendJson(res, 403, { error: '非法的 pdf 路径' })
    }
    return sendJson(res, 200, listAnnos(pdf))
  }
  if (p === '/api/anno' && req.method === 'POST') {
    const { pdf = '', page = 1, rect = null, quote = '', text = '', author = 'ADMIN' } = await readJson(req)
    const body = String(text).trim()
    if (!body) return sendJson(res, 400, { error: '批注内容为空' })
    let pdfRel
    try {
      pdfRel = pdfKey(pdf)
    } catch {
      return sendJson(res, 400, { error: '非法的 pdf 路径' })
    }
    if (!pdfRel) return sendJson(res, 400, { error: '缺少 pdf' })
    // 锚点矩形 = 选中区块末行的页面归一化 (x, y, w, h)：与缩放无关，
    // 前端按当前渲染页宽乘回去即得红线起点（句尾），无需重跑文本匹配
    const box =
      Array.isArray(rect) && rect.length >= 4 && rect.every((v) => Number.isFinite(+v))
        ? rect.slice(0, 4).map(Number)
        : [0, 0, 0, 0]
    const rec = {
      id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      pdf: pdfRel,
      page: Number(page) || 1,
      rect: box,
      quote: String(quote).replace(/\s+/g, ' ').trim().slice(0, 600),
      text: String(text),
      author: String(author || 'ADMIN'),
      createdAt: new Date().toLocaleString('sv-SE'),
    }
    try {
      insertAnno(rec)
    } catch (e) {
      return sendJson(res, 500, { error: `批注写入失败：${e.message}` })
    }
    return sendJson(res, 200, rec)
  }
  // 改批注正文（引用是选中区块原文、rect 是锚点，都不开放修改）
  if (p === '/api/anno' && req.method === 'PUT') {
    const { id = '', text } = await readJson(req)
    if (!id) return sendJson(res, 400, { error: '缺少 id' })
    if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: '批注内容为空' })
    let rec
    try {
      rec = updateAnno(String(id), { text })
    } catch (e) {
      return sendJson(res, 500, { error: `批注更新失败：${e.message}` })
    }
    if (!rec) return sendJson(res, 404, { error: '该批注不存在' })
    return sendJson(res, 200, rec)
  }
  if (p === '/api/anno' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') || ''
    if (!id) return sendJson(res, 400, { error: '缺少 id' })
    let ok = false
    try {
      ok = deleteAnno(id)
    } catch (e) {
      return sendJson(res, 500, { error: `批注删除失败：${e.message}` })
    }
    if (!ok) return sendJson(res, 404, { error: '该批注不存在' })
    return sendJson(res, 200, { ok: true })
  }
  if (p === '/api/vocab/generate' && req.method === 'POST') {
    // 耗时日志：LLM 慢/超时是这条链路的主要故障源，落一行日志便于事后直接查后端日志
    const t0 = Date.now()
    const cost = () => `${Date.now() - t0}ms`
    const { word, sentence = '', pdf = '', page = 1, point = null } = await readJson(req)
    if (!word || !pdf) return sendJson(res, 400, { error: '缺少 word 或 pdf' })
    // pdf = 相对 assests 的路径（含子目录），直接作笔记表里的键（anchor.pdf 也是它）
    let pdfPath
    try {
      pdfPath = pdfKey(pdf)
    } catch {
      return sendJson(res, 400, { error: '非法的 pdf 路径' })
    }
    const pageN = Number(page) || 1

    // 已有同词卡（term 不分大小写）→ 直接返回，不重复生成
    const dup = findVocab(pdfPath, word)
    if (dup) return sendJson(res, 200, dup)

    let cfg = {}
    try {
      cfg = JSON.parse(await readFile(join(__dirname, 'config.json'), 'utf8'))
    } catch {}
    if (!cfg.apiKey) {
      return sendJson(res, 503, { error: '未配置 apiKey：请编辑 .claude/preview/backend/config.json' })
    }

    let ai
    try {
      ai = await llmWord(cfg, word, sentence)
    } catch (e) {
      console.warn(`[vocab/generate] 失败 ${word} ${cost()} — ${e.message}`)
      return sendJson(res, 502, { error: `AI 生成失败：${e.message}` })
    }

    const lemma = String(ai.lemma || word).toLowerCase().trim()
    // AI 归出 lemma 后【重查】再查重：LLM 等待期（10-60s）内可能有并发请求已入库
    // 同词，用请求开始时的旧快照防不住；重查把查重竞态窗口从秒级缩到毫秒级
    const dupLemma = findVocab(pdfPath, lemma)
    if (dupLemma) return sendJson(res, 200, dupLemma)
    const sentBold = boldWord(String(sentence || '').replace(/\s+/g, ' ').trim(), word)
    // 点击点归一化坐标 → anchor.sel（此前恒为占位 [0,0,0,0]）：标记端按该点在页面
    // 上的精确位置锚定「生成它的那一次出现」，同词其它语境不再乱标（user 反馈）。
    // 合法范围取 (0,1) 开区间：占位 0 落不进 → 旧数据自动走原句/锚定页回退
    const pt =
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(+point[0]) && +point[0] > 0 && +point[0] < 1 &&
      Number.isFinite(+point[1]) && +point[1] > 0 && +point[1] < 1
        ? [+point[0], +point[1], 0, 0]
        : [0, 0, 0, 0]
    // 入库（(pdf, term) 主键去重）：并发同词请求由 INSERT OR IGNORE 兜住
    const rec = {
      term: lemma,
      surface: word,
      sentence: sentBold,
      hyphenated: ai.hyphenated || lemma,
      meaning: ai.meaning || '',
      roots: ai.roots || [],
      anchor: { pdf: pdfPath, page: pageN, sel: pt },
      createdAt: new Date().toLocaleString('sv-SE'), // YYYY-MM-DD HH:mm:ss 本地时间
    }
    try {
      const saved = insertVocab(rec) || rec
      console.log(`[vocab/generate] ${word} → ${saved.term} ${cost()}`)
      return sendJson(res, 200, saved)
    } catch (e) {
      console.warn(`[vocab/generate] 入库失败 ${word} ${cost()} — ${e.message}`)
      return sendJson(res, 500, { error: `笔记写入失败：${e.message}` })
    }
  }
  return serveStatic(req, res)
})

const port = Number(process.env.PORT) || 8120
openStore(join(ASSETS, 'notes.db'))
// 旧 jsonl 一次性导入（幂等：库里的 meta.imported_jsonl_at 是闸门）。
// 放在 listen 之前：先落库再收请求，避免启动瞬间的前端读到空库
let imported = null
try {
  imported = await importJsonlOnce(ASSETS, resolve(__dirname, '../../../.trash'))
} catch (e) {
  console.error(`[pj13-preview] 旧 jsonl 导入失败（不影响启动）：${e.message}`)
}
server.listen(port, '127.0.0.1', () => {
  console.log(`[pj13-preview] listening on http://127.0.0.1:${port}`)
  console.log(`[pj13-preview] dist = ${DIST}`)
  console.log(`[pj13-preview] assets root = ${ASSETS}`)
  console.log(`[pj13-preview] store = ${join(ASSETS, 'notes.db')}`)
  if (imported) {
    console.log(
      `[pj13-preview] 已导入旧 jsonl：生词 ${imported.vocab} 条 / 批注 ${imported.annos} 条；` +
        `归档 ${imported.moved.length} 个文件 → .trash` +
        (imported.kept.length ? `；保留：${imported.kept.join('、')}` : ''),
    )
  }
})
