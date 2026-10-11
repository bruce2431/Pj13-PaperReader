// Catalog —— 素材库目录页（assests/ 的文件浏览列表，Cloudreve 式）
// 只列【子目录】与【PDF】：文件夹一行加粗、右侧显示递归 PDF 数并带进入箭头，PDF 行显示大小与修改时间。
// 单击即进入目录 / 打开 PDF（不做选中态：浏览素材时少一步确认更顺手）。
import type { FsEntry, FsListing } from '../types'

interface CatalogProps {
  listing: FsListing | null
  loading: boolean
  error: string
  /** 上次打开的 PDF 相对路径：命中行加淡色标记，便于回到上次读的那篇 */
  lastPdf: string
  onOpenDir: (path: string) => void
  onOpenPdf: (entry: FsEntry) => void
}

function fmtSize(n?: number): string {
  if (!n || n < 0) return '—'
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2c.5 0 .97.24 1.25.65l.9 1.3h8.65A1.5 1.5 0 0 1 21 8.45v8.05A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5z"
        fill="currentColor"
      />
    </svg>
  )
}

function PdfIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M6 2.75A1.75 1.75 0 0 1 7.75 1h6.5L20 6.75v14.5A1.75 1.75 0 0 1 18.25 23H7.75A1.75 1.75 0 0 1 6 21.25z"
        fill="currentColor"
      />
      <path d="M14.25 1.5 20 7.25h-5.75z" fill="#fff" opacity=".55" />
      <text x="12" y="18.6" textAnchor="middle" fontSize="6.4" fill="#fff" fontWeight="700">
        PDF
      </text>
    </svg>
  )
}

export function Catalog({ listing, loading, error, lastPdf, onOpenDir, onOpenPdf }: CatalogProps) {
  const entries = listing?.entries ?? []
  const dirs = entries.filter((e) => e.type === 'dir').length
  const pdfs = entries.length - dirs

  return (
    <div className="pv-cat">
      <div className="pv-cat-head">
        <span className="pv-cat-title">
          {listing?.path ? listing.path.split('/').pop() : '素材库'}
        </span>
        <span className="pv-cat-count">
          {loading ? '读取中…' : `${dirs} 个目录 · ${pdfs} 篇 PDF`}
        </span>
      </div>

      {error && <div className="pv-cat-empty pv-cat-err">目录读取失败：{error}</div>}
      {!error && !loading && entries.length === 0 && (
        <div className="pv-cat-empty">此目录没有子目录或 PDF</div>
      )}

      <div className="pv-cat-list">
        {entries.map((e) => (
          <button
            key={e.path}
            className={`pv-cat-row ${e.type} ${lastPdf === e.path ? 'last' : ''}`}
            onClick={() => (e.type === 'dir' ? onOpenDir(e.path) : onOpenPdf(e))}
            title={e.type === 'dir' ? `进入 ${e.name}` : `打开 ${e.name}`}
          >
            <span className={`pv-cat-icon ${e.type}`}>
              {e.type === 'dir' ? <FolderIcon /> : <PdfIcon />}
            </span>
            <span className="pv-cat-name">{e.name}</span>
            <span className="pv-cat-meta">
              {e.type === 'dir'
                ? `${e.pdfCount ?? 0} 篇 PDF`
                : `${fmtSize(e.size)}${e.mtime ? ` · ${fmtTime(e.mtime)}` : ''}`}
            </span>
            {e.type === 'dir' && <span className="pv-cat-arrow">›</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
