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

import { initSchema, health, DB_PATH } from './db/index.js';
import { seed } from './db/seed.js';
import { COOKIE_NAME, readSession, touchSession, cleanupSessions } from './lib/session.js';

import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import studyRoutes from './routes/study.js';
import cardRoutes from './routes/cards.js';
import gameRoutes from './routes/game.js';
import miscRoutes from './routes/misc.js';
import aiRoutes from './routes/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIST = path.resolve(ROOT, '../web/dist');
const PORT = Number(process.env.PORT) || 5180;
const HOST = process.env.HOST || '127.0.0.1';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 8 * 1024 * 1024,   // 导入备份包可能不小
  trustProxy: true,
});

/* ---------- 初始化数据 ---------- */
initSchema();
seed({ quiet: true });

/* ---------- 插件 ---------- */
await app.register(cookie);
await app.register(rateLimit, {
  global: false,
  max: 300,
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

/* ---------- 健康检查（公开）---------- */
app.get('/api/health', async () => ({
  ok: true,
  service: 'kaoyan-math-tutor',
  version: '2.0.0',
  db: health(),
  uptime: Math.round(process.uptime()),
}));

/* ---------- 业务路由 ---------- */
await app.register(authRoutes);
await app.register(catalogRoutes);
await app.register(studyRoutes);
await app.register(cardRoutes);
await app.register(gameRoutes);
await app.register(miscRoutes);
await app.register(aiRoutes);

/* ---------- 统一错误格式 ---------- */
app.setErrorHandler((err, req, reply) => {
  if (err.statusCode === 429) {
    return reply.code(429).send({ error: '操作太频繁了，缓一缓再试' });
  }
  if (err.validation) {
    return reply.code(400).send({ error: '请求参数不正确', detail: err.message });
  }
  req.log.error({ err }, '未处理的服务端错误');
  return reply.code(err.statusCode || 500).send({ error: err.message || '服务器内部错误' });
});

/* ---------- 静态资源（生产）---------- */
if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' });

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
