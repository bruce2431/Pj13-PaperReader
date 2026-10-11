// TopBar —— Prism 风格极简顶栏：抽屉开关 / 面包屑 / 页码 / 缩放
// 面包屑首段固定「素材库」（= 项目根 assests/），其后是当前目录各层；读 PDF 时末段是文件名。
// 返回目录走面包屑各段（含首段「素材库」回库根），不再单设「← 目录」按钮。
import type { FsListing } from '../types'

interface TopBarProps {
  /** 当前素材库目录相对路径（'' = 根） */
  dir: string
  /** 目录列举结果（用于校验 / 面包屑回退层级；读取中可为 null） */
  listing: FsListing | null
  /** 正在阅读的 PDF 相对路径（'' = 目录页） */
  pdfPath: string
  onNavigateDir: (path: string) => void
  page: number
  pageCount: number
  scale: number
  onScaleChange: (s: number) => void
  onFitWidth: () => void
  drawerOpen: boolean
  onToggleDrawer: () => void
  loadState: 'loading' | 'ready' | 'error'
}

export function TopBar({
  dir,
  listing,
  pdfPath,
  onNavigateDir,
  page,
  pageCount,
  scale,
  onScaleChange,
  onFitWidth,
  drawerOpen,
  onToggleDrawer,
  loadState,
}: TopBarProps) {
  // 面包屑 = 素材库 / 逐层目录（读 PDF 时把文件名接在末尾）
  const segs = dir ? listing?.path?.split('/') ?? dir.split('/') : []
  const crumbs: { label: string; path: string | null }[] = [
    { label: '素材库', path: '' },
    ...segs.map((name, i) => ({ label: name, path: segs.slice(0, i + 1).join('/') })),
  ]
  if (pdfPath) crumbs.push({ label: pdfPath.split('/').pop() || pdfPath, path: null })
  const reading = !!pdfPath

  return (
    <header className="pv-topbar">
      <div className="pv-topbar-left">
        {/* 笔记抽屉属于阅读器：目录页不渲染（目录页也没有笔记可看） */}
        {reading && (
          <button className="pv-icon-btn" onClick={onToggleDrawer} title="切换生词笔记抽屉">
            <span className={`pv-drawer-tick ${drawerOpen ? 'on' : ''}`} />
            笔记
          </button>
        )}
        <span className="pv-topbar-title">Pj13 · 论文精读</span>
      </div>

      <div className="pv-topbar-mid">
        <nav className="pv-crumb">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={`${c.label}-${i}`} className="pv-crumb-item">
                {i > 0 && <span className="pv-crumb-sep">/</span>}
                <button
                  className={`pv-crumb-seg ${last ? 'cur' : 'link'}`}
                  disabled={last}
                  onClick={() => c.path !== null && onNavigateDir(c.path)}
                  title={c.label}
                >
                  {c.label}
                </button>
              </span>
            )
          })}
        </nav>
        {loadState === 'error' && <span className="pv-state pv-state-err">加载失败</span>}
      </div>

      <div className="pv-topbar-right">
        {reading && (
          <>
            <span className="pv-page-info">{pageCount ? `${page} / ${pageCount}` : '—'}</span>
            <span className="pv-topbar-sep" />
            <button className="pv-icon-btn" onClick={onFitWidth} title="适合宽度">
              适宽
            </button>
            <button
              className="pv-icon-btn"
              onClick={() => onScaleChange(Math.max(0.4, scale - 0.15))}
              title="缩小"
            >
              −
            </button>
            <span className="pv-zoom">{Math.round(scale * 100)}%</span>
            <button
              className="pv-icon-btn"
              onClick={() => onScaleChange(Math.min(5, scale + 0.15))}
              title="放大"
            >
              +
            </button>
          </>
        )}
      </div>
    </header>
  )
}
