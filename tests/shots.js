#!/usr/bin/env node
/* 截图验收：手机尺寸（375×812）与桌面尺寸的关键页面。
 * 只在本地跑，不进测试套件。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const OUT = process.env.SHOT_DIR || path.join(REPO, '..', 'outputs', 'commercial-v1');
fs.mkdirSync(OUT, { recursive: true });

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
    for (const v of fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const bin = g.replace('*', v.replace('chromium_headless_shell-', ''));
      if (fs.existsSync(bin)) return { bin, kind: 'shell' };
    }
  }
  const c = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  for (const x of c) if (fs.existsSync(x)) return { bin: x, kind: 'chrome' };
  return null;
}
const BROWSER = findBrowser();
if (!BROWSER) { console.log('没找到 Chromium'); process.exit(0); }

const SMOKE = path.join(REPO, 'tests', '.shot.html');
let html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
html = html.replace(/ data-page-node-id="[^"]*"/g, '');
html = html.replace(/(src|href)="(?!https?:|#)([^"]+)"/g, '$1="../$2"');
html = html.replace(/<link[^>]*katex[^>]*>\s*/gi, '');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*katex[^"]*"><\/script>/gi,
  `<script>window.katex={renderToString:function(t){return '<span class="katex-stub">'+String(t)+'</span>';}};</script>`);

/* 注入一份有内容的存档，不然截出来全是空态 */
const seed = `
<script>
(function () {
  function d(off) { var x = new Date(); x.setDate(x.getDate() - off); return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
  var attempts = [], i = 0;
  var qs = [['q01','c1n2'],['q04','c1n4'],['q02','c1n3'],['q05','c1n5']];
  for (var day = 0; day < 24; day++) {
    for (var k = 0; k < 4; k++) {
      var q = qs[i % qs.length];
      attempts.push({ id: 'a' + i, qid: q[0], kid: q[1], answer: 'A',
        correct: (i % 9) !== 0, context: 'practice', date: d(day), ts: Date.now() - day * 86400000 + i * 1000 });
      i++;
    }
  }
  var checkins = {};
  for (var x = 0; x < 24; x++) checkins[d(x)] = { minutes: 20 + (x % 5) * 10 };
  localStorage.setItem('kaoyan_math_tutor_v1', JSON.stringify({
    attempts: attempts, checkins: checkins, cards: {}, customQ: [], notes: {}, classrooms: {},
    cardDeck: {}, chats: {}, daily: null,
    game: { xp: 1450, achievements: { first_step: true, streak7: true }, combo: 4, bestCombo: 11,
            boss: {}, flags: {}, seen: {} },
    settings: { examTrack: 'math1', dailyNew: 2, examDate: '2026-12-26', persona: 'strict',
                lastExportAt: new Date(Date.now() - 21 * 86400000).toISOString(),
                llm: { enabled: true, kind: 'cloud', base: 'https://api.deepseek.com', model: 'deepseek-chat',
                       localBase: 'http://127.0.0.1:1234/v1', localModel: '', localName: '',
                       cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat',
                       cloudKey: '', rememberKey: false } }
  }));
})();
</script>`;
html = html.replace('<script src=', seed + '\n<script src=');
fs.writeFileSync(SMOKE, html);

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(REPO, p);
  if (!f.startsWith(REPO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)] || 'text/plain';
  res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
  res.end(fs.readFileSync(f));
});

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0; const waiting = new Map(); const listeners = [];
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
    else if (m.method) listeners.forEach(fn => fn(m));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('连不上'))); });
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
    on(fn) { listeners.push(fn); },
    close() { try { ws.close(); } catch (e) { } }
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-shot-'));
  const args = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--window-size=1440,900',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'];
  if (BROWSER.kind === 'chrome') args.unshift('--headless=new');
  const proc = spawn(BROWSER.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let client = null;
  try {
    const dbg = path.join(profile, 'DevToolsActivePort');
    let dbgPort = 0;
    for (let t = Date.now(); Date.now() - t < 20000;) {
      if (fs.existsSync(dbg)) { const l = fs.readFileSync(dbg, 'utf8').trim().split('\n'); if (l[0]) { dbgPort = parseInt(l[0], 10); break; } }
      await sleep(80);
    }
    const list = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/list')).json();
    const page = list.find(t => t.type === 'page');
    client = cdp(page.webSocketDebuggerUrl);
    await client.ready;
    const errs = [];
    client.on(m => {
      if (m.method === 'Runtime.exceptionThrown') errs.push('异常：' + ((m.params.exceptionDetails.exception || {}).description || '').split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('console.error：' + m.params.args.map(a => a.value || a.description || '').join(' '));
    });
    await client.send('Runtime.enable');
    await client.send('Page.enable');

    const goto = async (route, w, h) => {
      await client.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
      await client.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/tests/.shot.html?n=' + Date.now() + '#/' + String(route).replace(/^\//, '') });
      for (let t = Date.now(); Date.now() - t < 15000;) {
        const r = await client.send('Runtime.evaluate', {
          expression: 'document.readyState + "|" + (typeof window.App) + "|" + (document.getElementById("main") ? document.getElementById("main").innerHTML.length : 0)',
          returnByValue: true
        });
        const v = String(r.result.value || '').split('|');
        if (v[0] === 'complete' && v[1] === 'object' && parseInt(v[2], 10) > 200) break;
        await sleep(120);
      }
      await sleep(700);
      const dbg = await client.send('Runtime.evaluate', {
        expression: 'location.hash + " | " + (document.querySelector(".page-title") ? document.querySelector(".page-title").textContent : "无标题")',
        returnByValue: true
      });
      console.log('      → ' + dbg.result.value);
    };
    const shot = async (name, full) => {
      const r = await client.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: !!full
      });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
      console.log('  ✓ ' + name + '.png');
    };

    console.log('手机尺寸 375×812：');
    for (const [route, name] of [['', 'mobile-dashboard'], ['quiz', 'mobile-quiz'], ['stats', 'mobile-stats'], ['settings', 'mobile-settings'], ['lab', 'mobile-lab']]) {
      await goto(route, 375, 812);
      await shot(name);
    }
    /* 抽屉展开态 */
    await goto('', 375, 812);
    await client.send('Runtime.evaluate', { expression: 'document.getElementById("nav-toggle").click()' });
    await sleep(420);
    await shot('mobile-drawer-open');

    console.log('桌面尺寸 1440×900：');
    for (const [route, name] of [['', 'desktop-dashboard'], ['settings', 'desktop-settings'], ['stats', 'desktop-stats']]) {
      await goto(route, 1440, 900);
      await shot(name, true);
    }

    if (errs.length) { console.log('\n⚠ 页面报错：'); errs.slice(0, 8).forEach(e => console.log('   ' + e.slice(0, 160))); }
    else console.log('\n✓ console 报错 0 条');
  } catch (e) {
    console.log('截图失败：' + e.message);
  } finally {
    if (client) client.close();
    try { proc.kill('SIGKILL'); } catch (e) { }
    server.close();
    try { fs.unlinkSync(SMOKE); } catch (e) { }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
})();
