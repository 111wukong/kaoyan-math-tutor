import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles/index.css';
/* ★ 这一行必须排在 App 之前。
 *
 * stores/theme.ts 在模块顶层就调用了 applyTheme(readCachedTheme()) ——
 * import 求值顺序保证它在本文件往下执行之前跑完，也就是**在 React 渲染之前**
 * 就把 data-theme 挂到了 <html> 上。首屏因此直接是正确颜色，
 * 不会出现「先深空、再跳成宣纸」的闪变。
 *
 * 如果把这行挪到 App 之后，或者改成在 useEffect 里应用，那个闪变就会回来。
 * import 顺序在这里是有语义的，不是随手排的。 */
import './stores/theme';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 首屏启动动画：React 挂载完成即淡出，别让它多留一帧
const boot = document.getElementById('boot');
if (boot) {
  boot.classList.add('gone');
  setTimeout(() => boot.remove(), 600);
}
