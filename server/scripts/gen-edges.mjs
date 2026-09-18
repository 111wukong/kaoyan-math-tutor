/* 知识图谱校验 + 导入
 *
 * ── 这个脚本解决什么 ──────────────────────────────────────────────
 * edges.json 是人（和模型）写的，人写的数据一定会有：
 *   · 手滑把 to 写成不存在的 id
 *   · 同一个 from/to 写两遍
 *   · related 边正反各写一条（本意是双向，但存储只存一行）
 *   · **造出环** —— 这个最要命，A 是 B 的前置、B 又是 A 的前置，
 *     拓扑排序会死循环，而且语义上根本不成立
 * 所以导入前必须有一道门。环检测是硬失败，其余是警告。
 *
 * ── 为什么校验和导入放在同一个脚本 ────────────────────────────────
 * 校验通过才导入，两者中间不该有「人工确认」的空档 ——
 * 那等于给了「先写进去再说」的机会。要改数据就改 edges.json 重跑。
 *
 * 跑法：
 *   node server/scripts/gen-edges.mjs          校验并导入
 *   node server/scripts/gen-edges.mjs --check  只校验，不写库
 *   node server/scripts/gen-edges.mjs --stats  校验 + 打印图谱体检报告
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../src/db/index.js';
import { findCyclesIn, invalidateGraph } from '../src/lib/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EDGES_FILE = path.join(ROOT, 'src/data/edges.json');

const TYPES = new Set(['prereq', 'related', 'confusable']);
const STRENGTHS = new Set(['hard', 'soft']);
const BIDIRECTIONAL = new Set(['related', 'confusable']);

export function readEdgesFile(file = EDGES_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { version: raw.version, note: raw.note, edges: raw.edges || [] };
}

/**
 * 纯校验，不碰数据库。
 *
 * @param {Array} edges  edges.json 里的边（字段名 from / to）
 * @param {Set<string>} nodeIds 合法节点 id 集合
 * @returns {{errors:string[], warnings:string[], cycles:string[][], stats:object}}
 */
export function validateEdges(edges, nodeIds) {
  const errors = [];
  const warnings = [];
  const seen = new Set();

  edges.forEach((e, i) => {
    const at = `第 ${i + 1} 条`;
    if (!e.from || !e.to) { errors.push(`${at}：缺 from 或 to`); return; }
    if (!nodeIds.has(e.from)) errors.push(`${at}：from「${e.from}」不是已存在的知识点`);
    if (!nodeIds.has(e.to)) errors.push(`${at}：to「${e.to}」不是已存在的知识点`);
    if (e.from === e.to) errors.push(`${at}：${e.from} 指向自己`);
    if (e.type && !TYPES.has(e.type)) errors.push(`${at}：type「${e.type}」不合法`);
    if (e.strength && !STRENGTHS.has(e.strength)) errors.push(`${at}：strength「${e.strength}」不合法`);
    if (!e.reason || !String(e.reason).trim()) {
      warnings.push(`${at}：${e.from} → ${e.to} 没有写 reason，审核时看不出为什么这么连`);
    }

    const key = `${e.from}|${e.to}|${e.type || 'prereq'}`;
    if (seen.has(key)) errors.push(`${at}：${key} 重复`);
    seen.add(key);

    /* related / confusable 是双向语义，存储只存一行。
     * 正反各写一条不会算错，但会让前端画两条重叠的线，还让边数虚高。 */
    if (BIDIRECTIONAL.has(e.type)) {
      const rev = `${e.to}|${e.from}|${e.type}`;
      if (seen.has(rev)) {
        warnings.push(`${at}：${e.from} ↔ ${e.to} 的 ${e.type} 边反向也写了一条，删掉一条即可（双向是语义，不用存两行）`);
      }
    }
  });

  const cycles = findCyclesIn(edges.map((e) => ({ from: e.from, to: e.to, type: e.type || 'prereq' })));
  if (cycles.length) {
    cycles.forEach((c) => errors.push(`环：${c.join(' → ')}`));
  }

  return { errors, warnings, cycles, stats: summarize(edges, nodeIds) };
}

/** 图谱体检：覆盖率、出度分布、最长链。 */
function summarize(edges, nodeIds) {
  const byType = {};
  const byStrength = {};
  const outDeg = new Map();
  const inDeg = new Map();

  for (const e of edges) {
    const t = e.type || 'prereq';
    byType[t] = (byType[t] || 0) + 1;
    if (t === 'prereq') {
      const s = e.strength || 'hard';
      byStrength[s] = (byStrength[s] || 0) + 1;
      outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
      inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    }
  }

  const prereqEdges = edges.filter((e) => (e.type || 'prereq') === 'prereq');
  const withPrereq = new Set(prereqEdges.map((e) => e.to));
  const hasSuccessor = new Set(prereqEdges.map((e) => e.from));
  const isolated = [...nodeIds].filter((id) => !withPrereq.has(id) && !hasSuccessor.has(id));

  return {
    total: edges.length,
    byType,
    byStrength,
    nodes: nodeIds.size,
    nodesWithPrereq: withPrereq.size,
    nodesUnlocking: hasSuccessor.size,
    isolated,
    maxOutDegree: Math.max(0, ...outDeg.values()),
    maxInDegree: Math.max(0, ...inDeg.values()),
    maxChain: longestChain(prereqEdges),
  };
}

/** 最长前置链（DAG 上的最长路径），用来判断图谱是不是一条线。 */
function longestChain(prereqEdges) {
  const adj = new Map();
  const indeg = new Map();
  for (const e of prereqEdges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    if (!indeg.has(e.from)) indeg.set(e.from, 0);
  }
  const memo = new Map();
  const depth = (n) => {
    if (memo.has(n)) return memo.get(n);
    memo.set(n, 1);   // 防环兜底（环已被硬门禁拦住，这里只是别挂死）
    let best = 1;
    for (const m of (adj.get(n) || [])) best = Math.max(best, 1 + depth(m));
    memo.set(n, best);
    return best;
  };
  let max = 0;
  for (const n of indeg.keys()) max = Math.max(max, depth(n));
  return max;
}

/** 幂等导入：先清空再写入，保证库与文件一致。 */
export function importEdges(edges) {
  initSchema();
  const ins = db.prepare(`INSERT INTO knowledge_edges (from_kid,to_kid,type,strength,reason,source)
    VALUES (@from,@to,@type,@strength,@reason,@source)`);
  const run = db.transaction(() => {
    db.exec('DELETE FROM knowledge_edges');
    for (const e of edges) {
      ins.run({
        from: e.from,
        to: e.to,
        type: e.type || 'prereq',
        strength: e.strength || 'hard',
        reason: e.reason || '',
        source: e.source || 'manual',
      });
    }
  });
  run();
  invalidateGraph();
  return edges.length;
}

/* ---------- 命令行 ---------- */
const isMain = process.argv[1] && process.argv[1].endsWith('gen-edges.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const wantStats = args.includes('--stats');

  initSchema();
  const nodeIds = new Set(db.prepare('SELECT id FROM knowledge').all().map((r) => r.id));
  if (!nodeIds.size) {
    console.error('[edges] knowledge 表是空的 —— 先跑 npm run seed');
    process.exit(1);
  }

  const { edges } = readEdgesFile();
  const { errors, warnings, stats } = validateEdges(edges, nodeIds);

  if (warnings.length) {
    console.log(`\n\x1b[33m${warnings.length} 条警告：\x1b[0m`);
    warnings.forEach((w) => console.log('  · ' + w));
  }

  if (errors.length) {
    console.error(`\n\x1b[31m${errors.length} 条错误，未写入：\x1b[0m`);
    errors.forEach((e) => console.error('  ✗ ' + e));
    process.exit(1);
  }

  if (wantStats) {
    console.log('\n\x1b[1m图谱体检\x1b[0m');
    console.log(`  边总数        ${stats.total}`);
    console.log(`  按类型        ${Object.entries(stats.byType).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    console.log(`  前置强度      ${Object.entries(stats.byStrength).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    console.log(`  知识点        ${stats.nodes} 个，其中 ${stats.nodesWithPrereq} 个有前置`);
    console.log(`  出度最大/入度最大  ${stats.maxOutDegree} / ${stats.maxInDegree}`);
    console.log(`  最长前置链    ${stats.maxChain} 层`);
    if (stats.isolated.length) {
      console.log(`  \x1b[33m孤立节点 ${stats.isolated.length} 个：${stats.isolated.join('、')}\x1b[0m`);
    }
  }

  if (checkOnly) {
    console.log(`\n\x1b[32m✅ 校验通过（${edges.length} 条边，未写库）\x1b[0m`);
    process.exit(0);
  }

  const n = importEdges(edges);
  console.log(`\n\x1b[32m✅ 已导入 ${n} 条边\x1b[0m`);
}
