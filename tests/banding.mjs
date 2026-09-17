/* 近黑渐变上的色带（banding）检测
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 赛博网格的底色是 rgb(5,6,12) 这个量级，而地平线光带、暗角都是
 * 跨几百像素的平滑渐变。换算成 8 位色阶，天空区的梯度只有 ~0.03 色阶/像素 ——
 * 显卡把几十个像素量化到同一个色阶，于是屏幕上出现一条条宽度几十像素的色带。
 * 人眼在暗部对亮度差最敏感，这种带比在亮部明显得多。
 *
 * 问题是**看不出**：压缩过的截图里看不出，缩略图里更看不出，我肉眼看过三轮都没发现。
 * 所以只能数。
 *
 * ── 判据 ────────────────────────────────────────────────────
 * 沿一列像素走，把亮度相同且连续的一段叫「平台」。
 *   平台占比 = 落在长度 ≥ MIN_RUN 的平台里的像素数 / 总像素数
 *
 * 平滑渐变 + 无抖动时，平台宽度 = 1 / 梯度斜率，通常几十像素 ——
 * 也就是说**占比接近 1**，而这个「1」正是色带本身：
 * 8 位量化必然产生平台，问题不在有没有平台，在于平台有多宽。
 * 加抖动之后平台被打散成 1–4 像素的碎块，占比掉到 0.01 以下。
 *
 * 所以这个数**不是「越小越好」的美学指标**，它是
 * 「有多少像素正处在肉眼可见的平坦台阶上」。
 * 实测过的三档：
 *   不抖动   0.964   最长平台 81px   ← 肉眼可见的硬色带
 *   IGN 抖动 0.021   最长平台  6px   ← 效果好但 PNG 压不动，截图管线会挂
 *   Bayer   0.007   最长平台  4px   ← 现在用的
 *
 * ── 为什么必须 1:1 采集（这段最容易搞错）──────────────────────
 * 画布按 dpr 1.25 渲染，而 `npm run shots` 是在 deviceScaleFactor=2 下截图的 ——
 * 中间隔了一次 1.6 倍上采样。在那种图上量，量到的是「上采样之后」的结果，
 * 而不是着色器真正的输出：实测同一份代码 1:1 是 0.007、DPR 2 是 0.218，
 * 相差 30 倍，而上采样还会把抖动本身糊掉一部分。
 *
 * 所以这个脚本**自己起浏览器、按 deviceScaleFactor = 1.25 采集**，
 * 让画布后备存储（1800×1125）和截图（1800×1125）严格 1:1，零重采样。
 * 这也顺带切掉了 DPR 2 那趟里混进来的所有重采样伪影。
 *
 * ── 采样位置 ────────────────────────────────────────────────
 * 默认取登录页右边缘、地平线以上的天空区：那里没有被任何面板遮挡，
 * 也没有横向网格线（横向线会制造出「非色带」的亮度跳变，污染统计）。
 * 多列取中位数，避开偶尔撞上的星尘和竖向数据线。
 *
 * 用法：
 *   npm run banding                              # 起浏览器采登录页，1:1 量
 *   npm run banding -- --isolate                 # 额外报「仅着色器 / 仅 CSS」的分解
 *   npm run banding -- --file a.png b.png        # 量已有的图（跳过采集）
 *   npm run banding -- --x 0.9 --y0 0.05 --y1 0.5
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, decodePngBuffer, columnLuma, median } from './lib/png.mjs';
import { launchPage, sleep } from './lib/browser.mjs';

const MIN_RUN = 4;        // 短于 4 个像素的平台不算「带」
const COLUMNS = 7;        // 取几列
const COL_SPAN = 0.02;    // 列分布在 x 附近的这个宽度内

/** 画布 dpr。必须和 CyberGrid.tsx 里的 `let dpr = 1.25` 保持一致 ——
 *  这里是「按画布原生分辨率采集」的前提，对不上就白测了。 */
const CANVAS_DPR = 1.25;
const VIEW = { w: 1440, h: 900 };

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  argv.splice(i, 2);
  return Number.isFinite(v) ? v : dflt;
}
function flag(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

const X = opt('x', 0.97);
const Y0 = opt('y0', 0.03);
const Y1 = opt('y1', 0.55);
const THRESHOLD = opt('threshold', 0.55);
const ISOLATE = flag('isolate');
const BASE = process.env.BASE || 'http://127.0.0.1:5180';

let files = argv.filter((a) => !a.startsWith('--'));
const useFiles = files.length > 0;

/** 数一列的平台占比 */
function plateauRatio(col) {
  let inPlateau = 0;
  let i = 0;
  let maxRun = 0;
  let runs = 0;
  while (i < col.length) {
    let j = i;
    while (j + 1 < col.length && col[j + 1] === col[i]) j++;
    const len = j - i + 1;
    runs++;
    maxRun = Math.max(maxRun, len);
    if (len >= MIN_RUN) inPlateau += len;
    i = j + 1;
  }
  return { ratio: inPlateau / col.length, maxRun, runs, levels: new Set(col).size };
}

/** 对一张已解码的图做测量，返回中位数指标 */
function measure(img) {
  const x0 = Math.round(img.width * X);
  const y0 = Math.round(img.height * Y0);
  const y1 = Math.round(img.height * Y1);
  const span = Math.max(1, Math.round(img.width * COL_SPAN));

  const ratios = [];
  const runsArr = [];
  const levelsArr = [];
  let maxRun = 0;
  for (let k = 0; k < COLUMNS; k++) {
    const x = Math.min(
      img.width - 1,
      Math.max(0, x0 + Math.round((k - (COLUMNS - 1) / 2) * (span / COLUMNS))),
    );
    const r = plateauRatio(columnLuma(img, x, y0, y1));
    ratios.push(r.ratio);
    runsArr.push(r.runs);
    levelsArr.push(r.levels);
    maxRun = Math.max(maxRun, r.maxRun);
  }
  return {
    ratio: median(ratios),
    maxRun,
    runs: Math.round(median(runsArr)),
    levels: Math.round(median(levelsArr)),
  };
}

function report(label, m) {
  const bad = m.ratio > THRESHOLD;
  const mark = bad ? '\x1b[31m✗ 有色带\x1b[0m' : '\x1b[32m✓ 平滑\x1b[0m';
  console.log(
    `  ${mark} ${label.padEnd(24)} ` +
    `平台占比 ${m.ratio.toFixed(3)}  ` +
    `最长平台 ${String(m.maxRun).padStart(3)}px  ` +
    `色阶 ${String(m.levels).padStart(3)}  ` +
    `平台段数 ${String(m.runs).padStart(3)}`,
  );
  return bad;
}

let failed = 0;
let worst = 0;

/* ---------------- 路径 A：量已有的图 ---------------- */
if (useFiles) {
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`\x1b[31m✗ 找不到 ${f}\x1b[0m`);
      failed++;
      continue;
    }
    const m = measure(decodePng(f));
    worst = Math.max(worst, m.ratio);
    if (report(path.basename(f), m)) failed++;
  }
} else {
  /* ---------------- 路径 B：自己起浏览器，1:1 采集 ---------------- */
  console.log(`\x1b[90m采集 ${BASE}/login  @ deviceScaleFactor ${CANVAS_DPR}（画布原生，1:1）\x1b[0m`);

  let browser = null;
  try {
    browser = await launchPage({ width: VIEW.w, height: VIEW.h });
    const { client } = browser;
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    /* 冻结动画：让采集有确定性。shader 的 uTime 停在 0，
     * 扫描线在屏幕最顶端（uv.y=1.0），不干扰采样区。
     * 星尘也尊重 reduced-motion → 静态。 */
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.w, height: VIEW.h, deviceScaleFactor: CANVAS_DPR, mobile: false,
    });

    const ev = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    };

    /** 采集一张，返回解码后的图。inject 会在截图前注入一段样式。 */
    async function grab(inject) {
      await client.send('Page.navigate', { url: `${BASE}/login?cb=${Date.now()}` });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const ok = await ev('document.readyState === "complete" && !!document.querySelector("input[name=email]")');
        if (ok === true) break;
        await sleep(180);
      }
      await sleep(1400);
      if (inject) { await ev(inject); await sleep(800); }

      /* ★ 采集前先确认主胎装上了。WebGL 静默降级的话，量到的是 CSS 备胎，
       * 数字看着"没问题"，但结论是假的 —— 备胎长得像不代表主胎装上了。 */
      const fx = await ev(`(() => {
        const gl = document.documentElement.classList.contains('fx-webgl');
        const c = document.querySelector('canvas[data-fx=cybergrid]');
        return gl + '|' + (c ? c.width + 'x' + c.height : 'none');
      })()`);
      const [alive, size] = String(fx).split('|');
      if (alive !== 'true') {
        console.log(`\x1b[33m  ⚠ WebGL 没起来（走了 CSS 降级），这次的数字只能反映备胎\x1b[0m`);
      }

      /* captureScreenshot 在 headless + 软件 GL 下偶发挂住（见 screenshot.mjs 里的注释），
       * 重试。不重试的话这个检测本身就会变成一个 flaky 测试。 */
      let shot = null;
      for (let attempt = 1; attempt <= 3 && !shot; attempt++) {
        try {
          shot = await client.send('Page.captureScreenshot', { format: 'png' }, 20000);
        } catch (e) {
          if (attempt === 3) throw e;
          await sleep(900);
        }
      }
      const img = decodePngBuffer(Buffer.from(shot.data, 'base64'));
      return { img, fxSize: size };
    }

    const HIDE_CSS = `(() => {
      let s = document.getElementById('band-hide-css');
      if (!s) { s = document.createElement('style'); s.id = 'band-hide-css'; document.head.appendChild(s); }
      s.textContent = 'body::before, body::after { display: none !important; }';
      return 'ok';
    })()`;
    const HIDE_GL = `(() => {
      let s = document.getElementById('band-hide-gl');
      if (!s) { s = document.createElement('style'); s.id = 'band-hide-gl'; document.head.appendChild(s); }
      s.textContent = 'canvas[data-fx=cybergrid] { display: none !important; }';
      return 'ok';
    })()`;
    /* ★ 藏星尘也点名 data-fx，不能用 canvas 通配 —— 页面上有两个画布。 */
    const HIDE_SF = `(() => {
      let s = document.getElementById('band-hide-sf');
      if (!s) { s = document.createElement('style'); s.id = 'band-hide-sf'; document.head.appendChild(s); }
      s.textContent = 'canvas[data-fx=starfield] { display: none !important; }';
      return 'ok';
    })()`;

    const main = await grab(null);
    const mMain = measure(main.img);
    console.log(`\x1b[90m画布 ${main.fxSize}\x1b[0m`);
    console.log('');
    if (report('登录页（原样）', mMain)) failed++;
    worst = Math.max(worst, mMain.ratio);

    if (ISOLATE) {
      /* 分解：把每一层单独量一次。没有这一步的话，
       * 「有色带」只是一个现象，不知道该改哪儿。
       *
       * ⚠️ 两组的注入方式**方向是相反的**，很容易写反（第一版就写反过）：
       *   · 「仅着色器」= 藏掉 CSS 层（body::before/after），留画布
       *   · 「仅 CSS」  = 藏掉两个画布，留 CSS 层
       * 如果两组都写成"藏 CSS 层"，那第二组量到的其实是纯底色 ——
       * 平台占比 1.000、色阶 1，看起来"最糟"，其实是全平，什么都没量到。
       *
       * 还要注意：藏画布必须**同时点名两个**（cybergrid + starfield）。
       * 只藏着色器的话剩下的其实是星尘画布，不是 CSS。 */
      console.log('');
      console.log('\x1b[90m── 分层归因 ──\x1b[0m');
      const mGL = measure((await grab(HIDE_CSS)).img);
      report('仅 WebGL 着色器', mGL);
      const mCSS = measure((await grab(HIDE_GL + ';' + HIDE_SF)).img);
      report('仅 CSS 光晕/网格', mCSS);
      console.log('');
      console.log(`\x1b[90m  着色器 ${mGL.ratio.toFixed(3)}    CSS ${mCSS.ratio.toFixed(3)}\x1b[0m`);
    }
  } finally {
    if (browser) browser.kill();
  }
}

console.log('\n' + '─'.repeat(58));
console.log(`  采样区 x≈${X}  y ${Y0}–${Y1}（${COLUMNS} 列取中位数）  阈值 ${THRESHOLD}`);
if (!useFiles) console.log(`  画布原生 1:1（deviceScaleFactor ${CANVAS_DPR}）`);
if (failed) {
  console.log(`\x1b[31m❌ 色带检测：1 项，失败 1 项（最高平台占比 ${worst.toFixed(3)}）\x1b[0m`);
  console.log('   近黑渐变上的平台就是色带本身。检查 CyberGrid.tsx 里最后那行 Bayer 抖动还在不在。');
  process.exit(1);
}
console.log(`\x1b[32m✅ 色带检测：1 项（最高平台占比 ${worst.toFixed(3)}）\x1b[0m`);
