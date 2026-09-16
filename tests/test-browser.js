#!/usr/bin/env node
/* 真浏览器冒烟测试：启动无头 Chromium，用 CDP 打开真实页面，
 * 检查课堂页能不能渲染出来，并抓取所有 console 报错 / 未捕获异常。
 *
 * 静态检查查不出「选择器写错导致点开白屏」这类问题，只有真跑一次才知道。
 * 找不到浏览器时自动跳过（不算失败），这样换台机器也能跑。
 *
 *   node tests/test-browser.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const SMOKE = path.join(__dirname, '.smoke.html');
const HOME = os.homedir();

/* ---------- 1. 找浏览器：优先 Playwright 的 headless shell（不需要显示器） ---------- */
function findBrowser() {
  const glob = [
    path.join(HOME, 'Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    path.join(HOME, 'Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-x64/chrome-headless-shell'),
    path.join(HOME, 'Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'),
    path.join(HOME, '.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell')
  ];
  for (const g of glob) {
    const dir = path.dirname(g);
    const base = path.dirname(dir);
    if (!fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const v of versions) {
      const bin = g.replace('*', v.replace('chromium_headless_shell-', ''));
      if (fs.existsSync(bin)) return { bin, kind: 'shell' };
    }
  }
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  for (const c of cands) if (fs.existsSync(c)) return { bin: c, kind: 'chrome' };
  return null;
}

const BROWSER = findBrowser();
if (!BROWSER) {
  console.log('  · 本机没找到 Chromium 内核，跳过浏览器冒烟测试');
  console.log('\n' + '─'.repeat(40));
  console.log('✅ 浏览器冒烟跳过：0 项');
  process.exit(0);
}

/* ---------- 2. 从 index.html 生成冒烟页（保证环境一致，不手写第二份骨架） ---------- */
let html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
html = html.replace(/ data-page-node-id="[^"]*"/g, '');                       // 去掉预览工具注入的噪声
html = html.replace(/(src|href)="(?!https?:|#)([^"]+)"/g, '$1="../$2"');      // 相对路径上跳一层

// 掐掉 KaTeX 的 CDN 依赖：没网时那个请求会一直挂着，页面永远停在 loading，
// 测试就成了在测网络而不是测代码。给个本地 stub 顶上。
html = html.replace(/<link[^>]*katex[^>]*>\s*/gi, '');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*katex[^"]*"><\/script>/gi,
  `<script>
window.katex = {
  renderToString: function (tex) { return '<span class="katex-stub">' + String(tex) + '</span>'; }
};
</script>`);
if (!/katex-stub/.test(html)) throw new Error('没能替换掉 KaTeX CDN —— index.html 结构变了？');

const collector = `<script>
window.__errors = [];
window.onerror = function (m, s, l, c) {
  window.__errors.push(String(m) + ' @' + String(s || '').split('/').pop() + ':' + l);
  return false;
};
window.addEventListener('unhandledrejection', function (e) {
  window.__errors.push('unhandledRejection: ' + String((e.reason && e.reason.message) || e.reason));
});
</script>`;
html = html.replace('<script src=', collector + '\n<script src=');
fs.writeFileSync(SMOKE, html);

/* ---------- 3. 零依赖静态服务器 ---------- */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(REPO, p);
  if (!f.startsWith(REPO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('nope');
  }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)] || 'text/plain';
  res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
  res.end(fs.readFileSync(f));
});

/* ---------- 4. 极简 CDP 客户端（Node 22 自带 WebSocket） ---------- */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach(fn => fn(msg));
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
    close() { try { ws.close(); } catch (e) { } }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitPort(file, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8').trim().split('\n');
      if (txt[0]) return parseInt(txt[0], 10);
    }
    await sleep(80);
  }
  throw new Error('浏览器没在 ' + ms + 'ms 内报出调试端口');
}

(async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/tests/.smoke.html#/class/c1n4';

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-smoke-'));
  const args = [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1440,900',          // 窄窗口会命中响应式断点，测不到三栏
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ];
  if (BROWSER.kind === 'chrome') args.unshift('--headless=new');

  const proc = spawn(BROWSER.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let procErr = '';
  proc.stderr.on('data', d => { procErr += d.toString(); });

  let code = 0, out = [], fails = 0, passes = 0;
  let client = null;
  try {
    const dbgPort = await waitPort(path.join(profile, 'DevToolsActivePort'), 20000);
    const list = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/list')).json();
    const page = list.find(t => t.type === 'page');
    if (!page) throw new Error('没有可用的页面目标');

    client = cdp(page.webSocketDebuggerUrl);
    await client.ready;

    const consoleErrors = [];
    client.on(msg => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        consoleErrors.push('未捕获异常：' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push('console.error：' + msg.params.args.map(a => a.value || a.description || '').join(' '));
      }
    });

    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });

    // 等页面真的就绪，而不是死等一个固定的毫秒数
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      const s = await client.send('Runtime.evaluate', {
        expression: 'document.readyState + "|" + (typeof window.App) + "|" + (document.querySelectorAll(".c-roster-item").length)',
        returnByValue: true
      });
      const v = String(s.result.value || '');
      if (v.indexOf('complete|object|4') === 0) { ready = true; break; }
      await sleep(150);
    }
    await sleep(250);   // 让渲染后的收尾逻辑（resetRoster / scrollStream）跑完

    const evalVal = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      return r.result ? r.result.value : undefined;
    };
    const runProbe = async (expr) => String((await evalVal(expr)) || '');

    // 探针自己包一层 try/catch —— 否则它一抛异常，测试只会报"什么都没测到"，
    // 看不出到底是页面坏了还是探针写错了。
    const probe = `(function () {
      try {
        var r = [];
        function chk(ok, label) { r.push((ok ? '\\u2713 ' : '\\u2717 ') + label); }
        var main = document.getElementById('main');
        chk(!!main && main.innerHTML.length > 200, '主区域渲染出内容');
        chk(document.querySelectorAll('.c-roster-item').length === 4, '花名册 4 个人（老师 + 甲乙丙）');
        chk(!!document.querySelector('.c-roster-ava.c-ava-teacher'), '老师头像样式挂上了');
        chk(!!document.querySelector('.c-roster-ava.c-ava-smart'), '学生甲头像样式挂上了');
        chk(!!document.querySelector('.c-roster-ava.c-ava-weak'), '学生丙头像样式挂上了');
        chk(!!document.getElementById('c-stream'), '对话流容器存在');
        chk(!!document.getElementById('c-board'), '黑板容器存在');
        chk(!!document.getElementById('c-status'), '状态条存在');
        chk(!!document.getElementById('c-input'), '插话输入框存在');
        chk(document.querySelectorAll('.seg-btn').length >= 2, '课堂 / 讨论两个模式按钮都在');
        chk(typeof window.App.startClass === 'function', 'App.startClass 可调用');
        chk(typeof window.Classroom.run === 'function', 'Classroom 引擎已加载');
        chk(!!document.querySelector('.c-board-empty'), '黑板初始占位正常');
        var lay = document.querySelector('.class-layout');
        chk(!!lay && getComputedStyle(lay).display === 'flex', '三栏布局样式生效');
        var side = document.querySelector('.class-side');
        var sw = side ? getComputedStyle(side).width : '无';
        // 判据从「左栏正好 214px」换成「body 底色等于设计 token」：
        // 前者是魔法数字，改一次版就误报一次；后者直接证明样式表生效。
        chk(getComputedStyle(document.body).backgroundColor === 'rgb(246, 246, 243)',
          '样式表确实加载了（body 底色 ' + getComputedStyle(document.body).backgroundColor + '）');
        chk(!!side && parseInt(sw, 10) > 100, '三栏布局的左栏有宽度（' + sw + '）');
        var weak = document.getElementById('c-st-weak');
        chk(!!weak && weak.textContent.length > 0, '丙的状态位有内容（' + (weak ? weak.textContent : '无') + '）');
        chk(!!document.querySelector('.c-ava-weak'), '丙的头像配色类存在');
        return r.join('\\n');
      } catch (e) {
        return '\\u2717 探针自身抛异常：' + (e && e.message);
      }
    })()`;

    out = (await runProbe(probe)).split('\n').filter(Boolean);

    const pageErrs = await evalVal('JSON.stringify(window.__errors || [])');
    let jsErrs = [];
    try { jsErrs = JSON.parse(pageErrs); } catch (e) { }

    console.log('\n=== 无头 Chromium 渲染课堂页（' + BROWSER.kind + '）===');
    out.forEach(l => console.log('  ' + l));
    passes = out.filter(l => l.startsWith('✓')).length;
    fails = out.filter(l => l.startsWith('✗')).length;

    if (ready) {
      passes++;
      console.log('  ✓ 页面在 15 秒内完成加载（不依赖外网）');
    } else {
      fails++;
      console.log('  ✗ 页面 15 秒内没加载完 —— 可能有外部资源在阻塞');
    }

    /* ================= B. 卡片库：课堂记录 → 卡片 → 导出 ================= */
    const seeded = {
      classrooms: {
        c1n4: {
          kid: 'c1n4', mode: 'lesson', stage: 'done',
          question: {
            id: 'q1', kid: 'c1n4', type: 'choice',
            stem: '求极限 lim (tan x - sin x) / x^3',
            options: [{ k: 'A', t: '1/2' }, { k: 'B', t: '0' }],
            answer: 'A', analysis: 'tan x - sin x 等价于 x^3/2，所以极限是 $1/2$。'
          },
          reason: '你在这一节错过 3 次',
          turns: [
            { role: 'teacher', text: '这一步讲完了。当 x 趋于 0 时，sin x 等价于 x。' },
            { role: 'average', text: '那为什么不能拆开代换呢？' },
            { role: 'weak', text: '我觉得是 0 吧，两个都换成 x 就减没了。' },
            { role: 'teacher', text: '学生丙把等价代换当成了普通约分，这是典型混淆。加减中不能随便代换。' },
            { role: 'teacher', text: '这节课记住两件事：\n1. 等价代换只能用于乘除因子，加减中慎用。\n2. 遇到 tan x - sin x 要先提取公因式。' }
          ],
          spoken: [], userTurns: [], board: [], memory: {}
        }
      }
    };
    await evalVal('localStorage.setItem("kaoyan_math_tutor_v1", ' + JSON.stringify(JSON.stringify(seeded)) + ')');
    // 必须让 URL 真的变化才会重新加载 —— 导航到一模一样的地址浏览器会当成空操作，
    // 页面不会重跑 load()，种子数据就白写了。
    // 注意：query 要插在 # 之前，否则会被当成 hash 的一部分，路由就匹配不上了。
    const parts = url.split('#');
    await client.send('Page.navigate', { url: parts[0] + '?seed=' + Date.now() + '#' + (parts[1] || '') });
    const dl2 = Date.now() + 15000;
    while (Date.now() < dl2) {
      const v = String(await evalVal('document.readyState + "|" + (typeof window.App) + "|" + document.querySelectorAll(".c-roster-item").length') || '');
      if (v.indexOf('complete|object|4') === 0) break;
      await sleep(150);
    }
    await sleep(200);

    const cardOut = [];

    // B1：课堂页有没有「整理成复习卡片」入口
    cardOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var side = document.querySelector('.class-side');
        chk(!!side, '课堂页渲染出来了（种子数据被读到了）');
        chk(/重开一节/.test(side ? side.textContent : ''), '★ 认出了已有的课堂记录（按钮变成「重开一节」）');
        chk(!!side && /整理成复习卡片/.test(side.textContent), '课堂页出现「整理成复习卡片」入口');
        chk(typeof window.Cards.distill === 'function', 'Cards 引擎已加载');
        chk(!!document.getElementById('pk-card-css'), '★ 卡片样式已注入 head（只有一份来源）');
        chk(!!document.getElementById('print-root'), '打印容器存在于 body 直接子级');
        chk(getComputedStyle(document.getElementById('print-root')).display === 'none', '屏幕上打印容器是隐藏的');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    // B2：生成卡片并跳转
    await evalVal("window.App.makeCards('c1n4')");
    await sleep(400);
    cardOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        chk(location.hash === '#/cards/c1n4', '跳到卡片库（' + location.hash + '）');
        var cells = document.querySelectorAll('#main .pk-cell');
        chk(cells.length >= 4, '渲染出 ' + cells.length + ' 张卡片');
        chk(!!document.querySelector('#main .pk-card.pk-problem'), '有题目卡');
        chk(!!document.querySelector('#main .pk-card.pk-point'), '有结论卡');
        chk(!!document.querySelector('#main .pk-card.pk-pitfall'), '★ 有易错卡（从老师点名点评里抽的）');
        chk(!!document.querySelector('#main .pk-card.pk-question'), '★ 有疑问卡（学生问句 + 老师回应）');
        chk(!document.querySelector('#main .pk-cover'), '屏幕上不显示封面（封面只在打印时出现）');
        var pit = document.querySelector('#main .pk-card.pk-pitfall');
        // 期望色从 Cards.TYPES 现算，避免改配色就要回来改测试
        var wantPit = (function () {
          var h = (window.Cards && window.Cards.TYPES && window.Cards.TYPES.pitfall.color) || '#a33a2e';
          var n = parseInt(h.slice(1), 16);
          return 'rgb(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ') + ')';
        })();
        chk(pit && getComputedStyle(pit).borderLeftColor === wantPit,
            '★ 易错卡的类型色条真的生效了（期望 ' + wantPit + '，实际 ' + (pit ? getComputedStyle(pit).borderLeftColor : '无') + '）');
        var del = document.querySelector('#main .pk-del');
        chk(!!del && getComputedStyle(del).display !== 'none', '屏幕上有删除按钮');
        var c0 = document.querySelector('#main .pk-card');
        chk(c0 && getComputedStyle(c0).breakInside === 'avoid',
            '★ 卡片声明了 break-inside:avoid（不会被分页切断）');
        chk(document.querySelectorAll('#main .deck-chip').length >= 3, '有类型筛选按钮');
        chk(/共 \\d+ 张/.test(document.querySelector('.page-sub').textContent), '副标题报出了卡片总数');
        chk(!document.querySelector('#main .pk-card.pk-formula') ||
            /[=\\\\]/.test(document.querySelector('#main .pk-card.pk-formula').textContent),
            '★ 公式卡里没有纯碎片（都带等号或 LaTeX 命令）');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    const totalCells = await evalVal('document.querySelectorAll("#main .pk-cell").length');

    // B3：按类型筛选
    await evalVal("window.App.setDeckFilter('pitfall')");
    await sleep(200);
    cardOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var n = document.querySelectorAll('#main .pk-cell').length;
        var p = document.querySelectorAll('#main .pk-card.pk-pitfall').length;
        chk(n >= 1 && n === p, '★ 筛选「易错点」后只剩易错卡（' + n + ' / ' + p + '）');
        chk(n < ${totalCells}, '确实比全部少了（' + n + ' < ${totalCells}）');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));
    await evalVal("window.App.setDeckFilter('all')");
    await sleep(200);

    // B4：导出 —— 把 window.print 换掉，否则无头浏览器会卡在打印对话框
    await evalVal('window.__printHtml = ""; window.print = function () { window.__printHtml = document.getElementById("print-root").innerHTML; };');
    await evalVal('window.App.exportCards()');
    await sleep(500);
    cardOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var h = window.__printHtml || '';
        chk(h.length > 300, '★ 打印容器被填上了内容（' + h.length + ' 字符）');
        chk(h.indexOf('pk-cover') >= 0, '★ 打印版有封面块');
        chk(h.indexOf('class="pk-card') >= 0, '打印版有卡片');
        chk(h.indexOf('pk-del') < 0, '★ 打印版里没有删除按钮');
        chk(h.indexOf('pk-src') < 0, '打印版里没有来源角标');
        chk(h.indexOf('课堂复习卡片') >= 0, '打印版有标题');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    // B5：切到打印媒体，验证「打印出来只剩卡片」这件事真的成立
    await client.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(200);
    cardOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var d = function (id) { var e = document.getElementById(id); return e ? getComputedStyle(e).display : '不存在'; };
        chk(d('app') === 'none', '★ 打印时整个应用界面被隐藏（#app = ' + d('app') + '）');
        chk(d('toast-root') === 'none', '打印时提示条被隐藏');
        chk(d('print-root') === 'grid', '★ 打印时卡片容器显示为两栏网格（' + d('print-root') + '）');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));
    await client.send('Emulation.setEmulatedMedia', { media: 'screen' });

    const cardErrs = JSON.parse(await evalVal('JSON.stringify(window.__errors || [])') || '[]');

    console.log('\n=== 卡片库：课堂记录 → 卡片 → 导出 ===');
    cardOut.forEach(l => console.log('  ' + l));
    passes += cardOut.filter(l => l.startsWith('✓')).length;
    fails += cardOut.filter(l => l.startsWith('✗')).length;

    /* ================= C. 学习引擎 v2：公式实验室 · 闪电战 · 解析公式渲染 ================= */
    /* 这一段的三个点都是「静态检查查不出来」的：
       · 画布到底画没画上东西（选择器对了但画布空白，一样是白屏体验）
       · 拖滑块后读数有没有跟着变
       · 答案解析里的 LaTeX 有没有真的过 KaTeX（不过就是一堆反斜杠源码） */
    const v2Out = [];

    const goto = async (route) => {
      await client.send('Page.navigate', { url: parts[0] + '?n=' + Date.now() + '#/' + route });
      const dl = Date.now() + 15000;
      while (Date.now() < dl) {
        const v = String(await evalVal(
          'document.readyState + "|" + (typeof window.App) + "|" + ' +
          '(document.getElementById("main") ? document.getElementById("main").innerHTML.length : 0)') || '');
        const m = v.split('|');
        if (m[0] === 'complete' && m[1] === 'object' && parseInt(m[2], 10) > 200) break;
        await sleep(120);
      }
      await sleep(250);
    };

    // C1：公式实验室 —— 四个模块都能画出东西
    await goto('lab');
    v2Out.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var tabs = document.querySelectorAll('.lab-tabs .lab-tab');
        chk(tabs.length >= 4, '公式实验室有 ' + tabs.length + ' 个模块标签');
        chk(!!document.querySelector('.lab-tab.on'), '有一个标签处于选中态');
        chk(document.querySelectorAll('.lab-ctrl input[type=range]').length >= 1, '至少有一个可拖滑块');
        var cv = document.getElementById('lab-canvas');
        chk(!!cv, '画布元素存在');
        chk(!!cv && cv.width > 100 && cv.height > 100, '画布有实际尺寸（' + (cv ? cv.width + '×' + cv.height : '无') + '）');
        chk(!!cv && getComputedStyle(cv).height !== '0px', '★ 画布的 CSS 高度生效了（不是被压成 0）');
        // 真去数非透明像素 —— 元素存在但一片空白是最常见的"假通过"
        var painted = -1;
        if (cv) {
          var g = cv.getContext('2d');
          var d = g.getImageData(0, 0, cv.width, cv.height).data;
          painted = 0;
          for (var i = 3; i < d.length; i += 4) if (d[i] !== 0) painted++;
        }
        chk(painted > 500, '★ 画布上真的画了东西（' + painted + ' 个非透明像素）');
        var rows = document.querySelectorAll('.lab-readout .lab-row');
        chk(rows.length >= 2, '读数区有 ' + rows.length + ' 行');
        var vd = document.getElementById('lab-verdict');
        chk(!!vd && vd.textContent.length > 4, '★ 给了一句结论（' + (vd ? vd.textContent.slice(0, 24) : '无') + '…）');
        chk(document.querySelector('.lab-verdict') && getComputedStyle(document.querySelector('.lab-verdict')).backgroundColor !== 'rgba(0, 0, 0, 0)',
            '结论块的样式生效了（有底色）');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    // C2：拖滑块 → 读数跟着变（不然"可交互"是假的）
    const beforeH = await evalVal('document.querySelector("#lab-readout .lab-row b").textContent');
    await evalVal("window.App.labSet('derivative', 'h', 0.01)");
    await sleep(300);
    const afterH = await evalVal('document.querySelector("#lab-readout .lab-row b").textContent');
    v2Out.push('  ' + (beforeH !== afterH ? '✓' : '✗') +
      ' 拖动滑块后读数确实变了（' + beforeH + ' → ' + afterH + '）');

    // C3：切模块 —— 不能只是换了个标题，画布要重画
    await goto('lab/riemann');
    v2Out.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        chk(/定积分/.test(document.querySelector('.lab-title').textContent), '★ 切到了「定积分」模块');
        chk(document.querySelectorAll('.lab-ctrl select').length >= 1, '该模块有下拉控件（取点方式）');
        var cv = document.getElementById('lab-canvas');
        var painted = -1;
        if (cv) {
          var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          painted = 0;
          for (var i = 3; i < d.length; i += 4) if (d[i] !== 0) painted++;
        }
        chk(painted > 500, '★ 切模块后画布重画了（' + painted + ' 个非透明像素）');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    // C4：闪电战 —— 开局 / 答题 / 扣命
    await goto('blitz');
    v2Out.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        chk(/60 秒/.test(document.getElementById('main').textContent), '规则里写明 60 秒限时');
        chk(typeof window.App.blitzStart === 'function', 'App.blitzStart 可调用');
        chk(!!document.querySelector('.blitz-rules'), '规则列表渲染出来了');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    await evalVal('window.App.blitzStart()');
    await sleep(300);
    v2Out.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        chk(!!document.querySelector('.blitz-hud'), 'HUD 渲染出来了');
        var lives = document.querySelectorAll('.blitz-lives .life');
        chk(lives.length === 3, 'HUD 上是 3 条命');
        chk(document.querySelectorAll('.blitz-lives .life.on').length === 3, '开局 3 条命都是亮的');
        chk(/^\\d+s$/.test((document.querySelector('.blitz-clock') || {}).textContent || ''), '倒计时在走（' + (document.querySelector('.blitz-clock') || {}).textContent + '）');
        chk(document.querySelectorAll('.blitz-body .opt, #blitz-body .opt, #blitz-body .fill-row').length >= 1 ||
            !!document.querySelector('#blitz-body .opt') || !!document.querySelector('#blitz-body .fill-row'),
            '题干下方有作答区');
        chk(!!document.querySelector('#blitz-bar'), '倒计时进度条存在');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    // 故意答错，验证「命当场就少一条」+ 解析走了公式渲染
    await evalVal("window.App.blitzAnswer('__definitely_wrong__')");
    await sleep(250);
    v2Out.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        chk(document.querySelectorAll('.blitz-lives .life.on').length === 2,
            '★ 答错后当场少一条命（剩 ' + document.querySelectorAll('.blitz-lives .life.on').length + ' 条）');
        var fb = document.getElementById('blitz-feedback');
        chk(!!fb && fb.className.indexOf('no') >= 0, '反馈区标成答错态');
        chk(!!fb && fb.textContent.length > 4, '反馈里写出了正确答案');
        chk(!!fb && fb.textContent.indexOf('答案：答案：') < 0, '★ 没有出现「答案：答案：」这种重复前缀');
        // 冒烟页的 KaTeX 是桩，桩会把原始 tex 放进自己的 span 里，
        // 所以判据是「剔除渲染过的片段之后，外面不能再有裸露的反斜杠」。
        var BS = String.fromCharCode(92);
        var bare = fb ? fb.innerHTML.replace(/<span class="katex-stub">[\\s\\S]*?<\\/span>/g, '') : '';
        chk(!!fb && bare.indexOf(BS) < 0,
            '★ 反馈里没有裸露的 LaTeX 源码（公式都进了渲染器）');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    // C5：做完一题后，解析里的公式必须过 KaTeX
    //     （冒烟页把 KaTeX 换成了 stub，所以只要解析走了渲染器就会留下 .katex-stub）
    await evalVal(`(function () {
      var BS = String.fromCharCode(92);
      var pick = null;
      for (var i = 0; i < QDATA.length; i++) {
        var x = QDATA[i];
        if (x.type === 'choice' && x.analysis && x.analysis.indexOf(BS) >= 0 && x.options && x.options.length) { pick = x; break; }
      }
      if (!pick) return 'none';
      var st = JSON.parse(localStorage.getItem('kaoyan_math_tutor_v1') || '{}');
      var t = window.Game.fmtToday();
      st.daily = { date: t, reviewIds: [], newIds: [], quizIds: [pick.id], reviewDoneIds: [], newDoneIds: [], quizDoneIds: [] };
      localStorage.setItem('kaoyan_math_tutor_v1', JSON.stringify(st));
      return pick.id;
    })()`);
    await goto('quiz');
    const quizQid = await evalVal('document.querySelector(".q-card") ? 1 : 0');
    v2Out.push('  ' + (quizQid ? '✓' : '✗') + ' 每日一练渲染出题目（种子生效）');
    await evalVal('(function () { var o = document.querySelector("#main .opt"); if (o) o.click(); })()');
    await sleep(300);
    v2Out.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var ans = document.querySelector('#main .ans');
        chk(!!ans, '答完后出现了「解析」区块');
        chk(!!ans && ans.textContent.indexOf('答案：') >= 0, '解析里有答案');
        var BS = String.fromCharCode(92);
        var bare = ans ? ans.innerHTML.replace(/<span class="katex-stub">[\\s\\S]*?<\\/span>/g, '') : '';
        chk(!!ans && bare.indexOf(BS) < 0,
            '★ 解析里没有裸露的 LaTeX 源码（公式都进了渲染器）');
        chk(!!ans && !!ans.querySelector('.katex-stub'),
            '★ 解析确实交给了公式渲染器（含 .katex-stub）');
        var xp = document.querySelector('#main .xp-note');
        chk(!!xp, '★ 答完后显示了本次拿到的 XP');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    const v2Errs = JSON.parse(await evalVal('JSON.stringify(window.__errors || [])') || '[]');

    console.log('\n=== 学习引擎 v2：公式实验室 · 闪电战 · 解析公式渲染 ===');
    v2Out.forEach(l => console.log('  ' + l));
    passes += v2Out.filter(l => l.startsWith('✓')).length;
    fails += v2Out.filter(l => l.startsWith('✗')).length;

    /* ================= D. 小屏布局 · 无障碍 · 存档告警 ================= */
    const dOut = [];

    /* D1 无障碍（桌面宽度） */
    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var skip = document.querySelector('.skip-link');
        chk(!!skip, '跳过导航链接存在');
        chk(!!skip && getComputedStyle(skip).position === 'absolute',
            '★ 跳过链接用移出视口而不是 display:none（后者拿不到焦点，等于没写）');
        chk(document.getElementById('main').getAttribute('tabindex') === '-1', '#main 可被程序化聚焦');
        chk(typeof window.App.focusMain === 'function', 'App.focusMain 可调用');
        chk(typeof window.App.toggleNav === 'function', 'App.toggleNav 可调用');
        var nav = document.getElementById('nav');
        chk(!!nav && !!nav.getAttribute('aria-label'), '主导航有 aria-label');
        chk(document.getElementById('toast-root').getAttribute('aria-live') === 'polite',
            'toast 容器是 live region');
        var al = document.getElementById('storage-alert');
        chk(!!al, '存档告警容器存在');
        chk(!!al && al.getAttribute('role') === 'alert', '★ 告警用 role=alert（读屏器会打断播报）');
        var tg = document.getElementById('nav-toggle');
        chk(!!tg && !!tg.getAttribute('aria-controls'), '导航按钮声明了 aria-controls');
        /* 图标必须全部 aria-hidden，否则读屏器会把每个 path 都念一遍 */
        var icons = document.querySelectorAll('#nav svg.ic');
        var bad = 0;
        icons.forEach(function (el) { if (el.getAttribute('aria-hidden') !== 'true') bad++; });
        chk(icons.length > 0 && bad === 0,
            '★ 侧栏 ' + icons.length + ' 个图标全部 aria-hidden（漏标 ' + bad + ' 个）');
        var mark = document.querySelector('.brand-mark');
        chk(!!mark && mark.getAttribute('aria-hidden') === 'true', '品牌标记（装饰性积分号）也标了 aria-hidden');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    /* D2 统计页的图表必须给读屏器一句文字摘要 */
    await goto('stats');
    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var imgs = document.querySelectorAll('#main svg[role="img"]');
        chk(imgs.length >= 2, '★ 统计页两张图都标了 role=img（找到 ' + imgs.length + ' 个）');
        var bad = 0;
        imgs.forEach(function (s) {
          if (!s.getAttribute('aria-label') || s.getAttribute('aria-label').length < 8) bad++;
        });
        chk(imgs.length > 0 && bad === 0, '★ 每张图都带一句 aria-label 摘要（缺 ' + bad + ' 个）');
        var trend = document.querySelector('#main svg[role="img"]');
        chk(!!trend && trend.getAttribute('aria-label').indexOf('正确率') >= 0,
            '折线图的摘要说的是正确率（' + (trend ? trend.getAttribute('aria-label').slice(0, 40) : '') + '…）');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    /* D3 公式实验室的画布 */
    await goto('lab');
    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var cv = document.getElementById('lab-canvas');
        chk(!!cv, '实验室画布存在');
        chk(!!cv && cv.getAttribute('role') === 'img', '★ 画布标了 role=img');
        chk(!!cv && (cv.getAttribute('aria-label') || '').length > 10,
            '★ 画布有 aria-label 说明（画布内容对读屏器完全不可见）');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    /* D4 小屏：375×812（iPhone 尺寸） */
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 812, deviceScaleFactor: 2, mobile: true
    });
    await sleep(500);
    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var sb = document.getElementById('sidebar');
        var tg = document.getElementById('nav-toggle');
        chk(window.innerWidth <= 400, '视口确实切到了 375px（innerWidth=' + window.innerWidth + '）');
        chk(!!tg && getComputedStyle(tg).display !== 'none', '★ 小屏下导航按钮出现');
        chk(!!sb && getComputedStyle(sb).position === 'fixed', '★ 侧栏改成固定定位（抽屉模式）');
        var box = sb.getBoundingClientRect();
        chk(box.right <= 2, '★ 抽屉默认收在视口外（right=' + Math.round(box.right) + '）');
        var main = document.getElementById('main');
        var mw = main.getBoundingClientRect().width;
        chk(mw > 330, '★ 主内容占满屏宽（' + Math.round(mw) + ' / 375）');
        chk(document.documentElement.scrollWidth <= window.innerWidth + 1,
            '★ 没有横向溢出（scrollWidth=' + document.documentElement.scrollWidth + '）');
        var sc = document.getElementById('nav-scrim');
        chk(!!sc && sc.hidden, '遮罩默认隐藏');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    /* 点开抽屉 → 滑入 + 遮罩 + aria 同步；Esc 关掉 */
    await evalVal('document.getElementById("nav-toggle").click()');
    await sleep(320);
    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var sb = document.getElementById('sidebar');
        var tg = document.getElementById('nav-toggle');
        var sc = document.getElementById('nav-scrim');
        chk(sb.getBoundingClientRect().left >= -1, '★ 点按钮后抽屉滑入（left=' + Math.round(sb.getBoundingClientRect().left) + '）');
        chk(!!sc && !sc.hidden, '★ 遮罩出现');
        chk(!!tg && tg.getAttribute('aria-expanded') === 'true', '★ aria-expanded 同步为 true');
        chk(document.body.classList.contains('nav-locked'), '★ 抽屉打开时锁住背后滚动');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    await evalVal('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await sleep(320);
    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var sb = document.getElementById('sidebar');
        var tg = document.getElementById('nav-toggle');
        var sc = document.getElementById('nav-scrim');
        chk(sb.getBoundingClientRect().right <= 2, '★ Esc 能收起抽屉');
        chk(!!sc && sc.hidden, '遮罩跟着收起');
        chk(!!tg && tg.getAttribute('aria-expanded') === 'false', 'aria-expanded 复位');
        chk(!document.body.classList.contains('nav-locked'), '滚动锁解除');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    await client.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    /* D5 存档告警：让 save() 真的失败一次，看横幅会不会出现、恢复后会不会撤掉。
       这一段必须在最后 —— 它要 monkeypatch localStorage，之后不能再整页导航。 */
    await goto('settings');
    const patchRes = await evalVal(`(function () {
      try {
        var orig = localStorage.setItem.bind(localStorage);
        window.__origSetItem = orig;
        localStorage.setItem = function (k) {
          if (k === 'kaoyan_math_tutor_v1') {
            var e = new Error('quota exceeded');
            e.name = 'QuotaExceededError';
            throw e;
          }
          return orig.apply(localStorage, arguments);
        };
        return 1;
      } catch (e) { return 'patch 失败：' + e.message; }
    })()`);
    dOut.push('  ' + (patchRes === 1 ? '✓' : '✗') + ' 已模拟存储写入失败（' + patchRes + '）');

    const triggered = await evalVal(`(function () {
      var el = document.getElementById('set-exam');
      if (!el) return 0;
      el.value = '2026-12-26';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 1;
    })()`);
    await sleep(300);
    dOut.push('  ' + (triggered === 1 ? '✓' : '✗') + ' 触发了写盘（改考试日期会调 save()）');

    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var al = document.getElementById('storage-alert');
        chk(!!al && !al.hidden, '★ 写盘失败时常驻横幅出现（不再静默吞掉）');
        chk(!!al && al.textContent.indexOf('没有保存成功') >= 0, '横幅说清了是什么事');
        chk(!!al && al.textContent.indexOf('导出备份') >= 0, '★ 横幅里直接给了「导出备份」按钮');
        chk(document.body.classList.contains('has-storage-alert'), '正文底部让出了横幅的位置');
        chk(typeof window.App.exportData === 'function', 'App.exportData 可调用');
        chk(typeof window.App.dismissStorageAlert === 'function', 'App.dismissStorageAlert 可调用');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    /* 恢复写入后再存一次 —— 横幅应该自己撤掉，而不是一直挂着 */
    await evalVal('(function(){ if (window.__origSetItem) { localStorage.setItem = function (k, v) { return window.__origSetItem(k, v); }; } return 1; })()');
    await evalVal(`(function () {
      var el = document.getElementById('set-exam');
      if (el) { el.value = '2026-12-26'; el.dispatchEvent(new Event('change', { bubbles: true })); }
      return 1;
    })()`);
    await sleep(300);
    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var al = document.getElementById('storage-alert');
        chk(!!al && al.hidden, '★ 写入恢复后横幅自动撤掉');
        chk(!document.body.classList.contains('has-storage-alert'), '底部留白也收回了');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    /* D6 设置页上的数据与诊断面板真的渲染出来了 */
    dOut.push(...(await runProbe(`(function () {
      try {
        var r = [], chk = function (o, l) { r.push((o ? '\\u2713 ' : '\\u2717 ') + l); };
        var txt = document.getElementById('main').textContent;
        chk(txt.indexOf('数据与备份') >= 0, '设置页有「数据与备份」卡片');
        chk(txt.indexOf('导出备份') >= 0, '有导出按钮');
        chk(txt.indexOf('导入并合并') >= 0, '有合并导入按钮');
        chk(txt.indexOf('覆盖导入') >= 0, '有覆盖导入按钮');
        chk(!!document.getElementById('data-import-file'), '导入用的文件选择器存在');
        chk(txt.indexOf('存储用量') >= 0, '显示了存储用量');
        chk(txt.indexOf('上次备份') >= 0, '显示了上次备份时间');
        chk(txt.indexOf('诊断') >= 0, '设置页有「诊断」卡片');
        chk(typeof window.App.copyDiagnostics === 'function', 'App.copyDiagnostics 可调用');
        chk(typeof window.App.exportDiagnostics === 'function', 'App.exportDiagnostics 可调用');
        chk(typeof window.App.clearDiagnostics === 'function', 'App.clearDiagnostics 可调用');
        chk(!!window.Store && typeof window.Store.bundle === 'function', 'Store 模块已加载');
        chk(!!window.Telemetry && typeof window.Telemetry.report === 'function', 'Telemetry 模块已加载');
        /* 导出包默认不带 Key —— 用真实 state 验一遍 */
        var b = window.Store.bundle({ settings: { llm: { cloudKey: 'sk-x' } }, attempts: [] }, {});
        chk(b.data.settings.llm.cloudKey === '', '★ 导出包里的 API Key 被清空');
        chk(b.keyStripped === true, '★ 并且标记了已剥离');
        return r.join('\\n');
      } catch (e) { return '\\u2717 探针抛异常：' + (e && e.message); }
    })()`)).split('\n').filter(Boolean));

    const dErrs = JSON.parse(await evalVal('JSON.stringify(window.__errors || [])') || '[]');

    console.log('\n=== 小屏布局 · 无障碍 · 存档告警 ===');
    dOut.forEach(l => console.log('  ' + l));
    passes += dOut.filter(l => l.startsWith('✓')).length;
    fails += dOut.filter(l => l.startsWith('✗')).length;

    const allErr = jsErrs.concat(consoleErrors, cardErrs, v2Errs, dErrs);
    if (allErr.length) {
      fails++;
      console.log('  ✗ 页面有 JS 报错：');
      allErr.slice(0, 6).forEach(e => console.log('      ' + String(e).slice(0, 160)));
    } else {
      passes++;
      console.log('  ✓ 整页没有 JS 报错');
    }
    if (fails) code = 1;
  } catch (e) {
    console.log('\n=== 无头 Chromium 渲染课堂页 ===');
    console.log('  ✗ 冒烟测试没能跑起来：' + e.message);
    if (procErr) console.log('    ' + procErr.split('\n').filter(Boolean).slice(0, 4).join('\n    '));
    fails = 1; code = 1;
  } finally {
    if (client) client.close();
    try { proc.kill('SIGKILL'); } catch (e) { }
    server.close();
    try { fs.unlinkSync(SMOKE); } catch (e) { }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }

  console.log('\n' + '─'.repeat(40));
  console.log((code === 0 ? '✅ 浏览器冒烟通过：' : '❌ 有失败：') + passes + ' 项' + (fails ? '，失败 ' + fails : ''));
  process.exit(code);
})();
