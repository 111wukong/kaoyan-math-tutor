/* 研数 · 存档层（零依赖）
 *
 * 解决的问题：localStorage 是唯一的持久化介质，但原来的实现有三处硬伤 ——
 *   1) save() 把写入异常整个吞掉，配额满了用户毫无察觉，一直答到某天发现进度没了；
 *   2) state.attempts 只增不减，按每天 50 题算一年就是 1.8 万条（约 2.3 MB），
 *      逼近浏览器 5 MB 的配额；
 *   3) 没有任何导出/导入出口，浏览器清缓存 = 全部学习记录归零。
 *
 * 这里的做法：
 *
 *   stats  —— 全量聚合（永不裁剪），是"计数类"问题的唯一权威。
 *             掌握度、正确率、热力图、薄弱点全都读它。
 *   attempts —— 只保留最近 CAP_DETAIL 条明细，供错题本展示"我的答案"这类需要原文的地方。
 *
 * 关键不变式：**裁剪明细之前先把全量计数冻结进 stats**。
 * 所以「裁剪前算出的掌握度」与「裁剪后算出的掌握度」必须完全一致 ——
 * 这条由 tests/test-store.js 断言，不是靠自觉。
 *
 * 依赖顺序：本文件必须最先加载（game.js / app.js 都读 window.Store）。
 */
(function () {
  'use strict';

  var SCHEMA = 2;            // 导出包格式版本
  var STATS_V = 1;           // stats 结构版本
  var CAP_DETAIL = 2000;     // attempts 明细保留条数（约 40 天 × 50 题）
  var CAP_DAYS = 1400;       // stats.days 保留天数（约 3.8 年）
  var APP_ID = 'kaoyan-math-tutor';

  /* ---------- 1. 聚合 ---------- */

  function blankStats() {
    return {
      v: STATS_V,
      n: 0,                    // 累计作答次数（永不回退）
      nodes: {},               // kid -> { n, c, ts }
      qs: {},                  // qid -> { n, c, ok, ts, kid }；ok = 最后一次是否答对
      days: {},                // 'YYYY-MM-DD' -> { n, c }
      today: { date: '', q: {} } // 当日逐题次数，只保留最近一天（answerXp 要用）
    };
  }

  function isStats(s) { return !!s && s.v === STATS_V && typeof s.n === 'number'; }

  /* 增量累加一条作答。必须按时间顺序调用（app.js 在 push 时调用，天然有序）。 */
  function bump(stats, rec) {
    if (!isStats(stats)) return blankStats();
    if (!rec) return stats;
    var qid = String(rec.qid == null ? '' : rec.qid);
    var kid = String(rec.kid == null ? '' : rec.kid);
    var date = String(rec.date == null ? '' : rec.date);
    var ts = +rec.ts || 0;
    var ok = rec.correct ? 1 : 0;

    stats.n += 1;

    var ns = stats.nodes[kid] || (stats.nodes[kid] = { n: 0, c: 0, ts: 0 });
    ns.n += 1;
    if (ok) ns.c += 1;
    if (ts >= ns.ts) ns.ts = ts;

    /* qs[qid] 记录"该题最后一次作答"——掌握度口径「每道题都答对过」靠它，
       所以 ts 相同（测试里手搓的记录常常没有 ts）时也要让后写的覆盖先写的。 */
    var q = stats.qs[qid] || (stats.qs[qid] = { n: 0, c: 0, ok: 0, ts: 0, kid: kid });
    q.n += 1;
    if (ok) q.c += 1;
    if (ts >= q.ts) { q.ts = ts; q.ok = ok; }
    q.kid = kid;

    var ds = stats.days[date] || (stats.days[date] = { n: 0, c: 0 });
    ds.n += 1;
    if (ok) ds.c += 1;

    if (stats.today.date !== date) stats.today = { date: date, q: {} };
    stats.today.q[qid] = (stats.today.q[qid] || 0) + 1;

    return stats;
  }

  /* 从明细全量重算。老存档没有 stats 时用它补上。 */
  function statsFrom(state) {
    var st = blankStats();
    var arr = (state && state.attempts) || [];
    for (var i = 0; i < arr.length; i++) bump(st, arr[i]);
    return st;
  }

  /* 读聚合。带一层极轻的缓存 —— 渲染一个页面会问几十次，
     每次都遍历 2000 条明细没必要。
     缓存签名用「明细长度 + 最后一条的 ts」：push / 裁剪都会改变它。 */
  var _cache = null;
  function statsOf(state) {
    if (!state) return blankStats();
    var arr = state.attempts || [];
    var sig = arr.length + ':' + (arr.length ? (+arr[arr.length - 1].ts || 0) : 0);
    var persisted = isStats(state.stats);
    if (_cache && _cache.state === state && _cache.sig === sig && _cache.persisted === persisted) {
      return _cache.val;
    }
    var val;
    if (persisted) {
      /* 明细条数不可能超过累计次数（明细是累计的子集）。
         真超过了说明 stats 落后于明细，宁可重算一次也不要用坏数据。 */
      val = state.stats.n >= arr.length ? state.stats : statsFrom(state);
    } else {
      val = statsFrom(state);
    }
    _cache = { state: state, sig: sig, persisted: persisted, val: val };
    return val;
  }

  /* 当日某题已作答次数。answerXp 用它算「今日第几次」。
     注意 answerXp 是在 push 之前调用的，所以这里返回的是"本次之前"的次数。 */
  function todayCount(stats, qid, date) {
    if (!stats || !stats.today || stats.today.date !== date) return 0;
    return (stats.today.q && stats.today.q[qid]) || 0;
  }

  /* 某知识点的全量计数。没有记录时返回 { n:0, c:0, ts:0 }。 */
  function nodeStat(stats, kid) {
    return (stats && stats.nodes && stats.nodes[kid]) || { n: 0, c: 0, ts: 0 };
  }

  /* 某天的全量计数。 */
  function dayStat(stats, date) {
    return (stats && stats.days && stats.days[date]) || { n: 0, c: 0 };
  }

  /* 该知识点下"最后一次答错的题"数量 —— 与 app.js mistakeList / Game.projection 口径一致。 */
  function wrongLastCount(stats, kidFilter) {
    var n = 0;
    if (!stats || !stats.qs) return 0;
    for (var qid in stats.qs) {
      if (!stats.qs.hasOwnProperty(qid)) continue;
      var q = stats.qs[qid];
      if (kidFilter && !kidFilter(q.kid)) continue;
      if (!q.ok) n++;
    }
    return n;
  }

  /* ---------- 2. 裁剪 ---------- */

  /* 把明细裁到 CAP_DETAIL 条。
     先冻结 stats（全量计数），再丢最旧的明细 —— 顺序反了就会真的丢数据。 */
  function trim(state) {
    if (!state) return { dropped: 0, kept: 0, frozen: false };
    var arr = state.attempts || [];
    var frozen = false;
    if (!isStats(state.stats) || state.stats.n < arr.length) {
      state.stats = statsFrom(state);
      frozen = true;
    }
    var dropped = 0;
    if (arr.length > CAP_DETAIL) {
      dropped = arr.length - CAP_DETAIL;
      state.attempts = arr.slice(dropped);
    }
    var days = Object.keys(state.stats.days || {});
    if (days.length > CAP_DAYS) {
      days.sort();
      for (var i = 0; i < days.length - CAP_DAYS; i++) delete state.stats.days[days[i]];
    }
    return { dropped: dropped, kept: state.attempts.length, frozen: frozen };
  }

  /* 存档体检 + 修复。load() 里调用一次。 */
  function ensure(state) {
    if (!state) return state;
    if (!state.attempts || !state.attempts.length) {
      if (!isStats(state.stats)) state.stats = blankStats();
      return state;
    }
    var r = trim(state);
    if (r.dropped || r.frozen) state.__storeRepair = { dropped: r.dropped, frozen: r.frozen };
    return state;
  }

  /* ---------- 3. 写入 ---------- */

  /* 记一次作答：进明细 → 进聚合 → 裁剪。
     顺序不能反 —— 先裁剪再聚合的话，被丢掉的那几条就永远进不了计数。 */
  function pushAttempt(state, rec) {
    if (!state || !rec) return null;
    if (!state.attempts) state.attempts = [];
    if (!isStats(state.stats)) state.stats = statsFrom(state);
    state.attempts.push(rec);
    bump(state.stats, rec);
    trim(state);
    return rec;
  }

  /* ---------- 4. 用量与配额 ---------- */

  /* localStorage 按 UTF-16 计，一个字符 2 字节。 */
  function sizeOf(state) {
    var s = '';
    try { s = JSON.stringify(state) || ''; } catch (e) { s = ''; }
    return { chars: s.length, bytes: s.length * 2 };
  }

  var _quota = 0;
  /* 实测本机配额：从 128 KB 起倍增写探针，直到写不进去。
     只在打开"数据"面板时跑一次，结果缓存。 */
  function probeQuota() {
    if (_quota) return _quota;
    var key = '__kaoyan_probe__';
    var n = 128 * 1024;
    try {
      localStorage.removeItem(key);
      for (var i = 0; i < 8 && n <= 8 * 1024 * 1024; i++) {
        try { localStorage.setItem(key, new Array(n + 1).join('x')); }
        catch (e) { break; }
        n *= 2;
      }
      localStorage.removeItem(key);
      _quota = Math.min(n, 8 * 1024 * 1024);
    } catch (e) {
      try { localStorage.removeItem(key); } catch (e2) { /* 忽略 */ }
      _quota = 5 * 1024 * 1024;
    }
    return _quota;
  }

  function usage(state, withProbe) {
    var sz = sizeOf(state);
    var arr = (state && state.attempts) || [];
    var quotaChars = withProbe ? probeQuota() : 0;
    return {
      chars: sz.chars,
      bytes: sz.bytes,
      kb: Math.round(sz.bytes / 1024),
      attempts: arr.length,
      cap: CAP_DETAIL,
      quotaChars: quotaChars,
      /* 没探测过就不编一个比例出来 —— 显示"—"比显示一个假数字诚实 */
      ratio: quotaChars ? Math.min(1, sz.chars / quotaChars) : null,
      days: Object.keys((state && state.stats && state.stats.days) || {}).length,
      totalAttempts: (state && state.stats && state.stats.n) || arr.length
    };
  }

  /* ---------- 5. 导出 ---------- */

  var EXPORT_FIELDS = ['attempts', 'cards', 'checkins', 'daily', 'customQ', 'notes',
    'classrooms', 'cardDeck', 'game', 'chats', 'settings'];

  function clone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; }
  }

  /* 生成导出包。**默认剥掉 API Key** —— 导出文件常被丢进网盘/聊天窗口，
     密钥跟着跑出去是很容易发生的事故。要连 Key 一起导出得显式传 {withKey:true}。 */
  function bundle(state, opts) {
    opts = opts || {};
    var data = {};
    EXPORT_FIELDS.forEach(function (k) {
      if (state && state[k] !== undefined) data[k] = clone(state[k]);
    });
    var hadKey = !!(data.settings && data.settings.llm && data.settings.llm.cloudKey);
    if (data.settings && data.settings.llm) {
      if (!opts.withKey) { data.settings.llm.cloudKey = ''; data.settings.llm.rememberKey = false; }
    }
    return {
      app: APP_ID,
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      appVersion: (opts.version || '1.0'),
      keyStripped: hadKey && !opts.withKey,
      stats: state && isStats(state.stats) ? clone(state.stats) : null,
      data: data
    };
  }

  function fileName(now) {
    var d = now || new Date();
    function p(n) { return ('0' + n).slice(-2); }
    return '研数备份-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
  }

  /* ---------- 6. 导入校验 ---------- */

  function validate(obj) {
    var errs = [];
    if (!obj || typeof obj !== 'object') return { ok: false, errors: ['文件内容不是 JSON 对象'], summary: null };
    if (obj.app !== APP_ID) errs.push('这不是研数的备份文件（缺少 app 标识）');
    if (typeof obj.schema !== 'number') errs.push('缺少 schema 版本号');
    else if (obj.schema > SCHEMA) errs.push('备份来自更新的版本（schema ' + obj.schema + '），当前只认到 ' + SCHEMA);
    if (!obj.data || typeof obj.data !== 'object') errs.push('缺少 data 段');
    if (errs.length) return { ok: false, errors: errs, summary: null };

    var d = obj.data;
    ['attempts', 'customQ'].forEach(function (k) {
      if (d[k] !== undefined && !Array.isArray(d[k])) errs.push(k + ' 应该是数组');
    });
    ['cards', 'checkins', 'notes', 'classrooms', 'cardDeck', 'chats'].forEach(function (k) {
      if (d[k] !== undefined && (typeof d[k] !== 'object' || d[k] === null || Array.isArray(d[k]))) {
        errs.push(k + ' 应该是对象');
      }
    });
    if (errs.length) return { ok: false, errors: errs, summary: null };

    var attempts = Array.isArray(d.attempts) ? d.attempts : [];
    var dates = {};
    attempts.forEach(function (a) { if (a && a.date) dates[a.date] = 1; });
    var dayKeys = Object.keys(dates).sort();
    return {
      ok: true, errors: [],
      summary: {
        schema: obj.schema,
        exportedAt: obj.exportedAt || '',
        attempts: attempts.length,
        totalAttempts: (obj.stats && obj.stats.n) || attempts.length,
        cards: Object.keys(d.cards || {}).length,
        checkins: Object.keys(d.checkins || {}).length,
        customQ: (d.customQ || []).length,
        chats: Object.keys(d.chats || {}).length,
        classrooms: Object.keys(d.classrooms || {}).length,
        xp: (d.game && d.game.xp) || 0,
        firstDay: dayKeys[0] || '',
        lastDay: dayKeys[dayKeys.length - 1] || '',
        hasSettings: !!d.settings,
        keyStripped: !!obj.keyStripped
      }
    };
  }

  /* ---------- 7. 导入合并 ---------- */

  function laterOf(a, b) {
    /* 取"更靠后"的那条卡片：先看 lastReview，再看 reps，最后偏向 a（本机的） */
    var ta = +((a && (a.lastReview || a.createdAt)) || 0);
    var tb = +((b && (b.lastReview || b.createdAt)) || 0);
    if (ta !== tb) return ta > tb ? a : b;
    return ((a && a.reps) || 0) >= ((b && b.reps) || 0) ? a : b;
  }

  function attemptKey(a) {
    if (!a) return '';
    if (a.id) return a.id;
    return String(a.qid) + '|' + String(a.ts || 0) + '|' + String(a.date || '');
  }

  /* 把两个存档合起来。策略是"只增不减" —— 合并永远不该让任何一份数据变少。 */
  function mergeInto(base, incoming) {
    if (!base || !incoming) return base;

    /* 作答：按 key 去重，两边并集，按时间重排 */
    var seen = {};
    var attempts = [];
    (base.attempts || []).concat(incoming.attempts || []).forEach(function (a) {
      var k = attemptKey(a);
      if (!k || seen[k]) return;
      seen[k] = 1;
      attempts.push(a);
    });
    attempts.sort(function (x, y) { return (+x.ts || 0) - (+y.ts || 0); });
    base.attempts = attempts;

    /* 卡片：同一张取更靠后的那次复习状态 */
    var cards = base.cards = base.cards || {};
    var incCards = incoming.cards || {};
    for (var cid in incCards) {
      if (!incCards.hasOwnProperty(cid)) continue;
      cards[cid] = cards[cid] ? laterOf(cards[cid], incCards[cid]) : incCards[cid];
    }

    /* 打卡：同一天取分钟数大的 */
    var ck = base.checkins = base.checkins || {};
    var incCk = incoming.checkins || {};
    for (var d in incCk) {
      if (!incCk.hasOwnProperty(d)) continue;
      var a1 = ck[d], b1 = incCk[d];
      if (!a1) ck[d] = b1;
      else if (b1 && (b1.minutes || 0) > (a1.minutes || 0)) ck[d] = b1;
    }

    /* 自定义题库：按 id 并集 */
    var seenQ = {}, cq = [];
    (base.customQ || []).concat(incoming.customQ || []).forEach(function (q) {
      var k = q && (q.id || q.stem);
      if (!k || seenQ[k]) return;
      seenQ[k] = 1;
      cq.push(q);
    });
    base.customQ = cq;

    /* 游戏化：取更大的进度，集合类取并集 */
    if (incoming.game) {
      var g = base.game = base.game || {};
      var h = incoming.game;
      g.xp = Math.max(g.xp || 0, h.xp || 0);
      g.combo = Math.max(g.combo || 0, h.combo || 0);
      g.bestCombo = Math.max(g.bestCombo || 0, h.bestCombo || 0);
      ['achievements', 'flags', 'seen', 'boss', 'makeups', 'freezeLog', 'blitz'].forEach(function (k) {
        if (h[k] === undefined) return;
        if (Array.isArray(h[k])) {
          var s = {};
          (g[k] || []).concat(h[k]).forEach(function (x) { s[x] = 1; });
          g[k] = Object.keys(s);
        } else if (h[k] && typeof h[k] === 'object') {
          g[k] = g[k] || {};
          for (var kk in h[k]) {
            if (!h[k].hasOwnProperty(kk)) continue;
            if (g[k][kk] === undefined) { g[k][kk] = h[k][kk]; continue; }
            if (typeof h[k][kk] === 'number' && typeof g[k][kk] === 'number') {
              g[k][kk] = Math.max(g[k][kk], h[k][kk]);
            }
          }
        }
      });
    }

    /* 笔记 / 课堂 / 卡组 / 聊天：补齐本机没有的，本机已有的不动 */
    ['notes', 'classrooms', 'cardDeck', 'chats'].forEach(function (k) {
      var t = base[k] = base[k] || {};
      var inc = incoming[k] || {};
      for (var id in inc) {
        if (inc.hasOwnProperty(id) && t[id] === undefined) t[id] = inc[id];
      }
    });

    /* 设置：本机优先，只补空缺 —— 导入别人的存档不该把本机模型配置冲掉 */
    if (incoming.settings) {
      var s0 = base.settings = base.settings || {};
      var s1 = incoming.settings;
      for (var sk in s1) {
        if (!s1.hasOwnProperty(sk)) continue;
        if (s0[sk] === undefined) s0[sk] = s1[sk];
      }
    }

    return base;
  }

  /* 把导入包应用到 state 上。mode: 'replace' | 'merge'。
     replace 也保留本机的 settings.llm —— 否则换台机器导入就把 Key 和模型配置清了。 */
  function applyBundle(state, obj, mode) {
    var d = obj.data || {};
    if (mode === 'replace') {
      var keepLLM = state.settings && state.settings.llm;
      EXPORT_FIELDS.forEach(function (k) {
        if (d[k] === undefined) return;
        state[k] = clone(d[k]);
      });
      if (keepLLM) state.settings.llm = keepLLM;
    } else {
      mergeInto(state, d);
    }
    /* 合并完必须重算：两边的 stats 相加没有意义，明细并集才是真的 */
    state.stats = isStats(obj.stats) && mode === 'replace' && !d.attempts
      ? clone(obj.stats)
      : statsFrom(state);
    trim(state);
    return state;
  }

  /* ---------- 8. 兜底 ---------- */

  /* 浏览器禁用 localStorage（隐私模式 / 站点设置）时不要整个应用崩掉 */
  function available() {
    try {
      var k = '__kaoyan_t__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  window.Store = {
    SCHEMA: SCHEMA, STATS_V: STATS_V, CAP_DETAIL: CAP_DETAIL, CAP_DAYS: CAP_DAYS, APP_ID: APP_ID,

    blankStats: blankStats,
    isStats: isStats,
    bump: bump,
    statsFrom: statsFrom,
    statsOf: statsOf,
    todayCount: todayCount,
    nodeStat: nodeStat,
    dayStat: dayStat,
    wrongLastCount: wrongLastCount,

    trim: trim,
    ensure: ensure,
    pushAttempt: pushAttempt,

    sizeOf: sizeOf,
    probeQuota: probeQuota,
    usage: usage,

    bundle: bundle,
    fileName: fileName,
    validate: validate,
    mergeInto: mergeInto,
    applyBundle: applyBundle,
    available: available,

    /* 给测试用：清掉 statsOf 的缓存 */
    _resetCache: function () { _cache = null; }
  };
})();
