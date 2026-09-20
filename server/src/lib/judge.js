/* 判题器（原样移植自纯前端版 js/engine.js 的 Judge）
 *
 * 填空题的难点不是"判断对错"，是"用户输入的形式和标准答案长得不一样但意思一样"：
 *   - 全角/半角：　１／２ vs 1/2
 *   - 中文标点：，。；：
 *   - LaTeX 残留：\pi vs π vs pi
 *   - 上标字符：x² vs x^2
 *   - 分数 vs 小数：1/2 vs 0.5
 *   - 空格：随便加
 * 这一层全部消化掉，否则用户会觉得"我明明答对了它说错"。
 */

function norm(s) {
  let x = String(s == null ? '' : s).trim();
  // 全角 → 半角
  x = x.replace(/[\uFF00-\uFFEF]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  x = x.replace(/[，。；：、]/g, ',').replace(/\s+/g, '').toLowerCase();
  x = x.replace(/\\/g, '');                 // 去掉 LaTeX 反斜杠：\pi -> pi
  x = x.replace(/π/g, 'pi').replace(/√/g, 'sqrt');
  x = x.replace(/²/g, '^2').replace(/³/g, '^3');
  x = x.replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  x = x.replace(/（/g, '(').replace(/）/g, ')');
  return x;
}

function fracVal(s) {
  const m = String(s).match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (m && parseFloat(m[2]) !== 0) return parseFloat(m[1]) / parseFloat(m[2]);
  return null;
}

/* ---------- 题型 ----------
 *
 * 六种，对应考研数学卷面的真实构成：
 *   单选(choice)  10 题 × 5 分
 *   填空(blank)    6 题 × 5 分
 *   解答(solve)    6 题 × 10~12 分   ← 70 分，最大的一块
 *   证明(proof)    与解答同属大题，但评分看论证链而不是结果
 *   多选(multi) / 判断(judge)  真题不考，用来练概念辨析 —— 全对才给分，
 *                              逼着人把「差不多懂了」变成「确实分得清」
 *
 * ── 为什么「判不了」必须是一个显式的类别 ────────────────────────────
 * 解答题/证明题的答案是「过程」，不是「一个值」。用字符串比对去判它，
 * 结果只会是「答对也判错」—— 比没有这道题更糟。
 * 所以把它们单独列进 SELF_GRADED_TYPES：判题器**主动放弃**，
 * 由用户对照参考答案自评。判题器返回 false 不是「答错了」，是「不归我判」。
 *
 * ★ 这个集合也是**权限边界**：服务端只允许这两个题型接受客户端传上来的
 *   correct 值。不挡的话，任何人都能对选择题宣称自己答对了，
 *   掌握度和 XP 立刻失真。
 */
export const SELF_GRADED_TYPES = new Set(['solve', 'proof']);

/** 允许入库的题型。录题、AI 出题、种子导入都从这里取，别各写一份。 */
export const QUESTION_TYPES = ['choice', 'multi', 'blank', 'judge', 'solve', 'proof'];

/** 题型的中文名。界面、日志、导出共用一份 —— 两处各写一遍必然漂移。 */
export const TYPE_LABEL = {
  choice: '单选',
  multi: '多选',
  blank: '填空',
  judge: '判断',
  solve: '解答',
  proof: '证明',
};

/** 选项型题型：答案是一组标号 */
export const OPTION_TYPES = new Set(['choice', 'multi']);

/* ---------- 判断题的真假归一化 ----------
 *
 * 判断题的输入方式太多：键盘打 T/F、中文打「对/错」、符号打 √/×、
 * 还有人打「正确」「错误」「是」「否」。
 * 全都认，否则用户明明答对了却看到红叉。
 *
 * 注意 'x' 归到「错」：判断题里 x 不可能是一个变量，
 * 而 × 和 x 在中文输入习惯里是同一个意思。
 */
const JUDGE_TRUE = new Set(['t', 'true', '对', '正确', '是', '√', 'yes', 'y', '1']);
const JUDGE_FALSE = new Set(['f', 'false', '错', '错误', '否', '×', 'x', '✗', 'no', 'n', '0']);

/** '对，因为…' / '错，反例是…' 这类带理由的作答，看首字 */
function normJudge(s) {
  const x = String(s == null ? '' : s).trim().toLowerCase();
  if (!x) return '';
  if (JUDGE_TRUE.has(x)) return 'T';
  if (JUDGE_FALSE.has(x)) return 'F';
  if (/^[对正是√]/.test(x)) return 'T';
  if (/^[错否×✗]/.test(x)) return 'F';
  return '';
}

/* ---------- 选项型答案的归一化 ----------
 *
 * 「ACD」「a c d」「A、C、D」「ＡＣＤ」都是同一个答案。
 * 归一化成**去重 + 升序**的字母串 —— 多选题的答案顺序没有意义，
 * 不排序的话「CA」会被判成和「AC」不同。
 */
function normLetters(s) {
  const x = String(s == null ? '' : s)
    .replace(/[\uFF00-\uFFEF]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .replace(/[^A-F]/g, '');
  return [...new Set(x.split(''))].sort().join('');
}

/**
 * 把答案规整成该题型的**规范形式**。
 *
 * ★ 写入（录题 / 种子导入）和比对（判题）必须走同一个函数。
 *   两边各写一份的话，录进去的形态和判题时期待的形态迟早对不上，
 *   表现为「标准答案自己判不过自己」—— 而且它不会报错，
 *   只会让用户答对也吃红叉。这个文件里所有归一化都只有一份实现，就是这个原因。
 */
export function canonicalAnswer(type, raw) {
  const s = String(raw ?? '').trim();
  if (type === 'choice') return s.toUpperCase().replace(/[^A-F]/g, '').slice(0, 1);
  if (type === 'multi') return normLetters(s);
  if (type === 'judge') return normJudge(s);
  /* 解答/证明题的「答案」是给人读的参考解答，一个字都不许改 */
  if (SELF_GRADED_TYPES.has(type)) return s;
  return normalizeAnswer(s);
}

export function checkBlank(userAns, stdAns) {
  let u = norm(userAns);
  let a = norm(stdAns);
  if (!u || !a) return false;
  if (u === a) return true;

  const un = parseFloat(u);
  const an = parseFloat(a);
  const uf = fracVal(u);
  const af = fracVal(a);
  const uNum = uf !== null ? uf : (!Number.isNaN(un) ? un : null);
  const aNum = af !== null ? af : (!Number.isNaN(an) ? an : null);
  if (uNum !== null && aNum !== null && Math.abs(uNum - aNum) < 1e-6) return true;

  u = u.replace(/\^/g, '').replace(/[*]/g, '');
  a = a.replace(/\^/g, '').replace(/[*]/g, '');
  return u === a;
}

/**
 * 判一道题。
 *
 * @param {object} q 题目行（需要 type / answer）
 * @param {string} userAns 用户作答
 * @param {boolean|undefined} selfCorrect
 *        仅对 SELF_GRADED_TYPES 生效：用户对照参考答案自评的结果。
 *        其他题型**一律忽略** —— 这是权限边界，不是提示。
 * @returns {boolean} 解答/证明题在没给 selfCorrect 时返回 false，
 *          意思是「还没判」，调用方要先走自评流程（见 routes/study.js）。
 */
export function judge(q, userAns, selfCorrect) {
  if (SELF_GRADED_TYPES.has(q.type)) return selfCorrect === true;

  if (q.type === 'choice' || q.type === 'multi') {
    /* 选项题也得过一遍归一化。
     * 中文输入法下用户很容易打出全角的 Ａ Ｂ Ｃ Ｄ，只 trim + toUpperCase 会直接判错 ——
     * 那不是学生答错了，是输入法的问题。
     * 多选题还多一层：答案顺序无意义，必须排序后比对。 */
    const u = normLetters(userAns);
    const a = normLetters(q.answer);
    if (!u || !a) return false;
    return u === a;
  }

  if (q.type === 'judge') {
    const u = normJudge(userAns);
    const a = normJudge(q.answer);
    return !!u && u === a;
  }

  return checkBlank(userAns, q.answer);
}

/** 选项 JSON 解析（库里存字符串） */
export function parseOptions(q) {
  if (!q.options) return null;
  if (Array.isArray(q.options)) return q.options;
  try { return JSON.parse(q.options); } catch { return null; }
}

/** 评分点解析。解答/证明题的分步给分依据，同样是「库里存字符串」。 */
export function parseSteps(q) {
  if (!q.steps) return null;
  if (Array.isArray(q.steps)) return q.steps;
  try {
    const a = JSON.parse(q.steps);
    return Array.isArray(a) ? a : null;
  } catch { return null; }
}

/* ---------- 入库前的答案体检 ----------
 *
 * 判题器只对**数值**做容差比对，对 LaTeX 命令的归一化是不完整的：
 * 标准答案 `\sqrt{2}` 归一化后是 `sqrt{2}`，用户输入 `√2` 归一化后是 `sqrt2`，
 * 两者并不相等。一旦这样的答案进了库，用户答对也会被判错 ——
 * 比没有这道题还糟。
 *
 * 所以凡是「答案要进 questions 表」的路径（手工录题、AI 生成）都要先过这里。
 * 规则只有一份，改的时候不用担心漏了哪条路径。
 */

/** 把答案里能救回来的写法规范化：\frac{1}{2} → 1/2，x=2 → 2。 */
export function normalizeAnswer(answer) {
  return String(answer ?? '')
    .replace(/\$+/g, '')
    .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '$1/$2')
    .trim()
    .replace(/^[a-zA-Z][_a-zA-Z0-9]*\s*=\s*(.+)$/, '$1')
    .trim();
}

/** 判题器认得的填空题答案：整数、小数、分数。 */
const NUMERIC_ANSWER = /^-?\d+(\.\d+)?(\/\d+(\.\d+)?)?$/;

/**
 * 答案能不能被自动判分。
 *
 * @param {'choice'|'multi'|'blank'|'judge'|'solve'|'proof'} type
 * @param {string} answer
 * @returns {null|string} null = 没问题；否则是给人看的说明（直接可以显示给用户）
 */
export function answerIssue(type, answer) {
  const raw = String(answer ?? '').trim();
  if (!raw) return '答案不能为空';

  if (type === 'choice') {
    if (!/^[A-Fa-f]$/.test(raw)) return '单选题的答案必须是 A / B / C / D 之一';
    return null;
  }

  if (type === 'multi') {
    /* 多选题答案的合法形态：2~6 个**互不重复**的 A–F 字母。
     * 允许中间有分隔符（A,C / A、C），归一化会去掉。
     * 只选一个字母是单选，不是多选 —— 拦下来，否则它会一直按多选记分，
     * 而用户以为自己录的是一道单选题。 */
    const bare = raw.replace(/[\s,，、;；/|]/g, '');
    if (!/^[A-Fa-f]{2,6}$/.test(bare)) {
      return '多选题的答案要写成 2~6 个字母的组合，比如 ACD';
    }
    if (new Set(bare.toUpperCase().split('')).size !== bare.length) {
      return `「${raw}」里有重复的选项，多选题的答案不能重复同一个字母`;
    }
    return null;
  }

  if (type === 'judge') {
    if (!normJudge(raw)) {
      return '判断题的答案只能是对 / 错（写 T / F、√ / × 也认）';
    }
    return null;
  }

  if (SELF_GRADED_TYPES.has(type)) {
    /* 解答题和证明题**不自动判分**，所以这里不卡「必须是数值」。
     * 卡的是别把参考答案写成空壳 —— 用户之后要拿它自评，
     * 这里放一个「略」过去，等于这道题以后没有任何参照。 */
    if (raw.length < 2) return '参考答案太短了 —— 你之后要靠它自评，至少写清结论';
    if (raw.length > 2000) return '参考答案太长了（上限 2000 字），把关键步骤写清就够';
    return null;
  }

  const norm = normalizeAnswer(raw);
  if (!norm) return '答案不能为空';
  if (NUMERIC_ANSWER.test(norm)) return null;

  /* 判不了，给具体建议。分两类说 ——
   * 用户看到「改成 1/2」却不知道该拿根号怎么办，等于没说。 */
  if (/[\\{}π√a-zA-Z]/.test(norm)) {
    return `「${raw}」不是纯数值（含字母、根号或 π），判题器没法比对 —— `
      + '请改成选择题，或者把答案写成整数、小数、分数（如 2、-1/2、0.5）。';
  }
  return `「${raw}」不是一个确定的数值 —— 填空题的答案只能是整数、小数或分数（如 2、-1/2、0.5）。`;
}

/** 对外暴露题目（剥掉答案与解析，考试中不能泄露） */
export function publicQuestion(q, { withAnswer = false } = {}) {
  const base = {
    id: q.id,
    kid: q.kid,
    type: q.type,
    /** 题型中文名。前端不该再维护一份 type→中文 的映射 —— 两份必然漂移。 */
    typeLabel: TYPE_LABEL[q.type] || q.type,
    /** 解答/证明题由用户自评，前端要靠它切换作答区形态 */
    selfGraded: SELF_GRADED_TYPES.has(q.type),
    difficulty: q.difficulty,
    stem: q.stem,
    options: parseOptions(q),
    sourceType: q.source_type,
    sourceYear: q.source_year,
    source: q.source,
  };
  if (withAnswer) {
    base.answer = q.answer;
    base.analysis = q.analysis;
    /* 评分点跟着答案一起给 —— 它是「分步给分」的依据，
     * 提前暴露就等于把答案给出去了。 */
    base.steps = parseSteps(q);
  }
  return base;
}
