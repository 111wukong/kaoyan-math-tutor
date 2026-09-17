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

/** 对外暴露题目（剥掉答案与解析，考试中不能泄露） */
export function publicQuestion(q, { withAnswer = false } = {}) {
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
