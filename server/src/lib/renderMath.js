/* 公式渲染服务
 *
 * ── 为什么服务端渲染，而不是在小程序里跑 KaTeX ────────────────────
 * KaTeX 的 HTML 输出依赖三样小程序没有的东西：
 *   1. DOM（它吐的是绝对定位的 <span> 树）
 *   2. 25 个 woff2 字体文件（约 2MB，主包上限也是 2MB）
 *   3. CSS 类（katex 自己的样式表）
 * 硬塞进 rich-text 的结果是错位的乱码。所以公式必须在服务端变成图。
 *
 * ── 为什么用 MathJax 而不是 KaTeX 转图 ───────────────────────────
 * KaTeX 没有 SVG 输出。MathJax 的 tex2svg 输出是**自包含**的：
 * 字形全部转成 <path>，字体数据以 <defs> 内嵌在同一份 SVG 里，
 * 不依赖任何外部字体。这一点是关键 —— 小程序加载不了外部字体。
 *
 * ── 为什么默认出 PNG ─────────────────────────────────────────────
 * 小程序 <image> 组件对 SVG 的支持在 iOS 上一直不稳（时好时坏，
 * 与基础库版本相关）。PNG 是唯一保证能显示的形式。
 * 但 SVG 只有 4~8KB 而 PNG 是 30~60KB，所以两个都留：
 *   · 静态、确定能显示的场合用 PNG（默认）
 *   · 服务端调试 / Web 端内联用 SVG（体积小、任意缩放不糊）
 *
 * ── 尺寸怎么算 ──────────────────────────────────────────────────
 * MathJax 的 SVG 根节点带 `viewBox`，单位是 1/1000 em：
 *   viewBox="0 -833.9 4825.1 1090.4"
 *   → 宽 4.8251em，高 1.0904em
 * 按字号 17px、2 倍图算，就得到 164×37 的 PNG。
 * 比读 width="105.2ex" 靠谱 —— ex 是个相对单位，resvg 不认，
 * 而 em 换成 px 只需要一个字号常量。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* 磁盘缓存目录。放在 server/.cache/ 下，已在 .gitignore 里。
 * 为什么要落盘而不只是内存：这个缓存跨重启有效，而题库的公式是
 * 不变的 —— 重启一次就重新渲染 291 道题的公式，是很没必要的开销。 */
export const CACHE_DIR = path.resolve(__dirname, '../../.cache/math');

/** 字号（px）。和 Web 端正文字号对齐，让两端视觉一致。 */
const FONT_PX = 17;

/** 2 倍图。小程序在 3x 屏上会把 2x 图放大，但公式是线条图形，
 *  2x 已经看不出锯齿；3x 只是让体积翻倍。 */
const PNG_SCALE = 2;

/**
 * 默认墨色。
 *
 * ★ 这是个非做不可的参数，不是可选项。
 *   MathJax 输出的字形用 `fill="currentColor"` / `stroke="currentColor"`，
 *   「currentColor」在浏览器里继承父元素的 color，而 resvg 光栅化时
 *   没有父元素可继承 → 一律当黑色。
 *   结果就是：深色主题下公式图是一张**全透明底的黑色文字**，等于看不见。
 *
 * 所以渲染时必须显式替换成真实色值。这个值同时进缓存键 ——
 * 同一道题在深色主题和浅色主题下是两张不同的图。
 *
 * 默认取深墨色（浅色底用）。小程序端会按当前主题传自己的前景色。
 */
const DEFAULT_INK = '#1a1c22';

let inited = false;
let doc = null;
let adaptor = null;
let resvgCls = null;

/** 懒初始化。MathJax 首次构造约 200ms，不该在服务启动时就付这个代价。 */
function init() {
  if (inited) return;
  /* ★ 先把 inited 置 true 再干活：MathJax 的构造不是线程安全的，
   * 两个请求同时进来会各构造一份。JS 单线程下这个窗口其实不存在，
   * 但保持「标记先行」的习惯，将来如果拆成 worker 不会踩坑。
   *
   * 失败时必须回滚 —— 否则一次 require 失败会让 inited 永远为 true
   * 而 doc 是 null，之后每个请求都拿到 undefined 然后炸在别处。 */
  inited = true;

  try {
    /* mathjax-full 3.x 是 CommonJS。在 ESM 里用 createRequire 拿，
     * 比 `import { mathjax } from '...'` 可靠 —— 后者依赖 Node 的
     * CJS 具名导出探测，而 mathjax 的导出方式是 `exports.x = void 0`
     * 那种形式，探测不一定命中。 */
    const { mathjax } = require('mathjax-full/js/mathjax.js');
    const { TeX } = require('mathjax-full/js/input/tex.js');
    const { SVG } = require('mathjax-full/js/output/svg.js');
    const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
    const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
    const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');

    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);

    doc = mathjax.document('', {
      InputJax: new TeX({
        /* AllPackages 覆盖 ams / cases / matrix / color / bbox 等。
         * 考研数学用得到的都在里面（\begin{cases}、\begin{pmatrix}、
         * \text{}、\dfrac）。少装一个包，考场上就有一类题显示不出来。 */
        packages: AllPackages,
        /* 语法错误直接抛，由 renderSvg 兜住转成 fallback 文本 ——
         * MathJax 默认会渲染一个红色的错误标记，那个标记在小程序里
         * 是看不懂的英文，不如把源码原样还回去。 */
        formatError: (jax, err) => {
          throw err;
        },
      }),
      OutputJax: new SVG({ fontCache: 'local' }),
    });

    try {
      /* resvg 是可选的：没装的话 PNG 出不来，但 SVG 仍然可用。
       * 不让它成为硬依赖 —— 在只跑 API 的环境里没必要装。 */
      ({ Resvg: resvgCls } = require('@resvg/resvg-js'));
    } catch {
      resvgCls = null;
    }
  } catch (e) {
    inited = false;
    doc = null;
    throw e;
  }
}

/** 缓存键。tex + 显示模式 + 墨色一起哈希 ——
 *  同一串公式的行内/行间尺寸不同，深色/浅色主题的图也不同。 */
export function cacheKey(tex, display, color = DEFAULT_INK) {
  return crypto.createHash('sha256')
    .update(`${display ? 'D' : 'I'}\u0000${color}\u0000${tex}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * 剥掉 MathJax 的外层容器。
 *
 * MathJax 输出的是 `<mjx-container class="MathJax" jax="SVG"><svg …>…</svg></mjx-container>`。
 * 那个容器是给浏览器里做行内对齐用的，在图片场景下没有意义，而且
 * resvg 只接受 `<svg>` 作为根节点 —— 带着容器喂进去会报
 * 「SVG data parsing failed cause the document does not have a root node」，
 * 这个错误信息完全没提容器的事，很容易往「SVG 本身写坏了」的方向查。
 */
function unwrapSvg(s) {
  const i = s.indexOf('<svg');
  const j = s.lastIndexOf('</svg>');
  return (i >= 0 && j > i) ? s.slice(i, j + 6) : s;
}

/**
 * 从 MathJax 的输出里把尺寸读出来。
 * viewBox 单位是 1/1000 em，所以除以 1000 再乘字号就是 px。
 */
function sizeOf(svgText) {
  const vb = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/.exec(svgText);
  if (!vb) return { w: 0, h: 0 };
  const wEm = Number(vb[3]) / 1000;
  const hEm = Number(vb[4]) / 1000;
  return {
    w: Math.max(1, Math.round(wEm * FONT_PX)),
    h: Math.max(1, Math.round(hEm * FONT_PX)),
  };
}

/**
 * 把 MathJax 的 SVG 改成「有明确 px 尺寸」的版本。
 *
 * 原输出的 width/height 是 ex 单位（resvg 不认），且带一个
 * vertical-align 的 style（在图片里没意义）。这里统一换成 px。
 */
function normalizeSvg(svgText, { w, h }, scale = 1) {
  return svgText
    .replace(/\sstyle="[^"]*"/, '')
    .replace(/\swidth="[^"]*"/, ` width="${Math.round(w * scale)}"`)
    .replace(/\sheight="[^"]*"/, ` height="${Math.round(h * scale)}"`);
}

/**
 * 渲染单个公式。
 *
 * @param {string} tex  LaTeX 源码（不含 $ 定界符）
 * @param {boolean} display  true = 行间公式（独立成行、居中）
 * @returns {{key:string, svg:string, w:number, h:number}}
 */
export function renderSvg(tex, display = false, color = DEFAULT_INK) {
  const key = cacheKey(tex, display, color);

  let out;
  try {
    init();
    out = adaptor.outerHTML(doc.convert(tex, { display }));
  } catch (e) {
    /* 语法错误不能变成 500 —— 用户录了一道题，公式写错一个括号，
     * 整个页面不该崩。退化成「把源码当普通文字」，前端照常显示，
     * 用户能看出自己写错了什么。 */
    const msg = String(e?.message || e).replace(/^.*?:\s*/, '').slice(0, 200);
    return {
      key,
      svg: '',
      w: 0,
      h: 0,
      error: msg,
      fallback: tex,
    };
  }

  const raw = unwrapSvg(out);
  const { w, h } = sizeOf(raw);
  /* 把 currentColor 换成真实色值。见 DEFAULT_INK 上面的注释 ——
   * 不换的话深色主题下公式是黑的，看不见。 */
  const inked = raw.split('currentColor').join(color);
  return { key, svg: normalizeSvg(inked, { w, h }), w, h };
}

/**
 * 转 PNG。resvg 不可用时返回 null，调用方退到 SVG。
 * @returns {Buffer|null}
 */
export function renderPng(tex, display = false, color = DEFAULT_INK) {
  try { init(); } catch { return null; }
  if (!resvgCls) return null;

  const r = renderSvg(tex, display, color);
  if (!r.svg) return null;

  const sized = normalizeSvg(r.svg, { w: r.w, h: r.h }, PNG_SCALE);
  try {
    const png = new resvgCls(sized, {
      /* 背景透明 —— 公式要贴在各种主题的卡片上，硬加底色会在卡片上
       * 出现一个方块。文字颜色已经由 color 参数保证对比度。 */
      background: 'rgba(0,0,0,0)',
      fitTo: { mode: 'width', value: Math.max(1, Math.round(r.w * PNG_SCALE)) },
    }).render();
    return png.asPng();
  } catch {
    return null;
  }
}

/* ---------- 磁盘缓存 ---------- */

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * 确保这个公式的静态文件在磁盘上，返回可供 <image src> 用的相对路径。
 *
 * 为什么走静态文件而不是每次返回 base64：
 *   · base64 会让响应体积涨 33%，而同一个公式在题库里会反复出现；
 *   · 静态文件可以带一年期的 immutable 缓存头，第二次是零请求；
 *   · 小程序的 <image> 缓存策略对同 URL 是有效的，base64 没有缓存。
 */
export function ensureAsset(tex, display = false, format = 'png', color = DEFAULT_INK) {
  const r = renderSvg(tex, display, color);
  const key = r.key;
  const ext = format === 'svg' ? 'svg' : 'png';
  const file = path.join(CACHE_DIR, `${key}.${ext}`);

  if (fs.existsSync(file)) {
    return { key, url: `/math/${key}.${ext}`, w: r.w, h: r.h, error: r.error };
  }

  if (!r.svg) {
    /* 渲染失败：不落盘，让调用方拿 fallback 文本自己处理。
     * 落盘会产生一个「永远坏」的缓存，改了公式也不会更新。 */
    return { key, url: '', w: 0, h: 0, error: r.error, fallback: r.fallback };
  }

  ensureCacheDir();

  if (ext === 'svg') {
    fs.writeFileSync(file, r.svg);
  } else {
    const png = renderPng(tex, display, color);
    if (!png) {
      /* resvg 没装 —— 退到 SVG，别让整个接口失败。 */
      const svgFile = path.join(CACHE_DIR, `${key}.svg`);
      fs.writeFileSync(svgFile, r.svg);
      return { key, url: `/math/${key}.svg`, w: r.w, h: r.h, note: 'png-unavailable' };
    }
    fs.writeFileSync(file, png);
  }

  return { key, url: `/math/${key}.${ext}`, w: r.w, h: r.h };
}

/* ---------- 文本切段 ----------
 *
 * 这是小程序 math-text 组件的服务端一半。
 *
 * 为什么要切段而不是整段出图：
 *   「设函数 $f(x)=x^2$ 在区间上连续」整句渲染成一张图，用户就没法
 *   选中、复制、搜索，也无法用读屏软件。切成
 *   [文字, 公式图, 文字] 之后，文字部分是原生 <text>，公式部分是 <image>，
 *   用 flex-wrap 拼起来 —— 两边的优点都留住了。
 *
 * 定界符：$...$（行内）、$$...$$（行间）、\(...\)、\[...\]。
 * ★ 不处理裸写的反斜杠命令：那会让「价格 $5 到 $10」这种普通文本
 *   被误判成公式。宁可漏，不可错 —— 漏了只是显示成原文，错了是乱码。
 */

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

/**
 * 判断一段 $...$ 里的内容**是不是真的公式**。
 *
 * 为什么需要这一步：`价格 $5 到 $10 之间` 这句话里，两个 $ 之间夹着
 * 「5 到 」，正则会把整段当成行内公式。这是真实会出现的文本 ——
 * 录题时用户会写「2019 年真题，第 $3 题」这种话。
 *
 * 判定口径（宽松但足够安全）：
 *   · 含反斜杠命令（\frac、\infty、\text）→ 一定是公式
 *   · 含 ^ _ { } = < > → 一定是公式
 *   · 含拉丁字母且不含中文 → 公式（$x$、$n$、$f(x)$）
 *   · 含中文 → 不是公式（中文不会出现在 LaTeX 数学模式里）
 *   · 纯数字 / 纯数字加标点 → 不是公式（这是钱的写法，不是公式的写法）
 *
 * 最后一条会误伤 `$100$` 这种「就想显示一个数字」的写法。可以接受：
 * 它显示成原文 `$100$`，用户看得懂；而反过来（把「$5 到 $10」渲染成
 * 乱码公式）是不可读的。
 */
function looksLikeMath(tex) {
  if (!tex) return false;
  if (/\\[a-zA-Z]+/.test(tex)) return true;        // \frac, \infty
  if (/[\^_{}=<>]/.test(tex)) return true;         // x^2, a_{n}, x=1
  if (/[\u4e00-\u9fa5]/.test(tex)) return false;   // 含中文，不是公式
  if (/[a-zA-Z]/.test(tex)) return true;           // $x$, $f(x)$
  if (/^[\d\s.,+\-*/%]+$/.test(tex)) return false; // 纯数字，多半是金额
  return true;
}

/**
 * 把一段含 $...$ 的文本切成 [{type:'text'|'math', ...}] 段。
 *
 * @returns {{segments: Array, hasMath: boolean}}
 */
export function splitText(text, { format = 'png', color = DEFAULT_INK } = {}) {
  const src = String(text ?? '');
  const segments = [];
  let last = 0;
  let m;

  MATH_RE.lastIndex = 0;
  while ((m = MATH_RE.exec(src)) !== null) {
    const [whole, d1, d2, i1, i2] = m;
    const tex = (d1 ?? d2 ?? i1 ?? i2 ?? '').trim();
    const display = Boolean(d1 !== undefined || d2 !== undefined);

    if (!tex) continue;

    /* 不是公式就把它连同定界符一起当普通文字。
     * 注意 last 不推进 —— 这段会并进上一段文本里，$ 符号原样保留，
     * 用户看到的就是自己写的原文。 */
    if (!looksLikeMath(tex)) continue;

    if (m.index > last) {
      segments.push({ type: 'text', v: src.slice(last, m.index) });
    }

    const asset = ensureAsset(tex, display, format, color);
    segments.push({
      type: 'math',
      tex,
      display,
      ...asset,
    });

    last = m.index + whole.length;
  }

  if (last < src.length) segments.push({ type: 'text', v: src.slice(last) });

  /* 没有任何公式时，返回单段文本 —— 让前端少一个分支。 */
  if (!segments.length) segments.push({ type: 'text', v: src });

  return { segments, hasMath: segments.some((s) => s.type === 'math') };
}

/**
 * PNG 光栅化是否可用。
 *
 * 控制台要能回答这个问题：resvg 没装时公式图会静默降级成 SVG，
 * 而 SVG 在 iOS 小程序里可能显示不出来 —— 那是一种「服务端一切正常、
 * 用户端一片空白」的故障，最难查。所以把这个状态暴露出来。
 */
export function pngAvailable() {
  try { init(); } catch { return false; }
  return Boolean(resvgCls);
}

/** 缓存目录的统计信息，给控制台看。 */export function cacheStats() {
  if (!fs.existsSync(CACHE_DIR)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const st = fs.statSync(path.join(CACHE_DIR, f));
    if (st.isFile()) { files += 1; bytes += st.size; }
  }
  return { files, bytes, mb: Number((bytes / 1024 / 1024).toFixed(2)) };
}

/** 清空缓存（控制台按钮）。 */
export function clearCache() {
  if (!fs.existsSync(CACHE_DIR)) return 0;
  const files = fs.readdirSync(CACHE_DIR);
  for (const f of files) fs.unlinkSync(path.join(CACHE_DIR, f));
  return files.length;
}

/**
 * 预热。启动时在后台调一次。
 *
 * 为什么要预热：MathJax 首次构造约 200ms，加上第一次渲染的字体表
 * 构建，实测首个请求要 2 秒以上。那 2 秒会落在「今天第一个打开
 * 小程序的人」身上，表现为打开题目页白屏两秒 —— 很像 bug。
 * 启动时付掉这笔钱，用户就永远感知不到。
 *
 * 失败不抛：预热只是优化，它失败不该阻止服务启动。第一次真实
 * 请求会再试一遍（init 已经把 inited 回滚了）。
 */
export function warm() {
  try {
    init();
    renderSvg('x^2', false);
    return true;
  } catch {
    return false;
  }
}
