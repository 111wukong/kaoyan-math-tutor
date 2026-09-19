/* FSRS-6 间隔重复调度器
 *
 * ── 为什么换掉 SM-2 ────────────────────────────────────────────────
 * SM-2 是 1987 年的算法：只有一个 EF 因子，复习间隔按固定倍率滚。
 * FSRS 把「记忆」拆成两个可学习的量：
 *   stability（S）  记忆稳定度 —— 保留率降到 90% 所需的天数
 *   difficulty（D） 这张卡对这个人的难度（1–10）
 * 每次作答都用遗忘曲线反推「你现在还记得的概率是多少」，再据此调整 S。
 * 好处是同样多的复习次数，能把时间更多地花在快忘掉的卡上。
 *
 * ── 参数与公式来源 ────────────────────────────────────────────────
 * 全部取自 open-spaced-repetition/ts-fsrs（792★，TypeScript）：
 *   packages/fsrs/src/constant.ts   → default_w（21 个权重）
 *   packages/fsrs/src/algorithm.ts  → forgetting_curve / init_* / next_*
 * 没有凭记忆编数字 —— 权重是从参考实现里逐个数抄下来的。
 *
 * ── 与原版的差异（有意为之，写清楚免得后人以为漏了）────────────────
 *   1. **不做 fuzz**。原版给间隔加随机抖动，避免大量卡片挤在同一天。
 *      这里卡片量级是几十张，抖动带来的不可复现性反而碍事（测试难写）。
 *   2. **不做学习步骤（learning steps）**。这个应用按「天」调度，
 *      due 是个日期字符串，分钟级的步骤没有落点。
 *      enable_short_term 只保留 t=0（同一天内二次复习）那一支。
 *   3. 间隔上限 365 天。原版默认 36500 —— 对备考来说没有意义。
 */
import { addDays, today } from './dates.js';

/** FSRS-6 默认权重，逐个数取自 ts-fsrs 的 constant.ts。 */
export const W = Object.freeze([
  0.212,    // w0  初始稳定度 Again
  1.2931,   // w1  初始稳定度 Hard
  2.3065,   // w2  初始稳定度 Good
  8.2956,   // w3  初始稳定度 Easy
  6.4133,   // w4  初始难度（Good 时 D0 = w4）
  0.8334,   // w5  初始难度随评分的指数
  3.0194,   // w6  难度增量系数
  0.001,    // w7  难度均值回归强度
  1.8722,   // w8  成功时稳定度增量系数
  0.1666,   // w9  成功时 S 的指数
  0.796,    // w10 成功时 (1-R) 的指数
  1.4835,   // w11 遗忘时稳定度系数
  0.0614,   // w12 遗忘时 D 的指数
  0.2629,   // w13 遗忘时 (S+1) 的指数
  1.6483,   // w14 遗忘时 (1-R) 的指数
  0.6014,   // w15 Hard 惩罚
  1.8729,   // w16 Easy 奖励
  0.5425,   // w17 短期（同日）稳定度系数
  0.0912,   // w18 短期稳定度指数
  0.0658,   // w19 短期稳定度偏移
  0.1542,   // w20 衰减指数（FSRS6_DEFAULT_DECAY）
]);

const S_MIN = 0.01;
const S_MAX = 36500;
/** 间隔上限。原版 36500 天，备考场景用不到，压到一年。 */
const MAX_INTERVAL = 365;
/** 目标保留率。90% 是 FSRS 的默认值，也是「间隔 = 稳定度」的由来。 */
const REQUEST_RETENTION = 0.9;

/* decay 取负 —— 参考实现里就是这么处理的（computeDecayFactor 里 -decayOrParams[20]）。 */
const DECAY = -W[20];
const FACTOR = Math.exp(Math.pow(DECAY, -1) * Math.log(0.9)) - 1;
/* 间隔倍率：让 R(interval) 正好等于目标保留率。
 * 保留率取 0.9 时它等于 1，也就是「间隔 = 稳定度」；留着这个算式是为了
 * 以后想调保留率时不用重推公式。 */
const INTERVAL_MODIFIER = (Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1) / FACTOR;

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const round8 = (x) => Math.round(x * 1e8) / 1e8;

/**
 * 遗忘曲线：距今 elapsedDays 天、稳定度为 stability 时，还记得的概率。
 *   R(t,S) = (1 + FACTOR · t/S)^DECAY
 * 代入 t = S 得 0.9 —— 这正是「稳定度 = 保留率降到 90% 的天数」的定义。
 */
export function retrievability(elapsedDays, stability) {
  if (!(stability > 0)) return 0;
  const t = Math.max(0, elapsedDays);
  return round8(Math.pow(1 + (FACTOR * t) / stability, DECAY));
}

/** 第一次作答后的初始稳定度。 */
export function initStability(g) {
  return Math.max(W[g - 1], 0.1);
}

/** 第一次作答后的初始难度。评分 3（记得）时正好等于 w4。 */
export function initDifficulty(g) {
  return clamp(round8(W[4] - Math.exp((g - 1) * W[5]) + 1), 1, 10);
}

/** 难度越靠近两端，改起来越慢 —— 否则一张卡会被一两次手滑带跑偏。 */
function linearDamping(deltaD, oldD) {
  return round8((deltaD * (10 - oldD)) / 9);
}

function meanReversion(init, current) {
  return round8(W[7] * init + (1 - W[7]) * current);
}

export function nextDifficulty(d, g) {
  const deltaD = -W[6] * (g - 3);
  const nextD = d + linearDamping(deltaD, d);
  return clamp(meanReversion(initDifficulty(4), nextD), 1, 10);
}

/** 答对之后的稳定度。Hard 打惩罚、Easy 给奖励。 */
export function nextRecallStability(d, s, r, g) {
  const hardPenalty = g === 2 ? W[15] : 1;
  const easyBound = g === 4 ? W[16] : 1;
  const next = s * (1
    + Math.exp(W[8])
      * (11 - d)
      * Math.pow(s, -W[9])
      * (Math.exp((1 - r) * W[10]) - 1)
      * hardPenalty
      * easyBound);
  return round8(clamp(next, S_MIN, S_MAX));
}

/** 答错之后的稳定度 —— 通常比原来更低，但不会归零。 */
export function nextForgetStability(d, s, r) {
  const next = W[11]
    * Math.pow(d, -W[12])
    * (Math.pow(s + 1, W[13]) - 1)
    * Math.exp((1 - r) * W[14]);
  /* 上界是 S / e^(w17·w18)：一次遗忘最多把稳定度打到这个比例，
   * 不会「一道题没想起来就全忘了」。 */
  const ceiling = s / Math.exp(W[17] * W[18]);
  return round8(clamp(clamp(next, S_MIN, S_MAX), S_MIN, Math.max(ceiling, S_MIN)));
}

/** 同一天内的二次复习（t = 0）：只看评分，不看遗忘曲线。 */
export function nextShortTermStability(s, g) {
  const next = s * Math.exp(W[17] * (g - 3 + W[18]) * Math.pow(s, -W[19]));
  return round8(clamp(next, S_MIN, S_MAX));
}

/** 稳定度 → 下次间隔（天）。 */
export function nextInterval(stability) {
  return clamp(Math.round(stability * INTERVAL_MODIFIER), 1, MAX_INTERVAL);
}

/** 两个日期字符串之间差几天。 */
export function daysBetween(fromStr, toStr) {
  const a = new Date(`${fromStr}T00:00:00`);
  const b = new Date(`${toStr}T00:00:00`);
  return Math.max(0, Math.round((b - a) / 864e5));
}

/* ---------- 对外接口（与原来的 sm2.js 保持同形，调用方不用改结构）---------- */

/**
 * 新建一张卡。
 *
 * state='new'、stability/difficulty 留空 —— 第一次作答时才由评分决定，
 * 这是 FSRS 的设计（初始稳定度取决于你第一次答得有多轻松）。
 */
export function newCard(knowledgeId, questionId, cardType) {
  const id = 'card_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
  return {
    id,
    type: cardType || 'knowledge',
    knowledgeId: knowledgeId || null,
    questionId: questionId || null,
    state: 'new',
    stability: null,
    difficulty: null,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: addDays(today(), 1),
    lastReview: null,
    createdAt: today(),
  };
}

/**
 * 复习一次后的新状态。纯函数 —— 同样的输入永远给同样的输出，测试好写。
 *
 * @param {object} card  至少要有 state / stability / difficulty / reps / lapses / lastReview
 * @param {1|2|3|4} rating  1=忘了 2=吃力 3=记得 4=很熟（对应 FSRS 的 Again/Hard/Good/Easy）
 */
export function grade(card, rating) {
  const g = clamp(Math.round(Number(rating) || 1), 1, 4);
  const todayStr = today();

  const state = card.state || (card.reps > 0 ? 'review' : 'new');
  const reps = card.reps || 0;
  const lapses = card.lapses || 0;

  /* 已存在的卡如果没有 FSRS 状态（老库迁移过来的），用 interval 反推：
   * interval 本来就约等于稳定度（保留率 90% 时两者相等），
   * 难度取中性值 5，之后几次复习会自己收敛。 */
  let s = card.stability != null ? Number(card.stability) : null;
  let d = card.difficulty != null ? Number(card.difficulty) : null;
  if (s == null && (card.interval || 0) > 0) s = Math.max(Number(card.interval), 0.1);
  if (d == null && (card.interval || 0) > 0) d = 5;

  const elapsed = card.lastReview ? daysBetween(card.lastReview, todayStr) : 0;

  let nextS;
  let nextD;
  let nextState;

  if (s == null || d == null) {
    /* 第一次作答 */
    nextS = initStability(g);
    nextD = initDifficulty(g);
    nextState = g === 1 ? 'learning' : 'review';
  } else {
    const r = retrievability(elapsed, s);
    if (elapsed === 0) {
      nextS = nextShortTermStability(s, g);
    } else if (g === 1) {
      nextS = nextForgetStability(d, s, r);
    } else {
      nextS = nextRecallStability(d, s, r, g);
    }
    nextD = nextDifficulty(d, g);
    if (g === 1) nextState = state === 'review' ? 'relearning' : 'learning';
    else nextState = 'review';
  }

  return {
    state: nextState,
    stability: nextS,
    difficulty: nextD,
    interval: nextInterval(nextS),
    reps: reps + 1,
    lapses: g === 1 ? lapses + 1 : lapses,
    due: addDays(todayStr, nextInterval(nextS)),
    lastReview: todayStr,
  };
}

/**
 * 诊断用：这张卡现在的可回忆概率。
 * 复习队列拿它排序 —— 「快忘掉的」排在前面，比单纯按 due 排更贴近实际需要。
 */
export function currentRetrievability(card, todayStr = today()) {
  const s = card.stability != null
    ? Number(card.stability)
    : (card.interval > 0 ? Number(card.interval) : null);
  if (!s || !card.lastReview) return null;
  return retrievability(daysBetween(card.lastReview, todayStr), s);
}
