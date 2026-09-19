/* FSRS 调度器测试
 *
 * ── 为什么这些断言值得单独写 ──────────────────────────────────────
 * 调度算法错了**不会报错**：页面照常显示，复习照常能点，
 * 只是间隔一天天变得离谱 —— 要么该复习的永远不出现，要么天天让你重做。
 * 用户要过很久才察觉「怎么老是这几张卡」。
 *
 * 所以这里钉的是三类东西：
 *   1. 定义自洽 —— 稳定度的定义就是「保留率降到 90% 的天数」，
 *      这条不成立的话整套参数都是错的（也说明权重抄错了）
 *   2. 单调性 —— 答得越轻松间隔越长、答错必然变短
 *   3. 老库迁移 —— SM-2 时代的卡不能变成「新卡」重来一遍
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `kmt-fsrs-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP;

const F = await import('../server/src/lib/fsrs.js');
const { db, initSchema } = await import('../server/src/db/index.js');
const { migrate } = await import('../server/src/db/migrate.js');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; } else { fail += 1; console.error(`  \x1b[31m✗\x1b[0m ${msg}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

/** 模拟「到期才复习」：每次把 lastReview 往前推 interval 天。 */
function simulate(rating, rounds) {
  let card = F.newCard('k1', null, 'knowledge');
  const intervals = [];
  const stabilities = [];
  for (let i = 0; i < rounds; i += 1) {
    const next = F.grade(card, rating);
    intervals.push(next.interval);
    stabilities.push(next.stability);
    card = { ...card, ...next };
    const d = new Date();
    d.setDate(d.getDate() - next.interval);
    card.lastReview = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return { intervals, stabilities };
}

/* ══════════════════════════════════════════════════════════════════ */
section('一、定义自洽（权重抄错了这里就会露）');

/* 稳定度的定义：t = S 时保留率正好 0.9。这条是整个算法的锚点。 */
ok(Math.abs(F.retrievability(10, 10) - 0.9) < 1e-6,
  `R(t=S, S) 应正好 0.9，实得 ${F.retrievability(10, 10)}`);
ok(F.retrievability(0, 10) === 1, 'R(t=0) 应为 1（刚复习完，肯定记得）');
ok(F.retrievability(30, 10) < 0.9, 't > S 时保留率应低于 0.9');

/* 间隔倍率：目标保留率取 0.9 时它应该等于 1，也就是「间隔 = 稳定度」。 */
ok(Math.abs(F.nextInterval(10) - 10) <= 1, `nextInterval(10) 应约等于 10，实得 ${F.nextInterval(10)}`);
ok(F.nextInterval(1) >= 1, '间隔下限应为 1 天（不能排到当天）');
ok(F.nextInterval(1e6) <= 365, '间隔上限应生效');

/* ══════════════════════════════════════════════════════════════════ */
section('二、初始值随评分单调');

const initS = [1, 2, 3, 4].map(F.initStability);
const initD = [1, 2, 3, 4].map(F.initDifficulty);
ok(initS.every((v, i) => i === 0 || v > initS[i - 1]),
  `初始稳定度应随评分递增，实得 ${initS.join(' / ')}`);
ok(initD.every((v, i) => i === 0 || v < initD[i - 1]),
  `初始难度应随评分递减（答得越轻松越不难），实得 ${initD.join(' / ')}`);
ok(initD.every((v) => v >= 1 && v <= 10), `初始难度应在 1–10，实得 ${initD.join(' / ')}`);

/* ══════════════════════════════════════════════════════════════════ */
section('三、跨天调度曲线');

const good = simulate(3, 8);
const easy = simulate(4, 8);
const hard = simulate(2, 8);

ok(good.intervals.every((v, i) => i === 0 || v >= good.intervals[i - 1]),
  `连续「记得」间隔不该倒退：${good.intervals.join(' → ')}`);
ok(good.intervals[7] > good.intervals[0],
  `连续「记得」间隔应显著增长：${good.intervals.join(' → ')}`);

/* 三条曲线的相对关系 —— 这是「评分真的起作用了」的证明。
 * 比到第 8 次没有意义：都撞到 365 天上限了，所以比第 3 次。 */
ok(easy.intervals[2] > good.intervals[2],
  `「很熟」应比「记得」长得快：很熟 ${easy.intervals.slice(0, 4).join('/')} vs 记得 ${good.intervals.slice(0, 4).join('/')}`);
ok(hard.intervals[7] < good.intervals[7],
  `「吃力」应比「记得」长得慢：吃力 ${hard.intervals.slice(0, 4).join('/')} vs 记得 ${good.intervals.slice(0, 4).join('/')}`);

/* ══════════════════════════════════════════════════════════════════ */
section('四、答错的处置');

const strong = {
  state: 'review', stability: 60, difficulty: 5,
  reps: 10, lapses: 0, lastReview: '2026-08-01', interval: 60,
};
const forgot = F.grade(strong, 1);
ok(forgot.stability < 60, `答错后稳定度必须下降，实得 ${forgot.stability}`);
ok(forgot.stability > 0, '稳定度不能归零（否则这张卡永远出不来）');
ok(forgot.lapses === 1, `lapses 应 +1，实得 ${forgot.lapses}`);
ok(forgot.state === 'relearning', `review 状态答错应进入 relearning，实得 ${forgot.state}`);
ok(forgot.interval >= 1, '答错后间隔至少 1 天');
ok(forgot.interval < 60, `答错后间隔应明显缩短，实得 ${forgot.interval}`);

/* ══════════════════════════════════════════════════════════════════ */
section('五、同日重复复习');

/* 同一天连点几次不该把间隔推到天上（t=0 走的是短期分支）。 */
let c = F.newCard('k1', null, 'knowledge');
const sameDay = [];
for (let i = 0; i < 6; i += 1) {
  const next = F.grade(c, 3);
  sameDay.push(next.interval);
  c = { ...c, ...next };   // lastReview 保持今天 → elapsed = 0
}
ok(sameDay.every((v) => v <= 30),
  `同日连点不该把间隔推飞：${sameDay.join(' → ')}`);

/* ══════════════════════════════════════════════════════════════════ */
section('六、老库迁移（SM-2 的卡不能变成新卡）');

initSchema();
/* 把 cards 换成 SM-2 时代的形状 —— 没有 state/stability/difficulty。 */
db.exec('DROP TABLE IF EXISTS cards');
db.exec(`CREATE TABLE cards (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'knowledge',
  knowledge_id TEXT, question_id TEXT, due TEXT NOT NULL, interval INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0, ef REAL NOT NULL DEFAULT 2.5,
  lapses INTEGER NOT NULL DEFAULT 0, last_review TEXT, created_at TEXT NOT NULL)`);
db.exec(`INSERT INTO cards (id,user_id,type,knowledge_id,due,interval,reps,ef,lapses,last_review,created_at)
  VALUES ('old1', 1, 'knowledge', 'c1n1', '2026-09-20', 30, 5, 2.4, 1, '2026-08-21', '2026-08-01')`);
db.exec(`INSERT INTO cards (id,user_id,type,knowledge_id,due,interval,reps,ef,lapses,last_review,created_at)
  VALUES ('fresh1', 1, 'knowledge', 'c1n2', '2026-09-20', 0, 0, 2.5, 0, NULL, '2026-09-19')`);

const added = migrate();
ok(added.includes('cards.state'), `迁移应补上 cards.state，实得 ${JSON.stringify(added)}`);
ok(added.includes('cards.stability'), '迁移应补上 cards.stability');
ok(added.includes('cards.difficulty'), '迁移应补上 cards.difficulty');

const oldRow = db.prepare("SELECT * FROM cards WHERE id = 'old1'").get();
ok(oldRow.state === 'review', `复习过的老卡应回填成 review，实得 ${oldRow.state}`);
ok(Math.abs(oldRow.stability - 30) < 0.001,
  `稳定度应由 interval 反推（保留率 90% 时两者相等），实得 ${oldRow.stability}`);
ok(oldRow.difficulty === 5, `难度应回填中性值 5，实得 ${oldRow.difficulty}`);

const freshRow = db.prepare("SELECT * FROM cards WHERE id = 'fresh1'").get();
ok(freshRow.state === 'new', '没复习过的老卡应保持 new');
ok(freshRow.stability === null, '没复习过的老卡不该被塞一个稳定度');

/* 迁移是幂等的 —— 每次启动都会跑，不能越跑越偏 */
migrate();
migrate();
const after = db.prepare("SELECT * FROM cards WHERE id = 'old1'").get();
ok(after.stability === oldRow.stability && after.difficulty === oldRow.difficulty,
  '重复迁移不该改动已回填的值');

/* ★ 最要紧的一条：老卡被当成「新卡」重来的话，用户几百次复习就白费了。
 * 用回填后的状态跑一次 grade，稳定度必须从 30 附近继续，而不是回到 2 左右。 */
const continued = F.grade(oldRow, 3);
ok(continued.stability > 20,
  `老卡接续后稳定度应基于原值增长，实得 ${continued.stability}（若接近 2 说明被当成新卡了）`);
ok(continued.reps === 6, `reps 应从 5 继续，实得 ${continued.reps}`);

/* ══════════════════════════════════════════════════════════════════ */
section('七、输入健壮性');

const weird = F.grade({ state: 'review', stability: 10, difficulty: 5, reps: 3, lapses: 0, lastReview: null, interval: 10 }, 3);
ok(Number.isFinite(weird.stability) && weird.stability > 0, 'lastReview 为 null 时不该算出 NaN');
ok(F.grade({}, 3).stability > 0, '空对象应被当成新卡处理');
ok(F.grade(F.newCard('k', null, 'k'), 99).stability > 0, '越界评分应被夹住而不是崩');
ok(F.grade(F.newCard('k', null, 'k'), 0).stability > 0, '评分 0 应被夹到 1');

try {
  db.close();
  fs.rmSync(TMP, { force: true });
  fs.rmSync(`${TMP}-wal`, { force: true });
  fs.rmSync(`${TMP}-shm`, { force: true });
} catch { /* 临时目录，删不掉无所谓 */ }

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ FSRS 调度器：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ FSRS 调度器：${pass} 项\x1b[0m`);
