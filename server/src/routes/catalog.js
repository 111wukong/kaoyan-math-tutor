/* 知识树与题库（只读 + 用户掌握状态） */
import { db } from '../db/index.js';
import { getTree, masteryBoard, nodeMastery, inTrack } from '../lib/game.js';
import { nodeContext } from '../lib/graph.js';
import { publicQuestion } from '../lib/judge.js';

export default async function catalogRoutes(fastify) {
  /* ---------- 完整知识树（带掌握状态）---------- */
  fastify.get('/api/catalog/tree', async (req) => {
    const track = req.query.track || 'math1';
    const tree = getTree();
    const board = masteryBoard(req.userId, { track });
    const rowByNode = new Map(board.rows.map((r) => [r.nodeId, r]));

    const nodesByChapter = tree.nodes.reduce((acc, n) => {
      (acc[n.chapter_id] = acc[n.chapter_id] || []).push(n);
      return acc;
    }, {});
    const chaptersByCat = tree.chapters.reduce((acc, c) => {
      (acc[c.category_id] = acc[c.category_id] || []).push(c);
      return acc;
    }, {});

    const categories = tree.categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      color: cat.color,
      chapters: (chaptersByCat[cat.id] || []).map((ch) => {
        const all = nodesByChapter[ch.id] || [];
        const visible = all.filter((n) => inTrack(n, track));
        const rows = visible.map((n) => {
          const m = rowByNode.get(n.id) || { level: 'new', label: '未学' };
          return {
            id: n.id,
            title: n.title,
            difficulty: n.difficulty,
            exam: n.exam,
            mastery: m.level,
            masteryLabel: m.label,
            accuracy: m.accuracy,
            attempts: m.attempts,
            questions: m.questions,
            hasCard: m.hasCard,
          };
        });
        const mastered = rows.filter((r) => r.hasCard).length;
        return {
          id: ch.id,
          name: ch.name,
          nodes: rows,
          total: rows.length,
          mastered,
          lit: rows.length > 0 && mastered >= rows.length,
        };
      }).filter((ch) => ch.nodes.length > 0),
    })).filter((c) => c.chapters.length > 0);

    return {
      track,
      categories,
      mastery: {
        dist: board.dist,
        pct: board.pct,
        total: board.total,
        learned: board.learned,
        label: board.label,
      },
    };
  });

  /* ---------- 知识点详情 ---------- */
  fastify.get('/api/catalog/knowledge/:id', async (req, reply) => {
    const tree = getTree();
    const node = tree.nodeById.get(req.params.id);
    if (!node) return reply.code(404).send({ error: '知识点不存在' });

    const chapter = tree.chapters.find((c) => c.id === node.chapter_id);
    const category = tree.categories.find((c) => c.id === node.category_id);

    const qs = db.prepare('SELECT * FROM questions WHERE kid = ? ORDER BY id').all(node.id);
    const mastery = nodeMastery(req.userId, node.id);

    const related = (node.related || []).map((id) => {
      const r = tree.nodeById.get(id);
      return r ? { id: r.id, title: r.title } : null;
    }).filter(Boolean);

    /* 图谱上下文：前置 / 解锁 / 易混 / 影响面。
     * 与上面的 related 是两回事 —— related 是旧的无向 JSON 字段（保留兼容），
     * graph 是有向边。前端要展示「学这个之前得先会什么」只能用 graph。 */
    const ctx = nodeContext(node.id);
    const withTitle = (list) => list.map((e) => ({
      id: e.kid,
      title: tree.nodeById.get(e.kid)?.title || e.kid,
      strength: e.strength,
      reason: e.reason,
      source: e.source,
    }));
    const graph = {
      prerequisites: withTitle(ctx.prerequisites),
      unlocks: withTitle(ctx.unlocks),
      confusable: withTitle(ctx.confusable),
      impact: ctx.impact,
    };

    const notes = db.prepare('SELECT id, text, date FROM notes WHERE user_id = ? AND kid = ? ORDER BY created_at DESC')
      .all(req.userId, node.id);

    const card = db.prepare('SELECT * FROM cards WHERE user_id = ? AND knowledge_id = ? AND type = ?')
      .get(req.userId, node.id, 'knowledge');

    // 该节点作答历史（最近 20 条），带题目原文摘要
    const history = db.prepare(`
      SELECT a.qid, a.answer, a.correct, a.date, a.ts, q.stem
      FROM attempts a LEFT JOIN questions q ON q.id = a.qid
      WHERE a.user_id = ? AND a.kid = ? ORDER BY a.ts DESC LIMIT 20
    `).all(req.userId, node.id);

    return {
      node: {
        id: node.id, title: node.title, content: node.content, example: node.example,
        difficulty: node.difficulty, exam: node.exam,
        chapterId: node.chapter_id, chapterName: chapter?.name || '',
        categoryId: node.category_id, categoryName: category?.name || '',
        color: category?.color || '#3b82f6',
      },
      mastery,
      related,
      graph,
      notes,
      card: card || null,
      questions: qs.map((q) => publicQuestion(q, { withAnswer: false })),
      history,
    };
  });

  /* ---------- 题库筛选 ---------- */
  fastify.get('/api/catalog/questions', async (req) => {
    const { kid, type, difficulty, sourceType, year, limit = 50, random = '0' } = req.query;
    const where = ['(owner_id IS NULL OR owner_id = @uid)'];
    const params = { uid: req.userId };

    if (kid) { where.push('kid = @kid'); params.kid = kid; }
    if (type) { where.push('type = @type'); params.type = type; }
    if (difficulty) { where.push('difficulty = @difficulty'); params.difficulty = Number(difficulty); }
    if (sourceType) { where.push('source_type = @sourceType'); params.sourceType = sourceType; }
    if (year) { where.push('source_year = @year'); params.year = Number(year); }

    const order = random === '1' ? 'RANDOM()' : 'id';
    const rows = db.prepare(`SELECT * FROM questions WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT @limit`)
      .all({ ...params, limit: Math.min(500, Number(limit) || 50) });

    return { questions: rows.map((q) => publicQuestion(q, { withAnswer: false })), count: rows.length };
  });

  /* ---------- 题库筛选维度（给筛选面板用）---------- */
  fastify.get('/api/catalog/facets', async () => {
    const sources = db.prepare(`SELECT source_type v, COUNT(*) n FROM questions WHERE owner_id IS NULL AND source_type <> '' GROUP BY source_type`).all();
    const years = db.prepare(`SELECT source_year v, COUNT(*) n FROM questions WHERE owner_id IS NULL AND source_year IS NOT NULL GROUP BY source_year ORDER BY source_year`).all();
    const difficulties = db.prepare(`SELECT difficulty v, COUNT(*) n FROM questions WHERE owner_id IS NULL GROUP BY difficulty ORDER BY difficulty`).all();
    const types = db.prepare(`SELECT type v, COUNT(*) n FROM questions WHERE owner_id IS NULL GROUP BY type`).all();
    const total = db.prepare('SELECT COUNT(*) n FROM questions WHERE owner_id IS NULL').get().n;
    return { sources, years, difficulties, types, total };
  });

  /* ---------- 单题详情（含答案，用于复盘）---------- */
  fastify.get('/api/catalog/questions/:id', async (req, reply) => {
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
    if (!q) return reply.code(404).send({ error: '题目不存在' });
    const stat = db.prepare('SELECT n, c, ok FROM stats_question WHERE user_id = ? AND qid = ?').get(req.userId, q.id);
    return { question: publicQuestion(q, { withAnswer: true }), stat: stat || { n: 0, c: 0, ok: 0 } };
  });
}
