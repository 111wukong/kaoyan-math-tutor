/* 题型与判题器：六种题型的判分口径 + 题库数据完整性
 *
 * ── 为什么必须有这个套件 ──────────────────────────────────────────
 * 判题器的失效方式是**静默判错**：用户答对了、屏幕上出现红叉，
 * 页面不报错、构建通过、截图也看不出。上一版只有 choice / blank 两种题型，
 * 判分逻辑短到一眼能看完；补上多选 / 判断 / 解答 / 证明之后，
 * 每种都多出一层归一化（字母去重排序、真假词表、自评放行），
 * 靠眼睛看已经守不住了。
 *
 * 这里钉住三类事：
 *   1. 归一化 —— 各种输入写法要能收敛到同一个答案（用户不该为输入法买单）
 *   2. ★ 权限边界 —— selfCorrect 只能对解答/证明题生效。
 *      漏了这一条，任何人都能对单选题宣称「我答对了」，XP 和掌握度立刻失真。
 *   3. 数据 —— 题库里每种题型的答案形态合法（否则用户答对也会被判错）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judge, canonicalAnswer, answerIssue, parseSteps, publicQuestion,
  QUESTION_TYPES, SELF_GRADED_TYPES, TYPE_LABEL,
} from '../server/src/lib/judge.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(REPO, 'server/src/data', f), 'utf8'));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

const questions = read('questions.json');
const knowledge = read('knowledge.json');

/* ============================================================
   1. 单选题 / 填空题（原有口径不能回归）
   ============================================================ */
section('1. 单选 / 填空：原有口径不能回归');
{
  const c = { type: 'choice', answer: 'A' };
  ok('单选：字母相同判对', judge(c, 'A') === true);
  ok('单选：小写也算对', judge(c, 'a') === true);
  ok('单选：全角 Ａ 也算对（输入法不该让人吃红叉）', judge(c, 'Ａ') === true);
  ok('单选：选错判错', judge(c, 'B') === false);
  ok('单选：多选了也判错', judge(c, 'AB') === false);

  const b = { type: 'blank', answer: '1/2' };
  ok('填空：1/2 与 0.5 等价', judge(b, '0.5') === true);
  ok('填空：全角 １／２ 等价', judge(b, '１／２') === true);
  ok('填空：答错判错', judge(b, '2/3') === false);
}

/* ============================================================
   2. 多选题
   ============================================================ */
section('2. 多选题');
{
  const m = { type: 'multi', answer: 'ACD' };
  ok('多选：顺序无关（CA D 也算对）', judge(m, 'CAD') === true);
  ok('多选：带分隔符也算对', judge(m, 'A,C,D') === true);
  ok('多选：小写也算对', judge(m, 'acd') === true);
  ok('多选：漏选一个判错', judge(m, 'AC') === false);
  ok('多选：多选一个判错', judge(m, 'ABCD') === false);
  ok('多选：空答案判错', judge(m, '') === false);

  /* 归一化必须是**去重 + 排序**，否则「CA」和「AC」会被判成不同答案 */
  ok('多选：canonicalAnswer 去重排序', canonicalAnswer('multi', 'c a a') === 'AC');
  ok('多选：写入时也走同一套归一化（否则标准答案自己判不过自己）',
    canonicalAnswer('multi', 'D、A、C') === 'ACD');
}

/* ============================================================
   3. 判断题
   ============================================================ */
section('3. 判断题');
{
  const t = { type: 'judge', answer: 'T' };
  const f = { type: 'judge', answer: 'F' };
  ok('判断：T / 对 / 正确 / √ 都算对', ['T', 't', '对', '正确', '√', '是'].every((x) => judge(t, x) === true));
  ok('判断：F / 错 / × / 否 都算错', ['F', 'f', '错', '错误', '×', '否'].every((x) => judge(t, x) === false));
  ok('判断：答「错」时 F 题判对', judge(f, '错') === true);
  ok('判断：带理由的作答看首字（「对，因为…」）', judge(t, '对，因为 f 在 [0,1] 连续') === true);
  ok('判断：无法识别的内容判错（不能默认给分）', judge(t, '不知道') === false);
  ok('判断：空答案判错', judge(t, '') === false);
}

/* ============================================================
   4. ★ 解答 / 证明题：不自动判分，只认自评
   ============================================================ */
section('4. ★ 解答 / 证明题（这一节是核心）');
{
  const s = { type: 'solve', answer: '\\frac{1}{2}' };
  ok('解答：没给自评结果时返回 false（表示「还没判」）', judge(s, '\\frac{1}{2}') === false);
  ok('解答：用户自评「对」才判对', judge(s, '随便写点什么', true) === true);
  ok('解答：用户自评「错」判错', judge(s, '随便写点什么', false) === false);
  ok('解答：即使写的内容和参考答案一模一样，没自评也不算对',
    judge(s, '\\frac{1}{2}', undefined) === false);

  /* ★★ 权限边界。这三条是**安全断言**，不是功能断言。
   *    漏掉的话，客户端传一个 selfCorrect:true 就能把任何题刷成答对。 */
  ok('★ 权限边界：单选题不接受 selfCorrect 放行',
    judge({ type: 'choice', answer: 'A' }, 'B', true) === false);
  ok('★ 权限边界：多选题不接受 selfCorrect 放行',
    judge({ type: 'multi', answer: 'ACD' }, 'A', true) === false);
  ok('★ 权限边界：判断题不接受 selfCorrect 放行',
    judge({ type: 'judge', answer: 'T' }, 'F', true) === false);
  ok('★ 权限边界：填空题不接受 selfCorrect 放行',
    judge({ type: 'blank', answer: '1/2' }, '9', true) === false);
}

/* ============================================================
   5. 录题校验（answerIssue）：判不了的答案要拦在入口
   ============================================================ */
section('5. 录题校验');
{
  ok('单选：非字母被拒', !!answerIssue('choice', 'X1'));
  ok('单选：A 通过', answerIssue('choice', 'A') === null);

  ok('多选：只选一个被拒（那是单选）', !!answerIssue('multi', 'A'));
  ok('多选：重复字母被拒', !!answerIssue('multi', 'AAC'));
  ok('多选：ACD 通过', answerIssue('multi', 'ACD') === null);

  ok('判断：乱写被拒', !!answerIssue('judge', '也许'));
  ok('判断：T 通过', answerIssue('judge', 'T') === null);
  ok('判断：对 通过（会归一化成 T）', answerIssue('judge', '对') === null);

  /* 解答题不该被「必须是数值」那条规则误伤 —— 它的答案是过程，不是值 */
  ok('★ 解答：含根号的参考答案不该被拒（它不自动判分）',
    answerIssue('solve', '\\sqrt{2}-1') === null);
  ok('解答：空答案被拒', !!answerIssue('solve', ''));
  ok('解答：一个字太短被拒', !!answerIssue('solve', '略'));

  /* 反过来，填空题仍然必须卡住非数值 —— 这条是老口径 */
  ok('填空：含根号被拒（会「答对判错」）', !!answerIssue('blank', '\\sqrt{2}'));
  ok('填空：0.5 通过', answerIssue('blank', '0.5') === null);
}

/* ============================================================
   6. 题库数据完整性
   ============================================================ */
section('6. 题库数据');
{
  const kids = new Set(knowledge.map((k) => k.id));
  const byType = {};
  questions.forEach((q) => { byType[q.type] = (byType[q.type] || 0) + 1; });

  ok('题型都在白名单里',
    questions.every((q) => QUESTION_TYPES.includes(q.type)),
    [...new Set(questions.filter((q) => !QUESTION_TYPES.includes(q.type)).map((q) => q.type))].join(' '));

  /* 四种新题型都要真的**有题**。只加代码不加题，界面上就是空的 ——
   * 「支持多选题」这句话只有在题库里有多选题时才是真的。 */
  for (const t of ['multi', 'judge', 'solve', 'proof']) {
    ok(`题库里有 ${TYPE_LABEL[t]}题（${byType[t] || 0} 道）`, (byType[t] || 0) >= 8);
  }

  ok('每种题型都挂了真实考点',
    questions.every((q) => kids.has(q.kid)),
    questions.filter((q) => !kids.has(q.kid)).map((q) => q.id).join(' '));

  /* ★ 最关键的一条：**库里每一道题，拿它自己的答案去判，必须判对**。
   *   判不过自己的话，用户答对也会吃红叉，而且没有任何反馈。 */
  const selfFail = questions.filter((q) => {
    if (SELF_GRADED_TYPES.has(q.type)) return judge(q, q.answer, true) !== true;
    return judge(q, q.answer) !== true;
  });
  ok('★ 每道题用自己的答案都能判对（否则用户答对也会被判错）',
    selfFail.length === 0,
    selfFail.slice(0, 5).map((q) => `${q.id}(${q.type}) ans=${JSON.stringify(q.answer)}`).join(' | '));

  /* 选项型题：答案字母必须真的在选项里，且标号连续 */
  const badOpts = [];
  for (const q of questions) {
    if (q.type !== 'multi' && q.type !== 'choice' && q.type !== 'judge') continue;
    if (!q.options) { badOpts.push(`${q.id} 没有选项`); continue; }
    const keys = JSON.parse(q.options).map((o) => o.k);
    if (q.type === 'multi') {
      const want = 'ABCDEF'.slice(0, keys.length);
      if (keys.join('') !== want) badOpts.push(`${q.id} 标号不连续: ${keys.join('')}`);
      if (q.answer.split('').some((k) => !keys.includes(k))) badOpts.push(`${q.id} 答案 ${q.answer} 超出选项范围`);
    }
    if (q.type === 'judge' && keys.join('') !== 'TF') badOpts.push(`${q.id} 判断题选项应为 T/F`);
  }
  ok('选项型题目的选项标号与答案自洽', badOpts.length === 0, badOpts.slice(0, 5).join(' | '));

  /* 解答/证明题必须有评分点，否则「分步给分」无从谈起 */
  const noSteps = questions.filter((q) => SELF_GRADED_TYPES.has(q.type) && !(q.steps || []).length);
  ok('★ 解答 / 证明题都带评分点', noSteps.length === 0, noSteps.map((q) => q.id).join(' '));

  const badPts = questions
    .filter((q) => SELF_GRADED_TYPES.has(q.type))
    .filter((q) => (q.steps || []).some((s) => !s.t || !(s.pts > 0)));
  ok('评分点每条都有内容且分值大于 0', badPts.length === 0, badPts.map((q) => q.id).join(' '));

  /* 题库里不许出现 $ —— 库里的数据一律是裸 LaTeX，$ 由渲染管线补。
   * 混进来一个 $ 会让 autoLatex 二次包裹，屏幕上出现一对美元符号。 */
  const withDollar = questions.filter((q) =>
    [q.stem, q.answer, q.analysis].some((v) => String(v || '').includes('$')));
  ok('题库里不出现 $（数据用裸 LaTeX）', withDollar.length === 0,
    withDollar.slice(0, 5).map((q) => q.id).join(' '));
}

/* ============================================================
   7. 对外暴露（publicQuestion）
   ============================================================ */
section('7. 对外暴露');
{
  const solve = questions.find((q) => q.type === 'solve');
  const pub = publicQuestion(solve, { withAnswer: false });
  ok('不传 withAnswer 时**不泄露**答案与评分点',
    pub.answer === undefined && pub.steps === undefined);
  ok('但会告诉前端「这题要自评」', pub.selfGraded === true);
  ok('带题型中文名（前端不再自己维护映射）', pub.typeLabel === '解答');

  const full = publicQuestion(solve, { withAnswer: true });
  ok('withAnswer 时评分点能解析成数组', Array.isArray(full.steps) && full.steps.length > 0);
  ok('parseSteps 对坏 JSON 返回 null 而不是抛异常', parseSteps({ steps: '{坏' }) === null);

  const choice = publicQuestion(questions.find((q) => q.type === 'choice'), { withAnswer: true });
  ok('单选题 selfGraded 为 false', choice.selfGraded === false);
}

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ 题型与判题器：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 题型与判题器：${pass} 项\x1b[0m`);
