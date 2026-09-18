/* 游戏化核心：XP / 等级 / 四级掌握度 / 成就 / 连续打卡 / 备考投影
 *
 * 口径完整移植自纯前端版 js/game.js —— 那是被 26 条成就、多轮调参和测试钉死过的逻辑，
 * 重写等于重新踩一遍坑。唯一变化：数据源从内存 state 换成数据库查询。
 *
 * 与原版的一处结构性简化：
 *   原版要自己维护「全量聚合 stats + 明细裁剪」那套不变式（localStorage 有 5MB 配额）；
 *   这里 attempts 明细全量存库，聚合表只是加速用 —— 掌握度直接读聚合表，
 *   口径与明细一致，且不需要裁剪。
 */
import { db } from '../db/index.js';

/* ---------- XP 表 ---------- */
export const XP = {
  learn: 20,
  correct: 10,
  wrong: 2,
  checkin: 15,
  card: 1,
  boss: 80,
  review: { 1: 2, 2: 5, 3: 8, 4: 10 },
};

/* ---------- 等级曲线 ----------
 * 升到第 n 级需要 100 + (n-1)*60。68 个知识点 + 204 道题首刷 ≈ 3400 XP，
 * 加打卡与复习能到 6000+，对应 11 级左右 —— 全学完刚好"封神"。
 */
export const LEVELS = [
  '初识极限', '数轴新兵', '求导学徒', '积分见习', '级数行者', '多元探索者',
  '曲线猎手', '矩阵行者', '概率赌徒', '极限猎人', '定理克星', '考场主宰',
];
const TOP_TITLE = '考场主宰';

export function needFor(level) { return 100 + (level - 1) * 60; }

export function levelInfo(xp) {
  const x = Math.max(0, Math.floor(xp || 0));
  let level = 1;
  let base = 0;
  let need = needFor(1);
  while (x >= base + need) {
    base += need;
    level += 1;
    need = needFor(level);
  }
  const into = x - base;
  return {
    xp: x,
    level,
    title: LEVELS[level - 1] || TOP_TITLE,
    into,
    need,
    pct: need > 0 ? Math.round((into / need) * 100) : 0,
    total: base + need,
  };
}

/* ---------- 掌握度 ---------- */
export const MASTERY_LABEL = { new: '未学', learning: '学习中', proficient: '熟练', mastered: '精通' };
export const MASTERY_MULT = { new: 1, learning: 1, proficient: 0.5, mastered: 0.2 };
const PROF_ATTEMPTS = 3;
const PROF_ACCURACY = 0.9;

export function sessionMult(nthToday) { return nthToday <= 1 ? 1 : nthToday <= 3 ? 0.7 : 0.3; }

/* ---------- 打卡与连续天数 ---------- */
export function checkinOk(rec) {
  return !!rec && (rec.tasksDone === true || (rec.minutes || 0) >= 30);
}

const pad = (n) => String(n).padStart(2, '0');

export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function dayStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

export function shiftDay(s, n) {
  const d = parseDay(s);
  if (!d) return s;
  d.setDate(d.getDate() + n);
  return dayStr(d);
}

/* 连续天数核心算法。当前连续：今天没打卡就从昨天往回数。 */
export function streakFromSet(set, todayStr) {
  const dates = Object.keys(set).sort();
  if (!dates.length) return { current: 0, best: 0 };
  let best = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    run = dates[i] === shiftDay(dates[i - 1], 1) ? run + 1 : 1;
    if (run > best) best = run;
  }
  let cur = 0;
  let d = set[todayStr] ? todayStr : shiftDay(todayStr, -1);
  while (set[d]) {
    cur += 1;
    d = shiftDay(d, -1);
    if (cur > 9999) break;
  }
  return { current: cur, best };
}

/* ---------- 考纲过滤 ----------
 * 原版口径：数一看到全部节点（数一考纲覆盖面最大）。
 */
export function inTrack(node, track) {
  if (!track || track === 'math1') return true;
  const e = node.exam;
  if (e === 'all') return true;
  if (!Array.isArray(e)) return false;
  return e.indexOf(track) >= 0;
}

/* ---------- 成就表（26 项，与前端版逐条一致）---------- */
export const ACHIEVEMENTS = [
  { id: 'first-step', name: '万里长征第一步', desc: '完成第一次打卡', icon: '始', tier: 'bronze', check: (c) => c.streak >= 1 || c.bestStreak >= 1 },
  { id: 'streak-7', name: '一周不辍', desc: '连续打卡 7 天', icon: '七', tier: 'bronze', check: (c) => c.bestStreak >= 7 },
  { id: 'streak-30', name: '月度铁人', desc: '连续打卡 30 天', icon: '月', tier: 'silver', check: (c) => c.bestStreak >= 30 },
  { id: 'streak-100', name: '百日筑基', desc: '连续打卡 100 天', icon: '百', tier: 'gold', check: (c) => c.bestStreak >= 100 },

  { id: 'learn-10', name: '开卷有益', desc: '学完 10 个知识点', icon: '书', tier: 'bronze', check: (c) => c.learned >= 10 },
  { id: 'learn-30', name: '半壁江山', desc: '学完 30 个知识点', icon: '半', tier: 'silver', check: (c) => c.learned >= 30 },
  { id: 'learn-half', name: '过半', desc: '学完当前考纲一半的知识点', icon: '越', tier: 'silver', check: (c) => c.total > 0 && c.learned * 2 >= c.total },
  { id: 'learn-all', name: '全树点亮', desc: '学完全部知识点', icon: '全', tier: 'gold', check: (c) => c.total > 0 && c.learned >= c.total },

  { id: 'correct-50', name: '五十题', desc: '累计答对 50 题', icon: '五', tier: 'bronze', check: (c) => c.correct >= 50 },
  { id: 'correct-200', name: '题海遨游', desc: '累计答对 200 题', icon: '海', tier: 'silver', check: (c) => c.correct >= 200 },
  { id: 'correct-500', name: '千锤百炼', desc: '累计答对 500 题', icon: '千', tier: 'gold', check: (c) => c.correct >= 500 },

  { id: 'combo-10', name: '十连对', desc: '单日连续答对 10 题', icon: '十', tier: 'bronze', check: (c) => c.bestCombo >= 10 },
  { id: 'combo-25', name: '势不可挡', desc: '单日连续答对 25 题', icon: '势', tier: 'silver', check: (c) => c.bestCombo >= 25 },
  { id: 'combo-50', name: '无人能挡', desc: '单日连续答对 50 题', icon: '极', tier: 'gold', check: (c) => c.bestCombo >= 50 },

  { id: 'queue-clear', name: '队列清零', desc: '清空一次到期的复习队列', icon: '清', tier: 'bronze', check: (c) => !!c.flags.clearedQueue },
  { id: 'mistake-zero', name: '错题清仓', desc: '答对过至少 5 题，且错题本已经清空', icon: '仓', tier: 'silver', check: (c) => c.correct >= 5 && c.mistakes === 0 },
  { id: 'focus-120', name: '深度专注', desc: '单日专注满 120 分钟', icon: '专', tier: 'silver', check: (c) => c.maxMinutes >= 120 },
  { id: 'deck-20', name: '卡片收藏家', desc: '卡片库攒够 20 张', icon: '卡', tier: 'bronze', check: (c) => c.deckCards >= 20 },

  { id: 'chapter-1', name: '首章通关', desc: '点亮第一个章节', icon: '首', tier: 'bronze', check: (c) => c.chaptersDone >= 1 },
  { id: 'chapter-5', name: '攻城略地', desc: '点亮 5 个章节', icon: '攻', tier: 'silver', check: (c) => c.chaptersDone >= 5 },
  { id: 'chapter-all', name: '一统天下', desc: '点亮全部章节', icon: '统', tier: 'gold', check: (c) => c.chaptersTotal > 0 && c.chaptersDone >= c.chaptersTotal },

  { id: 'boss-1', name: '初战告捷', desc: '通关第一个章节 BOSS', icon: '捷', tier: 'silver', check: (c) => c.bossPassed >= 1 },
  { id: 'boss-3', name: '屠龙者', desc: '通关 3 个章节 BOSS', icon: '屠', tier: 'gold', check: (c) => c.bossPassed >= 3 },

  { id: 'level-5', name: '登堂入室', desc: '升到 5 级', icon: '堂', tier: 'bronze', check: (c) => c.level >= 5 },
  { id: 'level-10', name: '渐入佳境', desc: '升到 10 级', icon: '境', tier: 'gold', check: (c) => c.level >= 10 },
];

/* ---------- 知识树缓存（静态数据，进程内缓存一次）---------- */
let _tree = null;
export function getTree() {
  if (_tree) return _tree;
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order').all();
  const chapters = db.prepare('SELECT * FROM chapters ORDER BY sort_order').all();
  const knowledge = db.prepare('SELECT * FROM knowledge ORDER BY sort_order').all();
  const questions = db.prepare('SELECT id, kid FROM questions WHERE owner_id IS NULL').all();

  const nodes = knowledge.map((k) => ({
    ...k,
    exam: k.exam === 'all' ? 'all' : k.exam.split(','),
    related: safeJson(k.related, []),
  }));

  _tree = {
    categories,
    chapters,
    nodes,
    questions,
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    questionsByKid: questions.reduce((acc, q) => {
      (acc[q.kid] = acc[q.kid] || []).push(q.id);
      return acc;
    }, {}),
  };
  return _tree;
}

export function invalidateTree() { _tree = null; }

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/* ---------- 用户学情快照 ---------- */
export function buildSnapshot(userId, { track = 'math1', todayStr } = {}) {
  const tree = getTree();
  /* ★ 兜底必须走**本地**日期，不能用 new Date().toISOString().slice(0, 10)。
   *
   * toISOString() 返回 UTC。而「今天」在这个应用里到处是本地口径
   * （study.js / cards.js / game.js 路由里的 todayStr() 全部用
   *  getFullYear / getMonth / getDate）。两套口径在 UTC+8 的凌晨会差一天：
   * 北京时间 00:00–08:00 期间，UTC 还停在前一天。
   *
   * 后果很具体，而且专挑深夜发作：深夜打完卡，连续天数不涨；
   * 每日任务里的「今天」还停在昨天。这个项目的主人恰好是夜猫子
   * （生产力高峰 23:00–02:00），也就是说这个 bug 一年里绝大多数时候
   * 都落在他最活跃的那几个小时里。
   *
   * CI 上是被这条抓出来的：runner 跑在 UTC，但 workflow 把 TZ 钉成了
   * Asia/Shanghai，跑的时候正好落在窗口内 → 「连续天数 >= 1」实得 0。
   * 回归测试见 tests/day-boundary.mjs（故意把 TZ 设成和 UTC 差一天再验）。 */
  const t = todayStr || dayStr(new Date());

  const game = db.prepare('SELECT * FROM game_state WHERE user_id = ?').get(userId) || {};
  const flags = safeJson(game.flags || '{}', {});

  const nodes = tree.nodes.filter((n) => inTrack(n, track));
  const nodeIds = new Set(nodes.map((n) => n.id));

  // 一次拉全量聚合，内存里算 —— 最多 204 行，比反复查库快
  const nodeStats = new Map(
    db.prepare('SELECT kid, n, c, ts FROM stats_node WHERE user_id = ?').all(userId)
      .map((r) => [r.kid, r]),
  );
  const qStats = new Map(
    db.prepare('SELECT qid, kid, n, c, ok, ts FROM stats_question WHERE user_id = ?').all(userId)
      .map((r) => [r.qid, r]),
  );
  const cardKids = new Set(
    db.prepare('SELECT DISTINCT knowledge_id FROM cards WHERE user_id = ? AND knowledge_id IS NOT NULL')
      .all(userId).map((r) => r.knowledge_id),
  );
  const checkins = db.prepare('SELECT date, minutes, tasks_done FROM checkins WHERE user_id = ?').all(userId);
  const boss = db.prepare('SELECT chapter_id, score FROM boss_records WHERE user_id = ?').all(userId);
  const deckCount = db.prepare('SELECT COUNT(*) n FROM card_deck WHERE user_id = ?').get(userId).n;

  let attemptCount = 0;
  let correct = 0;
  let wrong = 0;
  nodes.forEach((n) => {
    const s = nodeStats.get(n.id);
    if (s) { attemptCount += s.n; correct += s.c; }
  });
  qStats.forEach((q) => {
    if (nodeIds.has(q.kid) && !q.ok) wrong += 1;
  });

  const learned = nodes.filter((n) => cardKids.has(n.id)).length;

  const chStat = {};
  nodes.forEach((n) => {
    const s = chStat[n.chapter_id] || (chStat[n.chapter_id] = { total: 0, mastered: 0 });
    s.total += 1;
    if (cardKids.has(n.id)) s.mastered += 1;
  });
  const chaptersTotal = Object.keys(chStat).length;
  const chaptersDone = Object.keys(chStat).filter((k) => chStat[k].total > 0 && chStat[k].mastered >= chStat[k].total).length;

  const checkinMap = {};
  let maxMinutes = 0;
  checkins.forEach((c) => {
    checkinMap[c.date] = { minutes: c.minutes, tasksDone: c.tasks_done === 1 };
    if (c.minutes > maxMinutes) maxMinutes = c.minutes;
  });
  const okSet = {};
  Object.keys(checkinMap).forEach((d) => { if (checkinOk(checkinMap[d])) okSet[d] = 1; });
  const sk = streakFromSet(okSet, t);

  const lv = levelInfo(game.xp || 0);

  return {
    today: t,
    xp: game.xp || 0,
    level: lv.level,
    title: lv.title,
    levelInfo: lv,
    streak: sk.current,
    bestStreak: sk.best,
    learned,
    total: nodes.length,
    attempts: attemptCount,
    correct,
    wrong,
    mistakes: wrong,
    maxMinutes,
    chaptersDone,
    chaptersTotal,
    chStat,
    bossPassed: boss.filter((b) => b.score != null).length,
    deckCards: deckCount,
    bestCombo: game.best_combo || 0,
    combo: game.combo || 0,
    flags,
  };
}

/* ---------- 单节点掌握度 ----------
 *
 * ── 自建题为什么要单独查一次 ──────────────────────────────────────
 * getTree() 是**进程级共享缓存**，所有用户共用一份，所以它只装内置题
 * （owner_id IS NULL）—— 把某个用户的自建题塞进去，别的用户就会看到别人的题。
 *
 * 但自建题（尤其是 AI 生成的变式题）如果不参与掌握度，就会出现
 * 「我明明练了 10 道，学情一点没动」—— 那用户凭什么还练？
 * 所以这里按用户单独查一次，批量调用时通过 ownByKid 传入避免 N+1。
 */
export function nodeMastery(userId, nodeId, { nodeStats, qStats, tree, ownByKid } = {}) {
  const t = tree || getTree();
  const ns = nodeStats
    ? (nodeStats.get(nodeId) || { n: 0, c: 0 })
    : (db.prepare('SELECT n, c FROM stats_node WHERE user_id = ? AND kid = ?').get(userId, nodeId) || { n: 0, c: 0 });
  const n = ns.n;
  const correct = ns.c;
  const accuracy = n ? correct / n : 0;

  const qMap = qStats
    ? qStats
    : new Map(db.prepare('SELECT qid, kid, n, c, ok, ts FROM stats_question WHERE user_id = ?').all(userId).map((r) => [r.qid, r]));

  const builtinQ = t.questionsByKid[nodeId] || [];
  const ownQ = ownByKid
    ? (ownByKid[nodeId] || [])
    : db.prepare('SELECT id FROM questions WHERE owner_id = ? AND kid = ?').all(userId, nodeId).map((r) => r.id);

  const qIds = builtinQ.concat(ownQ);
  const seenQ = qIds.filter((id) => qMap.has(id)).length;

  /* allRight 只算**内置题**。
   *
   * 它衡量的是「官方题库覆盖完了没」，是个客观刻度。
   * 把自建题也算进去的话，用户生成 20 道变式题就永远评不上精通 ——
   * 那不是严格，那是拿自己生成的题把自己堵死。
   * 而且 AI 出题数量不限，让它参与就等于给「精通」加了一个可无限膨胀的门槛。 */
  const allRight = builtinQ.length > 0 && builtinQ.every((id) => qMap.get(id)?.ok);

  let level;
  if (!n) level = 'new';
  else if (n >= PROF_ATTEMPTS && accuracy >= PROF_ACCURACY && allRight) level = 'mastered';
  else if (n >= PROF_ATTEMPTS && accuracy >= PROF_ACCURACY) level = 'proficient';
  else level = 'learning';

  return {
    nodeId, level, label: MASTERY_LABEL[level],
    attempts: n, correct, accuracy,
    questions: qIds.length, questionsSeen: seenQ, allRight,
    builtinQuestions: builtinQ.length, ownQuestions: ownQ.length,
  };
}

/** 批量取某个用户的全部自建题，按考点分组。给 masteryBoard 用。 */
function ownQuestionsByKid(userId) {
  const rows = db.prepare('SELECT id, kid FROM questions WHERE owner_id = ?').all(userId);
  return rows.reduce((acc, q) => {
    (acc[q.kid] = acc[q.kid] || []).push(q.id);
    return acc;
  }, {});
}

/** 全树掌握度分布 + 每节点状态（知识树页一次要，必须批量算） */
export function masteryBoard(userId, { track = 'math1' } = {}) {
  const tree = getTree();
  const nodeStats = new Map(db.prepare('SELECT kid, n, c, ts FROM stats_node WHERE user_id = ?').all(userId).map((r) => [r.kid, r]));
  const qStats = new Map(db.prepare('SELECT qid, kid, n, c, ok, ts FROM stats_question WHERE user_id = ?').all(userId).map((r) => [r.qid, r]));
  const cardKids = new Set(db.prepare('SELECT DISTINCT knowledge_id FROM cards WHERE user_id = ? AND knowledge_id IS NOT NULL').all(userId).map((r) => r.knowledge_id));
  /* 一次查完该用户的全部自建题，避免在下面的 map 里逐节点查库。 */
  const ownByKid = ownQuestionsByKid(userId);

  const nodes = tree.nodes.filter((n) => inTrack(n, track));
  const rows = nodes.map((n) => ({
    ...nodeMastery(userId, n.id, { nodeStats, qStats, tree, ownByKid }),
    hasCard: cardKids.has(n.id),
  }));

  const dist = { new: 0, learning: 0, proficient: 0, mastered: 0 };
  rows.forEach((r) => { dist[r.level] += 1; });

  return {
    rows,
    dist,
    total: nodes.length,
    learned: nodes.filter((n) => cardKids.has(n.id)).length,
    label: MASTERY_LABEL,
    pct: {
      learning: nodes.length ? Math.round((dist.learning / nodes.length) * 100) : 0,
      proficient: nodes.length ? Math.round((dist.proficient / nodes.length) * 100) : 0,
      mastered: nodes.length ? Math.round((dist.mastered / nodes.length) * 100) : 0,
    },
  };
}

/* ---------- 单次作答该给多少 XP（防刷分）---------- */
export function answerXp(userId, qid, kid, { todayStr, recorded = false } = {}) {
  /* 同上：本地日期，不是 UTC。
   * 这里算的是「这道题今天第几次作答」，用来决定防刷分的衰减档位。
   * 用 UTC 的话，凌晨作答会去数昨天的行，档位错一档。 */
  const t = todayStr || dayStr(new Date());
  const todayN = db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = ? AND qid = ? AND date = ?')
    .get(userId, qid, t).n;
  const nth = recorded ? Math.max(1, todayN) : todayN + 1;

  const m = nodeMastery(userId, kid);
  const mm = MASTERY_MULT[m.level] ?? 1;
  const sm = sessionMult(nth);
  const base = XP.correct;
  const amount = Math.max(1, Math.round(base * mm * sm));

  return {
    amount, base, mastery: m.level, masteryLabel: m.label, masteryMult: mm,
    nthToday: nth, sessionMult: sm, reduced: amount < base,
    note: amount < base
      ? (mm < 1 && nth > 1 ? '已掌握 + 今日重复'
        : mm < 1 ? `该知识点已${m.label}`
          : `今日第 ${nth} 次作答`)
      : '',
  };
}

/* ---------- 发 XP（幂等键防重复发放）---------- */
export function awardXp(userId, kind, { amount, rating, key } = {}) {
  const g = db.prepare('SELECT * FROM game_state WHERE user_id = ?').get(userId) || { xp: 0, flags: '{}' };
  const flags = safeJson(g.flags || '{}', {});

  if (key && flags[`xp:${key}`]) {
    return { gained: 0, levelUp: false, level: levelInfo(g.xp || 0).level, skipped: true };
  }

  let amt = amount;
  if (amt == null) amt = kind === 'review' ? (XP.review[rating] || 0) : (XP[kind] || 0);

  const before = levelInfo(g.xp || 0);
  const after = levelInfo((g.xp || 0) + amt);
  if (key) flags[`xp:${key}`] = 1;

  // upsert：即使 game_state 行缺失（老数据/异常注册流程）也不会把 XP 吞掉
  db.prepare(`INSERT INTO game_state (user_id, xp, flags, updated_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET xp = excluded.xp, flags = excluded.flags, updated_at = datetime('now')`)
    .run(userId, after.xp, JSON.stringify(flags));

  return {
    gained: amt,
    levelUp: after.level > before.level,
    from: before.level, to: after.level,
    title: after.title,
    level: after.level,
  };
}

/* ---------- 成就判定 ---------- */
export function checkAchievements(userId, opts = {}) {
  const ctx = buildSnapshot(userId, opts);
  const owned = new Set(db.prepare('SELECT achievement_id FROM achievements WHERE user_id = ?').all(userId).map((r) => r.achievement_id));
  const fresh = [];
  const ins = db.prepare('INSERT OR IGNORE INTO achievements (user_id, achievement_id, date) VALUES (?,?,?)');

  ACHIEVEMENTS.forEach((a) => {
    if (owned.has(a.id)) return;
    let hit = false;
    try { hit = !!a.check(ctx); } catch { hit = false; }
    if (!hit) return;
    ins.run(userId, a.id, ctx.today);
    fresh.push(a.id);
  });
  return fresh;
}

export function achievementBoard(userId, opts = {}) {
  const ctx = buildSnapshot(userId, opts);
  const owned = new Map(db.prepare('SELECT achievement_id, date FROM achievements WHERE user_id = ?').all(userId).map((r) => [r.achievement_id, r.date]));
  return ACHIEVEMENTS.map((a) => {
    const at = owned.get(a.id) || null;
    let progress = null;
    if (!at) progress = progressHint(a.id, ctx);
    return { id: a.id, name: a.name, desc: a.desc, icon: a.icon, tier: a.tier, unlockedAt: at, progress };
  });
}

/* 未解锁成就的「离达标还差多少」 */
function progressHint(id, c) {
  const map = {
    'streak-7': [c.bestStreak, 7], 'streak-30': [c.bestStreak, 30], 'streak-100': [c.bestStreak, 100],
    'learn-10': [c.learned, 10], 'learn-30': [c.learned, 30], 'learn-half': [c.learned * 2, c.total], 'learn-all': [c.learned, c.total],
    'correct-50': [c.correct, 50], 'correct-200': [c.correct, 200], 'correct-500': [c.correct, 500],
    'combo-10': [c.bestCombo, 10], 'combo-25': [c.bestCombo, 25], 'combo-50': [c.bestCombo, 50],
    'focus-120': [c.maxMinutes, 120], 'deck-20': [c.deckCards, 20],
    'chapter-1': [c.chaptersDone, 1], 'chapter-5': [c.chaptersDone, 5], 'chapter-all': [c.chaptersDone, c.chaptersTotal],
    'boss-1': [c.bossPassed, 1], 'boss-3': [c.bossPassed, 3],
    'level-5': [c.level, 5], 'level-10': [c.level, 10],
  };
  const m = map[id];
  if (!m) return null;
  return { have: m[0], need: m[1], pct: m[1] > 0 ? Math.min(100, Math.round((m[0] / m[1]) * 100)) : 0 };
}

/* ---------- 备考投影：照这个速度，考前来得及吗 ---------- */
export function projection(userId, { track = 'math1', examDate, dailyNew = 2 } = {}) {
  const snap = buildSnapshot(userId, { track });
  const remaining = Math.max(0, snap.total - snap.learned);
  if (!examDate) return { remaining, daysLeft: null, neededPerDay: null, onTrack: null, dailyNew };

  const t = snap.today;
  const d1 = parseDay(t);
  const d2 = parseDay(examDate);
  const daysLeft = d2 && d1 ? Math.max(0, Math.round((d2 - d1) / 864e5)) : 0;
  const neededPerDay = daysLeft > 0 ? Math.ceil(remaining / daysLeft) : remaining;
  const onTrack = daysLeft > 0 ? dailyNew >= neededPerDay : remaining === 0;

  return {
    remaining, daysLeft, neededPerDay, onTrack, dailyNew,
    learned: snap.learned, total: snap.total,
    message: remaining === 0
      ? '全部知识点已过一遍，接下来就是复习和刷题。'
      : daysLeft === 0
        ? '考试日期已到或已过。'
        : onTrack
          ? `按每天 ${dailyNew} 个的节奏，考前刚好走完一轮。`
          : `要考前走完一轮，每天得学 ${neededPerDay} 个（当前 ${dailyNew} 个）。`,
  };
}

/* ---------- 下一步建议：今天该干什么 ---------- */
export function nextSuggestion(userId, { track = 'math1' } = {}) {
  const snap = buildSnapshot(userId, { track });
  const t = snap.today;
  const dueCount = db.prepare('SELECT COUNT(*) n FROM cards WHERE user_id = ? AND due <= ?').get(userId, t).n;
  const out = [];

  if (dueCount > 0) {
    out.push({ kind: 'review', priority: 100, title: `清掉 ${dueCount} 张到期复习卡`, why: '到期未复习的卡片，记忆保留率每天都在掉。', route: '/review' });
  }
  if (snap.wrong > 0) {
    out.push({ kind: 'mistake', priority: 80, title: `重练 ${snap.wrong} 道错题`, why: '错题是当前最薄弱的地方，优先于刷新题。', route: '/mistakes' });
  }
  const untouched = snap.total - snap.learned;
  if (untouched > 0) {
    out.push({ kind: 'learn', priority: 60, title: `学 ${Math.min(2, untouched)} 个新知识点`, why: `还有 ${untouched} 个知识点没学过。`, route: '/learn' });
  }
  out.push({ kind: 'quiz', priority: 40, title: '做一套每日一练', why: '保持手感，顺便检验今天学的有没有真的记住。', route: '/quiz' });

  return { items: out.sort((a, b) => b.priority - a.priority), snapshot: snap, dueCount };
}
