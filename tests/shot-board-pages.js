#!/usr/bin/env node
/* 黑板分页的验收截图。只在本地跑，不进测试套件。
 *
 *   node tests/shot-board-pages.js
 *
 * 为什么不复用 shots.js：那个脚本走「注入通用种子 → 抓关键页面」，
 * 而分页要的是一份**多页黑板**的种子 —— 通用种子里没有，也就截不出导航。
 *
 * 输出到 ../outputs/board-pages/。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const OUT = process.env.SHOT_DIR || path.join(REPO, '..', 'outputs', 'board-pages');
fs.mkdirSync(OUT, { recursive: true });

const SMOKE = path.join(__dirname, '.shot-pages.html');
const HOME = os.homedir();

function findBrowser() {
  const glob = [
    path.join(HOME, 'Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    path.join(HOME, 'Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-x64/chrome-headless-shell'),
    path.join(HOME, '.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell')
  ];
  for (const g of glob) {
    const dir = path.dirname(g), base = path.dirname(dir);
    if (!fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const v of versions) {
      const bin = g.replace('*', v.replace('chromium_headless_shell-', ''));
      if (fs.existsSync(bin)) return { bin, kind: 'shell' };
    }
  }
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ];
  for (const c of cands) if (fs.existsSync(c)) return { bin: c, kind: 'chrome' };
  return null;
}
const BROWSER = findBrowser();
if (!BROWSER) { console.log('没找到 Chromium，跳过截图'); process.exit(0); }

/* 从 index.html 生成截图页 —— 不手写第二份骨架，保证跟真实页面一致 */
let html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
html = html.replace(/ data-page-node-id="[^"]*"/g, '');
html = html.replace(/(src|href)="(?!https?:|#)([^"]+)"/g, '$1="../$2"');
html = html.replace(/<link[^>]*katex[^>]*>\s*/gi, '');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*katex[^"]*"><\/script>/gi,
  `<script>window.katex={renderToString:function(t){return '<span class="katex-stub">'+String(t)+'</span>';}};</script>`);
fs.writeFileSync(SMOKE, html);

/* 一份两页黑板的课堂记录：第 1 页留一条旧内容，第 2 页是这节课写的 */
const seeded = {
  classrooms: {
    c1n4: {
      kid: 'c1n4', mode: 'lesson', stage: 'done',
      question: {
        id: 'q1', kid: 'c1n4', type: 'choice',
        stem: '求极限 lim (tan x − sin x) / x³',
        options: [{ k: 'A', t: '1/2' }, { k: 'B', t: '0' }],
        answer: 'A', analysis: 'tan x − sin x 等价于 x³/2，所以极限是 $1/2$。'
      },
      reason: '你在这一节错过 3 次',
      turns: [
        { role: 'teacher', text: '这一步讲完了。当 x 趋于 0 时，sin x 等价于 x。' },
        { role: 'average', text: '那为什么不能拆开代换呢？' },
        { role: 'weak', text: '我觉得是 0 吧，两个都换成 x 就减没了。' },
        { role: 'teacher', text: '学生丙把等价代换当成了普通约分，这是典型混淆。加减中不能随便代换。' },
        { role: 'teacher', text: '这节课记住两件事：\n1. 等价代换只能用于乘除因子，加减中慎用。\n2. 遇到 tan x − sin x 要先提取公因式。' }
      ],
      spoken: [], userTurns: [], memory: {},
      moves: { focus: 4, probing: 2, telling: 1 },
      board: [
        { by: 'teacher', kind: 'latex', tex: 'x^2', note: '上一段留下的式子' },
        { by: 'teacher', kind: 'page', title: '等价代换的应用' },
        {
          by: 'teacher', kind: 'steps', title: '求 lim (tan x − sin x)/x³',
          steps: ['提取公因式 tan x', '用 1−cos x ~ x²/2', '得极限 1/2']
        },
        { by: 'teacher', kind: 'latex', tex: '\\lim_{x\\to 0}\\frac{\\sin x}{x}=1', note: '第一个重要极限' },
        {
          by: 'weak', kind: 'graph', expr: 'a*sin(x)/x', xmin: -6, xmax: 6,
          params: [{ name: 'a', value: 1, min: 0, max: 3, step: 0.5 }],
          yRange: [-1.5, 3]
        },
        { by: 'teacher', kind: 'highlight', target: '提取公因式' }
      ]
    }
  },
  /* 让 llmOn() 成立，课堂页才会走完整的渲染路径（字段名见 test-browser.js 的注释） */
  settings: {
    llm: {
      enabled: true, kind: 'local',
      localBase: 'http://127.0.0.1:1', localModel: 'test-model', localName: 'test'
    }
  }
};

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
    } else if (msg.method) { listeners.forEach(fn => fn(msg)); }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('CDP 连不上')));
  });
  return {
    ready,
    send(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
      });
    },
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
  throw new Error('浏览器没报出调试端口');
}

(async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/tests/.shot-pages.html#/class/c1n4';

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-shot-'));
  const args = [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1440,1200',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ];
  if (BROWSER.kind === 'chrome') args.unshift('--headless=new');

  const proc = spawn(BROWSER.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let client = null;
  try {
    const dbgPort = await waitPort(path.join(profile, 'DevToolsActivePort'), 20000);
    const list = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/list')).json();
    const page = list.find(t => t.type === 'page');
    if (!page) throw new Error('没有可用的页面目标');

    client = cdp(page.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 1200, deviceScaleFactor: 2, mobile: false });

    /* 先种数据再导航 —— localStorage 得在页面 load() 之前就位 */
    await client.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/tests/.shot-pages.html' });
    await sleep(400);
    await client.send('Runtime.evaluate', {
      expression: 'localStorage.setItem("kaoyan_math_tutor_v1", ' +
        JSON.stringify(JSON.stringify(seeded)) + ')'
    });
    await client.send('Page.navigate', { url });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const s = await client.send('Runtime.evaluate', {
        expression: 'document.readyState + "|" + (typeof window.App) + "|" + (document.querySelectorAll(".c-roster-item").length)',
        returnByValue: true
      });
      if (String(s.result.value || '').indexOf('complete|object|4') === 0) break;
      await sleep(150);
    }
    await sleep(600);

    const evalVal = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      return r.result ? r.result.value : undefined;
    };
    const shoot = async (name) => {
      const r = await client.send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(OUT, name + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('  ✓ ' + f);
    };

    const navTxt = await evalVal(
      '(function(){var e=document.querySelector(".c-board-nav-label");return e?e.textContent:"（没有导航）";})()');
    const blocks = await evalVal('document.querySelectorAll(".c-board-item").length');
    console.log('默认页：' + navTxt + '，' + blocks + ' 块');

    /* 黑板在页面下方 —— 不滚过去就只截到聊天流 */
    await evalVal('(function(){var e=document.querySelector(".class-board")||document.getElementById("c-board");' +
      'if(e)e.scrollIntoView({block:"start"});window.scrollBy(0,-20);})()');
    await sleep(350);

    /* 顺带报一下按钮状态：截图上「可点」和「禁用」都是灰的，光看图分不出来 */
    const btnState = await evalVal(`(function () {
      var f = function (b) {
        if (!b) return '无';
        return (b.disabled ? '禁用' : '可点') + '/opacity ' + getComputedStyle(b).opacity;
      };
      return '上一页 ' + f(document.querySelector('[data-role="board-prev"]')) +
        '，下一页 ' + f(document.querySelector('[data-role="board-next"]'));
    })()`);
    console.log('按钮：' + btnState);

    await shoot('01-最新页');

    await evalVal('(function(){var b=document.querySelector(\'[data-role="board-prev"]\');if(b)b.click();})()');
    await sleep(400);
    const navTxt2 = await evalVal(
      '(function(){var e=document.querySelector(".c-board-nav-label");return e?e.textContent:"（没有导航）";})()');
    const blocks2 = await evalVal('document.querySelectorAll(".c-board-item").length');
    console.log('翻上一页后：' + navTxt2 + '，' + blocks2 + ' 块');
    await shoot('02-上一页');

    /* 顺带截一张卡片库：黑板上写的公式与步骤现在也进去了。
       必须调 makeCards（它才真的跑蒸馏并落盘），直接改 hash 会看到空态。 */
    await evalVal("window.App.makeCards('c1n4')");
    await sleep(800);
    await shoot('03-卡片库含解题步骤卡');
  } catch (e) {
    console.log('截图失败：' + (e && e.message));
    process.exitCode = 1;
  } finally {
    if (client) client.close();
    try { proc.kill(); } catch (e) { }
    server.close();
  }
})();
