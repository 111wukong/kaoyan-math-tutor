/* 气泡 / 解析的 Markdown + 数学渲染回归
 *
 * 这组用例盯的是「标记符号和公式直接漏到屏幕上」这一类缺陷 ——
 * 页面不报错、控制台干净、其余测试全绿，用户却在气泡里看到裸露的 ** 和 $。
 * 修之前，下面 15 个真实句式里有 7 个会漏。
 *
 * 根因不是巧合，是两个来源的格式不一致：
 *   · 模型输出 —— 提示词明确要求「行内 $...$，独立 $$...$$」
 *     （agent.js / engine.js / classroom.js 三处都这么写）
 *   · 题库数据 —— 裸 LaTeX，没有 $ 包裹（data-questions.js 里一个 $ 都没有）
 * 两者进同一个渲染函数。老实现只认后者：autoLatex 看见 $\frac{1}{2}$
 * 里的 \frac 会再包一层 $，原来那两个 $ 就变成了字面量。
 *
 * 另一半是顺序问题：老实现「先按 $ 切分、再逐段套 **加粗**」，
 * 于是「**当 $x\to 0$ 时**」被 $ 从中间切开，两半各剩一个 **，谁都不配对。
 *
 * 渲染函数藏在 app.js 的 IIFE 里（它启动时要摸 DOM，Node 里没法直接 require），
 * 所以这里按段落标记把源码切出来 eval。标记找不到就立刻失败，不静默跳过。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'js/app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  => ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

/* ---------------- 0. 把渲染段切出来 ---------------- */
function cut(from, to, plusEnd) {
  const a = SRC.indexOf(from);
  if (a < 0) return null;
  const b = SRC.indexOf(to, a + from.length);
  if (b < 0) return null;
  return SRC.slice(a, b + (plusEnd || 0));
}
const RENDER = cut('  /* ============ 数学渲染', '  /* ============ 数据索引');
const ESC = cut('  function esc(s) {', '\n  }\n', 4);

console.log('=== 0. 渲染段可以从 app.js 里切出来 ===');
ok(!!RENDER && RENDER.length > 2000, '★ 找得到渲染段（app.js 的段落标记变了就得同步改这里）', RENDER ? RENDER.length : null);
ok(!!ESC, '★ 找得到 esc()');

/* 桩 KaTeX：把渲染过的公式包成 <K>…</K>，好判断哪些片段真的过了渲染器 */
global.window = { katex: { renderToString: function (tex) { return '<K>' + tex + '</K>'; } } };
/* 导出写成防御式的：函数不存在时给 null，而不是让整个测试脚本崩掉 ——
   崩掉只会得到一行堆栈，看不出到底是哪个函数没了。 */
const mod = { exports: {} };
new Function('module', 'exports', ESC + '\n' + RENDER + '\n' + [
  'module.exports = {',
  '  md:          typeof md === "function" ? md : null,',
  '  mdStream:    typeof mdStream === "function" ? mdStream : null,',
  '  inlineMd:    typeof inlineMd === "function" ? inlineMd : null,',
  '  inlineBlock: typeof inlineBlock === "function" ? inlineBlock : null,',
  '  autoLatex:   typeof autoLatex === "function" ? autoLatex : null',
  '};'
].join('\n'))(mod, mod.exports);
const R = mod.exports;

const CORE = ['md', 'inlineMd', 'inlineBlock'];
const MISSING = CORE.filter(function (k) { return typeof R[k] !== 'function'; });
ok(MISSING.length === 0, '★ 渲染函数都在（缺：' + (MISSING.join('、') || '无') + '）', MISSING);
if (MISSING.length) {
  /* 连渲染函数都没有，后面的用例全都没有意义 —— 直接报失败，别假装跑过 */
  console.log('\n──────────────────────────────');
  console.log('❌ 有失败：' + pass + ' 项，失败 ' + (fail + MISSING.length));
  process.exit(1);
}

/* 剥掉「已渲染的公式」和「流式尾巴」之后剩下的，就是用户真正会看到的裸文本。
   这里任何 ** / $ / ` / 反斜杠 / # 都是漏出来的标记。 */
function bare(h) {
  return String(h)
    .replace(/<K>[\s\S]*?<\/K>/g, '')
    .replace(/<span class="md-tail">[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]+>/g, '');
}
function clean(h) {
  const t = bare(h);
  return !/\*\*|\$|`|\\[a-zA-Z]|(^|[^*])\*[^*]|#/.test(t);
}

/* ---------------- 1. 行内公式：模型输出的主要形式 ---------------- */
console.log('\n=== 1. $...$ 行内公式必须渲染，$ 不许留在屏幕上 ===');
{
  const h = R.md('答案是 $\\frac{3}{2}$，注意 $x^{2}$。');
  ok(h.indexOf('<K>\\frac{3}{2}</K>') >= 0, '★ $\\frac{3}{2}$ 交给了渲染器', h);
  ok(clean(h), '★ 屏幕上没有裸露的 $', bare(h));
  ok(bare(h).indexOf('，注意') >= 0, '★ 中文没有被卷进公式里', bare(h));
}
{
  const h = R.md('$x$');
  ok(h === '<p><K>x</K></p>', '★ 单个行内公式只渲染一次（老实现会二次包裹）', h);
}
{
  const h = R.md('\\(a+b\\) 与 \\[c+d\\]');
  ok(h.indexOf('<K>a+b</K>') >= 0, '\\(...\\) 也认', h);
  ok(h.indexOf('<K>c+d</K>') >= 0, '\\[...\\] 也认', h);
}

/* ---------------- 2. 加粗跨公式（老实现漏 ** 的主因） ---------------- */
console.log('\n=== 2. **加粗** 跨过公式时不许断成两半 ===');
{
  const h = R.md('**当 $x \\to 0$ 时，$\\sin x \\sim x$**，可以直接替换。');
  ok(h.indexOf('<b>') >= 0, '★ 加粗生效了', h);
  ok(clean(h), '★ 没有裸露的 **', bare(h));
}
{
  const h = R.md('**注意 $\\varepsilon$-$\\delta$ 语言**');
  ok(h.indexOf('<b>') >= 0 && clean(h), '★ 公式结尾就是加粗结尾也不漏 **', h);
}
{
  const h = R.md('**结论**：$a*b$ 是乘法');
  ok(h.indexOf('<b>结论</b>') >= 0 && clean(h), '★ 加粗里的 * 和公式里的 * 互不干扰', h);
}

/* ---------------- 3. 裸 LaTeX：题库数据的形式，不能被改坏 ---------------- */
console.log('\n=== 3. 裸 LaTeX（题库数据）仍然照常渲染 ===');
{
  /* 真·题库解析，抄自 data-questions.js（运行时的值是单个反斜杠） */
  const q = '拆成 \\frac{3}{2} \\cdot \\frac{\\sin 3x}{3x}，由重要极限 \\lim_{x\\to0}\\frac{\\sin x}{x}=1 得 \\frac{3}{2}。';
  const h = R.inlineMd(q);
  ok(h.indexOf('<K>') >= 0, '★ 裸 LaTeX 被包成了公式', h);
  ok(!/\\[a-zA-Z]/.test(bare(h)), '★ 屏幕上没有反斜杠源码', bare(h));
}
{
  const h = R.inlineMd('矩阵满足 (AB)^{T}=B^{T}A^{T}，(AB)^{-1}=B^{-1}A^{-1}。');
  ok(!/\\[a-zA-Z]/.test(bare(h)), '★ 上标/下标裸写法也渲染', bare(h));
}
{
  const h = R.md('当 X \\sim N(\\mu,\\sigma^{2}) 时 D X = \\sigma^{2}。');
  ok(!/\\[a-zA-Z]/.test(bare(h)), '★ 正文里夹裸公式不留源码', bare(h));
}

/* ---------------- 4. 块级公式 ---------------- */
console.log('\n=== 4. $$...$$ 必须独立成块，不能塞进 <p> ===');
{
  const h = R.md('推导如下：\n\n$$\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$$\n\n所以成立。');
  ok(h.indexOf('<div class="katex-display">') >= 0, '★ 有 katex-display 容器', h);
  ok(!/<p>[^<]*<div class="katex-display">/.test(h), '★ 块级公式没有落在 <p> 内部', h);
  ok(clean(h), '★ 没有裸露的 $$', bare(h));
}

/* ---------------- 5. 标题 / 列表 / 表格 ---------------- */
console.log('\n=== 5. 标题、列表、表格的标记不许漏出来 ===');
{
  const h = R.md('#### 解题步骤\n先看分母。');
  ok(h.indexOf('<div class="md-h4">') >= 0, '★ #### 变成了标题', h);
  ok(clean(h), '★ 没有裸露的 #', bare(h));
}
{
  const h = R.md('- **必记结论**：$\\lim_{x\\to0}\\frac{\\sin x}{x}=1$\n- **易错点**：不能在加减里代换');
  ok(h.indexOf('<ul class="md-ul">') >= 0, '★ - 变成了无序列表', h);
  ok(h.indexOf('<b>必记结论</b>') >= 0, '★ 列表项里的加粗生效', h);
  ok(clean(h), '★ 列表项里没有裸露标记', bare(h));
}
{
  const h = R.md('1. 先求导\n2. 再代入');
  ok(h.indexOf('<ol class="md-ol">') >= 0, '★ 1. 变成了有序列表', h);
  ok(bare(h).indexOf('1.') < 0, '★ 序号标记没漏出来', bare(h));
}
{
  const h = R.md('| 类型 | 公式 |\n| --- | --- |\n| 等价 | $\\sin x\\sim x$ |');
  ok(h.indexOf('<table class="md-table">') >= 0, '★ 表格被识别', h);
  ok(clean(h), '★ 表格里没有裸露的 | 和反斜杠', bare(h));
}

/* ---------------- 6. 强调的边界：不能吃掉乘法 ---------------- */
console.log('\n=== 6. 强调要认，但乘法不能被吃掉 ===');
{
  const h = R.md('这是 *重要* 的一点。');
  ok(h.indexOf('<i>重要</i>') >= 0, '★ *斜体* 生效', h);
}
{
  const h = R.md('__重点__ 这里');
  ok(h.indexOf('<b>重点</b>') >= 0, '★ __加粗__ 生效', h);
  ok(bare(h).indexOf('__') < 0, '★ __ 没被 autoLatex 当成公式吞掉', bare(h));
}
{
  const a = R.md('计算 2 * 3 = 6 和 a*b。');
  ok(bare(a).indexOf('2 * 3') >= 0, '★ 2 * 3 的乘号保留', bare(a));
  ok(bare(a).indexOf('a*b') >= 0, '★ a*b 的乘号保留', bare(a));
}
{
  const h = R.md('写成 `x^2` 或者 `\\frac{1}{2}` 都行。');
  ok(h.indexOf('<code>') >= 0, '★ 反引号变成了行内代码', h);
  ok(bare(h).indexOf('`') < 0, '★ 反引号没漏出来', bare(h));
}

/* ---------------- 7. 转义：正文里的尖括号不能变成标签 ---------------- */
console.log('\n=== 7. 正文必须转义 ===');
{
  const h = R.md('比较 a < b 且 c > d。');
  ok(h.indexOf('&lt;') >= 0 && h.indexOf('&gt;') >= 0, '★ 尖括号被转义', h);
  ok(h.indexOf('<script') < 0 && R.md('<img src=x onerror=alert(1)>').indexOf('<img') < 0,
    '★ 标签注入进不来', h);
}

/* ---------------- 8. 流式渲染：半截文本不许漏标记 ---------------- */
console.log('\n=== 8. 打字机的半截文本不许闪出裸标记 ===');
if (typeof R.mdStream !== 'function') {
  ok(false, '★ mdStream 存在（流式渲染器，修之前没有）');
} else {
  const full = '**等价无穷小代换**：当 $x \\to 0$ 时，$$\\lim_{x\\to0}\\frac{\\sin x}{x}=1$$ 所以 `\\sin x \\sim x`。';
  let bad = 0, first = '';
  for (let i = 1; i <= full.length; i++) {
    const h = R.mdStream(full.slice(0, i));
    if (!clean(h)) { bad++; if (!first) first = full.slice(0, i); }
  }
  ok(bad === 0, '★ ' + full.length + ' 帧里没有一帧漏标记', { bad, first });
  ok(R.mdStream(full) === R.md(full), '★ 整段说完时和正式渲染完全一致');
  {
    const h = R.mdStream('**还没闭合的加粗');
    ok(h.indexOf('md-tail') >= 0, '★ 未闭合的加粗尾巴被挂成纯文本', h);
    ok(bare(h).indexOf('**') < 0 || h.indexOf('md-tail') >= 0, '★ 未闭合的 ** 没进正文', bare(h));
  }
  {
    const h = R.mdStream('推导：$$\\lim_{x\\to0}');
    ok(h.indexOf('katex-display') < 0, '★ 未闭合的块级公式先不渲染（避免整段跳动）', h);
  }
}

/* ---------------- 9. inlineMd 的契约：不加块级包装 ---------------- */
console.log('\n=== 9. inlineMd 不能塞 <p>（用在 .ans 这类行内位置）===');
{
  const h = R.inlineMd('答案 $\\frac{3}{2}$');
  ok(h.indexOf('<p>') < 0, '★ 没有块级 <p>', h);
  ok(h.indexOf('<K>') >= 0, '★ 公式照样渲染', h);
}

/* ---------------- 10. 课堂答题卡题干必须走渲染器 ---------------- */
console.log('\n=== 10. 课堂答题卡的题干走 md()，不是 esc() ===');
{
  /* 题干是整堂课公式最密集的地方。以前这里是 esc(a.prompt)，
     老师出的题会带着裸露的 $...$ 和 ** 一起出现在答题卡上。 */
  ok(SRC.indexOf("'<div class=\"c-ask-q\">' + md(a.prompt || '') + '</div>'") >= 0,
    '★ c-ask-q 用的是 md(a.prompt)');
  ok(SRC.indexOf("'<div class=\"c-ask-q\">' + esc(a.prompt || '')") < 0,
    '★ 老的 esc(a.prompt) 已经不存在');
}

console.log('\n──────────────────────────────');
console.log((fail === 0 ? '✅ 渲染回归全部通过：' : '❌ 有失败：') + pass + ' 项' + (fail ? '，失败 ' + fail : ''));
process.exit(fail ? 1 : 0);
