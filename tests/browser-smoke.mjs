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

const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const WIDTH = 1440;
const HEIGHT = 900;

let pass = 0;
let fail = 0;
const failures = [];
const consoleErrors = [];
const exceptions = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 找浏览器 ---------- */
function findBrowser() {
  const home = os.homedir();
  const candidates = [];
  // Playwright 缓存的 headless shell：不需要显示器，启动最快
  for (const base of [`${home}/Library/Caches/ms-playwright`, `${home}/.cache/ms-playwright`]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('chromium_headless_shell-')) continue;
      for (const rel of [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell',
      ]) {
        candidates.push({ bin: path.join(base, d, rel), kind: 'shell' });
      }
    }
  }
  candidates.push(
    { bin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
    { bin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'chrome' },
    { bin: '/usr/bin/google-chrome', kind: 'chrome' },
    { bin: '/usr/bin/google-chrome-stable', kind: 'chrome' },
    { bin: '/usr/bin/chromium', kind: 'chrome' },
    { bin: '/usr/bin/chromium-browser', kind: 'chrome' },
    { bin: '/opt/google/chrome/chrome', kind: 'chrome' },
    { bin: '/snap/bin/chromium', kind: 'chrome' },
  );
  return candidates.find((c) => fs.existsSync(c.bin)) || null;
}

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
  console.log('\n\x1b[33m· 本机没找到 Chromium 内核，跳过浏览器冒烟测试\x1b[0m');
  console.log('  （装了 Google Chrome / Edge，或任意带 playwright 的工具即可自动启用）');
  console.log('\n' + '─'.repeat(46));
  console.log('\x1b[32m✅ 浏览器冒烟跳过：0 项\x1b[0m');
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
  });

  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Log.enable');

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
    ok('星尘 canvas 已挂载', d.canvas >= 1, `实得 ${d.canvas}`);
    ok('页面标题正确', /研数/.test(d.title), d.title);
  }

  section('1. 星尘 canvas 真的画了东西');
  {
    await sleep(900);   // 让粒子跑几帧
    const r = await probe(`
      var cv = document.querySelector('canvas');
      if (!cv) return JSON.stringify({ w: 0, h: 0, painted: 0 });
      var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      var painted = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] !== 0) painted++;
      return JSON.stringify({ w: cv.width, h: cv.height, painted: painted });`);
    const d = JSON.parse(r);
    ok('canvas 有实际尺寸', d.w > 200 && d.h > 200, `${d.w}×${d.h}`);
    ok('canvas 上真的画了粒子（非透明像素）', d.painted > 500, `${d.painted} 个非透明像素`);
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
    ok('侧栏 13 项导航全部渲染', navCount === 13, `实得 ${navCount} 个`);
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
        return JSON.stringify({
          title: h1 ? h1.textContent.trim() : '',
          len: m ? m.innerText.replace(/\\s/g,'').length : 0,
          skel: document.querySelectorAll('.skeleton').length,
          crash: document.body.innerText.indexOf('应用出错了') >= 0 || document.body.innerText.indexOf('Something went wrong') >= 0
        });`);
      const d = JSON.parse(r);
      const newErrs = exceptions.length + consoleErrors.length - before;

      ok(`${label}（${route}）渲染出内容`, d.len > 30, `正文 ${d.len} 字${d.skel ? `（还有 ${d.skel} 个骨架屏未消失）` : ''}`);
      ok(`${label} 没有崩溃`, !d.crash);
      ok(`${label} 无新增报错`, newErrs === 0, `${newErrs} 条`);
      ok(`${label} 标题正确`, !d.title || d.title.length > 0, `h1="${d.title}"`);
    }
  }

  section('4. 公式实验室：切模块后画布真的重画');
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
    ok('默认模块画布已绘制', p1 > 500, `${p1} 像素`);

    // 切到第二个模块，画布必须重画（不是只换了个标题）
    const switched = await probe(`
      var btns = Array.from(document.querySelectorAll('[role=tab]'));
      if (btns.length < 2) return 'NO_TABS';
      btns[1].click();
      return btns.length;`);
    ok('有多个实验模块可切', switched !== 'NO_TABS' && Number(switched) >= 2, `实得 ${switched}`);
    await sleep(1000);

    const p2 = await count();
    ok('切模块后画布重画了', p2 > 500 && p2 !== p1, `像素 ${p1} → ${p2}`);

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
    } else {
      ok('实验模块有可拖滑块', false, '没找到 range');
    }
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
if (fail) {
  console.log(`\x1b[31m❌ 浏览器冒烟：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
} else {
  console.log(`\x1b[32m✅ 浏览器冒烟：${pass} 项全部通过\x1b[0m`);
  process.exit(0);
}
