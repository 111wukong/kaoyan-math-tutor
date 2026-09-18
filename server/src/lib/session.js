/* 会话管理
 *
 * 方案：随机 32 字节 token 放 httpOnly cookie，库里只存 sha256(token)。
 * 为什么不用 JWT：
 *   - 学习系统需要「退出登录立刻失效」和「看到我的活跃设备」，JWT 无状态特性在这里是负担；
 *   - 库里存哈希，token 原文只在 cookie 里 —— 拖库也换不出可用凭据。
 * cookie 设置：httpOnly（JS 读不到）+ sameSite=Lax（挡 CSRF）+ 生产环境 secure。
 */
import crypto from 'node:crypto';
import { db } from '../db/index.js';

const TTL_DAYS = 30;
export const COOKIE_NAME = 'yanshu_session';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(userId, { userAgent = '', ip = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_DAYS * 864e5);

  db.prepare(`INSERT INTO sessions (token_hash,user_id,created_at,expires_at,last_seen_at,user_agent,ip)
    VALUES (?,?,?,?,?,?,?)`).run(
    sha256(token), userId,
    now.toISOString(), expires.toISOString(), now.toISOString(),
    String(userAgent).slice(0, 300), String(ip).slice(0, 60),
  );

  return { token, expiresAt: expires };
}

export function readSession(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at, u.email, u.username, u.avatar_hue, u.created_at,
           u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token));
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }

  /* 被停用的账号：立刻注销它的全部会话，并当作「没登录」处理。
   *
   * 为什么在这里删会话，而不是只在登录处拦一道：
   * 停用是一个**正在生效**的动作。管理员点了停用之后，那个人手里
   * 那个 30 天有效的 cookie 还在 —— 如果只在登录处拦，他要等 cookie
   * 自然过期才真的被挡住，这中间「停用」是假的。
   * 顺手把 sessions 行删掉，也让管理台的「活跃设备数」当场归零。 */
  if (row.status && row.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    return null;
  }

  return row;
}

export function touchSession(token) {
  if (!token) return;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    .run(new Date().toISOString(), sha256(token));
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** 清掉过期会话。启动时 + 每小时跑一次。 */
export function cleanupSessions() {
  const r = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  return r.changes;
}

export function cookieOptions() {
  const prod = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: prod,
    path: '/',
    maxAge: TTL_DAYS * 86400,
  };
}

export function logAuth(event, { email = null, userId = null, ip = '', userAgent = '' } = {}) {
  db.prepare('INSERT INTO auth_log (email,user_id,event,ip,user_agent) VALUES (?,?,?,?,?)')
    .run(email, userId, event, String(ip).slice(0, 60), String(userAgent).slice(0, 300));
}
