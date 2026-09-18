/* 数据库连接与初始化
 *
 * 用 better-sqlite3：同步 API，事务写起来直白，本地单文件零运维。
 * 打开时统一设置：
 *   - WAL：读写不互相阻塞（学习时前端轮询统计不会卡住写入）
 *   - foreign_keys：级联删除靠它，删用户必须带走全部学习数据
 *   - busy_timeout：避免多进程（dev 的 --watch 重启）瞬时锁冲突直接抛错
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

export const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

/** 建表（幂等）。启动时跑一次。
 *
 * ⚠️ 这一步**只建缺失的表**。schema.sql 全是 `CREATE TABLE IF NOT EXISTS`，
 * 表已存在时整条语句被跳过 —— 也就是说「往已有表里加一列」它做不到。
 * 补列是 migrate()（见 migrate.js）的职责，启动时紧跟在本函数之后调用。
 * 只调本函数不调 migrate()，老库上任何读新列的查询都会 no such column。
 */
export function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  return db;
}

/** 事务包装。better-sqlite3 的事务是同步的，异常自动回滚。 */
export function tx(fn) {
  return db.transaction(fn);
}

/**
 * 从 attempts 明细完整重建聚合表。
 * 聚合表是派生数据 —— 任何怀疑它跟明细对不上时，跑这个函数就能恢复。
 * 返回重建后的计数，便于自检。
 */
export function rebuildStats(userId) {
  const run = db.transaction((uid) => {
    db.prepare('DELETE FROM stats_node WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM stats_question WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM stats_daily WHERE user_id = ?').run(uid);

    db.prepare(`
      INSERT INTO stats_node (user_id, kid, n, c, ts)
      SELECT user_id, kid, COUNT(*), SUM(correct), MAX(ts)
      FROM attempts WHERE user_id = ? GROUP BY kid
    `).run(uid);

    db.prepare(`
      INSERT INTO stats_daily (user_id, date, n, c)
      SELECT user_id, date, COUNT(*), SUM(correct)
      FROM attempts WHERE user_id = ? GROUP BY date
    `).run(uid);

    // 每题最后一次作答的 correct 决定 ok（错题本口径：最后一次答错 = 仍在错题本）
    db.prepare(`
      INSERT INTO stats_question (user_id, qid, kid, n, c, ok, ts)
      SELECT a.user_id, a.qid, a.kid, g.n, g.c,
             (SELECT correct FROM attempts x
               WHERE x.user_id = a.user_id AND x.qid = a.qid
               ORDER BY x.ts DESC, x.rowid DESC LIMIT 1),
             g.ts
      FROM attempts a
      JOIN (
        SELECT qid, COUNT(*) n, SUM(correct) c, MAX(ts) ts
        FROM attempts WHERE user_id = ? GROUP BY qid
      ) g ON g.qid = a.qid
      WHERE a.user_id = ?
      GROUP BY a.qid
    `).run(uid, uid);

    const n = db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = ?').get(uid).n;
    return { attempts: n };
  });
  return run(userId);
}

/** 数据库体检：给 /api/health 用。 */
export function health() {
  const t = db.prepare('SELECT COUNT(*) n FROM sqlite_master WHERE type = ?').get('table').n;
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const attempts = db.prepare('SELECT COUNT(*) n FROM attempts').get().n;
  return { path: DB_PATH, tables: t, users, attempts, ok: true };
}
