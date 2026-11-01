/* 拍照解题：prompt 构造 + 结果清洗
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────
 * 这个功能的风险点不在「调用模型」，而在两件事：
 *   1. **模型会把看不清的题目编出来** —— 图片糊了、字迹潦草、有遮挡，
 *      模型倾向于猜一个「看起来合理」的题然后认真解它。用户拿到一份
 *      工整但解的是另一道题的答案，比报错糟糕得多。
 *   2. **结构化输出会坏** —— 多模态模型吐 JSON 比纯文本模型更容易截断，
 *      而且图片里常有 $ 和反斜杠，转义容易出错。
 * 这两件事都需要能被单独测试，所以和路由分开。
 *
 * ── 和「AI 讲解」的区别 ──────────────────────────────────────────
 * explain 讲的是**库里已有的题**，有标准答案兜底，所以可以要求它
 * 「只讲关键一步」。solve 面对的是**库外的题**，没有答案可对照，
 * 必须完整解一遍 —— 但正因为没有兜底，防幻觉的要求要写得更死。
 */

/* 图片里认不出来的内容，统一用这个标记。
 * 让模型输出固定词而不是自由发挥，前端才能把它标红提示用户。 */
export const UNKNOWN = '（字迹不清）';

/** 构造解题 prompt。 */
export function buildSolvePrompt() {
  return [
    '你是一名考研数学老师。图片里是一道数学题，可能是印刷体也可能是手写。',
    '请先**准确转录**题目，再完整解答。',
    '',
    '只输出 JSON，不要任何解释文字、不要 markdown 围栏。格式：',
    '{',
    '  "question": "题干完整转录（含选项、已知条件；公式用 LaTeX）",',
    '  "answer": "最终答案（LaTeX）",',
    '  "approach": "一句话：这题考什么 + 关键那一步（不超过 60 字）",',
    '  "steps": [{"t": "这一步做什么、为什么这么做", "f": "这一步的式子，用 $...$ 包裹，可为空"}],',
    '  "points": ["考点名，2~4 个"],',
    '  "pitfall": "最容易错的地方，一句话",',
    '  "signal": "可迁移的判断信号：看到 X，先想 Y"',
    '}',
    '',
    '【硬性要求】',
    `- 看不清的地方写「${UNKNOWN}」，**绝对不要猜测或补全题目条件**。`,
    '  宁可解不出来，也不能解一道自己编的题。',
    '- 如果图片里没有数学题，question 填「未识别到数学题」，answer/steps 留空。',
    '- steps 写 3~6 步。每步的 t 要讲「为什么」，不要只写式子。',
    '- 数学公式用 LaTeX：行内 $...$，独立成行 $$...$$。不要用 \\( \\) 或 \\[ \\]。',
    '- steps 里的 f 字段也要用 $...$ 包裹 —— 小程序端按 $ 切段渲染，',
    '  没包裹的话会当成普通文字显示成源码。',
    '- 不要复述「这是一道关于…的题」这类空话，直接给内容。',
  ].join('\n');
}

/** 把任意值收敛成字符串，并截断。 */
function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}

/**
 * 给没包 $ 的纯公式补上定界符。
 *
 * ★ 为什么要兜这一层：小程序端按 `$` 切段来渲染公式（见 renderMath.js），
 *   模型经常把 steps.f 直接写成 `\frac{\sin 3x}{x}=3` 而不包 $。
 *   不兜的话，用户看到的是一行 LaTeX 源码，而页面一切正常 ——
 *   这种「看起来能用但显示错了」的问题最难被发现。
 *
 * ★ 为什么不能无条件包：f 里也可能是一句中文说明（「所以 x=1」）。
 *   把中文包进 $...$ 会让 MathJax 渲染出一堆乱码。
 *   所以只包「含 LaTeX 命令且不含中文」的那种。
 */
function wrapMath(s) {
  if (!s) return '';
  if (s.includes('$')) return s;
  const hasCmd = /\\[a-zA-Z]+/.test(s);
  const hasCJK = /[\u4e00-\u9fff]/.test(s);
  return hasCmd && !hasCJK ? `$${s}$` : s;
}

/**
 * 剥掉「纯数字」公式的定界符。
 *
 * ★ 这是个必须处理的死角：renderMath.js 的 looksLikeMath 会把纯数字
 *   判成「多半是金额」，于是 `$3$` 不渲染、连定界符一起当普通文字。
 *   这条规则在网页端是对的（防止把 $100 渲染成公式），但解题的答案
 *   恰恰经常是 `$3$` 这种纯数字 —— 用户会看到一个带美元符号的「$3$」。
 *
 *   所以在这里剥掉：答案 `$3$` → `3`，显示成正常文字。
 *   含字母或运算符的（`$x^2$`、`$x=1$`）保持不动，它们会被正常渲染。
 */
function unwrapPlainNumber(s) {
  if (!s) return '';
  const m = /^\$([\d\s.,+\-*/%]+)\$$/.exec(s.trim());
  return m ? m[1].trim() : s;
}

/**
 * 清洗模型输出。
 *
 * @param {any} raw 模型返回的 content（字符串，或已经解析好的对象）
 * @returns {{question, answer, approach, steps, points, pitfall, signal, degraded}}
 *          degraded = true 表示 JSON 没解析出来，question 里装的是原文。
 *          调用方应据此提示「格式异常，已按原文显示」而不是假装成功。
 */
export function sanitizeSolve(raw) {
  const empty = {
    question: '', answer: '', approach: '', steps: [],
    points: [], pitfall: '', signal: '', degraded: false,
  };

  let obj = raw;
  if (typeof raw === 'string') {
    obj = parseLoose(raw);
  }
  if (!obj || typeof obj !== 'object') {
    return { ...empty, question: str(raw, 4000), degraded: true };
  }

  const steps = Array.isArray(obj.steps)
    ? obj.steps
      .map((s) => {
        /* ★ 这里踩过一次：原来写的是 `t: str(s?.t ?? s)` —— 想让
         *   纯字符串步骤也能用。但当 s 是对象且**没有 t 字段**时，
         *   `s?.t ?? s` 会取到整个对象，String(obj) 得到 "[object Object]"，
         *   前端就显示一串 [object Object]。
         *   正确做法是先判断类型，再决定从哪里取值。 */
        const isObj = s && typeof s === 'object';
        return {
          t: str(isObj ? s.t : s, 600),
          f: wrapMath(str(isObj ? s.f : '', 600)),
        };
      })
      .filter((s) => s.t || s.f)
      .slice(0, 8)
    : [];

  const points = Array.isArray(obj.points)
    ? obj.points.map((p) => str(p, 60)).filter(Boolean).slice(0, 6)
    : [];

  const out = {
    question: str(obj.question, 4000),
    answer: unwrapPlainNumber(str(obj.answer, 1200)),
    approach: str(obj.approach, 300),
    steps,
    points,
    pitfall: str(obj.pitfall, 400),
    signal: str(obj.signal, 300),
    degraded: false,
  };

  /* question 空 = 模型没按格式来。这时候不要把半截 JSON 当题干，
   * 直接判为降级，让前端显示原文。 */
  if (!out.question) {
    return { ...empty, question: str(raw, 4000), degraded: true };
  }
  return out;
}

/**
 * 宽容解析：剥围栏 → 取最外层 {} → 去尾逗号。
 * 和 routes/ai.js 的 parseJsonObject 同一套策略，但独立一份 ——
 * 那个函数在路由文件里没导出，而这个模块要能被测试单独引用。
 */
function parseLoose(content) {
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
