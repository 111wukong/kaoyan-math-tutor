/* 小程序控制台接口 /api/admin/app/*
 *
 * ── 这个文件存在的理由 ────────────────────────────────────────────
 * Web 端不只是「另一个客户端」，它是小程序的**运营后台**。
 *
 * 小程序审核一次 1~7 天、发版更久，而下面这些事每周都可能要做：
 *   · 关掉一个出问题的功能
 *   · 调每日 AI 配额（Key 的账单在涨）
 *   · 改公告、进入维护模式
 *   · 换订阅消息模板 / 改推送时间
 *   · 清公式图缓存、看缓存占了多少磁盘
 *   · 看谁在刷 AI、给某个人单独放开额度
 *
 * 这些如果都要改代码重新提审，小程序就成了一个僵死的东西。
 * 所以它们全部落在这个后台里。
 *
 * ── 与 admin.js 的分工 ────────────────────────────────────────────
 * admin.js 管**人**（建号、改角色、停用、删号、重置密码）。
 * 这个文件管**小程序这个产品**（配置、配额、推送、渲染缓存）。
 * 分开是因为它们的变更频率和风险等级完全不同：改一个人的密码
 * 是一次性操作，调配额是天天做的事。
 *
 * 所有路由显式挂 requireAdmin，理由见 admin.js 开头第 1 条。
 */

import { db } from '../db/index.js';
import { getConfig, saveConfig, previewConfig, DEFAULTS } from '../lib/appConfig.js';
import { usageOverview, dailyLimitFor } from '../lib/llm.js';
import { cacheStats, clearCache, pngAvailable, warm } from '../lib/renderMath.js';

function audit(req, action, { target = null, detail = {} } = {}) {
  try {
    db.prepare(`INSERT INTO admin_log (actor_id, actor_email, target_id, target_email, action, detail, ip)
      VALUES (?,?,?,?,?,?,?)`).run(
      req.admin.id, req.admin.email,
      target?.id ?? null, target?.email ?? null,
      action, JSON.stringify(detail), String(req.ip || '').slice(0, 60),
    );
  } catch (e) {
    req.log.error({ err: e }, '写管理审计失败');
  }
}

/* ---------- 配置校验 ----------
 *
 * 为什么要在服务端校验，而不是「前端表单已经限制住了」：
 * 前端限制只对走界面的管理员有效。这个后台可能被 curl 调用
 * （换机器、写脚本、以后接 CLI），而一份坏配置的后果是**小程序
 * 全体用户白屏** —— 那时候连「进后台改回来」都要先修服务。
 *
 * 所以每条都校验，而且返回具体哪一条不对，不要只说「参数错误」。
 */

const HTTP_RE = /^https?:\/\/[^\s]+$/i;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function validateConfig(next) {
  const errs = [];

  if (next.version) {
    if (next.version.latest && !VERSION_RE.test(next.version.latest)) {
      errs.push('version.latest 必须是 1.0.0 这种三段式版本号');
    }
    if (next.version.min && !VERSION_RE.test(next.version.min)) {
      errs.push('version.min 必须是 1.0.0 这种三段式版本号（留空表示不强制更新）');
    }
  }

  if (next.notice && !['info', 'warn'].includes(next.notice.level)) {
    errs.push('notice.level 只能是 info 或 warn');
  }

  if (next.ai) {
    if (!['server', 'byok'].includes(next.ai.mode)) {
      errs.push('ai.mode 只能是 server 或 byok');
    }
    if (next.ai.base && !HTTP_RE.test(next.ai.base)) {
      errs.push('ai.base 必须是 http(s):// 开头的地址');
    }
    if (next.ai.model !== undefined && !String(next.ai.model).trim()) {
      errs.push('ai.model 不能为空');
    }
    const n = Number(next.ai.dailyCalls);
    if (!Number.isInteger(n) || n < 0) {
      errs.push('ai.dailyCalls 必须是不小于 0 的整数（0 表示不限）');
    }
  }

  if (next.push) {
    const h = Number(next.push.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      errs.push('push.hour 必须是 0~23 的整数');
    }
    /* 模板 ID 是微信后台生成的一串 43 字符左右的 base64url。
     * 不校验格式，只校验「开了推送却没填模板」这个必然出错的组合 ——
     * 那种配置下每次推送都会失败，而且错误码很难懂。 */
    if (next.push.on && !String(next.push.templateId || '').trim()) {
      errs.push('开启推送时必须填写订阅消息模板 ID');
    }
  }

  if (next.bank && next.bank.baseUrl && !HTTP_RE.test(next.bank.baseUrl)) {
    errs.push('bank.baseUrl 必须是 http(s):// 开头的地址（留空表示走本站）');
  }

  if (next.study) {
    const dn = Number(next.study.dailyNew);
    if (!Number.isInteger(dn) || dn < 0) errs.push('study.dailyNew 必须是不小于 0 的整数');
    const rc = Number(next.study.reviewCap);
    if (!Number.isInteger(rc) || rc < 1) errs.push('study.reviewCap 必须是不小于 1 的整数');
  }

  return errs;
}

export default async function adminAppRoutes(fastify) {
  /* ============ 读配置 ============
   * 返回完整配置（含 ai.base/model）—— 这是管理员，看得见实现细节。 */
  fastify.get('/api/admin/app/config', { preHandler: fastify.requireAdmin }, async () => {
    return {
      config: getConfig(),
      defaults: DEFAULTS,
      /* 环境状态和配置放一起返回：管理员打开这一页时最想知道的是
       * 「现在这套配置能不能真的跑起来」，而不只是「配置项填了什么」。
       * 一个填得很漂亮的配置 + 一个没设的 SERVER_LLM_KEY = AI 全挂。 */
      env: {
        serverLlmKey: Boolean((process.env.SERVER_LLM_KEY || '').trim()),
        wxAppId: Boolean((process.env.WX_APPID || '').trim()),
        wxSecret: Boolean((process.env.WX_SECRET || '').trim()),
        wxDevLogin: process.env.WX_DEV_LOGIN === '1',
        pngAvailable: pngAvailable(),
        nodeEnv: process.env.NODE_ENV || 'development',
      },
    };
  });

  /* ============ 改配置 ============ */
  fastify.put('/api/admin/app/config', {
    preHandler: fastify.requireAdmin,
    schema: {
      body: { type: 'object', additionalProperties: true },
    },
  }, async (req, reply) => {
    const patch = req.body || {};
    /* ★ 必须用 previewConfig（深合并）而不是 {...getConfig(), ...patch}。
     *   后者是浅合并：只传 {ai:{dailyCalls:50}} 时整个 ai 对象会被
     *   替换成只剩 dailyCalls，mode/base/model 全丢，然后校验报
     *   「ai.mode 只能是 server 或 byok」—— 管理员完全看不懂为什么。 */
    const merged = previewConfig(patch);

    const errs = validateConfig(merged);
    if (errs.length) {
      return reply.code(400).send({ error: errs[0], code: 'BAD_CONFIG', errors: errs });
    }

    const before = getConfig();
    const { config, changed } = saveConfig(patch);

    audit(req, 'app_config_update', {
      detail: {
        changed,
        /* 只记改动块的 before/after，不记整份配置 ——
         * 整份配置会让每条审计日志变成几 KB。 */
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, config[k]])),
      },
    });

    return { ok: true, config, changed };
  });

  /* ============ 环境自检 ============
   * 单独一个接口，方便以后写脚本轮询（部署后跑一次，确认没漏配）。 */
  fastify.get('/api/admin/app/env', { preHandler: fastify.requireAdmin }, async () => {
    const cfg = getConfig();
    const checks = [];

    if (cfg.ai.mode === 'server' && !(process.env.SERVER_LLM_KEY || '').trim()) {
      checks.push({
        level: 'error',
        key: 'serverLlmKey',
        message: 'AI 模式是「服务端统一 Key」，但没有设置 SERVER_LLM_KEY —— 所有 AI 接口会直接返回 400。',
      });
    }
    if (cfg.ai.mode === 'server' && cfg.push.on && !cfg.push.templateId) {
      checks.push({ level: 'warn', key: 'pushTemplate', message: '推送已开启但没填模板 ID。' });
    }
    if (!pngAvailable()) {
      checks.push({
        level: 'warn',
        key: 'resvg',
        message: 'PNG 光栅化不可用（@resvg/resvg-js 没装或加载失败），公式图会降级成 SVG —— iOS 小程序可能显示空白。',
      });
    }
    if (process.env.WX_DEV_LOGIN === '1') {
      checks.push({
        level: 'error',
        key: 'wxDevLogin',
        message: 'WX_DEV_LOGIN=1 正在生效：任何人可以用任意 code 登录成任意 openid。这只允许在本地开发时打开。',
      });
    }
    if (!process.env.WX_APPID && process.env.WX_DEV_LOGIN !== '1') {
      checks.push({ level: 'warn', key: 'wxAppId', message: '没有配置 WX_APPID / WX_SECRET，微信登录不可用。' });
    }

    return {
      checks,
      ok: checks.every((c) => c.level !== 'error'),
      config: { aiMode: cfg.ai.mode, pushOn: cfg.push.on, maintenance: cfg.maintenance.on },
    };
  });

  /* ============ AI 用量 ============
   * 这是控制台最常看的一页：今天谁用得多、总额度还剩多少。 */
  fastify.get('/api/admin/app/usage', { preHandler: fastify.requireAdmin }, async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query?.days) || 14));
    const cfg = getConfig();

    const overview = usageOverview();

    /* 近 N 天的总量趋势。用来回答「这个月账单是不是在涨」。 */
    const trend = db.prepare(`
      SELECT day, SUM(calls) AS calls, COUNT(DISTINCT user_id) AS users
      FROM ai_usage
      GROUP BY day
      ORDER BY day DESC
      LIMIT ?
    `).all(days).reverse();

    /* 每人每人的上限要和「实际生效值」一起给 —— 因为个人覆盖可能
     * 是 NULL（用全局），前端不能直接拿 ai_daily_limit 显示，
     * 那会显示成空白。 */
    const users = overview.users.map((u) => ({
      id: u.id,
      email: u.email,
      username: u.username,
      calls: u.calls,
      override: u.ai_daily_limit,
      limit: dailyLimitFor(u.id),
      remaining: dailyLimitFor(u.id) === 0 ? null : Math.max(0, dailyLimitFor(u.id) - u.calls),
    }));

    return {
      day: overview.day,
      total: overview.total,
      globalLimit: cfg.ai.dailyCalls,
      mode: cfg.ai.mode,
      trend,
      users,
    };
  });

  /* ============ 单独调某个人的配额 ============
   *
   * body: { limit: number | null }
   *   null = 清掉个人覆盖，回到全局默认
   *   0    = 不限
   *   n>0  = 每日 n 次
   *
   * ★ 为什么允许 0（不限）：把某个人的额度放开是合理需求
   *   （比如你自己）。但界面上要提示「这会让该用户的调用直接计入
   *   你的账单」—— 不设上限的账号是最容易被忽略的成本来源。 */
  fastify.patch('/api/admin/app/users/:id/quota', {
    preHandler: fastify.requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['limit'],
        properties: { limit: { type: ['integer', 'null'] } },
      },
    },
  }, async (req, reply) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT id, email, ai_daily_limit FROM users WHERE id = ?').get(id);
    if (!target) return reply.code(403).send({ error: '用户不存在', code: 'FORBIDDEN' });

    const limit = req.body.limit;
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
      return reply.code(400).send({ error: 'limit 必须是不小于 0 的整数，或 null', code: 'BAD_LIMIT' });
    }

    db.prepare('UPDATE users SET ai_daily_limit = ? WHERE id = ?').run(limit, id);

    audit(req, 'app_quota_update', {
      target,
      detail: { before: target.ai_daily_limit, after: limit },
    });

    return { ok: true, id, limit, effective: dailyLimitFor(id) };
  });

  /* ============ 推送状态 ============
   * 「昨天推了没有、失败在哪」—— 没有这张表，推送就是个黑盒。 */
  fastify.get('/api/admin/app/push', { preHandler: fastify.requireAdmin }, async () => {
    const cfg = getConfig();

    const subs = db.prepare(`
      SELECT s.user_id, s.template_id, s.granted, s.quota_left, s.updated_at,
             u.email, u.username
      FROM push_sub s JOIN users u ON u.id = s.user_id
      ORDER BY s.updated_at DESC
      LIMIT 200
    `).all();

    const logs = db.prepare(`
      SELECT p.id, p.user_id, p.template_id, p.page, p.ok, p.errcode, p.errmsg, p.at,
             u.email
      FROM push_log p LEFT JOIN users u ON u.id = p.user_id
      ORDER BY p.at DESC
      LIMIT 100
    `).all();

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
      FROM push_log
      WHERE at >= datetime('now', '-7 days')
    `).get();

    return {
      config: cfg.push,
      stats: { total: stats.total || 0, ok: stats.ok || 0, failed: stats.failed || 0 },
      subscribers: subs.length,
      withQuota: subs.filter((s) => s.quota_left > 0).length,
      subs,
      logs,
    };
  });

  /* ============ 渲染缓存 ============ */
  fastify.get('/api/admin/app/render', { preHandler: fastify.requireAdmin }, async () => ({
    ...cacheStats(),
    pngAvailable: pngAvailable(),
  }));

  fastify.post('/api/admin/app/render/clear', { preHandler: fastify.requireAdmin }, async (req) => {
    const n = clearCache();
    audit(req, 'app_render_clear', { detail: { removed: n } });
    return { ok: true, removed: n };
  });

  /* 预热：把题库里所有公式先渲一遍。
   * 为什么需要它：第一次有人打开某道题时现渲，那一屏要等 1~2 秒。
   * 部署后点一次这个按钮，之后所有人都是秒开。 */
  fastify.post('/api/admin/app/render/warm', { preHandler: fastify.requireAdmin }, async () => {
    const ok = warm();
    return { ok, ...cacheStats() };
  });
}
