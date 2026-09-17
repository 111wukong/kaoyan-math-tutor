/* 给重构后的界面截图，供人眼审查
 *
 * 为什么要单独做这件事：
 * 229 项测试证明了「页面渲染出来了、canvas 有像素、公式没漏源码」，
 * 但「好不好看」是断言测不了的。这个脚本只干一件事 —— 把页面拍下来。
 *
 * 关键：**先灌数据再截图**。空状态下所有页面都是「还没有卡片」「题库为空」，
 * 截 8 张空态图根本看不出配色、密度、层级对不对 ——
 * 而设计问题恰恰只在有内容时才暴露。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const OUT = process.env.OUT || '/tmp/yanshu-shots';
const W = 1440, H = 900;

/* ---------------- 1. 找浏览器 ---------------- */
function findBrowser() {
  const cands = [
    ...(fs.existsSync(path.join(os.homedir(), 'Library/Caches/ms-playwright'))
      ? fs.readdirSync(path.join(os.homedir(), 'Library/Caches/ms-playwright'))
          .filter((d) => d.startsWith('chromium_headless_shell-'))
          .map((d) => path.join(os.homedir(), 'Library/Caches/ms-playwright', d,
            'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
      : []),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

/* ---------------- 2. 极简 cookie jar + API ---------------- */
const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const text = await res.text();
  try { return { status: res.status, data: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, data: null }; }
}

/* ---------------- 3. 造数据 ---------------- */
const EMAIL = `shot_${Date.now()}@test.local`;

console.log('① 注册截图专用账号');
const reg = await api('POST', '/api/auth/register', {
  email: EMAIL, username: '王国华', password: 'Kaoyan2027!',
});
if (![200, 201].includes(reg.status)) {
  console.error('注册失败', reg.status, JSON.stringify(reg.data));
  process.exit(1);
}
const TOKEN = jar.get('yanshu_session');
console.log(`   账号 ${EMAIL}`);

console.log('② 灌学习数据（要有分布，不能全满也不能全空）');
const tree = (await api('GET', '/api/catalog/tree')).data;
const allKids = tree.categories.flatMap((c) => c.chapters.flatMap((ch) => ch.nodes));

const qs = (await api('GET', '/api/catalog/questions?limit=200')).data.questions;
const byKid = new Map();
for (const q of qs) {
  if (!byKid.has(q.kid)) byKid.set(q.kid, []);
  byKid.get(q.kid).push(q);
}

/* 三档分布，让掌握度、热力图、错题本、复习队列都有东西可看：
 *   前 9 个知识点 → 每题答对 3 遍（推到 proficient / mastered）
 *   接下来 6 个   → 先错一遍再答对（留在 learning，且进错题本）
 *   剩下的一律不碰（保持 new，让知识树有对比） */
let answered = 0, wrong = 0;
const kids = [...byKid.keys()];

async function answer(qid, forceWrong) {
  const detail = await api('GET', `/api/catalog/questions/${qid}`);
  const truth = detail.data?.question?.answer;
  const a = forceWrong ? (detail.data?.question?.type === 'choice' ? 'ZZZ' : '绝对不对') : truth;
  const r = await api('POST', '/api/study/answer', { qid, answer: a, context: 'quiz' });
  if (r.data?.correct === false) wrong++;
  answered++;
}

for (const kid of kids.slice(0, 9)) {
  for (const q of byKid.get(kid).slice(0, 2)) {
    for (let i = 0; i < 3; i++) await answer(q.id, false);
  }
}
for (const kid of kids.slice(9, 15)) {
  for (const q of byKid.get(kid).slice(0, 2)) {
    await answer(q.id, true);
    await answer(q.id, false);
  }
}
console.log(`   作答 ${answered} 次（其中判错 ${wrong} 次）`);

/* 复习卡：给几张卡打分，让「复习」页和 SM-2 有内容。
 * 注意要用 /api/cards（全量）而不是 /api/cards/due ——
 * SM-2 把新建的卡排在明天，所以「今日到期」此刻是 0 张。 */
const allCards = (await api('GET', '/api/cards?limit=50')).data?.cards || [];
let graded = 0;
for (const c of allCards.slice(0, 10)) {
  const r = await api('POST', `/api/cards/${c.id}/grade`, { rating: 3 });
  if (r.status === 200) graded++;
}
console.log(`   复习卡共 ${allCards.length} 张，已评 ${graded} 张`);

/* 课堂存档：让课堂页不是空态 */
await api('PUT', `/api/classroom/${kids[0]}`, {
  payload: {
    turns: [
      { role: 'teacher', name: '老师', text: '今天我们看一个典型错误：求 $\\lim_{x\\to 0}\\frac{\\sin x}{x}$ 时，直接把 $x=0$ 代进去。' },
      { role: 'xiaoming', name: '小明', text: '代进去是 $\\frac{0}{0}$，那答案就是 0 吧？' },
      { role: 'teacher', name: '老师', text: '这就是**概念性错误**。$\\frac{0}{0}$ 是未定式，不是 0 —— 它只说明需要变形。' },
      { role: 'xiaohong', name: '小红', text: '那用等价无穷小 $\\sin x \\sim x$，就变成 $\\frac{x}{x}=1$。' },
      { role: 'xiaogang', name: '小刚', text: '为什么这里可以用等价无穷小替换？条件是什么？' },
    ],
    board: [
      '$\\lim_{x\\to 0}\\frac{\\sin x}{x}$',
      '$\\sin x \\sim x \\ (x\\to 0)$',
      '$\\Rightarrow \\lim_{x\\to 0}\\frac{x}{x} = 1$',
    ],
    round: 1,
  },
});

/* ---------------- 4. 起浏览器 ---------------- */
const BROWSER = findBrowser();
if (!BROWSER) {
  console.error('找不到 Chromium 内核，跳过截图');
  process.exit(0);
}
console.log(`③ 浏览器 ${BROWSER}`);

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yanshu-shot-'));
const args = [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--window-size=${W},${H}`,
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  'about:blank',
];
if (/Google Chrome$|Microsoft Edge$/.test(BROWSER)) args.unshift('--headless=new');

const proc = spawn(BROWSER, args, { stdio: ['ignore', 'ignore', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dbgPort = null;
for (let i = 0; i < 100; i++) {
  const f = path.join(profile, 'DevToolsActivePort');
  if (fs.existsSync(f)) { dbgPort = fs.readFileSync(f, 'utf8').trim().split('\n')[0]; break; }
  await sleep(200);
}
if (!dbgPort) { console.error('拿不到调试端口'); proc.kill('SIGKILL'); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
const page = list.find((t) => t.type === 'page');

/* 极简 CDP 客户端 */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) listeners.forEach((fn) => fn(m));
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
        setTimeout(() => {
          if (waiting.has(id)) { waiting.delete(id); reject(new Error(method + ' 超时')); }
        }, 25000);
      });
    },
    on(fn) { listeners.push(fn); },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
}

let client = null;
try {
  client = cdp(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: false,
  });

  const ev = async (expr) => {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return { value: r.result?.value };
  };

  async function shoot(name, route, { waitFor, settle = 1400 } = {}) {
    await client.send('Page.navigate', { url: `${BASE}${route}${route.includes('?') ? '&' : '?'}cb=${Date.now()}` });
    // 轮询等就绪条件，别赌固定 sleep
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const r = await ev(waitFor || 'document.readyState === "complete"');
      if (r.value === true) break;
      await sleep(180);
    }
    await sleep(settle);   // 让动画 / canvas / 图表跑几帧
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    const title = (await ev('document.title')).value || '';
    console.log(`   ✓ ${name.padEnd(16)} ${route.padEnd(16)} ${kb} KB  「${title}」`);
  }

  /* 未登录状态：登录 / 注册页 —— 第一印象 */
  console.log('④ 未登录页面');
  await shoot('01-登录', '/login', { waitFor: '!!document.querySelector("input[name=email]")' });
  await shoot('02-注册', '/register', { waitFor: 'document.querySelectorAll("form input").length >= 4' });

  /* 注入会话 cookie，进入已登录状态 */
  await client.send('Network.setCookie', {
    name: 'yanshu_session', value: TOKEN, url: BASE, path: '/',
    httpOnly: true, sameSite: 'Lax',
  });

  console.log('⑤ 已登录页面');
  const SHELL = '!!document.querySelector("nav[aria-label=\\"主导航\\"]")';
  await shoot('03-仪表盘', '/', { waitFor: SHELL, settle: 2000 });
  await shoot('04-知识树', '/learn', { waitFor: SHELL, settle: 1600 });
  await shoot('05-知识点详情', `/learn/${kids[0]}`, { waitFor: SHELL, settle: 2200 });
  await shoot('06-每日一练', '/quiz', { waitFor: SHELL, settle: 2000 });
  await shoot('07-复习', '/review', { waitFor: SHELL, settle: 1600 });
  await shoot('08-错题本', '/mistakes', { waitFor: SHELL, settle: 1600 });
  await shoot('09-统计', '/stats', { waitFor: SHELL, settle: 2400 });
  await shoot('10-公式实验室', '/lab', { waitFor: SHELL, settle: 2400 });
  await shoot('11-闪电战', '/blitz', { waitFor: SHELL, settle: 1800 });
  await shoot('12-卡片库', '/deck', { waitFor: SHELL, settle: 1600 });
  await shoot('13-课堂', '/classroom', { waitFor: SHELL, settle: 1800 });
  await shoot('14-成就', '/achievements', { waitFor: SHELL, settle: 1800 });
  await shoot('15-设置', '/settings', { waitFor: SHELL, settle: 1600 });

  console.log(`\n截图输出：${OUT}`);
} finally {
  if (client) client.close();
  try { proc?.stderr?.destroy(); } catch { /* 已关 */ }
  try { proc?.kill('SIGKILL'); } catch { /* 已退 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}
