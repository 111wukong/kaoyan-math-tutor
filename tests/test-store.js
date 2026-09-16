/* 存档层回归测试（js/store.js）
 *
 * 这一层的存在意义只有一个：**让 attempts 明细可以被安全裁剪**。
 * 所以最重要的一组断言不是"函数没报错"，而是不变式：
 *
 *   「裁剪前算出的掌握度 / 正确率 / 错题数」必须与「裁剪后」完全一致。
 *
 * 这条如果不成立，用户用了几个月之后会看到自己的掌握度莫名其妙退回去 ——
 * 而且不会有任何报错。所以它是本文件的第一个测试段。
 *
 * 另外覆盖：导出包脱敏、导入校验、合并"只增不减"、replace 不冲掉本机模型配置。
 */
'use strict';
const path = require('path');
const BASE = path.join(__dirname, '..');

global.window = {};
require(path.join(BASE, 'js/store.js'));
require(path.join(BASE, 'js/game.js'));
const Store = global.window.Store;
const Game = global.window.Game;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  => ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }

/* ---------- 造数据 ---------- */
const WORLD = {
  chapters: [{ id: 'calc-0', name: '第一章 极限', categoryId: 'calculus', categoryName: '高等数学', color: '#1b4d8f' }],
  nodes: [
    { id: 'c1n1', title: '数列极限', exam: 'all', chapterId: 'calc-0', categoryId: 'calculus' },
    { id: 'c1n2', title: '重要极限', exam: 'all', chapterId: 'calc-0', categoryId: 'calculus' }
  ],
  questions: [
    { id: 'q01', kid: 'c1n1' }, { id: 'q02', kid: 'c1n1' },
    { id: 'q03', kid: 'c1n2' }
  ]
};

let seq = 0;
function mkAttempt(o) {
  seq++;
  const d = o.date || '2026-09-10';
  return {
    id: 'a' + seq, qid: o.qid, kid: o.kid,
    answer: o.answer === undefined ? 'A' : o.answer,
    correct: !!o.correct, context: o.context || 'practice',
    date: d, ts: o.ts !== undefined ? o.ts : Date.parse(d + 'T08:00:00Z') + seq * 1000
  };
}
function baseState(attempts) {
  return {
    attempts: attempts || [], cards: {}, checkins: {}, customQ: [],
    notes: {}, classrooms: {}, cardDeck: {}, chats: {},
    game: { xp: 0, achievements: {}, combo: 0, bestCombo: 0, boss: {}, flags: {}, seen: {} },
    settings: { examTrack: 'math1', llm: { kind: 'cloud', cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat', cloudKey: 'sk-secret', rememberKey: true } }
  };
}

/* 一批"足够真实"的作答：跨 60 天、两个节点、三三分布 */
function sampleAttempts(n) {
  const out = [];
  const qids = [['q01', 'c1n1'], ['q02', 'c1n1'], ['q03', 'c1n2']];
  for (let i = 0; i < n; i++) {
    const [qid, kid] = qids[i % qids.length];
    const day = 1 + (i % 60);
    const date = '2026-07-' + (day < 10 ? '0' + day : day);
    // 刻意制造"每道题都答对过" + 约 5% 错题（正确率 > 90% 才能到 mastered，
    // 用 1/7 的错题率会一直卡在 learning，掌握度那几条断言就变成在比 0）
    out.push(mkAttempt({ qid, kid, correct: (i % 20) !== 0, date, ts: Date.parse(date + 'T08:00:00Z') + i * 1000 }));
  }
  return out;
}

function snapshot(state) {
  /* 必须用 statsOf（权威聚合），不能用 statsFrom（从明细现算）——
     明细裁过之后 statsFrom 只会数到剩下那 2000 条。
     这个区别本身就是本层的设计要点，第 1 段末尾有一条断言专门钉住它。 */
  const st = Store.statsOf(state);
  const rows = WORLD.nodes.map(n => Game.nodeMastery(state, WORLD, n.id));
  const proj = Game.snapshot(state, WORLD, { track: 'math1' });
  return {
    statsN: st.n,
    nodeN: rows.map(r => r.attempts).join(','),
    nodeC: rows.map(r => r.correct).join(','),
    nodeLv: rows.map(r => r.level).join(','),
    nodeSeen: rows.map(r => r.questionsSeen).join(','),
    allRight: rows.map(r => r.allRight).join(','),
    projAttempts: proj.attempts, projCorrect: proj.correct, projWrong: proj.wrong,
    days: Object.keys(st.days).sort().map(d => d + ':' + st.days[d].n + '/' + st.days[d].c).join('|')
  };
}

console.log('\n=== 1. ★ 裁剪不变式：裁掉明细不能改变任何统计口径 ===');
{
  const many = sampleAttempts(5200);                    // 远超 CAP_DETAIL = 2000
  const s = baseState(many);
  Store._resetCache();
  const before = snapshot(s);
  eq(s.attempts.length, 5200, '裁剪前明细是 5200 条');

  const r = Store.trim(s);
  Store._resetCache();
  const after = snapshot(s);

  eq(s.attempts.length, Store.CAP_DETAIL, '裁剪后明细正好是上限 2000 条');
  eq(r.dropped, 3200, '报告丢掉了 3200 条');
  eq(before.statsN, after.statsN, '★ 累计作答次数不变');
  eq(before.nodeN, after.nodeN, '★ 各节点作答次数不变');
  eq(before.nodeC, after.nodeC, '★ 各节点答对次数不变');
  eq(before.nodeLv, after.nodeLv, '★ 各节点掌握度等级不变');
  eq(before.nodeSeen, after.nodeSeen, '★ 各节点已见题数不变');
  eq(before.allRight, after.allRight, '★ 「每道题都答对过」判定不变');
  eq(before.projAttempts, after.projAttempts, '★ 备考投影的作答总数不变');
  eq(before.projCorrect, after.projCorrect, '★ 备考投影的正确数不变');
  eq(before.projWrong, after.projWrong, '★ 备考投影的错题数不变');
  eq(before.days, after.days, '★ 逐日统计不变');
  ok(before.nodeLv.indexOf('mastered') >= 0, '这一批数据确实产生了 mastered（否则上面几条是在比 0）', before.nodeLv);

  /* 保留的必须是"最近"的 2000 条，不能留最旧的 */
  eq(s.attempts[0].id, many[3200].id, '★ 留下的是最近的 2000 条（首条 = 原第 3201 条）');
  eq(s.attempts[s.attempts.length - 1].id, many[5199].id, '最后一条仍是最后一条');

  /* ★ 这一条钉住整个设计的支点：
     裁剪之后"从明细现算"一定会偏小，所以 stats 必须是持久化的权威，
     任何消费方都不允许绕过 statsOf 自己去遍历 attempts。 */
  eq(Store.statsFrom(s).n, Store.CAP_DETAIL,
    '★ 对照：裁剪后 statsFrom（只数明细）确实只剩 2000 —— 所以不能用它');
  eq(Store.statsOf(s).n, 5200,
    '★ 而 statsOf（权威聚合）仍然是 5200');
}

console.log('\n=== 2. 聚合等价：增量 bump 与全量重算必须一致 ===');
{
  const many = sampleAttempts(300);
  const s1 = baseState(many);
  const fromScratch = Store.statsFrom(s1);

  const s2 = baseState([]);
  s2.stats = Store.blankStats();
  many.forEach(a => Store.bump(s2.stats, a));

  eq(JSON.stringify(fromScratch), JSON.stringify(s2.stats), '★ 两种算法得到完全相同的聚合');

  const s3 = baseState(many);
  const inc = Store.statsFrom(baseState(many.slice(0, 100)));
  many.slice(100).forEach(a => Store.bump(inc, a));
  eq(JSON.stringify(inc), JSON.stringify(fromScratch), '★ 先算前 100 条再增量补完，结果也一样');
}

console.log('\n=== 3. pushAttempt：顺序错了就会丢计数 ===');
{
  const s = baseState([]);
  Store.ensure(s);
  const rec = mkAttempt({ qid: 'q01', kid: 'c1n1', correct: true, date: '2026-09-14' });
  Store.pushAttempt(s, rec);
  eq(s.attempts.length, 1, '明细里有 1 条');
  eq(s.stats.n, 1, '★ 聚合里也记了 1 次（先 push 后 bump，顺序不能反）');
  eq(Store.nodeStat(s.stats, 'c1n1').n, 1, '节点计数跟上');
  eq(s.stats.qs['q01'].ok, 1, '该题最后一次答对');
  eq(s.stats.today.date, '2026-09-14', 'today 桶跟着走');
  eq(Store.todayCount(s.stats, 'q01', '2026-09-14'), 1, '当日该题次数 = 1');

  Store.pushAttempt(s, mkAttempt({ qid: 'q01', kid: 'c1n1', correct: false, date: '2026-09-14' }));
  eq(Store.todayCount(s.stats, 'q01', '2026-09-14'), 2, '同一天再答一次，当日次数 = 2');
  eq(s.stats.qs['q01'].ok, 0, '★ 最后一次是错的，ok 要翻成 0');
  eq(Store.todayCount(s.stats, 'q01', '2026-09-15'), 0, '★ 换一天，当日次数归零');
}

console.log('\n=== 4. 坏存档与边界 ===');
{
  const s = baseState([]);
  Store.ensure(s);
  ok(Store.isStats(s.stats), '空存档也补出合法 stats');
  eq(s.stats.n, 0, '空存档累计 0 次');

  const bad = baseState([mkAttempt({ qid: 'q01', kid: 'c1n1', correct: true })]);
  bad.stats = { v: 1, n: 0, nodes: {}, qs: {}, days: {}, today: { date: '', q: {} } };
  Store._resetCache();
  eq(Store.statsOf(bad).n, 1, '★ stats 落后于明细（n=0 < 明细 1 条）时自动重算，不用坏数据');

  const noStats = baseState([mkAttempt({ qid: 'q01', kid: 'c1n1', correct: true })]);
  Store._resetCache();
  eq(Store.statsOf(noStats).n, 1, '没有 stats 字段时从明细现算（老存档路径）');

  Store._resetCache();
  eq(Store.statsOf(null).n, 0, 'null state 返回空聚合，不炸');

  /* 没有 ts 的记录（手搓数据）也要让后写的覆盖先写的 */
  const nots = baseState([]);
  nots.stats = Store.blankStats();
  Store.bump(nots.stats, { qid: 'qX', kid: 'cX', correct: true, date: 'd1' });
  Store.bump(nots.stats, { qid: 'qX', kid: 'cX', correct: false, date: 'd1' });
  eq(nots.stats.qs['qX'].ok, 0, '★ 没有 ts 时按写入顺序，后写的覆盖先写的');

  const days = baseState([]);
  days.stats = Store.blankStats();
  for (let i = 0; i < Store.CAP_DAYS + 40; i++) {
    Store.bump(days.stats, { qid: 'q1', kid: 'k1', correct: true, date: '2020-01-01', ts: i + 1 });
  }
  ok(true, '（days 封顶在下一段单独验，这里只确认大量同日写入不炸）');
}

console.log('\n=== 5. 逐日桶封顶 ===');
{
  const s = baseState([]);
  s.stats = Store.blankStats();
  const N = Store.CAP_DAYS + 60;
  for (let i = 0; i < N; i++) {
    const d = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
    Store.bump(s.stats, { qid: 'q1', kid: 'k1', correct: true, date: d, ts: Date.parse(d + 'T00:00:00Z') });
  }
  eq(Object.keys(s.stats.days).length, N, '写入后有 ' + N + ' 天');
  const totalBefore = s.stats.n;
  Store.trim(s);
  eq(Object.keys(s.stats.days).length, Store.CAP_DAYS, '★ 逐日桶被裁到上限');
  eq(s.stats.n, totalBefore, '★ 裁逐日桶不影响累计次数');
  ok(!s.stats.days['2020-01-01'], '裁掉的是最早的那天');
  ok(!!s.stats.days[Object.keys(s.stats.days).sort().pop()], '最近的那天还在');
}

console.log('\n=== 6. 用量统计 ===');
{
  const s = baseState(sampleAttempts(120));
  Store.ensure(s);
  const u = Store.usage(s, false);
  eq(u.attempts, 120, '明细条数');
  eq(u.totalAttempts, 120, '累计次数');
  eq(u.cap, Store.CAP_DETAIL, '上限暴露出来给界面用');
  eq(u.ratio, null, '★ 没探测配额时 ratio 是 null，不编一个假比例出来');
  ok(u.kb >= 1, '体积换算成 KB（' + u.kb + '）');
  ok(u.chars > 0, '字符数 > 0');

  /* 实测：50 条/天 × 365 天 在旧实现下会逼近配额；现在明细封顶，
     所以体积不随使用时长线性增长。 */
  const big = baseState(sampleAttempts(5000));
  Store.ensure(big);
  const u2 = Store.usage(big, false);
  eq(u2.attempts, Store.CAP_DETAIL, '★ 5000 条入库后明细仍被压在 2000');
  eq(u2.totalAttempts, 5000, '★ 累计次数如实记录 5000');
  ok(u2.kb < 900, '★ 存档体积被压住（' + u2.kb + ' KB），不会随使用年限线性膨胀');
}

console.log('\n=== 7. 导出包：默认不带走 API Key ===');
{
  const s = baseState(sampleAttempts(10));
  Store.ensure(s);
  s.settings.lastExportAt = '2026-09-14T10:00:00Z';

  const b = Store.bundle(s, { version: '1.0' });
  eq(b.app, 'kaoyan-math-tutor', '带应用标识');
  eq(b.schema, Store.SCHEMA, '带 schema 版本');
  eq(b.data.settings.llm.cloudKey, '', '★ 导出包里的 API Key 被清空');
  eq(b.data.settings.llm.rememberKey, false, '★ 记住 Key 的开关也复位');
  eq(b.keyStripped, true, '★ 标记了"已剥离 Key"，导出后要能告诉用户');
  eq(b.data.attempts.length, 10, '作答记录带上了');
  ok(b.stats && b.stats.n === 10, '聚合也带上（导入时可以少算一次）');

  const bk = Store.bundle(s, { version: '1.0', withKey: true });
  eq(bk.data.settings.llm.cloudKey, 'sk-secret', '显式要求时才带 Key');
  eq(bk.keyStripped, false, '带 Key 时不标 stripped');

  const noKeyState = baseState([]);
  noKeyState.settings.llm.cloudKey = '';
  const b2 = Store.bundle(noKeyState, {});
  eq(b2.keyStripped, false, '本来就没有 Key 时不谎报 stripped');

  ok(/^研数备份-\d{8}-\d{4}\.json$/.test(Store.fileName(new Date(2026, 8, 14, 9, 5))),
    '文件名带日期时间（' + Store.fileName(new Date(2026, 8, 14, 9, 5)) + '）');
}

console.log('\n=== 8. 导入校验：坏文件要在动手之前被挡住 ===');
{
  const good = Store.bundle(baseState(sampleAttempts(5)), {});

  eq(Store.validate(good).ok, true, '合法备份通过');
  eq(Store.validate(good).summary.attempts, 5, '预览里给出作答条数');

  eq(Store.validate(null).ok, false, 'null 被拒');
  eq(Store.validate('x').ok, false, '字符串被拒');
  eq(Store.validate({}).ok, false, '空对象被拒');
  ok(Store.validate({ app: 'other-app', schema: 1, data: {} }).errors.join()
    .indexOf('研数') >= 0, '别的应用的备份被拒，且说明原因');

  const future = Store.bundle(baseState([]), {});
  future.schema = Store.SCHEMA + 5;
  ok(Store.validate(future).errors.join().indexOf('更新的版本') >= 0,
    '★ 更高 schema 版本被拒（不能让新版备份被老版静默吃坏）');

  const noData = Store.bundle(baseState([]), {});
  delete noData.data;
  eq(Store.validate(noData).ok, false, '缺 data 段被拒');

  const badArr = Store.bundle(baseState([]), {});
  badArr.data.attempts = { not: 'array' };
  eq(Store.validate(badArr).ok, false, 'attempts 不是数组被拒');

  const badObj = Store.bundle(baseState([]), {});
  badObj.data.cards = [1, 2, 3];
  eq(Store.validate(badObj).ok, false, 'cards 不是对象被拒');

  const s2 = Store.bundle(baseState([]), {});
  s2.data.attempts = [{ qid: 'q1', kid: 'k1', correct: true, date: '2026-09-01', ts: 1 }];
  const v = Store.validate(s2);
  eq(v.ok, true, '只有一天记录也算合法');
  eq(v.summary.firstDay, '2026-09-01', '预览给出起始日期');
}

console.log('\n=== 9. 合并导入：只增不减 ===');
{
  const mine = baseState([
    mkAttempt({ qid: 'q01', kid: 'c1n1', correct: true, date: '2026-09-01', ts: 1000 }),
    mkAttempt({ qid: 'q02', kid: 'c1n1', correct: false, date: '2026-09-02', ts: 2000 })
  ]);
  mine.cards = { c1n1: { knowledgeId: 'c1n1', reps: 3, lastReview: 5000 } };
  mine.checkins = { '2026-09-01': { minutes: 10 } };
  mine.customQ = [{ id: 'cq1', stem: 'a' }];
  mine.game.xp = 300;
  mine.game.achievements = { a1: true };
  Store.ensure(mine);

  const theirs = baseState([
    mkAttempt({ qid: 'q02', kid: 'c1n1', correct: true, date: '2026-09-03', ts: 3000 }),
    mkAttempt({ qid: 'q03', kid: 'c1n2', correct: true, date: '2026-09-04', ts: 4000 })
  ]);
  theirs.cards = {
    c1n1: { knowledgeId: 'c1n1', reps: 9, lastReview: 9000 },   // 更靠后 → 应该赢
    c1n2: { knowledgeId: 'c1n2', reps: 1, lastReview: 4000 }    // 本机没有 → 应该补进来
  };
  theirs.checkins = { '2026-09-01': { minutes: 25 }, '2026-09-05': { minutes: 5 } };
  theirs.customQ = [{ id: 'cq1', stem: 'a' }, { id: 'cq2', stem: 'b' }];
  theirs.game.xp = 900;
  theirs.game.achievements = { a2: true };
  theirs.settings.llm.cloudModel = 'moonshot-v1-8k';            // 不该覆盖本机

  Store.applyBundle(mine, Store.bundle(theirs, {}), 'merge');
  Store._resetCache();

  eq(mine.attempts.length, 4, '★ 作答并集 = 4 条（重叠的那条没被重复计入）');
  eq(mine.stats.n, 4, '★ 聚合跟着重算成 4');
  eq(mine.cards.c1n1.reps, 9, '★ 同一张卡片取复习进度更靠后的那次');
  eq(mine.cards.c1n2.reps, 1, '本机没有的卡片补了进来');
  eq(mine.checkins['2026-09-01'].minutes, 25, '★ 同一天打卡取分钟数大的');
  eq(mine.checkins['2026-09-05'].minutes, 5, '本机没有的那天补了进来');
  eq(mine.customQ.length, 2, '自定义题库按 id 并集');
  eq(mine.game.xp, 900, '★ XP 取更大的（合并不能让进度倒退）');
  eq(mine.game.achievements.a1, true, '★ 本机成就保留');
  eq(mine.game.achievements.a2, true, '★ 对方成就也并进来');
  eq(mine.settings.llm.cloudModel, 'deepseek-chat', '★ 导入别人的存档不会冲掉本机的模型配置');
  eq(mine.settings.llm.cloudKey, 'sk-secret', '★ 本机 Key 也还在');
  ok(mine.attempts[0].ts <= mine.attempts[mine.attempts.length - 1].ts, '合并后按时间重排');

  /* 幂等：同一份合并两次不该翻倍 */
  const n1 = mine.attempts.length, xp1 = mine.game.xp;
  Store.applyBundle(mine, Store.bundle(theirs, {}), 'merge');
  Store._resetCache();
  eq(mine.attempts.length, n1, '★ 重复合并同一份备份，条数不翻倍');
  eq(mine.game.xp, xp1, '★ XP 也不会翻倍');
}

console.log('\n=== 10. 覆盖导入：换存档但保住本机模型配置 ===');
{
  const mine = baseState([mkAttempt({ qid: 'q01', kid: 'c1n1', correct: true, date: '2026-09-01', ts: 1000 })]);
  mine.game.xp = 5000;
  Store.ensure(mine);

  const theirs = baseState([mkAttempt({ qid: 'q03', kid: 'c1n2', correct: true, date: '2026-08-01', ts: 500 })]);
  theirs.game.xp = 42;
  theirs.settings.llm = { kind: 'local', cloudKey: '', cloudBase: 'https://other', cloudModel: 'other' };

  Store.applyBundle(mine, Store.bundle(theirs, {}), 'replace');
  Store._resetCache();

  eq(mine.attempts.length, 1, '★ 覆盖后只剩对方的记录');
  eq(mine.attempts[0].qid, 'q03', '确实是对方的记录');
  eq(mine.game.xp, 42, 'XP 被覆盖');
  eq(mine.stats.n, 1, '★ 聚合重算成 1（不是两边相加）');
  eq(mine.settings.llm.cloudKey, 'sk-secret', '★ 本机 API Key 保住了');
  eq(mine.settings.llm.cloudModel, 'deepseek-chat', '★ 本机模型配置保住了');
}

console.log('\n=== 11. 合并后仍然满足裁剪不变式 ===');
{
  const a = baseState(sampleAttempts(3000));
  const b = baseState(sampleAttempts(3000).map((x, i) => Object.assign({}, x, { id: 'b' + i, ts: x.ts + 5000000 })));
  Store.ensure(a);
  Store.applyBundle(a, Store.bundle(b, {}), 'merge');
  Store._resetCache();

  const before = snapshot(a);
  eq(a.attempts.length, Store.CAP_DETAIL, '合并后明细被重新裁到上限');
  Store.trim(a);
  Store._resetCache();
  const after = snapshot(a);
  eq(before.statsN, after.statsN, '★ 合并 + 裁剪之后累计次数依然不变');
  eq(before.nodeLv, after.nodeLv, '★ 掌握度依然不变');
  ok(before.statsN > Store.CAP_DETAIL, '这一批确实超过了明细上限（' + before.statsN + '）');
}

console.log('\n=== 12. 存储不可用时的兜底 ===');
{
  const saved = global.localStorage;
  global.localStorage = {
    setItem() { const e = new Error('denied'); e.name = 'SecurityError'; throw e; },
    getItem() { return null; },
    removeItem() {}
  };
  eq(Store.available(), false, '★ 存储被禁用时 available() 返回 false，不抛异常');
  global.localStorage = saved;

  const s = baseState([]);
  s.stats = Store.blankStats();
  Store.bump(s.stats, null);
  eq(s.stats.n, 0, 'bump(null) 不炸也不计数');
  eq(Store.statsOf(undefined).n, 0, 'statsOf(undefined) 返回空聚合');
  eq(Store.todayCount(null, 'q1', 'd'), 0, 'todayCount 传 null 返回 0');
  eq(Store.nodeStat(null, 'k').n, 0, 'nodeStat 传 null 返回零值');
  eq(Store.wrongLastCount(null), 0, 'wrongLastCount 传 null 返回 0');
  eq(Store.ensure(null), null, 'ensure(null) 原样返回');
  eq(Store.trim(null).dropped, 0, 'trim(null) 不炸');
}

console.log('\n=== 13. 与 Game 的接线（口径不能各算各的）===');
{
  const many = sampleAttempts(4200);
  const s = baseState(many);
  Store.ensure(s);
  Store._resetCache();

  const ns = Store.nodeStat(Store.statsOf(s), 'c1n1');
  const m = Game.nodeMastery(s, WORLD, 'c1n1');
  eq(m.attempts, ns.n, '★ Game.nodeMastery 的作答数与聚合一致');
  eq(m.correct, ns.c, '★ 答对数一致');
  eq(m.questionsSeen, 2, '★ 该节点下 2 道题都答过（明细裁掉后仍成立）');
  eq(m.allRight, true, '★ 两道题都答对过');

  const proj = Game.snapshot(s, WORLD, { track: 'math1' });
  eq(proj.attempts, Store.statsOf(s).n, '★ 仪表盘快照的作答总数 = 全量累计');
  eq(proj.wrong, Store.wrongLastCount(Store.statsOf(s)), '★ 快照的错题口径 = 聚合口径');

  /* answerXp 的"今日第几次"也要走聚合 */
  const s2 = baseState([]);
  Store.ensure(s2);
  const today = new Date().getFullYear() + '-' +
    ('0' + (new Date().getMonth() + 1)).slice(-2) + '-' + ('0' + new Date().getDate()).slice(-2);
  const xp1 = Game.answerXp(s2, 'q01', 'c1n1', { today: today, world: WORLD });
  eq(xp1.nthToday, 1, '第一次作答 nthToday = 1');
  Store.pushAttempt(s2, mkAttempt({ qid: 'q01', kid: 'c1n1', correct: true, date: today }));
  const xp2 = Game.answerXp(s2, 'q01', 'c1n1', { today: today, world: WORLD });
  eq(xp2.nthToday, 2, '★ 同一题再答，nthToday = 2（读的是聚合不是明细）');
}

console.log('\n──────────────────────────────');
if (fail === 0) console.log('✅ 存档层全部通过：' + pass + ' 项');
else console.log('❌ 有失败：' + pass + ' 项，失败 ' + fail);
process.exit(fail ? 1 : 0);
