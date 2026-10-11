# pj13-pdf-reader

论文精读阅读器 —— 给一个本地 PDF 素材库套上「目录页 + 阅读器 + 生词卡 + 批注卡」的 Web 应用。

零依赖 Node 后端（`node:http` + 内置 `node:sqlite`，无 npm 依赖），前端 Vite + React 18 + pdf.js。
为**扫描版 PDF**（整页位图 + OCR 文本层）做了专门的字形对齐处理，划词、标色、选区框都能贴住字形。

## 功能

- **目录页**：镜像素材库的真实目录层级（子目录可进、面包屑回退、目录显示「N 篇 PDF」），只列目录与 `.pdf`。
- **阅读器**：pdf.js canvas 渲染，分页与缩放，记忆上次打开的文件与缩放比例。
- **生词卡**：划词或触屏长按取词 → 调 LLM 拆词根词缀 + 给中文释义 → 入库；页面上用蓝色框标出该词，点框开卡。
- **批注卡**：选中原文 → 写批注 → 以气泡锚定在原文位置。
- **笔记抽屉**：一页汇总当前 PDF 的全部卡片，可改释义/词根、可删卡（锚点与词形不可改）。
- **扫描件适配**：无字形采样时按字符宽度比例铺宽 + 墨迹吸附；多行选区逐行吸附。
- **触屏**：`pointer:coarse` 环境下接管原生选择（长按取词，菜单延后到抬手弹出）。
- **可选的宿主集成**：选区通过 `postMessage` 上报给外层页面，由宿主浮窗承载「生成单词卡 / 创建批注」等动作；不接宿主也能单独跑。

## 目录结构

```
preview.json            预览容器/宿主的启动描述（cmd/cwd/port/idleMinutes/quoteActions）
backend/
  server.mjs            静态托管 ../frontend/dist + /api/* 接口
  store.mjs             SQLite 存储层（vocab_notes / annos 两张表）
  config.example.json   AI 配置模板（复制成 config.json 填 key）
frontend/
  src/                  React 源码（components/ 下为 PdfViewer、Catalog、卡片与抽屉等）
  index.html  vite.config.ts  tsconfig.json  package.json
```

## 运行

**前置**：Node ≥ 22.5（`node:sqlite` 内置；实测 v24 无需 flag）。
素材库根固定为 `<项目根>/assests/`，后端按 `backend/ → preview/ → .claude/ → 项目根` 的层级去取，
因此本仓库需要放在 **`<项目根>/.claude/preview/`** 这一层。

```bash
# 1) 放到约定位置
git clone <repo> <项目根>/.claude/preview

# 2) 把 PDF 放进素材库（可带子目录）
mkdir -p <项目根>/assests && cp your-papers/*.pdf <项目根>/assests/

# 3) 构建前端
cd <项目根>/.claude/preview/frontend
npm install
npm run build

# 4) 起后端（托管 dist + API）
cd ../backend
PORT=8130 node server.mjs
# 打开 http://127.0.0.1:8130/index.html
```

只调前端时用 dev 模式即可：`cd frontend && npm run dev`（后端连不上时自动落到 `src/api/mock.ts` 的假数据）。

## 配置 AI（生词卡需要）

```bash
cp backend/config.example.json backend/config.json   # 填 baseUrl / apiKey / model
```

任何 OpenAI 兼容端点都可以（智谱 / OpenAI / DeepSeek / 本地 Ollama…）。**缺 config.json 时不会崩**：
只有 `POST /api/vocab/generate` 返回 503，目录、阅读、批注、已有卡片全部照常。

## 数据

卡片全部存在 `<项目根>/assests/notes.db`（SQLite + WAL，首次启动自动建表）：

| 表 | 内容 |
| --- | --- |
| `vocab_notes` | 生词卡，主键 `(pdf, term)`；`roots/sel` 为 JSON 文本 |
| `annos` | 批注卡，引用原文 + 批注正文 |

无账号体系，纯本地单机。删掉 `notes.db` 即清空全部卡片。

## API

```
GET    /api/fs/list?path=<相对路径>   素材库目录树（只出目录与 PDF）
GET    /pdfs/<相对路径>               PDF 文件本体
GET    /api/vocab?pdf=<相对路径>      生词卡列表
POST   /api/vocab/generate            取词 → LLM 拆词根 + 释义 → 入库（需 config.json）
PUT    /api/vocab                     改释义/词根 {pdf, term, meaning?, roots?}
DELETE /api/vocab?pdf=&term=          删卡
GET    /api/anno?pdf=<相对路径>       批注列表
POST   /api/anno                      新建批注
PUT    /api/anno                      改批注正文 {id, text}
DELETE /api/anno?id=                  删批注
```

## 实现要点（扫描版 PDF 对齐）

扫描件整页是一张位图，页面里没有可采样的 `fillText`，字形几何只能靠 OCR 文本层推算，容易整体偏移。处理方式：

1. **宽采样**：正常 PDF 直接拦截 `ctx.fillText` 记下每个字形的设备像素位置；采样不到时，退回「按字符宽度比例把 item 全宽铺给每个字符」（空格也占宽）——曾按非空格字符均分，导致行内越靠后的词起点越右偏、词尾溢出到下一个词。
2. **墨迹吸附**：按 canvas 像素找墨迹列，把框贴到真实字形上；**限 ±0.3em 微调窗口**——扫描件背景有噪点，相邻词的墨迹会连成一片，无约束地吸附会骑到后一个词上。
3. **选区逐行吸附**：原生 `::selection` 隐藏，改由叠加层画框；多行选区的每一条 client rect 都要用 `caretRangeFromPoint` 取出**本行那一段**文本再吸附。把整段文本喂给每条矩形必然匹配失败，会回落到 DOM 文本层矩形——而 OCR 文本层的字形与 canvas 墨迹有 2~6px 固有偏差，看着就是「选框整体偏了」。

## 已知限制

- 扫描件依赖 PDF 内的 OCR 文本层；纯图片、无文本层的 PDF 无法划词与标色。
- 生词卡的释义由 LLM 生成，需要自备 key；首次生成可能要几十秒。
- 分页/缩放后标记会重算，超大页面在低端设备上略卡。
- 仓库**不含**任何示例 PDF（版权原因），`frontend/public/pdfs/` 为空 —— dev mock 模式里出现的文件名只是假数据，对应的 PDF 链接会 404。

## License

未指定（作者保留所有权利）。如需开源授权请由作者补充。
