/* 数据库路径的工具函数
 *
 * ── 为什么这个判断要放在服务端 ────────────────────────────────────
 * 测试总入口（tests/run-all.mjs）有一道闸门：`BASE=http://… npm test`
 * 是对着**已经在跑的服务**测的，如果那个服务连的是真实库，
 * 测试会往里灌账号和作答记录，而且跑完不清理。
 * 实测污染过一次：一个真实账号旁边躺了 17 个测试账号。
 *
 * 判据本来是「让服务端把 DB_PATH 报出来，客户端判断它在不在临时目录」。
 * 但 DB_PATH 是**绝对路径**，把它放在公开的 /api/health 里等于
 * 匿名告诉全世界「你的服务器装在哪」—— 所以现在服务端自己判断，
 * 只回一个布尔值。
 *
 * ★ 不能拿 os.tmpdir() 做字符串前缀比较。
 *   macOS 上 os.tmpdir() 返回 /var/folders/xx/…/T，而 /tmp 是指向
 *   /private/tmp 的软链 —— 谁都不是谁的前缀。直接比的话
 *   DB_PATH=/tmp/xxx.db 会被误判成真实库，把 README 里推荐的用法也挡掉。
 *   所以先把候选根目录 realpath 化再比。这个坑第一次就踩了。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 这个数据库路径在不在临时目录里。
 *
 * @param {string} dbPath 数据库文件的绝对路径
 * @returns {boolean} 路径为空时返回 false（信息不足时按「不确定」处理，由调用方决定）
 */
export function isTempDbPath(dbPath) {
  const p = String(dbPath || '');
  if (!p) return false;

  const roots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp']
    .map((r) => { try { return fs.realpathSync(r); } catch { return null; } })
    .filter(Boolean);

  /* 数据库文件可能还不存在，所以拿它的**目录**去 realpath。 */
  const dir = (() => {
    try { return fs.realpathSync(path.dirname(p)); } catch { return path.dirname(p); }
  })();

  return roots.some((r) => dir === r || dir.startsWith(r + path.sep));
}
