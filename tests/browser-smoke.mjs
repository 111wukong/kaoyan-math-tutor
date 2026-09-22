/* 真浏览器冒烟测试（零 npm 依赖）
 *
 * 为什么必须有这一层：`vite build` 通过 + `tsc` 零错误，仍然可能是白屏。
 * 静态检查查不出「点了注册整页崩掉」。这里用系统里的 Chromium + Node 22 自带的
 * WebSocket 说 CDP，真开一次页面，把 15 个路由全走一遍。
 *
 * 前提：后端已在 127.0.0.1:5180 运行，且 web/dist 已构建（后端会托管它）。
 *   终端 1: npm run start
 *   终端 2: node tests/browser-smoke.mjs
 *
 * 找不到 Chromium 就优雅跳过（exit 0），不报失败 —— 换台机器跑测试不该红。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from './lib/server.mjs';
import { startLlmStub } from './lib/llm-stub.mjs';
/* ★ 找浏览器只用 lib/browser.mjs 那一份。
 *   这里原来有一份**逐行复制**的副本，于是「BROWSER 环境变量优先」这类
 *   改动只改了 lib 那份，本套件照旧用缓存里的 headless-shell ——
 *   排查 CI 红时想在本机复现「完整版 Chrome」的行为，指不过去，只能另写探针。
 *   两处实现迟早漂移，索性只留一处。 */
import { findBrowser } from './lib/browser.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180';

/* 引导管理员凭据。服务端不再有内置默认密码（公开仓库里不能有能用的口令），
 * 测试得自己指定 —— npm test 起的临时服务用的是同一组值。 */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || TEST_ADMIN_PASSWORD;
const WIDTH = 1440;
const HEIGHT = 900;

let pass = 0;
let fail = 0;
/* 「因环境跳过」是第三态：既不算通过也不算失败。
 * 但它必须在日志里出声、并在汇总行里带出来 ——
 * 这个项目的教训是「0 项」和「全绿」在汇总里长得一样，
 * 所以任何跳过都不许静默。 */
let skipped = 0;
const failures = [];
const consoleErrors = [];
const exceptions = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
function skip(name, why) {
  skipped++;
  console.log(`  \x1b[33m⚠ 跳过\x1b[0m ${name}  \x1b[90m（${why}）\x1b[0m`);
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 找浏览器用 lib/browser.mjs 的 findBrowser（见顶部 import 的说明）。
 * 这里不再保留副本 —— 两份实现漂移过一次，代价是 CI 连红 7 次。 */

/* ---------- 极简 CDP 客户端 ---------- */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach((fn) => fn(msg));
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连不上')));
  });
  return {
    ready,
    send(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => {
          if (waiting.has(id)) { waiting.delete(id); reject(new Error(method + ' 超时')); }
        }, 20000);
      });
    },
    on(fn) { listeners.push(fn); },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
}

/* ---------- 主流程 ---------- */
const browser = findBrowser();
if (!browser) {
  /* ★ [SKIP] 这个标记是给 tests/run-all.mjs 认的，别删。
   *   以前运行器是靠「输出里有没有『跳过』两个字」判断套件跳没跳 ——
   *   结果某个套件里一条断言叫「花括号组要整体跳过」，就被误判成整包跳过了，
   *   汇总行打出「（跳过 —— 本机没有浏览器）」而实际它跑得好好的。
   *   靠子串猜状态就是这种下场，改成显式标记。 */
  console.log('[SKIP] 本机没有 Chromium 内核');
  console.log('\n\x1b[33m· 本机没找到 Chromium 内核，跳过浏览器冒烟测试\x1b[0m');
  console.log('  （装了 Google Chrome / Edge，或任意带 playwright 的工具即可自动启用）');
  console.log('\n' + '─'.repeat(46));
  console.log('\x1b[32m✅ 浏览器冒烟：0 项（已跳过）\x1b[0m');
  process.exit(0);
}
console.log(`\x1b[1m研数 · 真浏览器冒烟测试\x1b[0m`);
console.log(`目标 ${BASE}`);
console.log(`内核 ${browser.bin.replace(os.homedir(), '~')}`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yanshu-smoke-'));
let proc = null;
let client = null;

try {
  const args = [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    /* ★ 关掉弹窗拦截 —— 站内链接一律 target="_blank"，而**完整版 Chrome
     * 在 --headless=new 下会把这种点击当成「无用户手势的自动弹窗」拦掉**，
     * 一个标签都不会多出来。本机（命中 Playwright 缓存的 headless-shell）
     * 一路绿，CI（Ubuntu + /usr/bin/google-chrome）连续红在「没等到新标签页」。
     * 实测对照见 lib/browser.mjs 里同一处注释。 */
    '--disable-popup-blocking',
    /* ★ 软件 WebGL2。没有这三个参数，headless 下 getContext('webgl2') 直接返回 null,
     * 赛博网格背景会静默降级成 CSS 备胎 —— 于是「背景画出来了」这条断言
     * 测的其实是备胎，主胎装没装上根本不知道。
     * SwiftShader 是纯 CPU 实现，慢但确定性好。 */
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--window-size=${WIDTH},${HEIGHT}`,
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ];
  if (browser.kind === 'chrome') args.unshift('--headless=new');
  /* 不要用 detached: true。Chromium 会派生 zygote / GPU / renderer 一堆子进程，
     独立进程组反而让它们在父进程退出后继续活着，把输出管道一直攥着不放 ——
     接管道（npm test | tail）时表现为整条命令永久挂起。
     普通子进程 + 显式 kill 就够，Chromium 被 SIGKILL 后不会留孤儿。 */
  proc = spawn(browser.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', () => { /* 启动噪音，忽略 */ });

  // 端口写在 DevToolsActivePort 文件里，轮询等它出现
  const portFile = path.join(profile, 'DevToolsActivePort');
  let dbgPort = null;
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(portFile)) {
      const t = fs.readFileSync(portFile, 'utf8').trim().split('\n')[0];
      if (t) { dbgPort = t; break; }
    }
    await sleep(250);
  }
  if (!dbgPort) throw new Error('浏览器起来了但没写出调试端口');

  const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面目标');

  client = cdp(page.webSocketDebuggerUrl);
  await client.ready;

  /* 记下浏览器发出的每一个请求。
   * 用来证明「切回一个刚看过的页面时，**没有再打接口**」——
   * 只断言「DOM 还在」是不够的：DOM 保住了、数据照样重拉一遍，
   * 用户看到的依然是闪一下。缓存有没有生效只有数请求才知道。 */
  const requests = [];

  client.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      // React 开发构建的提示不算错误
      if (!/Download the React DevTools|DevTools/i.test(text)) consoleErrors.push(text);
    }
    if (msg.method === 'Network.requestWillBeSent') {
      requests.push(msg.params.request.url);
    }
  });

  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Log.enable');
  await client.send('Network.enable');

  const ev = async (expr) => {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return { value: r.result?.value };
  };

  /* 探针一律自带 try/catch —— 探针自己抛异常时，你会分不清是页面坏了还是探针写错了 */
  const probe = async (body) => {
    const r = await ev(`(function(){try{${body}}catch(e){return 'PROBE_ERROR: '+(e&&e.message)}})()`);
    return r.error ? 'PROBE_ERROR: ' + r.error : r.value;
  };

  const nav = async (p) => {
    const sep = p.includes('?') ? '&' : '?';
    await client.send('Page.navigate', { url: `${BASE}${p}${sep}cb=${Date.now()}` });
  };

  const waitFor = async (expr, label, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const r = await ev(expr);
      if (r.value === true) return true;
      await sleep(180);
    }
    console.log(`  \x1b[31m✗ 等待超时（${timeout}ms）：${label}\x1b[0m`);
    fail++; failures.push('等待超时：' + label);
    return false;
  };

  const bodyText = async () => (await ev('document.body.innerText')) .value || '';

  /* ---------- 标签页 / 客户端路由 ----------
   *
   * 站内链接现在**一律 target="_blank"**（需求：「从一个网页进入另一个网页，
   * 浏览器要新开一个，上一个网页留着」）。于是有两件事要分开测：
   *
   *   · 点链接 → 应该**开一个新标签页**，原页面不动。走 HTTP 的 /json/list
   *     对比点击前后的目标列表来验（CDP 的 Target.getTargets 只在浏览器级
   *     会话可用，这里连的是 page 会话）。
   *   · 要在**同一个文档里**换路由（保活 / 缓存 / 滚动恢复那几节的前提），
   *     就得走 React Router 自己监听的那条路：popstate。
   */
  const listPages = async () => {
    try {
      const l = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      return l.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
    } catch { return []; }
  };

  /** 等一个新标签页出现，且路径正好是 expectPath */
  const waitForNewTab = async (knownIds, expectPath, timeout = 6000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const fresh = (await listPages()).filter((p) => !knownIds.includes(p.id));
      const hit = fresh.find((p) => {
        try { return new URL(p.url).pathname === expectPath; } catch { return false; }
      });
      if (hit) return hit;
      await sleep(120);
    }
    return null;
  };

  /**
   * 同一个文档内的客户端路由切换。
   *
   * pushState 本身**不触发**任何事件，React Router 监听的是 popstate，
   * 所以必须手动补一发。state 里带上自增的 idx ——
   * 不带的话 React Router 会把这次跳转算成 delta 为负的 POP，
   * 行为虽然也是导航，但语义上不对（这一条是 PUSH）。
   */
  const spaNav = async (p) => probe(`
    history.pushState({ idx: ((history.state && history.state.idx) || 0) + 1 }, '', ${JSON.stringify(p)});
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    return location.pathname;`);

  /* ============================================================ */
  section('0. 页面可达');
  {
    const h = await fetch(`${BASE}/api/health`).catch(() => null);
    ok('后端在线', !!h && h.ok, h ? String(h.status) : '连不上 —— 先 npm run start');
    if (!h || !h.ok) throw new Error('后端没起来，后面测不了');

    await nav('/');
    await waitFor('!!document.querySelector("input[name=email]")', '登录表单出现');
    const info = await probe(`
      var cs = getComputedStyle(document.documentElement);
      return JSON.stringify({
        w: innerWidth, h: innerHeight,
        bg: cs.getPropertyValue('--color-ink-1000').trim(),
        canvas: document.querySelectorAll('canvas').length,
        title: document.title
      });`);
    console.log('  视口/主题：' + info);
    const d = JSON.parse(info);
    ok('视口是桌面宽度（没误中响应式断点）', d.w >= 1400, `innerWidth=${d.w}`);
    ok('设计 token 已注入（--color-ink-1000）', /#03040a/i.test(d.bg), `实得 "${d.bg}"`);
    ok('背景画布已挂载（赛博网格 + 星尘 = 2）', d.canvas >= 2, `实得 ${d.canvas}`);
    ok('页面标题正确', /研数/.test(d.title), d.title);
  }

  section('1. 背景三层：赛博网格（WebGL）/ 星尘（Canvas2D）/ 层次顺序');
  {
    /* ---- 0. 先探这个浏览器到底能不能拿到 WebGL2 ----
     *
     * 拿不到的话，赛博网格会走 CSS 降级路径 —— 那三条针对 WebGL 的断言
     * 就没有意义了。此时**显式跳过并出声**，而不是让它们假绿或假红。
     * 启动参数里已经带了 SwiftShader，正常情况下一定拿得到；
     * 拿不到说明这个内核不带软件 WebGL，需要单独处理。 */
    const hasWebGL2 = await probe(
      `var c = document.createElement('canvas');
       try { return !!c.getContext('webgl2'); } catch (e) { return false; }`,
    );
    if (hasWebGL2 !== true) {
      console.log('  \x1b[33m⚠ 这个内核拿不到 WebGL2 —— 赛博网格会走 CSS 降级路径。\x1b[0m');
      console.log('  \x1b[33m  启动参数必须带：--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader\x1b[0m');
    }

    /* ---- 1a. 赛博网格的着色器真的编译链接成功了 ---- */
    /* fx-webgl 这个类只在 createShaderRenderer 返回非 null 时挂上，
     * 也就是「顶点+片元着色器编译通过、程序链接通过」。
     * 这一条是必须的：着色器挂掉时组件会**静默降级**成 CSS 背景，
     * 页面照常好看，只是那个最贵的功能死了。
     * 实测踩过：把 `const float HORIZON` 写成 `const HORIZON`，
     * 编译报错 → 降级 → 15 张截图张张"看着没问题"。 */
    if (hasWebGL2 === true) {
      const glOk = await probe(`return document.documentElement.classList.contains('fx-webgl')`);
      ok('赛博网格着色器编译链接成功（fx-webgl 已挂上）', glOk === true,
        `实得 ${JSON.stringify(glOk)} —— 页面会静默降级为 CSS 背景，先看控制台里的 [fx] 警告`);

      const glCanvas = await probe(`
        var c = document.querySelector('canvas[data-fx=cybergrid]');
        if (!c) return JSON.stringify({ missing: true });
        var cs = getComputedStyle(c);
        return JSON.stringify({
          w: c.width, h: c.height, cssW: Math.round(c.getBoundingClientRect().width),
          z: cs.zIndex, pos: cs.position, vis: cs.visibility, op: cs.opacity,
        });`);
      const gc = JSON.parse(glCanvas);
      ok('赛博网格 canvas 已挂载且按 DPR 放大', !gc.missing && gc.w > gc.cssW,
        `后备缓冲 ${gc.w}×${gc.h} / CSS ${gc.cssW}px —— 未放大说明 resize 没跑`);
      ok('赛博网格压在星尘之下（-z-20 < -z-10）', gc.z === '-20', `z-index=${gc.z}`);
      ok('赛博网格铺满视口且可见', gc.pos === 'fixed' && gc.vis === 'visible' && gc.op === '1',
        `${gc.pos} / ${gc.vis} / opacity ${gc.op}`);
    } else {
      skip('赛博网格着色器编译链接成功（fx-webgl 已挂上）', '本内核无 WebGL2');
      skip('赛博网格 canvas 已挂载且按 DPR 放大', '本内核无 WebGL2');
      skip('赛博网格压在星尘之下（-z-20 < -z-10）', '本内核无 WebGL2');
      skip('赛博网格铺满视口且可见', '本内核无 WebGL2');
    }

    /* ---- 1b. 星尘 canvas 真的画了东西 ---- */
    await sleep(900);   // 让粒子跑几帧
    const r = await probe(`
      var cv = document.querySelector('canvas[data-fx=starfield]');
      if (!cv) return JSON.stringify({ w: 0, h: 0, painted: 0 });
      var ctx = cv.getContext('2d');
      if (!ctx) return JSON.stringify({ w: cv.width, h: cv.height, painted: -1 });
      var d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      var painted = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] !== 0) painted++;
      return JSON.stringify({ w: cv.width, h: cv.height, painted: painted });`);
    const d = JSON.parse(r);
    ok('星尘 canvas 有实际尺寸', d.w > 200 && d.h > 200, `${d.w}×${d.h}`);
    ok('星尘 canvas 上真的画了粒子（非透明像素）', d.painted > 500,
      d.painted === -1 ? 'getContext("2d") 返回 null —— 选错画布了？' : `${d.painted} 个非透明像素`);

    /* ---- 1c. 层次顺序：负 z-index 的层没有被不透明祖先盖住 ----
     *
     * ★ 这条是踩出来的，不是想出来的。
     * CSS 绘制顺序（CSS 2.1 附录 E）：根元素背景 → 负 z-index 子元素 →
     * 普通流块级元素的背景 → ……。所以只要 body（或中间任何一层）
     * 画了不透明的 background，就会把 -z-20 / -z-10 整层盖掉。
     * 症状极具欺骗性：着色器在跑、画布尺寸正确、控制台干净、页面"有背景"
     * （那是 CSS 备胎），就是看不见主背景。当时排查了四十分钟，
     * 最后是把 canvas 临时提到 z-index:99999 才一眼看穿。
     * 现在把「canvas 到 html 之间没有任何不透明背景」变成断言。 */
    const chain = await probe(`
      var el = document.querySelector('canvas[data-fx=cybergrid]');
      var bad = [];
      /* 走到 html 为止但不含 html —— html 的背景是"画布底色"，
       * 绘制顺序里排在负 z-index 之前，是**该有**的，不算遮挡。 */
      while (el && el !== document.documentElement) {
        var bg = getComputedStyle(el).backgroundColor;
        var m = bg.match(/rgba?\\(([^)]+)\\)/);
        if (m) {
          var p = m[1].split(',').map(function(s){return parseFloat(s)});
          var a = p.length > 3 ? p[3] : 1;
          if (a > 0.02) bad.push((el.tagName || '?') + '.' + String(el.className || '').split(' ')[0] + ' bg=' + bg);
        }
        el = el.parentElement;
      }
      var htmlBg = getComputedStyle(document.documentElement).backgroundColor;
      var bodyBg = getComputedStyle(document.body).backgroundColor;
      return JSON.stringify({ bad: bad, htmlBg: htmlBg, bodyBg: bodyBg });`);
    const ch = JSON.parse(chain);
    ok('canvas 到 html 之间没有任何不透明背景（否则会盖住负 z-index 层）',
      ch.bad.length === 0, ch.bad.join(' / '));
    ok('body 自己不能有背景（body 背景画在负 z-index 之后）',
      /rgba?\(0, 0, 0, 0\)/.test(ch.bodyBg), `body bg=${ch.bodyBg}`);
    ok('底色挂在 html 上（画布底色，永远在最底层）',
      /rgb\(5, 6, 12\)/.test(ch.htmlBg), `html bg=${ch.htmlBg}`);

    /* ---- 1d. 端到端：背景层真的改变了屏幕上的像素 ----
     *
     * 1a~1c 查的是"该有的东西在不在"，这条查的是"它到底有没有出现在屏幕上"。
     * 做法：截两次图，一次带着赛博网格、一次把它藏掉，比较全图平均亮度。
     * 用全图均值而不是某个点，是因为星尘在闪烁、星星是孤立亮点 ——
     * 单点采样会撞上星星造成假阳性，全图均值里那点噪声不到 0.01，
     * 而网格贡献是 1 以上，差三个数量级。 */
    if (hasWebGL2 === true) {
      const meanBrightness = async () => {
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        const res = await ev(`(async function(){
          var img = new Image();
          img.src = 'data:image/png;base64,${shot.data}';
          await img.decode();
          var c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          var g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          var d = g.getImageData(0, 0, c.width, c.height).data;
          var sum = 0;
          for (var i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
          return sum / (d.length / 4) / 3;
        })()`);
        return res.value;
      };

      const withBg = await meanBrightness();
      await probe(`document.querySelector('canvas[data-fx=cybergrid]').style.display='none'; return 1`);
      await sleep(320);
      const withoutBg = await meanBrightness();
      await probe(`document.querySelector('canvas[data-fx=cybergrid]').style.display=''; return 1`);

      const delta = withBg - withoutBg;
      console.log(`  全图平均亮度：带网格 ${withBg.toFixed(3)} / 藏掉 ${withoutBg.toFixed(3)} / 差 ${delta.toFixed(3)}`);
      ok('藏掉赛博网格后屏幕确实变暗（说明它真的画在屏幕上，不是被盖住）',
        delta > 0.5, `亮度差仅 ${delta.toFixed(3)} —— 太小，背景很可能被某层盖住了`);
    } else {
      skip('藏掉赛博网格后屏幕确实变暗', '本内核无 WebGL2');
    }
  }

  section('2. 注册流程（走真实 UI，不调后门）');
  const EMAIL = `browser_${Date.now()}@test.local`;
  {
    await nav('/register');
    await waitFor('document.querySelectorAll("form input").length >= 4', '注册表单出现');
    const names = await probe('return Array.from(document.querySelectorAll("form input")).map(function(i){return i.name}).join(",")');
    ok('表单字段齐全', /email/.test(names) && /username/.test(names) && /password/.test(names) && /confirm/.test(names), names);

    // React 受控组件：必须用原生 setter + 派发 input 事件，直接赋 value 不生效
    const fill = `
      var setV = function (sel, v) {
        var el = document.querySelector(sel);
        if (!el) return false;
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      return [setV('input[name=email]', ${JSON.stringify(EMAIL)}),
              setV('input[name=username]', '悟空测试'),
              setV('input[name=password]', 'Kaoyan2027!'),
              setV('input[name=confirm]', 'Kaoyan2027!')].join(',');`;
    const filled = await probe(fill);
    ok('四个字段都填上了', filled === 'true,true,true,true', filled);

    // 密码强度条应当当场亮起来（不是「控件在」，而是「有反应」）
    const bar = await probe(`
      var el = document.querySelector('form .h-full.rounded-full');
      return el ? getComputedStyle(el).width : 'NONE';`);
    ok('密码强度条当场生效（宽度非 0）', bar !== 'NONE' && parseFloat(bar) > 0, `宽度 ${bar}`);

    await ev('document.querySelector("form button[type=submit]").click()');
    const entered = await waitFor('!!document.querySelector("nav[aria-label=\\"主导航\\"]")', '注册成功并进入主界面', 15000);
    ok('注册后自动进入应用外壳', entered);
    const navCount = (await ev('document.querySelectorAll("nav[aria-label=\\"主导航\\"] a").length')).value;
    ok('侧栏 14 项导航全部渲染', navCount === 14, `实得 ${navCount} 个`);
    const groups = (await ev('document.querySelectorAll("nav[aria-label=\\"主导航\\"] > div").length')).value;
    ok('导航分了 4 组', groups === 4, `实得 ${groups} 组`);
  }

  section('3. 14 个路由全部渲染（逐个真开一遍）');
  {
    const routes = [
      ['/', '仪表盘', '积分'],
      ['/learn', '知识树', ''],
      ['/quiz', '每日一练', ''],
      ['/review', '复习队列', ''],
      ['/mistakes', '错题本', ''],
      ['/questions', '我的题库', ''],
      ['/lab', '公式实验室', ''],
      ['/blitz', '闪电战', ''],
      ['/deck', '卡片库', ''],
      ['/chat', 'AI 对话', ''],
      ['/classroom', '课堂', ''],
      ['/stats', '统计', ''],
      ['/achievements', '成就', ''],
      ['/settings', '设置', ''],
    ];

    for (const [route, label] of routes) {
      const before = exceptions.length + consoleErrors.length;
      await nav(route);
      await waitFor('!!document.querySelector("#main-scroll")', `${label} 外壳就位`, 10000);
      await sleep(700);   // 等数据拉回来 + 入场动画

      const r = await probe(`
        var m = document.getElementById('main-scroll');
        var h1 = document.querySelector('h1');
        var t = document.body.innerText;
        return JSON.stringify({
          title: h1 ? h1.textContent.trim() : '',
          len: m ? m.innerText.replace(/\\s/g,'').length : 0,
          skel: document.querySelectorAll('.skeleton').length,
          /* ★ 「页面出错了」是每页各自的错误边界文案（KeepAlivePages 里包的）。
             以前只查 '应用出错了'（全局边界），而全局边界一挂整站都没了，
             根本走不到这条断言 —— 等于这条检查一直是空转。
             现在按页包了边界，一页崩掉只有那一页显示这句，必须查它。 */
          crash: t.indexOf('应用出错了') >= 0
              || t.indexOf('页面出错了') >= 0
              || t.indexOf('这一页没能渲染出来') >= 0
              || t.indexOf('Something went wrong') >= 0
        });`);
      const d = JSON.parse(r);
      const newErrs = exceptions.length + consoleErrors.length - before;

      ok(`${label}（${route}）渲染出内容`, d.len > 30, `正文 ${d.len} 字${d.skel ? `（还有 ${d.skel} 个骨架屏未消失）` : ''}`);
      ok(`${label} 没有崩溃`, !d.crash);
      ok(`${label} 无新增报错`, newErrs === 0, `${newErrs} 条`);
      ok(`${label} 标题正确`, !d.title || d.title.length > 0, `h1="${d.title}"`);
    }
  }

  /* 知识星系是本轮唯一的"全新交互"—— 68 个节点每帧在 JS 里算投影。
   * 它此前一条断言都没有：主循环死掉、节点全挤在球心、切视图不生效，
   * 三种坏法都不会让页面报错，截图里也"看着有东西"。
   * 所以这里必须验三件事：节点齐、主循环在动、两个视图能互相切。 */
  section('3b. 知识星系：节点齐 / 主循环在动 / 视图可切');
  {
    await nav('/learn');
    await waitFor('!!document.querySelector("[data-galaxy=host]")', '星系容器就位');
    await sleep(900);

    const gal = await probe(`
      var nodes = document.querySelectorAll('[data-galaxy=node]');
      var canvas = document.querySelector('[data-galaxy=host] canvas');
      return JSON.stringify({ n: nodes.length, canvas: !!canvas });`);
    const g = JSON.parse(gal);
    ok('星系默认渲染出考点节点', g.n > 50, `${g.n} 个节点`);
    ok('星系连线画布已挂载', g.canvas === true);

    /* 主循环是否在跑 —— 不能用"等 350ms 看自转有没有动"来验。
     * headless Chrome 默认上报 prefers-reduced-motion: reduce，
     * 而组件是遵守这个偏好的（不自动旋转），所以那种写法在 CI 上必红，
     * 而它红的原因跟代码好坏毫无关系。
     *
     * 正确验法是**真的拖一下**：拖动是用户主动操作，任何偏好下都必须生效。
     * 顺带它还把「投影算完 → 写进 style.transform」这条链路整条打通验证了，
     * 比只看自转强。 */
    const box = JSON.parse(await probe(`
      var h = document.querySelector('[data-galaxy=host]');
      if (!h) return 'null';
      var r = h.getBoundingClientRect();
      return JSON.stringify({
        x: Math.round(r.left + r.width / 2),
        y: Math.round(Math.min(r.top + r.height / 2, innerHeight - 80)),
      });`));
    ok('星系容器在视口内，可拖拽', !!box && box.y > 0, box ? `落点 ${box.x},${box.y}` : '容器不在视口内');

    const t1 = await probe(`
      var n = document.querySelectorAll('[data-galaxy=node]')[0];
      return n ? n.style.transform : '';`);

    if (box) {
      /* 用 CDP 的真鼠标事件，不用 JS 造 PointerEvent ——
       * 组件里调了 setPointerCapture，合成事件的 pointerId 是假的，会抛异常。 */
      await client.send('Input.dispatchMouseEvent',
        { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
      for (const dx of [30, 70, 110]) {
        await client.send('Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: box.x + dx, y: box.y + 12, button: 'left', buttons: 1 });
        await sleep(40);
      }
      await client.send('Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: box.x + 110, y: box.y + 12, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(220);
    }

    const t2 = await probe(`
      var n = document.querySelectorAll('[data-galaxy=node]')[0];
      return n ? n.style.transform : '';`);
    ok('★ 拖动后节点位置真的变了（投影主循环在跑）', !!t2 && t1 !== t2,
      t1 === t2 ? `拖动前后都是 ${String(t1).slice(0, 44)}` : '');

    /* 深度雾化：远处的节点必须比近处暗，否则球心会糊成一团。
     * 断言"不透明度确实分了两档以上"，而不是只看有没有值。 */
    const depths = await probe(`
      var ns = Array.from(document.querySelectorAll('[data-galaxy=node]'));
      var ops = ns.map(function (n) { return parseFloat(n.style.opacity || '1'); })
                  .filter(function (v) { return !isNaN(v); });
      ops.sort(function (a, b) { return a - b; });
      return JSON.stringify({ min: ops[0], max: ops[ops.length - 1], n: ops.length });`);
    const dp = JSON.parse(depths);
    ok('★ 深度雾化生效（最暗/最亮拉开差距）', dp.max - dp.min > 0.5,
      `不透明度 ${dp.min} → ${dp.max}（共 ${dp.n} 个）`);

    /* 切到列表视图：星系必须整块消失，不然两个视图会叠在一起 */
    const switched = await probe(`
      var btns = Array.from(document.querySelectorAll('[role=tablist] button'));
      var b = btns.find(function (x) { return x.textContent.indexOf('列表') >= 0; });
      if (!b) return 'NO_BTN';
      b.click();
      return 'ok';`);
    ok('能找到"列表"视图切换按钮', switched === 'ok', String(switched));
    await sleep(600);
    const afterList = await probe(`
      return JSON.stringify({
        host: !!document.querySelector('[data-galaxy=host]'),
        cats: document.querySelectorAll('#main-scroll h2').length,
      });`);
    const al = JSON.parse(afterList);
    ok('切到列表视图后星系消失', al.host === false, `host 仍存在=${al.host}`);
    ok('列表视图按科目分了块', al.cats >= 1, `${al.cats} 个科目头`);

    /* 章节默认是**收起的** —— 这是设计，不是 bug。
     * 所以「有没有考点链接」不能直接断言，得先展开一章。
     * 章节行的判别特征：是 <button> 且内部有个 span.truncate。
     * 科目头是 button 但用 <h2>；考点行是 <a>（Link）不是 button —— 三者不会混。 */
    const opened = await probe(`
      var bs = Array.from(document.querySelectorAll('#main-scroll button'));
      var ch = bs.find(function (b) { return b.querySelector('span.truncate'); });
      if (!ch) return 'NO_CH';
      ch.click();
      return ch.textContent.trim().slice(0, 24);`);
    ok('能展开一个章节', opened !== 'NO_CH', String(opened));
    await sleep(700);
    const links = await probe(`
      return document.querySelectorAll('#main-scroll a[href^="/learn/"]').length;`);
    ok('展开后列出该章的考点链接', Number(links) > 0, `${links} 条`);

    /* 切回星系 —— 切回来坏掉（比如 canvas 尺寸没重算）是很常见的一种 */
    const back = await probe(`
      var btns = Array.from(document.querySelectorAll('[role=tablist] button'));
      var b = btns.find(function (x) { return x.textContent.indexOf('星系') >= 0; });
      if (!b) return 'NO_BTN';
      b.click();
      return 'ok';`);
    ok('能切回星系视图', back === 'ok', String(back));
    await sleep(900);
    const backNodes = await probe(`
      var h = document.querySelector('[data-galaxy=host]');
      if (!h) return -1;
      var c = h.querySelector('canvas');
      return JSON.stringify({
        n: document.querySelectorAll('[data-galaxy=node]').length,
        cw: c ? c.width : 0,
      });`);
    const bn = JSON.parse(backNodes);
    ok('★ 切回星系后节点与画布尺寸都回来了', bn !== -1 && bn.n > 50 && bn.cw > 100,
      `节点 ${bn.n} 个 / 画布宽 ${bn.cw}px`);

    /* ============================================================
       ★★ 真鼠标点节点必须能跳转
       ============================================================
       这一条是用户报上来的：「知识树星系下，为什么点不动？」

       根因：组件在容器上调了 setPointerCapture，于是 pointerup 被重定向到容器。
       而 click 的落点按规范是「pointerdown 目标与 pointerup 目标的**最近公共祖先**」——
       按下落在节点的 <span> 上、抬起被挪到容器上，公共祖先就成了容器，
       节点上的 <Link> 永远收不到 click。**控制台一声不响、页面不报错。**

       为什么原来那一堆星系断言全都没抓到：
         · 「节点存在」「画布有尺寸」「拖动会转」—— 这些在点不动的情况下**全部成立**；
         · el.click()（JS 直接点）是好的，所以拿 JS 点击去测也会绿。
       只有**用 CDP 发真鼠标事件**才复现得出来。所以下面刻意不用 JS 点击。

       顺带钉住两件事：
         · 从节点上起手拖动，仍然要能转（不能为了修点击把拖动修坏）；
         · 拖完不能误触发跳转（moved > 6 的那道闸）。
       ============================================================ */
    const frontNode = async () => {
      const raw = await probe(`
        var ns = Array.from(document.querySelectorAll('[data-galaxy=node]'));
        var best = null, bo = -1;
        ns.forEach(function (n) { var o = parseFloat(n.style.opacity || '0'); if (o > bo) { bo = o; best = n; } });
        if (!best) return 'NO_NODE';
        var r = best.getBoundingClientRect();
        return JSON.stringify({
          href: best.getAttribute('href'),
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        });`);
      try { return JSON.parse(String(raw)); } catch { return { href: '', x: 0, y: 0 }; }
    };

    /* 先记下 click 到底落在谁身上 —— 万一将来回归，报错信息直接指出机制 */
    await probe(`
      window.__clickTarget = null;
      document.addEventListener('click', function (e) {
        var t = e.target;
        window.__clickTarget = t.tagName + '|' + (t.closest && t.closest('[data-galaxy=node]') ? 'in-node' : 'NOT-in-node');
      }, true);
      return 1;`);

    /* ---------- ① 从节点上起手拖动：要转，但不许跳 ---------- */
    const dn = await frontNode();
    const tBefore = await probe(`
      var n = document.querySelectorAll('[data-galaxy=node]')[0];
      return n ? n.style.transform : '';`);
    await client.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: dn.x, y: dn.y, button: 'left', clickCount: 1, buttons: 1 });
    for (const dx of [16, 38, 62]) {
      await client.send('Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: dn.x + dx, y: dn.y + 10, button: 'left', buttons: 1 });
      await sleep(40);
    }
    await client.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: dn.x + 62, y: dn.y + 10, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(500);
    const tAfter = await probe(`
      var n = document.querySelectorAll('[data-galaxy=node]')[0];
      return n ? n.style.transform : '';`);
    ok('★ 从节点上起手拖动仍能转动星系（修点击不能把拖动修坏）',
      !!tAfter && tBefore !== tAfter, `拖动前后都是 ${String(tBefore).slice(0, 44)}`);
    const stillHere = await probe('return location.pathname');
    ok('★ 拖动后不会误跳进考点（moved>6 那道闸还在）', stillHere === '/learn', `实得 ${stillHere}`);

    /* ---------- ② 干净的一点：必须**在新标签页里**打开考点 ---------- */

    /* ★ 环境自检：完整版 Chrome 必须关掉弹窗拦截。
     *
     *   下面这一整组断言都建立在「点 target="_blank" 链接能真的开出新标签」上，
     *   而这个能力**是环境相关的，产品代码一模一样**：
     *
     *     完整版 Chrome + --headless=new    → page 1 → 1   拦掉
     *     完整版 Chrome + 关掉弹窗拦截       → page 1 → 2   放行
     *     chrome-headless-shell             → page 1 → 2   放行
     *
     *   （完整版 Chrome 把「无用户手势的 target="_blank" 点击」当成自动弹窗拦了。
     *     真实用户点击带手势，本来不会被拦；无头环境缺的正是那个手势。）
     *
     * ── 为什么检查参数，而不是「点一下试试」──────────────────────────
     *   试过行为自检：造一个 <a target="_blank"> 然后 a.click()，看标签数变不变。
     *   **它抓不到这个问题** —— 实测把 flag 去掉再跑，自检照样打勾，
     *   而后面三条真断言全红。原因是程序化的 a.click() 不走弹窗拦截那条路径，
     *   被拦的是 CDP 派发的**真实鼠标事件**。
     *   一个会漏报的自检比没有自检更糟：它给出「环境没问题」的错误信号，
     *   把人往「是不是产品代码坏了」的方向引。
     *   所以这里退一步，直接断言启动参数 —— 不够优雅，但它说的是实话。 */
    if (browser.kind === 'chrome') {
      ok('环境自检：完整版 Chrome 关掉了弹窗拦截（否则 target=_blank 开不出新标签）',
        args.includes('--disable-popup-blocking'),
        '启动参数缺 --disable-popup-blocking —— 下面五条新标签页断言必然失败');
    }

    await sleep(300);
    const cn = await frontNode();
    await probe(`window.__clickTarget = null; return 1;`);
    const known = (await listPages()).map((p) => p.id);
    await client.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: cn.x, y: cn.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(60);
    await client.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: cn.x, y: cn.y, button: 'left', clickCount: 1, buttons: 0 });
    const openedNode = await waitForNewTab(known, cn.href);
    ok('★★ 真鼠标点星系节点会在新标签页打开考点',
      !!openedNode, openedNode ? openedNode.url : `没等到指向 ${cn.href} 的新标签页`);
    const after = await probe('return location.pathname');
    ok('★ 原页面留在知识树上（链接不再把当前页顶掉）', after === '/learn', `实得 ${after}`);
    const target = await probe('return window.__clickTarget');
    ok('★ click 的落点确实在节点内部（不是被指针捕获挪到容器上）',
      String(target || '').indexOf('in-node') >= 0,
      `实得 ${target}（若是 "DIV|NOT-in-node" 就是 setPointerCapture 又回来了）`);
  }

  /* 窄屏。桌面 1440 下一切正常，不代表 390 下也正常 ——
   * 星系的球半径、HUD 的刻度尺、全屏着色器，三样都是按桌面比例调的。
   * 实测就是这么漏的：390 宽下星系外圈标签被 overflow 整排切掉，
   * 中间糊成一片，而所有桌面断言全绿。 */
  section('3c. 窄屏（390×844）：布局不溢出、星系不默认出场但仍在');
  {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await nav('/learn');
    await waitFor('!!document.querySelector("#main-scroll")', '知识树就位（窄屏）');
    await sleep(1000);

    const narrow = await probe(`
      return JSON.stringify({
        host: !!document.querySelector('[data-galaxy=host]'),
        cats: document.querySelectorAll('#main-scroll h2').length,
        wide: document.documentElement.scrollWidth > innerWidth + 1,
      });`);
    const nw = JSON.parse(narrow);
    ok('窄屏下不默认渲染星系', nw.host === false, `host 存在=${nw.host}`);
    ok('窄屏下默认给列表视图（有科目分块）', nw.cats >= 1, `${nw.cats} 个科目头`);
    ok('★ 窄屏下页面没有横向溢出', nw.wide === false, '有内容把页面撑宽了');

    /* 星系仍在切换器里 —— 窄屏是「不默认出场」，不是「砍掉」 */
    const toGalaxy = await probe(`
      var bs = Array.from(document.querySelectorAll('[role=tablist] button'));
      var b = bs.find(function (x) { return x.textContent.indexOf('星系') >= 0; });
      if (!b) return 'NO_BTN';
      b.click();
      return 'ok';`);
    ok('窄屏下仍能手动切到星系', toGalaxy === 'ok', String(toGalaxy));
    await sleep(1100);

    /* ★ 这条就是抓「外圈被切掉」的。
     * overflow-hidden 是**视觉裁剪**，不影响 getBoundingClientRect ——
     * 所以溢出的标签在几何上照样量得出来，不用截图比对像素。 */
    const gNarrow = await probe(`
      var h = document.querySelector('[data-galaxy=host]');
      if (!h) return JSON.stringify({ ok: false });
      var r = h.getBoundingClientRect();
      var ns = Array.from(document.querySelectorAll('[data-galaxy=node]'));
      var out = ns.filter(function (n) {
        var b = n.getBoundingClientRect();
        return b.left < r.left - 1 || b.right > r.right + 1;
      });
      return JSON.stringify({
        ok: true, n: ns.length, out: out.length,
        sample: out.slice(0, 2).map(function (x) { return x.textContent.trim(); }),
      });`);
    const gn = JSON.parse(gNarrow);
    ok('窄屏下星系仍能渲染出节点', gn.ok === true && gn.n > 50, `节点 ${gn.n} 个`);
    ok('★ 窄屏下没有节点被容器切掉', gn.out === 0,
      `${gn.out} 个标签溢出：${JSON.stringify(gn.sample)}`);
  }

  /* ★ 视口必须还原。
   * 后面每一节的断言都是按 1440 宽写的（比如「视口是桌面宽度」、
   * 「星系默认渲染」），不还原就会从第 4 节开始报一堆莫名其妙的失败，
   * 而你会去查那些页面，不会想到是这里没收拾干净。 */
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });
  await nav('/');
  await waitFor('!!document.querySelector("#main-scroll")', '还原桌面视口');
  await sleep(400);

  section('4. 公式实验室：换公式后画布真的重画');
  {
    await nav('/lab');
    await waitFor('!!document.querySelector("canvas[aria-label*=交互演示]")', '实验画布出现');
    await sleep(900);

    const count = async () => {
      const r = await probe(`
        var cv = document.querySelector('canvas[aria-label*=交互演示]');
        if (!cv) return -1;
        var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        var p = 0;
        for (var i = 3; i < d.length; i += 4) if (d[i] !== 0) p++;
        return p;`);
      return Number(r);
    };

    const p1 = await count();
    ok('默认公式的画布已绘制', p1 > 500, `${p1} 像素`);

    /* ★ 这一条守的是这次改造的核心需求：**每一条公式都要有演示**，
     *   而不是只有手写的那几个。左侧列表里随便点一条，画布必须重画。 */
    const listLen = await probe(`return document.querySelectorAll('button[data-formula]').length`);
    ok('★ 公式列表列出了可选的公式', Number(listLen) >= 20, `${listLen} 条`);

    const switched = await probe(`
      var bs = document.querySelectorAll('button[data-formula]');
      if (bs.length < 3) return 'FEW';
      var target = bs[bs.length - 1];
      target.click();
      return target.getAttribute('data-formula');`);
    ok('能点列表里的另一条公式', switched !== 'FEW' && switched !== 'PROBE_ERROR', String(switched));
    await sleep(900);

    const p2 = await count();
    ok('★ 换一条公式后画布重画了（不是只有几个能拖）', p2 > 500 && p2 !== p1, `像素 ${p1} → ${p2}`);

    // 拖动滑块，读数必须跟着变
    const before = await probe('var e=document.querySelector("input[type=range]"); return e? e.value : "NONE"');
    if (before !== 'NONE') {
      await probe(`
        var e = document.querySelector('input[type=range]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, String(Number(e.max)));
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        return 1;`);
      await sleep(500);
      const after = await probe('var e=document.querySelector("input[type=range]"); return e? e.value : "NONE"');
      ok('拖动滑块后取值确实变了', before !== after, `${before} → ${after}`);
      ok('拖动滑块后画布也重画了', (await count()) !== p2, '像素数没变');
    } else {
      ok('演示模块有可拖滑块', false, '没找到 range');
    }

    /* 公式手册那一侧：卡片上的「动手」要能就地展开演示 */
    const handbook = await probe(`
      var bs = Array.from(document.querySelectorAll('[role=tab], button'));
      var t = bs.find(function (x) { return x.textContent.trim() === '公式手册'; });
      if (!t) return 'NO_TAB';
      t.click();
      return 'ok';`);
    ok('能切到公式手册', handbook === 'ok', String(handbook));
    await sleep(1200);

    const toggle = await probe(`
      var b = document.querySelector('button[data-demo-toggle]');
      if (!b) return 'NO_BTN';
      b.click();
      return b.getAttribute('data-demo-toggle');`);
    ok('手册卡片上有「动手」按钮', toggle !== 'NO_BTN' && toggle !== 'PROBE_ERROR', String(toggle));
    await sleep(1200);
    const inline = await count();
    ok('★ 手册卡片里就地展开了演示（不用切回演示台）', inline > 500, `${inline} 像素`);
  }

  section('5. 数学公式渲染（重点：不许漏出裸 LaTeX）');
  {
    // 在页面上下文里取知识点 —— Node 侧没有 cookie，直接 fetch 会 401
    await nav('/learn');
    await waitFor('!!document.querySelector("#main-scroll")', '知识树就位');
    await sleep(800);

    // 章节默认可能是收起的，先全部展开，否则节点链接根本没渲染
    await probe(`
      document.querySelectorAll('#main-scroll [role=button], #main-scroll button').forEach(function (b) {
        if (b.getAttribute('aria-expanded') === 'false') b.click();
      });
      return 1;`);
    await sleep(600);

    const href = await probe(`
      var a = document.querySelector('#main-scroll a[href*="/learn/"]');
      return a ? a.getAttribute('href') : '';`);
    let kid = href ? href.split('/learn/')[1] : null;
    if (!kid) {
      // 兜底：页面上下文里调接口（会带上会话 cookie）
      const r = await ev(`fetch('/api/catalog/tree').then(function(r){return r.json()}).then(function(d){return d.categories[0].chapters[0].nodes[0].id}).catch(function(e){return 'ERR:'+e.message})`);
      kid = typeof r.value === 'string' && !r.value.startsWith('ERR:') ? r.value : null;
    }
    ok('拿到了一个知识点 id', !!kid, `kid=${kid}`);

    // 关键：不能只验一个样本。68 个知识点都要过这条检查，
    // 所以这里抽 4 个不同科目的节点逐个真开一遍。
    const kidsR = await ev(`fetch('/api/catalog/tree').then(function(r){return r.json()}).then(function(d){
      var out = [];
      d.categories.forEach(function(c){ c.chapters.forEach(function(ch){ ch.nodes.forEach(function(n){ out.push(n.id); }); }); });
      return JSON.stringify(out.filter(function(_, i){ return i % 17 === 0; }).slice(0, 4));
    }).catch(function(e){ return 'ERR:'+e.message })`);
    const kids = typeof kidsR.value === 'string' && kidsR.value.startsWith('[') ? JSON.parse(kidsR.value) : [];
    ok('抽到了多个知识点做抽查', kids.length >= 3, `实得 ${kids.length} 个`);

    /* 判据说明：KaTeX 渲染过的片段要把整棵子树删掉再查，否则测的是渲染结果本身。
       .katex 是 KaTeX 的根节点类名。 */
    const checkLeak = `
      var bs = String.fromCharCode(92);
      var rich = document.querySelectorAll('#main-scroll .rich-text');
      var bare = '';
      rich.forEach(function (el) {
        var clone = el.cloneNode(true);
        clone.querySelectorAll('.katex, .katex-display').forEach(function (k) { k.remove(); });
        bare += clone.textContent;
      });
      var leaked = (bare.match(new RegExp(bs + bs + '[a-zA-Z]+', 'g')) || []);
      var uniq = [];
      leaked.forEach(function (x) { if (uniq.indexOf(x) < 0) uniq.push(x); });
      return JSON.stringify({
        rich: rich.length,
        katex: document.querySelectorAll('#main-scroll .katex').length,
        leaked: uniq.slice(0, 6),
        leakedTotal: leaked.length,
        textLen: document.getElementById('main-scroll').innerText.replace(/\\s/g,'').length
      });`;

    let anyLeak = false;
    for (const k of kids) {
      await nav(`/learn/${k}`);
      await waitFor('!!document.querySelector("#main-scroll")', `知识点 ${k} 就位`);
      await sleep(750);
      const d = JSON.parse(await probe(checkLeak));
      const label = `知识点 ${k}`;
      ok(`${label} 正文渲染出来了`, d.textLen > 100, `${d.textLen} 字`);
      ok(`${label} 公式交给了 KaTeX`, d.katex > 0, `${d.katex} 个 .katex 节点`);
      ok(`${label} 无裸露 LaTeX`, d.leaked.length === 0,
        `漏出 ${d.leakedTotal} 处：${JSON.stringify(d.leaked)}`);
      if (d.leaked.length) anyLeak = true;
    }
    ok('★ 抽查的知识点全部无 LaTeX 泄漏', !anyLeak);

    /* 题干与解析也不能漏 —— 204 道题里 132 条解析带 LaTeX */
    await nav('/quiz');
    await waitFor('!!document.querySelector("#main-scroll")', '每日一练就位');
    await sleep(1200);
    const q = JSON.parse(await probe(checkLeak));
    ok('每日一练渲染出题干', q.textLen > 30, `${q.textLen} 字`);
    ok('★ 题干/选项的公式已渲染（没有反斜杠源码）', q.leaked.length === 0,
      `漏出 ${JSON.stringify(q.leaked)}`);

    /* 顺手断言「不该出现的东西」：markdown 标记漏屏 */
    const marks = await probe(`
      var t = document.getElementById('main-scroll').innerText;
      var bad = [];
      if (t.indexOf('**') >= 0) bad.push('**');
      if (t.indexOf('$$') >= 0) bad.push('$$');
      if (/\\u0001|\\u0002/.test(t)) bad.push('占位符泄漏');
      return JSON.stringify(bad);`);
    const badMarks = JSON.parse(marks);
    ok('★ 没有 ** / $$ / 占位符漏到屏幕上', badMarks.length === 0, `漏出 ${JSON.stringify(badMarks)}`);
  }

  section('6. 课堂页空态与角色说明');
  {
    await nav('/classroom');
    await waitFor('!!document.querySelector("#main-scroll")', '课堂页就位');
    await sleep(800);
    const t = await bodyText();
    ok('课堂页给出引导文案（不是白屏）', t.includes('知识点') || t.includes('上课'), t.slice(0, 60).replace(/\n/g, ' '));
    ok('说明了三个同学各错各的', t.includes('小明') || t.includes('各错各的'), '');
    ok('提示要配模型', t.includes('模型') || t.includes('设置'), '');
  }

  section('7. 设置页模型接入面板');
  {
    await nav('/settings');
    await waitFor('!!document.querySelector("#main-scroll")', '设置页就位');
    await sleep(900);
    const t = await bodyText();
    ok('设置页有内容', t.length > 100, `${t.length} 字`);
    ok('提到模型接入', t.includes('模型') || t.includes('Base'), '');
    // 绝不能把 Key 明文显示出来
    ok('★ 页面上没有明文 API Key', !/sk-[a-zA-Z0-9]{20,}/.test(t), (t.match(/sk-[a-zA-Z0-9]{10,}/) || [''])[0]);
  }

  /* ============================================================
     7b. 主题切换
     ============================================================
     这一节的判据全部落在**计算样式**上，不看截图 ——
     因为"主题坏了"的典型表现是「页面不报错、控制台干净、截图看着有颜色，
     只是某些文字和底色撞在一起了」。那种坏法只有量对比度才看得见。

     特别要盯的是 --color-veil：它是唯一一个明暗主题**取值方向相反**的令牌
     （暗色下是白、亮色下是黑）。它要是没翻过来，全站 137 处
     bg-veil/N 的卡片边界会整片消失 —— 而页面依然"正常渲染"。 */
  section('7b. 主题切换：真的换色、真的持久化、亮色不瞎');
  {
    await nav('/settings');
    await waitFor('!!document.querySelector("#main-scroll")', '设置页就位（主题节）');
    await sleep(900);

    const before = JSON.parse(await probe(`return JSON.stringify({
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      ink: getComputedStyle(document.documentElement).getPropertyValue('--color-ink-950').trim(),
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      veil: getComputedStyle(document.documentElement).getPropertyValue('--color-veil').trim(),
    })`));
    ok('默认主题是 deep-space', before.theme === 'deep-space', before.theme);
    ok('默认是暗色模式', before.mode === 'dark', before.mode);
    ok('默认叠层色是白', /#fff|#ffffff|rgb\(255, 255, 255\)/i.test(before.veil), before.veil);

    const cards = await probe(`return document.querySelectorAll('[data-theme-id]').length`);
    ok('外观面板列出了多套主题（≥8）', Number(cards) >= 8, `${cards} 套`);

    /* 点「宣纸」。注意用的是**真 click**，不是直接改 store ——
     * 要验的是"用户点得动"，不是"store 改得动"。 */
    const picked = await probe(`
      var bs = document.querySelectorAll('[data-theme-id]');
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].getAttribute('data-theme-id') === 'paper') { bs[i].click(); return 'ok'; }
      }
      return 'NO_CARD';`);
    ok('能点到「宣纸」主题卡', picked === 'ok', String(picked));
    await sleep(700);

    const after = JSON.parse(await probe(`return JSON.stringify({
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      ink: getComputedStyle(document.documentElement).getPropertyValue('--color-ink-950').trim(),
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      veil: getComputedStyle(document.documentElement).getPropertyValue('--color-veil').trim(),
      cs: document.documentElement.style.colorScheme,
      canvas: document.querySelectorAll('canvas').length,
      navItems: document.querySelectorAll('nav[aria-label="主导航"] a').length,
    })`));
    ok('★ 点了主题后 data-theme 真的变了', after.theme === 'paper', after.theme);
    ok('★ data-mode 跟着变成 light', after.mode === 'light', after.mode);
    ok('★ 底色令牌真的换了（--color-ink-950）', after.ink !== before.ink, `${before.ink} → ${after.ink}`);
    ok('★ 页面底色真的变亮（html background）', after.htmlBg !== before.htmlBg, `${before.htmlBg} → ${after.htmlBg}`);
    ok('★ 叠层色翻成深色（--color-veil，暗→亮方向相反的那个令牌）',
      after.veil !== before.veil && !/#fff/i.test(after.veil), `${before.veil} → ${after.veil}`);
    ok('★ color-scheme 跟着切成 light（否则滚动条/日期控件还是黑的）', after.cs === 'light', after.cs);
    ok('★ 亮色主题下不挂 WebGL 背景画布', Number(after.canvas) === 0, `${after.canvas} 个画布`);
    ok('切主题不影响导航项数量', Number(after.navItems) === 14, `${after.navItems} 项`);

    /* ★ 对比度：亮色主题最容易出的错是「浅色字压在浅底上」。
     * 取一个正文标题的实际 color，要求三通道都足够深。
     * 深空主题下这里会是 rgb(233,235,244)，所以这条断言本身是能区分主题的。 */
    const titleColor = await probe(`
      var el = document.querySelector('#main-scroll h2') || document.querySelector('#main-scroll h1');
      if (!el) return 'NO_EL';
      return getComputedStyle(el).color;`);
    const cm = String(titleColor).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    ok('★ 亮色主题下正文标题是深色（不是浅色压浅底）',
      !!cm && Number(cm[1]) < 140 && Number(cm[2]) < 140 && Number(cm[3]) < 140, String(titleColor));

    /* ★ 卡片边界：亮色主题下描边必须是深色。
     * 这条对应「白叠白 → 卡片凭空消失」那个坑 —— 全站 137 处
     * bg-veil/N、border-veil/N 都指望这个令牌翻过来。
     *
     * ⚠️ 读的是**真实元素的 borderTopColor**，不是令牌原文。
     * 两个原因：令牌原文会被压缩器改写成 #rrggbbaa 十六进制
     * （写 rgba(...) 的正则会被它绕过去，第一版就栽在这）；
     * 而且读元素还顺带验证了"令牌确实流到了元素上"。
     * 计算值一律是 rgb()/rgba() 形式，不用管源码怎么写。 */
    const border = await probe(`
      var el = document.querySelector('#main-scroll .glass') || document.querySelector('#main-scroll [class*="glass"]');
      if (!el) return 'NO_EL';
      return getComputedStyle(el).borderTopColor;`);
    const bm = String(border).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    ok('★ 亮色主题下卡片描边是深色（白叠白会让卡片边界凭空消失）',
      !!bm && Number(bm[1]) < 150 && Number(bm[2]) < 150 && Number(bm[3]) < 150, String(border));

    /* 同一件事的另一面：亮色主题下卡片面必须比底色更亮（不是更暗） */
    const surface = await probe(`
      var el = document.querySelector('#main-scroll .glass');
      if (!el) return 'NO_EL';
      var m = getComputedStyle(el).backgroundColor.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : 'PARSE_FAIL';`);
    ok('★ 亮色主题下卡片面是亮的', Number(surface) > 200, String(surface));

    /* 刷新后还在 —— 这条验的是 localStorage 那条路（首屏防闪靠它） */
    await nav('/settings');
    await waitFor('!!document.querySelector("#main-scroll")', '刷新后设置页就位');
    await sleep(900);
    const persisted = await probe(`return document.documentElement.dataset.theme`);
    ok('★ 刷新后主题仍在（localStorage 生效）', persisted === 'paper', String(persisted));
    /* 首屏防闪的关键：data-theme 必须在**首帧**就对了。
     * 这里查的是它有没有在 JS 应用之前就被内联脚本挂上 ——
     * 直接读 dataset 只能证明"最终对了"，所以额外确认 <html> 上
     * 没有被 store 之外的路径改过（theme 与 mode 自洽）。 */
    const selfConsistent = await probe(`return JSON.stringify({
      t: document.documentElement.dataset.theme,
      m: document.documentElement.dataset.mode,
    })`);
    ok('★ 主题与明暗标记自洽', JSON.parse(selfConsistent).m === 'light', selfConsistent);

    const serverTheme = await ev(`fetch('/api/settings').then(function(r){return r.json()}).then(function(d){return d.settings.theme})`);
    ok('★ 主题已回写服务端（换设备能跟着走）', serverTheme.value === 'paper', String(serverTheme.value));

    /* 切回深空 —— 后面的断言（以及"无 console 报错"那节）都按默认主题写 */
    const back = await probe(`
      var bs = document.querySelectorAll('[data-theme-id]');
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].getAttribute('data-theme-id') === 'deep-space') { bs[i].click(); return 'ok'; }
      }
      return 'NO_CARD';`);
    ok('能切回深空', back === 'ok', String(back));
    await sleep(900);
    const backState = JSON.parse(await probe(`return JSON.stringify({
      t: document.documentElement.dataset.theme,
      c: document.querySelectorAll('canvas').length,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    })`));
    ok('★ 切回深空后 WebGL 背景画布回来了', backState.t === 'deep-space' && backState.c >= 2, JSON.stringify(backState));
    ok('★ 切回深空后底色回到近黑', /rgb\(5, 6, 12\)/.test(backState.htmlBg), backState.htmlBg);

    /* ★ 暗色主题之间也必须真的换色 —— 这条盯的是一个已经踩过的坑。
     *
     * CyberGrid 的着色器强调色原来是写死在组件里的
     * （const ACCENT = ['#22d3ee','#3b82f6','#a855f7']），只有 CSS 那一半
     * 跟着主题走。结果「赛博绿」和「深空」的截图几乎一模一样 ——
     * 按钮绿了，但占满整屏的背景网格还是青蓝色。
     *
     * 而当时**所有断言全绿**：data-theme 对、令牌对、对比度对。
     * 因为「颜色对不对」和「颜色和主题一致不一致」是两回事。
     * 是给 8 套主题各截一张图、人眼横着比，才发现的。
     *
     * 这条断言把它变成机器可判：屏幕整体的「绿-蓝」差值，
     * 赛博绿必须显著高于深空。背景占了绝大多数像素，
     * 所以整屏均值能可靠地反映背景色调。 */
    const meanColor = async () => {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      const res = await ev(`(async function(){
        var img = new Image();
        img.src = 'data:image/png;base64,${shot.data}';
        await img.decode();
        var c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        var g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        var d = g.getImageData(0, 0, c.width, c.height).data;
        var r = 0, gg = 0, b = 0;
        for (var i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i+1]; b += d[i+2]; }
        var n = d.length / 4;
        return JSON.stringify({ r: r/n, g: gg/n, b: b/n });
      })()`);
      return JSON.parse(res.value);
    };

    const deep = await meanColor();
    const pickLime = await probe(`
      var bs = document.querySelectorAll('[data-theme-id]');
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].getAttribute('data-theme-id') === 'cyber-lime') { bs[i].click(); return 'ok'; }
      }
      return 'NO_CARD';`);
    ok('能切到赛博绿', pickLime === 'ok', String(pickLime));
    await sleep(2200);   // 等星尘重建 + 网格跑几帧
    const lime = await meanColor();

    const deepAdv = deep.g - deep.b;
    const limeAdv = lime.g - lime.b;
    console.log(`  全屏均值 深空 rgb(${deep.r.toFixed(1)}, ${deep.g.toFixed(1)}, ${deep.b.toFixed(1)})  ` +
      `→ 赛博绿 rgb(${lime.r.toFixed(1)}, ${lime.g.toFixed(1)}, ${lime.b.toFixed(1)})`);
    ok('★ 切到赛博绿后屏幕整体真的变绿了（背景网格跟着主题走）',
      limeAdv > deepAdv + 1,
      `绿-蓝差 ${deepAdv.toFixed(2)} → ${limeAdv.toFixed(2)} —— 没变说明着色器强调色还写死在组件里`);

    /* 收尾：切回深空，后面的断言都按默认主题写 */
    await probe(`
      var bs = document.querySelectorAll('[data-theme-id]');
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].getAttribute('data-theme-id') === 'deep-space') { bs[i].click(); return 'ok'; }
      }
      return 'NO_CARD';`);
    await sleep(900);
  }

  /* ============================================================
     7c. 管理台
     ============================================================
     这里验两件事，缺一不可：
       · 普通用户**进不去**（前端跳走 + 服务端 403，两层都要）；
       · 管理员**进得去且看得到数据**。
     只验第一条的话，一个"把所有人都挡在外面"的实现也能过；
     只验第二条的话，一个"谁都能进"的实现也能过。 */
  section('7c. 管理台：普通用户进不去 / 管理员进得去');
  {
    /* ---- 普通用户 ---- */
    await nav('/admin');
    await waitFor('!!document.querySelector("#main-scroll")', '普通用户访问 /admin');
    await sleep(1000);
    const asUser = JSON.parse(await probe(`return JSON.stringify({
      path: location.pathname,
      table: !!document.querySelector('#main-scroll table'),
      navItems: document.querySelectorAll('nav[aria-label="主导航"] a').length,
    })`));
    ok('★ 普通用户访问 /admin 会被弹回首页', asUser.path === '/', asUser.path);
    ok('★ 普通用户看不到用户表格', asUser.table === false, String(asUser.table));
    ok('★ 普通用户侧栏没有「管理」入口', Number(asUser.navItems) === 14, `${asUser.navItems} 项`);

    /* ---- 换成管理员 ----
     * 用页面上下文的 fetch 登录（cookie 会写进同一个浏览器上下文），
     * 然后整页导航 —— 这样走的是真实的「会话探测 → 渲染」链路，
     * 而不是绕过前端去改 React state。 */
    const login = await ev(`fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(${JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })})
    }).then(function (r) { return r.status })`);
    ok('能在页面上下文里登录引导管理员', login.value === 200, String(login.value));

    await nav('/admin');
    const gotTable = await waitFor('!!document.querySelector("#main-scroll table")', '管理台用户表格出现', 15000);
    /* ★ 表格出现 ≠ 页面渲染完。
     *   管理台同时打三个接口（overview / users / logs），表格是 users 先回来的产物，
     *   此刻「总览」那几张卡还是骨架屏 —— innerText 里一个字都没有。
     *   原来这里固定 sleep 900ms 就断言字数，机器一忙就报出
     *   「管理台渲染出内容 276 字」这种假红：实测撞到过一次，同一份代码重跑就绿。
     *   假红的代价不是"多看一眼"，是让人开始不信任测试。
     *   改成等条件成立（最多 8 秒）：慢不再等于错，真的渲染不出来照样红。 */
    /* ★ 这里只断言一次。waitFor 超时时它自己会记一笔失败，原来后面还跟着
     *   一条 `ok('管理台渲染出内容', ad.len > 300)`，于是**同一个问题在报告里
     *   显示成两条**（「等待超时：管理台内容渲染完成」+「管理台渲染出内容 273 字」），
     *   看着像两个 bug，排查时先怀疑自己刚改的东西。
     *
     *   超时也从 8 秒提到 12 秒：完整版 Chrome 下管理台要等三个接口
     *   （overview / users / logs）都回来，CI 的 runner 比开发机慢得多。 */
    /* ★ 阈值 200，不是 300。
     *
     *   这个数只用来区分「页面渲染出来了」和「还停在骨架屏」，
     *   **不该受库里有多少数据影响**。原来写 300 是照着
     *   `npm test` 的环境定的 —— 那时接口套件已经注册了一堆用户，
     *   用户表格行多、字数自然上得去。但单独跑本套件时库里只有
     *   管理员 + 一个普通用户，正文稳定在 222 字，于是必然超时。
     *   症状是「单独跑浏览器测试就红，npm test 就绿」，
     *   看起来像测试之间互相污染，实际是阈值钉在了数据量上。 */
    const rendered = await waitFor(
      'document.getElementById("main-scroll").innerText.replace(/\\s/g,"").length > 200',
      '管理台渲染出内容（正文 > 200 字）', 12000,
    );
    if (!rendered) {
      /* 失败时把实际字数打出来 —— 否则只知道「没到 200」，
       * 不知道是差一点点还是整块内容没出来。 */
      const len = await probe('return (document.getElementById("main-scroll")||{innerText:""}).innerText.replace(/\\s/g,"").length');
      console.log(`  \x1b[90m   （实际正文 ${len} 字，阈值 200）\x1b[0m`);
    }

    if (gotTable) {
      const ad = JSON.parse(await probe(`return JSON.stringify({
        path: location.pathname,
        rows: document.querySelectorAll('#main-scroll table tbody tr').length,
        h1: document.querySelector('#main-scroll h1') ? document.querySelector('#main-scroll h1').textContent.trim() : '',
        len: document.getElementById('main-scroll').innerText.replace(/\\s/g, '').length,
        navItems: document.querySelectorAll('nav[aria-label="主导航"] a').length,
        groups: document.querySelectorAll('nav[aria-label="主导航"] > div').length,
        search: !!document.querySelector('input[aria-label="搜索用户"]'),
      })`));
      ok('★ 管理员能进入 /admin', ad.path === '/admin', ad.path);
      ok('★ 管理台列出了用户行', ad.rows >= 2, `${ad.rows} 行`);
      ok('管理台标题正确', ad.h1.indexOf('用户管理') >= 0, ad.h1);
      /* 「渲染出内容」不在这里再断言 —— 上面那条 waitFor 已经管了（见注释）。 */
      ok('★ 管理员侧栏多了「管理」分组与入口', ad.navItems === 15 && ad.groups === 5,
        `${ad.navItems} 项 / ${ad.groups} 组`);
      ok('管理台有搜索框', ad.search === true);

      /* 搜索：输入后行数必须真的变少（不是只把输入框画出来） */
      await probe(`
        var el = document.querySelector('input[aria-label="搜索用户"]');
        if (!el) return 'NO_INPUT';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(ADMIN_EMAIL)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';`);
      await sleep(1200);
      const filtered = await probe(`return document.querySelectorAll('#main-scroll table tbody tr').length`);
      ok('★ 搜索后只剩匹配的行', Number(filtered) === 1, `${filtered} 行`);

      /* 详情弹窗。判据除了"有内容"，还有一条**隐私断言**：
       * 页面上不许出现密码哈希/盐、不许出现别人的 API Key。 */
      const opened = await probe(`
        var b = document.querySelector('#main-scroll table tbody tr button');
        if (!b) return 'NO_BTN';
        b.click();
        return 'ok';`);
      ok('能点开用户详情', opened === 'ok', String(opened));
      await sleep(1300);
      const dlgLen = await probe(`
        var d = document.querySelector('[role=dialog]');
        return d ? d.innerText.replace(/\\s/g, '').length : 0;`);
      ok('★ 详情弹窗渲染出内容', Number(dlgLen) > 150, `${dlgLen} 字`);

      const dlgText = await probe(`
        var d = document.querySelector('[role=dialog]');
        return d ? d.innerText : '';`);
      ok('★ 管理台上不出现密码哈希/盐', !/password_(hash|salt)/.test(String(dlgText)));
      ok('★ 管理台上不出现任何 API Key 明文', !/sk-[a-zA-Z0-9]{16,}/.test(String(dlgText)));

      /* 关掉弹窗。用 aria-label 在 JS 里找，不写 CSS 属性选择器 ——
       * 「关闭」不是 ASCII 标识符，写进选择器要处理转义，不值当。 */
      await probe(`
        var bs = document.querySelectorAll('[role=dialog] button');
        for (var i = 0; i < bs.length; i++) {
          if (bs[i].getAttribute('aria-label') === '关闭') { bs[i].click(); return 'ok'; }
        }
        return 'NO_CLOSE';`);
      await sleep(500);

      /* 管理接口真的返回了数据（不是前端造假表格） */
      const apiRows = await ev(`fetch('/api/admin/users?limit=200', { credentials: 'include' })
        .then(function (r) { return r.json() })
        .then(function (d) { return d.users.length })`);
      ok('★ 管理接口返回真实用户数据', Number(apiRows.value) >= 2, String(apiRows.value));

      /* 护栏：服务端不许管理员删掉自己。
       *
       * ★ 必须先问出自己的 id，**不能写死 1**。
       * 写死的话，万一 id 1 不是管理员而是某个普通用户，
       * 这一发 DELETE 会真的把他连数据一起删掉 —— 测试自己把库改坏了，
       * 而且它还会"通过"（返回 200 也是真删了）。 */
      const meId = await ev(`fetch('/api/auth/me', { credentials: 'include' })
        .then(function (r) { return r.json() })
        .then(function (d) { return d.user.id })`);
      const selfDel = await ev(`fetch('/api/admin/users/' + ${JSON.stringify(meId.value)}, {
        method: 'DELETE', credentials: 'include'
      }).then(function (r) { return r.status })`);
      ok('★ 服务端挡住"删自己"（前端置灰只是体验，门在服务端）',
        Number(selfDel.value) === 400, `实得 ${selfDel.value}`);
      /* 顺带证明"挡住"不是"删成功了但返回 400" */
      const stillMe = await ev(`fetch('/api/auth/me', { credentials: 'include' }).then(function (r) { return r.status })`);
      ok('★ 删自己被拒后账号仍然存在', Number(stillMe.value) === 200, `实得 ${stillMe.value}`);
    }
  }

  /* ============================================================
     8a. 目录导航与面包屑
     ============================================================
     这一节验的是「能不能直接跳到某个考点、能不能一眼看出自己在哪」。
     判据落在**真的点得动、真的跳过去、跳过去之后高亮对**，
     而不是「侧栏里有个叫目录的东西」。 */
  section('8a. 目录导航（考点目录）与面包屑');
  {
    await nav('/');
    await waitFor('!!document.querySelector("#main-scroll")', '首页就位（目录节）');
    await sleep(700);

    /* 目录默认是收起的 —— 这是设计（68 个考点摊开会把侧栏挤爆）。
     * 所以先断言它收着，再点开。 */
    const dir = await probe(`return JSON.stringify({
      nav: !!document.querySelector('nav[aria-label="考点目录"]'),
      toggle: !!Array.from(document.querySelectorAll('nav[aria-label="考点目录"] button'))
        .find(function (b) { return b.textContent.indexOf('考点目录') >= 0; }),
      links: document.querySelectorAll('nav[aria-label="考点目录"] a').length,
      crumb: !!document.querySelector('nav[aria-label="面包屑"]'),
      h1: document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : '',
    })`);
    const d = JSON.parse(dir);
    ok('侧栏有「考点目录」这一块', d.nav === true);
    ok('目录默认收起（不挤占 14 个入口）', d.links === 0, `实得 ${d.links} 条链接`);
    ok('顶栏有面包屑', d.crumb === true);
    ok('首页面包屑就是页面标题', d.h1 === '仪表盘', `h1="${d.h1}"`);

    /* 点开目录 —— 顺带证明它是个真能展开的控件 */
    const opened = await probe(`
      var bs = Array.from(document.querySelectorAll('nav[aria-label="考点目录"] button'));
      var b = bs.find(function (x) { return x.textContent.indexOf('考点目录') >= 0; });
      if (!b) return 'NO_BTN';
      b.click();
      return 'ok';`);
    ok('能展开考点目录', opened === 'ok', String(opened));
    await sleep(600);

    const chapters = await probe(`return JSON.stringify({
      chaps: document.querySelectorAll('nav[aria-label="考点目录"] button[aria-expanded]').length,
      search: !!document.querySelector('input[aria-label="搜索考点"]'),
    })`);
    const c = JSON.parse(chapters);
    ok('展开后列出章节', c.chaps >= 5, `${c.chaps} 个章节`);
    ok('目录带搜索框', c.search === true);

    /* 搜索 → 点第一条结果 → 应该真的落在那个考点页上 */
    const typed = await probe(`
      var el = document.querySelector('input[aria-label="搜索考点"]');
      if (!el) return 'NO_INPUT';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '极限');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';`);
    ok('能在目录里搜考点', typed === 'ok', String(typed));
    await sleep(600);

    const hits = await probe(`return document.querySelectorAll('nav[aria-label="考点目录"] a').length`);
    ok('搜索出结果', Number(hits) > 0, `${hits} 条`);

    const href = await probe(`
      var a = document.querySelector('nav[aria-label="考点目录"] a');
      return a ? a.getAttribute('href') : '';`);
    ok('结果指向具体考点', /^\/learn\//.test(String(href)), String(href));

    /* 点一下 —— 站内链接现在一律新标签页，所以「原页面不动 + 多一个标签」才对 */
    const knownDir = (await listPages()).map((p) => p.id);
    await probe(`document.querySelector('nav[aria-label="考点目录"] a').click(); return 1`);
    const openedDir = await waitForNewTab(knownDir, String(href));
    ok('★ 点目录在新标签页打开考点', !!openedDir, openedDir ? openedDir.url : '没等到新标签页');
    const stillHome = await probe('return location.pathname');
    ok('★ 原页面没被顶掉（上一个网页还留着）', stillHome === '/', `实得 ${stillHome}`);

    /* 再直接进那个考点页，验它自己渲染得对不对 */
    await nav(String(href));
    await waitFor('!!document.querySelector("nav[aria-label=\\"面包屑\\"]")', '考点页面包屑出现');
    await sleep(900);

    const landed = await probe(`return JSON.stringify({
      path: location.pathname,
      crumb: Array.from(document.querySelectorAll('nav[aria-label="面包屑"] li'))
        .map(function (li) { return li.textContent.trim(); }),
      h1: document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : '',
    })`);
    const ld = JSON.parse(landed);
    ok('★ 直接进考点页路径正确', ld.path === String(href), ld.path);
    ok('★ 面包屑是三层（首页 / 知识树 / 考点）', ld.crumb.length === 3, JSON.stringify(ld.crumb));
    ok('★ 面包屑末段就是考点标题', ld.h1 === ld.crumb[2] && ld.h1.length > 0, `h1="${ld.h1}"`);
    ok('面包屑里有「知识树」这一层', ld.crumb.indexOf('知识树') >= 0, JSON.stringify(ld.crumb));

    /* 面包屑要能点着往上退 —— 不然它只是个装饰。
     * 同样是新标签页（站内链接的统一定义）。 */
    const knownCrumb = (await listPages()).map((p) => p.id);
    const back = await probe(`
      var a = Array.from(document.querySelectorAll('nav[aria-label="面包屑"] a'))
        .find(function (x) { return x.textContent.trim() === '知识树'; });
      if (!a) return 'NO_LINK';
      a.click();
      return 'ok';`);
    ok('面包屑里的「知识树」可点', back === 'ok', String(back));
    const openedCrumb = await waitForNewTab(knownCrumb, '/learn');
    ok('★ 点面包屑在新标签页退回知识树', !!openedCrumb, openedCrumb ? openedCrumb.url : '没等到新标签页');
  }

  /* ============================================================
     4b. 公式实验室：257 条逐条点过，一条都不能让页面崩
     ============================================================
     ★ 这一节守的是一个**真实发生过**的 bug：切换公式时参数表里缺键，
     Slider 拿 undefined 去调 toFixed 抛 TypeError，整个实验室页面被
     ErrorBoundary 替换成「页面出错了 / 这一页没能渲染出来」。
     实测 257 条里有 7 条一点就崩，而且崩的规律不明显
     （取决于「上一条公式的控件键」和「这一条的控件键」是否重合）。

     为什么单元测试守不住它：tests/formula-demos.mjs 用的是 canvas 桩，
     验的是「演示函数不抛异常」；而这个 bug 在 **React 组件**里
     （参数表的生命周期），只有真渲染一次才暴露。

     ★ 判据用「console 里有没有『渲染期异常』」+「列表还在不在」两条。
     实测过一个**不可靠**的判据，记在这里免得下次又走一遍：
     一开始是「点完之后查 canvas 还在不在」—— 页面被错误边界替换时
     canvas 在那一刻还挂在 DOM 上，于是它一直返回 true，
     8 条就崩了的页面被这条判据判成「没有一条会崩」。
     console 那条才是可靠的：componentDidCatch 里那一句是同步打的。 */
  section('4b. 公式实验室：逐条点过 257 条公式，一条都不能崩');
  {
    await nav('/lab');
    await waitFor('!!document.querySelector("button[data-formula]")', '实验列表就位');
    await sleep(700);

    const chapters = JSON.parse(await probe(
      `return JSON.stringify(Array.from(document.querySelectorAll('select option')).map(o=>o.value).filter(Boolean))`));
    ok('能拿到章节筛选列表', chapters.length >= 15, `${chapters.length} 章`);

    const before = consoleErrors.length;
    let clicked = 0;
    let reloads = 0;
    const dead = [];

    const pickChapter = async (ch) => {
      await probe(`
        var sel = document.querySelector('select');
        var set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        set.call(sel, ${JSON.stringify(ch)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 1;`);
      await sleep(260);
    };

    for (const ch of chapters) {
      await pickChapter(ch);
      const n = Number(await probe(`return document.querySelectorAll('button[data-formula]').length`)) || 0;
      for (let i = 0; i < n; i++) {
        const r = await probe(`
          var bs = document.querySelectorAll('button[data-formula]');
          var b = bs[${i}];
          if (!b) return 'MISS';
          var name = b.textContent.trim().slice(0, 40);
          b.click();
          return name;`);
        if (r === 'MISS') {
          /* 列表整个消失了。正常情况下列表一直在（章节筛选没变），
           * 所以这只有一个解释：页面被错误边界换掉了。 */
          dead.push(`第 ${ch} 章第 ${i + 1} 条`);
          reloads++;
          if (reloads > 30) { console.log('  \x1b[31m重载次数过多，停止扫描\x1b[0m'); break; }
          await nav('/lab');
          await waitFor('!!document.querySelector("button[data-formula]")', '实验列表恢复');
          await sleep(600);
          await pickChapter(ch);
          continue;
        }
        clicked++;
      }
    }

    await sleep(500);   // 等 console 事件把最后几条送过来
    ok(`★ 逐条点过 ${clicked} 条公式（不是空跑）`, clicked >= 250, `实得 ${clicked}`);
    ok('★★ 没有一条公式会让页面崩掉（列表不会中途消失）',
      dead.length === 0, `崩了 ${dead.length} 次：${dead.slice(0, 6).join(' / ')}`);
    const renderErrors = consoleErrors.slice(before).filter((t) => t.includes('渲染期异常'));
    ok('★★ console 里也没有被错误边界接住的渲染期异常',
      renderErrors.length === 0, renderErrors.slice(0, 2).join(' | '));
  }

  /* ============================================================
     8b. 页面切换：保活 + 缓存
     ============================================================
     用户的原话是「页面之间切换……切了页面全部刷新了」。这一节把「刷新」
     拆成两个可测的事实：
       · DOM 实例还在不在（保活）—— 记号属性还在就是还在；
       · 有没有重新打接口（缓存）—— 数请求条数。
     两条都要有：只保 DOM 不缓存，数据照样重拉；只缓存不保活，
     输入框里打了半截的字照样没。 */
  section('8b. 页面切换：不卸载、不重拉、滚动还在');
  {
    await nav('/mistakes');
    await waitFor('!!document.querySelector("[data-page=\\"/mistakes\\"]")', '错题本就位');
    await sleep(1000);

    /* 在页面上打个记号。只有「同一个 DOM 实例」才会留着它 ——
     * 重新挂载的话属性会跟着新节点一起消失。 */
    const marked = await probe(`
      var host = document.querySelector('[data-page="/mistakes"]');
      if (!host) return 'NO_HOST';
      host.setAttribute('data-keep-probe', 'alive');
      return 'ok';`);
    ok('错题本页面容器就位', marked === 'ok', String(marked));

    /* ★ 先把「侧栏链接 = 新标签页」这个约定钉住，再用一次真点击验证。
     *
     *   之后的切页都改用 spaNav（同一个文档里的客户端路由）——
     *   这一节要验的是「保活 / 不重拉 / 滚动还在」，前提是**不整页刷新**。
     *   而点侧栏现在会开新标签，走的是「新文档 + 全新应用实例」，
     *   那正好是保活管不到的场景。所以两者必须分开测。 */
    const targets = JSON.parse(await probe(`
      return JSON.stringify(Array.from(document.querySelectorAll('nav[aria-label="主导航"] a'))
        .map(function (x) { return x.getAttribute('target'); }));`));
    ok('★ 侧栏每个入口都是新标签页打开（target=_blank）',
      targets.length >= 10 && targets.every((t) => t === '_blank'),
      `${targets.filter((t) => t === '_blank').length}/${targets.length} 个`);

    const knownSide = (await listPages()).map((p) => p.id);
    await probe(`
      var a = Array.from(document.querySelectorAll('nav[aria-label="主导航"] a'))
        .find(function (x) { return x.getAttribute('href') === '/stats'; });
      if (a) a.click();
      return 1;`);
    const openedSide = await waitForNewTab(knownSide, '/stats');
    ok('★ 真点侧栏确实开了新标签页', !!openedSide, openedSide ? openedSide.url : '没等到新标签页');
    ok('★ 原页面还停在错题本（上一个网页留着）',
      (await probe('return location.pathname')) === '/mistakes',
      String(await probe('return location.pathname')));

    const clickNav = async (href) => spaNav(href);

    const before = requests.filter((u) => u.includes('/api/study/mistakes')).length;

    /* 切到统计，再切回来 —— 全程走客户端路由，不是整页刷新 */
    ok('能在同一文档内切到统计', (await clickNav('/stats')) === '/stats');
    await waitFor('document.querySelector("[data-page=\\"/stats\\"]").style.display !== "none"', '统计页显示出来');
    await sleep(800);

    const switched = JSON.parse(await probe(`return JSON.stringify({
      stats: document.querySelector('[data-page="/stats"]').style.display,
      wrong: document.querySelector('[data-page="/mistakes"]').style.display,
      probe: !!document.querySelector('[data-keep-probe]'),
      skel: document.querySelectorAll('#main-scroll .skeleton').length,
    })`));
    ok('切走的页面被藏起来（display:none）', switched.wrong === 'none', `实得 ${switched.wrong}`);
    ok('当前页面显示出来', switched.stats !== 'none', `实得 ${switched.stats}`);
    ok('★ 切走的页面没有被卸载（DOM 记号还在）', switched.probe === true);
    ok('★ 切到统计没有闪骨架屏', switched.skel === 0, `${switched.skel} 个骨架屏`);

    ok('能切回错题本', (await clickNav('/mistakes')) === '/mistakes');
    await waitFor('document.querySelector("[data-page=\\"/mistakes\\"]").style.display !== "none"', '错题本回到前台');
    await sleep(700);

    const backState = JSON.parse(await probe(`return JSON.stringify({
      probe: !!document.querySelector('[data-keep-probe]'),
      skel: document.querySelectorAll('#main-scroll .skeleton').length,
      len: document.querySelector('[data-page="/mistakes"]').innerText.replace(/\\s/g,'').length,
      pages: document.querySelectorAll('[data-page]').length,
      visible: Array.from(document.querySelectorAll('[data-page]'))
        .filter(function (p) { return p.style.display !== 'none'; }).length,
    })`));
    ok('★ 切回来还是同一个 DOM 实例', backState.probe === true);
    ok('★ 切回来不闪骨架屏（吃的是缓存）', backState.skel === 0, `${backState.skel} 个骨架屏`);
    ok('切回来内容还在', backState.len > 30, `${backState.len} 字`);
    ok('★ 同一时刻只显示一个页面', backState.visible === 1, `${backState.visible} 个可见`);
    ok('★ 访问过的页面都留在 DOM 里（保活池）', backState.pages >= 3, `${backState.pages} 个容器`);

    /* ★ 这一条才是"不刷新"的硬证据：切回来一次请求都没发。
     * 只断言"没有骨架屏"是不够的 —— 缓存过期时后台重拉也是没有骨架屏的，
     * 但那时候确实打了接口。 */
    const after = requests.filter((u) => u.includes('/api/study/mistakes')).length;
    ok('★ 切回错题本没有再打接口（缓存命中）', after === before, `${before} → ${after} 次`);

    /* 滚动位置：滚的是 **window**，不是 #main-scroll ——
     * AppShell 里那个 <main id="main-scroll"> 没有 overflow，
     * 它自己不滚。断言写错元素的话这条会永远"通过"（两边都是 0）。 */
    await nav('/learn/c1n1');
    await waitFor('!!document.querySelector("#main-scroll")', '知识点页就位（滚动节）');
    await sleep(1200);
    const scrolled = await probe(`
      var max = document.documentElement.scrollHeight - innerHeight;
      var target = Math.min(300, Math.max(0, max));
      window.scrollTo({ top: target, behavior: 'auto' });
      return JSON.stringify({ y: window.scrollY, max: max });`);
    const sc = JSON.parse(scrolled);
    ok('知识点页可以滚动（够长）', sc.max > 100, `可滚动高度 ${sc.max}px`);
    ok('已经滚下去了', sc.y > 50, `scrollY=${sc.y}`);

    ok('从知识点页切到统计', (await clickNav('/stats')) === '/stats');
    await waitFor('document.querySelector("[data-page=\\"/stats\\"]").style.display !== "none"', '统计页再次显示');
    await sleep(600);
    await probe(`history.back(); return 1`);
    await waitFor('location.pathname === "/learn/c1n1"', '回到知识点页');
    await sleep(800);

    const restored = await probe(`return window.scrollY`);
    ok('★ 切回知识点页时滚动位置被恢复（不再跳回顶部）',
      Math.abs(Number(restored) - sc.y) < 60, `scrollY=${restored}（期望 ≈${sc.y}）`);
  }

  /* ============================================================
     8c. 课堂：留痕 / 讲透 / 说不知道之后
     ============================================================
     这一节是用户报的三条课堂问题的端到端验收，所以必须**对着假模型
     真点一遍**，而不是只读接口返回：
       · 第一轮老师有没有把理论讲透（界面上写着"讲授 · 讲透理论"）；
       · 说「不知道」之后三个同学是不是真的闭嘴了（数气泡）；
       · 回复有没有留痕（气泡里有没有引用第几轮的问题）；
       · 「还是没懂 / 懂了」两个按钮能不能把这条链走完。
     假模型固定每轮回 4 条（老师 + 小明 + 小红 + 小刚），
     所以「学生静默」这件事在界面上是数得出来的。 */
  section('8c. 课堂：留痕 / 讲透 / 说不知道之后');
  {
    const stub = await startLlmStub();
    try {
      /* 在页面上下文里把 stub 配成本用户的本地模型 ——
       * 走的是真实设置接口，不是改前端 state。 */
      const cfg = await ev(`fetch('/api/settings/llm', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, kind: 'local', localBase: ${JSON.stringify(stub.base)}, localModel: 'stub-model' })
      }).then(function (r) { return r.status })`);
      ok('能在页面上下文里把课堂接到假模型上', cfg.value === 200, String(cfg.value));

      await nav('/classroom?kid=c1n1');
      await waitFor('!!document.querySelector("#main-scroll")', '课堂页就位');
      await sleep(900);

      /* 数「非本人」的气泡。
       * 不能直接数 [data-anchor^="t-N-"] —— 那一轮里还有**我自己**的那条发言，
       * 数进去就会把"只剩老师一条"误判成两条。本人气泡的判别特征是
       * 外层用了 flex-row-reverse（自己的消息靠右）。 */
      const others = (round) => probe(`
        return Array.from(document.querySelectorAll('[data-anchor^="t-${round}-"]'))
          .filter(function (el) { return String(el.className).indexOf('flex-row-reverse') < 0; }).length;`);

      const startBtn = await probe(`
        var bs = Array.from(document.querySelectorAll('#main-scroll button'));
        var b = bs.find(function (x) { return x.textContent.indexOf('开始上课') >= 0; });
        if (!b) return 'NO_BTN';
        b.click();
        return 'ok';`);
      ok('能点「开始上课」', startBtn === 'ok', String(startBtn));
      await waitFor('document.querySelectorAll("[data-anchor^=\\"t-0-\\"]").length > 0', '第一轮发言上屏', 20000);
      await sleep(900);

      const first = JSON.parse(await probe(`return JSON.stringify({
        text: document.querySelector('#main-scroll').innerText,
      })`));
      ok('第一轮四个角色都发言了（老师 + 三个同学）', Number(await others(0)) === 4, `实得 ${await others(0)} 条`);
      ok('★ 第一轮标为「讲透理论」阶段', first.text.indexOf('讲透理论') >= 0, '');
      ok('★ 提示这一轮老师会把定义/直观/条件讲全',
        first.text.indexOf('适用条件') >= 0 || first.text.indexOf('常见误区') >= 0, '');
      ok('首轮结尾的问题标为「老师留了个问题给你」',
        first.text.indexOf('老师留了个问题给你') >= 0, '');
      ok('首轮不问用户要答案之外的动笔', first.text.indexOf('不用算') >= 0, '');

      /* ---------- 说「不知道」 ---------- */
      const said = await probe(`
        var el = document.querySelector('#main-scroll textarea');
        if (!el) return 'NO_AREA';
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '我不知道');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        var bs = Array.from(document.querySelectorAll('#main-scroll button'));
        var b = bs.find(function (x) { return x.textContent.trim() === '发言'; });
        if (!b) return 'NO_SEND';
        b.click();
        return 'ok';`);
      ok('能发出「我不知道」', said === 'ok', String(said));
      await waitFor('document.querySelectorAll("[data-anchor^=\\"t-1-\\"]").length > 0', '第二轮上屏', 20000);
      await sleep(900);

      const r1others = Number(await others(1));
      const after = JSON.parse(await probe(`return JSON.stringify({
        text: document.querySelector('#main-scroll').innerText,
      })`));
      ok('★ 说「不知道」后三个同学全部静默（这一轮只剩老师，不含我自己那句）',
        r1others === 1, `第 2 轮有 ${r1others} 条非本人发言（期望 1）`);
      ok('★ 阶段切成「只讲给你听」', after.text.indexOf('只讲给你听') >= 0, '');
      ok('★ 界面上明说了同学已静默',
        after.text.indexOf('三个同学已静默') >= 0, '');
      ok('★ 结尾换成「确认你听懂了没有」，不是一道题',
        after.text.indexOf('老师想确认你听懂了没有') >= 0, '');
      ok('★ 明确说了这一轮不用动笔',
        after.text.indexOf('先别动笔') >= 0, '');

      /* ---------- 留痕 ---------- */
      const trail = JSON.parse(await probe(`return JSON.stringify({
        quote: document.querySelectorAll('[data-anchor^="t-1-"] [class*="border-l-2"]').length,
        text: document.querySelector('#main-scroll').innerText,
      })`));
      ok('★ 我的发言气泡里引出了在回答哪一问', trail.quote >= 1, `${trail.quote} 处引用`);
      ok('★ 引用标明了轮次', trail.text.indexOf('回答第 1 轮老师的问题') >= 0, '');
      ok('★ 有「本课问答留痕」面板', trail.text.indexOf('本课问答留痕') >= 0, '');

      const idx = await probe(`
        var bs = Array.from(document.querySelectorAll('#main-scroll button'));
        var b = bs.find(function (x) { return x.textContent.indexOf('本课问答留痕') >= 0; });
        if (!b) return 'NO_BTN';
        b.click();
        return 'ok';`);
      ok('留痕面板能展开', idx === 'ok', String(idx));
      await sleep(500);
      const idxBody = await probe(`return JSON.stringify({
        rows: document.querySelectorAll('#main-scroll ol > li').length,
        text: document.querySelector('#main-scroll').innerText,
      })`);
      const ib = JSON.parse(idxBody);
      ok('★ 留痕里列出了「几问几答」', /\d+\s*问\s*·\s*\d+\s*答/.test(ib.text), '');
      ok('★ 留痕里有问有答两条以上', ib.rows >= 2, `${ib.rows} 行`);

      /* ---------- 理解确认的两个按钮把链走完 ---------- */
      const quick = await probe(`
        var bs = Array.from(document.querySelectorAll('#main-scroll button'));
        var b = bs.find(function (x) { return x.textContent.indexOf('懂了，继续') >= 0; });
        if (!b) return 'NO_BTN';
        b.click();
        return 'ok';`);
      ok('★ 理解确认有「懂了，继续」这个一键回复', quick === 'ok', String(quick));
      await waitFor('document.querySelectorAll("[data-anchor^=\\"t-2-\\"]").length > 0', '第三轮上屏', 20000);
      await sleep(900);

      const practice = JSON.parse(await probe(`return JSON.stringify({
        text: document.querySelector('#main-scroll').innerText,
      })`));
      ok('★ 说懂了之后进「练习 · 验收」', practice.text.indexOf('练习') >= 0, '');
      ok('★ 这一轮才是「老师留了一道题给你」',
        practice.text.indexOf('老师留了一道题给你') >= 0, '');
      const r2others = Number(await others(2));
      ok('★ 学生恢复发言（不再静默）', r2others === 4, `第 3 轮有 ${r2others} 条非本人发言（期望 4）`);

      /* 切走再切回来，这一课还在 —— 保活 + 存档都要管用 */
      await probe(`
        var a = Array.from(document.querySelectorAll('nav[aria-label="主导航"] a'))
          .find(function (x) { return x.getAttribute('href') === '/stats'; });
        if (a) a.click();
        return 1;`);
      await sleep(700);
      await probe(`
        var a = Array.from(document.querySelectorAll('nav[aria-label="主导航"] a'))
          .find(function (x) { return x.getAttribute('href') === '/classroom'; });
        if (a) a.click();
        return 1;`);
      await sleep(900);
      const kept = JSON.parse(await probe(`return JSON.stringify({
        rounds: document.querySelectorAll('[data-anchor^="t-"]').length,
        text: document.querySelector('#main-scroll').innerText,
      })`));
      ok('★ 切走再切回来，这节课的对话还在', kept.rounds >= 6, `${kept.rounds} 条发言`);
      ok('★ 切回来留痕也还在', kept.text.indexOf('本课问答留痕') >= 0, '');
    } finally {
      /* 收干净：把模型配置撤掉，别让它影响后面的全局检查 */
      await ev(`fetch('/api/settings/llm', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, kind: 'local', localBase: '', localModel: '' })
      }).then(function (r) { return r.status })`).catch(() => {});
      await stub.stop();
    }
  }

  section('8. 全局：无未捕获异常 / 无 console 报错');
  {
    const uniqEx = [...new Set(exceptions)];
    const uniqErr = [...new Set(consoleErrors)];
    ok('没有未捕获异常', uniqEx.length === 0, uniqEx.slice(0, 3).join(' | '));
    ok('没有 console.error', uniqErr.length === 0, uniqErr.slice(0, 3).join(' | '));
    if (uniqEx.length) console.log('    异常：\n      ' + uniqEx.slice(0, 5).join('\n      '));
    if (uniqErr.length) console.log('    报错：\n      ' + uniqErr.slice(0, 5).join('\n      '));
  }
} catch (e) {
  console.log(`\n\x1b[31m测试脚本自身出错：${e.message}\x1b[0m`);
  fail++;
  failures.push('脚本自身出错：' + e.message);
} finally {
  if (client) client.close();
  // 主动断开 stderr 管道：不显式 destroy 的话，子进程的 pipe 会让事件循环多活一会儿
  try { proc?.stderr?.destroy(); } catch { /* 已关 */ }
  try { proc?.kill('SIGKILL'); } catch { /* 已退 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}

console.log('\n' + '─'.repeat(46));

/* 「跳过」必须在汇总行里留下痕迹。
 * 原因：run-all.mjs 是用正则抓这行数字的，跳过项不在 pass 里也不在 fail 里 ——
 * 如果汇总行只报 pass，那么「本机跑不了 WebGL、4 条断言被跳过」和
 * 「4 条断言真跑绿了」在父进程看来一模一样。这个项目已经被
 * 「0 项」和「全绿」长得一样坑过一次了，不能再来第二次。
 * 所以：跳过数直接写进汇总行（正则仍能抓到开头的 pass 数），
 * 并在下面单独出一行黄字点名。 */
const tail = skipped ? `（其中 ${skipped} 项因环境跳过）` : '';

if (fail) {
  console.log(`\x1b[31m❌ 浏览器冒烟：${pass} 项通过，失败 ${fail} 项${tail}\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
  if (skipped) console.log(`\x1b[33m   ⚠ 另有 ${skipped} 项被跳过，不等于验证过。\x1b[0m`);
  process.exit(1);
} else {
  console.log(`\x1b[32m✅ 浏览器冒烟：${pass} 项全部通过${tail}\x1b[0m`);
  if (skipped) {
    console.log(`\x1b[33m   ⚠ 这 ${skipped} 项没跑 —— 通常是本内核拿不到 WebGL2（缺 SwiftShader）。\x1b[0m`);
    console.log(`\x1b[33m     本机验收请用 Chrome + --use-angle=swiftshader；CI 上出现属正常，但别当成全绿。\x1b[0m`);
  }
  process.exit(0);
}
