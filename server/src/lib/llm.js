/* 模型接入解析 + 每日配额
 *
 * ── 为什么要单独一个文件 ──────────────────────────────────────────
 * 原来这段逻辑在 routes/misc.js 的 resolveLlm() 里，只有 5 行：
 * 「local 用本地地址，cloud 用云端地址 + 用户自己的 Key」。
 *
 * 加了「服务端统一 Key」之后，同一个函数要回答的问题变成了：
 *   · 这个用户这次该用谁的 Key？
 *   · 他还剩几次额度？
 *   · 如果上游挂了，这次扣掉的额度要不要退？
 * 这些都不是「解析一个字段」，而是一条有状态的流程。放在路由里
 * 会被 9 个 AI 接口各抄一遍，所以抽出来。
 *
 * ── ★ 安全红线（这段最重要）────────────────────────────────────
 * mode = 'server' 时，**必须彻底忽略用户自己填的 cloud_base**。
 *
 * 反例：如果统一 Key 模式下还沿用用户的 base，那么任何一个注册用户
 * 把 base 改成 https://evil.example，服务端下一次 AI 调用就会带着
 * **你的 Key** 打到他的服务器上。这不是「可能被滥用」，这是一个
 * 一行配置就能用的 Key 提取器。
 *
 * lib/llmUrl.js 那套 SSRF 防线拦不住这个 —— 它拦的是内网地址
 * （127.0.0.1、10.x），而 evil.example 是一个完全合法的公网域名。
 *
 * 所以这里的分支是硬隔离：server 模式下 base/model/key 三个字段
 * 全部来自配置和环境变量，用户的 llm_settings 表**一个字都不读**。
 * 只有 byok 模式才走用户配置。
 */

import { db } from '../db/index.js';
import { getConfig } from './appConfig.js';
import { today } from './dates.js';

/**
 * 解析该用户这次实际要用的模型配置。
 *
 * @returns {null | {base:string, model:string, key:string, source:'server'|'byok-local'|'byok-cloud'}}
 *          返回 null 表示「这个用户还没配过模型」（只有 byok 模式会）。
 */
export function resolveLlmFor(userId) {
  const c = getConfig();

  if (c.ai.mode === 'server') {
    return {
      base: c.ai.base,
      model: c.ai.model,
      key: (process.env.SERVER_LLM_KEY || '').trim(),
      source: 'server',
    };
  }

  const l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(userId);
  if (!l) return null;

  if (l.kind === 'local') {
    return { base: l.local_base, model: l.local_model, key: '', source: 'byok-local' };
  }
  return { base: l.cloud_base, model: l.cloud_model, key: l.cloud_key, source: 'byok-cloud' };
}

/**
 * 解析 vision（图片识别）用的模型配置。
 *
 * 逻辑：先走 resolveLlmFor 拿 base/key，再用 visionModel 覆盖 model。
 * 为什么 model 可以单独覆盖：很多 vision 模型（gpt-4o、claude-3、
 * deepseek-chat）和文本模型共用同一套 base/key，只是 model 名不同。
 * 如果 visionModel 没配（空字符串），就复用文本模型的 model ——
 * 假设它也支持 vision（deepseek-chat / gpt-4o 都支持）。
 */
export function resolveVisionLlm(userId) {
  const cfg = resolveLlmFor(userId);
  if (!cfg) return null;
  const c = getConfig();
  if (c.ai.visionModel && String(c.ai.visionModel).trim()) {
    cfg.model = String(c.ai.visionModel).trim();
  }
  return cfg;
}

/**
 * 该用户当前生效的每日上限。
 *
 * 优先级：个人覆盖（users.ai_daily_limit，NULL 表示没设）> 全局默认。
 * 0 在两级里都表示「不限」，而且必须能区分「没设」和「设成不限」——
 * 所以个人覆盖用 NULL 而不是 0 当哨兵（见 migrate.js 里的注释）。
 *
 * ★ byok 模式下**永远返回 0（不限）**。
 *   配额的意义是「别让陌生人的调用花我的钱」。用户自己填的 Key
 *   花的是他自己的钱，服务端再拦一道就成了纯粹的添堵 ——
 *   而且会让老用户升级后突然发现「AI 用着用着不能用了」。
 */
export function dailyLimitFor(userId) {
  const c = getConfig();
  if (c.ai.mode !== 'server') return 0;

  const globalLimit = Number(c.ai.dailyCalls) || 0;

  const row = db.prepare('SELECT ai_daily_limit FROM users WHERE id = ?').get(userId);
  const override = row?.ai_daily_limit;
  if (override === null || override === undefined) return globalLimit;

  const n = Number(override);
  return Number.isFinite(n) && n >= 0 ? n : globalLimit;
}

/** 当前用量。只读，不扣。 */
export function quotaState(userId) {
  const day = today();
  const limit = dailyLimitFor(userId);
  const used = db.prepare('SELECT calls FROM ai_usage WHERE user_id = ? AND day = ?')
    .get(userId, day)?.calls ?? 0;

  return {
    day,
    limit,
    used,
    /* remaining = null 表示「不限」。
     * 用 null 而不是 Infinity：JSON.stringify(Infinity) 是 null，
     * 与其让前端收到一个会变成 null 的 Infinity，不如直接给 null。 */
    remaining: limit === 0 ? null : Math.max(0, limit - used),
  };
}

/**
 * 扣一次额度。**在调用上游之前扣。**
 *
 * 为什么先扣后调：如果先调再扣，那么「上游超时」和「上游返回 401」
 * 这类失败就永远不会被计数 —— 而它们恰恰是最容易被刷的路径
 * （拿一个坏 Key 疯狂重试，服务端每次都真的发出请求）。
 * 先扣后调保证「每一次真正打到上游的请求都被记账」。
 *
 * 代价是失败的那次也被扣了，所以调用方在明确失败时要 refundQuota()。
 * 这里的取舍是「宁可少给一次，不可漏记一次」。
 *
 * @returns {{ok:boolean, code?:string, error?:string, day:string, limit:number, used:number, remaining:number|null}}
 */
export function consumeQuota(userId) {
  const st = quotaState(userId);

  if (st.limit !== 0 && st.used >= st.limit) {
    return {
      ok: false,
      code: 'QUOTA_EXCEEDED',
      error: `今天的 AI 次数用完了（上限 ${st.limit} 次），明天 0 点重置。`,
      ...st,
    };
  }

  /* 一条 UPSERT 完成「有行就 +1，没行就建 1」。
   * 不先 SELECT 再 INSERT/UPDATE：那中间有一个并发窗口，
   * 两次并发请求会都读到 used=0，然后都写成 1 —— 少记一次。
   * UPSERT 是原子的。 */
  db.prepare(`INSERT INTO ai_usage (user_id, day, calls) VALUES (?, ?, 1)
    ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1`).run(userId, st.day);

  return {
    ok: true,
    day: st.day,
    limit: st.limit,
    used: st.used + 1,
    remaining: st.limit === 0 ? null : Math.max(0, st.limit - st.used - 1),
  };
}

/**
 * 退还一次额度。用于「请求根本没打到上游就失败了」的场景：
 * 连不上、DNS 失败、上游 5xx。
 *
 * ★ 不退的情况：上游返回 4xx（Key 错、余额不足、模型名不存在）。
 *   那些请求**确实打到了上游**，也**确实花了时间**，而且它们是最可能
 *   被拿来刷的路径。如果 4xx 也退，配额就形同虚设。
 */
export function refundQuota(userId) {
  const day = today();
  db.prepare('UPDATE ai_usage SET calls = MAX(calls - 1, 0) WHERE user_id = ? AND day = ?')
    .run(userId, day);
}

/** 控制台用：全局今日用量概览。 */
export function usageOverview() {
  const day = today();
  const rows = db.prepare(`
    SELECT u.id, u.email, u.username, COALESCE(a.calls, 0) AS calls,
           u.ai_daily_limit
    FROM users u
    LEFT JOIN ai_usage a ON a.user_id = u.id AND a.day = ?
    ORDER BY calls DESC
  `).all(day);

  const total = rows.reduce((s, r) => s + r.calls, 0);
  return { day, total, users: rows };
}
