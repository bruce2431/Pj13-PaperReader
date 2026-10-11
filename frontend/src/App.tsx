import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { AnnoNote, FsEntry, FsListing, VocabNote, VocabPatch, ScreenRect } from './types'
import { PdfViewer, type PdfViewerHandle, type PendingWord, type QuoteSnap } from './components/PdfViewer'
import { NoteDrawer } from './components/NoteDrawer'
import { AnnotationCard, type CardState } from './components/AnnotationCard'
import { AnnoComposer, type AnnoDraft } from './components/AnnoComposer'
import { TopBar } from './components/TopBar'
import { Catalog } from './components/Catalog'

/** 批注署名（单机本地使用，无账号体系；与 createdAt 一起展示） */
const ANNO_AUTHOR = 'ADMIN'

export default function App() {
  // 构建指纹写进标签页标题：远程端（iPad）看标题即知加载的 bundle 版本
  document.title = `Pj13 精读 · build ${__BUILD_TAG__}`
  // 素材库目录浏览：dir = 当前目录相对路径（'' = assests 根）；pdfPath = '' 表示目录页
  const [dir, setDir] = useState(() => localStorage.getItem('pj13.lastDir') ?? '')
  const [listing, setListing] = useState<FsListing | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [pdfPath, setPdfPath] = useState('')
  const [pdfUrl, setPdfUrl] = useState('')
  const [notes, setNotes] = useState<VocabNote[]>([])
  // 本篇批注（与 PDF 同目录同名 .anno.jsonl）：右侧悬浮卡 + 红线，见 AnnoLayer
  const [annos, setAnnos] = useState<AnnoNote[]>([])
  // 批注编辑卡状态：annoDraft 打开中（新建 or 改写），editingAnno 非空表示改写既有批注
  const [annoDraft, setAnnoDraft] = useState<AnnoDraft | null>(null)
  const [editingAnno, setEditingAnno] = useState<AnnoNote | null>(null)
  const [annoBusy, setAnnoBusy] = useState(false)
  const [annoError, setAnnoError] = useState('')
  // 批注气泡上的操作（改/删）失败时的轻提示：气泡里没有位置展示错误，4s 自动消失
  const [annoToast, setAnnoToast] = useState('')
  // 缩放持久化（pj13.scale）：初始取上次会话的缩放，越界/缺省回 1
  const [scale, setScale] = useState(() => {
    const v = parseFloat(localStorage.getItem('pj13.scale') ?? '')
    return Number.isFinite(v) ? Math.min(5, Math.max(0.4, v)) : 1
  })
  // 启动时是否有存量缩放：有 → 用户缩放偏好优先，载入适宽收缩让位
  // （否则刷新会把主动放大拽回适宽，持久化失去意义）
  const hadSavedScale = useRef(localStorage.getItem('pj13.scale') != null)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [card, setCard] = useState<CardState | null>(null)
  // 正在生成单词卡的词（多槽并行）：PDF 页面上这些词标橘（PdfViewer pendingWords）。
  // 生命周期 = 生成请求本身（开始置入 → 响应回来 finally 移除），与卡片开关无关：
  // busy 卡中途被关（X/点外/滚离）橘标仍在，生成完成入 notes 蓝标接管（user 定案）。
  // 每项自带生成语境（原句/页码/点击点），橘标只标生成它的那次出现
  const [pendingWords, setPendingWords] = useState<PendingWord[]>([])
  // 在途生成表 + 卡片归属：卡片只有一个槽位，归属 = 最后发起的生成（activeGen）；
  // 被后来者顶掉的生成响应只入 notes 不抢卡；关卡只静默 activeGen 的迟到响应
  const gensRef = useRef<Set<{ word: string; closed: boolean }>>(new Set())
  const activeGenRef = useRef<{ word: string; closed: boolean } | null>(null)

  // 卡片关闭（含 busy 生成中）——X / 点外部 / 滚动远离三路都走这里
  const closeCard = useCallback(() => {
    if (activeGenRef.current) activeGenRef.current.closed = true
    setCard(null)
  }, [])
  const viewerRef = useRef<PdfViewerHandle>(null)
  // 官方浮窗（宿主 §47 .quote-pop）的引用快照：开窗时定格，宿主回发 action 时按它执行。
  // 必须**快照**而非开窗后现取——点宿主浮窗会把 iframe 内的 DOM 选区清掉。
  const quoteRef = useRef<QuoteSnap | null>(null)

  // 预览帧内选区 → 宿主官方浮窗（§48 桥：floria-quote-open）。宿主只负责开窗与回落动作 id，
  // 业务数据（原文/页码/锚点）全部随快照留在本页——点浮窗那一下帧内选区已失效，宿主也拿不到帧内 DOM。
  // 路径基准：Pj13 的 pdfPath 相对素材库根，宿主 refPath 要的是项目根相对 ⇒ 前缀 assests/。
  const handleQuote = useCallback(
    (snap: QuoteSnap) => {
      quoteRef.current = snap
      window.parent.postMessage(
        {
          type: 'floria-quote-open',
          text: snap.text,
          rect: snap.rect,
          pdf: pdfPath ? 'assests/' + pdfPath : '',
          page: snap.page,
          pageEnd: snap.pageEnd,
        },
        '*',
      )
    },
    [pdfPath],
  )

  // 关窗：帧内 mousedown / 滚动都由 PdfViewer 转发到这里（iframe 内事件不冒泡到宿主 document，
  // 宿主自己那两条「点外部/滚动即关」对帧内失效 ⇒ 必须由本页显式回报）。无窗时静默，不发无谓消息。
  const handleQuoteClose = useCallback(() => {
    if (!quoteRef.current) return
    quoteRef.current = null
    window.parent.postMessage({ type: 'floria-quote-close' }, '*')
  }, [])

  // 目录列举：切目录即拉取（后端扫描 assests 实时返回，新放论文刷新即见）
  useEffect(() => {
    let alive = true
    setListLoading(true)
    setListError('')
    api
      .listDir(dir)
      .then((l) => {
        if (!alive) return
        setListing(l)
        setDir(l.path) // 后端归一（如尾斜杠、'..'）为准，避免路径形态漂移
        localStorage.setItem('pj13.lastDir', l.path)
      })
      .catch((e) => {
        if (!alive) return
        // 上次记住的目录已被删/改名（老 localStorage）：退回根目录自愈，别把整页卡在报错
        if (dir) {
          setDir('')
          return
        }
        setListError(String(e).replace(/^Error:\s*/, ''))
      })
      .finally(() => alive && setListLoading(false))
    return () => {
      alive = false
    }
  }, [dir])

  // 打开某篇 PDF：path 即素材库相对路径（同时是笔记键）；目录页 → 阅读器由 pdfPath 非空触发
  const openPdf = useCallback((entry: FsEntry) => {
    if (!entry.url) return
    localStorage.setItem('pj13.lastPdf', entry.path)
    setPdfUrl(entry.url)
    setPdfPath(entry.path)
  }, [])

  useEffect(() => {
    if (!pdfPath) return
    // 重新打开同一篇（返回目录后再点）也重放下面这段：把阅读状态复位
    api.getVocabNotes(pdfPath).then(setNotes).catch(() => setNotes([]))
    api.getAnnos(pdfPath).then(setAnnos).catch(() => setAnnos([]))
    setCard(null)
    handleQuoteClose()
    setAnnoDraft(null)
    setEditingAnno(null)
    setAnnoError('')
    // 换 PDF：旧文档的在途生成全部作废（迟到响应连同 notes 一并跳过），橘标清空
    for (const g of gensRef.current) g.closed = true
    gensRef.current.clear()
    activeGenRef.current = null
    setPendingWords([])
  }, [pdfPath])

  const backToCatalog = useCallback(() => {
    setPdfPath('')
    setPdfUrl('')
    setCard(null)
    handleQuoteClose()
    setAnnos([])
    setAnnoDraft(null)
    setEditingAnno(null)
    setAnnoError('')
    setDrawerOpen(false) // 笔记抽屉属阅读器：回目录页一并收起（目录页无笔记按钮可关）
    for (const g of gensRef.current) g.closed = true
    gensRef.current.clear()
    activeGenRef.current = null
    setPendingWords([])
  }, [handleQuoteClose])

  // 目录跳转（面包屑各段 / 目录页文件夹行共用一套逻辑）：落到目标目录并退出阅读器
  // （阅读态由 pdfPath 非空决定，只改 dir 会留在阅读器里 → 必须一并 backToCatalog）
  const navigateDir = useCallback(
    (path: string) => {
      setDir(path)
      backToCatalog()
    },
    [backToCatalog],
  )

  // 缩放变化即写回（刷新/重进恢复）；按钮/滚轮/适宽/载入收缩统一经 setScale 汇入
  useEffect(() => {
    localStorage.setItem('pj13.scale', String(scale))
  }, [scale])

  // 批注操作失败的轻提示：4s 自动消失
  useEffect(() => {
    if (!annoToast) return
    const t = setTimeout(() => setAnnoToast(''), 4000)
    return () => clearTimeout(t)
  }, [annoToast])

  const openCardFromMark = useCallback((note: VocabNote, rect: ScreenRect) => {
    setCard({ note, word: note.surface, rect })
  }, [])

  // 浮窗动作①「生成单词卡」：已有笔记 → 直接开卡；否则调 AI 生成（追加笔记 jsonl）→ 开卡 + 入列表。
  // 与原先右键菜单同一套逻辑，只是入参从 MenuState 换成开窗时定格的 QuoteSnap（业务数据不能现取）。
  const runGenerateFromQuote = useCallback(
    async (snap: QuoteSnap) => {
      const word = snap.word || snap.text
      if (!word) return
      const w = word.toLowerCase()
      const rect: ScreenRect = snap.wordRect ?? snap.rect
      const hit = notes.find((n) => n.surface.toLowerCase() === w || n.term.toLowerCase() === w)
      if (hit) {
        setCard({ note: hit, word: hit.surface, rect })
        return
      }
      // await 期间 pdfPath 可能已变（换 PDF）：失败回查要用「发起时」的键
      const pdfAtStart = pdfPath
      const gen = { word, closed: false }
      gensRef.current.add(gen)
      activeGenRef.current = gen // 卡片槽位归最新发起的生成
      setPendingWords((ws) =>
        ws.some((p) => p.word === word)
          ? ws
          : [...ws, { word, sentence: snap.sentence, page: snap.page, sel: snap.point ?? null }],
      )
      setCard({ note: null, word, rect, busy: true })
      try {
        const note = await api.generateCard({
          word,
          sentence: snap.sentence,
          pdf: pdfPath,
          page: snap.page,
          point: snap.point,
        })
        if (!gensRef.current.has(gen)) return // 换 PDF 清场后的迟到响应：笔记已在服务端落盘，UI 全跳过
        // 生成已在服务端完成（jsonl 已追加）：取消只吸收 UI 响应，笔记照常入库
        setNotes((ns) => (ns.some((n) => n.term === note.term) ? ns : [...ns, note]))
        if (gen.closed || activeGenRef.current !== gen) return // 被顶掉/已关卡：不抢卡片
        setCard({ note, word: note.surface, rect })
      } catch (e) {
        const msg = String(e).replace(/^Error:\s*/, '')
        if (!gensRef.current.has(gen)) return // 换 PDF 清场后的迟到响应
        // 「失败」未必真失败：网关对上游 180s 无数据即掐断连接，此时服务端可能已落库
        //（2026-09-21 ConvS2S）。回查一次服务端为准——命中就当成功开卡，别出现
        //「卡片说生成失败、词却被标记」的自相矛盾
        let list: VocabNote[] | null = null
        try {
          list = await api.getVocabNotes(pdfAtStart)
        } catch {
          /* 回查也失败：按原样报错 */
        }
        if (!gensRef.current.has(gen)) return // 回查期间又换了 PDF
        if (list) {
          setNotes(list) // 服务端是真源，顺带治愈此前被掐断的「假失败」条目
          const hit2 = list.find((n) => n.surface.toLowerCase() === w || n.term.toLowerCase() === w)
          if (hit2) {
            if (gen.closed || activeGenRef.current !== gen) return
            setCard({ note: hit2, word: hit2.surface, rect })
            return
          }
        }
        if (gen.closed || activeGenRef.current !== gen) return
        setCard({ note: null, word, rect, error: msg })
      } finally {
        gensRef.current.delete(gen)
        if (activeGenRef.current === gen) activeGenRef.current = null
        // 同词可能有第二个在途生成：都结束才撤橘标
        setPendingWords((ws) =>
          [...gensRef.current].some((g) => g.word === word) ? ws : ws.filter((p) => p.word !== word),
        )
      }
    },
    [notes, pdfPath],
  )

  // 浮窗动作②「创建批注」：把选区锚点交给编辑卡（正文由用户手写）
  const runAnnoFromQuote = useCallback((snap: QuoteSnap) => {
    const a = snap.anno
    if (!a) return
    setAnnoError('')
    setEditingAnno(null)
    setAnnoDraft({ page: a.page, rect: a.rect, quote: a.quote, x: a.screen.x, y: a.screen.y })
  }, [])

  // 宿主点申报动作行 → 回发 id（宿主不代执行）。执行逻辑留本页：要调 Pj13 的 API 与阅读器状态。
  // 快照只认一次：取走即清，防连点重复执行。
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d || typeof d !== 'object' || d.type !== 'floria-quote-action') return
      const snap = quoteRef.current
      if (!snap) return
      quoteRef.current = null
      if (d.id === 'vocab') void runGenerateFromQuote(snap)
      else if (d.id === 'anno') runAnnoFromQuote(snap)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [runGenerateFromQuote, runAnnoFromQuote])

  const closeAnnoComposer = useCallback(() => {
    setAnnoDraft(null)
    setEditingAnno(null)
    setAnnoError('')
  }, [])

  // 批注气泡「编辑」：复用同一个编辑卡（位置贴气泡，正文预填）
  const handleAnnoEdit = (anno: AnnoNote, at: { x: number; y: number }) => {
    setAnnoError('')
    setEditingAnno(anno)
    setAnnoDraft({ page: anno.page, rect: anno.rect, quote: anno.quote, x: at.x, y: at.y })
  }

  const handleAnnoDelete = async (anno: AnnoNote) => {
    try {
      await api.deleteAnno(anno.id)
      setAnnos((as) => as.filter((a) => a.id !== anno.id))
      if (editingAnno?.id === anno.id) closeAnnoComposer()
    } catch (e) {
      setAnnoToast(String(e).replace(/^Error:\s*/, ''))
    }
  }

  // 保存：editingAnno 非空改正文，否则新建
  const saveAnno = async (text: string) => {
    const draft = annoDraft
    if (!draft || !pdfPath) return
    setAnnoBusy(true)
    setAnnoError('')
    try {
      if (editingAnno) {
        const rec = await api.updateAnno(editingAnno.id, text)
        setAnnos((as) => as.map((a) => (a.id === rec.id ? rec : a)))
      } else {
        const rec = await api.createAnno({
          pdf: pdfPath,
          page: draft.page,
          rect: draft.rect,
          quote: draft.quote,
          text,
          author: ANNO_AUTHOR,
        })
        setAnnos((as) => [...as, rec])
      }
      closeAnnoComposer()
    } catch (e) {
      setAnnoError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setAnnoBusy(false)
    }
  }

  // 生词卡改释义/词根（锚点与词形不动）；失败向上抛，由卡片就地显示
  const saveVocabPatch = async (patch: VocabPatch) => {
    const note = card?.note
    if (!pdfPath || !note?.anchor) throw new Error('这张卡没有可保存的锚点')
    const rec = await api.updateVocab(pdfPath, note.term, patch)
    setNotes((ns) => ns.map((n) => (n.term === rec.term ? rec : n)))
    setCard((c) => (c?.note?.term === rec.term ? { ...c, note: rec } : c))
  }

  const deleteVocabNote = async () => {
    const note = card?.note
    if (!pdfPath || !note?.anchor) throw new Error('这张卡没有可删除的锚点')
    await api.deleteVocab(pdfPath, note.term)
    setNotes((ns) => ns.filter((n) => n.term !== note.term))
    closeCard()
  }

  const handlePick = (note: VocabNote) => {
    viewerRef.current?.scrollToPage(note.anchor?.page || 1)
    setCard({ note, word: note.surface })
  }

  const reading = !!pdfPath

  return (
    <div className="pv-app">
      <TopBar
        dir={dir}
        listing={listing}
        pdfPath={pdfPath}
        onNavigateDir={navigateDir}
        page={page}
        pageCount={pageCount}
        scale={scale}
        onScaleChange={setScale}
        onFitWidth={() => viewerRef.current?.fitWidth()}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        loadState={loadState}
      />
      <div className="pv-body">
        <main className="pv-main">
          {/* 目录页与阅读器互斥渲染：目录页时不挂载 PdfViewer，空 src 不会把 loadState 打成 error */}
          {reading ? (
            <PdfViewer
              ref={viewerRef}
              src={pdfUrl}
              notes={notes}
              annos={annos}
              pendingWords={pendingWords}
              scale={scale}
              shrinkToFitOnLoad={!hadSavedScale.current}
              onScaleChange={setScale}
              onWordOpen={openCardFromMark}
              onQuote={handleQuote}
              onQuoteClose={handleQuoteClose}
              onPageChange={setPage}
              onPageCount={setPageCount}
              onLoadState={setLoadState}
              onAnnoEdit={handleAnnoEdit}
              onAnnoDelete={handleAnnoDelete}
            />
          ) : (
            <Catalog
              listing={listing}
              loading={listLoading}
              error={listError}
              lastPdf={localStorage.getItem('pj13.lastPdf') ?? ''}
              onOpenDir={navigateDir}
              onOpenPdf={openPdf}
            />
          )}
        </main>

        {reading && drawerOpen && (
          <NoteDrawer notes={notes} onPick={handlePick} onClose={() => setDrawerOpen(false)} />
        )}
      </div>

      {card && (
        <AnnotationCard card={card} onClose={closeCard} onSaveNote={saveVocabPatch} onDeleteNote={deleteVocabNote} />
      )}

      {annoDraft && (
        <AnnoComposer
          draft={annoDraft}
          author={ANNO_AUTHOR}
          busy={annoBusy}
          error={annoError}
          initialText={editingAnno?.text ?? ''}
          title={editingAnno ? '编辑批注' : '新建批注'}
          onSave={saveAnno}
          onCancel={closeAnnoComposer}
        />
      )}

      {annoToast && <div className="pv-toast">{annoToast}</div>}
    </div>
  )
}
