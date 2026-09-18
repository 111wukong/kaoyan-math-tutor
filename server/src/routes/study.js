/* 学习数据：作答 / 错题本 / 统计 / 每日计划 / 热力图
 *
 * 一次作答要原子地完成七件事，任何一步失败都必须整体回滚 ——
 * 否则会出现「题目算对了但 XP 没加」「统计涨了但错题本没进」这类难查的偏账：
 *   1. 判题
 *   2. 算 XP（必须在写入前算，因为要读"今天第几次答这道题"）
 *   3. 写 attempts 明细
 *   4. 更新 stats_node / stats_question / stats_daily 三张聚合
 *   5. 维护连击（跨日重置）
 *   6. 发 XP + 判成就
 *   7. 首次接触该知识点时建复习卡
 */
import { db } from '../db/index.js';
import { judge, parseOptions, publicQuestion } from '../lib/judge.js';
import {
  answerXp, awardXp, checkAchievements, buildSnapshot, masteryBoard,
  getTree, inTrack, nodeMastery, XP,
} from '../lib/game.js';
import { diagnoseRoots, nextToLearn } from '../lib/diagnose.js';
import { newCard } from '../lib/sm2.js';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default async function studyRoutes(fastify) {
  /* ============ 作答 ============ */
  fastify.post('/api/study/answer', {
    schema: {
      body: {
        type: 'object',
        required: ['qid', 'answer'],
        properties: {
          qid: { type: 'string' },
          answer: { type: 'string' },
          context: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { qid, answer, context = 'quiz' } = req.body;
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(qid);
    if (!q) return reply.code(404).send({ error: '题目不存在' });

    const today = todayStr();
    const correct = judge(q, answer);

    const run = db.transaction(() => {
      const xpInfo = answerXp(req.userId, qid, q.kid, { todayStr: today });

      const attemptId = 'a_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
      db.prepare(`INSERT INTO attempts (id,user_id,qid,kid,answer,correct,context,date,ts)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(attemptId, req.userId, qid, q.kid, String(answer ?? ''), correct ? 1 : 0, context, today, Date.now());

      // 聚合：node
      db.prepare(`INSERT INTO stats_node (user_id,kid,n,c,ts) VALUES (?,?,1,?,?)
        ON CONFLICT(user_id,kid) DO UPDATE SET n = n + 1, c = c + excluded.c, ts = excluded.ts`)
        .run(req.userId, q.kid, correct ? 1 : 0, Date.now());

      // 聚合：question（ok 直接覆盖为本次结果 → 错题本自动进出）
      db.prepare(`INSERT INTO stats_question (user_id,qid,kid,n,c,ok,ts) VALUES (?,?,?,1,?,?,?)
        ON CONFLICT(user_id,qid) DO UPDATE SET n = n + 1, c = c + excluded.c, ok = excluded.ok, ts = excluded.ts`)
        .run(req.userId, qid, q.kid, correct ? 1 : 0, correct ? 1 : 0, Date.now());

      // 聚合：daily
      db.prepare(`INSERT INTO stats_daily (user_id,date,n,c) VALUES (?,?,1,?)
        ON CONFLICT(user_id,date) DO UPDATE SET n = n + 1, c = c + excluded.c`)
        .run(req.userId, today, correct ? 1 : 0);

      // 连击：跨日重置
      const g = db.prepare('SELECT * FROM game_state WHERE user_id = ?').get(req.userId) || { combo: 0, best_combo: 0, flags: '{}' };
      const flags = (() => { try { return JSON.parse(g.flags || '{}'); } catch { return {}; } })();
      const combo = flags.comboDate === today ? (g.combo || 0) : 0;
      const nextCombo = correct ? combo + 1 : 0;
      const bestCombo = Math.max(g.best_combo || 0, nextCombo);
      flags.comboDate = today;

      db.prepare(`INSERT INTO game_state (user_id,combo,best_combo,flags) VALUES (?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET combo = excluded.combo, best_combo = excluded.best_combo, flags = excluded.flags`)
        .run(req.userId, nextCombo, bestCombo, JSON.stringify(flags));

      // 首次接触某知识点 → 建复习卡（答对答错都建：答错了更需要排进遗忘曲线）
      let cardCreated = null;
      const has = db.prepare('SELECT id FROM cards WHERE user_id = ? AND knowledge_id = ? AND type = ?')
        .get(req.userId, q.kid, 'knowledge');
      if (!has) {
        const c = newCard(q.kid, null, 'knowledge');
        db.prepare(`INSERT INTO cards (id,user_id,type,knowledge_id,question_id,due,interval,reps,ef,lapses,last_review,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(c.id, req.userId, c.type, c.knowledgeId, c.questionId, c.due, c.interval, c.reps, c.ef, c.lapses, c.lastReview, c.createdAt);
        cardCreated = c;
      }

      const xp = awardXp(req.userId, correct ? 'correct' : 'wrong', { amount: correct ? xpInfo.amount : XP.wrong });
      const fresh = checkAchievements(req.userId);
      const mastery = nodeMastery(req.userId, q.kid);

      return { xpInfo, xp, fresh, mastery, cardCreated };
    });

    const r = run();

    return {
      correct,
      myAnswer: String(answer ?? ''),
      answer: q.answer,
      analysis: q.analysis,
      options: parseOptions(q),
      stem: q.stem,
      kid: q.kid,
      xp: r.xp,
      xpNote: r.xpInfo.note,
      combo: db.prepare('SELECT combo, best_combo FROM game_state WHERE user_id = ?').get(req.userId),
      mastery: { level: r.mastery.level, label: r.mastery.label, accuracy: r.mastery.accuracy, attempts: r.mastery.attempts },
      achievements: r.fresh,
    };
  });

  /* ============ 错题本 ============ */
  fastify.get('/api/study/mistakes', async (req) => {
    const { kid } = req.query;
    const where = ['sq.user_id = @uid', 'sq.ok = 0'];
    const params = { uid: req.userId };
    if (kid) { where.push('sq.kid = @kid'); params.kid = kid; }

    const rows = db.prepare(`
      SELECT sq.qid, sq.kid, sq.n, sq.c, sq.ts,
             q.stem, q.type, q.options, q.answer, q.analysis, q.difficulty, q.source_type, q.source_year,
             k.title AS kidTitle, k.chapter_id AS chapterId,
             (SELECT answer FROM attempts a WHERE a.user_id = sq.user_id AND a.qid = sq.qid ORDER BY a.ts DESC LIMIT 1) AS myAnswer
      FROM stats_question sq
      JOIN questions q ON q.id = sq.qid
      LEFT JOIN knowledge k ON k.id = sq.kid
      WHERE ${where.join(' AND ')}
      ORDER BY sq.ts DESC
    `).all(params);

    const byKid = {};
    rows.forEach((r) => { byKid[r.kid] = (byKid[r.kid] || 0) + 1; });

    return {
      mistakes: rows.map((r) => ({
        qid: r.qid, kid: r.kid, kidTitle: r.kidTitle, chapterId: r.chapterId,
        stem: r.stem, type: r.type, options: parseOptions(r),
        answer: r.answer, analysis: r.analysis, myAnswer: r.myAnswer,
        difficulty: r.difficulty, sourceType: r.source_type, sourceYear: r.source_year,
        wrongCount: r.n - r.c, attempts: r.n, lastAt: r.ts,
      })),
      total: rows.length,
      byKid,
    };
  });

  /* ============ 薄弱知识点 ============ */
  fastify.get('/api/study/weak', async (req) => {
    const limit = Math.min(20, Number(req.query.limit) || 8);
    const board = masteryBoard(req.userId, { track: req.query.track || 'math1' });
    const tree = getTree();

    const wrongByKid = db.prepare(`
      SELECT kid, COUNT(*) n FROM stats_question WHERE user_id = ? AND ok = 0 GROUP BY kid
    `).all(req.userId);
    const wrongMap = new Map(wrongByKid.map((r) => [r.kid, r.n]));

    const scored = board.rows
      .filter((r) => r.attempts > 0 || wrongMap.has(r.nodeId))
      .map((r) => {
        const wrong = wrongMap.get(r.nodeId) || 0;
        const node = tree.nodeById.get(r.nodeId);
        // 优先级 = (1-正确率) × 重要度(难度) × 错题惩罚
        const score = (1 - r.accuracy) * (node?.difficulty || 2) * (1 + wrong * 0.5);
        return {
          nodeId: r.nodeId, title: node?.title || '', chapterId: node?.chapter_id,
          level: r.level, label: r.label, accuracy: r.accuracy,
          attempts: r.attempts, wrong, score: Number(score.toFixed(3)),
          why: wrong > 0 ? `错过 ${wrong} 道题` : `正确率 ${Math.round(r.accuracy * 100)}%`,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    /* 图谱加成：这个薄弱点背后是不是还有更早的根因。
     *
     * 注意这里**没有**改上面的排序 —— weak 的语义是「哪些地方弱」，
     * 那是个客观事实，不该被图谱搅动。根因是另一件事，单独用
     * /api/study/roots 表达。把两者混进一个排序里，
     * 前端就没法既显示「我弱在哪」又显示「我该先补什么」。
     *
     * rootCause 只在根因不是它自己时才给 —— 一个节点自己就是根因时，
     * 回填它自己只会让界面出现「先补 X（就是这里）」这种废话。 */
    const diag = diagnoseRoots(req.userId, { track: req.query.track || 'math1', limit: 20 });
    const rootOf = new Map();
    for (const r of diag.roots) {
      for (const s of r.coveredSymptoms) {
        if (!rootOf.has(s.nodeId)) rootOf.set(s.nodeId, r);
      }
    }

    return {
      weak: scored.map((s) => {
        const r = rootOf.get(s.nodeId);
        return {
          ...s,
          rootCause: r && r.nodeId !== s.nodeId
            ? { nodeId: r.nodeId, title: r.title, kind: r.kind, accuracy: r.accuracy, why: r.why }
            : null,
        };
      }),
    };
  });

  /* ============ 根因诊断：从错题回溯到真正没打牢的前置 ============
   *
   * 与 /api/study/weak 的区别（这两个接口很容易被混用）：
   *   weak  回答「我哪里弱」    —— 平铺，看全貌
   *   roots 回答「我该先补什么」—— 有向回溯，给行动顺序
   * 仪表盘上「今天先做什么」应该用 roots；知识树高亮用 weak。
   */
  fastify.get('/api/study/roots', async (req) => {
    const track = req.query.track || 'math1';
    const limit = Math.min(10, Number(req.query.limit) || 5);
    return diagnoseRoots(req.userId, { track, limit });
  });

  /* ============ 学情快照 ============ */
  fastify.get('/api/study/snapshot', async (req) => {
    const track = req.query.track || 'math1';
    const snap = buildSnapshot(req.userId, { track });
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.userId) || {};
    const dueCount = db.prepare('SELECT COUNT(*) n FROM cards WHERE user_id = ? AND due <= ?').get(req.userId, snap.today).n;
    return { snapshot: { ...snap, dueCount }, settings };
  });

  /* ============ 统计页数据 ============ */
  fastify.get('/api/study/stats', async (req) => {
    const track = req.query.track || 'math1';
    const tree = getTree();
    const snap = buildSnapshot(req.userId, { track });

    // 近 14 天正确率
    const days = db.prepare(`
      SELECT date, n, c FROM stats_daily WHERE user_id = ? ORDER BY date DESC LIMIT 14
    `).all(req.userId).reverse();

    // 全量日统计（热力图，26 周 = 182 天）
    const allDays = db.prepare('SELECT date, n, c FROM stats_daily WHERE user_id = ? ORDER BY date').all(req.userId);

    // 三科掌握度雷达
    const board = masteryBoard(req.userId, { track });
    const rowMap = new Map(board.rows.map((r) => [r.nodeId, r]));
    const radar = tree.categories.map((cat) => {
      const chIds = new Set(tree.chapters.filter((c) => c.category_id === cat.id).map((c) => c.id));
      const nodes = tree.nodes.filter((n) => chIds.has(n.chapter_id) && inTrack(n, track));
      const rows = nodes.map((n) => rowMap.get(n.id)).filter(Boolean);
      const avgAcc = rows.length ? rows.reduce((a, r) => a + r.accuracy, 0) / rows.length : 0;
      const masteredPct = rows.length ? rows.filter((r) => r.level === 'mastered' || r.level === 'proficient').length / rows.length : 0;
      return {
        id: cat.id, name: cat.name, color: cat.color,
        accuracy: Math.round(avgAcc * 100),
        coverage: Math.round(masteredPct * 100),
        total: rows.length,
        learned: rows.filter((r) => r.attempts > 0).length,
      };
    });

    // 各章正确率
    const chapterRows = tree.chapters.map((ch) => {
      const nodes = tree.nodes.filter((n) => n.chapter_id === ch.id && inTrack(n, track));
      const rows = nodes.map((n) => rowMap.get(n.id)).filter(Boolean);
      const n = rows.reduce((a, r) => a + r.attempts, 0);
      const c = rows.reduce((a, r) => a + r.correct, 0);
      return {
        id: ch.id, name: ch.name, categoryId: ch.category_id,
        attempts: n, correct: c,
        accuracy: n ? Math.round((c / n) * 100) : 0,
        nodes: rows.length,
        mastered: rows.filter((r) => r.level === 'mastered').length,
      };
    }).filter((c) => c.nodes > 0);

    // 来源分布（已作答的题按 sourceType 聚合）
    const bySource = db.prepare(`
      SELECT q.source_type AS sourceType, COUNT(*) n, SUM(a.correct) c
      FROM attempts a JOIN questions q ON q.id = a.qid
      WHERE a.user_id = ? AND q.source_type <> ''
      GROUP BY q.source_type
    `).all(req.userId);

    return {
      snapshot: snap,
      trend: days.map((d) => ({ date: d.date, total: d.n, correct: d.c, pct: d.n ? Math.round((d.c / d.n) * 100) : 0 })),
      heatmap: allDays.map((d) => ({ date: d.date, n: d.n, c: d.c })),
      radar,
      chapters: chapterRows,
      bySource,
      masteryDist: board.dist,
    };
  });

  /* ============ 每日计划 ============ */
  fastify.get('/api/study/daily', async (req) => {
    const today = todayStr();
    let plan = db.prepare('SELECT * FROM daily_plan WHERE user_id = ? AND date = ?').get(req.userId, today);
    if (!plan) {
      plan = generatePlan(req.userId, today);
    }
    const parse = (s) => { try { return JSON.parse(s); } catch { return []; } };

    const qs = parse(plan.quiz_ids).length
      ? db.prepare(`SELECT * FROM questions WHERE id IN (${parse(plan.quiz_ids).map(() => '?').join(',')})`).all(...parse(plan.quiz_ids))
      : [];
    const qMap = new Map(qs.map((q) => [q.id, q]));
    const tree = getTree();

    return {
      date: today,
      review: {
        ids: parse(plan.review_ids),
        done: parse(plan.review_done),
      },
      newNodes: parse(plan.new_ids).map((id) => {
        const n = tree.nodeById.get(id);
        return n ? { id: n.id, title: n.title, difficulty: n.difficulty } : null;
      }).filter(Boolean),
      newDone: parse(plan.new_done),
      quiz: parse(plan.quiz_ids).map((id) => {
        const q = qMap.get(id);
        return q ? publicQuestion(q, { withAnswer: false }) : null;
      }).filter(Boolean),
      quizDone: parse(plan.quiz_done),
    };
  });

  /* 重新生成今日计划 */
  fastify.post('/api/study/daily/refresh', async (req) => {
    const today = todayStr();
    const plan = generatePlan(req.userId, today, { force: true });
    return { ok: true, date: plan.date };
  });

  /* ============ 打卡 / 专注 ============ */
  fastify.post('/api/study/checkin', {
    schema: {
      body: {
        type: 'object',
        properties: { minutes: { type: 'number' }, tasksDone: { type: 'boolean' } },
      },
    },
  }, async (req) => {
    const today = todayStr();
    const { minutes = 0, tasksDone = false } = req.body || {};
    const prev = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?').get(req.userId, today);

    const nextMinutes = (prev?.minutes || 0) + Number(minutes || 0);
    const nextTasks = tasksDone || prev?.tasks_done === 1;

    db.prepare(`INSERT INTO checkins (user_id,date,minutes,tasks_done) VALUES (?,?,?,?)
      ON CONFLICT(user_id,date) DO UPDATE SET minutes = excluded.minutes, tasks_done = excluded.tasks_done`)
      .run(req.userId, today, nextMinutes, nextTasks ? 1 : 0);

    let xp = null;
    const wasOk = prev && (prev.tasks_done === 1 || prev.minutes >= 30);
    const isOk = nextTasks || nextMinutes >= 30;
    if (!wasOk && isOk) xp = awardXp(req.userId, 'checkin', { key: `checkin:${today}` });

    const fresh = checkAchievements(req.userId);
    const snap = buildSnapshot(req.userId);

    return {
      checkin: { date: today, minutes: nextMinutes, tasksDone: nextTasks, ok: isOk },
      xp, achievements: fresh,
      streak: snap.streak, bestStreak: snap.bestStreak,
    };
  });

  fastify.post('/api/study/focus', {
    schema: {
      body: { type: 'object', required: ['minutes'], properties: { minutes: { type: 'number' }, startedAt: { type: 'string' } } },
    },
  }, async (req) => {
    const { minutes, startedAt } = req.body;
    const today = todayStr();
    const m = Math.max(1, Math.min(600, Math.round(minutes)));

    db.prepare('INSERT INTO focus_sessions (id,user_id,minutes,started_at,ended_at) VALUES (?,?,?,?,?)')
      .run('f_' + Date.now().toString(36), req.userId, m, startedAt || new Date().toISOString(), new Date().toISOString());

    const prev = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?').get(req.userId, today);
    const nextMinutes = (prev?.minutes || 0) + m;
    const nextTasks = prev?.tasks_done === 1;
    db.prepare(`INSERT INTO checkins (user_id,date,minutes,tasks_done) VALUES (?,?,?,?)
      ON CONFLICT(user_id,date) DO UPDATE SET minutes = excluded.minutes, tasks_done = excluded.tasks_done`)
      .run(req.userId, today, nextMinutes, nextTasks ? 1 : 0);

    let xp = null;
    const wasOk = prev && (prev.tasks_done === 1 || prev.minutes >= 30);
    if (!wasOk && nextMinutes >= 30) xp = awardXp(req.userId, 'checkin', { key: `checkin:${today}` });

    const fresh = checkAchievements(req.userId);
    return { minutes: m, todayMinutes: nextMinutes, xp, achievements: fresh };
  });

  /* ============ 笔记 ============ */
  fastify.get('/api/study/notes', async (req) => {
    const rows = db.prepare(`
      SELECT n.id, n.kid, n.text, n.date, k.title AS kidTitle
      FROM notes n LEFT JOIN knowledge k ON k.id = n.kid
      WHERE n.user_id = ? ORDER BY n.created_at DESC
    `).all(req.userId);
    return { notes: rows };
  });

  fastify.post('/api/study/notes', {
    schema: { body: { type: 'object', required: ['kid', 'text'], properties: { kid: { type: 'string' }, text: { type: 'string' } } } },
  }, async (req) => {
    const { kid, text } = req.body;
    const id = 'n_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    db.prepare('INSERT INTO notes (id,user_id,kid,text,date,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, req.userId, kid, String(text).slice(0, 4000), todayStr(), new Date().toISOString());
    return { ok: true, id };
  });

  fastify.delete('/api/study/notes/:id', async (req) => {
    db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    return { ok: true };
  });

  /* ============ 重置学习数据（保留账号）============ */
  fastify.post('/api/study/reset', async (req, reply) => {
    const { confirm } = req.body || {};
    if (confirm !== 'RESET') return reply.code(400).send({ error: '需要确认' });
    db.transaction(() => {
      const uid = req.userId;
      ['attempts', 'stats_node', 'stats_question', 'stats_daily', 'cards', 'notes',
        'card_deck', 'checkins', 'daily_plan', 'achievements', 'boss_records',
        'chats', 'classrooms', 'focus_sessions'].forEach((t) => {
        db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);
      });
      db.prepare('UPDATE game_state SET xp = 0, combo = 0, best_combo = 0, blitz = \'{}\', flags = \'{}\' WHERE user_id = ?').run(uid);
    })();
    return { ok: true };
  });
}

/* ---------- 今日计划生成 ----------
 * 三类任务：
 *   review —— 到期复习卡（SM-2 决定）
 *   new    —— 未学过的新知识点，数量取用户设置 dailyNew
 *   quiz   —— 每日一练 5 题，优先「掌握度低 + 错题多」的节点
 */
function generatePlan(userId, today, { force = false } = {}) {
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) || {};
  const track = settings.exam_track || 'math1';
  const dailyNew = settings.daily_new ?? 2;
  const tree = getTree();

  const reviewIds = db.prepare('SELECT id FROM cards WHERE user_id = ? AND due <= ? ORDER BY due LIMIT 50')
    .all(userId, today).map((r) => r.id);

  const learnedKids = new Set(db.prepare('SELECT DISTINCT knowledge_id FROM cards WHERE user_id = ? AND knowledge_id IS NOT NULL')
    .all(userId).map((r) => r.knowledge_id));

  const candidates = tree.nodes.filter((n) => inTrack(n, track) && !learnedKids.has(n.id));
  // 由易到难，避免一上来就撞压轴
  candidates.sort((a, b) => (a.difficulty - b.difficulty) || a.sort_order - b.sort_order);
  const newIds = candidates.slice(0, dailyNew).map((n) => n.id);

  // 每日一练：错题优先 → 掌握度低 → 补足随机
  const weak = db.prepare(`
    SELECT kid, COUNT(*) n FROM stats_question WHERE user_id = ? AND ok = 0 GROUP BY kid ORDER BY n DESC LIMIT 10
  `).all(userId).map((r) => r.kid);

  const picked = [];
  const usedQ = new Set();
  const pickFrom = (kid) => {
    const rows = db.prepare('SELECT id FROM questions WHERE kid = ? AND owner_id IS NULL ORDER BY RANDOM() LIMIT 3').all(kid);
    for (const r of rows) {
      if (picked.length >= 5) return;
      if (usedQ.has(r.id)) continue;
      usedQ.add(r.id);
      picked.push(r.id);
    }
  };
  weak.forEach((kid) => { if (picked.length < 5) pickFrom(kid); });

  if (picked.length < 5) {
    const pool = tree.nodes.filter((n) => inTrack(n, track)).map((n) => n.id);
    const shuffled = pool.sort(() => Math.random() - 0.5);
    shuffled.forEach((kid) => { if (picked.length < 5) pickFrom(kid); });
  }

  const row = {
    user_id: userId,
    date: today,
    review_ids: JSON.stringify(reviewIds),
    new_ids: JSON.stringify(newIds),
    quiz_ids: JSON.stringify(picked.slice(0, 5)),
    review_done: '[]',
    new_done: '[]',
    quiz_done: '[]',
  };

  if (force) {
    db.prepare(`INSERT INTO daily_plan (user_id,date,review_ids,new_ids,quiz_ids,review_done,new_done,quiz_done)
      VALUES (@user_id,@date,@review_ids,@new_ids,@quiz_ids,@review_done,@new_done,@quiz_done)
      ON CONFLICT(user_id,date) DO UPDATE SET review_ids=@review_ids, new_ids=@new_ids, quiz_ids=@quiz_ids,
        review_done='[]', new_done='[]', quiz_done='[]'`).run(row);
  } else {
    db.prepare(`INSERT OR IGNORE INTO daily_plan (user_id,date,review_ids,new_ids,quiz_ids,review_done,new_done,quiz_done)
      VALUES (@user_id,@date,@review_ids,@new_ids,@quiz_ids,@review_done,@new_done,@quiz_done)`).run(row);
  }

  return db.prepare('SELECT * FROM daily_plan WHERE user_id = ? AND date = ?').get(userId, today);
}
