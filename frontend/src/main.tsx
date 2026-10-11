import ReactDOM from 'react-dom/client'
import App from './App'
import { applyTouchClass } from './touch'
import './styles.css'

// 触屏判据先落根元素类（必须早于渲染，见 touch.ts：媒体查询在 iPad 上不可靠）
applyTouchClass()

// 不用 StrictMode：pdf.js 页渲染是副作用型，双调用会重复 render canvas/文本层
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
