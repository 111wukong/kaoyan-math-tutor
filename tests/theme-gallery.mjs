/* 生成主题画廊：同一份数据、同一个仪表盘，只换主题，每个主题一张图
 *
 *   npm run gallery            # 输出到 docs/screenshots/themes/
 *   OUT=/tmp/g npm run gallery
 *
 * ── 为什么要单独做这件事 ────────────────────────────────────────
 * 8 套主题如果只在 README 里写个名字，没人知道它们长什么样，
 * 也就没人会去换。而这 8 套的设计取舍（亮色为什么加深强调色、
 * 为什么亮色不挂 WebGL 背景）只有看图才讲得清。
 *
 * ── 为什么自己起服务、自己灌数据 ────────────────────────────────
 * 复用 tests/lib/server.mjs 的一次性服务（空闲端口 + 临时库），
 * 所以它不碰 server/data/app.db，也不需要你先手动起服务。
 * 数据要**有分布**：全空的话所有卡片都是「还没有数据」，
 * 看不出配色和密度对不对 —— 而设计问题恰恰只在有内容时才暴露。
 *
 * ── 为什么用 CDP 的 jpeg 而不是 png ─────────────────────────────
 * 这个项目零图片编码依赖（没有 sharp / jimp）。PNG 只能靠
 * tests/lib/png.mjs 解码，编码得自己写；而 CDP 的 captureScreenshot
 * 本来就支持 format:'jpeg' + quality，白拿。8 张 PNG 是 4.1MB，
 * JPEG 之后约 1.2MB —— 这个差别决定了它能不能进仓库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/server.mjs';
import { launchPage, sleep } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT || path.join(ROOT, 'docs/screenshots/themes');
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const ROUTE = process.env.ROUTE || '/';

/* 顺序即画廊顺序：先暗后亮。id 必须和 web/src/lib/themes.ts 对得上 ——
 * 对不上时页面会静默落回默认主题，截出来 8 张一模一样的深空，
 * 而脚本不会报任何错。所以下面有一句「截完核对 data-theme」的断言。 */
const THEMES = [
  'deep-space', 'cyber-lime', 'nord-frost', 'ember', 'midnight-rose',
  'paper', 'mint', 'solarized',
];

fs.mkdirSync(OUT, { recursive: true });

const server = await startServer({ tag: 'gallery' });
const BASE = server.base;
console.log(`\x1b[1m研数 · 主题画廊\x1b[0m`);
console.log(`服务 ${BASE}`);
console.log(`输出 ${OUT}\n`);

/* ---------- 极简 cookie jar ---------- */
const jar = new Map();
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const t = await res.text();
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

/* ---------- 灌一份有分布的数据 ---------- */
const EMAIL = `gallery_${Date.now()}@test.local`;
const PASSWORD = 'Kaoyan2027!';
await api('POST', '/api/auth/register', { email: EMAIL, username: '王国华', password: PASSWORD });
await api('PUT', '/api/settings', { examDate: '2026-12-26', dailyNew: 3 });

const qs = (await api('GET', '/api/catalog/questions?limit=200')).questions;
const byKid = new Map();
for (const q of qs) {
  if (!byKid.has(q.kid)) byKid.set(q.kid, []);
  byKid.get(q.kid).push(q);
}
const kids = [...byKid.keys()];

async function answer(qid, wrong) {
  const d = await api('GET', `/api/catalog/questions/${qid}`);
  const a = wrong ? (d.question.type === 'choice' ? 'ZZZ' : '绝对不对') : d.question.answer;
  await api('POST', '/api/study/answer', { qid, answer: a, context: 'quiz' });
}

/* 三档分布：前 10 个知识点反复答对（推到熟练/精通）、
 * 接下来 8 个先错后对（留在学习中并进错题本）、再 6 个只答一次、
 * 剩下的不碰。这样掌握度分布、热力图、错题本、复习队列都有东西可看。 */
let n = 0;
for (const kid of kids.slice(0, 10)) {
  for (const q of byKid.get(kid).slice(0, 2)) {
    for (let i = 0; i < 3; i++) { await answer(q.id, false); n++; }
  }
}
for (const kid of kids.slice(10, 18)) {
  for (const q of byKid.get(kid).slice(0, 2)) { await answer(q.id, true); await answer(q.id, false); n += 2; }
}
for (const kid of kids.slice(18, 24)) {
  for (const q of byKid.get(kid).slice(0, 1)) { await answer(q.id, false); n++; }
}

const cards = (await api('GET', '/api/cards?limit=50')).cards || [];
for (const c of cards.slice(0, 12)) await api('POST', `/api/cards/${c.id}/grade`, { rating: 3 });
await api('POST', '/api/study/checkin', { minutes: 95, tasksDone: true });
console.log(`已灌数据：作答 ${n} 次 · 复习卡 ${cards.length} 张\n`);

/* ---------- 逐主题截图 ---------- */
const b = await launchPage({ width: W, height: H });
const { client } = b;
await client.send('Runtime.enable');
await client.send('Page.enable');
await client.send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 2, mobile: false,
});

const ev = async (expr) => {
  const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

let bad = 0;
try {
  /* 浏览器自己登录 —— Node 侧的 cookie jar 跟浏览器无关，
   * 不登录的话导航到 / 会被弹回 /login，截出来 8 张登录页。 */
  await client.send('Page.navigate', { url: `${BASE}/login` });
  for (let i = 0; i < 80; i++) {
    if (await ev('document.readyState === "complete"')) break;
    await sleep(150);
  }
  const st = await ev(`fetch('/api/auth/login', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, password: ${JSON.stringify(PASSWORD)} })
  }).then(function (r) { return r.status })`);
  if (st !== 200) throw new Error(`浏览器登录失败：${st}`);

  for (const id of THEMES) {
    /* 服务端和 localStorage 两条路都要设。
     * 只设 localStorage 的话，页面起来后 loadFromServer() 会把主题
     * 覆盖回服务端的值，截出来是上一个主题。 */
    await api('PUT', '/api/settings', { theme: id });
    await ev(`localStorage.setItem('yanshu:theme', ${JSON.stringify(id)})`);

    await client.send('Page.navigate', { url: `${BASE}${ROUTE}?cb=${Date.now()}` });
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (await ev('!!document.querySelector("#main-scroll")')) { ready = true; break; }
      await sleep(150);
    }
    if (!ready) console.log(`  \x1b[33m⚠ ${id} 没等到 #main-scroll\x1b[0m`);
    await sleep(2600);   // 等数据回来 + 入场动画 + 粒子跑几帧

    const info = JSON.parse(await ev(`JSON.stringify({
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      bg: getComputedStyle(document.documentElement).backgroundColor,
      canvas: document.querySelectorAll('canvas').length,
    })`));

    /* ★ 核对主题真的生效了。不核的话，id 写错（比如 themes.ts 里改了名）
     * 会静默落回默认主题 —— 8 张一模一样的深空，脚本一声不响。 */
    if (info.theme !== id) {
      console.log(`  \x1b[31m✗ ${id} 没生效（页面报的是 ${info.theme}）\x1b[0m`);
      bad++;
    }

    let shot = null;
    for (let a = 1; a <= 3 && !shot; a++) {
      try {
        /* JPEG 直接由 CDP 编码，不需要任何图片库。
         *
         * 质量 74 是量出来的折中：80 时 8 张共 1.9MB，
         * 74 掉到约 1.4MB，而配色、对比度、卡片边界这些
         * 「画廊要看的东西」在 74 下肉眼看不出差别 ——
         * 它压掉的是文字边缘的高频细节，不是色块。
         * 再往下压（<70）开始出现色带，而色带恰恰是这个项目
         * 专门写了一个检测套件去防的东西（见 tests/banding.mjs）。 */
        shot = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 74 }, 25000);
      } catch (e) {
        if (a === 3) throw e;
        await sleep(900);
      }
    }
    const file = path.join(OUT, `${id}.jpg`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    const mark = info.theme === id ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} ${id.padEnd(15)} ${info.mode.padEnd(5)} ${info.bg.padEnd(20)} ` +
      `画布 ${String(info.canvas).padStart(2)}  ${kb.padStart(4)} KB`);
  }
} finally {
  b.kill();
  await server.stop();
}

console.log(`\n输出目录 ${OUT}`);
if (bad) {
  console.log(`\x1b[31m✗ 有 ${bad} 个主题没生效 —— 检查 id 和 web/src/lib/themes.ts 是否一致\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32m✓ 全部主题都已生成\x1b[0m');
process.exit(0);
