/* 知识图谱：有向前置依赖的遍历与拓扑
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * 光有一张 knowledge_edges 表没用，真正要回答的是三个问题：
 *   1. 「我错在洛必达，真正没打牢的是哪个更早的东西？」 → ancestors()
 *   2. 「补这一个能顺带救回多少个考点？」               → impactOf()
 *   3. 「以我现在的进度，下一个该学什么？」             → topoOrder()
 * 这三个都不是 SQL 一行能算的，都需要在图上游走。
 *
 * ── 方向约定（与 schema.sql 一致，这里再写一遍）────────────────────
 *   from_kid = 前置（先学的）  →  to_kid = 后继（后学的）
 *
 *   所以：in[] 收集「我的前置」，out[] 收集「依赖我的后代」。
 *   找祖先走 in，找后代走 out。搞反了整套诊断就是错的。
 *
 * ── 关于 related / confusable 为什么不参与路径规划 ─────────────────
 *   related     两边都算邻居（无先后）
 *   confusable  两边都算邻居（用来出辨析题）
 *   这两种边在遍历时会**双向**展开，但默认的 ancestors/descendants
 *   只看 prereq —— 因为「易混」不代表「必须先学」，拿它做学习路径
 *   会把推荐顺序搅乱。
 *
 * ── 环 ────────────────────────────────────────────────────────────
 *   prereq 子图必须是 DAG。有环的话拓扑排序直接死循环，
 *   而且环意味着「A 是 B 的前置、B 又是 A 的前置」，这在语义上就不成立。
 *   findCycles() 是硬门禁，测试里必须跑。
 */
import { db } from '../db/index.js';

/** 参与遍历的边类型。prereq 有向；related / confusable 双向。 */
const BIDIRECTIONAL = new Set(['related', 'confusable']);

let _graph = null;

/**
 * 进程内缓存的图结构。与 getTree() 同生命周期 ——
 * 知识点是静态数据，每个请求重建邻接表是纯浪费。
 */
export function getGraph() {
  if (_graph) return _graph;

  const rows = db.prepare('SELECT from_kid, to_kid, type, strength, reason, source FROM knowledge_edges').all();

  const out = new Map();   // kid -> [{ kid, type, strength, reason, dir: 'out' }]
  const inb = new Map();   // kid -> [{ kid, type, strength, reason, dir: 'in' }]
  const push = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };

  for (const e of rows) {
    const meta = { type: e.type, strength: e.strength, reason: e.reason, source: e.source };
    push(out, e.from_kid, { kid: e.to_kid, ...meta });
    push(inb, e.to_kid, { kid: e.from_kid, ...meta });

    if (BIDIRECTIONAL.has(e.type)) {
      push(out, e.to_kid, { kid: e.from_kid, ...meta });
      push(inb, e.from_kid, { kid: e.to_kid, ...meta });
    }
  }

  _graph = {
    edges: rows,
    out,
    in: inb,
    /** 只含 prereq 的有向邻接表，拓扑与环检测专用。 */
    prereqOut: buildPrereqAdj(rows, 'out'),
    prereqIn: buildPrereqAdj(rows, 'in'),
    edgeCount: rows.length,
  };
  return _graph;
}

export function invalidateGraph() { _graph = null; }

function buildPrereqAdj(rows, side) {
  const m = new Map();
  for (const e of rows) {
    if (e.type !== 'prereq') continue;
    const [from, to] = side === 'out' ? [e.from_kid, e.to_kid] : [e.to_kid, e.from_kid];
    if (!m.has(from)) m.set(from, []);
    m.get(from).push(to);
  }
  return m;
}

/* ---------- 遍历 ---------- */

const ALL_TYPES = ['prereq', 'related', 'confusable'];

/**
 * 沿某方向做广度优先展开。
 *
 * @param {string} start
 * @param {'in'|'out'} dir   in = 往前置走，out = 往后代走
 * @param {object} opts
 * @param {number} opts.depth    最大层数，默认不限
 * @param {string[]} opts.types  只看哪些边类型，默认只 prereq
 * @param {boolean} opts.withMeta 是否连边信息一起返回（诊断要显示「为什么」）
 * @returns {Map<string, {depth:number, via:object[]}>}
 */
function walk(start, dir, { depth = Infinity, types = ['prereq'], withMeta = false } = {}) {
  const g = getGraph();
  const adj = dir === 'in' ? g.in : g.out;
  const seen = new Map();
  if (!start) return seen;

  let frontier = [start];
  seen.set(start, { depth: 0, via: [] });

  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of (adj.get(cur) || [])) {
        if (!types.includes(e.type)) continue;
        if (seen.has(e.kid)) continue;
        seen.set(e.kid, { depth: d, via: withMeta ? [e] : [] });
        next.push(e.kid);
      }
    }
    frontier = next;
  }

  seen.delete(start);   // 自己不算自己的祖先
  return seen;
}

/** 所有「应该先学」的节点（含跨章节）。 */
export function ancestors(kid, opts) { return walk(kid, 'in', opts); }

/** 所有「依赖它」的节点。数量就是修它的收益面。 */
export function descendants(kid, opts) { return walk(kid, 'out', opts); }

/** 所有类型的邻居（用于前端画图）。 */
export function neighbors(kid, dir, opts = {}) {
  return walk(kid, dir, { types: ALL_TYPES, withMeta: true, ...opts });
}

/**
 * 影响面：这个节点的后代数量。
 *
 * 这是根因排序里的关键权重 —— 「极限存在性」被 20 个考点依赖，
 * 「傅里叶级数」一个都不依赖，两者都没掌握时该先补谁一目了然。
 * 不加这个权重，就退化回「哪道题错得多先做哪个」。
 */
export function impactOf(kid) {
  return descendants(kid).size;
}

/* ---------- 拓扑 ---------- */

/**
 * 只对 prereq 子图做环检测（DFS 三色）。
 *
 * 拆成「纯函数 + 读库包装」两层，是因为导入脚本必须在**写库之前**就拦住环 ——
 * 先写坏数据再回滚，是给自己找麻烦。脚本拿内存里的边调 findCyclesIn 就行。
 *
 * @param {Array<{from:string,to:string,type?:string}>} edges
 * @returns {string[][]} 每个环的节点路径；无环返回 []
 */
export function findCyclesIn(edges) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const e of edges) {
    if ((e.type || 'prereq') !== 'prereq') continue;
    add(e.from, e.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];

  const visit = (n) => {
    color.set(n, GRAY);
    stack.push(n);
    for (const m of (adj.get(n) || [])) {
      const c = color.get(m) || WHITE;
      if (c === GRAY) {
        const i = stack.indexOf(m);
        if (i >= 0) cycles.push(stack.slice(i).concat(m));
      } else if (c === WHITE) {
        visit(m);
      }
    }
    stack.pop();
    color.set(n, BLACK);
  };

  const nodes = new Set([...adj.keys()]);
  for (const vs of adj.values()) vs.forEach((v) => nodes.add(v));
  for (const n of nodes) if ((color.get(n) || WHITE) === WHITE) visit(n);

  return cycles;
}

/** 读库版本：拿当前库里已落地的边做环检测。 */
export function findCycles() {
  const g = getGraph();
  return findCyclesIn(g.edges.map((e) => ({ from: e.from_kid, to: e.to_kid, type: e.type })));
}

/**
 * Kahn 拓扑排序（prereq 子图）。
 *
 * @param {string[]} nodes 参与排序的节点集合；缺省用图里出现过的全部
 * @returns {string[]} 拓扑序；有环时返回已完成的部分
 */
export function topoOrder(nodes) {
  const g = getGraph();
  const set = nodes ? new Set(nodes) : null;
  const indeg = new Map();
  const adj = new Map();

  const track = (n) => { if (!indeg.has(n)) indeg.set(n, 0); };

  for (const [from, tos] of g.prereqOut) {
    for (const to of tos) {
      if (set && (!set.has(from) || !set.has(to))) continue;
      track(from); track(to);
      adj.set(from, (adj.get(from) || []).concat(to));
      indeg.set(to, indeg.get(to) + 1);
    }
  }
  if (set) for (const n of set) track(n);

  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of (adj.get(n) || [])) {
      const d = indeg.get(m) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  return order;
}

/* ---------- 给前端的整图 ---------- */

/**
 * 前端画图用的扁平结构。
 * 只输出 prereq 边 + 少量 related，confusable 单独一组 ——
 * 三种边混在一起画，视觉上就是一团毛线。
 */
export function graphPayload({ nodeIds } = {}) {
  const g = getGraph();
  const keep = nodeIds ? new Set(nodeIds) : null;
  const edges = g.edges.filter((e) => !keep || (keep.has(e.from_kid) && keep.has(e.to_kid)));

  const prereq = edges.filter((e) => e.type === 'prereq');
  const confusable = edges.filter((e) => e.type === 'confusable');
  const related = edges.filter((e) => e.type === 'related');

  const touched = new Set();
  edges.forEach((e) => { touched.add(e.from_kid); touched.add(e.to_kid); });

  return {
    edges: edges.map((e) => ({ from: e.from_kid, to: e.to_kid, type: e.type, strength: e.strength, reason: e.reason })),
    counts: { total: edges.length, prereq: prereq.length, confusable: confusable.length, related: related.length },
    touched: [...touched],
  };
}

/** 单节点的前后邻居，给知识点详情页用。 */
export function nodeContext(kid) {
  const g = getGraph();
  const pre = (g.in.get(kid) || []);
  const post = (g.out.get(kid) || []);
  const pick = (list, type) => list
    .filter((e) => e.type === type)
    .map((e) => ({ kid: e.kid, strength: e.strength, reason: e.reason, source: e.source }));

  return {
    prerequisites: pick(pre, 'prereq'),
    unlocks: pick(post, 'prereq'),
    confusable: pick(pre, 'confusable'),
    related: pick(pre, 'related'),
    impact: descendants(kid).size,
  };
}
