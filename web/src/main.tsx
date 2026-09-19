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
import { ErrorBoundary, installGlobalErrorHandlers } from './components/ErrorBoundary';
import { useApp } from './stores/app';

/* 异步异常的兜底必须在 render 之前装上 —— 首屏那几个请求就是最早
 * 可能 reject 的东西，装晚了它们就漏过去了。 */
installGlobalErrorHandlers(useApp.getState().pushToast);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* ★ ErrorBoundary 必须包在 App 外面，而且要在 StrictMode 里侧 ——
        它是唯一能阻止「一个页面抛错 → 整棵树卸载 → 用户看到白屏」的东西。
        放在 App 里侧的话，Router 自己崩掉时它也一起没了。 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// 首屏启动动画：React 挂载完成即淡出，别让它多留一帧
const boot = document.getElementById('boot');
if (boot) {
  boot.classList.add('gone');
  setTimeout(() => boot.remove(), 600);
}
