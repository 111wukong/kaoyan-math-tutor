/* 复习队列（FSRS-6，见 lib/fsrs.js）
 *
 * 评分接口是「一次复习」的唯一写入口，事务内完成：
 *   卡片状态推进 → 若关联题目则记一次作答 → 发 XP → 判成就 → 检查队列是否清空
 */
import { db } from '../db/index.js';
import { grade as fsrsGrade, newCard, currentRetrievability } from '../lib/fsrs.js';
import { insertCard, updateCardSchedule } from '../lib/cardStore.js';
import { awardXp, checkAchievements, XP, buildSnapshot } from '../lib/game.js';
import { parseOptions } from '../lib/judge.js';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const shape = (c) => ({
  id: c.id,
  type: c.type,
  knowledgeId: c.knowledge_id,
  questionId: c.question_id,
  due: c.due,
  interval: c.interval,
  /* FSRS 状态。老库迁移过来的卡这两列是 NULL，前端要能处理「还没有稳定度」。 */
  state: c.state || 'new',
  stability: c.stability == null ? null : Number(c.stability),
  difficulty: c.difficulty == null ? null : Number(c.difficulty),
  /* 当前还记得的概率。用来在界面上提示「这张卡现在大概还剩多少印象」——
   * 比单纯显示「还有 3 天到期」信息量大得多。 */
  retrievability: currentRetrievability({
    stability: c.stability,
    interval: c.interval,
    lastReview: c.last_review,
  }) ?? null,
  reps: c.reps,
  ef: Number(c.ef),
  lapses: c.lapses,
  lastReview: c.last_review,
  createdAt: c.created_at,
  kidTitle: c.kid_title || null,
  content: c.content || null,
  example: c.example || null,
  stem: c.stem || null,
  options: c.options ? parseOptions(c) : null,
  answer: c.answer || null,
  analysis: c.analysis || null,
});

const JOIN = `
  SELECT c.*, k.title AS kid_title, k.content, k.example, q.stem, q.options, q.answer, q.analysis
  FROM cards c
  LEFT JOIN knowledge k ON k.id = c.knowledge_id
  LEFT JOIN questions q ON q.id = c.question_id
`;

export default async function cardRoutes(fastify) {
  /* ---------- 到期队列 ---------- */
  fastify.get('/api/cards/due', async (req) => {
    const today = todayStr();
    const rows = db.prepare(`${JOIN} WHERE c.user_id = ? AND c.due <= ? ORDER BY c.due, c.type DESC LIMIT 200`)
      .all(req.userId, today);
    return { cards: rows.map(shape), today, count: rows.length };
  });

  /* ---------- 全部卡片（按到期日）---------- */
  fastify.get('/api/cards', async (req) => {
    const { kid, type, limit = 200 } = req.query;
    const where = ['c.user_id = @uid'];
    const params = { uid: req.userId, limit: Math.min(1000, Number(limit) || 200) };
    if (kid) { where.push('c.knowledge_id = @kid'); params.kid = kid; }
    if (type) { where.push('c.type = @type'); params.type = type; }
    const rows = db.prepare(`${JOIN} WHERE ${where.join(' AND ')} ORDER BY c.due LIMIT @limit`).all(params);
    return { cards: rows.map(shape), count: rows.length };
  });

  /* ---------- 队列概况 ---------- */
  fastify.get('/api/cards/summary', async (req) => {
    const today = todayStr();
    const due = db.prepare('SELECT COUNT(*) n FROM cards WHERE user_id = ? AND due <= ?').get(req.userId, today).n;
    const total = db.prepare('SELECT COUNT(*) n FROM cards WHERE user_id = ?').get(req.userId).n;
    const upcoming = db.prepare(`
      SELECT due, COUNT(*) n FROM cards WHERE user_id = ? AND due > ? GROUP BY due ORDER BY due LIMIT 14
    `).all(req.userId, today);
    const byType = db.prepare('SELECT type, COUNT(*) n FROM cards WHERE user_id = ? GROUP BY type').all(req.userId);
    const avgEf = db.prepare('SELECT AVG(ef) v FROM cards WHERE user_id = ?').get(req.userId).v;
    const leeches = db.prepare('SELECT COUNT(*) n FROM cards WHERE user_id = ? AND lapses >= 4').get(req.userId).n;
    return {
      due, total, upcoming, byType,
      avgEf: avgEf ? Number(avgEf).toFixed(2) : null,
      leeches,
      today,
    };
  });

  /* ---------- 评分（复习的唯一写入口）---------- */
  fastify.post('/api/cards/:id/grade', {
    schema: {
      body: { type: 'object', required: ['rating'], properties: { rating: { type: 'integer', minimum: 1, maximum: 4 } } },
    },
  }, async (req, reply) => {
    const { rating } = req.body;
    const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!card) return reply.code(404).send({ error: '卡片不存在' });

    const today = todayStr();

    const run = db.transaction(() => {
      /* 把整张卡交给 grade()，而不是挑几个字段 —— FSRS 要用到 state /
       * stability / difficulty / last_review 才能算「现在还记得多少」。
       * 老卡这几列可能是 NULL，grade() 内部会用 interval 反推。 */
      const next = fsrsGrade(card, rating);
      updateCardSchedule(db, req.userId, card.id, next);

      // 复习也计入作答统计（自评「记得」以上视为答对）
      if (card.question_id || card.knowledge_id) {
        const kid = card.knowledge_id;
        const ok = rating >= 3 ? 1 : 0;
        const qid = card.question_id || `card:${card.id}`;
        const now = Date.now();
        db.prepare(`INSERT INTO attempts (id,user_id,qid,kid,answer,correct,context,date,ts) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run('a_' + now.toString(36) + Math.random().toString(36).slice(2, 8), req.userId, qid, kid, `rating:${rating}`, ok, 'review', today, now);
        if (kid) {
          db.prepare(`INSERT INTO stats_node (user_id,kid,n,c,ts) VALUES (?,?,1,?,?)
            ON CONFLICT(user_id,kid) DO UPDATE SET n=n+1, c=c+excluded.c, ts=excluded.ts`)
            .run(req.userId, kid, ok, now);
        }
        db.prepare(`INSERT INTO stats_question (user_id,qid,kid,n,c,ok,ts) VALUES (?,?,?,1,?,?,?)
          ON CONFLICT(user_id,qid) DO UPDATE SET n=n+1, c=c+excluded.c, ok=excluded.ok, ts=excluded.ts`)
          .run(req.userId, qid, kid || '', ok, ok, now);
        db.prepare(`INSERT INTO stats_daily (user_id,date,n,c) VALUES (?,?,1,?)
          ON CONFLICT(user_id,date) DO UPDATE SET n=n+1, c=c+excluded.c`)
          .run(req.userId, today, ok);
      }

      const xp = awardXp(req.userId, 'review', { rating });
      void XP;

      // 队列清空 → 打一个 flag 供「队列清零」成就判定
      const remaining = db.prepare('SELECT COUNT(*) n FROM cards WHERE user_id = ? AND due <= ?').get(req.userId, today).n;
      if (remaining === 0) {
        const g = db.prepare('SELECT flags FROM game_state WHERE user_id = ?').get(req.userId) || { flags: '{}' };
        let f = {}; try { f = JSON.parse(g.flags || '{}'); } catch { f = {}; }
        f.clearedQueue = 1;
        db.prepare('UPDATE game_state SET flags = ? WHERE user_id = ?').run(JSON.stringify(f), req.userId);
      }

      const fresh = checkAchievements(req.userId);
      return { next, xp, fresh, remaining };
    });

    const r = run();
    /* 重新读一次再交给 shape()，而不是手工拼 grade() 的返回值 ——
     * shape 会补上 retrievability 这类**派生**字段，手工拼一定会漏
     * （加 FSRS 时就是这么漏掉的：接口返回里没有可回忆概率）。 */
    const saved = db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id);
    return {
      card: shape(saved),
      xp: r.xp,
      achievements: r.fresh,
      remaining: r.remaining,
    };
  });

  /* ---------- 手动建卡 ---------- */
  fastify.post('/api/cards', {
    schema: {
      body: {
        type: 'object',
        properties: {
          knowledgeId: { type: 'string' },
          questionId: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { knowledgeId = null, questionId = null, type = 'knowledge' } = req.body || {};
    const c = newCard(knowledgeId, questionId, type);
    insertCard(db, req.userId, c);
    return { ok: true, card: c };
  });

  /* ---------- 删卡 ---------- */
  fastify.delete('/api/cards/:id', async (req) => {
    db.prepare('DELETE FROM cards WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    return { ok: true };
  });

  /* ---------- 学习进度（仪表盘用）---------- */
  fastify.get('/api/cards/progress', async (req) => {
    const snap = buildSnapshot(req.userId, { track: req.query.track || 'math1' });
    return { snapshot: snap };
  });
}
