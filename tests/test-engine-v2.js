/* 学习引擎 v2 回归测试
 *
 * 这一层的机制全部借鉴自成熟开源项目（helix-trainer / Duolingo / Orbit / mathlearn），
 * 但它们有个共同特点：**规则都是"看起来显然，边界全是坑"**。
 * 所以这里测的不是"函数没报错"，而是：
 *
 *   1) 三级掌握度 —— 精通必须"每道题都答对过"，
 *      只刷同一道题三次不能变成精通（这是整个 XP 递减机制的地基）
 *   2) XP 递减 —— 两个乘数相乘、下限 1、note 文案与数值一致
 *   3) 补签券 —— 只补昨天、前天必须真打过卡、每周上限、不累积
 *   4) 备考投影 —— 日均、缺口、是否来得及，口径不能自相矛盾
 *   5) 下一步 —— 优先级排序，且**永远只返回一个**
 *   6) 闪电战 —— 倍率阶梯与封顶、只记更好成绩
 *   7) 公式实验室纯数学层 —— 数值必须对得上解析解
 *   8) 模块接线 —— 新增模块忘了配 CONTROLS / DRAW 能被测出来
 */
'use strict';
const path = require('path');
const BASE = path.join(__dirname, '..');

global.window = {};
require(path.join(BASE, 'js/game.js'));
require(path.join(BASE, 'js/lab.js'));
const Game = global.window.Game;
const Lab = global.window.Lab;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  => ' + JSON.stringify(extra).slice(0, 200) : '')); }
}
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }
function near(a, b, tol, label) { ok(Math.abs(a - b) <= tol, label, { got: a, want: b, tol: tol }); }

/* ---------- 可控世界 ----------
 * k1 / k2 各有题，k3 只在数学二，k4 只在数学一 —— 用来测范围过滤。
 * 注意 game.js 的 inTrack：track === 'math1' 时一律放行（数学一是超集）。 */
const WORLD = {
  chapters: [
    { id: 'c0', name: '第一章 极限', categoryId: 'calculus', categoryName: '高等数学', color: '#3b5bdb' }
  ],
  nodes: [
    { id: 'k1', title: '数列极限', exam: 'all', chapterId: 'c0', categoryId: 'calculus' },
    { id: 'k2', title: '导数定义', exam: 'all', chapterId: 'c0', categoryId: 'calculus' },
    { id: 'k3', title: '中值定理', exam: ['math2'], chapterId: 'c0', categoryId: 'calculus' },
    { id: 'k4', title: '三重积分', exam: ['math1'], chapterId: 'c0', categoryId: 'calculus' },
    { id: 'k5', title: '定积分应用', exam: 'all', chapterId: 'c0', categoryId: 'calculus' },
    { id: 'k6', title: '行列式', exam: 'all', chapterId: 'c0', categoryId: 'calculus' }
  ],
  questions: [
    { id: 'k1q1', kid: 'k1' }, { id: 'k1q2', kid: 'k1' },
    { id: 'k2q1', kid: 'k2' },
    { id: 'k3q1', kid: 'k3' }, { id: 'k4q1', kid: 'k4' },
    { id: 'k5q1', kid: 'k5' }, { id: 'k6q1', kid: 'k6' }
  ]
};
const T = '2026-09-16';

/* 造一条作答记录 */
function at(qid, kid, correct, date) {
  return { qid: qid, kid: kid, correct: !!correct, date: date || '2026-09-01' };
}

/* ============================================================ */
console.log('=== 1. 三级掌握度 ===');

eq(Game.nodeMastery({}, WORLD, 'k1').level, 'new', '没答过 → 未学');
eq(Game.nodeMastery({}, WORLD, 'k1').label, '未学', '未学的中文标签');
eq(Game.nodeMastery({}, WORLD, 'k1').accuracy, 0, '没答过时正确率是 0 而不是 NaN');

eq(Game.nodeMastery({ attempts: [at('k1q1', 'k1', true)] }, WORLD, 'k1').level, 'learning', '答对 1 次 → 学习中');
eq(Game.nodeMastery({ attempts: [at('k1q1', 'k1', true), at('k1q1', 'k1', true), at('k1q1', 'k1', false)] }, WORLD, 'k1').level,
  'learning', '答 3 次但正确率 2/3 → 学习中（正确率不够）');

/* ★ 本文件最重要的一条：防刷分的地基 */
const grindy = { attempts: [at('k1q1', 'k1', true), at('k1q1', 'k1', true), at('k1q1', 'k1', true)] };
eq(Game.nodeMastery(grindy, WORLD, 'k1').level, 'proficient',
  '★ 只刷同一道题 3 次 → 熟练，不是精通');
eq(Game.nodeMastery(grindy, WORLD, 'k1').allRight, false,
  '★ allRight 为 false —— 节点里还有题没碰过');

const realMaster = {
  attempts: [at('k1q1', 'k1', true), at('k1q1', 'k1', true), at('k1q2', 'k1', true), at('k1q2', 'k1', true)]
};
eq(Game.nodeMastery(realMaster, WORLD, 'k1').level, 'mastered', '★ 节点内每道题都答对过 → 精通');
eq(Game.nodeMastery(realMaster, WORLD, 'k1').allRight, true, 'allRight 为 true');
eq(Game.nodeMastery(realMaster, WORLD, 'k1').questionsSeen, 2, '记录到碰过 2 道题');
eq(Game.nodeMastery(realMaster, WORLD, 'k1').questions, 2, '节点共 2 道题');

eq(Game.nodeMastery({ attempts: [at('k1q1', 'k1', true), at('k1q2', 'k1', true), at('k1q1', 'k1', false)] }, WORLD, 'k1').level,
  'learning', '每道题都答对过但正确率 2/3 → 仍然是学习中（正确率没过线）');

/* 只统计本节点的题，别串到隔壁 */
eq(Game.nodeMastery({ attempts: [at('k2q1', 'k2', true), at('k2q1', 'k2', true), at('k2q1', 'k2', true)] }, WORLD, 'k1').level,
  'new', '★ k2 的作答不会算到 k1 头上');

eq(Game.nodeMastery({ attempts: [at('k1q1', 'k1', true), at('k1q1', 'k1', true), at('k1q1', 'k1', true), at('k1q2', 'k1', true)] }, WORLD, 'k1').level,
  'mastered', '正确率 100% 且每题都碰过 → 精通（题量 4 ≥ 3）');

const board = Game.masteryBoard({ attempts: realMaster.attempts }, WORLD, { track: 'math1' });
eq(board.total, 6, '数学一 6 个节点（数学一是超集，全放行）');
eq(board.dist.mastered + board.dist.proficient + board.dist.learning + board.dist.new, board.total,
  '★ 四档分布之和 = 总节点数（不能有节点掉档）');
eq(board.dist.mastered, 1, 'k1 是精通');
eq(board.dist.new, 5, '其余 5 个未学');
eq(board.label.mastered, '精通', '分布里带中文标签');
eq(Game.masteryBoard({}, WORLD, { track: 'math2' }).total, 5, '数学二 5 个节点（排除只在数学一的 k4）');

/* ============================================================ */
console.log('\n=== 2. XP 递减 ===');

eq(Game.XP.correct, 10, '答对基础分是 10');
eq(Game.sessionMult(1), 1, '今日第 1 次不打折');
eq(Game.sessionMult(2), 0.7, '今日第 2 次 70%');
eq(Game.sessionMult(3), 0.7, '今日第 3 次 70%');
eq(Game.sessionMult(4), 0.3, '今日第 4 次起 30%');

/* 默认语义：本次作答「尚未写入」attempts，也就是 push 之前调用 */
eq(Game.answerXp({ attempts: [] }, 'k1q1', 'k1', { today: T, world: WORLD }).amount, 10,
  '新题首答给满 10');
eq(Game.answerXp({ attempts: [at('k1q1', 'k1', true, T)] }, 'k1q1', 'k1', { today: T, world: WORLD }).amount, 7,
  '同日第 2 次 → 7');
eq(Game.answerXp({ attempts: [at('k1q1', 'k1', true, T), at('k1q1', 'k1', true, T)] }, 'k1q1', 'k1', { today: T, world: WORLD }).amount,
  7, '同日第 3 次仍是 7（70%）');
/* 注意：这里 k1 已经答满 3 次且全对 → 节点升到"熟练"，
   所以拿到的是「掌握度 0.5 × 当日 0.3」的复合折扣，而不是纯 0.3。 */
eq(Game.answerXp({ attempts: [at('k1q1', 'k1', true, T), at('k1q1', 'k1', true, T), at('k1q1', 'k1', true, T)] }, 'k1q1', 'k1', { today: T, world: WORLD }).amount,
  2, '★ 同日第 4 次（节点已熟练）→ 10 × 0.5 × 0.3 = 2');

/* 把"当日重复"这一路单独隔离出来：节点停在"学习中"，掌握度乘数就是 1 */
const learningNode = {
  attempts: [at('k2q1', 'k2', true, T), at('k2q1', 'k2', false, T), at('k2q1', 'k2', false, T)]
};
eq(Game.nodeMastery(learningNode, WORLD, 'k2').level, 'learning', '对照节点确实停在"学习中"');
eq(Game.answerXp(learningNode, 'k2q1', 'k2', { today: T, world: WORLD }).amount, 3,
  '★ 纯当日第 4 次 → 10 × 0.3 = 3（掌握度不打折）');
eq(Game.answerXp(learningNode, 'k2q1', 'k2', { today: T, world: WORLD }).note, '今日第 4 次作答',
  '★ 只有当日重复时文案点明是第几次');

/* recorded:true 表示「已经写进去了」，此时 nth 不该再 +1 */
eq(Game.answerXp({ attempts: [at('k1q1', 'k1', true, T)] }, 'k1q1', 'k1', { today: T, world: WORLD }).nthToday, 2,
  '默认语义下今日已有 1 条 → 本次是第 2 次');
eq(Game.answerXp({ attempts: [at('k1q1', 'k1', true, T)] }, 'k1q1', 'k1', { today: T, world: WORLD, recorded: true }).nthToday, 1,
  '★ recorded:true 时本次是第 1 次（不会把首答误判成重复）');
eq(Game.answerXp({ attempts: [at('k1q1', 'k1', true, T)] }, 'k1q1', 'k1', { today: T, world: WORLD, recorded: true }).amount, 10,
  '★ 同上，首答拿满 10 分');

/* 昨天的作答不算今日重复 */
eq(Game.answerXp({ attempts: [at('k1q1', 'k1', true, '2026-09-15')] }, 'k1q1', 'k1', { today: T, world: WORLD }).amount, 10,
  '★ 昨天答过不影响今天首答的分数');

/* 掌握度乘数 */
const xpMaster = Game.answerXp({ attempts: realMaster.attempts }, 'k1q1', 'k1', { today: T, world: WORLD });
eq(xpMaster.mastery, 'mastered', '已精通节点被识别');
eq(xpMaster.masteryMult, 0.2, '精通节点 ×0.2');
eq(xpMaster.amount, 2, '★ 精通节点再答只给 2 分');
eq(xpMaster.reduced, true, 'reduced 标记为 true');
eq(xpMaster.note, '该知识点已精通', '★ 文案说清为什么只有 2 分');

const xpProf = Game.answerXp({ attempts: grindy.attempts }, 'k1q1', 'k1', { today: T, world: WORLD });
eq(xpProf.masteryMult, 0.5, '熟练节点 ×0.5');
eq(xpProf.amount, 5, '熟练节点首答给 5 分');

/* 下限 1：两个乘数叠到底也不能给 0（参与本身仍有正反馈） */
const xpFloor = Game.answerXp({
  attempts: realMaster.attempts.concat([at('k1q1', 'k1', true, T), at('k1q1', 'k1', true, T), at('k1q1', 'k1', true, T)])
}, 'k1q1', 'k1', { today: T, world: WORLD });
eq(xpFloor.amount, 1, '★ 精通 ×0.2 再叠今日第 4 次 ×0.3 → 下限 1，不给 0');
eq(xpFloor.note, '已掌握 + 今日重复', '★ 两个原因都命中时文案合并');

const xpDup = Game.answerXp({ attempts: [at('k2q1', 'k2', true, T)] }, 'k2q1', 'k2', { today: T, world: WORLD });
eq(xpDup.note, '今日第 2 次作答', '只有当日重复时文案是「今日第 N 次作答」');
eq(Game.answerXp({ attempts: [] }, 'k1q1', 'k1', { today: T, world: WORLD }).note, '',
  '拿满分时不显示解释文案');

/* ============================================================ */
console.log('\n=== 3. 补签券 ===');

eq(Game.FREEZE_PER_WEEK, 2, '每周 2 张券');
eq(Game.weekStart('2026-09-14'), '2026-09-14', '周一是一周起点（09-14 是周一）');
eq(Game.weekStart('2026-09-20'), '2026-09-14', '★ 周日归到本周周一，不是下周');
eq(Game.weekStart('2026-09-21'), '2026-09-21', '下周一另起一周');

/* 昨天打了卡 → 不需要补 */
const s1 = { checkins: { '2026-09-14': { tasksDone: true }, '2026-09-15': { tasksDone: true } }, game: Game.blank() };
eq(Game.autoMakeup(s1, T), null, '昨天已打卡 → 不补签');
eq(Game.freezesLeft(s1, T), 2, '没用券时剩 2 张');

/* 昨天漏了、前天打了 → 补 */
const s2 = { checkins: { '2026-09-14': { tasksDone: true } }, game: Game.blank() };
eq(Game.autoMakeup(s2, T), '2026-09-15', '★ 昨天漏了但前天打过 → 补上昨天');
eq(s2.game.makeups['2026-09-15'], 1, '补签日写进 makeups');
eq(Game.freezesLeft(s2, T), 1, '用掉 1 张，剩 1 张');
eq(Game.autoMakeup(s2, T), null, '★ 同一天重复调用不会重复扣券');
eq(Game.freezesLeft(s2, T), 1, '★ 重复调用后券数不变（幂等）');

/* 前天也没打 → 链子本来就断了，不给补 */
const s3 = { checkins: { '2026-09-10': { tasksDone: true } }, game: Game.blank() };
eq(Game.autoMakeup(s3, T), null, '★ 前天也没打卡 → 不补（券不是免死金牌）');
eq(Game.freezesLeft(s3, T), 2, '没补签就不扣券');

/* 本周券用完 */
const s4 = {
  checkins: { '2026-09-14': { tasksDone: true } },
  game: Object.assign(Game.blank(), { freezeLog: { '2026-09-14': '2026-09-15', '2026-09-15': '2026-09-16' } })
};
eq(Game.freezesUsedThisWeek(s4, T), 2, '同一周已用 2 张');
eq(Game.freezesLeft(s4, T), 0, '剩 0 张');
eq(Game.autoMakeup(s4, T), null, '★ 本周券用完 → 补不了');

/* 跨周券不累积：上周没用完也不会攒到这周 */
const s5 = { checkins: { '2026-09-14': { tasksDone: true } }, game: Object.assign(Game.blank(), { freezeLog: { '2026-09-07': '2026-09-08' } }) };
eq(Game.freezesUsedThisWeek(s5, T), 0, '★ 上周的用券不计入本周');
eq(Game.freezesLeft(s5, T), 2, '★ 券不累积，本周照样只有 2 张');

/* 补签后的有效连续天数 */
const s6 = {
  checkins: { '2026-09-14': { tasksDone: true }, '2026-09-16': { tasksDone: true } },
  game: Object.assign(Game.blank(), { makeups: { '2026-09-15': 1 } })
};
eq(Game.effectiveStreak(s6, '2026-09-16').current, 3, '★ 补签日算进连续链：14 + 15(补) + 16 = 3 天');
eq(Game.streakInfo(s6.checkins, '2026-09-16').current, 1, '★ 对照：不认补签时只有 1 天（说明补签确实起了作用）');

/* 打卡有效性口径 */
eq(Game.effectiveStreak({ checkins: { '2026-09-16': { minutes: 30 } }, game: Game.blank() }, '2026-09-16').current, 1,
  '专注 30 分钟也算打卡');
eq(Game.effectiveStreak({ checkins: { '2026-09-16': { minutes: 29 } }, game: Game.blank() }, '2026-09-16').current, 0,
  '专注 29 分钟不算打卡');

/* ============================================================ */
console.log('\n=== 4. 备考节奏投影 ===');

const p0 = Game.paceProjection({}, WORLD, { track: 'math1', today: T, examDate: '' });
eq(p0.total, 6, '总节点 6');
eq(p0.learned, 0, '没学任何节点');
eq(p0.remaining, 6, '剩余 6');
eq(p0.daysLeft, null, '★ 没设考试日期时 daysLeft 是 null（不是 0）');
eq(p0.onTrack, null, '★ 没考试日期时不给"来得及"结论');
eq(p0.projected, null, '没考试日期就推不出投影');
eq(p0.projectedPct, null, '没考试日期就没有百分比');
eq(p0.gap, null, '没考试日期就没有缺口');
eq(p0.windowDays, 14, '统计窗口是 14 天');

const p1 = Game.paceProjection({
  cards: { k1: { createdAt: '2026-09-13' }, k2: { createdAt: '2026-09-12' } }
}, WORLD, { track: 'math1', today: T, examDate: '2026-09-23' });
eq(p1.learned, 2, '已学 2 个');
eq(p1.remaining, 4, '还剩 4 个');
eq(p1.daysLeft, 7, '★ 09-16 → 09-23 是 7 天');
eq(p1.recentLearned, 2, '窗口内新学 2 个');
near(p1.perDay, 2 / 14, 1e-9, '日均 = 2 / 14');
eq(p1.projected, 3, '★ 投影 = 2 + round(0.1428×7) = 3');
eq(p1.projectedPct, 50, '投影覆盖 3/6 = 50%');
eq(p1.suggestedPerDay, 1, '建议每天 1 个（ceil(4/7)）');
eq(p1.onTrack, false, '★ 按当前速度来不及 → onTrack false');
eq(p1.gap, 3, '★ 考前还差 3 个');

/* 窗口外的旧卡片不算进"近期速度" */
const p2 = Game.paceProjection({
  cards: { k1: { createdAt: '2026-01-01' }, k2: { createdAt: '2026-09-13' } }
}, WORLD, { track: 'math1', today: T, examDate: '2026-09-23' });
eq(p2.learned, 2, '总已学仍是 2');
eq(p2.recentLearned, 1, '★ 半年前的卡片不算进近期速度');
near(p2.perDay, 1 / 14, 1e-9, '日均只用近期数据');

/* 全部学完 → 必然来得及 */
const p3 = Game.paceProjection({
  cards: { k1: {}, k2: {}, k3: {}, k4: {}, k5: {}, k6: {} }
}, WORLD, { track: 'math1', today: T, examDate: '2026-09-17' });
eq(p3.remaining, 0, '全部学完');
eq(p3.onTrack, true, '★ 剩余为 0 时一定是来得及（不该因为速度 0 判成落后）');
eq(p3.suggestedPerDay, null, '没剩的就不给每日建议');
eq(p3.projected, 6, '投影封顶在总数，不会算出 7 个');

/* 考试日期已过 → 不出现负数天 */
const p4 = Game.paceProjection({}, WORLD, { track: 'math1', today: T, examDate: '2026-09-01' });
eq(p4.daysLeft, 0, '★ 考试日期已过时 daysLeft 夹到 0，不出现负数');
eq(p4.suggestedPerDay, null, 'daysLeft 为 0 时不建议每日量（避免除零）');

/* ============================================================ */
console.log('\n=== 5. 下一步：只给一个答案 ===');

function na(opts) { return Game.nextAction({}, WORLD, opts); }

eq(na({ dueReview: 3, quizLeft: 2, mistakes: 5, newLeft: 4, learned: 10 }).kind, 'review',
  '有到期复习卡 → 先复习');
eq(na({ dueReview: 3, quizLeft: 2, mistakes: 5, newLeft: 4, learned: 10 }).href, '#/review', '复习指向 /review');
ok(na({ dueReview: 20, quizLeft: 2, mistakes: 5, newLeft: 4, learned: 10 }).weight >
  na({ dueReview: 1, quizLeft: 2, mistakes: 5, newLeft: 4, learned: 10 }).weight,
  '复习卡越多权重越高（堆得越久越该先清）');

eq(na({ quizLeft: 2, mistakes: 5, newLeft: 4, learned: 10 }).kind, 'quiz', '无复习时先做每日一练');
eq(na({ mistakes: 5, newLeft: 4, learned: 10 }).kind, 'mistakes', '无复习无练习时先清错题');

/* 落后时「学新」的权重会被抬到错题之上 */
eq(na({ mistakes: 5, newLeft: 4, learned: 10, onTrack: true }).kind, 'mistakes',
  '★ 进度正常时错题优先于新学');
eq(na({ mistakes: 5, newLeft: 4, learned: 10, onTrack: false }).kind, 'learn',
  '★ 进度落后时新学提到错题之前（来不及了就别慢慢磨错题）');

eq(na({ newLeft: 3, learned: 0 }).kind, 'learn', '只剩新学任务');
eq(na({ learned: 10 }).kind, 'blitz', '★ 都清完了、学过东西 → 推荐闪电战');
eq(na({ learned: 0 }).kind, 'lab', '★ 什么都没学过 → 推荐公式实验室（不是闪电战）');
eq(na({}).href, '#/lab', '兜底一定有一个可点的去处');

/* 无论什么输入，必须返回恰好一个候选，且字段完整 */
[ {}, { dueReview: 5 }, { quizLeft: 1 }, { mistakes: 1 }, { newLeft: 1, learned: 3 }, { learned: 3 } ].forEach(function (o, i) {
  const r = Game.nextAction({}, WORLD, o);
  ok(r && r.kind && r.label && r.reason && r.href && typeof r.weight === 'number',
    '第 ' + (i + 1) + ' 组输入返回完整建议（kind/label/reason/href/weight）');
});

/* ============================================================ */
console.log('\n=== 6. 闪电战计分 ===');

eq(Game.BLITZ_SECONDS, 60, '限时 60 秒');
eq(Game.BLITZ_LIVES, 3, '3 条命');
eq(Game.BLITZ_MAX_MULT, 5, '倍率封顶 5');
eq(Game.blitzMultiplier(0), 1, '连对 0 → ×1');
eq(Game.blitzMultiplier(2), 1, '连对 2 → 还是 ×1');
eq(Game.blitzMultiplier(3), 2, '★ 连对 3 → ×2');
eq(Game.blitzMultiplier(5), 2, '连对 5 → ×2');
eq(Game.blitzMultiplier(6), 3, '连对 6 → ×3');
eq(Game.blitzMultiplier(9), 4, '连对 9 → ×4');
eq(Game.blitzMultiplier(12), 5, '连对 12 → ×5');
eq(Game.blitzMultiplier(30), 5, '★ 连对 30 仍封顶 ×5（不让长局滚雪球）');
eq(Game.blitzMultiplier(-5), 1, '★ 负数连击兜底为 ×1，不出现 ×0 或负数');

const bs = Game.blitzScore({ combo: 7, correct: 9, wrong: 1 });
eq(bs.multiplier, 3, 'blitzScore 带出倍率');
eq(bs.correct, 9, 'blitzScore 带出答对数');

const sb = { game: Game.blank() };
const r1 = Game.recordBlitz(sb, { score: 120, correct: 9, wrong: 1, bestCombo: 7 }, T);
eq(r1.isBest, true, '★ 第一局就是纪录');
eq(sb.game.blitz.score, 120, '纪录写进 state.game.blitz');
eq(sb.game.blitz.date, T, '纪录带日期');

const r2 = Game.recordBlitz(sb, { score: 80, correct: 6, wrong: 3, bestCombo: 3 }, '2026-09-17');
eq(r2.isBest, false, '★ 更差的成绩不覆盖纪录');
eq(sb.game.blitz.score, 120, '★ 纪录仍是 120');
eq(sb.game.blitz.date, T, '★ 纪录日期也没被改掉');

const r3 = Game.recordBlitz(sb, { score: 200, correct: 15, wrong: 0, bestCombo: 15 }, '2026-09-18');
eq(r3.isBest, true, '更好的成绩覆盖纪录');
eq(sb.game.blitz.score, 200, '纪录更新为 200');
eq(r3.best.score, 200, '返回值里的 best 也是最新纪录');

const r4 = Game.recordBlitz({}, { score: 5 }, T);
eq(r4.best.score, 5, '★ 空 state 也能记纪录（自动补骨架）');
eq(Game.ensure({}).blitz, null, '新存档的 blitz 默认是 null（不是 {} 或 0）');

/* ============================================================ */
console.log('\n=== 7. 公式实验室：纯数学层 ===');

const F = Lab.funcById('sq');                       // f(x) = x²/2, f'(x) = x
near(Lab.secantSlope(F.f, 1, 1e-4), 1.00005, 1e-6, '★ 割线斜率 h=1e-4 在 x=1 处 ≈ 1.00005（逼近 f\'(1)=1）');
near(Lab.deriv(F.f, 1), F.df(1), 1e-5, '中心差分求导 ≈ 解析导数 x²/2 → x');
near(Lab.deriv(Math.sin, 0), 1, 1e-6, 'sin 在 0 处导数是 1');
near(Lab.deriv(Math.sin, Math.PI / 2), 0, 1e-6, 'sin 在 π/2 处导数是 0');
near(Lab.secantSlope(F.f, 1, 0), 1, 1e-6, '★ h=0 时退回解析求导，不出现除零得 Infinity');

const sq = function (x) { return x * x; };          // ∫₀¹ x² dx = 1/3
near(Lab.riemannSum(sq, 0, 1, 100, 'mid'), 0.333325, 1e-9, '★ 中点法 n=100 → 0.333325');
near(Lab.riemannSum(sq, 0, 1, 1000, 'mid'), 1 / 3, 1e-6, '★ 中点法 n=1000 已经很接近 1/3');
ok(Lab.riemannSum(sq, 0, 1, 10, 'left') < 1 / 3, '左端点法对递增函数偏小');
ok(Lab.riemannSum(sq, 0, 1, 10, 'right') > 1 / 3, '★ 右端点法对递增函数偏大（这正是要让学生看见的）');
eq(Lab.riemannSum(sq, 0, 1, 0, 'mid'), 0, '★ n=0 返回 0，不死循环也不 NaN');
near(Lab.integrate(sq, 0, 1), 1 / 3, 1e-9, '★ 辛普森法积分 ∫₀¹x² = 1/3');
near(Lab.integrate(Math.sin, 0, Math.PI), 2, 1e-9, '∫₀^π sin = 2');

near(Lab.taylorSin(1, 5), Math.sin(1), 1e-7, '★ 泰勒 5 项在 x=1 处 ≈ sin(1)');
near(Lab.taylorSin(1, 1), 1, 1e-9, '只留 1 项时泰勒 = x');
near(Lab.taylorSin(0, 5), 0, 1e-12, 'x=0 处恒为 0');
ok(Math.abs(Lab.taylorSin(3, 8) - Math.sin(3)) > Math.abs(Lab.taylorSin(1, 8) - Math.sin(1)),
  '★ 离展开点越远误差越大（这是"泰勒局部有效"的可视化依据）');

const seqE = Lab.seqById('e');
eq(Lab.minN(seqE, 0.1), 13, '★ (1+1/n)ⁿ 要在第 13 项起才落进 e±0.1');
eq(Lab.minN(seqE, 1e-12, 50), null, '★ 上限内达不到就返回 null（不假装收敛）');
eq(Lab.minN(Lab.seqById('ratio'), 0.01), 100, 'n/(n+1) 在第 100 项起进入 1±0.01');
eq(Lab.minN(Lab.seqById('alt'), 0.01), 101, '★ (−1)ⁿ/n 取绝对值后在第 101 项起 < 0.01');
eq(Lab.seqById('e').limit, Math.E, 'e 数列的极限标成 e');
eq(Lab.seqById('不存在的 id').id, 'e', '★ 未知 id 兜底到第一个数列，不返回 undefined');

/* ============================================================ */
console.log('\n=== 8. 模块接线（新增模块忘配控件能被测出来）===');

ok(Lab.MODULES.length >= 4, '至少有 4 个实验模块');
Lab.MODULES.forEach(function (m) {
  ok(!!m.id && !!m.nav && !!m.title && !!m.tex && !!m.hook && !!m.note,
    '模块 ' + m.id + ' 元数据齐全（id/nav/title/tex/hook/note）');
  ok(typeof Lab.DRAW[m.id] === 'function', '★ 模块 ' + m.id + ' 有对应的绘制函数');
  ok(Array.isArray(Lab.CONTROLS[m.id]) && Lab.CONTROLS[m.id].length > 0,
    '★ 模块 ' + m.id + ' 配了可调控件（否则画布是死的）');
  const d = Lab.defaultsFor(m.id);
  ok(d && typeof d === 'object', '模块 ' + m.id + ' 有默认参数');
  Lab.CONTROLS[m.id].forEach(function (c) {
    ok(d[c.k] !== undefined, '模块 ' + m.id + ' 的控件 ' + c.k + ' 在默认参数里有值');
    if (c.type === 'range') {
      ok(typeof c.min === 'number' && typeof c.max === 'number' && c.step > 0,
        '模块 ' + m.id + ' 的滑块 ' + c.k + ' 有合法的 min/max/step');
      ok(d[c.k] >= c.min && d[c.k] <= c.max,
        '★ 模块 ' + m.id + ' 的滑块 ' + c.k + ' 默认值落在 [min,max] 内（否则滑块一开就是错的）');
    } else {
      ok(Array.isArray(c.options) && c.options.length > 0,
        '模块 ' + m.id + ' 的下拉 ' + c.k + ' 有选项');
      ok(c.options.some(function (o) { return String(o[0]) === String(d[c.k]); }),
        '★ 模块 ' + m.id + ' 的下拉 ' + c.k + ' 默认值在选项里（否则 select 显示空白）');
    }
  });
  const rg = Lab.rangeFor(m.id);
  ok(Array.isArray(rg) && rg.length === 2 && rg[0].length === 2 && rg[0][0] < rg[0][1],
    '模块 ' + m.id + ' 的视窗范围合法（x 轴 min < max）');
});

/* ---------- 桩 canvas ----------
 * 不引任何绘图库，也不桩掉 plotter —— 让真实的坐标变换代码跑一遍，
 * 这样"Y 轴方向搞反""X 越界"这类错误才测得出来。 */
function makeCtx() {
  let strokes = 0;
  const noop = function () { };
  return {
    setTransform: noop, clearRect: noop, save: noop, restore: noop,
    beginPath: noop, moveTo: noop, lineTo: function () { strokes++; },
    stroke: noop, arc: noop, fill: noop, fillRect: noop, strokeRect: noop,
    setLineDash: noop, fillText: noop,
    strokes: function () { return strokes; },
    strokeStyle: '', lineWidth: 1, fillStyle: '', font: '', textAlign: '', lineJoin: ''
  };
}
function makeCanvas(w, h) {
  const ctx = makeCtx();
  return { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: function () { return ctx; }, _ctx: ctx };
}

/* 坐标变换本身（画对了才谈得上后面） */
const cv0 = makeCanvas(560, 320);
const pl = Lab.plotter(cv0, [-2, 2], [-1, 3]);
eq(cv0.width, 560, '★ dpr=1 时画布宽度 = clientWidth（DPR 适配走了真实分支）');
eq(cv0.height, 320, 'dpr=1 时画布高度 = clientHeight');
eq(pl.X(-2), pl.pad.l, '★ 视窗左边界映射到左内边距');
eq(pl.X(2), pl.w - pl.pad.r, '★ 视窗右边界映射到右内边距');
eq(pl.Y(3), pl.pad.t, '★ 视窗上边界映射到上内边距（Y 轴没有搞反）');
eq(pl.Y(-1), pl.h - pl.pad.b, '★ 视窗下边界映射到下内边距');
near(pl.invX(pl.X(1.234)), 1.234, 1e-9, 'X 与 invX 互为反函数');
eq(pl.Y(1), (pl.Y(3) + pl.Y(-1)) / 2, '★ 纵轴中值映射到正中间（线性）');

/* 绘图函数在真实参数下必须返回 { rows, verdict }，并且真的往画布上画了东西 */
Lab.MODULES.forEach(function (m) {
  const cv = makeCanvas(560, 320);
  const rg = Lab.rangeFor(m.id);
  let out = null, err = null;
  try {
    const p = Lab.plotter(cv, rg[0], rg[1]);
    out = Lab.DRAW[m.id](p, Lab.defaultsFor(m.id));
  } catch (e) { err = String(e && e.message || e); }
  ok(!err, '模块 ' + m.id + ' 的绘制函数在默认参数下不抛异常', err);
  if (!err && out) {
    ok(Array.isArray(out.rows) && out.rows.length > 0, '模块 ' + m.id + ' 返回了读数行');
    ok(typeof out.verdict === 'string' && out.verdict.length > 0, '★ 模块 ' + m.id + ' 给了一句结论（不然拖完滑块不知道学到了什么）');
    ok(out.rows.every(function (r) { return Array.isArray(r) && r.length === 2 && r[0] && r[1] !== undefined; }),
      '模块 ' + m.id + ' 的读数行都是 [标签, 值] 结构');
    ok(cv._ctx.strokes() > 0, '★ 模块 ' + m.id + ' 确实往画布上画了线（不是空画布）');
  }
});

console.log('\n──────────────────────────────');
console.log((fail === 0 ? '✅ 学习引擎 v2 全部通过：' : '❌ 有失败：') + pass + ' 项' + (fail ? '，失败 ' + fail : ''));
process.exit(fail ? 1 : 0);
