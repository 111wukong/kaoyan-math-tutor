/* 一次性数据修复：题库里矩阵环境的「行分隔符」写成了单个反斜杠。
 *
 * 背景：
 *   LaTeX 里矩阵换行是 `\\`（两个反斜杠）。种子文件里有 3 处写成了一个，
 *   于是解析出来是 `\begin{pmatrix}1&1\1&1\end{pmatrix}` —— `\1` 不是合法命令。
 *
 *   为什么以前没人发现：renderTex 当时用的是 throwOnError:false，
 *   KaTeX **既不抛异常、也不吐 katex-error 标记**，而是**静默渲染出一个错的矩阵**
 *   （实测 2×2 变成了 1×3，数字还被吞掉）。页面不报错、测试全绿、肉眼也不一定看出来。
 *   改成 throwOnError:true 之后它才浮出来。
 *
 * 修法：在 `\begin{env}...\end{env}` 内部，凡是「反斜杠串后面不是字母」的，
 *       就是行分隔符 —— 长度必须是偶数对（2 个）。不足就补齐。
 *
 * 跑法：node server/scripts/fix-matrix-rows.mjs          （干跑，只报告）
 *       node server/scripts/fix-matrix-rows.mjs --apply  （真写）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '..', 'src', 'data');
const APPLY = process.argv.includes('--apply');

const ENV_RE = /\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\}/g;

/** 把环境块里的坏行分隔符补齐成 `\\` */
function fixEnvRows(s) {
  return s.replace(ENV_RE, (env) =>
    env.replace(/\\+/g, (run, off) => {
      const after = env[off + run.length];
      /* 后面是字母 → 这是 \command 的起头，不能动。
       * （所以「\ 后面直接跟字母」的坏行分隔符识别不出来 —— 但那种写法
       *   本来就和命令无法区分，只能靠人看。本脚本不猜。） */
      if (after && /[a-zA-Z]/.test(after)) return run;
      return run.length >= 2 && run.length % 2 === 0 ? run : run + '\\';
    }),
  );
}

const hits = [];
function fixStr(s, where) {
  const out = fixEnvRows(s);
  if (out !== s) hits.push({ where, before: s, after: out });
  return out;
}

const file = path.join(DATA, 'questions.json');
const raw = fs.readFileSync(file, 'utf8');
const questions = JSON.parse(raw);

for (const q of questions) {
  q.stem = fixStr(q.stem, `${q.id}.stem`);
  q.analysis = fixStr(q.analysis, `${q.id}.analysis`);
  /* options 是「JSON 字符串」——要解一层再修，再编回去 */
  if (typeof q.options === 'string' && q.options.trim()) {
    let opts = null;
    try { opts = JSON.parse(q.options); } catch { opts = null; }
    if (Array.isArray(opts)) {
      let changed = false;
      for (const o of opts) {
        if (typeof o?.t === 'string') {
          const fixed = fixEnvRows(o.t);
          if (fixed !== o.t) {
            hits.push({ where: `${q.id}.options[${o.k}].t`, before: o.t, after: fixed });
            o.t = fixed;
            changed = true;
          }
        }
      }
      if (changed) q.options = JSON.stringify(opts);
    }
  }
}

console.log(`\n发现 ${hits.length} 处坏行分隔符：\n`);
for (const h of hits) {
  console.log(`  ${h.where}`);
  console.log(`    修前 ${JSON.stringify(h.before.slice(0, 90))}`);
  console.log(`    修后 ${JSON.stringify(h.after.slice(0, 90))}`);
}

if (!hits.length) {
  console.log('  （没有需要修的）\n');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n\x1b[33m这是干跑。确认无误后加 --apply 真写。\x1b[0m\n');
  process.exit(0);
}

/* 这个文件本来就是 JSON.stringify(data, null, 2) 的输出（无结尾换行），
   所以重新序列化不会产生额外 diff。写之前再核一遍这个前提。 */
const roundTrip = JSON.stringify(JSON.parse(raw), null, 2);
if (roundTrip !== raw) {
  console.error('\x1b[31m✗ 文件不是标准 JSON.stringify(data, null, 2) 输出 —— 重新序列化会产生大量无关 diff，已中止。\x1b[0m');
  process.exit(1);
}

const out = JSON.stringify(questions, null, 2);
fs.writeFileSync(file, out, 'utf8');
console.log(`\n\x1b[32m✅ 已写入 ${path.relative(process.cwd(), file)}（${hits.length} 处）\x1b[0m\n`);
