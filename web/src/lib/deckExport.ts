/* 卡片库导出：打印 / 独立 HTML
 *
 * 为什么走浏览器打印而不是引 jsPDF：
 *   - 浏览器自带排版引擎，中文断行、公式、字体全都免费且正确；
 *   - 引一个 PDF 库要多 300KB+，还得自己处理分页，结果通常更差。
 *
 * 两个格式：
 *   打印版 —— 白底黑字、两栏、卡片不被分页切断，直接 Ctrl+P 存 PDF；
 *   独立版 —— 单文件 HTML，能直接发给别人看（自带样式，不依赖本应用）。
 *
 * ── ★ 公式渲染：不要再写第二套管线 ────────────────────────────────
 *
 * 这个文件曾经自己实现过一遍「$...$ / 裸 LaTeX → KaTeX HTML」，结果导出
 * 出来的公式全是 `\frac`、`\lim` 的源码。两处原因，都是结构性的：
 *
 *   1. 它从 `window.katex` 取 KaTeX，而项目里 katex 是 ESM import 进来的
 *      （见 components/ui/Math.tsx），**从来没有挂到 window 上**。
 *      于是每次渲染都命中「拿不到 katex」的降级分支，直接吐原始源码。
 *   2. 就算把 katex 拿到手，那份正则也处理不了 `\begin{bmatrix}…\end{bmatrix}`、
 *      `\{X\le x_1\}`、`______` 这些真实数据里的形态 —— 而 Math.tsx 里的
 *      autoLatex 每一条分支都是踩过坑写下来的（见那边的注释）。
 *
 * 所以现在的做法是**直接复用产品的渲染管线**（renderRich）。好处不只是
 * 少写代码：页面上看到什么，导出就是什么，公式的坑修一处就够。
 *
 * ── ★ KaTeX 的 CSS 必须内联进导出文件 ────────────────────────────
 *
 * 只把公式渲染成 HTML 是不够的：KaTeX 的排版大量依赖它自己的 CSS
 * （根号是 CSS 画的、积分号/大括号靠字体度量、上下标位置靠定位）。
 * 没有这份 CSS，导出的文件打开就是一坨错位的字符 —— 用户看到的
 * 仍然是「乱码」，只是换了个形态。
 *
 * 以前是 CDN 外链，于是断网 / CDN 不通 = 公式废掉。现在用 `?inline`
 * 在构建时把 CSS 抽成字符串内联进去。
 *
 * 字体仍然走 CDN（绝对地址）：KaTeX 的字体有 1MB 上下，全量内联会让
 * 单文件膨胀到几百 KB。取舍是——打印路径不受影响（页面上字体是本地的、
 * 已加载的），导出的文件在有网时是完美的，断网时退化成系统字体，
 * **内容依然可读**（KaTeX 的 font-family 自带 serif fallback）。
 */

import { renderRich } from '@/components/ui/Math';
import katexCssRaw from 'katex/dist/katex.min.css?inline';

export interface DeckCard {
  id: string;
  kid: string;
  type: string;
  title: string;
  front: string;
  back: string;
  kidTitle?: string;
  /** 来源：ai（模型提取）/ manual（手动添加）/ classroom（课堂生成） */
  src?: string;
  /** 创建时间戳（毫秒） */
  ts?: number;
}

const TYPE_META: Record<string, { label: string; color: string; bg: string }> = {
  point: { label: '必记结论', color: '#0e7490', bg: '#ecfeff' },
  pitfall: { label: '易错点', color: '#b45309', bg: '#fffbeb' },
  formula: { label: '公式', color: '#6d28d9', bg: '#f5f3ff' },
  problem: { label: '题型', color: '#047857', bg: '#ecfdf5' },
  question: { label: '疑问', color: '#be123c', bg: '#fff1f2' },
};

const esc = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ★ 版本号必须和 package.json 里装的 katex 一致。
 *
 * 内联进来的 CSS 里字体是相对路径（url(fonts/KaTeX_…woff2)），而导出文件
 * 旁边并没有 fonts 目录 —— 所以要改写成 CDN 的绝对地址，这就得知道版本号。
 * 写死一个数字是有漂移风险的，所以 tests/deck-export.mjs 里有一条断言
 * 拿它和 node_modules/katex/package.json 比对，升级依赖时会被拦住。 */
export const KATEX_VERSION = '0.18.7';
const KATEX_FONT_BASE = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/fonts/`;

/* ★ 字体引用要统一改写成 CDN 绝对地址 —— 而且**不能只盯 `fonts/`**。
 *
 * 这份 CSS 是构建产物，Vite 早就动过手了，实测下来是**两种形态混着**：
 *
 *   · 大于 4KB 的字体 → url(/assets/KaTeX_AMS-Regular-BQhdFMY1.woff2)
 *     —— 根相对路径，在导出的单文件里等于 file:///assets/… → 404，
 *        有网也救不回来（文件名还带内容 hash，CDN 上没有这一份）
 *   · 小于 4KB 的字体 → url(data:font/woff2;base64,…)
 *     —— 已经是最理想的自包含形态，**不要动它**
 *
 * 所以只替换 `fonts/` 等于什么都没做（实测就是这么漏过去的：断言写的是
 * 「没有出现 url(fonts/…)」，而那个形态在构建产物里根本不存在）。
 *
 * 这里做两件事：认出 /assets/ 形态，并把 hash 后缀剥掉 —— CDN 上只有
 * `KaTeX_AMS-Regular.woff2`，没有带 hash 的那一份。
 *
 * hash 段按 `[A-Za-z0-9_]{8}` 匹配，**不含短横线**。用 `[\w-]{8}` 会把
 * `KaTeX_Size1-Regular` 里的 `-Regular` 当成 hash 剥掉，产出
 * `KaTeX_Size1.woff2`（CDN 上不存在）。
 *
 * 正则不可能穷举所有形态，所以 tests/deck-export.mjs 里有兜底断言：
 * 内联 CSS 里**每一个** url() 都必须是 data URI 或 CDN 绝对地址，且数量
 * 不能为 0。漏网的会被当场抓住 —— 这正是上次那条假绿换来的。 */
const KATEX_FONT_RE =
  /url\(\s*(['"]?)[^)'"]*?(KaTeX_[A-Za-z0-9_-]+?)(?:-[A-Za-z0-9_]{8})?\.(woff2|woff|ttf)\1\s*\)/g;

export const katexInlineCss = String(katexCssRaw).replace(
  KATEX_FONT_RE,
  (_m, q, name, ext) => `url(${q}${KATEX_FONT_BASE}${name}.${ext}${q})`,
);

/** 页面/导出共用的版式。字体族和配色是给**白纸**定的，跟应用主题无关。 */
const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #111827;
    font-family: "PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif; }
  .p-root { max-width: 820px; margin: 0 auto; padding: 26px 22px 40px; }
  .p-header { display: flex; align-items: flex-end; justify-content: space-between;
    gap: 16px; padding-bottom: 14px; border-bottom: 2px solid #111827; margin-bottom: 22px; }
  .p-header h1 { margin: 0; font-size: 21px; letter-spacing: -0.01em; }
  .p-sub { margin: 5px 0 0; font-size: 12.5px; color: #6b7280; }
  .p-meta { font-size: 12px; color: #6b7280; white-space: nowrap; }
  .p-group { margin-bottom: 26px; }
  .p-group-title { margin: 0 0 11px; font-size: 14.5px; color: #0f172a;
    padding-left: 9px; border-left: 3px solid #0e7490; }
  .p-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
  .p-card { border: 1px solid #e5e7eb; border-left: 3px solid var(--c);
    border-radius: 8px; padding: 11px 13px; background: #fff; }
  .p-card-head { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
  .p-tag { flex-shrink: 0; font-size: 10.5px; font-weight: 600; color: var(--c);
    background: var(--bg); border-radius: 4px; padding: 1.5px 6px; }
  .p-card-title { margin: 0; font-size: 13px; font-weight: 600; color: #111827; }
  .p-card-front { font-size: 12.5px; line-height: 1.72; color: #374151; }
  .p-card-back { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e5e7eb;
    font-size: 12.5px; line-height: 1.72; color: #111827; }
  .p-back-label { display: inline-block; font-size: 10.5px; font-weight: 600; color: #047857;
    background: #ecfdf5; border-radius: 4px; padding: 1px 5px; margin-right: 6px; }
  .p-footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e5e7eb;
    font-size: 11px; color: #9ca3af; text-align: center; }

  /* ★ 卡片正文是 renderRich 渲染的，它带的是**应用的 tailwind 类**
     （text-fg-soft / my-2 / border-hairline…）。这些类在导出文档里没有
     对应的 CSS —— 导出文件不带 tailwind。所以这里按元素名补一套最小版式，
     否则段落会挤在一起、表格没有边框、代码块变成白底黑字的一坨。
     改 renderRich 的结构时，这一节要跟着看一眼。 */
  .p-card-front > :first-child, .p-card-back > :first-child { margin-top: 0; }
  .p-card-front > :last-child, .p-card-back > :last-child { margin-bottom: 0; }
  .p-card-front p, .p-card-back p { margin: 0.45em 0; }
  .p-card-front ul, .p-card-front ol,
  .p-card-back ul, .p-card-back ol { margin: 0.45em 0; padding-left: 1.35em; }
  .p-card-front ul, .p-card-back ul { list-style: disc; }
  .p-card-front ol, .p-card-back ol { list-style: decimal; }
  .p-card-front li, .p-card-back li { margin: 0.15em 0; }
  .p-card-front h2, .p-card-front h3, .p-card-front h4, .p-card-front h5,
  .p-card-back h2, .p-card-back h3, .p-card-back h4, .p-card-back h5 {
    margin: 0.6em 0 0.25em; font-size: 1.02em; font-weight: 600; color: #111827; }
  .p-card-front strong, .p-card-back strong { font-weight: 600; color: #111827; }
  .p-card-front a, .p-card-back a { color: #0e7490; text-decoration: underline; }
  .p-card-front code, .p-card-back code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em; background: #f3f4f6; border-radius: 4px;
    padding: 1px 4px; color: #0f172a; }
  .p-card-front pre, .p-card-back pre { margin: 0.5em 0; padding: 8px 10px;
    background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; overflow-x: auto; }
  .p-card-front pre code, .p-card-back pre code { background: none; padding: 0; }
  .p-card-front blockquote, .p-card-back blockquote { margin: 0.5em 0;
    padding-left: 10px; border-left: 2px solid #cbd5e1; color: #4b5563; }
  .p-card-front hr, .p-card-back hr { margin: 0.6em 0; border: none;
    border-top: 1px solid #e5e7eb; }
  .p-card-front table, .p-card-back table { width: 100%; margin: 0.5em 0;
    border-collapse: collapse; font-size: 12px; }
  .p-card-front th, .p-card-front td,
  .p-card-back th, .p-card-back td { border: 1px solid #e5e7eb; padding: 4px 6px; text-align: left; }
  .p-card-front th, .p-card-back th { background: #f8fafc; font-weight: 600; }

  /* 公式失败时的降级块（renderRich 里那条 catch 分支）——
     它是浅色文字配深底，在白纸上几乎看不见，这里改成深色。 */
  .p-card-front code.katex-fallback, .p-card-back code.katex-fallback {
    background: #fffbeb; color: #92400e; }

  .katex { font-size: 1em; }
  .katex-display { margin: 0.6em 0; }

  @media print {
    .p-root { max-width: none; padding: 0; }
    .p-card { break-inside: avoid; page-break-inside: avoid; }
    .p-group { break-inside: auto; }
    @page { margin: 14mm 12mm; }
  }
`;

/** 文档级 CSS：版式 + KaTeX。两条路径共用，避免「打印对、导出错」这种漂移。 */
export const DOC_CSS = `${katexInlineCss}\n${BASE_CSS}`;

function cardsHtml(cards: DeckCard[], opts: { title: string; subtitle?: string }) {
  const groups = new Map<string, DeckCard[]>();
  cards.forEach((c) => {
    const k = c.kidTitle || c.kid;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  });

  const body = [...groups.entries()].map(([kidTitle, list]) => `
    <section class="p-group">
      <h2 class="p-group-title">${esc(kidTitle)}</h2>
      <div class="p-grid">
        ${list.map((c) => {
          const m = TYPE_META[c.type] || TYPE_META.point;
          return `
          <article class="p-card" style="--c:${m.color};--bg:${m.bg}">
            <div class="p-card-head">
              <span class="p-tag">${m.label}</span>
              <h3 class="p-card-title">${esc(c.title)}</h3>
            </div>
            <div class="p-card-front">${renderRich(c.front)}</div>
            ${c.back ? `<div class="p-card-back"><span class="p-back-label">答</span>${renderRich(c.back)}</div>` : ''}
          </article>`;
        }).join('')}
      </div>
    </section>
  `).join('');

  return `
    <div class="p-root">
      <header class="p-header">
        <div>
          <h1>${esc(opts.title)}</h1>
          ${opts.subtitle ? `<p class="p-sub">${esc(opts.subtitle)}</p>` : ''}
        </div>
        <div class="p-meta">共 ${cards.length} 张 · ${groups.size} 个考点</div>
      </header>
      ${body}
      <footer class="p-footer">研数 · 考研数学 AI 自学系统</footer>
    </div>
  `;
}

/** 在当前页打印（走浏览器打印引擎 → 可存 PDF） */
export function printDeck(cards: DeckCard[], title = '研数 · 复习卡片') {
  if (!cards.length) return false;

  let portal = document.getElementById('print-portal');
  if (portal) portal.remove();

  portal = document.createElement('div');
  portal.id = 'print-portal';

  /* 样式随 portal 一起挂：不依赖应用全局的样式表还在不在。
     重复引入 KaTeX CSS 不会冲突（同样的规则），但少一处「打印时样式没跟过来」。 */
  const style = document.createElement('style');
  style.textContent = DOC_CSS;
  portal.appendChild(style);

  const wrap = document.createElement('div');
  wrap.innerHTML = cardsHtml(cards, {
    title,
    subtitle: `导出时间 ${new Date().toLocaleString('zh-CN')}`,
  });
  portal.appendChild(wrap);

  document.body.appendChild(portal);
  window.print();
  setTimeout(() => portal?.remove(), 800);
  return true;
}

/** 下载成独立 HTML（单文件，直接能发给别人） */
export function downloadDeckHtml(cards: DeckCard[], title = '研数 · 复习卡片') {
  if (!cards.length) return false;

  /* 公式在**生成时**就已经渲染成静态 HTML 了（cardsHtml → renderRich），
     所以这里不需要任何脚本 —— 导出的文件不跑 JS 也能正确显示。
     以前这里挂了一个 CDN 的 katex.min.js，却没有任何地方调用它，
     是彻底的死代码（真正的问题在生成端，它救不了）。 */
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<style>${DOC_CSS}</style>
</head>
<body>
${cardsHtml(cards, { title, subtitle: `导出于 ${new Date().toLocaleString('zh-CN')}` })}
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `研数卡片-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** 纯文本（复制到微信/备忘录） */
export function deckToText(cards: DeckCard[]) {
  const groups = new Map<string, DeckCard[]>();
  cards.forEach((c) => {
    const k = c.kidTitle || c.kid;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  });
  const lines: string[] = [];
  groups.forEach((list, kidTitle) => {
    lines.push(`## ${kidTitle}`);
    list.forEach((c) => {
      lines.push(`- 【${TYPE_META[c.type]?.label || c.type}】${c.title}`);
      lines.push(`  Q: ${c.front.replace(/\n/g, ' ')}`);
      if (c.back) lines.push(`  A: ${c.back.replace(/\n/g, ' ')}`);
    });
    lines.push('');
  });
  return lines.join('\n');
}
