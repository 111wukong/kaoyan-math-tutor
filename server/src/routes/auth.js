/* 认证路由：注册 / 登录 / 登出 / 当前用户 / 改密 / 活跃会话 */
import { db } from '../db/index.js';
import {
  hashPassword, verifyPassword, checkPasswordStrength, checkEmail, checkUsername,
} from '../lib/password.js';
import {
  createSession, readSession, destroySession, destroyAllSessions,
  cleanupSessions, cookieOptions, COOKIE_NAME, logAuth,
} from '../lib/session.js';

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  avatarHue: u.avatar_hue,
  createdAt: u.created_at,
});

/** 新用户初始化：设置 / LLM 配置 / 游戏状态，三张单行表一次补齐 */
function initUserRows(userId) {
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(userId);
  db.prepare('INSERT OR IGNORE INTO llm_settings (user_id) VALUES (?)').run(userId);
  db.prepare('INSERT OR IGNORE INTO game_state (user_id) VALUES (?)').run(userId);
}

export default async function authRoutes(fastify) {
  /* ---------- 注册 ---------- */
  fastify.post('/api/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'username', 'password'],
        properties: {
          email: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const ua = req.headers['user-agent'] || '';
    const ip = req.ip;

    for (const err of [checkEmail(email), checkUsername(username), checkPasswordStrength(password)]) {
      if (err) return reply.code(400).send({ error: err });
    }

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) return reply.code(409).send({ error: '这个邮箱已经注册过了，直接登录吧' });

    const { hash, salt } = await hashPassword(password);
    const info = db.prepare(`INSERT INTO users (email,username,password_hash,password_salt,avatar_hue)
      VALUES (?,?,?,?,?)`).run(email, username, hash, salt, Math.floor(Math.random() * 360));

    const userId = Number(info.lastInsertRowid);
    initUserRows(userId);

    const { token, expiresAt } = createSession(userId, { userAgent: ua, ip });
    reply.setCookie(COOKIE_NAME, token, cookieOptions());
    logAuth('register', { email, userId, ip, userAgent: ua });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return { user: publicUser(user), expiresAt };
  });

  /* ---------- 登录 ---------- */
  fastify.post('/api/auth/login', {
    config: { rateLimit: { max: 12, timeWindow: '10 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: { email: { type: 'string' }, password: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const ua = req.headers['user-agent'] || '';
    const ip = req.ip;

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // 统一错误文案：不泄露「这个邮箱是否存在」
    const fail = () => {
      logAuth('login_failed', { email, ip, userAgent: ua });
      return reply.code(401).send({ error: '邮箱或密码不正确' });
    };
    if (!user) {
      // 用户不存在时也走一次哈希，避免用响应时间探测账号是否存在
      await hashPassword(password);
      return fail();
    }
    if (!(await verifyPassword(password, user.password_hash, user.password_salt))) return fail();

    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    const { token, expiresAt } = createSession(user.id, { userAgent: ua, ip });
    reply.setCookie(COOKIE_NAME, token, cookieOptions());
    logAuth('login', { email, userId: user.id, ip, userAgent: ua });

    return { user: publicUser(user), expiresAt };
  });

  /* ---------- 登出 ---------- */
  fastify.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
      const s = readSession(token);
      if (s) logAuth('logout', { userId: s.user_id, ip: req.ip });
      destroySession(token);
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  /* ---------- 当前用户 ---------- */
  fastify.get('/api/auth/me', async (req, reply) => {
    const token = req.cookies?.[COOKIE_NAME];
    const s = readSession(token);
    if (!s) return reply.code(401).send({ error: '未登录' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!user) return reply.code(401).send({ error: '未登录' });
    return { user: publicUser(user) };
  });

  /* ---------- 修改密码 ---------- */
  fastify.post('/api/auth/password', {
    preHandler: fastify.requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['current', 'next'],
        properties: { current: { type: 'string' }, next: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { current, next } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!(await verifyPassword(current, user.password_hash, user.password_salt))) {
      return reply.code(400).send({ error: '当前密码不正确' });
    }
    const err = checkPasswordStrength(next);
    if (err) return reply.code(400).send({ error: err });

    const { hash, salt } = await hashPassword(next);
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hash, salt, user.id);

    // 改密后踢掉其它设备，只保留当前会话
    const keep = req.cookies?.[COOKIE_NAME];
    destroyAllSessions(user.id);
    const { token } = createSession(user.id, { userAgent: req.headers['user-agent'] || '', ip: req.ip });
    reply.setCookie(COOKIE_NAME, token, cookieOptions());
    logAuth('password_change', { userId: user.id, email: user.email, ip: req.ip });
    void keep;

    return { ok: true };
  });

  /* ---------- 活跃会话（设备管理） ---------- */
  fastify.get('/api/auth/sessions', { preHandler: fastify.requireAuth }, async (req) => {
    const rows = db.prepare(`SELECT created_at, last_seen_at, expires_at, user_agent, ip
      FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC`).all(req.userId);
    return { sessions: rows, count: rows.length };
  });

  fastify.post('/api/auth/logout-all', { preHandler: fastify.requireAuth }, async (req, reply) => {
    destroyAllSessions(req.userId);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  /* ---------- 注销账号（连带清空全部学习数据，靠外键级联） ---------- */
  fastify.delete('/api/auth/account', {
    preHandler: fastify.requireAuth,
    schema: { body: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } } },
  }, async (req, reply) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!(await verifyPassword(req.body.password, user.password_hash, user.password_salt))) {
      return reply.code(400).send({ error: '密码不正确' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  cleanupSessions();
}
