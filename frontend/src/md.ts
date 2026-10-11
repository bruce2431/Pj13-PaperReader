// 批注正文的极简 markdown → HTML 渲染器（卡片内展示，无第三方依赖）
//
// 只覆盖批注会用的子集：标题 / 粗体 / 斜体 / 行内代码 / 代码块 / 有序无序列表 /
// 引用 / 分隔线 / 链接 / 段落内换行。其它语法原样显示。
// 安全：先整体转义 HTML 再套标记（用户手写正文不当作 HTML 执行），链接只放行
// http(s)/mailto/# —— 批注文件躺在素材库 PDF 旁边，来源不可信时不能成为注入点。

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 行内标记（输入已转义） */
function inline(s: string): string {
  let out = s
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  // 下划线斜体要求两侧是空白/标点，避免把 snake_case 标识符（effective_nuclear_charge）
  // 误拆成斜体
  out = out.replace(/(^|[\s(（])_([^_\s][^_\n]*?)_(?=[\s).,;:!?，。、)]|$)/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt: string, href: string) =>
    /^(https?:|mailto:|#)/i.test(href)
      ? `<a href="${href}" target="_blank" rel="noreferrer">${txt}</a>`
      : txt,
  )
  return out
}

const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\s*```|(-{3,}|\*{3,})\s*$)/

export function renderMarkdown(src: string): string {
  const lines = String(src || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const t = raw.trim()
    if (t.startsWith('```')) {
      closeList()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过收尾围栏（可能不存在 → 吃掉末尾也无妨）
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }
    if (!t) {
      closeList()
      i++
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) {
      closeList()
      const n = h[1].length
      out.push(`<h${n}>${inline(esc(h[2]))}</h${n}>`)
      i++
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      closeList()
      out.push('<hr />')
      i++
      continue
    }
    const ul = /^[-*+]\s+(.*)$/.exec(t)
    const ol = /^\d+[.)]\s+(.*)$/.exec(t)
    if (ul || ol) {
      const kind: 'ul' | 'ol' = ul ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline(esc((ul || ol)![1]))}</li>`)
      i++
      continue
    }
    if (t.startsWith('>')) {
      closeList()
      const buf: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${buf.map((b) => inline(esc(b))).join('<br />')}</blockquote>`)
      continue
    }
    // 段落：连续普通行合并，段内换行保留（<br />）
    closeList()
    const buf: string[] = [t]
    i++
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i].trim())) {
      buf.push(lines[i].trim())
      i++
    }
    out.push(`<p>${buf.map((b) => inline(esc(b))).join('<br />')}</p>`)
  }
  closeList()
  return out.join('')
}
