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
        chk(sw === '214px', '样式表确实加载了（左栏 ' + sw + '，窗口 ' + innerWidth + 'px）');
        var weak = document.getElementById('c-st-weak');
        chk(!!weak && weak.textContent.length > 0, '丙的状态位有内容（' + (weak ? weak.textContent : '无') + '）');
        chk(!!document.querySelector('.c-ava-weak'), '丙的头像配色类存在');
        return r.join('\\n');
      } catch (e) {
        return '\\u2717 探针自身抛异常：' + (e && e.message);
      }
    })()`;

    const res = await client.send('Runtime.evaluate', { expression: probe, returnByValue: true });
    out = String(res.result.value || '').split('\n').filter(Boolean);

    const pageErrs = (await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__errors || [])', returnByValue: true
    })).result.value;
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

    const allErr = jsErrs.concat(consoleErrors);
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
