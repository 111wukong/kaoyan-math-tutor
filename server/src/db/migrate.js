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
 * 凭据从环境变量读，默认值写在下面。默认值明文放在源码里是**有意为之**：
 *   1. 这是个本地/自托管的单机应用，不是多租户 SaaS；
 *   2. 没有默认值的话，首次部署的人拿不到任何入口，只能手改数据库；
 *   3. 明文只存在于「第一次创建」那一刻 —— 建完立刻可以改密。
 * 但**上线前必须改**，所以启动时会打一行显眼的警告，README 里也写了。
 *
 * 幂等性：只在「库里一个管理员都没有」时才创建/提权。
 * 之后再启动就是纯读，不会覆盖你已经改过的密码。
 */
import { db } from './index.js';
import { hashPassword } from '../lib/password.js';

/** 内置的默认引导密码。等于它就该在启动时警告。 */
export const DEFAULT_ADMIN_PASSWORD = 'wgh123456';

/** 引导管理员。生产环境请用 ADMIN_EMAIL / ADMIN_PASSWORD 覆盖。 */
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'wukong@qq.com').trim().toLowerCase();
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '管理员';

/** 引导凭据是不是还在用内置默认值。 */
export function usingDefaultAdminCredentials() {
  return ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD;
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
 *   3. 引导邮箱已被注册（但库里还没有管理员）→ 提权 + 重置成引导密码，
 *      返回 { action: 'promoted' }。重置密码是必要的：那个账号原来的密码
 *      我们无从得知，不提权则登不进去，提权但不重置则你自己也可能进不去。
 *      只在「首次提权」这一条路径上发生。
 *
 * @returns {Promise<{action:'skip'|'created'|'promoted', email:string, id?:number}>}
 */
export async function ensureAdmin() {
  if (adminCount() > 0) return { action: 'skip', email: ADMIN_EMAIL };

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(ADMIN_EMAIL);

  if (existing) {
    const { hash, salt } = await hashPassword(ADMIN_PASSWORD);
    db.prepare(`UPDATE users SET role = 'admin', status = 'active',
      password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(hash, salt, existing.id);
    return { action: 'promoted', email: ADMIN_EMAIL, id: existing.id };
  }

  const { hash, salt } = await hashPassword(ADMIN_PASSWORD);
  const info = db.prepare(`INSERT INTO users (email, username, password_hash, password_salt, avatar_hue, role)
    VALUES (?,?,?,?,?, 'admin')`)
    .run(ADMIN_EMAIL, ADMIN_USERNAME, hash, salt, Math.floor(Math.random() * 360));

  const id = Number(info.lastInsertRowid);
  // 三张单行表一次补齐，否则第一次进设置页会因为取不到行而报错
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(id);
  db.prepare('INSERT OR IGNORE INTO llm_settings (user_id) VALUES (?)').run(id);
  db.prepare('INSERT OR IGNORE INTO game_state (user_id) VALUES (?)').run(id);

  return { action: 'created', email: ADMIN_EMAIL, id };
}
