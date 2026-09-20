/* AI 批改：提示词构造 + 结果清洗
 *
 * ── 为什么这个套件必须有 ──────────────────────────────────────────
 * AI 批改的失效方式是**静默给错分**：学生明明做对了，AI 给 2/10，
 * 然后那道题进了错题本、XP 只加了 2 点、掌握度掉了一档 ——
 * 页面不报错、构建通过、接口 200。这比「接口挂了」难查一百倍，
 * 因为没有任何信号指向它。
 *
 * 所以这里守两件事：
 *   1. **算术不交给模型**：满分从库里的评分点求和、总分从各步相加。
 *      模型给的 total / full 一律忽略 —— 它会在总分上写一个和分步对不上的数，
 *      用户一眼就看出来，然后整个功能就不可信了。
 *   2. **畸形输出必须被清洗或作废**，不能把「—」「没写」「满分+10」这类
 *      东西变成分数。作废的代价只是回退到用户自评，而错分的代价是记错账。
 *
 * 这个文件是纯的（不引 db / fastify），所以能直接 import 做全量断言。
 */
import {
  buildGradePrompt, buildExplainPrompt, sanitizeGrade, extractJson, parseGrade,
  DEFAULT_FULL, PASS_RATIO,
} from '../server/src/lib/grade.js';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

const STEPS = [
  { t: '写出导数定义式', pts: 4 },
  { t: '正确求导并化简', pts: 4 },
  { t: '代值得到结论', pts: 2 },
];
const FULL = 10;
const Q = {
  type: 'solve',
  stem: '求 \\lim_{h\\to 0}\\frac{(1+h)^{2}-1}{h}',
  answer: '2',
  analysis: '展开后约掉 h。',
};

/* ============================================================
   1. 提示词
   ============================================================ */
section('1. 批改提示词');
{
  const p = buildGradePrompt(Q, STEPS, '我的作答：原式 = 2');
  ok('带上题干', p.includes(Q.stem));
  ok('带上参考答案', p.includes(Q.answer));
  ok('带上学生的作答原文', p.includes('我的作答：原式 = 2'));
  ok('★ 逐条列出评分点与分值', p.includes('1. （4 分）写出导数定义式') && p.includes('3. （2 分）代值得到结论'));
  ok('★ 明确写出满分', p.includes(`满分 ${FULL} 分`));
  ok('要求逐条打分', p.includes('逐条判断'));
  ok('禁止模型新增评分点', p.includes('不要自己新增评分点'));
  ok('★ 要求从严（不给安慰分）', p.includes('不要给「安慰分」'));
  ok('给出了 JSON 形状', p.includes('"got"') && p.includes('"i"'));
  ok('空白作答有兜底文案', buildGradePrompt(Q, STEPS, '').includes('（空白）'));

  /* 没有评分点时退化成 10 分制，形状也要跟着变 */
  const noSteps = buildGradePrompt(Q, [], '随便写');
  ok('★ 没有评分点时按 10 分制', noSteps.includes('10 分制整体评'));
  ok('没有评分点时形状里没有 steps', noSteps.includes('"score":7') && !noSteps.includes('"got"'));

  /* 超长输入要截断 —— 否则一次误贴整页笔记就能把上下文撑爆 */
  const long = buildGradePrompt(Q, STEPS, 'x'.repeat(9000));
  ok('超长作答被截断', long.length < 9000 && long.includes('…'));

  const e = buildExplainPrompt(Q, '学生写的', '计算失误');
  ok('讲解提示词带上错因', e.includes('计算失误'));
  ok('讲解提示词要求学生作答', e.includes('学生写的'));
  ok('讲解提示词限定了字数', e.includes('400 字'));
  ok('讲解提示词要求出小结题', e.includes('只有数字不同的小题'));
}

/* ============================================================
   2. ★ 算术不交给模型
   ============================================================ */
section('2. ★ 满分与总分都由代码算，不听模型的');
{
  const g = sanitizeGrade({ steps: [{ i: 1, got: 4 }, { i: 2, got: 4 }, { i: 3, got: 2 }] }, STEPS);
  ok('全对：score = 10', g.score === FULL);
  ok('full 来自评分点求和', g.full === FULL);
  ok('ratio = 1', g.ratio === 1);
  ok('correct = true', g.correct === true);
  ok('每步都带上了原评分点的文案与分值',
    g.steps.length === 3 && g.steps[1].t === '正确求导并化简' && g.steps[1].pts === 4);

  /* ★ 模型在 total / full 上写什么都不能影响结果 */
  const lying = sanitizeGrade({
    steps: [{ i: 1, got: 1 }, { i: 2, got: 0 }, { i: 3, got: 0 }],
    total: 999, full: 999, score: 999,
  }, STEPS);
  ok('★ 模型写的 total / full / score 一律被忽略',
    lying.score === 1 && lying.full === FULL,
    `实得 score=${lying.score} full=${lying.full}`);

  /* 评分点的满分以**库里**的为准：模型改不了分母 */
  const g2 = sanitizeGrade({ steps: [{ i: 1, got: 4 }, { i: 2, got: 4 }, { i: 3, got: 2 }] }, [
    { t: 'a', pts: 1 }, { t: 'b', pts: 1 }, { t: 'c', pts: 1 },
  ]);
  ok('★ 分母用库里的分值，不是模型的', g2.full === 3 && g2.score === 3);
}

/* ============================================================
   3. 畸形输出：清洗 or 作废
   ============================================================ */
section('3. 畸形输出');
{
  const one = (raw) => sanitizeGrade(raw, STEPS);

  ok('越界索引被丢弃', one({ steps: [{ i: 9, got: 3 }, { i: 1, got: 4 }] })?.steps.length === 3);
  ok('越界索引不产生额外步骤',
    one({ steps: [{ i: 9, got: 3 }, { i: 1, got: 4 }] }).score === 4);
  ok('非数字的 got 被丢弃（「没写」这类）',
    one({ steps: [{ i: 1, got: '没写' }] }) === null);
  ok('字符串数字能被接受', one({ steps: [{ i: 1, got: '4' }] })?.score === 4);
  ok('超过该步满分的分被夹回满分', one({ steps: [{ i: 1, got: 99 }] })?.score === 4);
  ok('负数被夹到 0', one({ steps: [{ i: 1, got: -5 }] })?.score === 0);
  ok('小数被四舍五入到整数', one({ steps: [{ i: 1, got: 2.6 }] })?.steps[0].got === 3);

  /* 同一个索引给两遍：取第一条。提示词里是按顺序列的，
   * 第一条对应它最先给出的判断，后面的多半是自我修正。 */
  const dup = one({ steps: [{ i: 1, got: 4 }, { i: 1, got: 0 }] });
  ok('★ 重复索引取第一条', dup.steps[0].got === 4);

  /* ★ 模型漏掉的评分点按 0 分算，不能默认给满分 */
  const missing = one({ steps: [{ i: 1, got: 4 }] });
  ok('★ 模型没提到的评分点记 0 分（不是满分）', missing.score === 4);
  ok('未涉及的步骤有明确标注', missing.steps[1].comment === '未涉及');

  ok('steps 不是数组 → 作废', one({ steps: '这是一段解释' }) === null);
  ok('steps 为空数组 → 作废', one({ steps: [] }) === null);
  ok('一个有效分数都没有 → 作废', one({ steps: [{ i: 99, got: 5 }] }) === null);
  ok('整个对象是 null → 作废', one(null) === null);
  ok('comment 被截断', (one({ steps: [{ i: 1, got: 4 }], comment: '啊'.repeat(500) }).comment.length) <= 300);
}

/* ============================================================
   4. 没有评分点：整体评 10 分制
   ============================================================ */
section('4. 没有评分点时的整体评');
{
  const g = sanitizeGrade({ score: 7, comment: '还行' }, []);
  ok('按 10 分制', g.full === DEFAULT_FULL && g.score === 7);
  ok('steps 是空数组（前端据此不渲染分步）', Array.isArray(g.steps) && g.steps.length === 0);
  ok('ratio 正确', Math.abs(g.ratio - 0.7) < 1e-9);
  ok('7 分算答对（阈值 0.6）', g.correct === true);
  ok('5 分算答错', sanitizeGrade({ score: 5 }, []).correct === false);
  ok('超范围的分数被夹住', sanitizeGrade({ score: 99 }, []).score === DEFAULT_FULL);
  ok('非数字分数 → 作废', sanitizeGrade({ score: '满分' }, []) === null);
  ok('缺分数 → 作废', sanitizeGrade({ comment: '不错' }, []) === null);
}

/* ============================================================
   5. 从模型输出文本里抠 JSON
   ============================================================ */
section('5. 抠 JSON');
{
  const shape = JSON.stringify({ steps: [{ i: 1, got: 4 }], comment: '好' });
  ok('裸 JSON', extractJson(shape)?.comment === '好');
  ok('包在 ```json 围栏里（小模型基本不听「不要代码块」）',
    extractJson('```json\n' + shape + '\n```')?.comment === '好');
  ok('围栏不带语言标记', extractJson('```\n' + shape + '\n```')?.comment === '好');
  ok('前后有废话', extractJson('好的，我来批改：\n' + shape + '\n以上。')?.comment === '好');
  ok('尾逗号能被救回来', extractJson('{"score":7,"comment":"好",}')?.score === 7);
  ok('没有 JSON → null', extractJson('这道题我不会批') === null);
  ok('空字符串 → null', extractJson('') === null);

  ok('★ parseGrade 端到端', parseGrade('```json\n' + shape + '\n```', STEPS)?.score === 4);
  ok('★ parseGrade 对无法解析的文本返回 null', parseGrade('我不会', STEPS) === null);
}

/* ============================================================
   6. ★ 不变量：任何输入下 score / full 都必须自洽
   ============================================================
   这条比前面所有单点断言加起来都值钱 —— 它保证不管模型吐什么，
   前端拿到的分数都「加得起来」，不会出现「分步加起来 6 分、总分写 9 分」
   这种用户一眼就能看出的自相矛盾。 */
section('6. ★ 不变量：score === Σgot、full === Σpts');
{
  const weird = [
    undefined, null, 0, '', 'x', [], {},
    { steps: null }, { steps: [{}] }, { steps: [{ i: 1 }] },
    { steps: [{ i: 1, got: Infinity }] },
    { steps: [{ i: 1, got: NaN }] },
    { steps: [{ i: '1', got: '4' }] },
    { steps: [{ i: 1.5, got: 2 }] },
    { steps: [{ i: -1, got: 2 }] },
    { steps: [{ i: 1, got: 4 }, { i: 2, got: 4 }, { i: 3, got: 2 }, { i: 4, got: 9 }] },
    { score: -3 }, { score: 0 }, { score: 1e9 },
    { steps: [], score: 5 },
  ];

  const bad = [];
  for (const raw of weird) {
    let g;
    try { g = sanitizeGrade(raw, STEPS); } catch (e) { bad.push(`抛异常 ${JSON.stringify(raw)}: ${e.message}`); continue; }
    if (g === null) continue;   // 作废是合法结果

    const sumGot = g.steps.reduce((a, s) => a + s.got, 0);
    const sumPts = g.steps.reduce((a, s) => a + s.pts, 0);
    const label = JSON.stringify(raw)?.slice(0, 60);

    if (g.score !== sumGot) bad.push(`${label} score=${g.score} 但 Σgot=${sumGot}`);
    if (g.steps.length && g.full !== sumPts) bad.push(`${label} full=${g.full} 但 Σpts=${sumPts}`);
    if (!Number.isFinite(g.score) || !Number.isFinite(g.full)) bad.push(`${label} 出现了非有限数`);
    if (!Number.isFinite(g.ratio) || g.ratio < 0 || g.ratio > 1.01) bad.push(`${label} ratio=${g.ratio}`);
    if (g.score < 0 || g.score > g.full) bad.push(`${label} score=${g.score} 越出 [0, ${g.full}]`);
    if (typeof g.correct !== 'boolean') bad.push(`${label} correct 不是布尔`);
    for (const s of g.steps) {
      if (!Number.isInteger(s.got)) bad.push(`${label} 第 ${s.i} 步的 got 不是整数`);
      if (s.got < 0 || s.got > s.pts) bad.push(`${label} 第 ${s.i} 步 ${s.got}/${s.pts} 越界`);
    }
  }
  ok(`★ ${weird.length} 组畸形输入下分数始终自洽（含未定义 / NaN / 越界 / 重复 / 空）`,
    bad.length === 0, bad.slice(0, 5).join(' | '));

  /* 评分点全是 0 分的退化情形：不能算出 NaN 或 0/0 */
  const zero = sanitizeGrade({ steps: [{ i: 1, got: 0 }, { i: 2, got: 0 }] }, [{ t: 'a', pts: 0 }, { t: 'b', pts: 0 }]);
  ok('★ 评分点全是 0 分时不产生 NaN', zero && Number.isFinite(zero.ratio) && zero.full === DEFAULT_FULL);
}

/* ============================================================
   7. 阈值
   ============================================================ */
section('7. 「算答对」的阈值');
{
  ok('PASS_RATIO 是 0.6', PASS_RATIO === 0.6);
  const at = (score) => sanitizeGrade({ steps: [{ i: 1, got: score }, { i: 2, got: 0 }, { i: 3, got: 0 }] }, [
    { t: 'a', pts: 6 }, { t: 'b', pts: 4 }, { t: 'c', pts: 0 },
  ]);
  ok('恰好 60% 算对', at(6).correct === true);
  ok('低于 60% 算错', at(5).correct === false);
  ok('0 分算错', at(0).correct === false);
}

/* ============================================================
   8. 自检：这些检查真的会失败吗
   ============================================================ */
section('8. 自检：检测器真的会报警吗');
{
  /* 手工构造一个「模型说了算」的错误实现，确认不变量会抓住它 */
  const naive = (raw) => ({
    steps: (raw?.steps || []).map((s) => ({ i: s.i, pts: 2, got: Number(s.got), t: '' })),
    score: Number(raw?.total) || 0,
    full: Number(raw?.full) || 10,
    ratio: 0.5, correct: true,
  });
  const bad = naive({ steps: [{ i: 1, got: 3 }], total: 99, full: 5 });
  ok('「总分听模型的」会被发现', bad.score !== bad.steps.reduce((a, s) => a + s.got, 0));
  ok('「full 听模型的」会被发现', bad.full !== bad.steps.reduce((a, s) => a + s.pts, 0));
  /* 这一步拿 3 分但满分只有 2 —— 分步越界必须被抓住 */
  ok('「got 越界」会被发现', bad.steps[0].got > bad.steps[0].pts);
}

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ AI 批改：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ AI 批改：${pass} 项\x1b[0m`);
