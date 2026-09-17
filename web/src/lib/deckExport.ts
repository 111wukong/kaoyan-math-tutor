/* 卡片库导出：打印 / 独立 HTML
 *
 * 为什么走浏览器打印而不是引 jsPDF：
 *   - 浏览器自带排版引擎，中文断行、公式、字体全都免费且正确；
 *   - 引一个 PDF 库要多 300KB+，还得自己处理分页，结果通常更差。
 *
 * 两个格式：
 *   打印版 —— 白底黑字、两栏、卡片不被分页切断，直接 Ctrl+P 存 PDF；
 *   独立版 —— 单文件 HTML，能直接发给别人看（自带样式，不依赖本应用）。
 */

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

/* 卡片里的 LaTeX 交给 KaTeX —— 但导出文件要能离线打开，
   所以只用 CDN（打印时通常有网）。渲染失败就退回原文，不会崩。 */
function renderTexSafe(tex: string, display: boolean) {
  const g = (window as any).katex;
  if (!g?.renderToString) return `<code>${esc(tex)}</code>`;
  try {
    return g.renderToString(tex, { displayMode: display, throwOnError: false, strict: false });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

/** 把文本里的 $...$ / 裸 LaTeX 转成 KaTeX HTML，其余转义 */
function richText(text: string) {
  const parts: string[] = [];
  let work = String(text ?? '');

  work = work.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => {
    parts.push(renderTexSafe(t, true));
    return `\u0000M${parts.length - 1}\u0000`;
  });
  work = work.replace(/\$([^$\n]+?)\$/g, (_, t) => {
    parts.push(renderTexSafe(t, false));
    return `\u0000M${parts.length - 1}\u0000`;
  });
  work = work.replace(/\\[a-zA-Z]+(?:\s*[_^]\{[^{}]*\})*(?:\{[^{}]*\})*/g, (m) => {
    parts.push(renderTexSafe(m, false));
    return `\u0000M${parts.length - 1}\u0000`;
  });

  let out = esc(work)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br />');

  out = out.replace(/\u0000M(\d+)\u0000/g, (_, i) => parts[Number(i)] ?? '');
  return out;
}

function cardsHtml(cards: DeckCard[], opts: { title: string; subtitle?: string; forPrint: boolean }) {
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
            <div class="p-card-front">${richText(c.front)}</div>
            ${c.back ? `<div class="p-card-back"><span class="p-back-label">答</span>${richText(c.back)}</div>` : ''}
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
  .katex { font-size: 1em; }
  @media print {
    .p-root { max-width: none; padding: 0; }
    .p-card { break-inside: avoid; page-break-inside: avoid; }
    .p-group { break-inside: auto; }
    @page { margin: 14mm 12mm; }
  }
`;

/** 在当前页打印（走浏览器打印引擎 → 可存 PDF） */
export function printDeck(cards: DeckCard[], title = '研数 · 复习卡片') {
  if (!cards.length) return false;

  let portal = document.getElementById('print-portal');
  if (portal) portal.remove();

  portal = document.createElement('div');
  portal.id = 'print-portal';

  const style = document.createElement('style');
  style.textContent = BASE_CSS;
  portal.appendChild(style);

  const wrap = document.createElement('div');
  wrap.innerHTML = cardsHtml(cards, {
    title,
    subtitle: `导出时间 ${new Date().toLocaleString('zh-CN')}`,
    forPrint: true,
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

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" />
<style>${BASE_CSS}</style>
</head>
<body>
${cardsHtml(cards, { title, subtitle: `导出于 ${new Date().toLocaleString('zh-CN')}`, forPrint: false })}
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script>
  // 无网时公式保持原样（KaTeX 未加载），不会崩
  if (!window.katex) console.info('未加载 KaTeX，公式以源码显示');
<\/script>
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
