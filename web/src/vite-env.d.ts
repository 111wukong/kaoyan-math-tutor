/* Vite 客户端类型。
 * 没有这个引用，`import './styles/index.css'` 这类副作用导入会被 TS 判为
 * "Cannot find module or type declarations"，而 vite build 又不报 —— 只有
 * tsc --noEmit 才看得见。所以它必须存在。 */
/// <reference types="vite/client" />
