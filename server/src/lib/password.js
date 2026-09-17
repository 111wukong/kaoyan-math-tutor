/* 密码哈希
 *
 * 用 Node 内置 scrypt（RFC 7914），不引 bcrypt/argon2 原生模块 —— 少一个编译依赖，
 * 少一个「换台机器装不上」的坑，安全性对本地学习应用完全够。
 *
 * 参数说明（OWASP 推荐档）：
 *   N = 2^14 迭代成本，r = 8 块大小，p = 1 并行度 → 单次约 50-100ms
 *   故意慢：让离线爆破的代价高到不划算
 *
 * 每个密码独立随机 salt，比对用 timingSafeEqual（防时序侧信道）。
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const OPTS = { N, r: R, p: P, maxmem: 128 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, KEYLEN, OPTS);
  return { hash: key.toString('hex'), salt };
}

export async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  let key;
  try {
    key = await scryptAsync(password, salt, KEYLEN, OPTS);
  } catch {
    return false;
  }
  const a = key;
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 密码强度检查。返回 null 表示通过，否则返回错误信息。 */
export function checkPasswordStrength(password) {
  const pwd = String(password || '');
  if (pwd.length < 8) return '密码至少 8 位';
  if (pwd.length > 128) return '密码太长了（上限 128 位）';
  if (/^\d+$/.test(pwd)) return '密码不能是纯数字';
  if (/^[a-zA-Z]+$/.test(pwd)) return '密码不能是纯字母';
  return null;
}

export function checkEmail(email) {
  const e = String(email || '').trim();
  if (!e) return '请填写邮箱';
  if (e.length > 254) return '邮箱过长';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return '邮箱格式不正确';
  return null;
}

export function checkUsername(name) {
  const n = String(name || '').trim();
  if (!n) return '请填写昵称';
  if (n.length > 24) return '昵称最多 24 个字符';
  return null;
}
