/* 知识树与题库（只读 + 用户掌握状态） */
import { db, rebuildStats } from '../db/index.js';
import { getTree, masteryBoard, nodeMastery, inTrack } from '../lib/game.js';
import { nodeContext } from '../lib/graph.js';
import {
  publicQuestion, answerIssue, canonicalAnswer,
  QUESTION_TYPES, OPTION_TYPES, SELF_GRADED_TYPES,
} from '../lib/judge.js';

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
  /* ---------- 公式库（公式手册）----------
   *
   * 为什么不做成「前端内置一份 JSON」：
   *   公式要按章节筛、按考点关联、按必背过滤，还要跟着知识树的
   *   掌握度走。放服务端才能和 knowledge / mastery 一起查。
   *
   * 返回**扁平且已排好序**的列表，分组交给前端 ——
   * 前端本来就要按筛选结果重新分组，服务端先分好一份，两边的分组口径
   * 迟早会打架（比如筛完之后空掉的组，服务端删还是前端删？）。
   * 排序口径：章节顺序 → 章内 sort_order。前端按 chapterId 的连续段分组即可。
   */
  fastify.get('/api/catalog/formulas', async (req) => {
    const track = req.query.track || 'math1';
    const q = String(req.query.q || '').trim().toLowerCase();
    const chapter = String(req.query.chapter || '');
    const kid = String(req.query.kid || '');
    const mustOnly = req.query.must === '1';

    const tree = getTree();
    const board = masteryBoard(req.userId, { track });
    const levelByNode = new Map(board.rows.map((r) => [r.nodeId, r.level]));
    const chapterById = new Map(tree.chapters.map((c) => [c.id, c]));
    const catById = new Map(tree.categories.map((c) => [c.id, c]));
    const chOrder = new Map(tree.chapters.map((c, i) => [c.id, i]));

    let rows = db.prepare('SELECT * FROM formulas').all();
    if (chapter) rows = rows.filter((r) => r.chapter_id === chapter);
    if (kid) rows = rows.filter((r) => r.kid === kid);
    if (mustOnly) rows = rows.filter((r) => r.must === 1);
    if (q) {
      /* 搜名字、LaTeX、条件、备注、分组标题五处。
       * 只搜名字不够用 —— 学生记得的是符号（「sinx/x」），不是条目名。 */
      rows = rows.filter((r) => [r.name, r.tex, r.cond, r.note, r.grp]
        .some((v) => String(v || '').toLowerCase().includes(q)));
    }

    rows.sort((a, b) => (chOrder.get(a.chapter_id) ?? 99) - (chOrder.get(b.chapter_id) ?? 99)
      || a.sort_order - b.sort_order);

    const items = rows.map((r) => {
      const ch = chapterById.get(r.chapter_id);
      const cat = ch ? catById.get(ch.category_id) : null;
      const node = r.kid ? tree.nodeById.get(r.kid) : null;
      return {
        id: r.id,
        chapterId: r.chapter_id,
        chapterName: ch ? ch.name : '',
        categoryId: cat ? cat.id : '',
        categoryName: cat ? cat.name : '',
        kid: r.kid || null,
        kidTitle: node ? node.title : null,
        /** 该公式所属考点的掌握状态 —— 界面靠它标「已学 / 未学」 */
        mastery: r.kid ? (levelByNode.get(r.kid) || 'new') : null,
        group: r.grp,
        name: r.name,
        tex: r.tex,
        cond: r.cond,
        note: r.note,
        must: r.must,
      };
    });

    return {
      items,
      count: items.length,
      /** 库里一共多少条（不受筛选影响）—— 界面要能说清「筛掉了多少」 */
      total: db.prepare('SELECT COUNT(*) n FROM formulas').get().n,
      mustCount: items.filter((x) => x.must).length,
      coveredKids: new Set(items.filter((x) => x.kid).map((x) => x.kid)).size,
      chapters: new Set(items.map((x) => x.chapterId)).size,
    };
  });

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

    /* 带上 mine —— 前端要靠它决定「能不能改 / 能不能删」。
     * 让前端去猜 id 前缀（u_ / g_ / q01）迟早会猜错，
     * 而且那是存储细节，不该泄漏到 UI 层。 */
    return {
      questions: rows.map((q) => ({
        ...publicQuestion(q, { withAnswer: false }),
        mine: q.owner_id === req.userId,
      })),
      count: rows.length,
    };
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

  /* ============ 自建题（录题）============
   *
   * 内置题库只有 204 道，而真题卷子上的错题才是真正的短板所在。
   * 这一组接口让用户把那些题录进来 —— 录完就能作答、进错题本、
   * 参与掌握度，也能被 AI 分析错因。
   *
   * ── 为什么录入时要卡答案 ────────────────────────────────────────
   * 判题器只对数值做容差比对（判据在 judge.js 的 answerIssue）。
   * 录一道判不了的题，用户之后每次答对都会被判错，而且没有任何提示 ——
   * 与其让他过几天来困惑，不如录入时就拦住，并说清该怎么改。
   */

  /** 校验并规整一条自建题。返回 { error } 或 { row }。 */
  function prepareQuestion(body, tree) {
    const kid = String(body?.kid ?? '').trim();
    if (!tree.nodeById.has(kid)) return { error: '考点不存在' };

    /* 题型白名单。不在名单里的一律当单选题 —— 但**不是静默**：
     * 下面 answerIssue 会按单选题去校验答案，形态不对就会报出来。 */
    const type = QUESTION_TYPES.includes(body?.type) ? body.type : 'choice';
    const stem = String(body?.stem ?? '').trim().slice(0, 800);
    if (stem.length < 5) return { error: '题干太短了，至少写 5 个字' };

    /* 答案按题型规整。这一步和判题器用的是同一个 canonicalAnswer ——
     * 录进去什么形态、判题时期待什么形态，只能有一处定义。 */
    const answer = canonicalAnswer(type, body?.answer);

    const issue = answerIssue(type, answer);
    if (issue) return { error: issue };

    /* ---------- 选项 ---------- */
    let options = null;
    if (type === 'judge') {
      /* 判断题的选项是**固定的两个**，不让用户填 ——
       * 让他填就一定会有人写成「正确/不正确」「真/假」，
       * 而判题器只认 T/F 这一组键。写死在这里，前端只需渲染。 */
      options = JSON.stringify([{ k: 'T', t: '正确' }, { k: 'F', t: '错误' }]);
    } else if (OPTION_TYPES.has(type)) {
      const raw = Array.isArray(body?.options) ? body.options : [];
      const clean = raw.map((o, i) => ({
        k: String(o?.k ?? 'ABCDEF'[i] ?? '').trim().toUpperCase().slice(0, 1),
        t: String(o?.t ?? '').trim().slice(0, 300),
      })).filter((o) => o.k && o.t);

      if (type === 'choice') {
        if (clean.length !== 4 || clean.map((o) => o.k).join('') !== 'ABCD') {
          return { error: '单选题需要正好四个选项，标号是 A / B / C / D' };
        }
        /* 这里**不需要**再检查「答案在不在选项里」：
         * 上一行已经保证选项键正好是 ABCD，而 answerIssue 保证答案是 A–D 之一，
         * 两者一交，答案必然在选项里。写一个永远不成立的检查只会让人以为
         * 这里有保护，实际是死的 —— 端到端测试里就是这么暴露出来的。 */
      } else {
        /* 多选题允许 4~6 个选项，标号必须从 A 连续排下去。
         * 不连续的话 normLetters 会把答案字母和选项键对不上号 ——
         * 比如选项只有 A、B、D（缺 C），答案 'ABD' 里那个 D 指向谁就说不清了。 */
        if (clean.length < 4 || clean.length > 6) {
          return { error: '多选题需要 4~6 个选项' };
        }
        const want = 'ABCDEF'.slice(0, clean.length);
        if (clean.map((o) => o.k).join('') !== want) {
          return { error: `多选题的选项标号要从 A 连续排到 ${want[want.length - 1]}` };
        }
        if (answer.split('').some((k) => !want.includes(k))) {
          return { error: `答案「${answer}」里有不存在的选项（只有 ${want}）` };
        }
        if (answer.length < 2) {
          return { error: '多选题至少要勾 2 个选项' };
        }
      }
      options = JSON.stringify(clean);
    }

    /* ---------- 评分点（解答 / 证明）---------- */
    let steps = '[]';
    if (SELF_GRADED_TYPES.has(type)) {
      const raw = Array.isArray(body?.steps) ? body.steps : [];
      const clean = raw
        .map((s) => ({
          t: String(s?.t ?? '').trim().slice(0, 500),
          pts: Math.max(0, Math.min(20, Number(s?.pts) || 0)),
        }))
        .filter((s) => s.t);
      if (clean.length > 12) return { error: '评分点最多 12 条' };
      steps = JSON.stringify(clean);
    }

    return {
      row: {
        kid,
        type,
        difficulty: Math.min(4, Math.max(1, Number(body?.difficulty) || 2)),
        stem,
        options,
        answer,
        analysis: String(body?.analysis ?? '').trim().slice(0, 2000),
        steps,
        sourceType: String(body?.sourceType ?? '').trim().slice(0, 40) || '自建',
        sourceYear: Number(body?.sourceYear) || null,
        source: String(body?.source ?? '').trim().slice(0, 80) || '手动录入',
      },
    };
  }

  /* ---------- 新建题目 ---------- */
  fastify.post('/api/questions', {
    schema: {
      body: {
        type: 'object',
        required: ['kid', 'stem', 'answer'],
        properties: {
          kid: { type: 'string', maxLength: 64 },
          type: { type: 'string', maxLength: 16 },
          /* ★ 上限是必须的。全局 bodyLimit 是 8MB，没有 maxLength 的话
           * 一道题的题干可以塞进 8MB —— 实测 200KB 一次通过。
           * 录题是手输的，5000 字符对一道数学题绰绰有余。 */
          stem: { type: 'string', maxLength: 5000 },
          options: { type: 'array', maxItems: 12 },
          steps: { type: 'array', maxItems: 12 },
          answer: { type: 'string', maxLength: 2000 },
          analysis: { type: 'string', maxLength: 5000 },
          difficulty: { type: 'integer', minimum: 1, maximum: 5 },
          sourceType: { type: 'string', maxLength: 32 },
          sourceYear: { type: 'integer', minimum: 1900, maximum: 2100 },
          source: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { error, row } = prepareQuestion(req.body, getTree());
    if (error) return reply.code(400).send({ error });

    const id = 'u_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    db.prepare(`INSERT INTO questions (id,kid,type,difficulty,stem,options,answer,analysis,source_type,source_year,source,owner_id)
      VALUES (@id,@kid,@type,@difficulty,@stem,@options,@answer,@analysis,@sourceType,@sourceYear,@source,@ownerId)`)
      .run({ id, ...row, ownerId: req.userId });

    const saved = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    return { ok: true, question: publicQuestion(saved, { withAnswer: true }) };
  });

  /* ---------- 单题详情（含答案，用于复盘）---------- */
  fastify.get('/api/catalog/questions/:id', async (req, reply) => {
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
    if (!q) return reply.code(404).send({ error: '题目不存在' });
    const stat = db.prepare('SELECT n, c, ok FROM stats_question WHERE user_id = ? AND qid = ?').get(req.userId, q.id);
    return { question: publicQuestion(q, { withAnswer: true }), stat: stat || { n: 0, c: 0, ok: 0 } };
  });

  /* ---------- 改自己的题 ----------
   * 内置题不能改。用 404 而不是 403：内置题的 id 是公开的，
   * 但没必要告诉调用者「它存在、只是不归你」。 */
  fastify.put('/api/questions/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          kid: { type: 'string' },
          type: { type: 'string' },
          stem: { type: 'string' },
          options: { type: 'array' },
          steps: { type: 'array' },
          answer: { type: 'string' },
          analysis: { type: 'string' },
          difficulty: { type: 'integer' },
          sourceType: { type: 'string' },
          sourceYear: { type: 'integer' },
          source: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const own = db.prepare('SELECT * FROM questions WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.userId);
    if (!own) return reply.code(404).send({ error: '题目不存在，或者不是你创建的' });

    /* 部分更新：没传的字段沿用原值。
     *
     * 不这么做的话，编辑时只想改题干，却因为没把 options 一起传回来
     * 被「选择题需要四个选项」拒掉 —— 而前端根本不知道要回传哪些字段。
     * 合并之后再走同一套校验，所以改完的题仍然是可判分的。 */
    const ownOptions = own.options ? JSON.parse(own.options) : undefined;
    const merged = {
      kid: req.body?.kid ?? own.kid,
      type: req.body?.type ?? own.type,
      stem: req.body?.stem ?? own.stem,
      options: req.body?.options ?? ownOptions,
      answer: req.body?.answer ?? own.answer,
      analysis: req.body?.analysis ?? own.analysis,
      difficulty: req.body?.difficulty ?? own.difficulty,
      sourceType: req.body?.sourceType ?? own.source_type,
      sourceYear: req.body?.sourceYear ?? own.source_year,
      source: req.body?.source ?? own.source,
    };

    const { error, row } = prepareQuestion(merged, getTree());
    if (error) return reply.code(400).send({ error });

    db.prepare(`UPDATE questions SET kid=@kid, type=@type, difficulty=@difficulty, stem=@stem,
      options=@options, answer=@answer, analysis=@analysis, source_type=@sourceType,
      source_year=@sourceYear, source=@source WHERE id=@id`).run({ ...row, id: own.id });

    const saved = db.prepare('SELECT * FROM questions WHERE id = ?').get(own.id);
    return { ok: true, question: publicQuestion(saved, { withAnswer: true }) };
  });

  /* ---------- 删自己的题 ---------- */
  fastify.delete('/api/questions/:id', async (req, reply) => {
    const own = db.prepare('SELECT id FROM questions WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.userId);
    if (!own) return reply.code(404).send({ error: '题目不存在，或者不是你创建的' });

    /* 连作答记录一起清掉，然后重建聚合表。
     * 不删明细的话 stats_node 里会留着一个已不存在题目的计数 ——
     * 掌握度虚高，而这个用户删题的意图恰恰是「这道题不算数」。 */
    const run = db.transaction(() => {
      db.prepare('DELETE FROM attempts WHERE user_id = ? AND qid = ?').run(req.userId, own.id);
      db.prepare('DELETE FROM stats_question WHERE user_id = ? AND qid = ?').run(req.userId, own.id);
      db.prepare('DELETE FROM questions WHERE id = ?').run(own.id);
      rebuildStats(req.userId);
    });
    run();
    return { ok: true };
  });
}
