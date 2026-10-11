// Pj13 精读预览 · 笔记存储层（SQLite，node:sqlite 内置，零依赖）
//
// 取代旧的一文件一篇 PDF 的 jsonl 追加存储：<pdf名>.jsonl（生词）/ <pdf名>.anno.jsonl（批注）
// 两张表放在同一个库（assests/notes.db）。旧 jsonl 只读一次：首次启动导入本库，
// 随后移入项目 .trash/（见 importJsonlOnce），此后 DB 是唯一真源。
//
// 对外形状与旧 jsonl 一行一条的 JSON 完全一致（VocabNote / AnnoNote），
// 只有 rect / sel / roots 三个数组列在库里存 JSON 文本。

import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

let db = null
const stmts = new Map()

/** 打开（或复用）库并建表：调用方给绝对路径，通常 = <素材库根>/notes.db */
export function openStore(dbPath) {
  if (db) return db
  db = new DatabaseSync(dbPath)
  // WAL：读写不互堵；busy_timeout 兜住偶发并发（本服务单进程，仅为稳健）
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 3000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS vocab_notes (
      pdf        TEXT NOT NULL,
      term       TEXT NOT NULL,
      surface    TEXT NOT NULL DEFAULT '',
      sentence   TEXT NOT NULL DEFAULT '',
      hyphenated TEXT NOT NULL DEFAULT '',
      meaning    TEXT NOT NULL DEFAULT '',
      roots      TEXT NOT NULL DEFAULT '[]',
      page       INTEGER NOT NULL DEFAULT 1,
      sel        TEXT NOT NULL DEFAULT '[0,0,0,0]',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (pdf, term)
    );
    CREATE TABLE IF NOT EXISTS annos (
      id         TEXT PRIMARY KEY,
      pdf        TEXT NOT NULL,
      page       INTEGER NOT NULL DEFAULT 1,
      rect       TEXT NOT NULL DEFAULT '[0,0,0,0]',
      quote      TEXT NOT NULL DEFAULT '',
      text       TEXT NOT NULL DEFAULT '',
      author     TEXT NOT NULL DEFAULT 'ADMIN',
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_annos_pdf ON annos(pdf, page);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `)
  return db
}

export function closeStore() {
  if (db) db.close()
  db = null
  stmts.clear()
}

function q(sql) {
  let s = stmts.get(sql)
  if (!s) {
    s = db.prepare(sql)
    stmts.set(sql, s)
  }
  return s
}

function getMeta(k) {
  const row = q('SELECT v FROM meta WHERE k = ?').get(k)
  return row ? row.v : null
}

function setMeta(k, v) {
  q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v))
}

const now = () => new Date().toLocaleString('sv-SE') // YYYY-MM-DD HH:mm:ss 本地时间

// 数组列（roots/sel/rect）在库里是 JSON 文本；坏值一律回退，别让一行脏数据炸掉整次列举
function parseArr(s, len) {
  try {
    const v = JSON.parse(s)
    if (!Array.isArray(v)) return null
    if (len && v.length < len) return null
    return len ? v.slice(0, len).map(Number) : v
  } catch {
    return null
  }
}

function vocabRowToNote(r) {
  return {
    term: r.term,
    surface: r.surface,
    sentence: r.sentence,
    hyphenated: r.hyphenated,
    meaning: r.meaning,
    roots: parseArr(r.roots) || [],
    anchor: { pdf: r.pdf, page: r.page, sel: parseArr(r.sel, 4) || [0, 0, 0, 0] },
    createdAt: r.created_at,
    ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
  }
}

function annoRowToNote(r) {
  return {
    id: r.id,
    pdf: r.pdf,
    page: r.page,
    rect: parseArr(r.rect, 4) || [0, 0, 0, 0],
    quote: r.quote,
    text: r.text,
    author: r.author,
    createdAt: r.created_at,
    ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
  }
}

// ---------------- 生词卡 ----------------

/** 某篇 PDF 的全部生词卡（按落库先后 = 旧的 jsonl 行序） */
export function listVocab(pdf) {
  return q('SELECT * FROM vocab_notes WHERE pdf = ? ORDER BY created_at, rowid').all(pdf).map(vocabRowToNote)
}

/** 同词查重（term 不分大小写），供「已有卡直接返回」用 */
export function findVocab(pdf, term) {
  const row = q('SELECT * FROM vocab_notes WHERE pdf = ? AND lower(term) = lower(?)').get(pdf, String(term))
  return row ? vocabRowToNote(row) : null
}

/** 新卡入库；同 (pdf, term) 已存在则原样返回旧卡（PK 去重，等价旧的 appendFile 前查重） */
export function insertVocab(rec) {
  q(`INSERT OR IGNORE INTO vocab_notes
     (pdf, term, surface, sentence, hyphenated, meaning, roots, page, sel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    rec.anchor.pdf,
    rec.term,
    rec.surface || '',
    rec.sentence || '',
    rec.hyphenated || '',
    rec.meaning || '',
    JSON.stringify(rec.roots || []),
    Number(rec.anchor.page) || 1,
    JSON.stringify(rec.anchor.sel || [0, 0, 0, 0]),
    rec.createdAt || now(),
  )
  return findVocab(rec.anchor.pdf, rec.term)
}

/** 改释义 / 改词根（锚点与词形不可改：它们是标色与定位的依据）；返回更新后的卡或 null */
export function updateVocab(pdf, term, patch) {
  const cur = findVocab(pdf, term)
  if (!cur) return null
  const meaning = typeof patch.meaning === 'string' ? patch.meaning : cur.meaning
  const roots = Array.isArray(patch.roots) ? patch.roots.map((s) => String(s)) : cur.roots
  q('UPDATE vocab_notes SET meaning = ?, roots = ?, updated_at = ? WHERE pdf = ? AND term = ?').run(
    meaning,
    JSON.stringify(roots),
    now(),
    cur.anchor.pdf,
    cur.term,
  )
  return findVocab(cur.anchor.pdf, cur.term)
}

export function deleteVocab(pdf, term) {
  const cur = findVocab(pdf, term)
  if (!cur) return false
  q('DELETE FROM vocab_notes WHERE pdf = ? AND term = ?').run(cur.anchor.pdf, cur.term)
  return true
}

// ---------------- 批注 ----------------

export function listAnnos(pdf) {
  return q('SELECT * FROM annos WHERE pdf = ? ORDER BY created_at, rowid').all(pdf).map(annoRowToNote)
}

export function findAnno(id) {
  const row = q('SELECT * FROM annos WHERE id = ?').get(String(id))
  return row ? annoRowToNote(row) : null
}

export function insertAnno(rec) {
  q(`INSERT INTO annos (id, pdf, page, rect, quote, text, author, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    rec.id,
    rec.pdf,
    Number(rec.page) || 1,
    JSON.stringify(rec.rect || [0, 0, 0, 0]),
    rec.quote || '',
    rec.text || '',
    rec.author || 'ADMIN',
    rec.createdAt || now(),
  )
  return findAnno(rec.id)
}

/** 改正文（引用与锚点不可改：引用是选中区块原文，改了与页面就对不上） */
export function updateAnno(id, patch) {
  const cur = findAnno(id)
  if (!cur) return null
  const text = typeof patch.text === 'string' ? patch.text : cur.text
  q('UPDATE annos SET text = ?, updated_at = ? WHERE id = ?').run(text, now(), cur.id)
  return findAnno(cur.id)
}

export function deleteAnno(id) {
  const cur = findAnno(id)
  if (!cur) return false
  q('DELETE FROM annos WHERE id = ?').run(cur.id)
  return true
}

// ---------------- 旧 jsonl 一次性导入 ----------------

/** 递归列出 assets 下所有 *.jsonl（含子目录；已归档的 *.jsonl.imported 不匹配） */
async function walkJsonl(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '.trash' || e.name.startsWith('.')) continue
      out.push(...(await walkJsonl(p)))
    } else if (e.isFile() && /\.jsonl$/i.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 移动失败（跨盘 EXDEV 等）回退「复制 + 删除」，两边都失败才抛 */
async function moveFile(from, to) {
  try {
    await rename(from, to)
  } catch {
    await copyFile(from, to)
    await unlink(from)
  }
}

/**
 * 把旧 jsonl 导入本库，并把原文件移入 trashDir（用户定案：导入后不留原件）。
 * 只在首次跑（meta.imported_jsonl_at 为空），此后幂等直接返回。
 * 文件里只要有一行坏行就【不搬】该文件，宁可留着让人检查。
 */
export async function importJsonlOnce(assetsRoot, trashDir) {
  if (db === null) throw new Error('store 未打开')
  if (getMeta('imported_jsonl_at')) return null

  const files = await walkJsonl(assetsRoot)
  const res = { vocab: 0, annos: 0, moved: [], kept: [] }
  for (const file of files) {
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch {
      res.kept.push(basename(file))
      continue
    }
    const isAnno = /\.anno\.jsonl$/i.test(file)
    const stem = basename(file).replace(/\.jsonl$/i, '')
    let recs = []
    let bad = 0
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        recs.push(JSON.parse(s))
      } catch {
        bad++
      }
    }
    if (bad > 0) {
      res.kept.push(`${basename(file)}（${bad} 行无法解析，保留原文件）`)
      continue
    }
    db.exec('BEGIN')
    try {
      for (const r of recs) {
        if (!r || typeof r !== 'object') continue
        if (isAnno) {
          const pdf = String(r.pdf || '').trim()
          if (!pdf || typeof r.text !== 'string') continue
          insertAnno({
            id: String(r.id || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`),
            pdf,
            page: r.page,
            rect: Array.isArray(r.rect) && r.rect.length >= 4 ? r.rect.slice(0, 4).map(Number) : [0, 0, 0, 0],
            quote: r.quote,
            text: r.text,
            author: r.author,
            createdAt: r.createdAt,
          })
          res.annos++
        } else {
          // 生词行：pdf 以 anchor.pdf 为准（旧文件按文件名读、按 anchor.pdf 过滤，
          // 两者不一致的历史行——如换过名的 PDF——保持旧口径，不在这里顺手改归属）
          const pdf = String(r.anchor?.pdf || `${stem}.pdf`).trim()
          if (!pdf || typeof r.term !== 'string' || !r.term) continue
          insertVocab({
            term: r.term,
            surface: r.surface,
            sentence: r.sentence,
            hyphenated: r.hyphenated,
            meaning: r.meaning,
            roots: Array.isArray(r.roots) ? r.roots : [],
            anchor: {
              pdf,
              page: r.anchor?.page,
              sel:
                Array.isArray(r.anchor?.sel) && r.anchor.sel.length >= 4
                  ? r.anchor.sel.slice(0, 4).map(Number)
                  : [0, 0, 0, 0],
            },
            createdAt: r.createdAt,
          })
          res.vocab++
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      res.kept.push(`${basename(file)}（导入失败：${e.message}）`)
      continue
    }
    // 导入成功 → 原件归档到 .trash（同名加序号，不覆盖既有归档）
    try {
      await mkdir(trashDir, { recursive: true })
      let dest = join(trashDir, `${stamp()}-${basename(file)}`)
      for (let i = 2; i < 100; i++) {
        try {
          await readFile(dest)
          dest = join(trashDir, `${stamp()}-${i}-${basename(file)}`)
        } catch {
          break
        }
      }
      await moveFile(file, dest)
      res.moved.push(basename(file))
    } catch (e) {
      res.kept.push(`${basename(file)}（已入库，但归档失败：${e.message}）`)
    }
  }
  setMeta('imported_jsonl_at', now())
  return res
}
