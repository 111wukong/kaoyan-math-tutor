/* 结构迁移 + 管理员引导
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────
 * schema.sql 全是 `CREATE TABLE IF NOT EXISTS`。这意味着：
 *   · 新库：建表，列齐全，没问题；
 *   · 老库：表已存在 → 整条 CREATE 被跳过 → **新加的列一个都不会补上**。
 * 于是「加一列」这件事在老库上表现为运行时 `no such column: role`，
 * 而且报错点在查询里，不在建表处 —— 排查时容易往错的方向找。
 *
 * 所以加列必须单独走 ALTER TABLE。这里是唯一的入口。
 *
 * ── 关于 ensureAdmin 的安全取舍 ──────────────────────────────────
 * 需要一个「系统里至少有一个管理员」的起点，否则管理接口永远进不去。
 * 做法：启动时检查有没有 role='admin' 的用户，没有就按配置建一个。
 *
 * ★ 这里**不再有内置的默认密码**。
 *   以前源码里写死了一个真实邮箱 + 一个可用的口令，README 里还抄了一份 ——
 *   一个公开仓库里躺着能用的凭据，这是不能接受的：口令会被人在别处复用，
 *   邮箱会被爬。
 *
 * 现在的规则（按优先级）：
 *   1. ADMIN_EMAIL + ADMIN_PASSWORD 都给了环境变量 → 用它们（部署脚本 / CI 走这条）
 *   2. 只给了邮箱 → 密码**现场随机生成**，创建那一刻打印一次到日志
 *   3. 都没给 → 邮箱用 admin@localhost 这个明显是占位的，密码同样随机生成
 *
 * 随机密码只在创建那一刻出现一次，之后库里只有 scrypt 哈希，谁也取不出来。
 * 忘了就删号重建，或者直接改库里的 password_hash。
 *
 * 幂等性：只在「库里一个管理员都没有」时才创建/提权。
 * 之后再启动就是纯读，不会覆盖你已经改过的密码。
 */
import crypto from 'node:crypto';
import { db } from './index.js';
import { hashPassword } from '../lib/password.js';

/** 没有显式配置时用的占位邮箱。故意不是任何人的真实邮箱。 */
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@localhost').trim().toLowerCase();
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '管理员';

/** 环境变量里显式给的密码。没给就是 null，由 ensureAdmin 现场生成一个随机的。 */
export const ADMIN_PASSWORD_ENV = process.env.ADMIN_PASSWORD || null;

/**
 * 生成一个随机密码。
 * 用 crypto.randomInt 而不是 `randomBytes[i] % chars.length` —— 后者有模偏差，
 * 某些字符出现的概率会明显偏高。
 *
 * 去掉了容易看错的 0/O/1/l/I，因为这是要人从日志里抄下来的。
 */
export function randomPassword(len = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i += 1) out += chars[crypto.randomInt(chars.length)];
  return out;
}

/** 读某张表当前的列名集合。 */
function columnsOf(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

/** 需要补列的表 → 列定义。key 是列名，值是 ALTER TABLE 用的定义片段。 */
const ADD_COLUMNS = {
  users: {
    role: "TEXT NOT NULL DEFAULT 'user'",
    status: "TEXT NOT NULL DEFAULT 'active'",
    note: "TEXT NOT NULL DEFAULT ''",
  },
  /* attempts.error_type —— 错因归类。
   * 新库由 schema.sql 建好，老库必须在这里补：attempts 表早已存在，
   * schema.sql 里那条 CREATE TABLE IF NOT EXISTS 会被整个跳过。 */
  attempts: {
    error_type: "TEXT NOT NULL DEFAULT ''",
  },
  /* cards 的 FSRS 状态（见 lib/fsrs.js）。
   * 老库的卡是 SM-2 调度的，只有 interval/reps/ef —— 补上这三列之后
   * 还要回填一次（见 migrate() 末尾），否则会被当成新卡重来。 */
  cards: {
    state: "TEXT NOT NULL DEFAULT 'new'",
    stability: 'REAL',
    difficulty: 'REAL',
  },
  /* questions.steps —— 解答题 / 证明题的评分点。
   * 新库由 schema.sql 建好；老库的 questions 表已经存在，
   * 那条 CREATE TABLE IF NOT EXISTS 会被整个跳过，所以必须在这里补。
   * 默认 '[]' 而不是 NULL：读的地方就能少一层判空。 */
  questions: {
    steps: "TEXT NOT NULL DEFAULT '[]'",
  },
};

/**
 * 补齐老库缺的列。幂等，可以每次启动都跑。
 * 返回这次真正补了哪些列（便于日志）。
 */
export function migrate() {
  const added = [];

  for (const [table, cols] of Object.entries(ADD_COLUMNS)) {
    const have = columnsOf(table);
    for (const [col, def] of Object.entries(cols)) {
      if (have.has(col)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      added.push(`${table}.${col}`);
    }
  }

  /* role 上的索引也要在老库上补 —— 它跟着新列一起来，
   * 而 schema.sql 里那条 CREATE INDEX 在补列之前就已经执行过了（当时列还不存在），
   * 会直接抛错把整个 initSchema 打断。所以索引放在这里建。 */
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');

  /* 兜底：把 NULL / 空串的历史值收敛到默认值。
   * 补列时给了 DEFAULT，SQLite 会把已有行填成默认值，正常不会出现 NULL；
   * 但手工改过库的情况存在，收敛一次成本极低。 */
  db.exec("UPDATE users SET role = 'user' WHERE role IS NULL OR role = ''");
  db.exec("UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''");

  /* ---------- FSRS 状态回填 ----------
   *
   * 老库的卡是 SM-2 调度的，只有 interval / reps / ef。补上 FSRS 三列之后
   * 它们全是默认值（state='new'、stability/difficulty=NULL），
   * 不回填的话会被当成**新卡**重走初始稳定度 —— 之前积累的复习历史白费，
   * 而且用户会看到自己明明复习过很多次的卡突然变成「新卡」。
   *
   * 回填口径：
   *   state      reps > 0 说明复习过 → 'review'
   *   stability  ≈ interval。这不是拍脑袋：稳定度的定义就是「保留率降到 90%
   *              所需的天数」，而 SM-2 的 interval 正是在保留率约 90% 时给的，
   *              两者量纲一致。
   *   difficulty 取中性值 5，之后几次复习会自己收敛到合适的值。
   *
   * 幂等：WHERE 条件保证只动「还没回填过」的行。
   * 新建的 FSRS 卡 state='new' 且 reps=0，不会被误伤。 */
  db.exec("UPDATE cards SET state = 'review' WHERE reps > 0 AND state = 'new'");
  db.exec('UPDATE cards SET stability = max(CAST(interval AS REAL), 0.1) WHERE stability IS NULL AND interval > 0');
  db.exec('UPDATE cards SET difficulty = 5 WHERE difficulty IS NULL AND interval > 0');

  return added;
}

/** 库里有几个管理员。 */
export function adminCount() {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
}

/**
 * 引导管理员账号。幂等。
 *
 * 三种情况：
 *   1. 库里已有管理员 → 什么都不做，返回 { action: 'skip' }。
 *      ★ 这一条是「不覆盖你改过的密码」的保证，别改成按邮箱判断。
 *   2. 引导邮箱还没被注册 → 建号，直接给 admin 角色，返回 { action: 'created' }。
 *   3. 引导邮箱已被注册（但库里还没有管理员）→ 提权 + 重置密码，
 *      返回 { action: 'promoted' }。重置密码是必要的：那个账号原来的密码
 *      我们无从得知，不提权则登不进去，提权但不重置则你自己也可能进不去。
 *      只在「首次提权」这一条路径上发生。
 *
 * `password` 和 `generated` 只在**刚创建/提权**时才有意义：
 *   generated=true 说明密码是现场随机生成的，调用方必须把它打印出来一次 ——
 *   否则这个账号谁也登不进去（库里只有哈希，事后取不出来）。
 *
 * @returns {Promise<{action:'skip'|'created'|'promoted', email:string, id?:number, password?:string, generated?:boolean}>}
 */
export async function ensureAdmin() {
  if (adminCount() > 0) return { action: 'skip', email: ADMIN_EMAIL };

  /* 密码：环境变量优先，没给就现场生成一个随机的。
   * 随机密码会随返回值带出去，由 index.js 打印一次。 */
  const password = ADMIN_PASSWORD_ENV || randomPassword();
  const generated = !ADMIN_PASSWORD_ENV;

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(ADMIN_EMAIL);

  if (existing) {
    const { hash, salt } = await hashPassword(password);
    db.prepare(`UPDATE users SET role = 'admin', status = 'active',
      password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(hash, salt, existing.id);
    return { action: 'promoted', email: ADMIN_EMAIL, id: existing.id, password, generated };
  }

  const { hash, salt } = await hashPassword(password);
  const info = db.prepare(`INSERT INTO users (email, username, password_hash, password_salt, avatar_hue, role)
    VALUES (?,?,?,?,?, 'admin')`)
    .run(ADMIN_EMAIL, ADMIN_USERNAME, hash, salt, Math.floor(Math.random() * 360));

  const id = Number(info.lastInsertRowid);
  // 三张单行表一次补齐，否则第一次进设置页会因为取不到行而报错
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(id);
  db.prepare('INSERT OR IGNORE INTO llm_settings (user_id) VALUES (?)').run(id);
  db.prepare('INSERT OR IGNORE INTO game_state (user_id) VALUES (?)').run(id);

  return { action: 'created', email: ADMIN_EMAIL, id, password, generated };
}
