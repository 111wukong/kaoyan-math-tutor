#!/usr/bin/env node
/* 线上冒烟：直接打 https://111wukong.github.io/kaoyan-math-tutor/
 *
 * 为什么需要它：curl 只能证明「文件在服务器上」，证明不了「页面跑得起来」。
 * GitHub Pages 上脚本 404、顺序错、KaTeX CDN 挂掉，都会让 curl 全绿而页面白屏。
 * 所以这里开真浏览器、走真网络、抓真报错。
 *
 * 用法：node smoke-online.js [url]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const URL_BASE = process.argv[2] || 'https://111wukong.github.io/kaoyan-math-tutor/';
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
if (!BROWSER) { console.log('没找到 Chromium，跳过线上冒烟'); process.exit(0); }

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
        setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(method + ' 超时')); } }, 30000);
      });
    },
    on(fn) { listeners.push(fn); },
    close() { try { ws.close(); } catch (e) { } }
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

(async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-online-'));
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
    const failedReqs = [];
    client.on(m => {
      if (m.method === 'Runtime.exceptionThrown') {
        errs.push('异常：' + ((m.params.exceptionDetails.exception || {}).description || '').split('\n')[0]);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errs.push('console.error：' + m.params.args.map(a => a.value || a.description || '').join(' ').split('\n')[0]);
      }
      if (m.method === 'Network.loadingFailed') failedReqs.push('加载失败：' + (m.params.errorText || ''));
      if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
        failedReqs.push('HTTP ' + m.params.response.status + ' ' + m.params.response.url);
      }
    });
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Network.enable');

    const evalJs = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('求值失败：' + (r.exceptionDetails.exception || {}).description);
      return r.result.value;
    };

    const goto = async (hash, w, h) => {
      await client.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
      await client.send('Page.navigate', { url: URL_BASE + '?cb=' + Date.now() + '#/' + String(hash).replace(/^\//, '') });
      for (let t = Date.now(); Date.now() - t < 30000;) {
        const r = await evalJs('document.readyState + "|" + (typeof window.App) + "|" + (document.getElementById("main") ? document.getElementById("main").innerHTML.length : 0)').catch(() => '');
        const v = String(r || '').split('|');
        if (v[0] === 'complete' && v[1] === 'object' && parseInt(v[2], 10) > 200) break;
        await sleep(150);
      }
      await sleep(600);
    };

    console.log('线上地址：' + URL_BASE + '\n');

    /* ---------- 0. 播种存档 ----------
       必须最先做：空档下统计页是空态、答题页可能不出题，
       后面的断言会「因为没东西可比」而假通过或假失败。
       先落在同源页面上才能写 localStorage。 */
    console.log('0. 播种测试存档');
    await goto('', 1440, 900);
    const seeded = await evalJs(`(function(){
      function d(off){ var x = new Date(); x.setDate(x.getDate() - off);
        return x.getFullYear() + '-' + ('0'+(x.getMonth()+1)).slice(-2) + '-' + ('0'+x.getDate()).slice(-2); }
      var qs = [['q01','c1n2'],['q04','c1n4'],['q02','c1n3'],['q05','c1n5']];
      var attempts = [], i = 0;
      for (var day = 0; day < 24; day++) for (var k = 0; k < 4; k++) {
        var q = qs[i % qs.length];
        attempts.push({ id: 'a'+i, qid: q[0], kid: q[1], answer: 'A', correct: (i % 20) !== 0,
          context: 'practice', date: d(day), ts: Date.now() - day*86400000 + i*1000 });
        i++;
      }
      var checkins = {};
      for (var x = 0; x < 24; x++) checkins[d(x)] = { minutes: 20 + (x % 5) * 10 };
      localStorage.setItem('kaoyan_math_tutor_v1', JSON.stringify({
        attempts: attempts, checkins: checkins, cards: {}, customQ: [], notes: {}, classrooms: {},
        cardDeck: {}, chats: {}, daily: null,
        game: { xp: 1450, achievements: {}, combo: 4, bestCombo: 11, boss: {}, flags: {}, seen: {} },
        settings: { examTrack: 'math1', dailyNew: 2, examDate: '2026-12-26', persona: 'strict',
          llm: { enabled: false, kind: 'cloud', base: 'https://api.deepseek.com', model: 'deepseek-chat',
                 localBase: 'http://127.0.0.1:1234/v1', localModel: '', localName: '',
                 cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat',
                 cloudKey: '', rememberKey: false } }
      }));
      return attempts.length;
    })()`);
    ok(seeded === 96, '已播种 96 条作答记录', 'got ' + seeded);

    /* ---------- 1. 桌面：脚本装载与全局 API ---------- */
    console.log('\n1. 脚本装载');
    await goto('', 1440, 900);
    const api = await evalJs(`JSON.stringify({
      store: typeof window.Store, telemetry: typeof window.Telemetry,
      schema: window.Store && window.Store.SCHEMA,
      statsOf: !!(window.Store && window.Store.statsOf),
      bundle: !!(window.Store && window.Store.bundle),
      usage: !!(window.Store && window.Store.usage),
      probeQuota: !!(window.Store && window.Store.probeQuota),
      available: !!(window.Store && window.Store.available),
      mergeInto: !!(window.Store && window.Store.mergeInto),
      report: !!(window.Telemetry && window.Telemetry.report),
      event: !!(window.Telemetry && window.Telemetry.event),
      caps: window.Store && window.Store.CAP_DETAIL,
      katex: typeof window.katex
    })`);
    const A = JSON.parse(api);
    ok(A.store === 'object', 'window.Store 已加载');
    ok(A.telemetry === 'object', 'window.Telemetry 已加载');
    ok(A.schema === 2, 'Store.SCHEMA = 2', 'got ' + A.schema);
    ok(A.caps === 2000, 'Store.CAP_DETAIL = 2000', 'got ' + A.caps);
    ok(A.statsOf && A.bundle && A.usage && A.probeQuota && A.available && A.mergeInto,
      'Store 公开 API 齐全（statsOf/bundle/usage/probeQuota/available/mergeInto）');
    ok(A.report && A.event, 'Telemetry 公开 API 齐全（report/event）');
    ok(A.katex === 'object', 'KaTeX 从 CDN 加载成功', 'got ' + A.katex);

    /* ---------- 2. 无障碍骨架 ---------- */
    console.log('\n2. 无障碍骨架');
    const a11y = await evalJs(`JSON.stringify({
      skip: !!document.querySelector('.skip-link'),
      navToggle: !!document.getElementById('nav-toggle'),
      scrim: !!document.querySelector('.nav-scrim'),
      alert: !!document.getElementById('storage-alert'),
      alertRole: (document.getElementById('storage-alert')||{}).getAttribute && document.getElementById('storage-alert').getAttribute('role'),
      mainTab: (document.getElementById('main')||{}).getAttribute && document.getElementById('main').getAttribute('tabindex'),
      navLabel: (document.getElementById('nav')||{}).getAttribute && document.getElementById('nav').getAttribute('aria-label'),
      iconCount: document.querySelectorAll('svg.ic').length,
      iconHidden: document.querySelectorAll('svg.ic[aria-hidden="true"]').length,
      altCount: document.querySelectorAll('img[alt]').length,
      ariaHidden: document.querySelectorAll('[aria-hidden="true"]').length,
      liveRegions: document.querySelectorAll('[aria-live]').length,
      toastLive: (function(){ var t = document.getElementById('toast-root'); return !!t && t.getAttribute('role') === 'status' && t.getAttribute('aria-live') === 'polite'; })()
    })`);
    const B = JSON.parse(a11y);
    ok(B.skip, '存在「跳到主要内容」跳过导航');
    ok(B.navToggle, '存在小屏导航按钮 #nav-toggle');
    ok(B.scrim, '存在抽屉遮罩 .nav-scrim');
    ok(B.alert && B.alertRole === 'alert', '#storage-alert 存在且 role=alert', 'role=' + B.alertRole);
    ok(B.mainTab === '-1', '#main 有 tabindex="-1"（可被程序聚焦）', 'got ' + B.mainTab);
    ok(!!B.navLabel, '主导航有 aria-label', 'got ' + B.navLabel);
    ok(B.iconCount > 0 && B.iconCount === B.iconHidden,
      '全部 ' + B.iconCount + ' 个 svg.ic 都标了 aria-hidden', B.iconHidden + '/' + B.iconCount);
    ok(B.ariaHidden > 5, 'aria-hidden 覆盖数 > 5', 'got ' + B.ariaHidden);
    /* 仪表盘上只有 toast 是 live region —— 答题反馈的那几个只在答题页渲染时才存在，
       所以「≥2」这个门槛本身是错的，正确的做法是去对应的页面数。见下面的 2b。 */
    ok(B.toastLive, '#toast-root 是 role=status + aria-live=polite 的播报区');

    /* ---------- 2b. 答题反馈的播报区 ---------- */
    console.log('\n2b. 反馈播报区（按页面存在）');
    await goto('quiz', 1440, 900);
    const quizLive = await evalJs(`JSON.stringify({
      qbody: document.querySelectorAll('[id^="qbody-"][role="status"][aria-live="polite"]').length,
      anyLive: document.querySelectorAll('[aria-live]').length
    })`);
    const QL = JSON.parse(quizLive);
    ok(QL.qbody >= 1, '每日一练：题干区是 role=status + aria-live=polite', 'got ' + QL.qbody);
    ok(QL.anyLive >= 2, '每日一练页 live region ≥2（toast + 反馈）', 'got ' + QL.anyLive);

    await goto('blitz', 1440, 900);
    /* 反馈区只在开局后才渲染（renderBlitzPlay 里），intro 屏上没有 —— 所以得先开局。 */
    const blitzLive = await evalJs(`(function(){
      if (typeof App.blitzStart !== 'function') return JSON.stringify({ started: false, fb: false });
      App.blitzStart();
      var fb = document.querySelector('#blitz-feedback[role="status"][aria-live="polite"]');
      return JSON.stringify({ started: !!document.getElementById('blitz-clock'), fb: !!fb });
    })()`);
    const BL = JSON.parse(blitzLive);
    ok(BL.started, '闪电战已开局（HUD 计时器存在）');
    ok(BL.fb, '闪电战：反馈区是 role=status + aria-live=polite');
    /* 收尾：别把计时器留在后台跑，免得影响后面的路由 */
    await evalJs('(function(){ if (typeof App.blitzQuit === "function") App.blitzQuit(); })()');
    await sleep(200);

    /* ---------- 3. 图表文字摘要 ---------- */
    console.log('\n3. 图表可访问性');
    await goto('stats', 1440, 900);
    const charts = await evalJs(`JSON.stringify({
      imgs: document.querySelectorAll('[role="img"]').length,
      labelled: document.querySelectorAll('[role="img"][aria-label]').length,
      canvases: document.querySelectorAll('canvas').length,
      canvasLabelled: document.querySelectorAll('canvas[aria-label]').length,
      sample: (document.querySelector('[role="img"]')||{}).getAttribute && (document.querySelector('[role="img"]').getAttribute('aria-label')||'').slice(0,70),
      hasMastery: document.body.textContent.indexOf('掌握') >= 0
    })`);
    const C = JSON.parse(charts);
    ok(C.imgs >= 2, '统计页有 role="img" 图表（≥2）', 'got ' + C.imgs);
    ok(C.imgs > 0 && C.imgs === C.labelled, '每个 role="img" 都带 aria-label', C.labelled + '/' + C.imgs);
    ok(C.canvases === 0 || C.canvases === C.canvasLabelled, 'canvas 均带 aria-label', C.canvasLabelled + '/' + C.canvases);
    ok(C.hasMastery, '统计页确实渲染了掌握度内容（不是空态）');
    if (C.sample) console.log('     摘要示例：' + C.sample + '…');

    /* ---------- 4. 设置页两个新面板 ---------- */
    console.log('\n4. 设置页面板');
    await goto('settings', 1440, 900);
    const panels = await evalJs(`JSON.stringify({
      titles: Array.prototype.map.call(document.querySelectorAll('.card-title'), function(e){ return e.textContent.trim().slice(0,24); }),
      hasBackup: document.body.textContent.indexOf('数据与备份') >= 0,
      hasDiag: document.body.textContent.indexOf('诊断') >= 0,
      hasExport: document.body.textContent.indexOf('导出') >= 0,
      hasImport: document.body.textContent.indexOf('导入') >= 0,
      hasCopyDiag: typeof App.copyDiagnostics === 'function' && typeof App.exportDiagnostics === 'function',
      hasClearDiag: typeof App.clearDiagnostics === 'function',
      hasExportFn: typeof App.exportData === 'function',
      hasImportFn: typeof App.importData === 'function' && typeof App.applyImportText === 'function' && typeof App.pickImport === 'function',
      hasNavFn: typeof App.toggleNav === 'function' && typeof App.closeNav === 'function' && typeof App.focusMain === 'function',
      hasDismiss: typeof App.dismissStorageAlert === 'function',
      examInput: !!document.getElementById('set-exam')
    })`);
    const D = JSON.parse(panels);
    ok(D.hasBackup, '「数据与备份」面板已渲染');
    ok(D.hasDiag, '「诊断」面板已渲染');
    ok(D.hasExport && D.hasImport, '导出/导入入口存在');
    ok(D.hasExportFn && D.hasImportFn, 'App.exportData / importData / applyImportText / pickImport 已导出');
    ok(D.hasCopyDiag && D.hasClearDiag, 'App.copyDiagnostics / exportDiagnostics / clearDiagnostics 已导出');
    ok(D.hasNavFn && D.hasDismiss, 'App.toggleNav / closeNav / focusMain / dismissStorageAlert 已导出');
    ok(D.examInput, '设置页存在 #set-exam（用于触发一次真实写盘）');

    /* ---------- 5. 诊断包不泄露用户内容（线上真跑一遍） ---------- */
    console.log('\n5. 诊断包隐私');
    const privacy = await evalJs(`(function(){
      var r = window.Telemetry.report();
      return JSON.stringify({
        len: r.length,
        head: r.split('\\n').slice(0, 3).join(' / '),
        leaks: ['sk-', 'cloudKey', 'apiKey', 'chat', 'notes', 'answer', '题干', 'DeepSeek'].filter(function(k){ return r.indexOf(k) >= 0; })
      });
    })()`);
    const E = JSON.parse(privacy);
    ok(E.len > 0, 'report() 有内容（' + E.len + ' 字符）');
    ok(E.leaks.length === 0, '诊断包不含敏感字段', '命中：' + JSON.stringify(E.leaks));
    console.log('     首行：' + E.head.slice(0, 90));

    /* ---------- 6. 375×812 无横向溢出 ---------- */
    console.log('\n6. 小屏 375×812');
    const routes = ['', 'quiz', 'stats', 'settings', 'lab'];
    for (const r of routes) {
      await goto(r, 375, 812);
      const m = await evalJs(`JSON.stringify({
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        sidebarX: (function(){ var s = document.getElementById('sidebar'); if(!s) return null; var b = s.getBoundingClientRect(); return Math.round(b.left); })(),
        sidebarVisible: (function(){ var s = document.getElementById('sidebar'); if(!s) return null; var b = s.getBoundingClientRect(); return b.right > 1 && b.left < window.innerWidth; })(),
        toggleW: (function(){ var t = document.getElementById('nav-toggle'); if(!t) return null; var b = t.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; })()
      })`);
      const F = JSON.parse(m);
      const name = r || 'dashboard';
      ok(F.scrollW <= F.innerW + 1, '/#/' + name + ' 无横向溢出', F.scrollW + ' > ' + F.innerW);
      ok(F.sidebarVisible === false, '/#/' + name + ' 侧栏默认收起', 'left=' + F.sidebarX);
      if (F.toggleW) ok(F.toggleW[0] >= 40 && F.toggleW[1] >= 40, '/#/' + name + ' 导航按钮触摸目标 ≥40px', F.toggleW.join('×'));
    }

    /* ---------- 7. 抽屉开合闭环 ---------- */
    console.log('\n7. 小屏抽屉开合');
    await goto('', 375, 812);
    await evalJs('document.getElementById("nav-toggle").click()');
    await sleep(450);
    const opened = await evalJs(`JSON.stringify({
      locked: document.body.classList.contains('nav-locked'),
      x: Math.round(document.getElementById('sidebar').getBoundingClientRect().left),
      expanded: document.getElementById('nav-toggle').getAttribute('aria-expanded')
    })`);
    const G = JSON.parse(opened);
    ok(G.locked, '展开时 body 锁滚动');
    ok(G.x >= -1, '抽屉已滑出（left=' + G.x + '）');
    ok(G.expanded === 'true', '导航按钮 aria-expanded=true', 'got ' + G.expanded);

    await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await sleep(450);
    const closed = await evalJs(`JSON.stringify({
      locked: document.body.classList.contains('nav-locked'),
      x: Math.round(document.getElementById('sidebar').getBoundingClientRect().left),
      expanded: document.getElementById('nav-toggle').getAttribute('aria-expanded')
    })`);
    const H = JSON.parse(closed);
    ok(!H.locked, 'Esc 关闭后解除滚动锁');
    ok(H.x < -100, '抽屉已收起（left=' + H.x + '）');
    ok(H.expanded === 'false', '导航按钮 aria-expanded=false', 'got ' + H.expanded);

    /* ---------- 8. 写盘失败横幅（线上真触发一次） ----------
       注意：save() 是 app.js 的模块内私有函数，没有挂到 App 上。
       所以必须走真实 UI 路径 —— 改考试日期并派发 change，由监听器去调 save()。
       这反而更好：验的是用户真会遇到的那条路，而不是一条测试专用的后门。 */
    console.log('\n8. 存档告警横幅');
    await goto('settings', 1440, 900);
    const banner = await evalJs(`(function(){
      var el = document.getElementById('set-exam');
      if (!el) return JSON.stringify({ shown: false, hasBtn: false, text: '', why: '找不到 #set-exam' });
      var orig = localStorage.setItem;
      var err = new Error('quota'); err.name = 'QuotaExceededError';
      localStorage.setItem = function(){ throw err; };
      try {
        el.value = '2027-01-05';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
      localStorage.setItem = orig;
      var box = document.getElementById('storage-alert');
      var shown = !!box && !box.hasAttribute('hidden') && box.textContent.length > 0;
      var hasBtn = !!box && !!box.querySelector('button');
      var text = box ? box.textContent : '';
      return JSON.stringify({ shown: shown, hasBtn: hasBtn, text: text.replace(/\\s+/g, ' ').slice(0, 90) });
    })()`);
    const I = JSON.parse(banner);
    ok(I.shown, '写盘失败后横幅出现', I.why || '');
    ok(I.hasBtn, '横幅内含操作按钮（导出备份）');
    if (I.text) console.log('     横幅文案：' + I.text);

    const recovered = await evalJs(`(function(){
      var el = document.getElementById('set-exam');
      if (el) { el.value = '2027-01-06'; el.dispatchEvent(new Event('change', { bubbles: true })); }
      var box = document.getElementById('storage-alert');
      return JSON.stringify({ hidden: !box || box.hasAttribute('hidden') || box.textContent.length === 0 });
    })()`);
    ok(JSON.parse(recovered).hidden, '存储恢复后横幅自动撤掉');

    /* ---------- 9. 控制台与网络 ---------- */
    console.log('\n9. 控制台与网络');
    const realErrs = errs.filter(e => !/favicon/i.test(e));
    const realFails = failedReqs.filter(e => !/favicon/i.test(e));
    ok(realErrs.length === 0, 'console 报错 / 未捕获异常 0 条', realErrs.slice(0, 3).join(' | '));
    ok(realFails.length === 0, '网络请求无 4xx/5xx', realFails.slice(0, 3).join(' | '));

    console.log('\n' + '─'.repeat(46));
    if (fail === 0) console.log('✅ 线上冒烟全部通过：' + pass + ' 项');
    else console.log('❌ ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.log('线上冒烟中断：' + e.message);
    process.exitCode = 1;
  } finally {
    if (client) client.close();
    try { proc.kill('SIGKILL'); } catch (e) { }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }
})();
