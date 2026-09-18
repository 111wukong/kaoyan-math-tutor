/* 知识图谱接口
 *
 * 只读。给前端画依赖图用，同时也把掌握度叠上去 ——
 * 前端拿到的是一个「带状态的图」，不需要自己再 join 一遍学情。
 *
 * 为什么不复用 /api/catalog/tree：
 * 那个接口返回的是**树**（category → chapter → node），层级完整但边被丢掉了。
 * 图谱要的是扁平节点 + 边表，两者结构不一样，硬塞进一个接口会让两边都别扭。
 */
import { getTree, masteryBoard, inTrack } from '../lib/game.js';
import { graphPayload, impactOf, getGraph } from '../lib/graph.js';
import { graphHealth } from '../lib/diagnose.js';

export default async function graphRoutes(fastify) {
  /* ---------- 整图 ---------- */
  fastify.get('/api/graph', async (req) => {
    const track = req.query.track || 'math1';
    const tree = getTree();
    const board = masteryBoard(req.userId, { track });
    const rowByNode = new Map(board.rows.map((r) => [r.nodeId, r]));

    const inTrackNodes = tree.nodes.filter((n) => inTrack(n, track));
    const ids = inTrackNodes.map((n) => n.id);
    const payload = graphPayload({ nodeIds: ids });

    const chapterById = new Map(tree.chapters.map((c) => [c.id, c]));
    const g = getGraph();

    const nodes = inTrackNodes.map((n) => {
      const r = rowByNode.get(n.id);
      const pre = (g.in.get(n.id) || []).filter((e) => e.type === 'prereq');
      return {
        id: n.id,
        title: n.title,
        chapterId: n.chapter_id,
        chapterName: chapterById.get(n.chapter_id)?.name || '',
        categoryId: n.category_id,
        difficulty: n.difficulty,
        level: r?.level || 'new',
        label: r?.label || '未学',
        accuracy: r ? Number((r.accuracy || 0).toFixed(3)) : 0,
        attempts: r?.attempts || 0,
        /* 影响面：这个节点卡住多少个下游。前端用它决定节点大小 ——
         * 一眼就能看出「极限」比「傅里叶级数」重要得多。 */
        impact: impactOf(n.id),
        prereqCount: pre.length,
        hardPrereqCount: pre.filter((e) => e.strength === 'hard').length,
      };
    });

    return {
      nodes,
      edges: payload.edges,
      counts: payload.counts,
      dist: board.dist,
      pct: board.pct,
      health: graphHealth(),
    };
  });

  /* ---------- 单节点的依赖上下文 ----------
   * 与 /api/catalog/knowledge/:id 的 graph 字段内容一致，
   * 但那个接口要连题目、笔记、卡片一起返回，用在图上太重。 */
  fastify.get('/api/graph/node/:id', async (req, reply) => {
    const tree = getTree();
    const node = tree.nodeById.get(req.params.id);
    if (!node) return reply.code(404).send({ error: '知识点不存在' });

    const g = getGraph();
    const withTitle = (list) => list.map((e) => ({
      id: e.kid,
      title: tree.nodeById.get(e.kid)?.title || e.kid,
      strength: e.strength,
      reason: e.reason,
      source: e.source,
    }));

    const pre = g.in.get(node.id) || [];
    const post = g.out.get(node.id) || [];

    return {
      id: node.id,
      title: node.title,
      prerequisites: withTitle(pre.filter((e) => e.type === 'prereq')),
      unlocks: withTitle(post.filter((e) => e.type === 'prereq')),
      confusable: withTitle(pre.filter((e) => e.type === 'confusable')),
      impact: impactOf(node.id),
    };
  });
}
