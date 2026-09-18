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

export function judge(q, userAns) {
  if (q.type === 'choice') {
    /* 选择题也得过一遍 norm。
     * 中文输入法下用户很容易打出全角的 Ａ Ｂ Ｃ Ｄ，只 trim + toUpperCase 会直接判错 ——
     * 那不是学生答错了，是输入法的问题。 */
    const u = norm(userAns);
    const a = norm(q.answer);
    if (!u || !a) return false;
    return u.toUpperCase() === a.toUpperCase();
  }
  return checkBlank(userAns, q.answer);
}

/** 选项 JSON 解析（库里存字符串） */
export function parseOptions(q) {
  if (!q.options) return null;
  if (Array.isArray(q.options)) return q.options;
  try { return JSON.parse(q.options); } catch { return null; }
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
 * @param {'choice'|'blank'} type
 * @param {string} answer
 * @returns {null|string} null = 没问题；否则是给人看的说明（直接可以显示给用户）
 */
export function answerIssue(type, answer) {
  const raw = String(answer ?? '').trim();
  if (!raw) return '答案不能为空';

  if (type === 'choice') {
    if (!/^[A-Da-d]$/.test(raw)) return '选择题的答案必须是 A / B / C / D 之一';
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

/** 对外暴露题目（剥掉答案与解析，考试中不能泄露） */export function publicQuestion(q, { withAnswer = false } = {}) {
  const base = {
    id: q.id,
    kid: q.kid,
    type: q.type,
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
  }
  return base;
}
