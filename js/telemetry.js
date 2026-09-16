/* 研数 · 本地可观测性（零依赖，默认不向任何地方发送数据）
 *
 * 解决的问题：这个应用没有服务端，也就没有日志。用户说"它坏了"的时候，
 * 开发者手上什么都没有 —— 连"他打开的是哪个页面、报了什么错"都不知道。
 *
 * 做法：把事件与错误留在本机，用户主动点「复制诊断信息」时才交出来。
 *
 * 一条硬规则：**诊断包里不出现任何用户内容**。
 * 不包含 API Key、聊天记录、笔记正文、题目与答案、错题原文 —— 只有计数和错误消息。
 * 用户愿意把诊断包发给你，不等于愿意把跟 AI 的对话记录发给你。
 * 这条由 tests/test-telemetry.js 断言（拿一份"全是敏感内容"的 state 生成报告，
 * 逐项检查里面不含这些字符串）。
 *
 * 关于 endpoint：留了字段但不填就不发。将来接服务端时改这一处即可，
 * 但**不要**默默把它打开 —— 一个承诺"数据不出本机"的应用突然开始上报，
 * 是信任层面的事故。
 */
(function () {
  'use strict';

  var KEY = 'kaoyan_math_tutor_diag_v1';
  var V = 1;
  var CAP_EVENTS = 400;      // 事件环形缓冲条数
  var CAP_ERRORS = 60;       // 错误去重后的条数
  var CAP_MSG = 300;         // 单条消息截断长度

  var buf = null;            // { v, events: [], errors: [], installedAt, sessions }
  var installed = false;

  function blank() {
    return { v: V, events: [], errors: {}, installedAt: Date.now(), sessions: 0 };
  }

  function load() {
    if (buf) return buf;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && d.v === V && Array.isArray(d.events) && d.errors && typeof d.errors === 'object') {
          buf = d;
          return buf;
        }
      }
    } catch (e) { /* 存储不可用或内容坏了，重建即可 —— 诊断数据不值得为它报错 */ }
    buf = blank();
    return buf;
  }

  var saveTimer = null;
  /* 诊断写入要节流：一次页面渲染可能产生几十个事件，
     每次都 JSON.stringify + setItem 会明显拖慢交互。 */
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try { localStorage.setItem(KEY, JSON.stringify(load())); } catch (e) { /* 配额满就放弃诊断数据 */ }
    }, 1200);
  }

  function clip(s) {
    var t = String(s == null ? '' : s);
    return t.length > CAP_MSG ? t.slice(0, CAP_MSG) + '…' : t;
  }

  /* ---------- 事件 ---------- */
  function event(name, props) {
    var b = load();
    b.events.push({ t: Date.now(), n: clip(name), p: props ? compact(props) : null });
    if (b.events.length > CAP_EVENTS) b.events = b.events.slice(b.events.length - CAP_EVENTS);
    persist();
  }

  /* 只留短标量，别把整个对象塞进诊断日志 */
  function compact(props) {
    var out = {};
    var n = 0;
    for (var k in props) {
      if (!props.hasOwnProperty(k)) continue;
      if (n >= 8) break;
      var v = props[k];
      var t = typeof v;
      if (t === 'string') out[k] = clip(v).slice(0, 60);
      else if (t === 'number' || t === 'boolean' || v === null) out[k] = v;
      n++;
    }
    return out;
  }

  /* ---------- 错误 ---------- */
  /* 同一条错误只留一条记录 + 计数。
     真实世界里同一个异常会在一秒内抛出几百次（渲染循环里），
     不去重的话缓冲区瞬间被同一条塞满，什么都看不到。 */
  function error(kind, message, stack) {
    var b = load();
    var msg = clip(message);
    var key = String(kind || 'error') + '|' + msg.slice(0, 120);
    var e = b.errors[key];
    if (e) {
      e.count++;
      e.last = Date.now();
    } else {
      e = b.errors[key] = {
        kind: String(kind || 'error'), msg: msg,
        stack: stack ? clip(stack).slice(0, 600) : '',
        first: Date.now(), last: Date.now(), count: 1
      };
    }
    /* 超上限时丢最早的那条（按首次出现时间） */
    var keys = Object.keys(b.errors);
    if (keys.length > CAP_ERRORS) {
      keys.sort(function (x, y) { return b.errors[x].first - b.errors[y].first; });
      for (var i = 0; i < keys.length - CAP_ERRORS; i++) delete b.errors[keys[i]];
    }
    persist();
  }

  function errorList() {
    var b = load();
    return Object.keys(b.errors).map(function (k) { return b.errors[k]; })
      .sort(function (x, y) { return y.last - x.last; });
  }

  /* ---------- 安装全局捕获 ---------- */
  function install(win) {
    if (installed) return;
    installed = true;
    var w = win || (typeof window !== 'undefined' ? window : null);
    var b = load();
    b.sessions++;
    persist();
    /* Node 里跑测试时 window 是个空对象，没有 addEventListener —— 直接返回，
       不要为了"装上捕获器"把测试进程搞崩。 */
    if (!w || typeof w.addEventListener !== 'function') return;

    w.addEventListener('error', function (ev) {
      /* 资源加载失败（script/img）也走这里，但没有 message —— 单独归一类，
         因为「KaTeX CDN 挂了」和「JS 抛异常」是完全不同的两件事。 */
      if (ev && ev.target && ev.target !== w && ev.target.tagName) {
        error('resource', ev.target.tagName + ' 加载失败：' + (ev.target.src || ev.target.href || ''));
        return;
      }
      var msg = ev && ev.message ? ev.message : '未知错误';
      var where = ev && ev.filename ? ev.filename + ':' + ev.lineno + ':' + ev.colno : '';
      error('js', msg + (where ? ' @ ' + where : ''), ev && ev.error && ev.error.stack);
    });

    w.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      var msg = r && r.message ? r.message : String(r == null ? '未知 Promise 拒绝' : r);
      error('promise', msg, r && r.stack);
    });
  }

  /* ---------- 诊断包 ---------- */
  /* 环境摘要。只含环境与计数，不含任何用户内容。 */
  function environment(state, extra) {
    var nav = (typeof navigator !== 'undefined' && navigator) || {};
    var sc = (typeof screen !== 'undefined' && screen) || {};
    var out = {
      生成时间: new Date().toISOString(),
      应用版本: (extra && extra.version) || '1.0',
      存档格式: (extra && extra.schema) || null,
      聚合版本: (extra && extra.statsV) || null,
      页面协议: (typeof location !== 'undefined' && location.protocol) || '',
      屏幕: sc.width ? sc.width + 'x' + sc.height : '',
      视口: (typeof innerWidth !== 'undefined') ? innerWidth + 'x' + innerHeight : '',
      语言: nav.language || '',
      用户代理: String(nav.userAgent || '').slice(0, 160),
      存储可用: (extra && typeof extra.storageOk === 'boolean') ? extra.storageOk : null,
      公式渲染器: (extra && typeof extra.katexOk === 'boolean') ? extra.katexOk : null,
      会话次数: load().sessions
    };
    if (extra && extra.usage) {
      out.存档KB = extra.usage.kb;
      out.明细条数 = extra.usage.attempts;
      out.累计作答 = extra.usage.totalAttempts;
      out.覆盖天数 = extra.usage.days;
    }
    return out;
  }

  /* 事件名计数。诊断包里给计数而不是逐条流水 —— 流水里可能带题目 id 之类的东西。 */
  function eventCounts() {
    var b = load();
    var out = {};
    b.events.forEach(function (e) { out[e.n] = (out[e.n] || 0) + 1; });
    return out;
  }

  function report(state, extra) {
    var lines = [];
    lines.push('===== 研数 · 诊断信息 =====');
    lines.push('（此文件只含环境信息、计数与错误消息，不含 API Key / 聊天记录 / 笔记 / 题目内容）');
    lines.push('');
    lines.push('--- 环境 ---');
    var env = environment(state, extra);
    Object.keys(env).forEach(function (k) { lines.push(k + ': ' + env[k]); });
    lines.push('');
    lines.push('--- 事件计数 ---');
    var ec = eventCounts();
    var ekeys = Object.keys(ec).sort(function (a, b) { return ec[b] - ec[a]; });
    if (!ekeys.length) lines.push('（无）');
    ekeys.forEach(function (k) { lines.push(k + ': ' + ec[k]); });
    lines.push('');
    lines.push('--- 错误（' + errorList().length + ' 类）---');
    var errs = errorList();
    if (!errs.length) lines.push('（无）');
    errs.forEach(function (e) {
      lines.push('[' + e.kind + '] x' + e.count + '  ' + e.msg);
      lines.push('    首次 ' + new Date(e.first).toISOString() + ' / 最近 ' + new Date(e.last).toISOString());
      if (e.stack) lines.push('    ' + e.stack.split('\n').slice(0, 4).join('\n    '));
    });
    return lines.join('\n');
  }

  function recentEvents(n) {
    var b = load();
    return b.events.slice(Math.max(0, b.events.length - (n || 30))).reverse();
  }

  function clear() {
    buf = blank();
    try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
  }

  window.Telemetry = {
    V: V, CAP_EVENTS: CAP_EVENTS, CAP_ERRORS: CAP_ERRORS,
    /* 预留的上报地址。留空 = 纯本地，什么都不发。 */
    endpoint: '',

    install: install,
    event: event,
    error: error,
    errors: errorList,
    recentEvents: recentEvents,
    environment: environment,
    eventCounts: eventCounts,
    report: report,
    clear: clear,

    _flush: function () { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } try { localStorage.setItem(KEY, JSON.stringify(load())); } catch (e) { } },
    _reset: function () { buf = null; installed = false; }
  };
})();
