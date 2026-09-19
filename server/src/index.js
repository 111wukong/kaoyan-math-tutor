/* 研数 · 服务端入口
 *
 * 一个进程同时干两件事：
 *   /api/*  → JSON / SSE 接口
 *   其它    → 生产环境托管 web/dist（SPA fallback 到 index.html）
 * 开发时前端跑在 Vite（5173），/api 反向代理到这里。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { initSchema, health, DB_PATH, db } from './db/index.js';
import { isTempDbPath } from './lib/dbPath.js';
import { migrate, ensureAdmin } from './db/migrate.js';
import { seed } from './db/seed.js';
import { COOKIE_NAME, readSession, touchSession, cleanupSessions } from './lib/session.js';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import catalogRoutes from './routes/catalog.js';
import studyRoutes from './routes/study.js';
import cardRoutes from './routes/cards.js';
import gameRoutes from './routes/game.js';
import graphRoutes from './routes/graph.js';
import miscRoutes from './routes/misc.js';
import aiRoutes from './routes/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIST = path.resolve(ROOT, '../web/dist');
const PORT = Number(process.env.PORT) || 5180;
const HOST = process.env.HOST || '127.0.0.1';

/* ---------- trustProxy ----------
 * 默认**关闭**。
 *
 * 打开它意味着「相信 X-Forwarded-For」，而那个请求头客户端可以随便写。
 * 裸奔时开着它，按 IP 计数的限流就形同虚设 —— 每换一个头就换一个身份，
 * 登录接口可以无限次试密码。实测过：固定头打到第 13 次被限流，
 * 轮换头打 16 次一次都没被拦。
 *
 * 只有确实跑在反向代理后面时才打开，并把值收窄到代理自己的地址，
 * 而不是一句 `true`：
 *   TRUST_PROXY=127.0.0.1            # 代理和 Node 同机
 *   TRUST_PROXY=172.16.0.0/12        # 容器网络
 *   TRUST_PROXY=127.0.0.1,::1        # 多个
 * 逗号分隔，交给 Fastify 自己解析（它认 CIDR 列表）。
 */
function resolveTrustProxy() {
  const raw = (process.env.TRUST_PROXY || '').trim();
  if (!raw) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : false;
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 8 * 1024 * 1024,   // 导入备份包可能不小
  trustProxy: resolveTrustProxy(),
});

/* ---------- 统一错误格式 ----------
 * ★ 这个钩子必须**先于任何插件和路由注册**。
 *
 * 之前它写在业务路由注册之后，Fastify 不会把它继承给已经注册的子上下文，
 * 于是整块是死代码，带来三个用户看得见的后果：
 *   1. 429 回的是框架默认的英文 `{"error":"Too Many Requests"}`，
 *      而前端 api.ts 正好读 `body.error` 当提示文案 —— 中文界面弹英文；
 *   2. 参数校验错误回 `FST_ERR_VALIDATION` + `"Bad Request"`，同样是英文；
 *   3. 未捕获异常回 `err.message` 原文（SQL 报错、文件路径都在里面）。
 * 位置写错一次，这三条就一起回来，所以下面留了断言（tests/security.mjs）。
 */
app.setErrorHandler((err, req, reply) => {
  if (err.statusCode === 429) {
    return reply.code(429).send({ error: '操作太频繁了，缓一缓再试', code: 'RATE_LIMITED' });
  }
  if (err.validation) {
    return reply.code(400).send({ error: '请求参数不正确', detail: err.message });
  }

  /* 5xx 不回 err.message。
   * Fastify 的默认序列化器会把它带上，而它可能是 SQL 报错、
   * 文件绝对路径、上游返回的原文 —— 这些都不该给客户端。
   * 真实错误留在日志里，响应只给一个可对账的 requestId。 */
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error({ err }, '未处理的服务端错误');
    return reply.code(500).send({ error: '服务器内部错误', requestId: req.id });
  }
  return reply.code(status).send({ error: err.message || '请求失败' });
});

/* ---------- 安全响应头 ----------
 * 之前一个都没有。对一个存着邮箱、学习记录、并且用
 * dangerouslySetInnerHTML 渲染 KaTeX 结果的站点，这层是最低成本的加固。
 *
 * 关于 CSP 里的 'unsafe-inline'：index.html 里有一段**必须内联**的启动脚本
 * （首屏防闪白 + 防闪主题，它要跑在 bundle 和样式表之前），
 * 还有一个内联 <style>。用哈希就得在改动那段脚本时同步改响应头，
 * 对一个单人维护的项目是纯粹的负债。所以这里保留 'unsafe-inline'，
 * 换取下面这几条真正有意义、且不会误伤的约束：
 *   frame-ancestors 'none'  → 防点击劫持（等价于 X-Frame-Options: DENY）
 *   object-src 'none'       → 禁插件
 *   base-uri 'self'         → 防 <base> 劫持相对路径
 *   form-action 'self'      → 防表单外发
 *   connect-src 'self'      → 前端只跟自己的 /api 说话
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.addHook('onSend', async (req, reply, payload) => {
  reply.header('Content-Security-Policy', CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  /* HSTS 只在真的走 HTTPS 时发。本地 http 开发时发了它，
   * 浏览器会把 127.0.0.1 也升级成 https，直接把自己锁在外面。 */
  if (req.protocol === 'https') {
    reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  return payload;
});

/* ---------- 初始化数据 ---------- */
initSchema();
/* 补列必须紧跟建表：schema.sql 对已存在的表整条跳过，加列只能靠 ALTER TABLE。 */
const migrated = migrate();
if (migrated.length) app.log.info(`结构迁移：补了 ${migrated.join('、')}`);
seed({ quiet: true });

/* ---------- 引导管理员 ---------- */
const bootAdmin = await ensureAdmin();
if (bootAdmin.action === 'created' || bootAdmin.action === 'promoted') {
  const how = bootAdmin.action === 'created' ? '已创建' : '已把既有账号提为';
  app.log.info(`${how}管理员 ${bootAdmin.email}（id ${bootAdmin.id}）`);

  if (bootAdmin.generated) {
    /* ★ 随机密码只在这里出现这一次。
     *
     * 库里存的是 scrypt 哈希，事后谁也取不出来 —— 这一行没看到，
     * 就只能删号重建或者手改数据库了。所以用 warn 级别 + 框起来，
     * 别让它淹在启动日志里。
     *
     * 为什么不用「内置默认密码」：源码和 README 是公开的，
     * 写死一个能用的口令等于把门钥匙挂在门上。 */
    app.log.warn('─'.repeat(58));
    app.log.warn(`  管理员初始密码：${bootAdmin.password}`);
    app.log.warn('  ↑ 只打印这一次。请立刻保存，并登录后改掉。');
    app.log.warn('  想自己指定：ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run start');
    app.log.warn('─'.repeat(58));
  } else {
    app.log.info('（密码取自 ADMIN_PASSWORD 环境变量）');
  }
}

/* ---------- 插件 ---------- */
await app.register(cookie);
/* global: true —— 这行以前是 false，于是那组 max/timeWindow 从来没被任何路由
 * 继承，实际只有显式挂了 config.rateLimit 的登录和注册受限。
 * 实测：对 /api/catalog/tree、/api/graph、/api/ai/error-stats、/api/study/answer
 * 各打 120 次，一个 429 都没有 —— AI 接口每次调用都要花钱打上游，却没有闸门。
 *
 * 600/分钟 = 每秒 10 次，对单人使用绰绰有余，同时挡住「一个脚本把库打满」。
 * 登录/注册有各自更紧的覆盖（见 routes/auth.js 的 config.rateLimit），
 * AI 接口也有（见 routes/ai.js），所以真正的闸门都在贵的地方。
 *
 * 上限可调：RATE_LIMIT_MAX。
 *   · 功能测试套件会把它开到很大 —— 它们不是来测限流的，
 *     几十上百次请求互相挤兑只会制造假红（见 tests/lib/server.mjs）；
 *   · tests/security.mjs 反过来用一台限值很小的私有服务，
 *     专门验「这个闸门真的会拦」。 */
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 600;
await app.register(rateLimit, {
  global: true,
  max: RATE_LIMIT_MAX,
  timeWindow: '1 minute',
});

/* ---------- 认证装饰器 ---------- */
app.decorate('requireAuth', async (req, reply) => {
  const token = req.cookies?.[COOKIE_NAME];
  const s = readSession(token);
  if (!s) return reply.code(401).send({ error: '未登录' });
  req.userId = s.user_id;
  req.user = s;
});

/* ---------- 管理员装饰器 ----------
 * 每次都回库里读 role，不信会话里带的快照。
 * 会话是 30 天有效的，如果把 role 当成会话的一部分缓存起来，
 * 那「撤掉某人的管理员」要等他重新登录才生效 —— 撤销必须是即时的。
 * 代价是一次主键查询，可以忽略。
 */
app.decorate('requireAdmin', async (req, reply) => {
  const token = req.cookies?.[COOKIE_NAME];
  const s = readSession(token);
  if (!s) return reply.code(401).send({ error: '未登录' });
  req.userId = s.user_id;
  req.user = s;

  const row = db.prepare('SELECT id, email, role, status FROM users WHERE id = ?').get(s.user_id);
  if (!row || row.role !== 'admin') {
    return reply.code(403).send({ error: '需要管理员权限', code: 'FORBIDDEN' });
  }
  req.admin = row;
});

/* ---------- 全局鉴权闸门 ----------
 * 白名单之外的所有 /api/* 都必须带有效会话。
 * 放在 onRequest 而不是每个路由里挂 preHandler —— 少写一处就是少一个漏网的口子。
 */
const PUBLIC_PREFIXES = ['/api/health', '/api/auth/'];
app.addHook('onRequest', async (req, reply) => {
  const url = req.raw.url || '';
  if (!url.startsWith('/api/')) return;
  if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return;

  const token = req.cookies?.[COOKIE_NAME];
  const s = readSession(token);
  if (!s) return reply.code(401).send({ error: '未登录', code: 'UNAUTHENTICATED' });
  req.userId = s.user_id;
  req.user = s;
  touchSession(token);
});

/* ---------- 健康检查（公开）----------
 * ★ 这里**只回「活着没有」和「库是不是一次性的」**，不回库内详情。
 *
 * 以前它把 health() 整个返回了，里面有 DB_PATH 的绝对路径、用户数、
 * 作答数。这个接口是公开的（在 PUBLIC_PREFIXES 里），等于把一个
 * 匿名可读的「你的服务器装在哪、有多少人在用」接口挂在公网上。
 *
 * 但 `db.isTemp` 必须留着 —— tests/run-all.mjs 靠它拦住
 * 「BASE=… 指着一个真实库跑测试」这件事（会往里灌账号且不清理）。
 * 布尔值不泄露路径，两边的需求都满足。
 * 需要完整信息（路径 / 表数 / 用户数）的运维场景走 /api/admin/health。 */
app.get('/api/health', async () => ({
  ok: true,
  service: 'kaoyan-math-tutor',
  version: '2.0.0',
  uptime: Math.round(process.uptime()),
  db: { isTemp: isTempDbPath(DB_PATH), ok: true },
}));

/* ---------- 健康检查（详细，管理员）---------- */
app.get('/api/admin/health', { preHandler: app.requireAdmin }, async () => ({
  ok: true,
  version: '2.0.0',
  uptime: Math.round(process.uptime()),
  db: health(),
}));

/* ---------- 业务路由 ---------- */
await app.register(authRoutes);
await app.register(adminRoutes);
await app.register(catalogRoutes);
await app.register(studyRoutes);
await app.register(cardRoutes);
await app.register(gameRoutes);
await app.register(graphRoutes);
await app.register(miscRoutes);
await app.register(aiRoutes);

/* ---------- 静态资源（生产）----------
 * 缓存策略分两类：
 *   /assets/** 文件名里带内容哈希（charts-5zzdM7Ec.js），内容一变名字就变，
 *              所以可以 immutable 缓存一年。之前这里是默认的 max-age=0，
 *              每次刷新都要回源校验 100+ 个文件（含 25 个 KaTeX 字体）。
 *   index.html 反过来必须 no-cache —— 它引用的是带哈希的资源名，
 *              缓存住它会让用户永远拿到旧的资源清单。 */
if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: '/',
    /* ★ 这个回调的第一个参数是 **Fastify 的 reply**，不是原生
     * ServerResponse —— 所以要用 reply.header()，写成 res.setHeader()
     * 会抛 `res.setHeader is not a function`，而且是在**发静态文件时**
     * 才炸：服务端直接退出，页面全白。这个坑被接口冒烟套件当场抓住过。 */
    setHeaders(reply, filePath) {
      if (/[/\\]assets[/\\]/.test(filePath)) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        reply.header('Cache-Control', 'no-cache');
      }
    },
  });

  // SPA fallback：非 /api 的未知路径一律交给前端路由
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url || '';
    if (url.startsWith('/api/')) {
      return reply.code(404).send({ error: '接口不存在' });
    }
    return reply.sendFile('index.html');
  });
  app.log.info(`静态资源目录: ${WEB_DIST}`);
} else {
  app.log.warn('未找到 web/dist —— 只提供 API。开发时请另开 Vite（npm run dev:web）');
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: '接口不存在' }));
}

/* ---------- 定时清理过期会话 ---------- */
const cleanupTimer = setInterval(() => {
  const n = cleanupSessions();
  if (n > 0) app.log.info(`清理过期会话 ${n} 条`);
}, 3600 * 1000);
cleanupTimer.unref();

/* ---------- 启动 ---------- */
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`研数服务已启动  http://${HOST}:${PORT}`);
  app.log.info(`数据库: ${DB_PATH}`);

  /* ---------- 上线前的两条提醒 ----------
   *
   * 这两件事都只在**对外可达**时才成立，而它们各自的后果都很直接：
   * 一个让会话 token 走明文 HTTP，一个让陌生人能自己建号。
   * 光写在 README 里没用 —— 出事之后回来看日志，这几行就是答案。
   *
   * 判断「对外可达」用的是监听地址而不是请求来源：绑 127.0.0.1 时
   * 只有本机能连，绑 0.0.0.0 或具体网卡地址时外面就够得着。
   */
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  const registrationOpen = process.env.REGISTRATION_ENABLED !== 'false';

  if (!loopbackOnly) {
    if (process.env.NODE_ENV !== 'production') {
      app.log.warn('─'.repeat(58));
      app.log.warn(`  服务监听在 ${HOST}（对外可达），但 NODE_ENV 不是 production。`);
      app.log.warn('  → cookie 没有 Secure 标记，会话 token 会走明文 HTTP 发出去，');
      app.log.warn('    同一个网络里谁都能抓走，然后就是 30 天的完整账号权限。');
      app.log.warn('  修：NODE_ENV=production（并且前面挂 HTTPS 反向代理）');
      app.log.warn('─'.repeat(58));
    }
    if (registrationOpen) {
      app.log.warn('─'.repeat(58));
      app.log.warn(`  服务监听在 ${HOST}（对外可达），而注册是开着的。`);
      app.log.warn('  → 任何人访问这个地址都能自己建号。配合「自定义模型地址」，');
      app.log.warn('    等于把服务端借出去当出网代理用。');
      app.log.warn('  修：REGISTRATION_ENABLED=false（账号改由管理员在后台建）');
      app.log.warn('─'.repeat(58));
    }
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    app.log.info(`收到 ${sig}，正在关闭…`);
    await app.close();
    process.exit(0);
  });
}
