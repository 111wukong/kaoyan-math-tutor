/* 知识图谱与根因诊断测试
 *
 * ── 这个套件为什么自己建库 ────────────────────────────────────────
 * 图算法和诊断都是**纯函数 + 数据库**，不走 HTTP。
 * 借 run-all 起好的服务来测的话，得先注册账号、再一道道答题造数据 ——
 * 为了验一个「回溯对不对」要发几十个请求，慢且脆。
 * 这里直接把库指到临时文件，构造完数据直接调函数。
 *
 * ── 为什么断言集中在「不该推什么」而不是「推了什么」 ──────────────
 * 推荐类逻辑最容易出的错不是「没推」，而是**推了不该推的**：
 * 把已经掌握的前置当根因、把前置没学的节点塞进学习路径。
 * 所以下面有一半断言是反着写的（ok(!roots.some(...))）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `kmt-graph-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP;

const { db, initSchema, rebuildStats } = await import('../server/src/db/index.js');
const { seed } = await import('../server/src/db/seed.js');
const { migrate } = await import('../server/src/db/migrate.js');
const {
  getGraph, invalidateGraph, ancestors, descendants, impactOf,
  topoOrder, findCyclesIn, findCycles, nodeContext, graphPayload,
} = await import('../server/src/lib/graph.js');
const { diagnoseRoots, nextToLearn, graphHealth } = await import('../server/src/lib/diagnose.js');
const { getTree } = await import('../server/src/lib/game.js');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; } else { fail += 1; console.error(`  \x1b[31m✗\x1b[0m ${msg}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

/* ---------- 准备数据 ---------- */
seed({ quiet: true });
initSchema();

const tree = getTree();
const nodeIds = new Set(tree.nodes.map((n) => n.id));

function makeUser(email) {
  const info = db.prepare(`INSERT INTO users (email,username,password_hash,password_salt,avatar_hue)
    VALUES (?,?,?,?,?)`).run(email, email, 'x', 'y', 0);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(id);
  db.prepare('INSERT OR IGNORE INTO llm_settings (user_id) VALUES (?)').run(id);
  db.prepare('INSERT OR IGNORE INTO game_state (user_id) VALUES (?)').run(id);
  return id;
}

let clock = Date.now();
const qOf = (kid) => db.prepare('SELECT id FROM questions WHERE kid = ? LIMIT 1').get(kid)?.id;

/** 造一次作答：同时写 attempts 明细与两张聚合表，口径与 study.js 一致。 */
function answer(userId, kid, correct) {
  const qid = qOf(kid);
  if (!qid) throw new Error(`没有 ${kid} 的题，测试数据不成立`);
  const ts = clock++;
  db.prepare(`INSERT INTO attempts (id,user_id,qid,kid,answer,correct,context,date,ts)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('a' + ts, userId, qid, kid, correct ? 'A' : 'B', correct ? 1 : 0, 'quiz', '2026-09-18', ts);
  db.prepare(`INSERT INTO stats_node (user_id,kid,n,c,ts) VALUES (?,?,1,?,?)
    ON CONFLICT(user_id,kid) DO UPDATE SET n = n + 1, c = c + excluded.c, ts = excluded.ts`)
    .run(userId, kid, correct ? 1 : 0, ts);
  db.prepare(`INSERT INTO stats_question (user_id,qid,kid,n,c,ok,ts) VALUES (?,?,?,1,?,?,?)
    ON CONFLICT(user_id,qid) DO UPDATE SET n = n + 1, c = c + excluded.c, ok = excluded.ok, ts = excluded.ts`)
    .run(userId, qid, kid, correct ? 1 : 0, correct ? 1 : 0, ts);
}

/* ══════════════════════════════════════════════════════════════════ */
section('一、图谱数据完整性');

const g = getGraph();
ok(g.edgeCount > 80, `边数应超过 80，实际 ${g.edgeCount}`);

/* 无环是硬要求：有环的话 topoOrder 会静默少返回节点，推荐会漏掉一整片 */
const cycles = findCycles();
ok(cycles.length === 0, `prereq 子图不该有环，实际发现 ${cycles.length} 个：${cycles.map((c) => c.join('→')).join('、')}`);

/* 悬空边：指向不存在的知识点，会让诊断走到一个没有标题的空节点 */
const health = graphHealth();
ok(health.dangling.length === 0, `不该有悬空边，实际 ${health.dangling.join('、')}`);
ok(health.isolated.length === 0, `不该有完全孤立的知识点，实际 ${health.isolated.join('、')}`);

/* 每种边类型都要有。confusable 为 0 的话「易混辨析」这条产品线是空的 */
ok(health.byType.prereq > 0, 'prereq 边不能为空');
ok((health.byType.confusable || 0) > 0, 'confusable 边不能为空');

/* 每条边都要有 reason —— 没有理由的边，人工审核时没法判断对错 */
const noReason = g.edges.filter((e) => !e.reason || !e.reason.trim());
ok(noReason.length === 0, `${noReason.length} 条边没写 reason`);

/* 覆盖率：大部分节点该有前置。全是根节点的话图谱等于没建 */
const withPrereq = new Set(g.edges.filter((e) => e.type === 'prereq').map((e) => e.to_kid));
ok(withPrereq.size >= nodeIds.size * 0.8,
  `至少 80% 的知识点应有前置，实际 ${withPrereq.size}/${nodeIds.size}`);

/* ══════════════════════════════════════════════════════════════════ */
section('二、图遍历与拓扑');

/* 洛必达（c2n5）的祖先里必须有求导法则（c2n2）和极限定义（c1n1）——
 * 前者同章、后者跨章，跨章那条正是「根因可能在别的章节」的证明 */
const anc = ancestors('c2n5');
ok(anc.has('c2n2'), '洛必达的祖先应包含求导法则');
ok(anc.has('c1n1'), '洛必达的祖先应包含数列极限的定义（跨章节）');
ok(!anc.has('c2n5'), '祖先集合不该包含自己');

/* 反向：极限定义的后代里必须有洛必达 */
const des = descendants('c1n1');
ok(des.has('c2n5'), '极限定义的后代应包含洛必达');

/* 影响面：极限是整棵树的地基，影响面必须显著大于傅里叶级数（末章叶子） */
ok(impactOf('c1n1') > impactOf('c6n3'),
  `极限的影响面应大于傅里叶级数，实际 ${impactOf('c1n1')} vs ${impactOf('c6n3')}`);

/* 拓扑序：每条 prereq 边都必须「前置排在后面之前」。
 * 这一条是整个路径推荐的地基 —— 排序错了，推荐就全错。 */
const order = topoOrder([...nodeIds]);
const idx = new Map(order.map((id, i) => [id, i]));
const badOrder = g.edges
  .filter((e) => e.type === 'prereq')
  .filter((e) => !(idx.has(e.from_kid) && idx.has(e.to_kid) && idx.get(e.from_kid) < idx.get(e.to_kid)));
ok(badOrder.length === 0, `${badOrder.length} 条边违反拓扑序：${badOrder.slice(0, 3).map((e) => `${e.from_kid}→${e.to_kid}`).join('、')}`);
ok(order.length === nodeIds.size, `拓扑序应覆盖全部 ${nodeIds.size} 个节点，实际 ${order.length}`);

/* 环检测本身要有效 —— 造一个环，必须被抓出来。
 * 不加这条的话，findCyclesIn 里写错方向也会一直返回「无环」，测试照样绿。 */
const fake = [
  { from: 'x', to: 'y', type: 'prereq' },
  { from: 'y', to: 'z', type: 'prereq' },
  { from: 'z', to: 'x', type: 'prereq' },
];
ok(findCyclesIn(fake).length > 0, '环检测必须能抓出人为构造的三节点环');
ok(findCyclesIn([{ from: 'x', to: 'y', type: 'prereq' }]).length === 0, '无环图不该被误报');

/* confusable 是双向语义：c2n5 与 c2n6 互为易混 */
const c25 = nodeContext('c2n5');
ok(c25.confusable.some((x) => x.kid === 'c2n6'), '洛必达的易混里应有泰勒公式');
ok(c25.prerequisites.some((x) => x.kid === 'c2n2'), '洛必达的前置里应有求导法则');
ok(c25.impact > 0, '洛必达的影响面应大于 0');

const payload = graphPayload();
ok(payload.counts.total === g.edgeCount, 'graphPayload 的边数应与图一致');

/* ══════════════════════════════════════════════════════════════════ */
section('三、根因回溯诊断');

/* 场景 A：导数定义（c2n1）已掌握，求导法则（c2n2）没打牢，洛必达（c2n5）出错。
 * 期望：根因指向 c2n2，且**不能**指向已经熟练的 c2n1。 */
const uA = makeUser('a@test.local');
for (let i = 0; i < 3; i++) answer(uA, 'c2n1', true);      // 已掌握
for (let i = 0; i < 3; i++) answer(uA, 'c2n2', i === 0);   // 3 次 1 对 → learning
answer(uA, 'c2n5', false);                                  // 错题
answer(uA, 'c2n5', false);

const dA = diagnoseRoots(uA, { limit: 10 });
ok(dA.symptomCount >= 2, `场景 A 至少应识别出 2 个症状，实际 ${dA.symptomCount}`);
ok(dA.roots.some((r) => r.nodeId === 'c2n2'), '根因应包含求导法则');
ok(!dA.roots.some((r) => r.nodeId === 'c2n1'),
  '已掌握（proficient）的前置不该被当成根因 —— 这是「别推荐你早会的东西」的保证');
ok(dA.roots.every((r) => r.score > 0), '所有根因的分数应为正');

/* 排序：分数必须单调不增，否则前端截断 top N 会漏掉真根因 */
const scores = dA.roots.map((r) => r.score);
ok(scores.every((s, i) => i === 0 || scores[i - 1] >= s), '根因应按分数降序');

/* 每个根因都要能说清「为什么」—— 说不清就等于没诊断 */
ok(dA.roots.every((r) => r.why && r.why.length > 10), '每条根因都要有 why 文案');
ok(dA.roots.every((r) => Array.isArray(r.coveredSymptoms) && r.coveredSymptoms.length > 0),
  '每条根因都要列出它覆盖了哪些症状节点');

/* 场景 B：把前置也练熟，根因就不该再指向它。
 * 没有这条，场景 A 的断言可能是「碰巧命中」而不是逻辑真的在起作用。 */
const uB = makeUser('b@test.local');
for (let i = 0; i < 4; i++) answer(uB, 'c2n2', true);   // 4 次全对 → proficient
answer(uB, 'c2n5', false);
answer(uB, 'c2n5', false);
const dB = diagnoseRoots(uB, { limit: 10 });
ok(!dB.roots.some((r) => r.nodeId === 'c2n2'),
  '前置练熟之后就不该再被诊断为根因');

/* 场景 C：完全没作答 → 不该瞎猜 */
const uC = makeUser('c@test.local');
const dC = diagnoseRoots(uC, { limit: 10 });
ok(dC.roots.length === 0 && dC.symptomCount === 0, '没有作答记录时应返回空诊断而不是编造');

/* kind 字段：未学过是 gap，学过但没打牢是 weak —— 两者该去做的动作完全不同 */
const uD = makeUser('d@test.local');
answer(uD, 'c2n5', false);
answer(uD, 'c2n5', false);
const dD = diagnoseRoots(uD, { limit: 10 });
ok(dD.roots.every((r) => r.kind === 'gap' || r.kind === 'weak'), 'kind 只能是 gap 或 weak');
ok(dD.roots.some((r) => r.kind === 'gap'), '没学过的前置应被标为 gap');

/* ── 实证必须压过推测 ──────────────────────────────────────────────
 * 这是端到端验证时抓出来的真 bug：
 * 「从没作答过」的节点 accuracy 也是 0，于是缺口算成满分 1，
 * 把「你求导法则 0 分」这种**实证问题**压到了第二位，
 * 而第一名是「你没碰过导数定义」—— 后者完全可能早就会了。
 *
 * 修法是给未作答节点的缺口打折（GAP_UNKNOWN = 0.5）。
 * 下面这条断言就是钉死它：有实证 weak 根因时，纯 gap 不许排第一。 */
const uF = makeUser('f@test.local');
for (let i = 0; i < 3; i++) answer(uF, 'c2n2', false);   // 求导法则：3 次全错
answer(uF, 'c2n5', false);                                // 洛必达：错
answer(uF, 'c2n5', false);

const dF = diagnoseRoots(uF, { limit: 10 });
ok(dF.roots.length > 0, '场景 F 应产出根因');
ok(dF.roots[0]?.nodeId === 'c2n2',
  `做错过（实证）的前置应排第一，实际第一是 ${dF.roots[0]?.nodeId}（kind=${dF.roots[0]?.kind}，score=${dF.roots[0]?.score}）`);
ok(dF.roots[0]?.kind === 'weak', '求导法则做过且全错，应判为 weak 而不是 gap');
ok(dF.roots.some((r) => r.kind === 'gap'),
  '纯未学过的前置仍应出现（打折不等于清零），只是不该排第一');

/* ── 硬前置不及格时，后继不许被推荐 ────────────────────────────────
 * 另一个端到端抓出来的 bug：旧口径只拦 level === 'new' 的前置，
 * 于是「求导法则正确率 0%」照样放行洛必达 —— 系统推荐的还是「硬上」。
 * 换汤不换药，正是这个功能本来要治的病。 */
const nF = nextToLearn(uF, { limit: 20 });
ok(!nF.items.some((x) => x.nodeId === 'c2n5'),
  '硬前置（求导法则）正确率为 0 时，洛必达不该被推荐');
ok(nF.blockedSample.some((b) => b.nodeId === 'c2n5'),
  '被卡住的节点应出现在 blockedSample 里，否则用户不知道「为什么没推荐这个」');
ok(nF.blockedSample.every((b) => b.blockers.length > 0),
  'blockedSample 每项都要说明是被谁卡住的');

/* ── 诊断与推荐不能自相矛盾 ────────────────────────────────────────
 * 第三个端到端抓出来的问题：roots 说「先补求导法则」，
 * path 却因为求导法则的前置（导数定义）也没学而把它拦掉，
 * 转头推荐「去学行列式」—— 两个接口各说各话。
 *
 * 修法是让根因豁免 blockers 拦截：根因是用户**实际做错过**的地方，
 * 证据强于「拓扑序上还没轮到」。 */
ok(nF.items.some((x) => x.isRoot), '推荐里必须包含回溯出来的根因');
ok(nF.items[0]?.isRoot,
  `根因应排在推荐第一位，实际第一位是 ${nF.items[0]?.nodeId}（isRoot=${nF.items[0]?.isRoot}）`);
ok(nF.items[0]?.nodeId === 'c2n2', '第一位应是求导法则（用户实际做错的那个）');

/* 根因在推荐里的相对顺序必须与诊断排名一致。
 * 给所有根因同一个加分会让他们同分，再被拓扑序打乱 ——
 * 于是「诊断说这是第 2 根因，推荐把它排到第 4」，两个接口各说各话。 */
const pathRoots = nF.items.filter((x) => x.isRoot).map((x) => x.nodeId);
const diagOrder = dF.roots.map((r) => r.nodeId).filter((id) => pathRoots.includes(id));
ok(JSON.stringify(pathRoots) === JSON.stringify(diagOrder),
  `推荐里根因的顺序应与诊断排名一致：推荐 [${pathRoots.join('>')}] vs 诊断 [${diagOrder.join('>')}]`);

/* ══════════════════════════════════════════════════════════════════ */
section('四、拓扑序学习路径');

const uE = makeUser('e@test.local');
const nE = nextToLearn(uE, { limit: 5 });
ok(nE.items.length > 0, '空白用户应能拿到推荐');
ok(nE.items.length <= 5, 'limit 应生效');

/* 核心断言：推荐出来的节点，它的硬前置不能还是「未学」状态。
 * 这就是旧逻辑（纯难度排序）会犯的错 —— 把泰勒推给连导数定义都含糊的人。 */
const prereqNew = nE.items.filter((it) => {
  const pre = (getGraph().in.get(it.nodeId) || []).filter((e) => e.type === 'prereq' && e.strength === 'hard');
  return pre.some((e) => {
    const row = db.prepare('SELECT n FROM stats_node WHERE user_id = ? AND kid = ?').get(uE, e.kid);
    return !row || row.n === 0;
  });
});
ok(prereqNew.length === 0,
  `推荐里不该出现「硬前置还没学」的节点，实际有 ${prereqNew.map((x) => x.title).join('、')}`);

ok(nE.blocked > 0, '空白用户应该有大量被前置卡住的节点 —— blocked 为 0 说明判定没生效');

/* 学完第一个之后，推荐应该往前走，而不是原地重复 */
const first = nE.items[0].nodeId;
for (let i = 0; i < 4; i++) answer(uE, first, true);
const nE2 = nextToLearn(uE, { limit: 5 });
ok(!nE2.items.some((x) => x.nodeId === first),
  '已练熟的节点不该继续出现在推荐里');
ok(nE2.blocked < nE.blocked,
  `解锁一个节点后 blocked 应减少：${nE.blocked} → ${nE2.blocked}`);

/* ══════════════════════════════════════════════════════════════════ */
section('五、迁移与数据口径');

/* attempts.error_type：新库要有这列，且默认空串 */
const cols = new Set(db.prepare('PRAGMA table_info(attempts)').all().map((r) => r.name));
ok(cols.has('error_type'), 'attempts 表应有 error_type 列');

const blank = db.prepare('SELECT error_type FROM attempts LIMIT 1').get();
ok(blank && blank.error_type === '', 'error_type 默认应为空串（= 没判过）');

/* migrate 幂等：跑两次不能报错，也不能重复加列 */
let migrateErr = null;
try { migrate(); migrate(); } catch (e) { migrateErr = e; }
ok(!migrateErr, `migrate() 应可重复执行，实际报错：${migrateErr?.message}`);

/* 聚合表能完整重建 —— 诊断依赖 stats_node / stats_question，它们歪了诊断就歪 */
const rebuilt = rebuildStats(uA);
ok(rebuilt.attempts > 0, 'rebuildStats 应返回重建的明细数');
const after = db.prepare('SELECT SUM(n) n FROM stats_node WHERE user_id = ?').get(uA).n;
const actual = db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = ?').get(uA).n;
ok(after === actual, `重建后聚合应等于明细：${after} vs ${actual}`);

/* 重建之后诊断结论必须一致 —— 否则说明诊断偷偷依赖了聚合表的某种偶然状态 */
const dA2 = diagnoseRoots(uA, { limit: 10 });
ok(dA2.roots.some((r) => r.nodeId === 'c2n2'), '重建聚合表后根因结论应保持不变');

/* ══════════════════════════════════════════════════════════════════ */
/* 收摊 */
try {
  db.close();
  fs.rmSync(TMP, { force: true });
  fs.rmSync(TMP + '-wal', { force: true });
  fs.rmSync(TMP + '-shm', { force: true });
} catch { /* 删不掉无所谓，是临时目录 */ }

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ 图谱与诊断：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 图谱与诊断：${pass} 项\x1b[0m`);
