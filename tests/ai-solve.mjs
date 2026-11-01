/* 拍照解题：提示词构造 + 结果清洗
 *
 * ── 为什么这个套件必须有 ──────────────────────────────────────────
 * 拍照解题最危险的失效方式不是报错，是**解一道自己编的题**：
 * 图片糊了、字迹潦草、有遮挡，模型倾向于猜一个「看起来合理」的
 * 条件然后认真推导。用户拿到一份工整、完整、逻辑自洽的解答，
 * 而它解的压根不是照片上那道题 —— 页面不报错、接口 200、排版漂亮。
 * 这种错误没有任何信号指向它，只能靠断言把「不许猜」钉在提示词里。
 *
 * 第二个失效方式是**结构化输出坏掉**：多模态模型吐 JSON 比纯文本
 * 模型更容易截断，而且图片里的 $ 和反斜杠转义容易出错。
 * 这里守的是「坏了要降级成原文，不能把半截 JSON 当题干展示」。
 *
 * 这个文件是纯的（不引 db / fastify），所以能直接 import 做全量断言。
 */
import { buildSolvePrompt, sanitizeSolve, UNKNOWN } from '../server/src/lib/solve.js';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

/* ============================================================
   一、提示词
   ============================================================ */
section('提示词约束');

const prompt = buildSolvePrompt();

ok('要求只输出 JSON', /只输出 JSON/.test(prompt));
ok('给出完整字段清单', ['question', 'answer', 'approach', 'steps', 'points', 'pitfall', 'signal']
  .every((k) => prompt.includes(`"${k}"`)));

/* ★ 这条是整个功能的底线。提示词里删掉「不要猜测」的话，
 *   模型在模糊图片上的表现是编条件 —— 而且编得很像。
 *   所以断言它必须存在，而不是「建议存在」。 */
ok('明确禁止猜测题目条件', /绝对不要猜测或补全题目条件/.test(prompt));
ok('给出「看不清」的固定标记', prompt.includes(UNKNOWN));
ok('要求 LaTeX 写法', /LaTeX/.test(prompt) && /\$\.\.\.\$/.test(prompt));
ok('禁止空转连接词', /不要复述/.test(prompt));
ok('规定步骤数区间', /3~6 步/.test(prompt));

/* 反例：提示词里不该出现「尽量补全」「合理推测」这类会诱发幻觉的说法 */
ok('不含「猜测补全」类措辞', !/尽量(补全|推测)|合理推测|自行补全/.test(prompt));

/* ============================================================
   二、正常输出
   ============================================================ */
section('正常 JSON');

const good = JSON.stringify({
  question: '求 $\\lim_{x\\to 0}\\frac{\\sin 3x}{x}$',
  answer: '$3$',
  approach: '重要极限，凑出 $\\frac{\\sin u}{u}$ 的形式',
  steps: [
    { t: '把 $3x$ 看作整体', f: '\\lim_{u\\to 0}\\frac{\\sin u}{u}=1' },
    { t: '乘除配平', f: '\\frac{\\sin 3x}{x}=3\\cdot\\frac{\\sin 3x}{3x}' },
    { t: '代极限', f: '' },
  ],
  points: ['重要极限', '等价无穷小'],
  pitfall: '漏掉系数 3',
  signal: '看到 $\\sin kx / x$，先想凑 $kx$',
});

const s1 = sanitizeSolve(good);
ok('解析成功', !s1.degraded);
ok('题干保留', s1.question.includes('\\sin 3x'));
/* 答案是纯数字时剥掉 $（见下面「纯数字答案」一节） */
ok('答案保留（纯数字剥 $）', s1.answer === '3');
ok('思路保留', s1.approach.length > 0);
ok('步骤数正确', s1.steps.length === 3);
ok('步骤含说明与式子', s1.steps[0].t.length > 0 && s1.steps[0].f.length > 0);
ok('空式子被保留为空串（不是 undefined）', s1.steps[2].f === '');
ok('考点两条', s1.points.length === 2);
ok('易错点保留', s1.pitfall === '漏掉系数 3');
ok('判断信号保留', s1.signal.includes('先想凑'));

/* 已经解析好的对象也要能吃（调用方可能自己先 parse 过） */
const s2 = sanitizeSolve(JSON.parse(good));
ok('接受已解析对象', !s2.degraded && s2.steps.length === 3);

/* ============================================================
   三、脏输出
   ============================================================ */
section('脏输出容错');

const fenced = '```json\n' + good + '\n```';
ok('剥掉 markdown 围栏', !sanitizeSolve(fenced).degraded);

const chatted = '好的，我来解这道题：\n\n' + good + '\n\n希望有帮助！';
ok('前后有废话也能取到 JSON', !sanitizeSolve(chatted).degraded);

const trailing = good.replace(/\}$/, ',}');
ok('尾逗号能兜住', !sanitizeSolve(trailing).degraded);

/* ★ 解析不出来时必须降级，而且原文要留在 question 里 ——
 *   直接返回空对象的话，用户看到一片空白，以为是网络问题。 */
const plain = '这道题先求导，再代入 x=0，答案是 3。';
const s3 = sanitizeSolve(plain);
ok('纯文本标记为降级', s3.degraded === true);
ok('纯文本原文进 question', s3.question.includes('先求导'));
ok('降级时不编造步骤', s3.steps.length === 0);

/* 有 JSON 但没有 question —— 半截输出，同样按降级处理 */
const noQ = JSON.stringify({ answer: '3', steps: [{ t: 'a' }] });
const s4 = sanitizeSolve(noQ);
ok('缺 question 视为降级', s4.degraded === true);

ok('空输入不炸', sanitizeSolve('').degraded === true);
ok('null 不炸', sanitizeSolve(null).degraded === true);
ok('数字不炸', sanitizeSolve(123).degraded === true);

/* ============================================================
   四、越界数据
   ============================================================ */
section('越界收敛');

const wild = JSON.stringify({
  question: 'x'.repeat(9000),
  answer: 'y'.repeat(3000),
  approach: 'z'.repeat(1000),
  steps: Array.from({ length: 20 }, (_, i) => ({ t: `步骤${i}`, f: 'f'.repeat(1000) })),
  points: Array.from({ length: 20 }, (_, i) => `考点${i}`),
  pitfall: 'p'.repeat(1000),
  signal: 's'.repeat(1000),
});
const w = sanitizeSolve(wild);
ok('题干截断到 4000', w.question.length === 4000);
ok('答案截断到 1200', w.answer.length === 1200);
ok('思路截断到 300', w.approach.length === 300);
ok('步骤最多 8 步', w.steps.length === 8);
ok('单步式子截断到 600', w.steps[0].f.length === 600);
ok('考点最多 6 个', w.points.length === 6);
ok('易错点截断到 400', w.pitfall.length === 400);
ok('信号截断到 300', w.signal.length === 300);

/* 畸形字段类型 */
const messy = JSON.stringify({
  question: '题干',
  steps: 'not-an-array',
  points: { a: 1 },
  answer: null,
});
const m = sanitizeSolve(messy);
ok('steps 非数组 → 空数组', Array.isArray(m.steps) && m.steps.length === 0);
ok('points 非数组 → 空数组', Array.isArray(m.points) && m.points.length === 0);
ok('answer 为 null → 空串', m.answer === '');

/* 步骤里混着空对象和纯字符串 */
const mixed = JSON.stringify({
  question: '题干',
  steps: [{ t: '有效步骤' }, {}, { f: '只有式子' }, '裸字符串'],
});
const mx = sanitizeSolve(mixed);
ok('过滤完全空的步骤', mx.steps.every((x) => x.t || x.f));
ok('纯字符串步骤被收进 t', mx.steps.some((x) => x.t === '裸字符串'));
ok('只有式子的步骤保留', mx.steps.some((x) => x.f === '只有式子' && !x.t));

/* ---------- f 字段的 $ 兜底 ----------
 * 模型经常把式子写成裸 LaTeX（不带 $）。前端按 $ 切段渲染，
 * 不兜的话用户看到的是一行 \frac{...} 源码。 */
const bareF = JSON.stringify({
  question: '题干',
  steps: [
    { t: '配平', f: '\\frac{\\sin 3x}{x}=3\\cdot\\frac{\\sin 3x}{3x}' },
    { t: '代值', f: '所以结果是 3' },
    { t: '已包好', f: '$x^2$' },
  ],
});
const bf = sanitizeSolve(bareF);
ok('裸 LaTeX 自动补 $', bf.steps[0].f.startsWith('$') && bf.steps[0].f.endsWith('$'));
ok('含中文的式子不补 $', !bf.steps[1].f.includes('$'));
ok('已经包好的不重复包', bf.steps[2].f === '$x^2$');

/* ---------- 纯数字答案的 $ 要剥掉 ----------
 * renderMath 的 looksLikeMath 把纯数字判成「金额」不渲染，
 * 留着 $ 的话用户看到的是「$3$」。 */
const numAns = (a) => sanitizeSolve(JSON.stringify({ question: '题干', answer: a })).answer;
ok('$3$ → 3', numAns('$3$') === '3');
ok('$\\\\frac{1}{2}$ 保留（含命令）', numAns('$\\frac{1}{2}$') === '$\\frac{1}{2}$');
ok('$x^2$ 保留（含字母）', numAns('$x^2$') === '$x^2$');
ok('$x=1$ 保留（含运算符）', numAns('$x=1$') === '$x=1$');
ok('裸数字不动', numAns('3') === '3');
ok('空答案不动', numAns('') === '');

/* ============================================================
   五、非数学题
   ============================================================ */
section('非数学题');

const notMath = JSON.stringify({
  question: '未识别到数学题',
  answer: '',
  approach: '',
  steps: [],
  points: [],
  pitfall: '',
  signal: '',
});
const nm = sanitizeSolve(notMath);
ok('不算降级（是正常回复）', nm.degraded === false);
ok('题干为提示语', nm.question === '未识别到数学题');
ok('无步骤', nm.steps.length === 0);

/* ============================================================ */
console.log('\n' + '─'.repeat(52));
if (fail) {
  console.log(`\x1b[31m❌ 拍照解题：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  console.log('   失败：' + failures.join('、'));
  process.exit(1);
}
console.log(`\x1b[32m✅ 拍照解题：${pass} 项全部通过\x1b[0m`);
