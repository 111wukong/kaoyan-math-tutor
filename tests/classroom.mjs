/* 课堂阶段机测试
 *
 * ── 为什么这个套件是纯函数、不走 HTTP ──────────────────────────────
 * 要验的东西（意图分类、阶段推演、提示词内容、越界过滤）全是**确定性**的：
 * 给定一句话，阶段必须落在唯一确定的那一个上。
 * 借服务端 + 假模型来测的话，每验一条都要发一次请求、配一次模型，
 * 而真正会错的那些分支（「没听懂」被归成「听懂了」）照样只取决于纯函数。
 * 这里直接 import 函数，一秒出结果。
 *
 * ── 断言的重点是「不该发生的」 ────────────────────────────────────
 * 这套逻辑的失效方式不是崩溃，而是**悄悄走错分支**：
 *   · 「我还是没听懂」被判成听懂了 → 下一轮甩一道算题；
 *   · 说「不知道」之后学生还在插话 → 用户被三个同学围着问；
 *   · 答疑阶段留了一道计算题 → 正是要修的那个毛病。
 * 这三种都不会报错、不会白屏，只会让用户觉得"这系统听不懂人话"。
 * 所以下面一半断言是反着写的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* DB_PATH 必须在 import 服务端模块之前设好 —— ai.js 会连带加载 db/index.js，
 * 那一步就把库打开了。和 tests/graph.mjs / tests/fsrs.mjs 是同一套做法。 */
const TMP = path.join(os.tmpdir(), `kmt-classroom-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP;

const {
  classifyIntent, resolvePhase, buildClassroomPrompt, guardClassroomResult,
  fallbackCheckPrompt, PROMPT_KIND,
} = await import('../server/src/routes/ai.js');
const { db, initSchema } = await import('../server/src/db/index.js');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; } else { fail += 1; console.error(`  \x1b[31m✗\x1b[0m ${msg}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

initSchema();

/* 造一个像样的知识点，用来验提示词里注入了什么 */
const NODE = {
  id: 'c1n1',
  title: '函数的极限',
  content: '设函数 $f(x)$ 在点 $x_0$ 的某个去心邻域内有定义。若存在常数 $A$，'
    + '对任意 $\\varepsilon>0$，总存在 $\\delta>0$，使得当 $0<|x-x_0|<\\delta$ 时，'
    + '恒有 $|f(x)-A|<\\varepsilon$，则称 $A$ 是 $f(x)$ 当 $x\\to x_0$ 时的极限。',
  example: '例：证明 $\\lim_{x\\to 1}(2x+1)=3$。',
  difficulty: 2,
};
const SNAP = { learned: 3, total: 68, wrong: 5, streak: 7 };

/* ══════════════════════════════════════════════════════════════════ */
section('1. 意图分类：先判「不懂」，再判「懂了」');

{
  /* ★ 这一组是整个改动的根。
   * 「听不懂」「没听懂」里都有个「懂」字 —— 只要判断顺序反了，
   * 它们就会被归成「听懂了」，然后下一轮直接出题。
   * 用户的原话是「我在说不知道的时候……不能马上就给我提问算题」，
   * 下面这几条就是钉死它。 */
  const confused = [
    '不知道', '我完全不知道', '不知道啊', '不会', '不会做',
    '没懂', '不懂', '听不懂', '我还是没听懂', '我没听懂',
    '不明白', '还是不明白', '不理解', '跟不上', '太快了',
    '能再说一遍吗', '重新讲一下', '没思路', '卡住了', '卡在这一步',
    '???', '？？？', '我懵了', '有点晕',
  ];
  for (const s of confused) {
    ok(classifyIntent(s) === 'confused', `「${s}」应判为困惑，实得 ${classifyIntent(s)}`);
  }

  const understood = [
    '懂了', '懂了！', '我明白了', '明白了', '理解了', '会了',
    '清楚了', '跟上了', '知道了', '原来如此', '可以了', '继续吧',
  ];
  for (const s of understood) {
    ok(classifyIntent(s) === 'understood', `「${s}」应判为已理解，实得 ${classifyIntent(s)}`);
  }

  /* ★ 反向断言：这几个**不许**被判成 understood。写在一起更醒目 ——
   * 它们正是顺序写反时会翻车的那几条。 */
  for (const s of ['没懂', '不懂', '听不懂', '没听懂', '还是不明白']) {
    ok(classifyIntent(s) !== 'understood', `★「${s}」绝不能判成已理解`);
  }

  const questions = [
    '为什么这里要加条件？',
    '这个怎么推出来的',
    '是不是可以反过来用',
    '什么是去心邻域',
    '凭什么能用洛必达',
  ];
  for (const s of questions) {
    ok(classifyIntent(s) === 'question', `「${s}」应判为提问，实得 ${classifyIntent(s)}`);
  }

  ok(classifyIntent('我觉得是 1') === 'other', '陈述性回答归为 other');
  ok(classifyIntent('') === 'none', '空输入归为 none');
  ok(classifyIntent('   ') === 'none', '全空格也归为 none');
  ok(classifyIntent(undefined) === 'none', 'undefined 不炸');
}

/* ══════════════════════════════════════════════════════════════════ */
section('2. 阶段推演：该讲就讲，该静默就静默，确认了才出题');

{
  const P = (o) => resolvePhase(o);

  ok(P({ round: 0, mode: 'lesson', intent: 'none' }) === 'lecture', '首轮 → lecture（把理论讲透）');
  ok(P({ round: 0, mode: 'lesson', intent: 'confused' }) === 'clarify', '首轮就说不知道 → 也走 clarify');
  ok(P({ round: 4, mode: 'lesson', intent: 'confused' }) === 'clarify', '任何时候说不知道 → clarify');
  ok(P({ round: 4, mode: 'lesson', intent: 'understood' }) === 'practice', '说懂了 → practice');
  ok(P({ round: 4, mode: 'lesson', intent: 'other' }) === 'explain', '普通陈述 → explain');

  /* ★ 答疑阶段的三条承接规则，每一条都对应一个具体的坏体验 */
  ok(P({ round: 4, mode: 'lesson', intent: 'other', prevPhase: 'clarify' }) === 'practice',
    '★ 答疑阶段里给出实质回应 → 才允许进练习');
  ok(P({ round: 4, mode: 'lesson', intent: 'question', prevPhase: 'clarify' }) === 'clarify',
    '★ 答疑阶段里继续追问 → 留在 clarify（不能因为"他说话了"就推去出题）');
  ok(P({ round: 4, mode: 'lesson', intent: 'none', prevPhase: 'clarify' }) === 'clarify',
    '★ 答疑阶段里没说话 → 留在 clarify，不许自己滑进练习');
  ok(P({ round: 4, mode: 'lesson', intent: 'confused', prevPhase: 'clarify' }) === 'clarify',
    '答疑阶段里还说不知道 → 继续 clarify');

  ok(P({ round: 4, mode: 'lesson', intent: 'question', prevPhase: 'explain' }) === 'explain',
    '常规阶段提问 → explain（不是 clarify，学生可以照常插话）');

  /* 研讨课自成一档：老师只抛问题，学生先各试各的 */
  for (const intent of ['none', 'confused', 'understood', 'question', 'other']) {
    ok(P({ round: 3, mode: 'discuss', intent }) === 'discuss', `研讨课下 intent=${intent} 仍是 discuss`);
  }

  /* 每个阶段结尾那一问的性质：前端靠它决定措辞（要不要动笔算） */
  ok(PROMPT_KIND.clarify === 'check', 'clarify 结尾是「理解确认」');
  ok(PROMPT_KIND.practice === 'practice', 'practice 结尾是「一道题」');
  ok(PROMPT_KIND.lecture === 'recall', 'lecture 结尾是「回忆式」');
}

/* ══════════════════════════════════════════════════════════════════ */
section('3. 提示词：首轮讲透 / 答疑静默 / 带上在回答哪一问');

{
  const base = { node: NODE, snap: SNAP, mode: 'lesson', round: 0 };

  /* ---------- 首轮讲透 ---------- */
  const lec = buildClassroomPrompt({ ...base, phase: 'lecture' });
  ok(lec.includes('把理论讲透'), 'lecture 提示词点明「把理论讲透」');
  ok(lec.includes('前提条件'), 'lecture 要求讲清前提条件');
  ok(lec.includes('适用范围'), 'lecture 要求讲清适用范围（什么情况下不能用）');
  ok(lec.includes('直观'), 'lecture 要求给直观解释');
  ok(lec.includes('400 字'), '★ lecture 放宽了字数上限（原来一刀切 120 字，讲不透）');
  ok(lec.includes('不要出计算题'), 'lecture 结尾留回忆式问题，不出计算题');
  ok(lec.includes(NODE.example), '★ lecture 把例题喂进去当讲解素材');
  ok(lec.includes('函数的极限'), 'lecture 注入了知识点标题');
  ok(lec.includes('$\\varepsilon>0$'), 'lecture 注入了知识点正文（含 LaTeX）');

  /* 首轮必须比后续轮次喂更多正文 —— 讲透需要材料 */
  const later = buildClassroomPrompt({ ...base, phase: 'explain', round: 5 });
  ok(lec.length > later.length, '首轮提示词比后续轮次更长（材料更多）');
  ok(!later.includes(NODE.example), '★ 后续轮次不再喂例题（否则模型会直接讲题，跳过概念）');

  /* ---------- 答疑静默 ---------- */
  const cla = buildClassroomPrompt({ ...base, phase: 'clarify', round: 3, userInput: '我不知道' });
  ok(cla.includes('三个学生全部静默'), '★ clarify 要求三个学生静默');
  ok(cla.includes('不许出题'), '★ clarify 明令不许出题');
  ok(cla.includes('理解确认'), 'clarify 要求结尾是理解确认');
  ok(cla.includes('换一个角度重讲'), 'clarify 要求换角度重讲，而不是重复上一轮');
  ok(cla.includes('我不知道'), 'clarify 把学生的原话带进去了');
  ok(!cla.includes(NODE.example), '★ clarify 不喂例题（这一轮要退回去讲概念，不是讲题）');

  /* ---------- 练习验收 ---------- */
  const pra = buildClassroomPrompt({ ...base, phase: 'practice', round: 5 });
  ok(pra.includes('小题'), 'practice 要求出一道小题');
  ok(pra.includes('针对刚才卡住的那个点'), 'practice 要求题目针对刚卡住的点');
  ok(!pra.includes('全部静默'), 'practice 不再要求学生静默（学生要各试各的）');

  /* ---------- 留痕：在回答哪一问 ---------- */
  const echo = buildClassroomPrompt({
    ...base, phase: 'explain', round: 2,
    userInput: '我觉得是 1',
    lastPrompt: '你能用自己的话说说，为什么 0/0 不能直接代值吗？',
    lastPromptRound: 1,
  });
  ok(echo.includes('学生正在回答的问题'), '★ 提示词里带上了「学生正在回答的问题」');
  ok(echo.includes('第 2 轮老师留的'), '★ 并标明那是第几轮留的问题');
  ok(echo.includes('为什么 0/0 不能直接代值'), '问题的原文被带进去了');
  ok(echo.includes('先点明在回应哪一问'), '★ 要求老师明确点出在回应哪一问');

  /* 没传 lastPrompt 时不能凭空冒出一段 —— 那会让模型去猜一个不存在的问题 */
  const noEcho = buildClassroomPrompt({ ...base, phase: 'explain', round: 2, userInput: '继续' });
  ok(!noEcho.includes('学生正在回答的问题'), '没传 lastPrompt 时不出现那段');

  /* ---------- 角色铁律没有被改掉 ---------- */
  ok(lec.includes('各错各的'), '「三个学生各错各的」这条铁律还在');
  ok(lec.includes('不许都说"我懂了"'), '「不许都说我懂了」还在');
}

/* ══════════════════════════════════════════════════════════════════ */
section('4. 越界过滤：提示词是请求，这里是保证');

{
  const students = [
    { role: 'teacher', name: '老师', text: '我们退回去看定义。' },
    { role: 'xiaoming', name: '小明', text: '那我是不是应该先求导？' },
    { role: 'xiaohong', name: '小红', text: '我也想问，定义域怎么定？' },
    { role: 'xiaogang', name: '小刚', text: '去掉条件还成立吗？' },
  ];
  const calcPrompt = '求 $\\lim_{x\\to 0}\\frac{\\sin x}{x}$ 的值';

  /* ---------- clarify：学生全摘掉 ---------- */
  const g1 = guardClassroomResult({ turns: students, board: ['b1'], prompt: calcPrompt }, 'clarify', NODE);
  ok(g1.turns.length === 1 && g1.turns[0].role === 'teacher',
    `★ clarify 下学生发言被摘干净（实得 ${g1.turns.map((t) => t.role).join('/')}）`);
  ok(g1.silenced === 3, `★ 被静默的条数如实报出来（实得 ${g1.silenced}）`);

  /* ---------- clarify：算题被换成理解确认 ---------- */
  ok(g1.adjusted === true, '★ 算题被判定为越界并替换');
  ok(g1.prompt !== calcPrompt, 'prompt 确实换掉了');
  ok(!/计算|的值是/.test(g1.prompt), '替换后不再是一道算题');
  ok(g1.prompt.includes('先不做题'), '替换后的话术明确说了「先不做题」');
  ok(g1.prompt.includes('函数的极限'), '兜底句带上了知识点标题，不是通用废话');
  ok(g1.prompt.includes('说不清也没关系'), '★ 兜底句留了「说不清也没关系」的出口（否则学生会硬撑说懂了）');

  /* ---------- clarify：好问题原样保留 ---------- */
  const good = '这一步的推理跟得上吗？是卡在定义，还是卡在符号？';
  const g2 = guardClassroomResult({ turns: students, board: [], prompt: good }, 'clarify', NODE);
  ok(g2.prompt === good, '★ 本来就是理解确认问题的，原样保留（不做无谓替换）');
  ok(g2.adjusted === false, '没替换就不该标 adjusted');

  /* 「求极限有哪些方法」这种带「求」字的好问题不该被误杀 */
  const alsoGood = '求极限的方法你能说出几种？说不全也没关系。';
  const g3 = guardClassroomResult({ turns: students, board: [], prompt: alsoGood }, 'clarify', NODE);
  ok(g3.prompt === alsoGood, '★ 带「求极限」字样的理解确认问题不被误杀');
  ok(g3.adjusted === false, '没误杀就不该标 adjusted');

  /* ---------- clarify：没有 prompt 也要补一个 ---------- */
  const g4 = guardClassroomResult({ turns: students, board: [], prompt: '' }, 'clarify', NODE);
  ok(g4.prompt.length > 5 && g4.adjusted === true, '★ clarify 下没留问题 → 补一个理解确认问题');

  /* ---------- clarify：老师也没说话 → 交回上层报失败 ---------- */
  const g5 = guardClassroomResult(
    { turns: students.slice(1), board: [], prompt: 'x' }, 'clarify', NODE,
  );
  ok(g5.turns.length === 0, '★ clarify 下只有学生发言时，结果为空（上层据此报 parseFailed）');

  /* ---------- 其它阶段不许动学生 ---------- */
  for (const phase of ['lecture', 'explain', 'practice', 'discuss']) {
    const g = guardClassroomResult({ turns: students, board: [], prompt: calcPrompt }, phase, NODE);
    ok(g.turns.length === 4, `${phase} 阶段学生发言条数不变`);
    ok(g.silenced === 0, `${phase} 阶段没有静默计数`);
    ok(g.prompt === calcPrompt, `${phase} 阶段 prompt 不做替换（练习阶段就该出题）`);
  }

  /* ---------- 兜底句本身 ---------- */
  ok(fallbackCheckPrompt(NODE).includes('函数的极限'), '兜底句用知识点标题');
  ok(fallbackCheckPrompt(null).includes('这一步'), '没有知识点时兜底句也不炸');
}

/* ══════════════════════════════════════════════════════════════════ */
/* 收摊 */
try {
  db.close();
  fs.rmSync(TMP, { force: true });
  fs.rmSync(`${TMP}-wal`, { force: true });
  fs.rmSync(`${TMP}-shm`, { force: true });
} catch { /* 临时目录，删不掉无所谓 */ }

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ 课堂阶段机：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 课堂阶段机：${pass} 项\x1b[0m`);
