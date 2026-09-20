/* AI 批改（解答题 / 证明题）—— 提示词构造 + 结果清洗
 *
 * ── 为什么单开一个文件、而且不引 db / fastify ──────────────────────
 * 这里的两个函数是**纯的**：输入字符串和数组，输出字符串和对象。
 * 所以 tests/ai-grade.mjs 能直接 import 它们做全量断言，不需要起库、起服务、
 * 起假模型。批改的失效方式是**静默给错分**（学生明明做对，AI 给 2/10），
 * 这种错只能靠「喂一堆畸形模型输出去看清洗层怎么处理」来守。
 *
 * ── 这一层的职责边界 ──────────────────────────────────────────────
 * 模型负责「判断学生答得对不对」，代码负责**一切可以算出来的东西**：
 *   · 满分是多少   → 从库里的评分点求和，**不听模型的**
 *   · 总分是多少   → 把各步得分加起来，**不听模型的**
 *   · 分数是否合法 → 有限数、落在 [0, 该步满分] 内
 *   · 有没有胡编的步骤 → 索引必须在评分点范围内
 * 让模型算算术是自找麻烦：它会在总分上写一个和分步对不上的数，
 * 而用户一眼就看得出来，然后整个功能就不可信了。
 *
 * ── 解析失败怎么办 ────────────────────────────────────────────────
 * 返回 null。调用方（前端）回退到「用户自评」——那条路一直都在，
 * 所以模型抽风不会让功能不可用，只是少了一层便利。
 * **宁可回退，也不要拿一个错的分去记账**：分数会进 XP、掌握度、错题本，
 * 错一次要用户自己去发现。
 */

/** 没有评分点时，按 10 分制整体评。 */
export const DEFAULT_FULL = 10;

/**
 * 「算答对」的分数线。
 *
 * 0.6 不是随便定的：考研解答题按步骤给分，拿到六成基本说明**思路是通的**，
 * 只是细节有漏。低于这个数通常是方法就没找对 —— 那种情况更该进错题本。
 * 这个阈值只影响「记对还是记错」，不影响 AI 给出的具体分数（那个照实显示）。
 */
export const PASS_RATIO = 0.6;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 截断到 n 个字符，超出补省略号。防止模型写一大段把界面撑爆。 */
function cut(s, n) {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/* ============================================================
   提示词
   ============================================================ */

/**
 * 构造批改提示词。
 *
 * @param {object} q           题目行（需要 stem / type / answer）
 * @param {Array}  steps       评分点 [{t, pts}]，可以为空
 * @param {string} userAnswer  学生的作答原文
 */
export function buildGradePrompt(q, steps, userAnswer) {
  const hasSteps = Array.isArray(steps) && steps.length > 0;
  const full = hasSteps ? steps.reduce((a, s) => a + (Number(s.pts) || 0), 0) : DEFAULT_FULL;

  const stepBlock = hasSteps
    ? [
      `【评分点】满分 ${full} 分，逐条打分`,
      ...steps.map((s, i) => `  ${i + 1}. （${Number(s.pts) || 0} 分）${s.t}`),
    ].join('\n')
    : `【评分】没有预设评分点，请按 10 分制整体评。`;

  const shape = hasSteps
    ? '{"steps":[{"i":1,"got":4,"comment":"这一步的评语"},{"i":2,"got":0,"comment":"这一步的评语"}],"comment":"总评"}'
    : '{"score":7,"comment":"总评"}';

  return [
    '你是一名考研数学阅卷老师。请**严格**批改下面这份作答。',
    '',
    `【题目】（${q.type === 'proof' ? '证明题' : '解答题'}）`,
    cut(q.stem, 800),
    '',
    '【参考答案】',
    cut(q.answer, 1500),
    '',
    stepBlock,
    '',
    '【学生的作答】',
    cut(userAnswer, 2000) || '（空白）',
    '',
    '【批改要求】',
    '1. 逐条判断学生的作答是否**实质**覆盖了该评分点。',
    '   只写结论没写过程、写「显然」「易得」跳过去，都算没覆盖。',
    '2. 每个评分点给 0 到它满分之间的**整数**分。允许部分给分：',
    '   思路对但算错了，给一半；公式写对了但没代入，给三分之一。',
    '3. 不要因为措辞和参考答案不同就扣分，看的是数学实质。',
    '4. **只对列出的评分点打分，不要自己新增评分点。**',
    '5. 学生用完全不同的正确解法也算对 —— 那是解法不同，不是错。',
    '6. comment 用中文，指出**第一个**没拿满分的步骤差在哪；',
    '   全对就写一句肯定 + 一个这类题的易错提醒。每条不超过 60 字。',
    '7. 不确定时从严，不要给「安慰分」——这是给备考的人用的，虚高的分害他。',
    '',
    '只输出 JSON，不要任何解释文字、不要 markdown 代码块：',
    shape,
  ].join('\n');
}

/**
 * 构造「讲透一道题」的提示词。
 *
 * @param {object} q
 * @param {string} userAnswer  学生最近一次的作答（可能为空）
 * @param {string} errorType   错因归类（可能为空）
 */
export function buildExplainPrompt(q, userAnswer, errorType) {
  return [
    '你是一名考研数学辅导老师。针对下面这道题，给这名学生讲透。',
    '',
    `【题目】（${q.type === 'proof' ? '证明题' : '解答题'}）`,
    cut(q.stem, 800),
    '',
    '【正确答案】',
    cut(q.answer, 800),
    '',
    q.analysis ? `【标准解析】\n${cut(q.analysis, 1200)}` : '',
    '',
    '【学生上次的作答】',
    cut(userAnswer, 1200) || '（没有作答记录）',
    '',
    errorType ? `【错因归类】${errorType}` : '',
    '',
    '【要求】按这个顺序讲，每一段都要短：',
    '1. 一句话说清**这题在考什么**（考点名 + 它在这个考点里的哪个位置）。',
    '2. 点出**关键的那一步** —— 为什么必须这么做，不这么做会卡在哪。',
    '3. 针对学生的作答，指出**具体哪一步**出了问题。不要泛泛说「基础不牢」。',
    '4. 给一个能迁移的判断信号：「看到 X，先想 Y」。',
    '5. 最后出一道只有数字不同的小题让他马上试。答案单独放最后一行，',
    '   以「答案：」开头。',
    '',
    '【硬性要求】',
    '- 不要复述题目，直接开始讲。',
    '- 数学公式用 LaTeX：行内 $...$，独立成行 $$...$$。',
    '- 全文控制在 400 字以内。讲透不等于讲多。',
    '- 不要用「首先/其次/最后」这类空转的连接词，直接说内容。',
  ].filter(Boolean).join('\n');
}

/* ============================================================
   结果清洗（这一层是重点）
   ============================================================ */

/**
 * 把模型吐出来的批改结果清洗成能用的形状。
 *
 * @param {any}    raw    模型输出（可能带 ```json 围栏、前后废话、尾逗号）
 * @param {Array}  steps  评分点 [{t, pts}]，可以为空
 * @returns {null|{steps, score, full, ratio, correct, comment}}
 *          null = 这次批改作废，调用方应回退到用户自评
 */
export function sanitizeGrade(raw, steps) {
  const list = Array.isArray(steps) ? steps : [];
  const hasSteps = list.length > 0;
  const full = hasSteps
    ? list.reduce((a, s) => a + (Number(s?.pts) || 0), 0)
    : DEFAULT_FULL;

  const comment = cut(raw?.comment, 300);

  /* ---------- 有评分点：逐条打分 ---------- */
  if (hasSteps) {
    const rawSteps = Array.isArray(raw?.steps) ? raw.steps : [];
    if (!rawSteps.length) return null;

    /* 每个评分点只认第一次出现的那个分数。
     * 模型偶尔会同一个索引给两遍（前后不一致），取第一条而不是最后一条 ——
     * 提示词里是按顺序列的，第一条对应它最先想到的判断。 */
    const got = new Map();
    const notes = new Map();
    for (const s of rawSteps) {
      const i = Number(s?.i);
      if (!Number.isInteger(i) || i < 1 || i > list.length) continue;   // 胡编的索引直接丢
      if (got.has(i)) continue;
      const pts = Number(list[i - 1]?.pts) || 0;
      const v = Number(s?.got);
      if (!Number.isFinite(v)) continue;                                 // 「没写」「—」这类
      got.set(i, clamp(Math.round(v), 0, pts));
      const c = cut(s?.comment, 120);
      if (c) notes.set(i, c);
    }

    /* 一个有效分数都没有 → 作废。不能默认给 0 分，也不能默认给满分。 */
    if (!got.size) return null;

    /* 模型没提到的评分点按 0 分算。
     * 这是**从严**的方向：漏答不能算对。反过来默认给满分的话，
     * 模型少写两条就等于白送分，而用户完全看不出来。 */
    const scored = list.map((s, idx) => {
      const i = idx + 1;
      return {
        i,
        t: s.t,
        pts: Number(s.pts) || 0,
        got: got.get(i) ?? 0,
        comment: notes.get(i) || (got.has(i) ? '' : '未涉及'),
      };
    });

    const score = scored.reduce((a, s) => a + s.got, 0);
    /* full 可能是 0（评分点都写了 0 分），那就退化成 10 分制，
     * 否则 ratio 会变成 0/0 = NaN 一路传到前端。 */
    const denom = full > 0 ? full : DEFAULT_FULL;
    const ratio = denom > 0 ? score / denom : 0;
    return { steps: scored, score, full: denom, ratio, correct: ratio >= PASS_RATIO, comment };
  }

  /* ---------- 没有评分点：整体评 ---------- */
  const v = Number(raw?.score);
  if (!Number.isFinite(v)) return null;
  const score = clamp(Math.round(v), 0, DEFAULT_FULL);
  return {
    steps: [],
    score,
    full: DEFAULT_FULL,
    ratio: score / DEFAULT_FULL,
    correct: score / DEFAULT_FULL >= PASS_RATIO,
    comment,
  };
}

/**
 * 从模型输出文本里把 JSON 抠出来。
 *
 * 提示词写着「不要 markdown 代码块」，但小模型基本不听 ——
 * 所以围栏、前后废话、尾逗号都要兜。这是和 ai.js 里 parseJsonObject
 * 同一套宽容策略，这里单独放一份是为了让本文件保持零依赖（能被测试直接 import）。
 */
export function extractJson(content) {
  const s = String(content || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** 一步到位：模型输出文本 → 清洗后的批改结果（或 null） */
export function parseGrade(content, steps) {
  const obj = extractJson(content);
  if (!obj) return null;
  return sanitizeGrade(obj, steps);
}
