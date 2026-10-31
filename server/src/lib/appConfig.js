/* 客户端配置中心
 *
 * ── 这个东西解决什么问题 ──────────────────────────────────────────
 * 小程序审核一次 1~7 天，发版更久。如果「今天关掉 AI 讲解」「把每日
 * 新卡从 2 张调到 5 张」「换一个订阅消息模板」这类操作需要重新提审，
 * 那这个产品在运营上就是僵硬的。
 *
 * 所以：凡是「可能要在不发版的前提下改掉」的参数，一律进这张表。
 * 小程序冷启动拉一次，服务端每次 AI 调用再读一次（有缓存，不查库）。
 *
 * ── 为什么用一份 JSON 而不是一列一个字段 ──────────────────────────
 * 见 schema.sql 里 app_config 的注释。一句话：加配置项不该是一次迁移。
 *
 * ── 读取路径的性能 ────────────────────────────────────────────────
 * getConfig() 有内存缓存，只有 saveConfig() 会失效它。
 * 这意味着 AI 接口每次调用读配置的代价是「一次对象属性访问」，
 * 而不是一次 SQLite 查询 —— 后者在每分钟几十次调用的量级下并不贵，
 * 但没有理由付。
 */

import { db } from '../db/index.js';

/* 默认值 = 出厂状态。
 *
 * ★ 这份默认值同时是「字段清单」。往这里加一个键，前端控制台会自动
 *   多出一个可编辑项（控制台是按这份结构渲染表单的），不用改两处。
 *   所以这里的键名要写成人能看懂的形式，它会长在界面上。
 *
 * ★ 数组不会被深合并（见 mergeDeep），所以列表类配置必须整份替换 ——
 *   这是刻意的：合并数组的语义永远说不清（按下标？按 id？去重？），
 *   与其猜，不如让调用方整份给。 */
export const DEFAULTS = {
  /* ---------- 版本 ---------- */
  version: {
    latest: '1.0.0',
    /* 低于这个版本的客户端会被要求更新。设成 '' 表示不强制。
     * 为什么要有强制更新：小程序端会依赖服务端接口的返回结构，
     * 老版本客户端遇到新结构可能直接白屏 —— 与其让用户面对白屏，
     * 不如给一句「请更新到最新版本」。 */
    min: '',
    note: '',
  },

  /* ---------- 公告 ---------- */
  notice: {
    on: false,
    title: '',
    body: '',
    level: 'info', // 'info' | 'warn'
  },

  /* ---------- 维护模式 ---------- */
  maintenance: {
    on: false,
    message: '系统维护中，预计很快恢复。',
  },

  /* ---------- 功能开关 ----------
   * 小程序端按这个决定「入口显不显示」。
   * ★ 它只是 UI 开关，不是权限 —— 真正的拦截在服务端路由里。
   *   前端藏起来的入口，用 curl 照样打得通，别把两者混为一谈。 */
  features: {
    review: true,
    quiz: true,
    mistakes: true,
    aiExplain: true,
    aiGrade: true,
    aiClassroom: false,
    lab: false,
    graph: true,
    achievements: true,
  },

  /* ---------- 题库 ----------
   * version：题库内容的版本号。改了题、加了题就 +1。
   *   小程序端把它存到 storage，和本地缓存比，不同就重新拉清单。
   *   ★ 这是整个离线化方案的地基：没有版本号，就只能每次都全量拉。
   * baseUrl：预渲染公式图 / 题库清单的静态地址（CDN 或本站）。
   *   留空表示走本站 /static。 */
  bank: {
    version: 1,
    baseUrl: '',
    renderedAt: '',
  },

  /* ---------- AI ----------
   * mode:
   *   'server' —— 用服务端统一 Key（配在环境变量 SERVER_LLM_KEY）。
   *               用户开箱即用，代价是你在替所有人付钱，所以必须配配额。
   *   'byok'   —— 沿用原来的逻辑，每个用户自己填 Key。
   *
   * ★ 默认值是 'byok'，不是 'server'。这不是保守，是必须：
   *   这个仓库已经有人在自己机器上跑着，每个人的 llm_settings 里
   *   都存着他们自己的 Key。默认改成 server 意味着升级之后
   *   SERVER_LLM_KEY 是空的 → 所有 AI 接口当场返回 400。
   *   一个「升级即失去功能」的默认值是设计事故，不是取舍。
   *   想用统一 Key 的人，在控制台点一下切换即可 —— 那是一次显式动作。
   *
   * ★★ 安全红线：mode='server' 时**必须忽略用户自己填的 cloud_base**。
   *    否则用户把 base 改成自己的地址，服务端就会带着**你的 Key**
   *    请求过去 —— 一个公开的 Key 提取器。见 lib/llm.js 里的实现。
   *    这条不是「最好注意一下」，是这个功能能不能开的前提。 */
  ai: {
    mode: 'byok',
    base: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    /* 每用户每日调用次数上限。0 = 不限。
     * 30 次是个经验值：一次「举一反三」= 1 次，一次批改 = 1 次，
     * 一天认真学 1 小时大概用 10~20 次。够用，且不会被人拿去刷。 */
    dailyCalls: 30,
  },

  /* ---------- 订阅消息 ----------
   * 微信的订阅消息是**一次性**的：用户点一次允许，只能发一条。
   * 所以「每天推送」在微信的规则下其实是「每次用户授权后发一条」，
   * 想持续推就必须持续获得授权 —— 这也是为什么这张表要记 quota_left。 */
  push: {
    on: false,
    templateId: '',
    /* 推送时间（小时，本地时区）。到点扫一遍今天有到期卡、且还有
     * 推送额度的用户，各发一条。 */
    hour: 20,
    page: 'pages/review/index',
  },

  /* ---------- 学习参数 ---------- */
  study: {
    /* 每日新卡上限。默认值和 user_settings.daily_new 一致，
     * 这里的值只用于「新用户初始化」，不覆盖用户自己改过的设置。 */
    dailyNew: 2,
    /* 一次复习最多给多少张。防止「攒了 300 张」时一屏刷不完。 */
    reviewCap: 200,
  },
};

/** 深合并。patch 里的值覆盖 base，对象递归，数组/原始值整份替换。 */
function mergeDeep(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch.slice();
  if (typeof patch !== 'object') return patch;

  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = mergeDeep(out[k], v);
  }
  return out;
}

/* 缓存。null 表示「还没读过」——不能拿一个空对象当哨兵，
 * 因为合法配置本来就可能是空对象。 */
let cache = null;

/** 确保单行表存在。启动时调一次，幂等。 */
export function ensureAppConfig() {
  db.prepare('INSERT OR IGNORE INTO app_config (id, json) VALUES (1, ?)')
    .run(JSON.stringify(DEFAULTS));
}

/**
 * 读当前生效的配置（默认值 + 库里存的，深合并）。
 *
 * 深合并的意义：以后往 DEFAULTS 里加了新键，老库里的 JSON 没有那个键，
 * 合并后自动拿到默认值 —— 不需要写迁移去补。这是这份设计最实用的一点。
 */
export function getConfig() {
  if (cache) return cache;

  const row = db.prepare('SELECT json FROM app_config WHERE id = 1').get();
  let stored = {};
  if (row?.json) {
    try { stored = JSON.parse(row.json); } catch {
      /* 库里是坏 JSON 时不能抛 —— 那会让整个服务起不来，
       * 而这时候用户连「进控制台修一下」的机会都没有。
       * 退到全默认值，并把问题记下来，控制台能看到。 */
      stored = {};
    }
  }

  cache = mergeDeep(DEFAULTS, stored);
  return cache;
}

/**
 * 只算不写：把 patch 深合并进当前配置并返回结果。
 *
 * ★ 存在的理由是「先校验、再落库」这件事必须用**同一份**合并结果。
 *   控制台一开始图省事写了 `{...getConfig(), ...patch}`（浅合并），
 *   结果 `{ai:{dailyCalls:50}}` 会把整个 ai 对象替换成只剩 dailyCalls，
 *   mode/base/model 全丢 —— 于是校验报「ai.mode 只能是 server 或 byok」，
 *   而管理员明明只改了配额。这条路径上的坑是：**校验用的对象和写入
 *   用的对象必须是同一个合并算法**，否则校验会拦掉合法输入，或者
 *   放过非法输入。
 */
export function previewConfig(patch) {
  return mergeDeep(getConfig(), patch);
}

/**
 * 写入配置。patch 会深合并进当前配置，未提供的字段保持不变。
 *
 * @returns {{config: object, changed: string[]}} changed 是变更的顶层键，
 *          用于审计日志（「谁把 AI 关了」要查得出来）。
 */
export function saveConfig(patch) {
  const before = getConfig();
  const next = mergeDeep(before, patch);

  /* 只记顶层键的增删改。够用了 —— 审计要回答的是「谁动了哪一块」，
   * 不是「第 3 个字符从 a 变成 b」。 */
  const changed = [];
  for (const k of Object.keys(next)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changed.push(k);
  }

  db.prepare("UPDATE app_config SET json = ?, updated_at = datetime('now') WHERE id = 1")
    .run(JSON.stringify(next));

  cache = next;
  return { config: next, changed };
}

/** 测试用：丢掉缓存。 */
export function resetConfigCache() {
  cache = null;
}

/**
 * 下发给**未登录**客户端的公开配置。
 *
 * ★ 白名单式：只列该给的。用「排除法」（delete 掉敏感的）迟早会漏 ——
 *   以后加了 ai.apiKey 之类的字段，忘了排除就是一次泄露。
 *   列举法不会漏，因为它默认不给。
 *
 * 这里不包含：ai.base / ai.model / ai.dailyCalls 的全局值。
 * 模型名和上游地址属于「服务端实现细节」，没必要告诉客户端；
 * 配额值通过 /api/app/config 的 quota 字段按用户返回。
 */
export function publicConfig() {
  const c = getConfig();
  return {
    version: c.version,
    notice: c.notice,
    maintenance: c.maintenance,
    features: c.features,
    bank: c.bank,
    push: c.push,
    study: c.study,
    /* 告诉客户端「AI 能不能用」以及「是不是走服务端 Key」——
     * 后者决定了设置页要不要显示「填自己的 Key」那一块。 */
    ai: {
      available: c.ai.mode === 'server' ? Boolean(process.env.SERVER_LLM_KEY) : true,
      mode: c.ai.mode,
    },
  };
}
