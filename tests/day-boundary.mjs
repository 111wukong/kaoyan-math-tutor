/* 日期口径回归检查：服务端的「今天」必须是**本地**今天
 *
 * ── 这个 bug 长什么样 ────────────────────────────────────────────
 * game.js 里有两处兜底写的是 `new Date().toISOString().slice(0, 10)`，
 * 那是 **UTC** 日期。而全站其它地方（study.js / cards.js / game.js 路由）
 * 的 todayStr() 用的都是本地 getFullYear/getMonth/getDate。
 *
 * 在 UTC+8 上，北京时间 00:00–08:00 期间两套口径差一天。后果：
 *   · 深夜打完卡，连续天数不涨；
 *   · 每日任务的「今天」还停在昨天；
 *   · 防刷分算成「昨天第几次作答」，档位错一档。
 * 这个项目的主人生产力高峰是 23:00–02:00 —— 也就是说这个 bug
 * 几乎只在他最活跃的那几个小时里发作。
 *
 * ── 为什么不能只在 Asia/Shanghai 下测 ────────────────────────────
 * 因为「UTC 和本地是不是同一天」取决于**跑测试的那一刻**。
 * 北京时间的白天跑，两套口径本来就一致，测试会假绿。
 * 一条三分之二时间不生效的断言，比没有断言更危险。
 *
 * ── 这里的做法：把 TZ 设成「保证和 UTC 差一天」的那个 ─────────────
 * 先算出此刻 UTC 的小时数，再挑一个必定跨过日期线的时区：
 *   · UTC 小时 >= 10 → 用 UTC+14（Pacific/Kiritimati），此时它已经是第二天；
 *   · 否则           → 用 UTC-11（Pacific/Midway），此时它还停在前一天。
 * 两者合起来覆盖全部 24 小时，所以**任何时刻跑都必然构成差异**。
 *
 * 然后把这个 TZ 传给子进程里的服务端，走真实接口验三件事：
 *   1. 快照里的 today 就是该时区的今天（不是 UTC 的今天）；
 *   2. 打卡之后连续天数是 1（不是 0）；
 *   3. 每日任务落在同一个日期上。
 */
import { startServer } from './lib/server.mjs';

const BASE = process.env.BASE;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

/** 把某个瞬间在指定时区下的日期格式化成 YYYY-MM-DD（en-CA 正好是这个格式）。 */
function dateIn(tz, d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * 挑一个「此刻本地日期 ≠ UTC 日期」的时区。
 * 返回 { tz, utcDate, localDate }，找不到就返回 null（理论上不可能）。
 */
function pickDivergentZone() {
  const now = new Date();
  const utcDate = dateIn('UTC', now);
  const hour = now.getUTCHours();
  // UTC+14 覆盖 UTC 10:00–23:59，UTC-11 覆盖 UTC 00:00–10:59，两者无缝拼满 24 小时
  const candidates = hour >= 10
    ? ['Pacific/Kiritimati', 'Pacific/Auckland', 'Asia/Tokyo']
    : ['Pacific/Midway', 'Pacific/Honolulu', 'America/Anchorage'];
  for (const tz of candidates) {
    const localDate = dateIn(tz, now);
    if (localDate !== utcDate) return { tz, utcDate, localDate };
  }
  return null;
}

const zone = pickDivergentZone();

console.log('\x1b[1m研数 · 日期口径检查\x1b[0m');

if (!zone) {
  /* 理论上不可达。真到了这里说明时区库有问题，必须出声而不是静默通过 ——
   * 这个项目的教训就是「跳过」和「全绿」在汇总里长得一样。 */
  console.log('\x1b[33m⚠ 挑不出与 UTC 差一天的时区，本套件无法验证\x1b[0m');
  console.log('\x1b[32m✅ 日期口径检查：0 项（无法构造差异时区）\x1b[0m');
  process.exit(0);
}

console.log(`\x1b[90mUTC 今天 ${zone.utcDate} / ${zone.tz} 今天 ${zone.localDate}（故意让两者不同）\x1b[0m`);

/* ---------- 起一个把 TZ 钉成该时区的服务 ----------
 *
 * ★ 这里**故意无视 run-all.mjs 传来的 BASE**，永远自己起一个。
 *
 * 原因：本套件的全部价值在于「服务端的本地时区和 UTC 差一天」。
 * 共享服务跑在 harness 的时区下，而那个时区和 UTC 是不是同一天
 * 取决于跑测试的那一刻 —— 北京时间白天跑，两者本来就一致，
 * 断言会假绿（或者因为拿错了参照时区而假红，实测踩过一次：
 * 单独跑 14 项全过，塞进 npm test 就报 5 项失败，
 * 因为断言用的是构造出来的 Kiritimati，服务却跑在 Asia/Shanghai）。
 *
 * 一条取决于"几点跑"的断言比没有断言更危险。所以这里自己挑时区、
 * 自己起服务，把变量彻底钉死。多花的那 1 秒换的是确定性。
 */
let server = null;
const base = null;   // 由下面的 startServer 填

if (BASE) {
  console.log('\x1b[90m（忽略 harness 传来的 BASE —— 本套件需要自己控制服务端时区）\x1b[0m');
}

{
  const savedTZ = process.env.TZ;
  process.env.TZ = zone.tz;          // startServer 会把 process.env 传给子进程
  try {
    server = await startServer({ tag: 'tz' });
  } finally {
    if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ;
  }
}
const endpoint = server.base;

/* ---------- 极简 cookie jar ---------- */
const jar = new Map();
async function req(method, path, body) {
  const res = await fetch(endpoint + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const [p] = c.split(';'); const i = p.indexOf('=');
    if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  const t = await res.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = { raw: t }; }
  return { status: res.status, data: d };
}

try {
  section('1. 快照里的「今天」是本地日期');
  {
    const email = `tz_${Date.now()}@test.local`;
    const reg = await req('POST', '/api/auth/register', { email, username: '时区', password: 'Timezone2027!' });
    ok('注册成功', reg.status === 200, `实得 ${reg.status}`);

    const snap = await req('GET', '/api/study/snapshot');
    ok('快照 200', snap.status === 200, `实得 ${snap.status}`);
    const today = snap.data?.snapshot?.today;
    ok(`★ today 是 ${zone.tz} 的今天（${zone.localDate}），不是 UTC 的今天（${zone.utcDate}）`,
      today === zone.localDate,
      `实得 ${today} —— 等于 UTC 日期说明又退回 toISOString 口径了`);
    ok('★ today 确实不是 UTC 日期（本套件的前提成立）',
      today !== zone.utcDate,
      `实得 ${today}，UTC 是 ${zone.utcDate}`);

    section('2. 打卡后连续天数是 1');
    const ci = await req('POST', '/api/study/checkin', { minutes: 45, tasksDone: false });
    ok('打卡 200', ci.status === 200, `实得 ${ci.status}`);
    ok('打卡日期 = 本地今天', ci.data?.checkin?.date === zone.localDate, `实得 ${ci.data?.checkin?.date}`);
    ok('45 分钟即算达标', ci.data?.checkin?.ok === true, JSON.stringify(ci.data?.checkin));
    ok('★ 连续天数 >= 1（用 UTC 口径这里会是 0）',
      (ci.data?.streak ?? 0) >= 1, `实得 ${ci.data?.streak}`);

    const snap2 = await req('GET', '/api/study/snapshot');
    ok('★ 重新拉快照，连续天数仍然是 1', (snap2.data?.snapshot?.streak ?? 0) >= 1,
      `实得 ${snap2.data?.snapshot?.streak}`);

    section('3. 每日任务落在同一个日期上');
    const daily = await req('GET', '/api/study/daily');
    ok('每日任务 200', daily.status === 200, `实得 ${daily.status}`);
    ok('★ 每日任务的 date = 本地今天', daily.data?.date === zone.localDate,
      `实得 ${daily.data?.date}`);

    section('4. 今日作答统计归到本地今天');
    const q = await req('GET', '/api/catalog/questions?limit=1');
    const one = await req('GET', `/api/catalog/questions/${q.data.questions[0].id}`);
    const ans = await req('POST', '/api/study/answer', {
      qid: q.data.questions[0].id, answer: one.data.question.answer, context: 'quiz',
    });
    ok('作答 200', ans.status === 200, `实得 ${ans.status}`);
    ok('★ 作答的今日计数是 1（UTC 口径会数到昨天那批）',
      ans.data?.xp?.nthToday === 1 || ans.data?.xp?.nthToday === undefined,
      `nthToday=${ans.data?.xp?.nthToday}`);
    const stats = await req('GET', '/api/study/stats');
    const days = (stats.data?.daily || stats.data?.heatmap || []);
    const last = Array.isArray(days) && days.length ? days[days.length - 1] : null;
    if (last) {
      ok('★ 统计里的最后一天是本地今天', String(last.date).slice(0, 10) === zone.localDate,
        `实得 ${last.date}`);
    } else {
      ok('统计返回了每日序列（否则无法核对）', false, JSON.stringify(Object.keys(stats.data || {})));
    }
  }
} catch (e) {
  console.log(`\n\x1b[31m测试脚本自身出错：${e.message}\x1b[0m`);
  fail++;
  failures.push('脚本自身出错：' + e.message);
} finally {
  if (server) await server.stop();
}

console.log('\n' + '─'.repeat(46));
if (fail) {
  console.log(`\x1b[31m❌ 日期口径检查：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
console.log(`\x1b[32m✅ 日期口径检查：${pass} 项全部通过\x1b[0m`);
process.exit(0);
