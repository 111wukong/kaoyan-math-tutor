import katex from 'katex';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/* 富文本渲染：Markdown + LaTeX
 *
 * 这条管线有一整段来自前端版的血泪教训：**标记符号绝对不许漏到屏幕上**。
 * 漏出来的样子是用户看到满屏的 \frac、**、$ —— 页面不报错、构建通过、
 * 测试全绿、截图也看不出，但阅读体验直接崩掉。
 *
 * 输入有两个来源，格式还不一样：
 *   a) 模型输出：数学写在 $...$ / $$...$$ 里（提示词是这么要求的）
 *   b) 库里的数据：**裸 LaTeX，一个 $ 都没有**（68 个知识点的正文与例题、
 *      204 道题的题干与解析，全都是「中文句子里夹着 \frac{...}」）
 *
 * 所以顺序至关重要，且**必须先摘数学、再转义、最后回填**：
 *   1. 行内代码 `...`  →  2. Markdown 链接  →  3. 已带定界符的数学
 *   4. __加粗__  →  5. autoLatex 给裸 LaTeX 补 $  →  6. 刚补出来的数学
 *   7. 剩下的纯文本做转义 + 强调  →  8. 占位符回填
 *
 * 顺序反了会出两种 bug（都真实踩过）：
 *   · 先按 $ 切分再套 **，则「**当 $x\to 0$ 时**」被从中间切开，两半各剩一个 **，
 *     屏幕上就是裸露的星号；
 *   · autoLatex 在 $ 之前跑，会把已有的 $\frac{1}{2}$ 再包一层 $，
 *     原来的定界符反而变成普通字符打到屏幕上。
 *
 * 占位符用 \u0001 N \u0002（正文里不可能出现），并且被 FRAG_STOP 当作硬边界，
 * 这样 autoLatex 的片段回溯不会跨过已渲染的公式去吞文本。
 */

const PH_OPEN = '\u0001';
const PH_CLOSE = '\u0002';
const PH_RE = /\u0001(\d+)\u0002/g;

/** 已带定界符的数学：$$...$$ / $...$ / \(...\) / \[...\] */
const MATH_SPAN = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
/** autoLatex 刚补出来的 $...$ */
const AUTO_SPAN = /\$([^$\n]+?)\$/g;

/** 片段边界：占位符、中文、中文标点、全角括号、空白、点号 */
const FRAG_STOP = /[\u0001\u0002\u4e00-\u9fff，。；：、！？「」【】（）《》〈〉\s·…]/;
const TEX_CMD = /[a-zA-Z]/;
/** 公式内允许继续吸收的字符 */
const MATH_CHAR = /[A-Za-z0-9\xc0-\xff\u0391-\u03c9().+\-*/=|<>·]/;
const CJK_OR_PUNCT = /[\u4e00-\u9fff\n，。；：、！？「」【】（）《》〈〉]/;

/** 反斜杠 + 单个符号的命令：\, \; \: \! \␣ —— 公式内空白/微调 */
const CMD_SYMBOL = ',;:! ';

/** 从 s[i] === '{' 跳到配对 '}' 之后。
 *  撞上中文 / 换行 / 文件尾（也就是括号根本没闭合）则返回 -1，调用方放弃。 */
function skipBraces(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
    else if (CJK_OR_PUNCT.test(c)) return -1;
  }
  return -1;
}

/* ============================================================
   转义
   ============================================================ */
const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/* ============================================================
   KaTeX 渲染（带缓存）
   同一个公式在一次会话里会被渲染很多遍 —— AI 流式输出时每几十毫秒就要重排
   整段气泡。不缓存的话 KaTeX 会把已经渲染过的公式反复重算。
   ============================================================ */
const FORMULA_CACHE = new Map<string, string>();
const FORMULA_CACHE_MAX = 500;

function renderTex(tex: string, display: boolean): string {
  const trimmed = tex.trim();
  if (!trimmed) return '';
  const key = (display ? 'D' : 'I') + trimmed;
  const hit = FORMULA_CACHE.get(key);
  if (hit !== undefined) return hit;

  let html: string;
  try {
    /* ★ throwOnError 必须是 true —— 这一条是踩过坑才写下来的。
     *
     * 设成 false 时 KaTeX **不抛异常**，而是自己吐一个
     *   <span class="katex-error" title="ParseError: ...">原始源码</span>
     * 这段源码（连同 \frac、\lim 这些反斜杠）会直接出现在屏幕上；
     * 而下面那个 catch 永远等不到异常，等于兜底是死代码。
     *
     * 更阴的是：katex-error 的类名**不是**独立成词的 katex，
     * 所以任何「删掉 .katex 子树再查残留」的检查都删不掉它 ——
     * 页面不报错、构建通过、测试看着全绿，用户却在看满屏 LaTeX 源码。
     * 实测题库里 20 多道题的解析就是这样漏的（\lim / \frac / \begin{bmatrix}）。
     *
     * 改成 true 之后解析失败会正常抛，走下面这条我们自己控制的降级路径。 */
    html = katex.renderToString(trimmed, {
      displayMode: display,
      throwOnError: true,
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch (e) {
    /* 渲染失败就把原文吐出来（至少用户能看到内容），但必须转义。
     * 开发期额外出声：这类失败是**静默**的，不主动报的话，
     * 题库或模型输出里坏一条公式可能几周都没人发现。
     * 只在 DEV 打，生产环境不污染用户控制台。 */
    if (import.meta.env?.DEV) {
      console.warn('[Math] KaTeX 解析失败，已降级为纯文本：', trimmed, (e as Error)?.message);
    }
    html = `<code class="rounded bg-white/8 px-1 py-0.5 font-mono text-[0.85em] text-amber-300/95">${escapeHtml(trimmed)}</code>`;
  }

  if (FORMULA_CACHE.size >= FORMULA_CACHE_MAX) FORMULA_CACHE.clear();
  FORMULA_CACHE.set(key, html);
  return html;
}

/* ============================================================
   autoLatex —— 给裸 LaTeX 补上 $ 定界符
   这是整条管线里最容易写错的一段，每个分支都对应一个真实踩过的坑。
   ============================================================ */
function autoLatex(s: string): string {
  if (!s) return s;
  let out = '';
  let i = 0;
  const n = s.length;

  /* ★ 位置对齐表 —— 分支 3 的「回退」靠它，别再用字符数硬算。
   *
   * 这里插进去的 $ 是源串里没有的，所以 out 和 s 的位置**不对齐**。
   * 以前分支 3 写的是：
   *     out = out.slice(0, out.length - (i - st));
   * 那个 (i - st) 是按**源码**算的，可 out 里每多一个 $ 就多退一格 ——
   * 结果是退到一半，把已经拼好的片段切成 `$\$` 这种残渣。
   * 实测题库 q08、q173 两道题的解析因此漏出 \frac / \to 到屏幕上。
   *
   * outLenAt[k]：消费到源码位置 k 时 out 的长度（精确值，只保证在片段边界上准确）
   * spanStart[k]：源码位置 k 落在哪个已包裹片段的起点；不在片段内则是 -1
   *              —— 分支 3 若退到片段内部，必须整体退到片段开头，不能只退一半。
   */
  const outLenAt = new Array(n + 1).fill(0);
  const spanStart = new Array(n + 1).fill(-1);

  /** 追加源码区间 [a, b) 的原始字符（1:1，不包裹） */
  const pushPlain = (a: number, b: number) => {
    for (let k = a; k < b; k++) {
      out += s[k];
      outLenAt[k + 1] = out.length;
      spanStart[k + 1] = -1;
    }
    i = b;
  };

  /** 追加一个包裹好的片段，覆盖源码区间 [a, b) */
  const pushSpan = (a: number, b: number, inner: string) => {
    const before = out.length;
    out += '$' + inner + '$';
    outLenAt[a] = before;
    for (let k = a + 1; k < b; k++) {
      outLenAt[k] = before;
      spanStart[k] = a;      // 落在片段内部的索引 → 指向片段起点
    }
    outLenAt[b] = out.length;
    spanStart[b] = -1;
    i = b;
  };

  while (i < n) {
    const c = s[i];

    /* 分支 0：\begin{env} ... \end{env} 环境块整体包裹。
       矩阵 / cases / 对齐环境里含 & 与 \\，逐字符扫会被截断。 */
    if (c === '\\' && s.slice(i, i + 7) === '\\begin{') {
      const envM = s.slice(i).match(/\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\}/);
      if (envM) {
        pushSpan(i, i + envM[0].length, envM[0]);
        continue;
      }
    }

    /* 分支 0b：\, \; \: \! \␣ —— 反斜杠 + 单个符号，都是「公式内空白/微调」。
       它们不含字母，所以进不了分支 1，会原样漏到屏幕上（用户看到 `\,`）。
       包成 $...$ 让 KaTeX 渲染成对应的空白即可。 */
    if (c === '\\' && i + 1 < n && CMD_SYMBOL.includes(s[i + 1])) {
      pushSpan(i, i + 2, s.slice(i, i + 2));
      continue;
    }

    /* 分支 1：\command 起头 → 吸收命令 + 参数 + 后续命令 */
    if (c === '\\' && i + 1 < n && TEX_CMD.test(s[i + 1])) {
      let j = i + 1;
      while (j < n && TEX_CMD.test(s[j])) j++;
      while (j < n) {
        const ch = s[j];
        if (ch === '{' || ch === '[') {
          const close = ch === '{' ? '}' : ']';
          let depth = 1;
          for (j++; j < n && depth > 0; j++) {
            if (s[j] === ch) depth++;
            else if (s[j] === close) depth--;
          }
        } else if (ch === '_' || ch === '^') {
          /* ★ 连续下划线是「填空横线」，不是下标 —— 一吸进公式就再也吐不出来。
           * 题库里 6 个下划线表示待填空（`= ______`），而 `_` 在 LaTeX 里是下标标记，
           * 包成 $______$ 之后 KaTeX 报「Expected group after '_'」，把源码红字吐回屏幕。
           * 实测 q04 / q138 / q27 / q193 等 10 余道题都是这个形态。 */
          if (ch === '_' && s[j + 1] === '_') break;
          j++;
          if (j < n && s[j] === '{') {
            let depth = 1;
            for (j++; j < n && depth > 0; j++) {
              if (s[j] === '{') depth++;
              else if (s[j] === '}') depth--;
            }
          } else {
            // 不带花括号的上下标：x^2、x_n、x^\alpha
            while (j < n && /[A-Za-z0-9\\]/.test(s[j])) {
              if (s[j] === '\\') { j++; while (j < n && TEX_CMD.test(s[j])) j++; }
              else j++;
            }
          }
        } else if (ch === ' ' && j + 1 < n && (s[j + 1] === '\\' || s[j + 1] === '^' || s[j + 1] === '_' || s[j + 1] === '{')) {
          // 公式内空格：空格后紧跟 \command / ^ / _ / { 视为继续
          const after = s[j + 1];
          if (after === '\\') {
            /* ★ \begin{env} 必须交给分支 0 整块处理。
             * 这里若继续吞，会在环境内部的 & 处断掉（& 不在 MATH_CHAR 里），
             * 产出一个没闭合的 \begin{bmatrix} —— KaTeX 直接报错、源码漏屏。
             * 实测 q52 的解析、kl2n2 的例题都是这个形态。 */
            if (s.slice(j + 1, j + 8) === '\\begin{') break;
            if (j + 2 < n && TEX_CMD.test(s[j + 2])) { j += 2; while (j < n && TEX_CMD.test(s[j])) j++; }
            else j++;
          } else j++;
        } else if (ch === ' ' && j + 1 < n && !CJK_OR_PUNCT.test(s[j + 1])) {
          // 公式内空格：空格后不是中文/中文标点/换行，视为同一公式继续
          j++;
        } else if (ch === '\\' && j + 1 < n && TEX_CMD.test(s[j + 1])) {
          // 同上：\begin{env} 交给分支 0，别吞
          if (s.slice(j, j + 7) === '\\begin{') break;
          j++;
          while (j < n && TEX_CMD.test(s[j])) j++;
        } else if (ch === "'" || ch === '′' || ch === ',' || ch === '!' || ch === '%') {
          j++;   // 撇号（导数）、英文逗号可吸收，避免 e^{x}'' 被切断
        } else if (MATH_CHAR.test(ch)) {
          j++;
        } else {
          break;
        }
      }
      // 一开始就 break（例如整个片段就是个 \begin{env}）→ 原样吐出去，别产出空公式
      if (j === i) { pushPlain(i, i + 1); continue; }
      pushSpan(i, j, s.slice(i, j));
      continue;
    }

    /* 分支 2：|expr| 绝对值表达式（内部含数学特征才包裹） */
    if (c === '|') {
      let j = i + 1;
      while (j < n && s[j] !== '|') j++;
      if (j < n && j > i + 1) {
        const inside = s.slice(i + 1, j);
        /* ★ 内部含中文/空白/换行就放弃。
         * 以前只判断「有没有数学特征」，于是第二个孤立的 | 会一路找到很远处的另一个 |，
         * 把 `| \ne 0，此时方程组有唯一解 x_i = \frac{|A_i|` 这种**夹着中文**的一大段
         * 整个包进 $...$ —— KaTeX 解析不了，直接把源码红字吐回屏幕。
         * 实测 q173 的解析就是这样漏的。 */
        const dirty = /[\u4e00-\u9fff\n，。；：、！？「」【】（）《》〈〉\s]/.test(inside);
        if (!dirty && (/[\\^_{}0-9]/.test(inside) || /[a-zA-Z]\s*[+\-*/]/.test(inside) || /\\[a-zA-Z]+/.test(inside))) {
          pushSpan(i, j + 1, s.slice(i, j + 1));
          continue;
        }
      }
    }

    /* 分支 3：独立的 ^ / _（裸上下标，如 x^{2}、X_1）→ 向左右扩展成连续碎片 */
    if (c === '^' || c === '_') {
      /* ★ 连续下划线是「填空横线」，不是下标。
       * 单个下划线（x_i）照旧当下标；只要左右挨着另一个下划线，就一定是填空。
       * 不拦的话会包出 $______$，KaTeX 报「Expected group after '_'」并把源码吐回屏幕。 */
      if (c === '_' && (s[i + 1] === '_' || s[i - 1] === '_')) {
        pushPlain(i, i + 1);
        continue;
      }

      let st = i;
      while (st > 0 && !FRAG_STOP.test(s[st - 1])) st--;
      // 前面是 |，说明在绝对值内部，交给分支 2 统一处理
      if (st > 0 && s[st - 1] === '|') { pushPlain(i, i + 1); continue; }
      // 退到片段内部的话，整体退到片段开头 —— 不能只退一半
      if (spanStart[st] >= 0) st = spanStart[st];
      /* ★ 精确回退。以前这里写的是 out.length - (i - st)，
       * 而 out 里插入了源串没有的 $，两者位置不对齐，退多退少全看插了几个 $。
       * 用位置对齐表就没这个问题。 */
      out = out.slice(0, outLenAt[st]);

      let en = i + 1;
      while (en < n && !FRAG_STOP.test(s[en])) {
        if (s[en] === '{') {
          /* ★ 花括号组必须整体跳过。
           * 不跳的话 e^{\alpha x} 会在组内空格处断成 `e^{\alpha`，
           * KaTeX 报「Expected '}', got 'EOF'」，源码漏屏。
           * 实测 q43 / q169 / kc7n2 都是这个形态。 */
          const after = skipBraces(s, en);
          if (after < 0) { en = n; break; }   // 括号没闭合就撞上中文/换行 → 整段放弃
          en = after;
          continue;
        }
        en++;
      }
      const raw = s.slice(st, en);
      const lead = (raw.match(/^[|，,]+/) || [''])[0].length;
      const trail = (raw.match(/[,，|]+$/) || [''])[0].length;
      const frag = raw.slice(lead, raw.length - trail);

      if (frag) {
        /* 被排除的头尾符号要**原样留在公式外面**，不能顺手删掉 ——
         * 以前是直接 replace 掉的，等于静默吃字符。 */
        if (lead) pushPlain(st, st + lead);
        pushSpan(st + lead, st + lead + frag.length, frag);
        continue;
      }
      // 整段都是 | 和逗号，没有可包裹的内容 → 原样吐出去
      pushPlain(i, i + 1);
      continue;
    }

    pushPlain(i, i + 1);
  }
  return out;
}

/* ============================================================
   Markdown 强调
   只处理已经转义过的纯文本，且此时公式已经换成占位符 ——
   所以不用担心 ** 和 $ 互相干扰。
   斜体刻意写得保守：星号两侧必须落在词边界上，
   否则「2 * 3」「a*b」这种数学里遍地都是的乘法会被当成斜体吃掉。
   ============================================================ */
function emphasize(s: string): string {
  return s
    .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong class="font-semibold text-fg">$1</strong>')
    .replace(/(^|[^\w\u4e00-\u9fff])\*([^\s*][^*\n]*?)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+?)~~/g, '<del class="text-fg-mute">$1</del>');
}

/* ============================================================
   行内管线：数学优先 → autoLatex → 转义 → 强调 → 数学塞回
   不套 <p>，所以能安全地放在气泡、黑板条目、题干这种行内位置。
   ============================================================ */
function inlinePipeline(text: string): string {
  const parts: string[] = [];
  const stash = (html: string) => {
    parts.push(html);
    return PH_OPEN + (parts.length - 1) + PH_CLOSE;
  };

  let rest = String(text ?? '');

  /* 1) 行内代码先摘走。必须在 autoLatex 之前 —— 否则 `x^2` 里的 ^ 会被
        连反引号一起包成公式，屏幕上就是 KaTeX 渲染出来的一对反引号。 */
  rest = rest.replace(/`([^`\n]+?)`/g, (_, inner) =>
    stash(`<code class="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[0.9em] text-cyan-200/95">${escapeHtml(inner)}</code>`));

  /* 2) Markdown 链接也要在 autoLatex 之前 —— URL 里常带 _ 和 &，
        被当成公式或实体就毁了。 */
  rest = rest.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) =>
    stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener" class="text-cyan underline decoration-cyan/40 underline-offset-2 hover:decoration-cyan">${escapeHtml(label)}</a>`));

  /* 3) 已经带定界符的数学（模型输出走这条） */
  rest = rest.replace(MATH_SPAN, (_m, dd, ii, pp, bb) => {
    const tex = dd != null ? dd : ii != null ? ii : pp != null ? pp : bb;
    return stash(renderTex(tex, dd != null || bb != null));
  });

  /* 4) __加粗__ 也要在 autoLatex 之前摘走 —— autoLatex 会把 __ 当成两个裸下标
        包进公式，KaTeX 遇到 __ 会吐一个红色报错块。 */
  rest = rest.replace(/__([^_\n]+?)__/g, (_, inner) => stash(`<strong class="font-semibold text-fg">${inlinePipeline(inner)}</strong>`));

  /* 5) 裸 LaTeX（题库数据走这条）。走到这里 rest 里已经没有 $ 了，
        所以 autoLatex 不可能把已有公式二次包裹。 */
  rest = autoLatex(rest);

  /* 6) autoLatex 刚补出来的 $...$ */
  rest = rest.replace(AUTO_SPAN, (_m, tex) => stash(renderTex(tex, false)));

  /* 7) 剩下的纯文本：先转义，再套强调 */
  let html = emphasize(escapeHtml(rest));

  /* 8) 把渲染好的数学塞回占位符 */
  return html.replace(PH_RE, (m, i) => parts[Number(i)] ?? m);
}

/** 单独一行、且整行就是一个块级公式占位符 —— 别包 <p> */
const BLOCK_PH_ONLY = /^\s*\u0001(\d+)\u0002\s*$/;

/* ---- Markdown 表格 ---- */
function isTableRow(l: string) {
  const t = l.trim();
  return t.length > 2 && t[0] === '|' && t[t.length - 1] === '|';
}
function isTableSep(l: string) {
  const t = l.trim().replace(/\s/g, '');
  return t.length > 2 && t[0] === '|' && t[t.length - 1] === '|'
    && /^[|:\-]+$/.test(t) && t.includes('-');
}
function tableCells(l: string) {
  return l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/* ============================================================
   块级 Markdown：标题、列表、引用、代码块、表格、段落
   目标不是完整实现 CommonMark，而是**不让标记符号漏到屏幕上**。
   ============================================================ */
function blockMd(src: string, blocks: string[]): string {
  const lines = src.split('\n');
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeBuf: string[] = [];

  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };
  const flushCode = () => {
    if (!codeBuf.length) return;
    html.push(`<pre class="my-3 overflow-x-auto rounded-xl border border-hairline bg-ink-900/80 p-3.5"><code class="font-mono text-[12.5px] leading-relaxed text-cyan-100/90">${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
    codeBuf = [];
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // 代码块围栏
    if (/^\s*```/.test(line)) {
      if (inCode) { flushCode(); inCode = false; } else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    /* 表格：表头行 + 分隔行 + 若干数据行。
       不做这一步的话，模型输出的 | a | b | 会原样显示成竖线和短横 —— 同样是「标记漏屏」。 */
    if (isTableRow(line) && li + 1 < lines.length && isTableSep(lines[li + 1])) {
      closeList();
      const head = tableCells(line);
      const rows: string[][] = [];
      let k = li + 2;
      while (k < lines.length && isTableRow(lines[k])) { rows.push(tableCells(lines[k])); k++; }
      html.push(
        '<div class="my-3 overflow-x-auto"><table class="w-full border-collapse text-[13px]">'
        + '<thead><tr>'
        + head.map((c) => `<th class="border border-hairline bg-white/5 px-3 py-2 text-left font-medium text-fg">${inlinePipeline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>'
            + head.map((_, ci) => `<td class="border border-hairline px-3 py-2 text-fg-soft">${inlinePipeline(r[ci] ?? '')}</td>`).join('')
            + '</tr>').join('')
        + '</tbody></table></div>',
      );
      li = k - 1;
      continue;
    }

    // 块级公式单独成行 —— 直接吐出 <div>，不能包进 <p>
    const bp = BLOCK_PH_ONLY.exec(line);
    if (bp) {
      closeList();
      html.push(blocks[Number(bp[1])] ?? '');
      continue;
    }

    if (!line.trim()) { closeList(); continue; }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lv = h[1].length;
      const sizes = ['text-[19px]', 'text-[17px]', 'text-[15.5px]', 'text-[14px]'];
      html.push(`<h${lv + 1} class="mt-4 mb-2 font-semibold tracking-tight text-fg ${sizes[lv - 1]}">${inlinePipeline(h[2])}</h${lv + 1}>`);
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      closeList();
      html.push(`<blockquote class="my-2.5 border-l-2 border-cyan/45 bg-white/3 py-1.5 pl-3.5 text-fg-soft">${inlinePipeline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      html.push('<hr class="my-3.5 border-hairline" />');
      continue;
    }

    // 列表
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)、]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want: 'ul' | 'ol' = ul ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        html.push(`<${want} class="my-2 space-y-1.5 ${want === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 text-fg-soft">`);
        listType = want;
      }
      html.push(`<li class="leading-relaxed">${inlinePipeline((ul || ol)![1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p class="my-2 leading-[1.85] text-fg-soft">${inlinePipeline(line)}</p>`);
  }

  if (inCode) flushCode();
  closeList();
  return html.join('');
}

/* ============================================================
   对外：完整渲染
   ============================================================ */
export function renderRich(text: string): string {
  const src = String(text ?? '');
  if (!src) return '';

  const blocks: string[] = [];

  /* 块级公式先切成独立的块，并保证它独占一行。
     不能让它留在 <p> 里：<div> 落在 <p> 内部会被浏览器强行拆开，
     后面的文字会跑到公式外面。 */
  const work = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => {
    blocks.push(`<div class="katex-display my-3 overflow-x-auto">${renderTex(tex, true)}</div>`);
    return '\n' + PH_OPEN + (blocks.length - 1) + PH_CLOSE + '\n';
  });

  return blockMd(work, blocks).replace(PH_RE, (m, i) => blocks[Number(i)] ?? m);
}

/** React 组件形式 */
export function RichText({
  text,
  className,
  inline = false,
}: {
  text: string;
  /** 保留参数以兼容旧调用点：现在裸 LaTeX 一律自动识别，不需要开关 */
  bareLatex?: boolean;
  className?: string;
  inline?: boolean;
}) {
  const html = useMemo(() => renderRich(text), [text]);
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag
      className={cn('rich-text', inline && '[&>p]:my-0 [&>p]:inline', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 只渲染一段短文本（题干、选项、解析），不处理块级 Markdown */
export function InlineMath({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => inlinePipeline(String(text ?? '')), [text]);
  return <span className={cn('rich-text-inline', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
