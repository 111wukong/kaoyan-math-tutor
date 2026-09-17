/* LaTeX 包裹全量检查（不需要浏览器、不需要起服务，纯静态）
 *
 * 为什么需要它：
 *   浏览器套件里那条「题干/选项的公式已渲染」是**随机抽 5 题**去查的
 *   —— 每日一练每次抽的题不一样，于是同一份代码可能本机绿、CI 红。
 *   实测就是这么挂的：CI 抽到了 q01（题干带 \lim），本机没抽到。
 *   全量扫一遍是确定性的，204 道题一个不漏，而且比开浏览器快得多。
 *
 * 做法：从 web/src/components/ui/Math.tsx 里**抽出真实的 autoLatex 源码**，
 *       不手抄。手抄一份必然和产品漂移 —— 那就等于测了个假的。
 *
 * 两条不变量：
 *   1. 去掉所有 $...$ 之后，不应残留任何 \command（那就是漏到屏幕上的裸 LaTeX）
 *   2. autoLatex 只应该「插入 $」，绝不能增删任何字符
 *      （违反它 = 内容被静默吃掉，或片段被切成 `$\$` 这种残渣）
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

/* ---------------- 1. 抽出真实的 autoLatex ----------------
 * 抽取逻辑统一放在 tests/lib/extract-pipeline.mjs，由它调 tsc 转译。
 * 这里以前自己用正则剥 TS 类型标注，踩过两次：
 *   · 按花括号配对找函数结尾 → 被 '\\begin{' 里的 { 骗到，把下一个函数也吞进来
 *   · 类型正则只覆盖 `(s: string)`，漏了 `(a: number, b: number)`
 * 换成真编译器之后这两类问题都不会再有。 */
section('1. 从产品源码里抽 autoLatex');
let autoLatex = null;
try {
  const core = await import(buildCore());
  autoLatex = core.autoLatex;
} catch (e) {
  ok('autoLatex 能在 Node 里跑起来', false, e.message);
}
ok('autoLatex 能在 Node 里跑起来', typeof autoLatex === 'function');
if (typeof autoLatex !== 'function') {
  console.log(`\n\x1b[31m❌ LaTeX 全量检查：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}

/* ---------------- 2. 收集所有会被渲染的文本 ---------------- */
section('2. 收集所有会被渲染的文本');
const questions = JSON.parse(fs.readFileSync(path.join(REPO, 'server/src/data/questions.json'), 'utf8'));
const knowledge = JSON.parse(fs.readFileSync(path.join(REPO, 'server/src/data/knowledge.json'), 'utf8'));

const qFields = [];
for (const q of questions) {
  qFields.push([`${q.id}.stem`, q.stem]);
  qFields.push([`${q.id}.analysis`, q.analysis]);
  let opts = [];
  try { opts = JSON.parse(q.options || '[]'); } catch { /* 没选项的题 */ }
  opts.forEach((o, i) => qFields.push([`${q.id}.option[${i}]`, o.t]));
}
const kFields = [];
for (const k of knowledge) {
  kFields.push([`${k.id}.title`, k.title]);
  kFields.push([`${k.id}.content`, k.content]);
  kFields.push([`${k.id}.example`, k.example]);
}

ok('题库字段数 > 200', qFields.length > 200, `${qFields.length} 个字段`);
ok('知识点字段数 > 100', kFields.length > 100, `${kFields.length} 个字段`);
ok('确实扫到了内容（不是空跑）',
  qFields.some(([, v]) => String(v || '').includes('\\')) && kFields.some(([, v]) => String(v || '').includes('\\')),
  '至少各有一条含 LaTeX');

/* ---------------- 3. 跑两条不变量 ---------------- */
/** 去掉 $...$ 之后还剩的 \command —— 那就是会漏到屏幕上的 */
function findResidue(wrapped) {
  const outside = String(wrapped).replace(/\$[^$\n]*\$/g, '');
  return outside.match(/\\[a-zA-Z]+/g) || [];
}
/** 去掉 $ 之后应与原文完全相同 */
function findMutation(src, wrapped) {
  return String(wrapped).replace(/\$/g, '') !== String(src);
}

function checkGroup(label, fields) {
  const residues = [];
  const mutations = [];
  for (const [id, val] of fields) {
    const src = String(val ?? '');
    if (!src) continue;
    const wrapped = autoLatex(src);

    const leftover = findResidue(wrapped);
    if (leftover.length) residues.push([id, [...new Set(leftover)].slice(0, 4).join(' '), src.slice(0, 70)]);

    if (findMutation(src, wrapped)) mutations.push([id, src.slice(0, 70), wrapped.replace(/\$/g, '').slice(0, 70)]);
  }
  ok(`${label} 无残留裸 LaTeX`, residues.length === 0,
    residues.slice(0, 4).map((r) => `${r[0]}: ${r[1]} ← ${JSON.stringify(r[2])}`).join(' | '));
  ok(`${label} 内容零增删（只插入了 $）`, mutations.length === 0,
    mutations.slice(0, 3).map((m) => `${m[0]}: ${JSON.stringify(m[1])} → ${JSON.stringify(m[2])}`).join(' | '));
  return residues.length + mutations.length;
}

section('3. 题干 / 选项 / 解析');
const qBad = checkGroup('题库', qFields);

section('4. 知识点正文 / 例题');
const kBad = checkGroup('知识点', kFields);

/* ---------------- 5. 防呆：确认这两个检测器真的会失败 ----------------
 * 一个永远为绿的检查比没有检查更糟 —— 它会让人以为有保护。
 * ★ 注意验的是「检测器」，不是 autoLatex：像 \unknowncmd 这种
 *   分支 1 本来就能正常包裹，拿它当反例会得到一个假的红。 */
section('5. 自检：两个检测器真的会报警吗');
{
  ok('残留检测：对没包裹的裸 LaTeX 报警',
    findResidue('结果是 \\frac{1}{2} 这样').length > 0,
    JSON.stringify(findResidue('结果是 \\frac{1}{2} 这样')));
  ok('残留检测：对已包裹的不误报',
    findResidue('结果是 $\\frac{1}{2}$ 这样').length === 0);
  ok('残留检测：能抓到被切断的残渣（本次修的那个 bug 的形态）',
    findResidue('[(1 + $\\$\\frac{1}{x}$').length > 0,
    JSON.stringify(findResidue('[(1 + $\\$\\frac{1}{x}$')));

  ok('内容检测：对少字符的报警', findMutation('abcdef', 'ab$cd$f') === true);
  ok('内容检测：对只插 $ 的不误报', findMutation('abcdef', 'ab$cd$ef') === false);
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + '─'.repeat(46));
if (fail) {
  console.log(`\x1b[31m❌ LaTeX 全量检查：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
  console.log(`\n共发现 ${qBad + kBad} 处问题。`);
  process.exit(1);
} else {
  console.log(`\x1b[32m✅ LaTeX 全量检查：${pass} 项全部通过\x1b[0m`);
  process.exit(0);
}
