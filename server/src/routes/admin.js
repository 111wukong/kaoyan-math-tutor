/* 管理接口 /api/admin/*
 *
 * ── 设计原则 ──────────────────────────────────────────────────────
 * 1. **每个路由都挂 requireAdmin**，不靠「父级前缀统一挂」。
 *    Fastify 的 prefix 注册和 preHandler 组合有好几种写法，
 *    而「以为挂上了其实没挂」是这类代码最典型的失效方式 ——
 *    它的表现是接口照常工作，只是谁都能调。逐条显式挂，多写十行，
 *    换的是「漏一个能被一眼看出来」。
 *
 * 2. **越权不是错误，是攻击**。所有拒绝都返回 403 + code=FORBIDDEN，
 *    不返回 404（返回 404 会被用来探测哪些 id 存在）。
 *
 * 3. **隐私边界**：管理员能看学情统计，但看不到
 *    · 密码哈希/盐（连脱敏形式都不给）
 *    · 用户的 LLM API Key（那是别人的密钥，不是系统资产）
 *    · 聊天内容、笔记正文、课堂记录原文
 *    能看的是「有多少条」而不是「内容是什么」。管理不是监视。
 *
 * 4. **护栏优先于便利**：任何会让系统失去最后一个管理员的操作，
 *    一律拒绝，包括管理员对自己下手。
 *
 * 5. **所有写操作进 admin_log**，含改前/改后的值。
 *    没有审计日志的管理后台，出事之后查不出是谁干的。
 */
import { db } from '../db/index.js';
import {
  hashPassword, checkPasswordStrength, checkEmail, checkUsername,
} from '../lib/password.js';
import { logAuth } from '../lib/session.js';
import { levelInfo } from '../lib/game.js';

const ROLES = ['user', 'admin'];
const STATUSES = ['active', 'disabled'];

/* ---------- 工具 ---------- */

/** 写一条管理审计。失败不能连累主流程 —— 审计是旁路，不是关键路径。 */
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

const shapeUser = (r) => ({
  id: r.id,
  email: r.email,
  username: r.username,
  role: r.role || 'user',
  status: r.status || 'active',
  note: r.note || '',
  avatarHue: r.avatar_hue,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastLoginAt: r.last_login_at,
});

/** 把列表行的统计列拼成嵌套对象，前端不用记一堆平铺字段名。 */
function shapeStats(r) {
  const attempts = r.n || 0;
  const correct = r.c || 0;
  const lv = levelInfo(r.xp || 0);
  return {
    attempts,
    correct,
    wrong: r.w || 0,
    accuracy: attempts ? Math.round((correct / attempts) * 100) : 0,
    xp: r.xp || 0,
    level: lv.level,
    levelTitle: lv.title,
    bestCombo: r.best_combo || 0,
    cards: r.cards || 0,
    deckCards: r.deck || 0,
    minutes: r.minutes || 0,
    activeDays: r.days || 0,
    achievements: r.ach || 0,
  };
}

/* 列表查询。用 LEFT JOIN 聚合子查询一次取全，不做 N+1。
 * 用户量大到几千时这里要改成物化统计表，但那是另一个量级的问题；
 * 现在每次请求跑一次全表聚合，比为了「可能的规模」提前加一层缓存更划算。 */
const LIST_SQL = `
  SELECT u.id, u.email, u.username, u.role, u.status, u.note, u.avatar_hue,
         u.created_at, u.updated_at, u.last_login_at,
         COALESCE(a.n, 0) n, COALESCE(a.c, 0) c, COALESCE(a.w, 0) w, COALESCE(a.days, 0) days,
         COALESCE(g.xp, 0) xp, COALESCE(g.best_combo, 0) best_combo,
         COALESCE(cd.cnt, 0) cards,
         COALESCE(dk.cnt, 0) deck,
         COALESCE(ck.minutes, 0) minutes,
         COALESCE(ac.cnt, 0) ach,
         COALESCE(ss.cnt, 0) sessions,
         ss.last_seen last_seen
  FROM users u
  LEFT JOIN (SELECT user_id, COUNT(*) n, SUM(correct) c, SUM(1 - correct) w,
                    COUNT(DISTINCT date) days
             FROM attempts GROUP BY user_id) a ON a.user_id = u.id
  LEFT JOIN game_state g ON g.user_id = u.id
  LEFT JOIN (SELECT user_id, COUNT(*) cnt FROM cards GROUP BY user_id) cd ON cd.user_id = u.id
  LEFT JOIN (SELECT user_id, COUNT(*) cnt FROM card_deck GROUP BY user_id) dk ON dk.user_id = u.id
  LEFT JOIN (SELECT user_id, SUM(minutes) minutes FROM checkins GROUP BY user_id) ck ON ck.user_id = u.id
  LEFT JOIN (SELECT user_id, COUNT(*) cnt FROM achievements GROUP BY user_id) ac ON ac.user_id = u.id
  LEFT JOIN (SELECT user_id, COUNT(*) cnt, MAX(last_seen_at) last_seen
             FROM sessions GROUP BY user_id) ss ON ss.user_id = u.id
`;

/* 排序白名单。**绝不能**把前端传来的字符串直接拼进 ORDER BY ——
 * 那是教科书级的 SQL 注入，而且参数化占位符在 ORDER BY 上不生效
 * （列名不是值）。只能白名单映射。 */
const SORTS = {
  created: 'u.created_at',
  lastLogin: 'u.last_login_at',
  lastSeen: 'ss.last_seen',
  attempts: 'n',
  accuracy: 'CASE WHEN n > 0 THEN CAST(c AS REAL) / n ELSE -1 END',
  xp: 'xp',
  level: 'xp',
  email: 'u.email',
  username: 'u.username',
};

export default async function adminRoutes(fastify) {
  /* ============ 总览 ============ */
  fastify.get('/api/admin/overview', { preHandler: fastify.requireAdmin }, async () => {
    const one = (sql, ...p) => db.prepare(sql).get(...p);

    const totals = one(`SELECT
      COUNT(*) users,
      SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) admins,
      SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) disabled,
      SUM(CASE WHEN date(last_login_at) >= date('now') THEN 1 ELSE 0 END) activeToday,
      SUM(CASE WHEN last_login_at IS NULL THEN 1 ELSE 0 END) neverLoggedIn
      FROM users`);

    const activity = one(`SELECT
      (SELECT COUNT(*) FROM attempts) attempts,
      (SELECT COUNT(*) FROM attempts WHERE correct = 1) correct,
      (SELECT COUNT(*) FROM sessions) sessions,
      (SELECT COUNT(*) FROM cards) cards,
      (SELECT COUNT(*) FROM card_deck) deck,
      (SELECT COUNT(*) FROM admin_log) adminActions`);

    const recent = db.prepare(`${LIST_SQL} ORDER BY u.created_at DESC LIMIT 5`).all()
      .map((r) => ({ ...shapeUser(r), stats: shapeStats(r) }));

    const dbSize = one('SELECT page_count * page_size bytes FROM pragma_page_count(), pragma_page_size()');

    return {
      totals: {
        users: totals.users || 0,
        admins: totals.admins || 0,
        disabled: totals.disabled || 0,
        activeToday: totals.activeToday || 0,
        neverLoggedIn: totals.neverLoggedIn || 0,
      },
      activity: {
        attempts: activity.attempts || 0,
        correct: activity.correct || 0,
        accuracy: activity.attempts ? Math.round((activity.correct / activity.attempts) * 100) : 0,
        sessions: activity.sessions || 0,
        cards: activity.cards || 0,
        deckCards: activity.deck || 0,
        adminActions: activity.adminActions || 0,
        dbMb: Number(((dbSize.bytes || 0) / 1024 / 1024).toFixed(2)),
      },
      recentUsers: recent,
    };
  });

  /* ============ 用户列表 ============ */
  fastify.get('/api/admin/users', {
    preHandler: fastify.requireAdmin,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          role: { type: 'string' },
          status: { type: 'string' },
          sort: { type: 'string' },
          dir: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          offset: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (req) => {
    const q = String(req.query.q || '').trim();
    const role = ROLES.includes(req.query.role) ? req.query.role : '';
    const status = STATUSES.includes(req.query.status) ? req.query.status : '';
    const sortKey = SORTS[req.query.sort] ? req.query.sort : 'created';
    const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = req.query.limit ?? 50;
    const offset = req.query.offset ?? 0;

    const where = [];
    const params = [];
    if (q) {
      where.push('(u.email LIKE ? OR u.username LIKE ? OR u.note LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (role) { where.push('u.role = ?'); params.push(role); }
    if (status) { where.push('u.status = ?'); params.push(status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db.prepare(`${LIST_SQL} ${clause} ORDER BY ${SORTS[sortKey]} ${dir}, u.id ${dir} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) n FROM users u ${clause}`).get(...params).n;

    return {
      users: rows.map((r) => ({
        ...shapeUser(r),
        stats: shapeStats(r),
        sessions: r.sessions || 0,
        lastSeenAt: r.last_seen || null,
      })),
      total,
      limit,
      offset,
    };
  });

  /* ============ 单个用户 ============ */
  fastify.get('/api/admin/users/:id', {
    preHandler: fastify.requireAdmin,
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const row = db.prepare(`${LIST_SQL} WHERE u.id = ?`).get(req.params.id);
    if (!row) return reply.code(404).send({ error: '用户不存在' });

    const uid = row.id;
    const recentAttempts = db.prepare(`
      SELECT a.qid, a.kid, a.correct, a.date, a.ts, q.stem
      FROM attempts a LEFT JOIN questions q ON q.id = a.qid
      WHERE a.user_id = ? ORDER BY a.ts DESC LIMIT 20`).all(uid);

    /* 会话列表给管理员看，但**不返回 token_hash** —— 那东西本身
     * 换不出 cookie（库里存的是哈希），但泄露它等于告诉别人
     * 「这些哈希值得拿去撞」，没必要。 */
    const sessions = db.prepare(`SELECT created_at, last_seen_at, expires_at, user_agent, ip
      FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 20`).all(uid);

    const settings = db.prepare(`SELECT exam_track, daily_new, exam_date, persona, sfx, theme
      FROM user_settings WHERE user_id = ?`).get(uid) || null;

    /* LLM 配置只回「配没配」，不回 base URL 和密钥 ——
     * 别人用的哪家模型、地址是什么，属于他的技术选择，不属于管理范畴。 */
    const llm = db.prepare('SELECT enabled, kind, cloud_key, local_model, cloud_model FROM llm_settings WHERE user_id = ?').get(uid);

    const daily = db.prepare(`SELECT date, n, c FROM stats_daily WHERE user_id = ?
      ORDER BY date DESC LIMIT 30`).all(uid).reverse();

    const logs = db.prepare(`SELECT id, actor_email, action, detail, at FROM admin_log
      WHERE target_id = ? ORDER BY at DESC LIMIT 30`).all(uid)
      .map((l) => ({ ...l, detail: safeJson(l.detail, {}) }));

    return {
      user: { ...shapeUser(row), stats: shapeStats(row), sessions: row.sessions || 0, lastSeenAt: row.last_seen || null },
      recentAttempts,
      sessions,
      settings: settings ? {
        examTrack: settings.exam_track,
        dailyNew: settings.daily_new,
        examDate: settings.exam_date,
        persona: settings.persona,
        sfx: settings.sfx === 1,
        theme: settings.theme,
      } : null,
      llm: llm ? {
        enabled: llm.enabled === 1,
        kind: llm.kind,
        hasKey: !!llm.cloud_key,
        model: llm.kind === 'local' ? llm.local_model : llm.cloud_model,
      } : null,
      daily,
      logs,
    };
  });

  /* ============ 新建用户 ============ */
  fastify.post('/api/admin/users', {
    preHandler: fastify.requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['email', 'username', 'password'],
        properties: {
          email: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
          role: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const role = ROLES.includes(req.body.role) ? req.body.role : 'user';
    const note = String(req.body.note || '').slice(0, 500);

    for (const err of [checkEmail(email), checkUsername(username), checkPasswordStrength(password)]) {
      if (err) return reply.code(400).send({ error: err });
    }
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      return reply.code(409).send({ error: '这个邮箱已经被占用了' });
    }

    const { hash, salt } = await hashPassword(password);
    const info = db.prepare(`INSERT INTO users (email, username, password_hash, password_salt, avatar_hue, role, note)
      VALUES (?,?,?,?,?,?,?)`)
      .run(email, username, hash, salt, Math.floor(Math.random() * 360), role, note);

    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(id);
    db.prepare('INSERT OR IGNORE INTO llm_settings (user_id) VALUES (?)').run(id);
    db.prepare('INSERT OR IGNORE INTO game_state (user_id) VALUES (?)').run(id);

    const target = { id, email };
    audit(req, 'user_create', { target, detail: { username, role, note } });

    const row = db.prepare(`${LIST_SQL} WHERE u.id = ?`).get(id);
    return { ok: true, user: { ...shapeUser(row), stats: shapeStats(row) } };
  });

  /* ============ 修改用户 ============ */
  fastify.patch('/api/admin/users/:id', {
    preHandler: fastify.requireAdmin,
    schema: {
      params: { type: 'object', properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          username: { type: 'string' },
          role: { type: 'string' },
          status: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const id = req.params.id;
    const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!cur) return reply.code(404).send({ error: '用户不存在' });

    const b = req.body || {};
    const sets = [];
    const params = [];
    const changed = {};

    /* ---- 邮箱 ---- */
    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase();
      const err = checkEmail(email);
      if (err) return reply.code(400).send({ error: err });
      const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, id);
      if (dup) return reply.code(409).send({ error: '这个邮箱已经被占用了' });
      if (email !== cur.email) { sets.push('email = ?'); params.push(email); changed.email = [cur.email, email]; }
    }

    /* ---- 昵称 ---- */
    if (b.username !== undefined) {
      const username = String(b.username).trim();
      const err = checkUsername(username);
      if (err) return reply.code(400).send({ error: err });
      if (username !== cur.username) { sets.push('username = ?'); params.push(username); changed.username = [cur.username, username]; }
    }

    /* ---- 备注 ---- */
    if (b.note !== undefined) {
      const note = String(b.note).slice(0, 500);
      if (note !== (cur.note || '')) { sets.push('note = ?'); params.push(note); changed.note = [cur.note || '', note]; }
    }

    /* ---- 角色 ----
     * 两道护栏，都指向同一件事：不能让系统失去最后一个管理员。
     * 没有这两道的话，管理员点一下「降为普通用户」就把自己关在门外了，
     * 而且没有后门可回（唯一的补救是手改数据库）。 */
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) return reply.code(400).send({ error: '角色只能是 user 或 admin' });
      if (id === req.admin.id && b.role !== 'admin') {
        return reply.code(400).send({ error: '不能取消自己的管理员权限 —— 会把自己关在门外', code: 'SELF_DEMOTE' });
      }
      if (cur.role === 'admin' && b.role !== 'admin' && countAdmins() <= 1) {
        return reply.code(400).send({ error: '这是最后一个管理员，不能降级', code: 'LAST_ADMIN' });
      }
      if (b.role !== cur.role) { sets.push('role = ?'); params.push(b.role); changed.role = [cur.role, b.role]; }
    }

    /* ---- 状态 ---- */
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return reply.code(400).send({ error: '状态只能是 active 或 disabled' });
      if (id === req.admin.id && b.status !== 'active') {
        return reply.code(400).send({ error: '不能停用自己的账号', code: 'SELF_DISABLE' });
      }
      if (cur.status === 'active' && b.status === 'disabled' && cur.role === 'admin' && countAdmins() <= 1) {
        return reply.code(400).send({ error: '这是最后一个管理员，不能停用', code: 'LAST_ADMIN' });
      }
      if (b.status !== cur.status) { sets.push('status = ?'); params.push(b.status); changed.status = [cur.status, b.status]; }
    }

    if (!sets.length) {
      const row = db.prepare(`${LIST_SQL} WHERE u.id = ?`).get(id);
      return { ok: true, changed: {}, user: { ...shapeUser(row), stats: shapeStats(row) } };
    }

    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);

    /* 停用 → 当场踢掉它所有会话。
     * 只改 status 不踢会话的话，对方手里那个 30 天 cookie 还是有效的
     * （readSession 里虽然也拦了一道，但把行删掉更干净：
     *  管理台的「活跃设备」数字会立刻变成 0，不用等下次请求）。 */
    if (changed.status && changed.status[1] === 'disabled') {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      logAuth('admin_disable', { email: cur.email, userId: id, ip: req.ip });
    }

    audit(req, 'user_update', { target: { id, email: cur.email }, detail: changed });

    const row = db.prepare(`${LIST_SQL} WHERE u.id = ?`).get(id);
    return { ok: true, changed, user: { ...shapeUser(row), stats: shapeStats(row) } };
  });

  /* ============ 重置密码 ============ */
  fastify.post('/api/admin/users/:id/password', {
    preHandler: fastify.requireAdmin,
    schema: {
      params: { type: 'object', properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        required: ['password'],
        properties: { password: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const id = req.params.id;
    const cur = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
    if (!cur) return reply.code(404).send({ error: '用户不存在' });

    const err = checkPasswordStrength(req.body.password);
    if (err) return reply.code(400).send({ error: err });

    const { hash, salt } = await hashPassword(req.body.password);
    db.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(hash, salt, id);

    // 重置密码必须踢掉旧会话，否则「重置」对已经登录的设备没有任何作用
    const killed = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;

    /* 审计里**不记密码原文**，连脱敏都不记。审计日志会被导出、会被截图，
     * 记进去等于把新密码留在一个比密码本身更不安全的地方。 */
    audit(req, 'password_reset', { target: cur, detail: { sessionsKilled: killed } });
    logAuth('admin_password_reset', { email: cur.email, userId: id, ip: req.ip });

    return { ok: true, sessionsKilled: killed };
  });

  /* ============ 强制下线 ============ */
  fastify.post('/api/admin/users/:id/logout', {
    preHandler: fastify.requireAdmin,
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const cur = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
    if (!cur) return reply.code(404).send({ error: '用户不存在' });

    const killed = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(cur.id).changes;
    audit(req, 'force_logout', { target: cur, detail: { sessionsKilled: killed } });
    return { ok: true, sessionsKilled: killed };
  });

  /* ============ 删除用户 ============
   * 靠外键 ON DELETE CASCADE 连带清掉全部学习数据（attempts / cards /
   * stats_* / notes / …）。schema 里每张学习表的 user_id 都指向 users(id)，
   * 且 PRAGMA foreign_keys = ON 在连接建立时就设了 —— 少任何一环都会留下孤儿数据。
   */
  fastify.delete('/api/admin/users/:id', {
    preHandler: fastify.requireAdmin,
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const id = req.params.id;
    const cur = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
    if (!cur) return reply.code(404).send({ error: '用户不存在' });

    if (id === req.admin.id) {
      return reply.code(400).send({ error: '不能删除自己的账号', code: 'SELF_DELETE' });
    }
    if (cur.role === 'admin' && countAdmins() <= 1) {
      return reply.code(400).send({ error: '这是最后一个管理员，不能删除', code: 'LAST_ADMIN' });
    }

    /* 先数一遍再删，好让审计日志里留下「删掉了多少数据」——
     * 删完之后这些行就查不到了。 */
    const wiped = {
      attempts: db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = ?').get(id).n,
      cards: db.prepare('SELECT COUNT(*) n FROM cards WHERE user_id = ?').get(id).n,
      notes: db.prepare('SELECT COUNT(*) n FROM notes WHERE user_id = ?').get(id).n,
      deckCards: db.prepare('SELECT COUNT(*) n FROM card_deck WHERE user_id = ?').get(id).n,
    };

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(req, 'user_delete', { target: cur, detail: wiped });

    return { ok: true, wiped };
  });

  /* ============ 审计日志 ============ */
  fastify.get('/api/admin/logs', {
    preHandler: fastify.requireAdmin,
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
      },
    },
  }, async (req) => {
    const rows = db.prepare('SELECT * FROM admin_log ORDER BY at DESC, id DESC LIMIT ?')
      .all(req.query.limit ?? 60);
    return {
      logs: rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        actorEmail: r.actor_email,
        targetId: r.target_id,
        targetEmail: r.target_email,
        action: r.action,
        detail: safeJson(r.detail, {}),
        ip: r.ip,
        at: r.at,
      })),
    };
  });
}

function countAdmins() {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
}

function safeJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
