/* 整条渲染管线的全量漏屏检查（不需要浏览器、不需要起服务，纯静态）
 *
 * 为什么单独立这一套，而不是加进 latex-coverage.mjs：
 *   latex-coverage 验的是 **autoLatex 的包裹对不对**（$ 之外不该有裸 \command、
 *   且不许增删字符）。但「包裹对了」≠「KaTeX 解析得了」。
 *
 *   renderTex 以前用的是 throwOnError:false —— 这个「容错」选项比名字看起来阴得多，
 *   它有**两种**失败形态，而且都不是好结果：
 *     a) 吐一个 <span class="katex-error">原始源码</span>。
 *        这个 span 的类名是 katex-error、不是独立成词的 katex，所以浏览器套件那句
 *        querySelectorAll('.katex, .katex-display').remove() **删不掉它** ——
 *        源码就带着反斜杠漏到屏幕上了。
 *     b) **既不抛异常、也不给 katex-error，静默渲染出一个错的结果。**
 *        实测 `\begin{pmatrix}1&1\1&1\end{pmatrix}`（行分隔符少了一个反斜杠）
 *        被渲染成 1×3 而不是 2×2，后面的数字直接吞掉 —— 页面不报错、构建通过、
 *        测试全绿、肉眼也不一定看得出。题库里就真的有 3 处这种。
 *
 *   产品已改成 throwOnError:true，让失败一定走 renderTex 自己的降级路径；
 *   本套件对两种形态都记账（抛异常 / katex-error 标记），一个都不放过。
 *
 *   这就是「autoLatex 全绿、浏览器套件报漏屏」那个矛盾的来源：
 *   两层检查看的是不同的东西，中间那一层（KaTeX 到底认不认）谁都没管。
 *
 * 所以这里跑的是**完整 renderRich**，用真 katex，按浏览器套件同一判据检查输出 HTML。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildCore, REPO } from './lib/extract-pipeline.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
function section(t) { console.log(`\n\x1b[36m【${t}】\x1b[0m`); }

/* ============================================================
   0. 漏屏检测器 —— 先定义，好在第 1 节自检它
   ============================================================ */

/** 把已渲染的 KaTeX 子树整棵剔除（等价于浏览器里 clone 后 remove()）。
 *
 *  注意类名判定用的是**独立成词**的 katex：
 *    class="katex"         → 剔除
 *    class="katex-display" → 不剔除（div，且里面那层 .katex 会被剔）
 *    class="katex-error"   → **不剔除** —— 与浏览器行为一致，这正是漏屏的载体
 */
function stripKatex(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<span', i)) {
      const tagEnd = html.indexOf('>', i);
      const tag = html.slice(i, tagEnd + 1);
      if (/class="[^"]*(?<![\w-])katex(?![\w-])/.test(tag)) {
        let depth = 1;
        let j = tagEnd + 1;
        while (j < html.length && depth > 0) {
          const nextOpen = html.indexOf('<span', j);
          const nextClose = html.indexOf('</span>', j);
          if (nextClose < 0) break;
          if (nextOpen >= 0 && nextOpen < nextClose) { depth++; j = nextOpen + 5; }
          else { depth--; j = nextClose + 7; }
        }
        i = j;
        continue;
      }
    }
    out += html[i];
    i++;
  }
  return out;
}

/** 剔除公式后还剩几个裸 \command —— 那就是会漏到屏幕上的 */
function leakedCommands(html) {
  return stripKatex(String(html)).match(/\\[a-zA-Z]+/g) || [];
}

/** KaTeX 解析失败？—— throwOnError:false 时它会吐 class="katex-error" */
function hasKatexError(html) {
  return String(html).includes('katex-error');
}

/* ============================================================
   1. 自检：检测器真的会报警吗
   一个永远为绿的检查比没有检查更糟 —— 它会让人以为有保护。
   ============================================================ */
section('1. 自检：漏屏检测器真的会报警吗');
{
  const good = '<p>结果是 <span class="katex"><span class="katex-html">x2</span></span> 这样</p>';
  ok('对已渲染的公式不误报', leakedCommands(good).length === 0, JSON.stringify(leakedCommands(good)));

  const bad = '<p>结果是 \\frac{1}{2} 这样</p>';
  ok('对裸 LaTeX 报警', leakedCommands(bad).length > 0, JSON.stringify(leakedCommands(bad)));

  /* ★ 这条是关键：katex-error 必须被算作漏屏，不能被当公式剔掉。
   * 写错成 /katex/ 就会把它一起剔掉，然后永远绿。 */
  const errSpan = '<span class="katex-error" title="x">\\frac{1}{</span>';
  ok('★ katex-error 不算已渲染公式（会被算作漏屏）',
    leakedCommands(errSpan).length > 0, JSON.stringify(leakedCommands(errSpan)));
  ok('★ katex-error 能被识别成解析失败', hasKatexError(errSpan) === true);

  ok('对正确的 katex 输出不误报 katex-error', hasKatexError(good) === false);

  /* 嵌套公式：外层剔除要连内层一起带走 */
  const nested = '<span class="katex"><span class="katex"><i>a</i></span>\\b</span>';
  ok('嵌套 span 能整棵剔干净', leakedCommands(nested).length === 0, JSON.stringify(leakedCommands(nested)));
}

/* ============================================================
   2. 抽出真实管线（不手抄）
   ============================================================ */
section('2. 从产品源码里抽完整管线');
const katex = (await import(path.join(REPO, 'node_modules', 'katex', 'dist', 'katex.mjs'))).default;
globalThis.katex = katex;

let core = null;
try {
  core = await import(buildCore());
} catch (e) {
  ok('管线能在 Node 里跑起来', false, e.message);
}
ok('管线能在 Node 里跑起来', !!(core && typeof core.renderRich === 'function'));
if (!core || typeof core.renderRich !== 'function') {
  console.log(`\n\x1b[31m❌ 渲染管线漏屏检查：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
const { renderRich, inlinePipeline } = core;

/* 记账：哪些公式送进了 KaTeX、成没成。
 * ★ 两种失败形态都要接住：
 *   · 抛异常（throwOnError:true，产品现在用的）
 *   · 返回了带 katex-error 的 HTML（throwOnError:false 的**部分**情况）
 *   只盯其中一种就会漏 —— 实测 `\1` 那种 KaTeX 既不抛、也不给 katex-error，
 *   而是静默渲染出一个错的结果，属于最难发现的一类。 */
const parseFailures = [];
const origRenderToString = katex.renderToString;
katex.renderToString = function (tex, opts) {
  try {
    const html = origRenderToString.call(this, tex, opts);
    if (typeof html === 'string' && html.includes('katex-error')) {
      parseFailures.push({ tex, display: !!opts?.displayMode, how: 'katex-error span' });
    }
    return html;
  } catch (e) {
    parseFailures.push({ tex, display: !!opts?.displayMode, how: `throw: ${e?.message || ''}` });
    throw e;   // 原样抛回去，让产品自己的 catch 去降级
  }
};

/* ============================================================
   3. 收集所有会被渲染的文本（读种子 JSON，不读本地 app.db）
   ============================================================ */
section('3. 收集所有会被渲染的文本');
const questions = JSON.parse(fs.readFileSync(path.join(REPO, 'server/src/data/questions.json'), 'utf8'));
const knowledge = JSON.parse(fs.readFileSync(path.join(REPO, 'server/src/data/knowledge.json'), 'utf8'));

const fields = [];
for (const q of questions) {
  fields.push([`${q.id}.stem`, q.stem, 'rich']);
  fields.push([`${q.id}.analysis`, q.analysis, 'rich']);
  let opts = [];
  try { opts = JSON.parse(q.options || '[]'); } catch { /* 没选项的题 */ }
  opts.forEach((o, i) => fields.push([`${q.id}.option[${i}]`, o.t, 'inline']));
}
for (const k of knowledge) {
  fields.push([`${k.id}.title`, k.title, 'rich']);
  fields.push([`${k.id}.content`, k.content, 'rich']);
  fields.push([`${k.id}.example`, k.example, 'rich']);
}

/* ★ 这里**不写死条数**。原先写的是 `=== 204`，题库一加题（补四种新题型那次
 *   就加到了 248）它就变成一条假失败，而它本来想守的是「题目没丢、全扫到了」。
 *   改成下限 + 打出实际值：题目只会越补越多，不该每次补题都来改测试。 */
ok(`题目全在（≥ 204 道）`, questions.length >= 204, `实际 ${questions.length}`);
ok('知识点 68 条全在', knowledge.length === 68, `实际 ${knowledge.length}`);
ok('确实扫到了内容（不是空跑）',
  fields.some(([, v]) => String(v || '').includes('\\')),
  '至少有一条含 LaTeX');

/* ============================================================
   4. 跑全量
   ============================================================ */
section('4. 全量渲染并检查');
const leaks = [];
const errLeaks = [];
let rendered = 0;
let scanned = 0;

for (const [label, raw, mode] of fields) {
  const src = String(raw ?? '');
  if (!src) continue;
  scanned++;

  const before = parseFailures.length;
  /* 题干/选项走 inline（与页面一致），解析与正文走 rich */
  const html = mode === 'inline' ? inlinePipeline(src) : renderRich(src);

  if (/class="katex"/.test(html)) rendered++;

  for (let k = before; k < parseFailures.length; k++) {
    errLeaks.push({ label, ...parseFailures[k] });
  }
  const leaked = leakedCommands(html);
  if (leaked.length) {
    leaks.push({ label, leaked: [...new Set(leaked)], src: src.slice(0, 160) });
  }
}

ok(`扫了 ${scanned} 段文本`, scanned > 300, `实际 ${scanned}`);
ok('★ KaTeX 解析失败 = 0（解析失败会把源码原样吐到屏幕上）',
  errLeaks.length === 0,
  errLeaks.slice(0, 6).map((e) => `${e.label} [${e.how}]: ${JSON.stringify(e.tex).slice(0, 80)}`).join(' | '));
ok('★ 裸命令漏屏 = 0',
  leaks.length === 0,
  leaks.slice(0, 6).map((l) => `${l.label}: ${l.leaked.join(' ')} ← ${JSON.stringify(l.src)}`).join(' | '));

/* 正向对照：不能因为「什么都没渲染」而白绿。
   两个检查在「renderRich 直接返回原文」时都会通过 —— 必须另有一条证明真的渲染了。 */
ok('★ 正向对照：确实渲染出了公式（不是空跑白绿）',
  rendered > 400,
  `有公式的字段 ${rendered} / ${scanned}`);

/* ============================================================
   5. 回归锚点：这几个形态各自修过一个真 bug，钉住它们
   ============================================================ */
section('5. 回归锚点（每个都对应一个修过的真 bug）');
{
  const cases = [
    ['填空横线 ______ 不是下标',
      '\\lim_{x \\to 0} \\frac{\\sin 5x}{x} = ______'],
    ['矩阵环境不能被 \\frac 吞掉（在 & 处断裂）',
      'A^{-1} = \\frac{1}{-2}\\begin{bmatrix} 4 & -2 \\\\ -3 & 1 \\end{bmatrix}'],
    ['花括号组要整体跳过（组内空格不能断）',
      '通解 y = e^{\\alpha x}(C_1\\cos\\beta x + C_2\\sin\\beta x)。'],
    ['孤立 | 不能跨中文找配对',
      '解的特征方程是 |\\lambda E - ______| = 0。'],
    ['\\, 这类符号命令不能原样漏出去',
      'f_X(x) = \\int_{-\\infty}^{+\\infty} ______ \\, dy。'],
    /* ★ 转义花括号必须能**起头**，不能等后面的 \command 才起步。
     *   不认 \{ 的话，`\{X\le x_1\}` 会被切成 `\le x_1\` ——
     *   末尾一个孤立反斜杠，KaTeX 报 Unexpected character '\'，源码漏屏。
     *   概率论里「事件用花括号包起来」的写法遍地都是（实测题 q247 的解析）。 */
    ['\\{ \\} 转义花括号要能起头（不能从中间截断）',
      'F(x_1)\\le F(x_2) 说的是 \\{X\\le x_1\\}\\subseteq\\{X\\le x_2\\}。'],
  ];
  for (const [name, src] of cases) {
    const html = renderRich(src);
    const bad = leakedCommands(html);
    ok(name, bad.length === 0 && !hasKatexError(html),
      bad.length ? `漏出 ${JSON.stringify(bad)}` : 'KaTeX 解析失败');
  }
}

/* ============================================================
   6. 反向对照：KaTeX 的两种失败形态，检测器都要能发现
   ============================================================ */
section('6. 反向对照：两种失败形态都要能被发现');
{
  /* ★ 这段是踩坑记录，不是装饰。
   *   KaTeX 容错模式（throwOnError:false）**不止一种失败形态**：
   *     · 未闭合花括号 `\frac{1}{`
   *         → 返回一个 class="katex-error" 的 span，源码直接显示出来
   *     · 坏的行分隔符 `\begin{pmatrix}1&1\1&1\end{pmatrix}`
   *         → **既不抛异常、也不给 katex-error**，静默渲染出一个错的矩阵
   *           （实测 2×2 变成 1×3，后面的数字被吞掉）
   *   只检查第一种的话，第二种能一直藏着 —— 题库里就真的有 3 处这种，
   *   而且已经藏了很久：页面不报错、构建通过、测试全绿、肉眼也未必看得出。
   *
   *   这就是产品把 throwOnError 改成 true 的理由：让失败一定走我们自己的
   *   降级路径，而不是交给 KaTeX 用两种方式中的某一种默默处理掉。 */
  const badParen = katex.renderToString('\\frac{1}{', { throwOnError: false, output: 'html' });
  ok('容错模式 · 未闭合花括号 → 吐 katex-error', hasKatexError(badParen) === true);
  ok('容错模式 · 且它的源码会被算作漏屏', leakedCommands(badParen).length > 0,
    JSON.stringify(leakedCommands(badParen)));

  const badRow = katex.renderToString('\\begin{pmatrix}1&1\\1&1\\end{pmatrix}', { throwOnError: false, output: 'html' });
  ok('★ 容错模式 · 坏行分隔符 → 既不报错也不给 katex-error（静默给错结果）',
    !hasKatexError(badRow) === true, '这条正是「测试全绿但渲染是错的」的来源');

  let threw = false;
  try {
    katex.renderToString('\\begin{pmatrix}1&1\\1&1\\end{pmatrix}', { throwOnError: true });
  } catch { threw = true; }
  ok('★ 严格模式（产品现在用的）能把它抛出来', threw === true);
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + '─'.repeat(46));
if (fail) {
  console.log(`\x1b[31m❌ 渲染管线漏屏检查：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
  console.log(`\n解析失败 ${errLeaks.length} 处，漏屏 ${leaks.length} 处。`);
  process.exit(1);
} else {
  console.log(`\x1b[32m✅ 渲染管线漏屏检查：${pass} 项全部通过（${scanned} 段文本，${rendered} 段渲染出公式）\x1b[0m`);
  process.exit(0);
}
