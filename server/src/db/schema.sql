-- 研数 · 数据库结构（SQLite）
--
-- 设计要点：
-- 1) 知识树与题库是「全局种子」（owner_id IS NULL），用户自建题 owner_id 指向用户；
-- 2) 学习数据一律按 user_id 隔离，级联删除；
-- 3) 聚合表（stats_*）与明细表（attempts）在同一事务内同步写入 ——
--    原纯前端版之所以要「裁剪前先冻结统计」，是因为 localStorage 有 5MB 配额；
--    数据库没有这个约束，但保留聚合表的真正理由是：看板页要跑几十次聚合查询，
--    每次全表扫 attempts 是浪费。明细仍然是权威，聚合表可从明细完整重建（见 rebuildStats）。
-- 4) 时间统一存 ISO8601 文本（本地日期 'YYYY-MM-DD' 用于业务口径，UTC 用于审计）。

PRAGMA foreign_keys = ON;

-- ============ 用户与会话 ============
-- role / status / note 三列是后加的（见 migrate.js 里的 ALTER TABLE）。
-- schema.sql 用的是 CREATE TABLE IF NOT EXISTS —— 老库再跑一遍不会补列，
-- 所以「新库建表」和「老库补列」两件事必须都做，缺一个就会出现
-- 「本机好好的、换台机器就报 no such column」。
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,          -- scrypt 派生，hex
  password_salt TEXT    NOT NULL,          -- 随机 16 字节，hex
  avatar_hue    INTEGER NOT NULL DEFAULT 0,-- 头像渐变色相，注册时随机分配
  role          TEXT    NOT NULL DEFAULT 'user',    -- 'user' | 'admin'
  status        TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'disabled'
  note          TEXT    NOT NULL DEFAULT '',        -- 管理员备注（只有管理员看得到）
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- ⚠️ users(role) 的索引**故意不写在这里**，它建在 migrate.js 里。
--
-- 原因：本文件是整段 exec 的，且全部是 IF NOT EXISTS。在老库上，
-- users 表已存在 → 上面那条 CREATE TABLE 被跳过 → 此刻 role 列还不存在
-- （它是靠 migrate() 里的 ALTER TABLE 补的，而 migrate() 在本文件之后才跑）。
-- 这时候执行 CREATE INDEX ... ON users(role) 会直接抛
-- 「no such column: role」，把整个 initSchema 打断，服务根本起不来。
-- 实测踩过一次，报错点在 index.js 的 initSchema，看着像建表脚本坏了。
--
-- 所以凡是「依赖新增列」的索引/约束，一律放到 migrate() 里，别放这儿。

-- 会话表：存 token 的 sha256，不存原文 —— 库被拖走也换不出可用的 cookie
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============ 用户配置 ============
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  exam_track TEXT    NOT NULL DEFAULT 'math1',
  daily_new  INTEGER NOT NULL DEFAULT 2,
  exam_date  TEXT    NOT NULL DEFAULT '',
  persona    TEXT    NOT NULL DEFAULT 'strict',
  sfx        INTEGER NOT NULL DEFAULT 1,
  theme      TEXT    NOT NULL DEFAULT 'deep-space',
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_settings (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 1,
  kind         TEXT    NOT NULL DEFAULT 'cloud',
  local_base   TEXT    NOT NULL DEFAULT 'http://127.0.0.1:1234/v1',
  local_model  TEXT    NOT NULL DEFAULT '',
  cloud_base   TEXT    NOT NULL DEFAULT 'https://api.deepseek.com',
  cloud_model  TEXT    NOT NULL DEFAULT 'deepseek-chat',
  cloud_key    TEXT    NOT NULL DEFAULT '',
  remember_key INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============ 知识树（全局种子）============
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#3b82f6',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chapters (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chapters_cat ON chapters(category_id, sort_order);

CREATE TABLE IF NOT EXISTS knowledge (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  chapter_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  example     TEXT NOT NULL DEFAULT '',
  difficulty  INTEGER NOT NULL DEFAULT 2,
  exam        TEXT NOT NULL DEFAULT 'all',   -- 'all' 或 'math1,math2'
  related     TEXT NOT NULL DEFAULT '[]',    -- JSON 数组
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chapter ON knowledge(chapter_id, sort_order);

-- ============ 题库 ============
CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  kid         TEXT NOT NULL,
  type        TEXT NOT NULL,                 -- choice | blank
  difficulty  INTEGER NOT NULL DEFAULT 2,
  stem        TEXT NOT NULL,
  options     TEXT,                          -- JSON 数组，仅选择题
  answer      TEXT NOT NULL,
  analysis    TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  source_year INTEGER,
  source      TEXT NOT NULL DEFAULT '',
  owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE  -- NULL = 内置
);
CREATE INDEX IF NOT EXISTS idx_questions_kid ON questions(kid);
CREATE INDEX IF NOT EXISTS idx_questions_owner ON questions(owner_id);

-- ============ 学习数据（按用户隔离）============

-- 作答明细。权威数据源。
CREATE TABLE IF NOT EXISTS attempts (
  id      TEXT    PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qid     TEXT    NOT NULL,
  kid     TEXT    NOT NULL,
  answer  TEXT,
  correct INTEGER NOT NULL,
  context TEXT,                              -- quiz | review | blitz | classroom | accept
  date    TEXT    NOT NULL,                  -- 'YYYY-MM-DD' 本地日期
  ts      INTEGER NOT NULL                   -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_attempts_user_ts ON attempts(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_user_kid ON attempts(user_id, kid);
CREATE INDEX IF NOT EXISTS idx_attempts_user_qid ON attempts(user_id, qid);
CREATE INDEX IF NOT EXISTS idx_attempts_user_date ON attempts(user_id, date);

-- 聚合表：由 attempts 派生，写入时同事务更新。可用 rebuildStats() 完整重建。
CREATE TABLE IF NOT EXISTS stats_node (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kid     TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  c       INTEGER NOT NULL DEFAULT 0,
  ts      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kid)
);

CREATE TABLE IF NOT EXISTS stats_question (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qid     TEXT    NOT NULL,
  kid     TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  c       INTEGER NOT NULL DEFAULT 0,
  ok      INTEGER NOT NULL DEFAULT 0,        -- 最后一次是否答对 → 错题本口径
  ts      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, qid)
);
CREATE INDEX IF NOT EXISTS idx_stats_q_wrong ON stats_question(user_id, ok);

CREATE TABLE IF NOT EXISTS stats_daily (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  c       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- 复习卡片（SM-2）
CREATE TABLE IF NOT EXISTS cards (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL DEFAULT 'knowledge',  -- knowledge | mistake
  knowledge_id TEXT,
  question_id  TEXT,
  due          TEXT    NOT NULL,
  interval     INTEGER NOT NULL DEFAULT 0,
  reps         INTEGER NOT NULL DEFAULT 0,
  ef           REAL    NOT NULL DEFAULT 2.5,
  lapses       INTEGER NOT NULL DEFAULT 0,
  last_review  TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_user_due ON cards(user_id, due);
CREATE INDEX IF NOT EXISTS idx_cards_user_kid ON cards(user_id, knowledge_id);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kid        TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  date       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user_kid ON notes(user_id, kid);

CREATE TABLE IF NOT EXISTS card_deck (
  id      TEXT    PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kid     TEXT    NOT NULL,
  type    TEXT    NOT NULL,
  title   TEXT    NOT NULL,
  front   TEXT    NOT NULL,
  back    TEXT    NOT NULL,
  src     TEXT    NOT NULL DEFAULT 'class',
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deck_user_kid ON card_deck(user_id, kid);

CREATE TABLE IF NOT EXISTS checkins (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  minutes    INTEGER NOT NULL DEFAULT 0,
  tasks_done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS daily_plan (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT    NOT NULL,
  review_ids   TEXT    NOT NULL DEFAULT '[]',
  new_ids      TEXT    NOT NULL DEFAULT '[]',
  quiz_ids     TEXT    NOT NULL DEFAULT '[]',
  review_done  TEXT    NOT NULL DEFAULT '[]',
  new_done     TEXT    NOT NULL DEFAULT '[]',
  quiz_done    TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS game_state (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp         INTEGER NOT NULL DEFAULT 0,
  combo      INTEGER NOT NULL DEFAULT 0,
  best_combo INTEGER NOT NULL DEFAULT 0,
  blitz      TEXT    NOT NULL DEFAULT '{}',   -- JSON：闪电战最好成绩
  flags      TEXT    NOT NULL DEFAULT '{}',   -- JSON：一次性标记
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS achievements (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT    NOT NULL,
  date           TEXT    NOT NULL,
  PRIMARY KEY (user_id, achievement_id)
);

CREATE TABLE IF NOT EXISTS boss_records (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chapter_id TEXT    NOT NULL,
  score      INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  pct        INTEGER NOT NULL DEFAULT 0,
  date       TEXT    NOT NULL,
  PRIMARY KEY (user_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS chats (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kid          TEXT    NOT NULL,
  stage        TEXT    NOT NULL DEFAULT 'explain',
  history      TEXT    NOT NULL DEFAULT '[]',
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kid)
);

CREATE TABLE IF NOT EXISTS classrooms (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kid      TEXT    NOT NULL,
  payload  TEXT    NOT NULL DEFAULT '{}',
  ts       INTEGER NOT NULL,
  PRIMARY KEY (user_id, kid)
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minutes    INTEGER NOT NULL,
  started_at TEXT    NOT NULL,
  ended_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_focus_user ON focus_sessions(user_id, ended_at DESC);

-- ============ 审计 ============
CREATE TABLE IF NOT EXISTS auth_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT,
  user_id    INTEGER,
  event      TEXT NOT NULL,   -- register | login | login_failed | logout | password_change
  ip         TEXT,
  user_agent TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_authlog_at ON auth_log(at DESC);

-- 管理员操作审计。
--
-- 为什么不复用 auth_log：两者的主体不同。auth_log 记的是「这个人对自己做了什么」
-- （登录、改密），admin_log 记的是「这个人对别人做了什么」（改角色、删号、重置密码）。
-- 混在一张表里，「谁被谁改了什么」需要靠 event 名前缀去猜，审计时最容易看漏。
-- 分成两张，查询各自直白。
CREATE TABLE IF NOT EXISTS admin_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL,   -- 操作者（管理员）的 user_id
  actor_email TEXT    NOT NULL,
  target_id   INTEGER,            -- 被操作者，删号后置 NULL 保留痕迹
  target_email TEXT,
  action      TEXT    NOT NULL,   -- user_create | user_update | user_delete | password_reset | force_logout
  detail      TEXT    NOT NULL DEFAULT '{}',  -- JSON：改了哪些字段、前后值
  ip          TEXT,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_adminlog_at ON admin_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_adminlog_target ON admin_log(target_id);
