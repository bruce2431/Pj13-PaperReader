/** 触屏（手指为主）判定 —— 全项目唯一入口，CSS 类与 JS 手势共用同一判据。
 *
 *  **不能用 `(pointer: coarse)` 单独判**：iPadOS Safari（桌面模式）把 iPad 谎报成 Mac，
 *  `pointer: fine` / `hover: hover` 都判真 ⇒ `pointer: coarse` 判假。后果是触屏接管整体不生效：
 *  长按取词监听不挂、`user-select:none` 也不生效，用户只剩被系统 callout 劫持的原生选择
 *  （user 反馈「手指选中后无事发生」）。
 *  判据抄本项目宿主侧 `web-src/sidebar/recent.js` 的实测结论（那边踩过同一个坑）：
 *  `hover: none`（手机）或 `MacIntel` + 多点触控（iPadOS 伪装成 Mac 的唯一破绽）即触屏。
 */
export function isTouchUI(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return true
    if (window.matchMedia('(hover: none)').matches) return true
  } catch {
    /* 老引擎不支持 matchMedia：落到 platform 判定 */
  }
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** 把判据落到根元素类 `.pv-touch` 上供 CSS 使用（媒体查询在 iPad 上不可靠）。
 *  必须在首次渲染前调用：PdfViewer 挂载时就按手势判据决定要不要挂触屏监听。 */
export function applyTouchClass(): void {
  if (isTouchUI()) document.documentElement.classList.add('pv-touch')
}
