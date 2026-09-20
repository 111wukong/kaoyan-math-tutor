/* 认证路由：注册 / 登录 / 登出 / 当前用户 / 改密 / 活跃会话 */
import { db } from '../db/index.js';
import {
  hashPassword, verifyPassword, checkPasswordStrength, checkEmail, checkUsername,
} from '../lib/password.js';
import {
  createSession, readSession, destroySession, destroyAllSessions,
  cleanupSessions, cookieOptions, COOKIE_NAME, logAuth,
} from '../lib/session.js';

/* ---------- 注册开关 ----------
 *
 * 默认**开着**（不制造意外），但公开部署时建议关掉。
 *
 * 为什么要给这个开关：开放注册意味着任何陌生人都能建号，而「有账号」
 * 正是「用户可自定义模型上游地址」这个功能的前提条件 ——
 * 两者叠在一起，服务端就变成了一个可被陌生人使用的出网代理
 * （细节见 lib/llmUrl.js 开头那段）。关掉注册，暴露面从「互联网」
 * 缩到「你认识的几个人」。
 *
 * 关掉不会把人锁在外面：库里一个管理员都没有时，启动会按
 * ADMIN_EMAIL / ADMIN_PASSWORD 引导一个出来（见 db/migrate.js 的
 * ensureAdmin），之后账号由管理员在后台建（POST /api/admin/users）。
 *
 * ★ 只有字符串 'false' 才算关。
 *   写成 '0' / 'no' / 'off' 这种「看起来像关闭」的值，实际是开着的 ——
 *   那是最危险的一类配置误解：运维以为关掉了，其实没有。
 *   宁可严格，也不要猜。
 */
const REGISTRATION_OPEN = process.env.REGISTRATION_ENABLED !== 'false';

/* 对外的用户对象。
 *
 * 白名单式：只列该给的字段。password_hash / password_salt 绝不出现在这里 ——
 * 用「排除法」（delete 掉敏感字段）迟早会漏一个，用「列举法」不会。
 * role 是必须给前端的：侧栏要不要显示「管理」入口、路由要不要放行，
 * 都靠它。但前端拿到 role 只是用来渲染，真正的鉴权在服务端 requireAdmin，
 * 前端藏起来的东西不代表服务端不设防。 */
const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  avatarHue: u.avatar_hue,
  role: u.role || 'user',
  createdAt: u.created_at,
});

/** 新用户初始化：设置 / LLM 配置 / 游戏状态，三张单行表一次补齐 */
function initUserRows(userId) {
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(userId);
  db.prepare('INSERT OR IGNORE INTO llm_settings (user_id) VALUES (?)').run(userId);
  db.prepare('INSERT OR IGNORE INTO game_state (user_id) VALUES (?)').run(userId);
}

export default async function authRoutes(fastify) {
  /* ---------- 站点配置（公开）----------
   * 前端登录 / 注册页要据此决定是「显示注册表单」还是「显示已关闭」——
   * 让人填完一整张表再被 403 顶回来，是很糟的体验，而且看起来像坏了。
   * 只暴露这一个布尔，不含任何内部信息。
   *
   * 它落在 /api/auth/ 前缀里，所以自动走全局鉴权白名单（见 index.js），
   * 未登录也能读 —— 这是必须的，注册页本来就还没登录。 */
  fastify.get('/api/auth/config', async () => ({
    registrationEnabled: REGISTRATION_OPEN,
  }));

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
    /* 关掉注册时直接 403，不再往下走。
     * 注意它排在 schema 校验之后（Fastify 的生命周期如此）——
     * 所以畸形请求会先拿到 400。这没关系：正常前端提交的是完整表单，
     * 而这里挡的是「拿脚本硬试」的人。 */
    if (!REGISTRATION_OPEN) {
      return reply.code(403).send({
        error: '本站已关闭注册，需要账号请联系管理员开通。',
        code: 'REGISTRATION_CLOSED',
      });
    }

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

    /* 被停用的账号：密码对也不给进。
     *
     * 注意顺序 —— 停用检查放在密码校验**之后**。放前面的话，
     * 「这个邮箱被停用了」会成为一个不需要密码就能拿到的信息，
     * 等于给外人一个枚举账号状态的接口。现在只有密码正确的人才会看到这句。 */
    if (user.status && user.status !== 'active') {
      logAuth('login_blocked', { email, userId: user.id, ip, userAgent: ua });
      return reply.code(403).send({ error: '这个账号已被停用，请联系管理员', code: 'ACCOUNT_DISABLED' });
    }

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
