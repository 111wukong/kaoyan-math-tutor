/* 数据库备份
 *
 * 用法：
 *   npm -w server run backup            # 备份一次，保留最近 7 份
 *   npm -w server run backup -- --keep 30
 *   node server/scripts/backup.mjs --out /path/to/dir
 *
 * ── 为什么不能用 cp ────────────────────────────────────────────────
 * 库开的是 WAL 模式。刚写完的事务可能还在 app.db-wal 里，
 * 还没合并回主库文件 —— 这时候 cp app.db 拿到的是一份**陈旧快照**，
 * 丢掉最近的作答记录，而 cp 不会报任何错。
 * （README 里提醒过「连 -wal/-shm 一起拷」，但把一件每天都要做的事
 * 写成一段需要人记住的注意事项，等于没做。）
 *
 * better-sqlite3 自带在线备份：db.backup() 走 SQLite 的 backup API，
 * 边写边拷也一致，不需要停服务。这才是正确做法。
 *
 * ── 挂定时任务 ────────────────────────────────────────────────────
 *   # 每天凌晨 3 点
 *   0 3 * * * cd /path/to/kaoyan-math-tutor && /usr/bin/env node server/scripts/backup.mjs >> /var/log/yanshu-backup.log 2>&1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'server', 'data', 'app.db');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const KEEP = Number(arg('keep', 7)) || 7;
const OUT_DIR = String(arg('out', path.join(path.dirname(DB_PATH), 'backups')));

if (!fs.existsSync(DB_PATH)) {
  console.error(`✗ 找不到数据库：${DB_PATH}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

/* 文件名带秒。带「天」的话同一天跑两次会互相覆盖，
 * 而人最容易在「我改了什么之后」手动补跑一次。 */
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(OUT_DIR, `app-${stamp}.db`);

/* readonly 打开：备份是只读操作，别让一个手滑的写把线上库搞坏。
 * fileMustExist 保证不会「备份出一个新建的空库」。 */
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

try {
  await db.backup(dest);

  const bytes = fs.statSync(dest).size;
  const srcBytes = fs.statSync(DB_PATH).size;
  console.log(`✓ 已备份 ${(bytes / 1024 / 1024).toFixed(2)} MB → ${dest}`);
  console.log(`  主库 ${(srcBytes / 1024 / 1024).toFixed(2)} MB（WAL 内容已一并纳入）`);

  /* 轮转：按文件名排序（时间戳是 ISO 格式，字典序即时间序），
   * 留下最近 KEEP 份。 */
  const all = fs.readdirSync(OUT_DIR)
    .filter((f) => /^app-.*\.db$/.test(f))
    .sort();
  const drop = all.slice(0, Math.max(0, all.length - KEEP));
  for (const f of drop) {
    fs.unlinkSync(path.join(OUT_DIR, f));
    console.log(`  - 清理旧备份 ${f}`);
  }
  console.log(`  现有备份 ${all.length - drop.length} 份（上限 ${KEEP}）`);
} catch (e) {
  console.error('✗ 备份失败：', e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
