/* 图谱驱动的诊断与路径规划
 *
 * ── 这个文件要解决的问题 ──────────────────────────────────────────
 * 旧的薄弱点排序是一行公式：
 *     score = (1 - 正确率) × 难度 × (1 + 错题数 × 0.5)
 * 它只看节点自己，于是必然得出「你在洛必达错得多，那就多刷洛必达」。
 * 但考研数学最常见的情况恰恰不是这样：洛必达用不好，是因为
 * 三个月前的极限存在性没打牢 —— 再刷一百道洛必达也没用。
 *
 * 这一层做两件事：
 *   1. diagnoseRoots()  从症状（错题）沿前置边回溯，找真正的根因
 *   2. nextToLearn()    按拓扑序推荐，前置没打牢的节点不推
 *
 * ── 为什么单开一个文件，不塞进 graph.js ───────────────────────────
 * graph.js 是纯图算法（只依赖数据库），这一层要读用户的掌握度，
 * 依赖 game.js。分开之后 graph.js 可以被任何地方安全引用，
 * 不会和 game.js 形成循环依赖。
 */
import { db } from '../db/index.js';
import { getTree, masteryBoard, inTrack } from './game.js';
import { ancestors, descendants, topoOrder, getGraph } from './graph.js';

/** 判定为「症状」的门槛：正确率低于这个值且作答过 ≥2 次。 */
const WEAK_ACCURACY = 0.6;
const WEAK_MIN_ATTEMPTS = 2;

/** 回溯深度上限。图最深 10 层，超过 4 层基本就是「整个学科的地基」，指出来也没用。 */
const MAX_DEPTH = 4;

/**
 * 未作答节点的「缺口」取值。
 *
 * 为什么不是 1（满格）：没做过 ≠ 不会。一个从没在本系统里作答过的前置，
 * 完全可能早就会了，只是没刷这里的题。而「做过且做错」是**实证**。
 * 两者给同样的缺口，诊断就会把「你没碰过导数定义」排在
 * 「你求导法则 0 分」前面 —— 端到端验证时就是这么错的。
 *
 * 为什么不是 0：没学过的前置确实该补，清零会让整条链上的空白节点全部消失，
 * 用户永远看不到「你还缺这一块」。
 *
 * 0.5 的含义：把它当成「有一半概率是短板」，排在实证问题之后，但在无关项之前。
 */
const GAP_UNKNOWN = 0.5;

/**
 * 「前置已就绪」的正确率门槛（只对 hard 前置生效）。
 *
 * 只看 level === 'new' 是不够的：一个正确率 0% 的 learning 节点照样会被放行，
 * 于是系统推荐你去攻洛必达，而你的求导法则还是 0 分 —— 换汤不换药，
 * 还是「硬上」。0.5 是「学过一点且不算差」的合理下限。
 */
const BLOCK_ACCURACY = 0.5;

/**
 * 收集症状节点：错题 + 低正确率。
 *
 * 为什么不只用错题：错题是「做过且做错」，但还有一类更麻烦的 ——
 * 做过几次、每次都蒙对，正确率虚高。这类节点不会出现在错题本里，
 * 却会在综合题里崩掉。所以正确率也算一路。
 */
function collectSymptoms(userId, board) {
  const wrongByKid = new Map(
    db.prepare('SELECT kid, COUNT(*) n FROM stats_question WHERE user_id = ? AND ok = 0 GROUP BY kid')
      .all(userId).map((r) => [r.kid, r.n]),
  );

  const symptoms = [];
  for (const r of board.rows) {
    const wrong = wrongByKid.get(r.nodeId) || 0;
    const weakAccuracy = r.attempts >= WEAK_MIN_ATTEMPTS && r.accuracy < WEAK_ACCURACY;
    if (wrong > 0 || weakAccuracy) {
      symptoms.push({ nodeId: r.nodeId, wrong, accuracy: r.accuracy, attempts: r.attempts, level: r.level });
    }
  }
  return symptoms;
}

/**
 * 根因回溯。
 *
 * 打分三要素（缺任何一个都会退化成没用的推荐）：
 *
 *   masteryGap   掌握缺口。已经掌握的前置不是根因 —— 没有这一项，
 *                会把「你早就学会了的基础」也推给你。
 *   coverage     症状覆盖数：这个祖先被**多少个当前出问题的节点**依赖。
 *                注意不是后代总数 —— 后代总数是静态的（极限永远是 20 个
 *                考点的祖先），而覆盖数是动态的，跟着你当前错在哪走。
 *   depthPenalty 距离衰减。隔了 4 层的前置，即使没掌握，也不该排在第一。
 *
 * strength 只做微调：hard 前置缺了学不动，soft 缺了能学但吃力，
 * 所以 soft 的分数打个折，但不清零。
 */
export function diagnoseRoots(userId, { track = 'math1', limit = 5, maxDepth = MAX_DEPTH } = {}) {
  const tree = getTree();
  const board = masteryBoard(userId, { track });
  const symptoms = collectSymptoms(userId, board);

  if (!symptoms.length) {
    return { roots: [], symptomCount: 0, scanned: 0, message: '还没有足够的作答记录，先做几道题再来看诊断。' };
  }

  const byNode = new Map(board.rows.map((r) => [r.nodeId, r]));
  const symptomIds = new Set(symptoms.map((s) => s.nodeId));

  /* 每个祖先节点 → 它覆盖了哪些症状节点。
   * 同一个祖先可能通过多条路径到达同一个症状，用 Set 去重。 */
  const cover = new Map();
  for (const s of symptoms) {
    const anc = ancestors(s.nodeId, { depth: maxDepth, types: ['prereq'], withMeta: true });
    for (const [kid, info] of anc) {
      const node = tree.nodeById.get(kid);
      if (!node || !inTrack(node, track)) continue;
      if (!cover.has(kid)) cover.set(kid, { depth: info.depth, via: info.via, symptoms: new Set() });
      const rec = cover.get(kid);
      rec.depth = Math.min(rec.depth, info.depth);
      rec.symptoms.add(s.nodeId);
    }
  }

  const roots = [];
  for (const [kid, rec] of cover) {
    const node = tree.nodeById.get(kid);
    const stat = byNode.get(kid);
    if (!stat) continue;

    /* 已经熟练/精通的前置不是根因 —— 这一条是「别推荐你早就会的东西」的保证。 */
    if (stat.level === 'proficient' || stat.level === 'mastered') continue;

    const gap = stat.level === 'new' ? GAP_UNKNOWN : 1 - (stat.accuracy || 0);
    if (gap <= 0) continue;

    const coverage = rec.symptoms.size;
    /* 距离衰减：第 1 层系数 1，第 2 层 0.71，第 3 层 0.58，第 4 层 0.5。
     * 用 1/√d 而不是 1/d —— 衰减太快的话，跨章节的真根因（往往在 2-3 层外）
     * 永远排不上来，等于又退回了「只看直接前置」。 */
    const depthPenalty = 1 / Math.sqrt(Math.max(1, rec.depth));
    /* 边的强度取该祖先到症状路径上最强的那条 —— 有一条 hard 就按 hard 算。 */
    const strength = (rec.via || []).some((e) => e.strength === 'hard') ? 'hard' : 'soft';
    const strengthFactor = strength === 'hard' ? 1 : 0.6;

    const score = gap * Math.sqrt(coverage) * depthPenalty * strengthFactor;

    /* kind 区分两种完全不同的处境：
     *   gap  从未学过 —— 这是知识盲区，得去学
     *   weak 学过但没打牢 —— 这是理解问题，得去补
     * 混成一个「薄弱」，用户不知道该学还是该练。 */
    const kind = stat.level === 'new' ? 'gap' : 'weak';

    const coveredSymptoms = [...rec.symptoms].map((sid) => {
      const sn = tree.nodeById.get(sid);
      const sym = symptoms.find((x) => x.nodeId === sid);
      return { nodeId: sid, title: sn?.title || sid, wrong: sym?.wrong || 0, accuracy: sym?.accuracy ?? 0 };
    }).sort((a, b) => b.wrong - a.wrong);

    roots.push({
      nodeId: kid,
      title: node?.title || kid,
      chapterId: node?.chapter_id,
      difficulty: node?.difficulty,
      kind,
      level: stat.level,
      label: stat.label,
      accuracy: Number((stat.accuracy || 0).toFixed(3)),
      attempts: stat.attempts,
      coverage,
      depth: rec.depth,
      strength,
      score: Number(score.toFixed(3)),
      coveredSymptoms,
      why: buildWhy(kind, stat, coverage, coveredSymptoms),
    });
  }

  roots.sort((a, b) => b.score - a.score || b.coverage - a.coverage);

  return {
    roots: roots.slice(0, limit),
    symptomCount: symptoms.length,
    scanned: cover.size,
    message: roots.length
      ? `从 ${symptoms.length} 个出问题的考点里回溯出 ${roots.length} 个根因。`
      : '回溯没有找到共同的前置缺口 —— 你出问题的地方比较分散，逐章排查即可。',
  };
}

function buildWhy(kind, stat, coverage, covered) {
  const pct = Math.round((stat.accuracy || 0) * 100);
  const head = kind === 'gap'
    ? '这个前置你还没学过'
    : `这个前置只做到 ${pct}% 正确率，没打牢`;
  const tail = coverage > 1
    ? `，而它卡住了 ${coverage} 个当前出问题的考点（${covered.slice(0, 3).map((c) => c.title).join('、')}${coverage > 3 ? ' 等' : ''}）`
    : `，${covered[0]?.title || '相关考点'}就卡在它上面`;
  return head + tail + '。先补它，比继续刷后面的题划算。';
}

/**
 * 拓扑序学习路径。
 *
 * 与旧逻辑的关键差别：**前置没打牢的节点不进候选**。
 * 旧逻辑按难度排，会把「泰勒公式」推给一个连导数定义都含糊的人 ——
 * 那不是推荐，那是挖坑。
 *
 * 「前置已满足」的口径分两档：
 *   hard 前置 —— 必须学过，且正确率不低于 BLOCK_ACCURACY（学过但 0 分不算数）
 *   soft 前置 —— 只要学过就放行
 * 不严到「必须 proficient」，否则大部分人会永远无路可走；
 * 也不松到「只要学过就放行」，否则系统会推荐你硬上自己 0 分的前置 ——
 * 那正是这个功能本来要治的病。
 *
 * 唯一的例外是根因节点，它豁免拦截，理由见下面 rootRank 那段。
 */
export function nextToLearn(userId, { track = 'math1', limit = 3 } = {}) {
  const tree = getTree();
  const board = masteryBoard(userId, { track });
  const byNode = new Map(board.rows.map((r) => [r.nodeId, r]));

  const wrongByKid = new Map(
    db.prepare('SELECT kid, COUNT(*) n FROM stats_question WHERE user_id = ? AND ok = 0 GROUP BY kid')
      .all(userId).map((r) => [r.kid, r.n]),
  );

  /* 根因豁免。
   *
   * 不加这一段会出现逻辑自相矛盾：诊断说「先补求导法则」，推荐却让你去学行列式。
   * 原因是求导法则的前置（导数定义）也没学过，于是它被 blockers 拦掉了 ——
   * 而 blockers 的本意是「还没轮到学」，不是「你已经做错了也别碰」。
   *
   * 根因节点是用户**实际做错过**的地方，证据比「拓扑序上还没轮到」强，
   * 所以对它豁免拦截，并给一个显著加分让它排到前面。
   * diagnoseRoots 和 nextToLearn 在同一个文件里，直接调用即可。 */
  const diag = diagnoseRoots(userId, { track, limit: 5 });
  const rootRank = new Map(diag.roots.map((r, i) => [r.nodeId, i]));

  const inTrackNodes = tree.nodes.filter((n) => inTrack(n, track));
  const order = topoOrder(inTrackNodes.map((n) => n.id));
  const orderIdx = new Map(order.map((id, i) => [id, i]));

  const g = getGraph();
  const items = [];
  const blockedList = [];

  for (const node of inTrackNodes) {
    const stat = byNode.get(node.id);
    if (!stat) continue;
    /* 已经熟练的不推 —— 推荐位有限，留给真正需要的。 */
    if (stat.level === 'proficient' || stat.level === 'mastered') continue;

    const rank = rootRank.has(node.id) ? rootRank.get(node.id) : -1;
    const isRoot = rank >= 0;

    const prereqs = (g.in.get(node.id) || []).filter((e) => e.type === 'prereq');
    const blockers = prereqs
      .map((e) => ({
        kid: e.kid,
        title: tree.nodeById.get(e.kid)?.title || e.kid,
        strength: e.strength,
        level: byNode.get(e.kid)?.level || 'new',
        accuracy: byNode.get(e.kid)?.accuracy || 0,
      }))
      /* 硬前置：没学过，或者学过但正确率不及格（学了个寂寞）。
       * 软前置：只要学过就放行 —— 它本来就不是「不学它学不懂」的关系，
       * 拿软前置卡人会让整个路径推荐几乎无路可走。 */
      .filter((b) => b.level === 'new'
        || (b.strength === 'hard' && b.accuracy < BLOCK_ACCURACY));

    const wrong = wrongByKid.get(node.id) || 0;

    if (blockers.length && !isRoot) {
      blockedList.push({
        nodeId: node.id,
        title: node.title,
        wrong,
        blockers: blockers.slice(0, 3).map((b) => ({
          nodeId: b.kid,
          title: b.title,
          level: b.level,
          accuracy: Number(b.accuracy.toFixed(3)),
        })),
      });
      continue;
    }

    /* 优先级：根因 > 错题 > 正在学 > 未学；同级里拓扑序靠前的先上。
     *
     * rootBoost 只用于 score 的展示，**排序不依赖它** —— 见下面 sort 的注释。
     * 这里保留它是因为前端可能想按 score 做可视化，但真正决定顺序的是 rank。 */
    const rootBoost = isRoot ? Math.max(0.5, 3 - rank * 0.5) : 0;
    const wrongBoost = wrong > 0 ? 2 : 0;
    const learningBoost = stat.level === 'learning' ? 1 : 0;
    const prereqDone = prereqs.filter((e) => {
      const lv = byNode.get(e.kid)?.level;
      return lv === 'proficient' || lv === 'mastered';
    }).length;
    const prereqRatio = prereqs.length ? prereqDone / prereqs.length : 1;

    const rootNote = diag.roots.find((r) => r.nodeId === node.id);
    items.push({
      nodeId: node.id,
      title: node.title,
      chapterId: node.chapter_id,
      difficulty: node.difficulty,
      level: stat.level,
      label: stat.label,
      accuracy: Number((stat.accuracy || 0).toFixed(3)),
      attempts: stat.attempts,
      wrong,
      isRoot,
      rank,
      prereqCount: prereqs.length,
      prereqRatio: Number(prereqRatio.toFixed(2)),
      order: orderIdx.has(node.id) ? orderIdx.get(node.id) : 999,
      score: Number((rootBoost + wrongBoost + learningBoost + prereqRatio + (4 - (node.difficulty || 2)) * 0.25).toFixed(3)),
      why: isRoot
        ? `回溯出来的根因：${rootNote?.coveredSymptoms?.length || 1} 个错题考点卡在它上面`
        : wrong > 0
          ? `错过 ${wrong} 道，前置已齐，可以集中攻`
          : stat.level === 'learning'
            ? '正在学，趁热打铁'
            : prereqs.length
              ? `前置（${prereqs.slice(0, 2).map((p) => tree.nodeById.get(p.kid)?.title || p.kid).join('、')}）已就绪`
              : '没有前置依赖，随时可以开始',
    });
  }

  /* 排序规则（顺序有意义，别改成单纯比 score）：
   *
   *   1. 根因一律排前面，且根因之间**严格按诊断排名**。
   *   2. 非根因之间才比 score。
   *
   * 为什么不把「根因优先」做成 score 里的一个加分项：
   * 试过，会错。加分差 0.5，而「前置完成度」这一项能差 1.0 ——
   * 于是诊断排第 2 的根因会被一个前置齐全的普通节点挤到第 3，
   * 两个接口给出的顺序对不上（测试里就是这么抓出来的）。
   * 根因优先是个**规则**，不是个权重，做成权重就一定会被淹没。 */
  items.sort((a, b) => {
    if (a.isRoot && b.isRoot) return a.rank - b.rank;
    if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
    return b.score - a.score || a.order - b.order;
  });
  blockedList.sort((a, b) => b.wrong - a.wrong);

  return {
    items: items.slice(0, limit),
    ready: items.length,
    blocked: blockedList.length,
    /* 带出被卡住的前几个，前端才能回答「为什么没推荐这个」——
     * 只给一个 blocked 数字，用户会以为系统坏了。 */
    blockedSample: blockedList.slice(0, 3),
    total: inTrackNodes.length,
    message: blockedList.length
      ? `${blockedList.length} 个考点因为前置没打牢被暂缓 —— 这是有意的，硬上会学不懂。`
      : '所有考点的前置都已就绪。',
  };
}

/**
 * 图谱健康度：给前端和测试用。
 * 会暴露「有多少节点是孤立的」，孤立节点意味着诊断到它就走不下去了。
 */
export function graphHealth() {
  const tree = getTree();
  const g = getGraph();
  const ids = new Set(tree.nodes.map((n) => n.id));
  const touched = new Set();
  g.edges.forEach((e) => { touched.add(e.from_kid); touched.add(e.to_kid); });

  return {
    nodes: ids.size,
    edges: g.edgeCount,
    isolated: [...ids].filter((id) => !touched.has(id)),
    dangling: g.edges
      .flatMap((e) => [e.from_kid, e.to_kid])
      .filter((id) => !ids.has(id)),
    byType: g.edges.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {}),
  };
}
