/* 公式库：数据完整性 + 真 KaTeX 渲染检查
 *
 * ── 为什么这个套件是必须的 ────────────────────────────────────────
 * 公式库和题库不一样：题库错了会被「答对判成错」抓出来，
 * 公式库错了**没有任何反馈**。一条 \operatorname{arccot} 拼错、
 * 一个大括号没闭合，页面照常渲染、构建照常通过、测试照常全绿 ——
 * 只是那一条变成了：
 *
 *   <code class="...">\operatorname{arccot} x</code>
 *
 * 也就是把 LaTeX 源码原样当纯文本显示出来（renderTex 的降级路径，
 * 见 Math.tsx 的 catch 分支）。用户看到的是一串反斜杠，
 * 而**没有人会为它报错**。
 *
 * 所以这里对**每一条**公式跑一次真 katex。判据直接照产品的行为定：
 * 渲染成功 = 输出里有 katex 子树；失败 = 走了 <code> 降级路径。
 *
 * ── 为什么不用 autoLatex 那两条不变量就够了 ───────────────────────
 * tests/latex-coverage.mjs 验的是「$ 包得对不对」，pipeline-leak.mjs 验的是
 * 「整条管线漏不漏源码」。两者都**不验公式本身写得对不对** ——
 * 一个写错的公式照样能被正确包裹、也照样不漏源码，它只是渲染不出来。
 * 这是第三层，必须单独有。
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
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

const read = (f) => JSON.parse(fs.readFileSync(path.join(REPO, 'server/src/data', f), 'utf8'));
const formulas = read('formulas.json');
const knowledge = read('knowledge.json');
const chapters = read('chapters.json');
const categories = read('categories.json');

/* ============================================================
   1. 数据完整性
   ============================================================ */
section('1. 数据完整性');
{
  ok('公式库不是空的', formulas.length > 0, `${formulas.length} 条`);

  const ids = formulas.map((f) => f.id);
  ok('id 唯一', new Set(ids).size === ids.length,
    `重复 ${ids.length - new Set(ids).size} 个`);

  const kIds = new Set(knowledge.map((k) => k.id));
  const chIds = new Set(chapters.map((c) => c.id));

  const badKid = formulas.filter((f) => f.kid && !kIds.has(f.kid)).map((f) => `${f.id}→${f.kid}`);
  ok('★ 每条公式挂的考点都真实存在', badKid.length === 0, badKid.slice(0, 5).join(' '));

  const badCh = formulas.filter((f) => !chIds.has(f.chapterId)).map((f) => `${f.id}→${f.chapterId}`);
  ok('每条公式的章节都真实存在', badCh.length === 0, badCh.slice(0, 5).join(' '));

  /* 考点必须属于它声明的那个章节 —— 不然「按章筛选」会把公式放到别的章里去。
   * 这类错**肉眼看不出来**（两边都是合法 id），只有对账才发现。 */
  const kidChapter = new Map(knowledge.map((k) => [k.id, k.chapterId]));
  const mismatch = formulas
    .filter((f) => f.kid && kidChapter.get(f.kid) !== f.chapterId)
    .map((f) => `${f.id}: 挂 ${f.kid}（属 ${kidChapter.get(f.kid)}）却写在 ${f.chapterId}`);
  ok('★ 考点与章节对得上（防「公式跑到别的章」）', mismatch.length === 0, mismatch.slice(0, 3).join(' | '));

  const noTex = formulas.filter((f) => !String(f.tex || '').trim());
  ok('每条都有 LaTeX 正文', noTex.length === 0, noTex.map((f) => f.id).join(' '));

  const badMust = formulas.filter((f) => f.must !== 0 && f.must !== 1);
  ok('must 只能是 0 / 1', badMust.length === 0, badMust.map((f) => f.id).join(' '));

  /* 必背比例要在合理区间。全是必背 = 等于没标；全是了解 = 这个库没用。
   * 上下限是「提醒」不是「硬规定」—— 真调整内容时改这两个数是有意的动作。 */
  const mustRatio = formulas.filter((f) => f.must === 1).length / formulas.length;
  ok('必背比例落在合理区间（30%~95%）', mustRatio > 0.3 && mustRatio < 0.95,
    `${Math.round(mustRatio * 100)}%`);

  /* 条件字段：这是这个库和「网上随便一份公式表」的区别所在。
   * 考研丢分恰好丢在「这个公式什么时候不能用」。 */
  const withCond = formulas.filter((f) => String(f.cond || '').trim()).length;
  ok('★ 带成立条件的公式占比 > 40%（条件是这个库的核心价值）',
    withCond / formulas.length > 0.4, `${withCond}/${formulas.length} 条带条件`);
}

/* ============================================================
   2. 覆盖度
   ============================================================ */
section('2. 覆盖度');
{
  const byChapter = new Map();
  formulas.forEach((f) => byChapter.set(f.chapterId, (byChapter.get(f.chapterId) || 0) + 1));

  const thin = chapters.filter((c) => (byChapter.get(c.id) || 0) < 4);
  ok('★ 每一章至少有 4 条公式（不许有空白章节）', thin.length === 0,
    thin.map((c) => `${c.name}:${byChapter.get(c.id) || 0}`).join(' '));

  const covered = new Set(formulas.filter((f) => f.kid).map((f) => f.kid));
  const ratio = covered.size / knowledge.length;
  ok('★ 考点覆盖率 > 90%', ratio > 0.9,
    `${covered.size}/${knowledge.length} = ${Math.round(ratio * 100)}%`);

  const byCat = new Map();
  for (const c of categories) byCat.set(c.id, 0);
  const chCat = new Map(chapters.map((c) => [c.id, c.categoryId]));
  formulas.forEach((f) => {
    const cat = chCat.get(f.chapterId);
    if (cat) byCat.set(cat, (byCat.get(cat) || 0) + 1);
  });
  const emptyCat = [...byCat.entries()].filter(([, n]) => n === 0);
  ok('三个科目都有公式', emptyCat.length === 0, emptyCat.map(([c]) => c).join(' '));

  const groups = new Set(formulas.map((f) => `${f.chapterId}|${f.group}`));
  ok('按「表」分组（不是一长串散条目）', groups.size >= 30, `${groups.size} 个分组`);
}

/* ============================================================
   3. ★ 每条公式都必须被真 KaTeX 渲染成功
   ============================================================ */
section('3. 真 KaTeX 渲染（这一节是核心）');

/* katex 必须在**导入管线之前**注入 —— 抽取出来的核心把 katex 声明成全局，
 * 运行时才去读。顺序反了就拿到 undefined。 */
const katex = (await import(path.join(REPO, 'node_modules', 'katex', 'dist', 'katex.mjs'))).default;
globalThis.katex = katex;

let core = null;
try { core = await import(buildCore()); } catch (e) {
  ok('渲染管线能在 Node 里跑起来', false, e.message);
}
ok('渲染管线能在 Node 里跑起来', !!(core && typeof core.renderTex === 'function'));
if (!core || typeof core.renderTex !== 'function') {
  console.log(`\n\x1b[31m❌ 公式库：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
const { renderTex, renderRich } = core;

/** 渲染成功 = 输出里出现了 katex 子树。
 *  失败时 renderTex 走的是 <code> 降级路径（把源码当纯文本显示），
 *  所以「没有 katex 子树」就是失败 —— 判据和产品行为完全一致。 */
function rendersOk(tex) {
  const html = String(renderTex(tex, true) || '');
  return html.includes('katex');
}

{
  const broken = [];
  for (const f of formulas) {
    if (!rendersOk(f.tex)) broken.push(f);
  }
  ok('★ 全部公式都能被 KaTeX 渲染（失败=屏幕上出现 LaTeX 源码）',
    broken.length === 0,
    broken.slice(0, 6).map((f) => `${f.id} ${JSON.stringify(f.tex).slice(0, 46)}`).join(' | '));
  if (broken.length) console.log(`     \x1b[33m共 ${broken.length} 条渲染失败\x1b[0m`);

  /* 条件字段也会被渲染（界面上就显示在公式下面），一样要能解析。
   * 单独测是因为它的写法更自由（中文 + 数学混排），最容易写坏。 */
  const badCond = formulas.filter((f) => String(f.cond || '').trim() && !rendersOk(f.cond));
  ok('★ 全部「成立条件」也能被渲染', badCond.length === 0,
    badCond.slice(0, 5).map((f) => `${f.id} ${JSON.stringify(f.cond)}`).join(' | '));

  /* 走完整管线（autoLatex + 行内/块级切分）再验一次。
   * 公式单独能渲染 ≠ 塞进整条管线还能渲染 —— 两者之间还有一层切分逻辑。 */
  const pipelineBad = [];
  for (const f of formulas) {
    const html = String(renderRich(`$$${f.tex}$$`) || '');
    if (!html.includes('katex')) pipelineBad.push(f.id);
  }
  ok('★ 走完整 renderRich 也都能渲染', pipelineBad.length === 0,
    pipelineBad.slice(0, 5).join(' '));
}

/* ============================================================
   4. 自检：上面这些检测器真的会报警吗
   ============================================================
   一个永远为绿的检查比没有检查更糟 —— 它会让人以为有保护。 */
section('4. 自检：检测器真的会失败吗');
{
  ok('对写坏的公式会报警（未闭合大括号）',
    rendersOk('\\frac{1}{2') === false);
  ok('对写坏的公式会报警（不存在的命令）',
    rendersOk('\\notacommand{x}') === false);
  ok('对正常公式不误报',
    rendersOk('\\frac{1}{2}') === true);
  ok('对中文混排的条件不误报',
    rendersOk('x\\to 0,\\ a>0') === true);
}

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ 公式库：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 公式库：${pass} 项\x1b[0m`);
