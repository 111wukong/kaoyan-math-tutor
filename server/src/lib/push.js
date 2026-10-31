/* 微信订阅消息推送
 *
 * ── 这个东西为什么值得做 ────────────────────────────────────────
 * FSRS 的本质是「到期必须被提醒」。网页端做不到这件事 ——
 * 用户不会每天主动打开一个书签。而小程序有订阅消息，这是它相对
 * 网页唯一不可替代的能力。
 *
 * ── 微信的规则（决定了实现形态）────────────────────────────────
 * 订阅消息是**一次性**的：用户点一次「允许」，只能收到一条。
 * 所以「每天推送」在微信的规则下其实是「每次授权后推一条」，
 * 想持续推就必须持续获得授权。
 *
 * 这带来两个直接后果：
 *   1. 必须记额度（push_sub.quota_left），推一条减一条；
 *   2. 没有额度的用户不推，也不该报错 —— 那是正常状态，不是故障。
 *
 * ── 模板字段为什么是配置项 ──────────────────────────────────────
 * 订阅消息的 data 字段名（thing1 / time2 / number3…）由**管理员在
 * 微信公众平台选的那个模板**决定，代码里猜不出来。猜错的后果是
 * 每次推送都返回 errcode 47003（参数不匹配），而且错误信息很难懂。
 * 所以字段映射放进配置，由控制台维护。
 */

import { db } from '../db/index.js';
import { getConfig } from './appConfig.js';
import { today } from './dates.js';
import { streakFromSet } from './game.js';

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const SEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send';

const WX_APPID = (process.env.WX_APPID || '').trim();
const WX_SECRET = (process.env.WX_SECRET || '').trim();

/* access_token 有效期 7200 秒，微信对获取频率也有限制（每天 2000 次）。
 * 缓存起来，提前 5 分钟过期 —— 卡在边界上过期会导致一次莫名其妙的
 * 40001（token 无效）。 */
let tokenCache = { token: '', expireAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expireAt) return tokenCache.token;

  if (!WX_APPID || !WX_SECRET) {
    throw new Error('没有配置 WX_APPID / WX_SECRET，无法获取 access_token');
  }

  const url = `${TOKEN_URL}?grant_type=client_credential`
    + `&appid=${encodeURIComponent(WX_APPID)}`
    + `&secret=${encodeURIComponent(WX_SECRET)}`;

  const res = await fetch(url);
  const body = await res.json();

  if (!body.access_token) {
    /* 微信的失败也是 200 + errcode，不看 errcode 会拿着 undefined 去发消息 */
    throw new Error(`获取 access_token 失败（${body.errcode}）：${body.errmsg || ''}`);
  }

  tokenCache = {
    token: body.access_token,
    expireAt: now + (Number(body.expires_in || 7200) - 300) * 1000,
  };
  return tokenCache.token;
}

/**
 * 算连续打卡天数。
 *
 * ★ 为什么不在 candidates() 的 SQL 里直接查：game_state 表**没有**
 *   streak 列 —— 连续天数是每次从 stats_daily 现算的（见 lib/game.js）。
 *   第一版想当然地写了个 `SELECT streak FROM game_state`，结果整个
 *   推送接口 500「no such column: streak」。
 *
 * ★ 为什么按需算：只有模板里真的用了 {streak} 才去查。
 *   大部分提醒模板只关心「今天几张卡」，不该为用不到的字段多跑一次查询。
 */
function streakOf(userId) {
  const rows = db.prepare(
    'SELECT date FROM stats_daily WHERE user_id = ? AND n > 0 ORDER BY date DESC LIMIT 400',
  ).all(userId);
  try {
    return streakFromSet(new Set(rows.map((r) => r.date)), today()).current || 0;
  } catch {
    return 0;
  }
}

/** 把 `{due}` 这类占位符替换成实际值。未识别的占位符原样保留 ——
 *  那通常是配置写错了，留着比静默吞掉更容易发现。 */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * 按配置拼出微信要的 data 结构。
 * 配置形如 { "thing1": "今天有 {due} 张卡片到期", "time2": "{time}" }，
 * 输出 { thing1: { value: '今天有 12 张卡片到期' }, time2: { value: '20:00' } }。
 */
function buildData(payload, vars) {
  const out = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (typeof v !== 'string' || !k) continue;
    out[k] = { value: fill(v, vars).slice(0, 200) };
  }
  return out;
}

/**
 * 找出今天该推的人。
 *
 * 三个条件同时满足才推：
 *   1. 有到期卡片（没东西复习就别打扰）
 *   2. 授权过且有剩余额度（一次性授权，推完就没了）
 *   3. 账号是 active（停用的人不该收到任何消息）
 */
function candidates() {
  const day = today();
  return db.prepare(`
    SELECT u.id, u.email, u.username,
           s.template_id, s.quota_left,
           (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id AND c.due <= ?) AS due
    FROM users u
    JOIN push_sub s ON s.user_id = u.id
    WHERE u.status = 'active'
      AND s.granted = 1
      AND s.quota_left > 0
      AND (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id AND c.due <= ?) > 0
    ORDER BY due DESC
  `).all(day, day);
}

/**
 * 给一个人发一条。
 * @returns {{ok:boolean, errcode?:number, errmsg?:string}}
 */
async function sendOne(token, sub, cfg) {
  const day = today();
  /* 只有模板真的用了 {streak} 才去算 —— 见 streakOf 的注释。 */
  const needsStreak = Object.values(cfg.push.payload || {}).some((v) => String(v).includes('{streak}'));
  const vars = {
    due: sub.due,
    streak: needsStreak ? streakOf(sub.id) : 0,
    date: day,
    time: `${String(cfg.push.hour).padStart(2, '0')}:00`,
    name: sub.username || '同学',
  };

  const body = {
    touser: '', // 下面用 openid 填
    template_id: sub.template_id,
    page: cfg.push.page || 'pages/review/index',
    data: buildData(cfg.push.payload, vars),
  };

  /* openid 从 wx_bind 拿。没有绑定记录的账号（网页邮箱注册的老用户）
   * 推不了 —— 那是预期内的，记成失败但不算错误。 */
  const bind = db.prepare('SELECT openid FROM wx_bind WHERE user_id = ?').get(sub.id);
  if (!bind || !bind.openid) {
    return { ok: false, errcode: -1, errmsg: '这个账号没有绑定微信，无法推送' };
  }
  body.touser = bind.openid;

  try {
    const res = await fetch(`${SEND_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await res.json();

    /* errcode 0 才算成功。45009 = 接口调用超过限额，43101 = 用户拒收。 */
    if (r.errcode === 0) return { ok: true };
    return { ok: false, errcode: r.errcode, errmsg: r.errmsg || '' };
  } catch (e) {
    return { ok: false, errcode: -2, errmsg: `网络错误：${e.message}` };
  }
}

/**
 * 跑一轮推送。
 *
 * @param {{force?:boolean, dryRun?:boolean}} opts
 *   force  —— 忽略「今天已经推过」的判断（控制台手动触发时用）
 *   dryRun —— 只算人数，不发（用来确认配置对不对）
 */
export async function runPush({ force = false, dryRun = false } = {}) {
  const cfg = getConfig();
  const day = today();

  if (!cfg.push.on) return { ok: false, skipped: true, reason: '推送没开启' };
  if (!cfg.push.templateId) return { ok: false, skipped: true, reason: '没有配置模板 ID' };

  if (!force) {
    /* ★ date(at, 'localtime') 而不是 date(at)：
     * push_log.at 存的是 datetime('now')，那是 **UTC**；而 today()
     * 是本地日期。直接比会在东八区的凌晨 0~8 点之间错开一天 ——
     * 表现是「昨晚推过了，今早又推一次」。 */
    const done = db.prepare(
      "SELECT COUNT(*) n FROM push_log WHERE date(at, 'localtime') = ? AND ok = 1",
    ).get(day).n;
    if (done > 0) return { ok: true, skipped: true, reason: '今天已经推过了', sent: done };
  }

  const list = candidates();
  if (dryRun) {
    return { ok: true, dryRun: true, candidates: list.length, users: list.map((u) => ({ id: u.id, email: u.email, due: u.due })) };
  }
  if (!list.length) return { ok: true, sent: 0, failed: 0, reason: '没有需要推送的人' };

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return { ok: false, error: e.message };
  }

  let sent = 0;
  let failed = 0;

  for (const sub of list) {
    const r = await sendOne(token, sub, cfg);

    db.prepare(`INSERT INTO push_log (user_id, template_id, page, ok, errcode, errmsg)
      VALUES (?,?,?,?,?,?)`).run(
      sub.id, sub.template_id, cfg.push.page || '',
      r.ok ? 1 : 0,
      r.errcode ?? null,
      String(r.errmsg || '').slice(0, 200),
    );

    if (r.ok) {
      sent += 1;
      /* 一次性授权：推成功就减一条额度。减到 0 之后这个用户
       * 要重新在小程序里点一次「允许」才能再收到。 */
      db.prepare('UPDATE push_sub SET quota_left = MAX(quota_left - 1, 0) WHERE user_id = ? AND template_id = ?')
        .run(sub.id, sub.template_id);
    } else {
      failed += 1;
    }
  }

  return { ok: true, sent, failed, total: list.length };
}

/* 上次推送的日期。进程内记录，重启后从 push_log 恢复 ——
 * 不这样做的话，一天内重启三次就会推三次。 */
let lastRunDay = null;

function restoreLastRun() {
  try {
    const row = db.prepare('SELECT MAX(date(at)) d FROM push_log WHERE ok = 1').get();
    lastRunDay = row?.d || null;
  } catch {
    lastRunDay = null;
  }
}

/**
 * 启动定时器。每 10 分钟看一次「现在是不是该推的小时」。
 *
 * 为什么不用精确的 setTimeout 到整点：小程序用户会在意「今天有没有
 * 收到提醒」，不会在意是 20:00:00 还是 20:07。而 10 分钟一次的
 * 轮询对「进程中途重启」是鲁棒的 —— 精确计时器一重启就丢。
 */
export function startPushScheduler(log) {
  restoreLastRun();

  const timer = setInterval(async () => {
    const cfg = getConfig();
    if (!cfg.push.on || !cfg.push.templateId) return;

    const now = new Date();
    if (now.getHours() !== Number(cfg.push.hour)) return;

    const day = today();
    if (lastRunDay === day) return;

    lastRunDay = day; // 先占位，防止并发的下一次 tick 重复跑
    try {
      const r = await runPush({ force: false });
      if (r.sent) log.info(`订阅消息推送完成：成功 ${r.sent} / 失败 ${r.failed}`);
      else if (r.reason) log.info(`订阅消息推送跳过：${r.reason}`);
      if (r.error) log.warn(`订阅消息推送失败：${r.error}`);
    } catch (e) {
      log.error({ err: e }, '订阅消息推送异常');
    }
  }, 10 * 60 * 1000);

  /* unref：这个定时器不该阻止进程退出 */
  timer.unref();
  return timer;
}
