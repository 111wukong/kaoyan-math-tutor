/* 小程序端接口
 *
 * 这个文件是「第二个客户端」的接入层。它不实现业务 —— 业务全在
 * catalog / study / cards / ai 那些路由里，Web 和小程序共用同一套。
 * 这里只做三件事：
 *   1. 启动配置下发（app_config）
 *   2. 微信登录（openid → 会话 token）
 *   3. 公式渲染（LaTeX → PNG，这是小程序唯一真正缺的能力）
 *
 * ── 为什么认证要额外支持 Bearer ──────────────────────────────────
 * Web 端靠 httpOnly cookie，小程序没有 cookie 这个概念（wx.request
 * 有一个隐式的 cookie 容器，但不可读、不可控、清缓存就丢，而且
 * 排查 401 时完全看不见它）。所以小程序走 Authorization: Bearer。
 * 服务端两条路都认，见 index.js 的 readToken()。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { db } from '../db/index.js';
import { publicConfig, getConfig } from '../lib/appConfig.js';
import { quotaState } from '../lib/llm.js';
import { splitText, ensureAsset, cacheStats, CACHE_DIR } from '../lib/renderMath.js';
import { createSession } from '../lib/session.js';
import { hashPassword } from '../lib/password.js';
import { randomPassword } from '../db/migrate.js';

/* 渲染接口是 CPU 密集的（MathJax 排版 + resvg 光栅化），
 * 全局那条 600/分钟 的闸门对它太松 —— 一个脚本能在一分钟内
 * 把 CPU 打满，把正常用户的请求全拖慢。单列一个更紧的。 */
const RENDER_LIMIT = { max: 120, timeWindow: '1 minute' };

/* 一次最多渲染多少条。批量接口的意义是「一次请求把一整道题的
 * 题干+四个选项+解析全渲完」，正常 10 条以内。给到 60 是留余量，
 * 同时也是防滥用的上限 —— 没有上限的话，一次请求就能塞一万条。 */
const MAX_BATCH = 60;

/* 墨色格式校验。它会被拼进缓存键，也是唯一进入文件名的可控字段
 * 之一（另一个是 hash），所以必须严格。 */
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function pickColor(raw) {
  const c = String(raw || '').trim();
  return COLOR_RE.test(c) ? c : undefined;
}

/* ---------- 微信登录 ---------- */

const WX_APPID = (process.env.WX_APPID || '').trim();
const WX_SECRET = (process.env.WX_SECRET || '').trim();

/* ★ 本地开发用的旁路。
 *
 * 没有注册小程序、或者不想每次真机调试都走一遍 code2session 时，
 * 可以直接传一个固定的 openid 登录。**只在显式打开时才生效**，
 * 而且启动时会打一条醒目的警告 —— 这种东西最怕的是「忘了关」
 * 被带上生产，所以它的开启条件必须是「有人专门去设了一个环境变量」，
 * 而不是「不是生产环境就自动开」。 */
const WX_DEV_LOGIN = process.env.WX_DEV_LOGIN === '1';

/**
 * 用 code 换 openid。生产走微信官方接口。
 * @returns {Promise<{openid:string, unionid?:string}|{error:string}>}
 */
async function code2openid(code) {
  if (WX_DEV_LOGIN) {
    /* 开发旁路：把 code 直接当 openid 用。
     * 加前缀是为了让开发账号在库里一眼能认出来，不会和真实 openid 混。 */
    return { openid: `dev_${String(code).slice(0, 40) || 'local'}` };
  }

  if (!WX_APPID || !WX_SECRET) {
    return {
      error: '服务端还没配置 WX_APPID / WX_SECRET，微信登录不可用。'
        + '（本地开发可以设 WX_DEV_LOGIN=1 走旁路）',
    };
  }

  const url = 'https://api.weixin.qq.com/sns/jscode2session'
    + `?appid=${encodeURIComponent(WX_APPID)}`
    + `&secret=${encodeURIComponent(WX_SECRET)}`
    + `&js_code=${encodeURIComponent(code)}`
    + '&grant_type=authorization_code';

  let body;
  try {
    const res = await fetch(url, { method: 'GET' });
    body = await res.json();
  } catch (e) {
    return { error: `连不上微信服务器：${e.message}` };
  }

  /* 微信的失败也是 200 + errcode，不看 errcode 会把失败当成功，
   * 然后拿着 undefined 的 openid 去建账号。 */
  if (body.errcode) {
    return { error: `微信登录失败（${body.errcode}）：${body.errmsg || ''}` };
  }
  if (!body.openid) return { error: '微信没有返回 openid' };

  return { openid: body.openid, unionid: body.unionid || '' };
}

/** 合成邮箱。见 schema.sql 里 wx_bind 的注释：users.email 是 NOT NULL。 */
function synthEmail(openid) {
  const h = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
  return `wx_${h}@wx.local`;
}

/**
 * 找到或创建这个 openid 对应的用户。
 *
 * 三种情况：
 *   1. wx_bind 里已有 → 直接返回那个 user_id（最常见）
 *   2. 没有绑定，但合成邮箱已被占用 → 说明是历史数据，补一条绑定
 *   3. 全新的微信用户 → 建 users 行 + 三张单行表 + 绑定
 *
 * ★ 第 3 步的四次写必须在一个事务里。否则中途失败会留下
 *   「有 users 行但没有 user_settings」的半残账号 —— 那个账号
 *   一进设置页就会因为取不到行而报错，而且它永远绑不上微信
 *   （下次登录会走到第 2 步，补绑定，但缺的那张表还是缺）。
 */
function findOrCreateWxUser(openid, { unionid = '', nickname = '', avatar = '' } = {}) {
  const bound = db.prepare('SELECT user_id FROM wx_bind WHERE openid = ?').get(openid);
  if (bound) {
    db.prepare("UPDATE wx_bind SET unionid = COALESCE(NULLIF(?, ''), unionid), nickname = COALESCE(NULLIF(?, ''), nickname), avatar = COALESCE(NULLIF(?, ''), avatar) WHERE openid = ?")
      .run(unionid, nickname, avatar, openid);
    return { userId: bound.user_id, created: false };
  }

  const email = synthEmail(openid);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  if (existing) {
    db.prepare('INSERT OR IGNORE INTO wx_bind (user_id, openid, unionid, nickname, avatar) VALUES (?,?,?,?,?)')
      .run(existing.id, openid, unionid, nickname, avatar);
    return { userId: existing.id, created: false };
  }

  /* 全新用户：把「建账号」推迟到调用方 —— 因为密码哈希是 async 的，
   * 而 better-sqlite3 的 transaction 必须是同步函数（在事务里 await
   * 会让事务在等待期间就被提交）。所以这里只把参数打包出去。 */
  return { pending: { email, openid, unionid, nickname, avatar } };
}

export default async function appRoutes(fastify) {
  /* ============ 启动配置（公开）============
   *
   * 小程序冷启动第一件事就是拉它，此时**还没登录**，所以必须公开。
   * 只返回 publicConfig() 那份白名单字段，不含模型地址/Key 等实现细节。 */
  fastify.get('/api/app/config', async () => {
    const c = getConfig();
    return {
      ...publicConfig(),
      /* 服务器时间。客户端据此校正本地时钟 —— 小程序的「今天」如果
       * 和服务器差一天，FSRS 的到期队列就会算错（少给或多给一批卡）。 */
      serverTime: new Date().toISOString(),
      pushHour: c.push.hour,
    };
  });

  /* ============ 微信登录（公开）============
   *
   * 请求：{ code, nickname?, avatar? }
   * 响应：{ token, expiresAt, user, created }
   *
   * ★ 返回的 token 和 Web 端的 cookie 是同一套会话（同一张 sessions 表），
   *   所以小程序和网页登录的是同一个账号，学习数据天然互通。 */
  fastify.post('/api/app/wx-login', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string' },
          nickname: { type: 'string' },
          avatar: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { code, nickname = '', avatar = '' } = req.body;

    const r = await code2openid(code);
    if (r.error) return reply.code(400).send({ error: r.error, code: 'WX_LOGIN_FAILED' });

    const found = findOrCreateWxUser(r.openid, { unionid: r.unionid, nickname, avatar });

    let userId;
    let created = false;

    if (found.userId) {
      userId = found.userId;
    } else {
      /* 新用户：先算哈希（async），再进同步事务。
       * 顺序不能反 —— better-sqlite3 的 transaction 不接受 async 函数，
       * 在事务里 await 会让事务在 await 期间就提交掉。 */
      const p = found.pending;
      /* 随机密码：这个账号永远不需要用密码登录（入口只有微信），
       * 但 users.password_hash 是 NOT NULL，所以必须给一个。
       * 用 24 位随机串而不是空串 —— 空串的 scrypt 哈希是一个
       * 众所周知的常量，等于给这个账号留了一个后门密码。 */
      const { hash, salt } = await hashPassword(randomPassword(24));

      const tx = db.transaction(() => {
        const info = db.prepare(`INSERT INTO users (email, username, password_hash, password_salt, avatar_hue)
          VALUES (?,?,?,?,?)`).run(
          p.email,
          (p.nickname || '研友').slice(0, 24),
          hash, salt,
          Math.floor(Math.random() * 360),
        );
        const id = Number(info.lastInsertRowid);
        db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(id);
        db.prepare('INSERT OR IGNORE INTO llm_settings (user_id) VALUES (?)').run(id);
        db.prepare('INSERT OR IGNORE INTO game_state (user_id) VALUES (?)').run(id);
        db.prepare('INSERT OR IGNORE INTO wx_bind (user_id, openid, unionid, nickname, avatar) VALUES (?,?,?,?,?)')
          .run(id, p.openid, p.unionid, p.nickname, p.avatar);
        return id;
      });

      userId = tx();
      created = true;
    }

    const { token, expiresAt } = createSession(userId, {
      userAgent: String(req.headers['user-agent'] || 'wx-miniprogram').slice(0, 300),
      ip: req.ip || '',
    });

    const u = db.prepare('SELECT id, email, username, avatar_hue, role, created_at FROM users WHERE id = ?').get(userId);

    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
    db.prepare("INSERT INTO auth_log (email, user_id, event, ip, user_agent) VALUES (?,?,?,?,?)")
      .run(u.email, userId, 'login_wx', String(req.ip || '').slice(0, 60),
        String(req.headers['user-agent'] || '').slice(0, 300));

    return {
      token,
      expiresAt,
      created,
      user: {
        id: u.id,
        email: u.email,
        username: u.username,
        avatarHue: u.avatar_hue,
        role: u.role || 'user',
        createdAt: u.created_at,
      },
    };
  });

  /* ============ 当前用户 + 配额 ============
   *
   * 小程序每次冷启动都会调：拿配额余量决定 AI 入口要不要置灰，
   * 拿 features 决定哪些入口显示。 */
  fastify.get('/api/app/me', async (req) => {
    const q = quotaState(req.userId);
    return {
      user: {
        id: req.user.user_id,
        email: req.user.email,
        username: req.user.username,
        avatarHue: req.user.avatar_hue,
        role: req.user.role || 'user',
      },
      quota: q,
      config: publicConfig(),
    };
  });

  /* ============ 订阅消息授权回报 ============
   *
   * 小程序调完 wx.requestSubscribeMessage 之后把结果告诉服务端。
   * 微信的订阅消息是**一次性**的：accept 一次只能发一条，
   * 所以这里记的是「还剩几条额度」，不是「永久许可」。 */
  fastify.post('/api/app/subscribe', {
    schema: {
      body: {
        type: 'object',
        required: ['templateId', 'accepted'],
        properties: {
          templateId: { type: 'string' },
          accepted: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const { templateId, accepted } = req.body;
    const cfg = getConfig();

    /* 只接受配置里那个模板的回报 —— 否则客户端可以往表里塞任意
     * template_id，把这张表当成一个任写的存储用。 */
    if (templateId !== cfg.push.templateId) {
      return { ok: false, ignored: true, reason: '模板不在白名单' };
    }

    db.prepare(`INSERT INTO push_sub (user_id, template_id, granted, quota_left, updated_at)
      VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(user_id, template_id) DO UPDATE SET
        granted = excluded.granted,
        quota_left = CASE WHEN excluded.granted = 1 THEN push_sub.quota_left + 1 ELSE 0 END,
        updated_at = datetime('now')`)
      .run(req.userId, templateId, accepted ? 1 : 0, accepted ? 1 : 0);

    const row = db.prepare('SELECT granted, quota_left FROM push_sub WHERE user_id = ? AND template_id = ?')
      .get(req.userId, templateId);

    return { ok: true, granted: !!row.granted, quotaLeft: row.quota_left };
  });

  /* ============ 公式渲染：单条/批量 ============
   *
   * 请求：{ items: [{ tex, display? }], format?: 'png'|'svg', color? }
   * 响应：{ items: [{ key, url, w, h, error?, fallback? }] }
   *
   * ★ 返回 URL 而不是内联 base64：
   *   · 同一道题的同一个公式在题库里反复出现，URL 能被 <image> 缓存；
   *   · base64 让响应涨 33%，且完全不可缓存；
   *   · 静态文件能带一年期 immutable 头。 */
  fastify.post('/api/render/math', {
    config: { rateLimit: RENDER_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['items'],
        properties: {
          format: { type: 'string' },
          color: { type: 'string' },
          items: {
            type: 'array',
            maxItems: MAX_BATCH,
            items: {
              type: 'object',
              required: ['tex'],
              properties: {
                tex: { type: 'string' },
                display: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const format = req.body.format === 'svg' ? 'svg' : 'png';
    const color = pickColor(req.body.color);

    return {
      format,
      items: req.body.items.map((it) => ensureAsset(String(it.tex).slice(0, 2000), !!it.display, format, color)),
    };
  });

  /* ============ 文本切段 ============
   *
   * 请求：{ texts: [{ text, display? }], format?, color? }
   * 响应：{ results: [{ segments, hasMath }] }
   *
   * 这是小程序 math-text 组件的服务端一半：客户端不用懂 LaTeX，
   * 拿到 segments 直接按 type 渲染 —— text 用 <text>，math 用 <image>。
   *
   * ★ 为什么要切段而不是整段出图：切段之后文字部分仍然可选中、
   *   可复制、可被读屏软件读到。整段出图等于把一道题变成一张图片，
   *   在无障碍和搜索上都是倒退。 */
  fastify.post('/api/render/text', {
    config: { rateLimit: RENDER_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['texts'],
        properties: {
          format: { type: 'string' },
          color: { type: 'string' },
          texts: {
            type: 'array',
            maxItems: MAX_BATCH,
            items: {
              type: 'object',
              required: ['text'],
              properties: { text: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (req) => {
    const format = req.body.format === 'svg' ? 'svg' : 'png';
    const color = pickColor(req.body.color);

    return {
      format,
      results: req.body.texts.map((it) => splitText(String(it.text).slice(0, 8000), { format, color })),
    };
  });

  /* ============ 渲染缓存统计（管理员看）============
   * 放在这里而不是 adminApp 里，是因为它读的是 renderMath 的私有目录。 */
  fastify.get('/api/app/render-stats', { preHandler: fastify.requireAdmin }, async () => cacheStats());

  /* ============ 静态资源：公式图 ============
   *
   * ★ 路径故意不在 /api 下面 —— 全局鉴权闸门只拦 /api/*，
   *   而 <image src> 发起的请求带不上 Authorization 头。
   *   公式图本身不含任何用户数据（内容只是 LaTeX 的渲染结果），
   *   公开是安全的。
   *
   * ★ 文件名严格校验。这个路由直接拼文件路径，如果不校验，
   *   请求 /math/..%2f..%2f.env 就能读到任意文件。
   *   只允许 24 位十六进制 + .png/.svg。 */
  fastify.get('/math/:file', async (req, reply) => {
    const { file } = req.params;
    if (!/^[a-f0-9]{24}\.(png|svg)$/.test(file)) {
      return reply.code(404).send({ error: '不存在' });
    }

    const full = path.join(CACHE_DIR, file);
    /* 二次确认：即使正则被绕过，也不允许跳出缓存目录。 */
    if (!full.startsWith(CACHE_DIR + path.sep) || !fs.existsSync(full)) {
      return reply.code(404).send({ error: '不存在' });
    }

    reply.header('Content-Type', file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
    /* 文件名是内容哈希，内容一变名字就变 —— 可以永久缓存。
     * 这一条是整个方案能「第二次零请求」的关键。 */
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(full));
  });
}
