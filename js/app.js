/* 研数 · 考研数学 AI 自学系统 —— 主应用
 * 本地存储 + Hash 路由，file:// 直接打开可用；可选接入 OpenAI 兼容 LLM。
 */
(function () {
  'use strict';

  var App = {}; // 暴露给内联事件的全局接口

  /* ============ 工具 ============ */
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad2(n) { return ('0' + n).slice(-2); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function addDaysStr(baseStr, n) {
    var p = baseStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function isBefore(a, b) { return a <= b; } // 日期字符串可直接比较
  function isEqual(a, b) { return a === b; }
  function rand(n) { return Math.floor(Math.random() * n); }
  function daysUntilExam() {
    var ed = state.settings.examDate;
    if (!ed) return null;
    var t = todayStr();
    if (ed < t) return 0;
    var d1 = new Date(t), d2 = new Date(ed);
    return Math.max(0, Math.ceil((d2 - d1) / 864e5));
  }
  function recommendedDailyNew() {
    var days = daysUntilExam();
    if (days === null) return state.settings.dailyNew;
    if (days <= 0) return 6;
    var remain = flatNodes().filter(function (n) { return !state.cards[n.id]; }).length;
    if (!remain) return state.settings.dailyNew;
    return Math.max(1, Math.min(6, Math.ceil(remain / days)));
  }
  function getFolded() {
    if (!state.foldedChapters) state.foldedChapters = {};
    return state.foldedChapters;
  }
  function toggleFold(chid) {
    var f = getFolded();
    f[chid] = !f[chid];
    save();
  }
  function shuffle(a) {
    var arr = a.slice(), i, j, t;
    for (i = arr.length - 1; i > 0; i--) { j = rand(i + 1); t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  function toast(msg, type) {
    var root = $('#toast-root');
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
    setTimeout(function () { el.remove(); }, 2600);
  }
  function confirmDialog(msg) { return window.confirm(msg); }

  /* ============ 数学渲染（KaTeX CDN，失败则降级原文） ============ */
  function katexOK() { return typeof window.katex !== 'undefined' && window.katex.renderToString; }
  function renderFormula(tex, display) {
    if (katexOK()) {
      try {
        return window.katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: false });
      } catch (e) { /* fallthrough */ }
    }
    return '<span class="mock-formula">' + esc(tex) + '</span>';
  }
  // 数据中的公式常是裸 LaTeX 源码（无 $ 包裹），自动为数学片段包裹 $ 以触发 KaTeX
  var TEX_CMD = /[a-zA-Z]/;
  var FRAG_STOP = /[\u4e00-\u9fff，。；：、！？「」【】（）《》〈〉\s·…]/; // 片段边界：中文、中文标点、全角括号、空白、点号
  function autoLatex(s) {
    if (!s) return s;
    var out = '', i = 0, n = s.length;
    while (i < n) {
      var c = s[i];
      // 分支0：\begin{env} ... \end{env} 环境块整体包裹（矩阵/cases/对齐等，含 & 与 \\ 不被截断）
      if (c === '\\' && s.slice(i, i + 7) === '\\begin{' ) {
        var envM = s.slice(i).match(/\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\}/);
        if (envM) {
          out += '$' + envM[0] + '$';
          i += envM[0].length;
          continue;
        }
      }
      // 分支1：\command 起头 → 吸收命令+参数+空格后接命令（已验证正确）
      if (c === '\\' && i + 1 < n && TEX_CMD.test(s[i + 1])) {
        var j = i + 1;
        while (j < n && TEX_CMD.test(s[j])) j++;
        while (j < n) {
          var ch = s[j];
          if (ch === '{' || ch === '[') {
            var close = ch === '{' ? '}' : ']', depth = 1;
            for (j++; j < n && depth > 0; j++) {
              if (s[j] === ch) depth++;
              else if (s[j] === close) depth--;
            }
          } else if (ch === '_' || ch === '^') {
            j++;
            if (j < n && s[j] === '{') {
              var depth = 1;
              for (j++; j < n && depth > 0; j++) {
                if (s[j] === '{') depth++;
                else if (s[j] === '}') depth--;
              }
            } else {
              while (j < n && /[A-Za-z0-9\\]/.test(s[j])) {
                if (s[j] === '\\') { j++; while (j < n && TEX_CMD.test(s[j])) j++; }
                else j++;
              }
            }
          } else if (ch === ' ' && j + 1 < n && (s[j + 1] === '\\' || s[j + 1] === '^' || s[j + 1] === '_' || (j + 2 < n && s[j + 1] === '{'))) {
            // 公式内空格：空格后紧跟 \command / ^ / _ / { 视为继续
            var after = s[j + 1];
            if (after === '\\' && j + 2 < n && TEX_CMD.test(s[j + 2])) { j += 2; while (j < n && TEX_CMD.test(s[j])) j++; }
            else if (after === '{') { j++; }
            else j++;
          } else if (ch === '\\' && j + 1 < n && TEX_CMD.test(s[j + 1])) {
            j++;
            while (j < n && TEX_CMD.test(s[j])) j++;
          } else if (ch === '\'' || ch === '′' || ch === '，' || ch === ',' || ch === '!' || ch === '!' || ch === '%') {
            j++; // 撇号（导数）、逗号可吸收，避免 e^{x}'' 被切断
          } else if (/[A-Za-z0-9\xc0-\xff\u0391-\u03c9().+\-*/=|<>·]/.test(ch)) {
            j++;
          } else {
            break;
          }
        }
        out += '$' + s.slice(i, j) + '$';
        i = j;
        continue;
      }
      // 分支2：独立的 ^ / _（裸上下标，如 x^{2}、X_1）→ 向左右扩展成连续碎片包裹
      if (c === '^' || c === '_') {
        var st = i;
        while (st > 0 && !FRAG_STOP.test(s[st - 1])) st--;
        // 回退 out 中已输出的 [st, i) 前缀字符，避免重复
        out = out.slice(0, out.length - (i - st));
        var en = i + 1;
        while (en < n && !FRAG_STOP.test(s[en])) en++;
        var frag = s.slice(st, en);
        // 去掉尾随的孤立逗号/括号（避免把 "，" 或 ")" 包进公式影响闭合）
        frag = frag.replace(/[,，]+$/, '');
        if (frag) {
          out += '$' + frag + '$';
          i = st + frag.length;
          continue;
        }
      }
      out += c;
      i++;
    }
    return out;
  }
  /* 轻量 markdown：**加粗**、$行内公式$、$$块级公式$$、- 列表、空行分段 */
  function md(text) {
    var s = String(text == null ? '' : text);
    var out = '';
    var blocks = s.split(/\$\$([\s\S]+?)\$\$/g);
    for (var i = 0; i < blocks.length; i++) {
      if (i % 2 === 1) {
        out += '<div class="katex-display">' + renderFormula(blocks[i], true) + '</div>';
      } else {
        out += inlineBlock(autoLatex(blocks[i]));
      }
    }
    // 分段
    var paras = out.split(/\n{2,}/);
    var html = paras.map(function (para) {
      var lines = para.split('\n');
      var str = '', ul = null;
      lines.forEach(function (l) {
        var m = l.match(/^\s*[-*]\s+(.+)/);
        if (m) {
          if (!ul) ul = '<ul style="padding-left:20px;margin:.3em 0">';
          ul += '<li>' + m[1] + '</li>';
        } else {
          if (ul) { str += ul + '</ul>'; ul = null; }
          str += l;
        }
      });
      if (ul) str += ul + '</ul>';
      return '<p>' + str.replace(/\n/g, '<br/>') + '</p>';
    }).join('');
    return html;
  }
  function inlineBlock(s) {
    var parts = s.split(/\$([^$\n]+?)\$/g);
    var o = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        o += renderFormula(parts[i], false);
      } else {
        o += esc(parts[i]).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      }
    }
    return o;
  }

  /* ============ 数据索引 ============ */
  var CATS = KDATA.categories;
  var NODE = {};
  var kidOfQ = {};
  CATS.forEach(function (cat) {
    cat.chapters.forEach(function (ch) {
      ch.nodes.forEach(function (n) { NODE[n.id] = n; });
    });
  });
  QDATA.forEach(function (q) { (kidOfQ[q.kid] = kidOfQ[q.kid] || []).push(q); });

  function trackPrefix() {
    var t = state.settings.examTrack || 'math1';
    return t === 'math1' ? 'm1' : t === 'math2' ? 'm2' : 'm3';
  }
  function nodeInTrack(n) {
    if (!n.exam) return true;
    if (n.exam === 'all') return true;
    var p = trackPrefix();
    return n.exam.indexOf(p) >= 0;
  }
  function flatNodes() {
    var arr = [];
    CATS.forEach(function (cat) {
      cat.chapters.forEach(function (ch) {
        ch.nodes.forEach(function (n) { if (nodeInTrack(n)) arr.push(n); });
      });
    });
    return arr;
  }
  function quesInTrack() {
    return QDATA.filter(function (q) { var n = NODE[q.kid]; return n && nodeInTrack(n); });
  }
  /* 来源徽章：经典例题 / 真题改编 / 模拟题（自定义导入题无 source 则不显示） */
  function srcBadge(q) {
    if (!q || !q.sourceType) return '';
    var icon = q.sourceType === '经典例题' ? '📘' : q.sourceType === '真题改编' ? '🎯' : '✍️';
    var year = q.sourceYear ? ' ' + q.sourceYear : '';
    return '<span class="src-badge st-' + (q.sourceType === '经典例题' ? 'classic' : q.sourceType === '真题改编' ? 'real' : 'mock') + '" title="' + esc(q.sourceType + (q.sourceYear ? '（' + q.sourceYear + '）' : '')) + '">' + icon + ' ' + esc(q.sourceType) + year + '</span>';
  }
  function chapOf(node) {
    for (var i = 0; i < CATS.length; i++) {
      for (var j = 0; j < CATS[i].chapters.length; j++) {
        var c = CATS[i].chapters[j];
        if (c.nodes.some(function (x) { return x.id === node.id; })) return { cat: CATS[i], ch: c };
      }
    }
    return null;
  }

  /* ============ 存储 ============ */
  var DB_KEY = 'kaoyan_math_tutor_v1';
  var sessionLLMKey = '';
  var defaults = {
    cards: {}, attempts: [], checkins: {}, daily: null, customQ: [], notes: {}, discussions: {},
    settings: {
      examTrack: 'math1', dailyNew: 2, examDate: '', persona: 'strict',
      llm: {
        enabled: false, kind: 'local',
        base: '', model: '',
        localBase: 'http://127.0.0.1:1234/v1', localModel: '', localName: '',
        cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat'
      }
    },
    chats: {}
  };
  var state;
  function load() {
    try {
      var raw = localStorage.getItem(DB_KEY);
      if (!raw) return JSON.parse(JSON.stringify(defaults));
      var d = JSON.parse(raw);
      // 合并默认
      var base = JSON.parse(JSON.stringify(defaults));
      for (var k in d) { if (d.hasOwnProperty(k)) base[k] = d[k]; }
      if (!base.settings) base.settings = JSON.parse(JSON.stringify(defaults.settings));
      if (!base.settings.llm) base.settings.llm = JSON.parse(JSON.stringify(defaults.settings.llm));
      if (!base.settings.persona) base.settings.persona = 'strict';
      if (!base.notes) base.notes = {};
      if (!base.discussions) base.discussions = {};
      // 旧版只有单一 base/model，这里迁移成 本地/云端 双通道
      var L = base.settings.llm;
      if (!L.localBase) L.localBase = 'http://127.0.0.1:1234/v1';
      if (!L.cloudBase) L.cloudBase = 'https://api.deepseek.com';
      if (!L.cloudModel) L.cloudModel = 'deepseek-chat';
      if (!L.kind) L.kind = (L.base && !/127\.0\.0\.1|localhost/i.test(L.base)) ? 'cloud' : 'local';
      if (L.kind === 'cloud' && L.base && !/127\.0\.0\.1|localhost/i.test(L.base)) L.cloudBase = L.base;
      if (L.kind === 'cloud' && L.model) L.cloudModel = L.model;
      if (!L.localModel) L.localModel = '';
      L.base = L.kind === 'cloud' ? L.cloudBase : L.localBase;
      L.model = L.kind === 'cloud' ? L.cloudModel : L.localModel;
      if (!base.settings.examTrack) base.settings.examTrack = 'math1';
      if (!base.settings.dailyNew) base.settings.dailyNew = 2;
      return base;
    } catch (e) { return JSON.parse(JSON.stringify(defaults)); }
  }
  function save() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(state)); } catch (e) { /* 存储满等异常忽略 */ }
  }

  /* ============ 卡片与作答 ============ */
  function dueCards() {
    var t = todayStr();
    return Object.keys(state.cards).map(function (id) { return state.cards[id]; })
      .filter(function (c) { return c.due <= t; })
      .sort(function (a, b) {
        if (a.type !== b.type) return a.type === 'mistake' ? -1 : 1;
        return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      });
  }
  function addAttempt(q, userAns, correct, context) {
    state.attempts.push({
      id: 'a' + Date.now().toString(36) + rand(1e6).toString(36),
      qid: q.id, kid: q.kid, answer: String(userAns == null ? '' : userAns),
      correct: !!correct, context: context || 'practice', date: todayStr(), ts: Date.now()
    });
    if (!correct) ensureMistakeCard(q);
    save();
    refreshBadges();
  }
  function ensureMistakeCard(q) {
    var found = Object.keys(state.cards).some(function (id) { return state.cards[id].questionId === q.id; });
    var t = todayStr();
    if (found) {
      Object.keys(state.cards).forEach(function (id) {
        var c = state.cards[id];
        if (c.questionId === q.id) { c.due = t; c.lapses = (c.lapses || 0) + 1; c.interval = 1; c.reps = 0; }
      });
    } else {
      var card = SM2.newCard(q.kid, q.id, 'mistake');
      card.due = t; // 错题明天再见（今天立刻出现在复习列表）
      state.cards[card.id] = card;
    }
    save();
  }
  function markLearned(kid) {
    if (!state.cards[kid]) state.cards[kid] = SM2.newCard(kid, null, 'knowledge');
    var d = state.daily;
    if (d && d.date === todayStr() && d.newIds.indexOf(kid) >= 0 && d.newDoneIds.indexOf(kid) < 0) {
      d.newDoneIds.push(kid);
      save();
      checkDailyAllDone();
    }
    refreshBadges();
  }
  function gradeReview(cardId, rating) {
    var c = state.cards[cardId];
    if (!c) return;
    var up = SM2.grade(c, rating);
    for (var k in up) c[k] = up[k];
    var d = state.daily;
    if (d && d.date === todayStr() && d.reviewIds.indexOf(cardId) >= 0 && d.reviewDoneIds.indexOf(cardId) < 0) {
      d.reviewDoneIds.push(cardId);
    }
    save();
    checkDailyAllDone();
    refreshBadges();
  }
  function nodeStatus(kid) {
    if (state.cards[kid]) return 'mastered';
    var has = state.attempts.some(function (a) { return a.kid === kid; });
    return has ? 'learning' : 'new';
  }
  function correctRateOf(kid, n) {
    var arr = state.attempts.filter(function (a) { return a.kid === kid; });
    if (n) arr = arr.slice(-n);
    if (!arr.length) return null;
    return arr.filter(function (a) { return a.correct; }).length / arr.length;
  }

  /* ============ 每日任务引擎 ============ */
  function nextNewNodes(k) {
    var learned = {};
    Object.keys(state.cards).forEach(function (id) { var c = state.cards[id]; if (c.knowledgeId) learned[c.knowledgeId] = 1; });
    state.attempts.forEach(function (a) { learned[a.kid] = 1; });
    var out = [];
    flatNodes().forEach(function (n) {
      if (!learned[n.id] && out.length < k) out.push(n.id);
    });
    return out;
  }
  function pickDailyQuiz(k) {
    var pool = quesInTrack();
    if (!pool.length) return [];
    var scored = pool.map(function (q) {
      var w = 1.5 + Math.random();
      var rate = correctRateOf(q.kid, 10);
      if (rate === null) w += 3;              // 完全没练过的知识点优先
      else w += (1 - rate) * 5;               // 掌握度差优先
      var wrongs = state.attempts.filter(function (a) { return a.kid === q.kid && !a.correct; }).length;
      w += Math.min(wrongs * 2, 6);           // 错题多的知识点优先
      return { q: q, w: w };
    });
    scored.sort(function (a, b) { return b.w - a.w; });
    var hot = scored.slice(0, Math.min(k, scored.length));
    // 打散顺序，避免每次同题序
    return shuffle(hot.map(function (x) { return x.q.id; }));
  }
  function getOrCreateDaily() {
    var t = todayStr();
    if (state.daily && state.daily.date === t) return state.daily;
    state.daily = {
      date: t,
      reviewIds: dueCards().slice(0, 30).map(function (c) { return c.id; }),
      newIds: nextNewNodes(state.settings.dailyNew || 2),
      quizIds: pickDailyQuiz(5),
      reviewDoneIds: [], newDoneIds: [], quizDoneIds: []
    };
    save();
    return state.daily;
  }
  function dailyProgress() {
    var d = getOrCreateDaily();
    var reviewAll = !d.reviewIds.length || d.reviewIds.every(function (id) { return d.reviewDoneIds.indexOf(id) >= 0; });
    var quizAll = !d.quizIds.length || d.quizIds.every(function (id) { return d.quizDoneIds.indexOf(id) >= 0; });
    var newAll = !d.newIds.length || d.newIds.every(function (id) { return d.newDoneIds.indexOf(id) >= 0; });
    d.reviewAll = reviewAll; d.quizAll = quizAll; d.newAll = newAll;
    return d;
  }
  function checkDailyAllDone() {
    var d = dailyProgress();
    var c = state.checkins[todayStr()] = state.checkins[todayStr()] || { minutes: 0, tasksDone: false };
    if (d.reviewAll && d.quizAll && d.newAll && !c.tasksDone) {
      c.tasksDone = true;
      save();
      toast('今日任务全部完成，打卡成功！', 'ok');
      refreshBadges();
    }
  }
  function checkinOK(date) {
    var c = state.checkins[date];
    return !!c && (c.tasksDone || (c.minutes || 0) >= 30);
  }
  function calcStreak() {
    var t = todayStr(), s = 0;
    if (!checkinOK(t)) t = addDaysStr(t, -1);
    while (checkinOK(t)) { s++; t = addDaysStr(t, -1); if (s > 9999) break; }
    return s;
  }

  /* ============ 专注计时器 ============ */
  var timer = { running: false, seconds: 0 };
  var timerEl = null;
  function tickTimer() {
    if (!timer.running) return;
    timer.seconds++;
    if (timer.seconds % 60 === 0) {
      var t = todayStr();
      var c = state.checkins[t] = state.checkins[t] || { minutes: 0, tasksDone: false };
      c.minutes = (c.minutes || 0) + 1;
      save();
      if (c.minutes >= 30 && !c.tasksDone) {
        checkDailyAllDone();
        toast('已专注 30 分钟，今日打卡达成！', 'ok');
      }
      refreshBadges();
    }
    var mm = Math.floor(timer.seconds / 60), ss = timer.seconds % 60;
    if (timerEl) timerEl.textContent = pad2(mm) + ':' + pad2(ss);
  }
  setInterval(tickTimer, 1000);

  /* ============ 侧边栏 ============ */
  function refreshBadges() {
    var dueN = dueCards().length;
    var db = $('#nav-due-badge'), rb = $('#nav-review-badge');
    if (db) { db.textContent = dueN; db.hidden = dueN === 0; }
    if (rb) { rb.textContent = dueN; rb.hidden = dueN === 0; }
    var mis = mistakeList().length;
    var mb = $('#nav-mistake-badge');
    if (mb) { mb.textContent = mis; mb.hidden = mis === 0; }
    var st = $('#side-streak');
    if (st) st.textContent = calcStreak();
    var tip = $('#side-tip');
    if (tip) {
      var d = dailyProgress();
      var remain = (d.reviewIds.length - d.reviewDoneIds.length) + (d.quizIds.length - d.quizDoneIds.length) + (d.newIds.length - d.newDoneIds.length);
      tip.textContent = remain > 0 ? '今日还有 ' + remain + ' 项任务待完成。' : '今日任务已清空，明天见！';
    }
  }
  function setActiveNav(h) {
    var seg = h.split('/')[1] || '';
    $$('.nav-item').forEach(function (a) { a.classList.remove('active'); });
    var map = { '': '/', learn: '/learn', quiz: '/quiz', review: '/review', mistakes: '/mistakes', stats: '/stats', settings: '/settings' };
    var target = map[seg];
    if (!target) target = seg === 'learn' ? '/learn' : '/';
    $$('.nav-item').forEach(function (a) {
      if (a.getAttribute('data-route') === target) a.classList.add('active');
    });
  }

  /* ============ 错题本 ============ */
  function mistakeList() {
    var seen = {}, out = [];
    state.attempts.slice().reverse().forEach(function (a) {
      if (seen[a.qid]) return;
      seen[a.qid] = 1;
      if (!a.correct) out.push(a);
    });
    return out;
  }

  /* ============ 图表 ============ */
  function svgHeatmap() {
    var cells = [];
    var end = new Date();
    var start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 181);
    var day = new Date(start);
    var weeks = [];
    var cur = [];
    for (;;) {
      var ds = day.getFullYear() + '-' + pad2(day.getMonth() + 1) + '-' + pad2(day.getDate());
      var c = state.checkins[ds];
      var min = c ? (c.minutes || 0) : 0;
      var lv = min <= 0 ? 0 : min < 15 ? 1 : min < 30 ? 2 : min < 60 ? 3 : 4;
      cur.push({ ds: ds, lv: lv });
      if (day.getDay() === 6 || ds === todayStr()) { weeks.push(cur); cur = []; }
      if (ds === todayStr()) break;
      day.setDate(day.getDate() + 1);
    }
    var table = weeks.map(function (w, wi) {
      return '<div class="heat-row">' + w.map(function (cell) {
        return '<div class="heat-cell heat-l' + cell.lv + '" title="' + cell.ds + ' 学习 ' + (cell.lv ? state.checkins[cell.ds].minutes + ' 分钟' : '未学习') + '"></div>';
      }).join('') + '</div>';
    }).join('');
    return '<div class="heat">' + table + '</div><div class="heat-meta">最近 26 周 <span class="legend" style="float:right">少 <span class="heat-cell heat-l0" style="display:inline-block"></span><span class="heat-cell heat-l1" style="display:inline-block"></span><span class="heat-cell heat-l2" style="display:inline-block"></span><span class="heat-cell heat-l3" style="display:inline-block"></span><span class="heat-cell heat-l4" style="display:inline-block"></span> 多</span></div>';
  }
  function svgTrend() {
    var days = [], d = new Date();
    for (var i = 13; i >= 0; i--) {
      var dd = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
      days.push(dd.getFullYear() + '-' + pad2(dd.getMonth() + 1) + '-' + pad2(dd.getDate()));
    }
    var pts = days.map(function (ds) {
      var arr = state.attempts.filter(function (a) { return a.date === ds; });
      if (!arr.length) return null;
      return arr.filter(function (a) { return a.correct; }).length / arr.length;
    });
    var W = 640, H = 160, P = 18;
    var maxX = 13;
    var poly = '', dots = '', labels = '';
    pts.forEach(function (p, i) {
      var x = P + (W - 2 * P) * i / maxX;
      if (p === null) { labels += '<text x="' + x + '" y="' + (H - 8) + '" font-size="9" fill="#8b93a7" text-anchor="middle">' + days[i].slice(5) + '</text>'; return; }
      var y = H - P - (H - 2 * P) * p;
      poly += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="#3b5bdb"/>';
      labels += '<text x="' + x + '" y="' + (H - 8) + '" font-size="9" fill="#8b93a7" text-anchor="middle">' + days[i].slice(5) + '</text>';
    });
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gy = P + (H - 2 * P) * g / 4;
      grid += '<line x1="' + P + '" y1="' + gy + '" x2="' + (W - P) + '" y2="' + gy + '" stroke="#eef0f6" stroke-width="1"/>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%">' + grid +
      '<path d="' + poly + '" fill="none" stroke="#3b5bdb" stroke-width="2.5" stroke-linecap="round"/>' +
      dots + labels + '</svg>';
  }
  function svgRadar() {
    var cats = CATS.map(function (c) {
      var qs = QDATA.filter(function (q) { var n = NODE[q.kid]; return n && n.category === c.id && nodeInTrack(n); });
      var ids = {};
      qs.forEach(function (q) { ids[q.kid] = 1; });
      var rates = Object.keys(ids).map(function (kid) { return correctRateOf(kid, 10); }).filter(function (x) { return x !== null; });
      var v = rates.length ? rates.reduce(function (a, b) { return a + b; }, 0) / rates.length : 0;
      return { name: c.name, v: v, qCount: qs.length };
    });
    var cx = 130, cy = 110, R = 72;
    var n = cats.length;
    function pt(i, r) {
      var ang = -Math.PI / 2 + i * 2 * Math.PI / n;
      return (cx + r * Math.cos(ang)).toFixed(1) + ',' + (cy + r * Math.sin(ang)).toFixed(1);
    }
    var gridSvg = '', labels = '';
    for (var g = 1; g <= 4; g++) {
      var rr = R * g / 4;
      var p = [];
      for (var i = 0; i < n; i++) p.push(pt(i, rr));
      gridSvg += '<polygon points="' + p.join(' ') + '" fill="none" stroke="#e6e9f2" stroke-width="1"/>';
    }
    var pp = [];
    cats.forEach(function (c, i) {
      pp.push(pt(i, R * c.v));
      var xy = pt(i, R + 22);
      labels += '<text x="' + xy.split(',')[0] + '" y="' + xy.split(',')[1] + '" font-size="12" fill="#5a6478" text-anchor="middle">' + c.name + '</text>';
      var pv = pt(i, R * c.v);
      labels += '<text x="' + pv.split(',')[0] + '" y="' + (+pv.split(',')[1] - 6) + '" font-size="11" fill="#3b5bdb" font-weight="700" text-anchor="middle">' + Math.round(c.v * 100) + '%</text>';
    });
    return '<svg viewBox="0 0 260 240" style="width:100%;max-width:300px">' + gridSvg +
      '<polygon points="' + pp.join(' ') + '" fill="rgba(59,91,219,.18)" stroke="#3b5bdb" stroke-width="2"/>' + labels + '</svg>';
  }
  function chapterBars() {
    var html = '';
    CATS.forEach(function (cat) {
      cat.chapters.forEach(function (ch) {
        var inTrack = ch.nodes.filter(nodeInTrack);
        if (!inTrack.length) return;
        var kids = {};
        inTrack.forEach(function (n) { kids[n.id] = 1; });
        var arr = state.attempts.filter(function (a) { return kids[a.kid]; });
        var rate = arr.length ? arr.filter(function (a) { return a.correct; }).length / arr.length : null;
        var pct = rate === null ? 0 : Math.round(rate * 100);
        html += '<div class="bar-row"><span class="bar-name">' + esc(ch.name) + '</span>' +
          '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
          '<span class="bar-val">' + (rate === null ? '—' : pct + '%') + '</span></div>';
      });
    });
    return html;
  }
  function todayCorrect() {
    var arr = state.attempts.filter(function (a) { return a.date === todayStr(); });
    if (!arr.length) return null;
    return Math.round(arr.filter(function (a) { return a.correct; }).length / arr.length * 100);
  }

  /* ============ 页面渲染 ============ */
  function head(title, sub, actions) {
    return '<div class="page-head"><div><div class="page-title">' + title + '</div>' +
      (sub ? '<div class="page-sub">' + sub + '</div>' : '') + '</div>' +
      (actions ? '<div class="page-actions">' + actions + '</div>' : '') + '</div>';
  }

  /* ----- 仪表盘 ----- */
  function pageDashboard() {
    var d = dailyProgress();
    var t = todayStr();
    var c = state.checkins[t] = state.checkins[t] || { minutes: 0, tasksDone: false };
    var done = c.tasksDone || (c.minutes || 0) >= 30;
    var tc = todayCorrect();

    var reviewHtml = d.reviewIds.length ? d.reviewIds.map(function (cid, i) {
      var card = state.cards[cid];
      var isDone = d.reviewDoneIds.indexOf(cid) >= 0;
      var label = card.type === 'mistake' && card.questionId
        ? '错题复盘：' + NODE[card.knowledgeId].title
        : '知识点复习：' + NODE[card.knowledgeId].title;
      return '<div class="task-item' + (isDone ? ' done' : '') + '"><span class="tick">✓</span>' +
        '<span class="tt"><span class="tag review">复习</span> ' + esc(label) + '</span>' +
        (isDone ? '<span class="go">已完成</span>' : '<a class="go" href="#/review">去复习 →</a>') + '</div>';
    }).join('') : '<div style="color:var(--ink-3);font-size:13px;padding:6px 2px">今天没有到期的复习卡，休息一下或学点新的。</div>';

    var newHtml = d.newIds.length ? d.newIds.map(function (kid, i) {
      var n = NODE[kid];
      var isDone = d.newDoneIds.indexOf(kid) >= 0;
      return '<div class="task-item' + (isDone ? ' done' : '') + '"><span class="tick">✓</span>' +
        '<span class="tt"><span class="tag new">新学</span> ' + esc(n.title) + '<div class="tt-sub">' + esc((chapOf(n) || {}).ch.name || '') + '</div></span>' +
        (isDone ? '<span class="go">已学会</span>' : '<a class="go" href="#/learn/' + kid + '">开始学习 →</a>') + '</div>';
    }).join('') : '<div style="color:var(--ink-3);font-size:13px;padding:6px 2px">知识树的内容都学完啦！去统计页看看战绩。</div>';

    var quizHtml = d.quizIds.length ? d.quizIds.map(function (qid, i) {
      var q = QDATA.filter(function (x) { return x.id === qid; })[0];
      var isDone = d.quizDoneIds.indexOf(qid) >= 0;
      return '<div class="task-item' + (isDone ? ' done' : '') + '"><span class="tick">✓</span>' +
        '<span class="tt"><span class="tag quiz">一练</span> <span class="stem-preview">' + md(q.stem || '') + '</span></span>' +
        (isDone ? '<span class="go">已作答</span>' : '<a class="go" href="#/quiz">去做题 →</a>') + '</div>';
    }).join('') : '<div style="color:var(--ink-3);font-size:13px;padding:6px 2px">题库为空，稍后再来看看。</div>';

    var remain = (d.reviewIds.length - d.reviewDoneIds.length) + (d.quizIds.length - d.quizDoneIds.length) + (d.newIds.length - d.newDoneIds.length);
    var learnedCount = flatNodes().filter(function (n) { return state.cards[n.id]; }).length;
    var totalInTrack = flatNodes().length;

    var box = $('#main');
    var daysLeft = daysUntilExam();
    var recNew = recommendedDailyNew();
    var examBanner = '';
    if (daysLeft !== null) {
      var remainNodes = flatNodes().filter(function (n) { return !state.cards[n.id]; }).length;
      var needDays = Math.ceil(remainNodes / Math.max(1, recNew));
      var behind = needDays > daysLeft;
      examBanner = '<div class="banner exam' + (behind ? ' warn' : '') + '">' +
        (daysLeft === 0 ? '⏰ 考试就是今天！' : '⏰ 距考试还有 <b>' + daysLeft + '</b> 天 · 还剩 ' + remainNodes + ' 个知识点 · 建议每天新学 <b>' + recNew + '</b> 个' + (behind ? ' · ⚠️ 按当前速度无法在考前学完！' : '')) +
        '</div>';
    }
    box.innerHTML = head('仪表盘', '考研数学 · ' + (state.settings.examTrack === 'math1' ? '数学一' : state.settings.examTrack === 'math2' ? '数学二' : '数学三') + (state.settings.examDate ? ' · 目标考试 ' + state.settings.examDate : '') + (daysLeft !== null ? ' · 建议每日新学 ' + recNew + ' 个' : '')) +
      examBanner +
      (done
        ? '<div class="banner">🎉 今日已打卡：' + (c.tasksDone ? '任务全部完成' : '专注 ' + (c.minutes || 0) + ' 分钟') + '。连续学习 ' + calcStreak() + ' 天。保持节奏！</div>'
        : '<div class="banner warn">今日任务还剩 <b>' + remain + '</b> 项（复习 ' + (d.reviewIds.length - d.reviewDoneIds.length) +
        ' · 新学 ' + (d.newIds.length - d.newDoneIds.length) + ' · 一练 ' + (d.quizIds.length - d.quizDoneIds.length) + '）。完成任务或专注 30 分钟即可打卡。</div>') +
      '<div class="grid-4">' +
      statBox('连续打卡', calcStreak() + ' 天', '今天' + (checkinOK(t) ? '已' : '未') + '打卡', 'accent') +
      statBox('已学知识点', learnedCount + ' / ' + totalInTrack, '按当前考试范围' + (totalInTrack ? ' · ' + Math.round(learnedCount / totalInTrack * 100) + '%' : ''), '') +
      statBox('待复习卡', dueCards().length + ' 张', '到期卡片与错题', '') +
      statBox('今日正确率', tc === null ? '—' : tc + '%', tc === null ? '今日暂未答题' : '已答 ' + state.attempts.filter(function (a) { return a.date === t; }).length + ' 题', '') +
      '</div>' +
      '<div class="grid-2 mt16">' +
      '<div class="card"><div class="card-title">今日任务单 <span class="sub">' + (remain > 0 ? '还剩 ' + remain + ' 项' : '全部完成 ✓') + '</span></div>' +
        '<div class="task-group"><div class="task-group-label">📥 到期复习（' + d.reviewIds.length + '）</div>' + reviewHtml + '</div>' +
        '<div class="task-group"><div class="task-group-label">📚 新知识点（' + d.newIds.length + '）</div>' + newHtml + '</div>' +
        '<div class="task-group"><div class="task-group-label">✍️ 每日一练（' + d.quizIds.length + ' 题）</div>' + quizHtml + '</div>' +
      '</div>' +
      '<div>' +
        '<div class="card"><div class="card-title">专注计时 <span class="sub">今日 ' + (c.minutes || 0) + ' 分钟</span></div>' +
          '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">' +
          '<div id="timer-display" style="font-size:38px;font-weight:800;font-family:var(--mono);color:var(--brand);letter-spacing:1px">00:00</div>' +
          '<div style="display:flex;gap:8px"><button class="btn primary" onclick="App.toggleTimer()" id="timer-btn">开始专注</button>' +
          '<button class="btn" onclick="App.resetTimer()">清零</button></div>' +
          '<div style="font-size:12.5px;color:var(--ink-3)">专注累计 30 分钟自动完成今日打卡；切走页面计时不停，关掉标签页才停止。</div>' +
          '</div></div>' +
        '<div class="card mt16"><div class="card-title">学习热力图 <span class="sub">近 26 周活跃度</span></div>' + svgHeatmap() + '</div>' +
      '</div>' +
      '</div>';
    timerEl = $('#timer-display');
    updateTimerUI();
  }
  function statBox(k, v, sub, cls) {
    return '<div class="stat-box ' + (cls || '') + '"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="d">' + sub + '</div></div>';
  }

  /* ----- 知识树 ----- */
  function pageTree() {
    var html = head('考研数学知识树', '按考试范围过滤：' + (state.settings.examTrack === 'math1' ? '数学一（全量）' : state.settings.examTrack === 'math2' ? '数学二（不含概率、级数、三重积分等）' : '数学三（不含三重积分与曲线曲面积分）'),
      '<a class="btn small" href="#/settings">调整考试范围</a>');
    var folded = getFolded();
    CATS.forEach(function (cat) {
      var chapters = cat.chapters.filter(function (ch) { return ch.nodes.some(nodeInTrack); });
      if (!chapters.length) return;
      html += '<div class="card mt16"><div class="card-title" style="color:' + cat.color + '">' + esc(cat.name) +
        ' <span class="sub">' + chapters.length + ' 章 · ' + chapters.reduce(function (a, c) { return a + c.nodes.filter(nodeInTrack).length; }, 0) + ' 个考点' + '</span></div>';
      chapters.forEach(function (ch) {
        var nodes = ch.nodes.filter(nodeInTrack);
        var mastered = nodes.filter(function (n) { return nodeStatus(n.id) === 'mastered'; }).length;
        var pct = Math.round(mastered / nodes.length * 100);
        var isFold = folded[ch.id];
        if (mastered === nodes.length && folded[ch.id] === undefined) isFold = true;
        html += '<div class="chapter mt12">' +
          '<div class="chapter-head" onclick="App.toggleChapter(\'' + ch.id + '\')">' +
          '<span class="fold-arrow">' + (isFold ? '▶' : '▼') + '</span>' + esc(ch.name) +
          '<span class="ch-progress-wrap"><span class="ch-bar"><i style="width:' + pct + '%"></i></span><span class="ch-pct">' + pct + '%</span></span>' +
          '</div>' +
          '<div class="chapter-body' + (isFold ? ' collapsed' : '') + '">';
        nodes.forEach(function (n) {
          var st = nodeStatus(n.id);
          html += '<a class="knode" href="#/learn/' + n.id + '">' +
            '<span class="st ' + st + '" title="' + (st === 'mastered' ? '已学习' : st === 'learning' ? '学习中' : '未开始') + '"></span>' +
            '<span class="t">' + esc(n.title) + '</span>' +
            '<span class="diff">难度 ' + n.difficulty + '</span>' +
            (n.exam !== 'all' ? '<span class="kw">' + n.exam.map(function (e) { return e === 'm1' ? '数一' : e === 'm2' ? '数二' : '数三'; }).join('/') + '</span>' : '') +
            '</a>';
        });
        html += '</div></div>';
      });
      html += '</div>';
    });
    $('#main').innerHTML = html;
  }
  App.toggleChapter = function (chid) { toggleFold(chid); pageTree(); };

  /* ----- 聊天学习页 ----- */
  function ensureSess(kid) {
    if (!state.chats[kid]) state.chats[kid] = AIEngine.newSession(kid);
    return state.chats[kid];
  }
  function pageLearn(kid) {
    var n = NODE[kid];
    if (!n) { $('#main').innerHTML = head('未找到知识点', '该知识点不存在或不在当前考试范围内') + '<p class="muted">返回 <a href="#/learn">知识树</a></p>'; return; }
    var chap = chapOf(n);
    var sess = ensureSess(kid);
    var stageLabel = sess.stage === 'quiz' ? '验收中' : sess.stage === 'summary' ? '已收尾' : '讲解中';
    var stageCls = sess.stage === 'quiz' ? 'quiz' : sess.stage === 'summary' ? 'summary' : 'explain';
    var related = (n.related || []).map(function (rid) {
      return '<button class="chip" onclick="App.learnNav(\'' + rid + '\')">' + esc((NODE[rid] || {}).title || rid) + '</button>';
    }).join('');

    var html = head('', '', '') +
      '<div class="chat-layout">' +
        '<div class="chat-main">' +
          '<div class="chat-panel">' +
            '<div class="k-header">' +
              '<span class="kh-tag">' + esc(chap.cat.name + ' · ' + chap.ch.name) + '</span>' +
              '<span class="stage-pill ' + stageCls + '" style="float:right">' + stageLabel + '</span>' +
              '<div class="kh-title">' + esc(n.title) + '</div>' +
              '<div class="kh-sub">难度 ' + n.difficulty + ' / 5 · ' + (n.exam === 'all' ? '公共考点' : '仅 ' + n.exam.map(function (e) { return e === 'm1' ? '数一' : e === 'm2' ? '数二' : '数三'; }).join('、')) + '</div>' +
            '</div>' +
            '<div class="msg-area" id="msg-area"></div>' +
            '<div class="quick-row" id="quick-row"></div>' +
            '<div class="input-row">' +
              '<input id="chat-input" placeholder="直接打字追问，或回答上面的题目（填空题在此输入答案）…" autocomplete="off">' +
              '<button onclick="App.sendChat()">发送</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="chat-side">' +
          '<div class="card"><div class="sub-title">阶段状态</div>' +
            '<div class="side-note">' + (sess.stage === 'quiz' ? '验收进行中：答完一道我再出下一道。' : sess.stage === 'summary' ? '本考点已验收完成，卡片已进入复习队列。' : 'AI 老师讲解中：可以追问、举例、出题，准备好了点"我学会了"。') + '</div></div>' +
          '<div class="card"><div class="sub-title">快捷指令</div><div id="quick-btns"></div></div>' +
          '<div class="card"><div class="sub-title">讨论模式</div>' +
            '<div class="side-note">一个老师带三个水平不同的学生，围绕一道你错过的题掰扯一轮，最后老师点名点评。你也可以插话。</div>' +
            '<button class="btn primary" style="width:100%;margin-top:10px" onclick="App.goDiscuss(\'' + esc(kid) + '\')">开一局讨论</button></div>' +
          (related ? '<div class="card"><div class="sub-title">常一起考的知识点</div>' + related + '</div>' : '') +
          '<div class="card"><div class="sub-title">学习贴士</div><div class="side-note">公式用 $\\LaTeX$ 书写；答错的题自动进错题本并出现在明天的复习队列。</div></div>' +
        '</div>' +
      '</div>';
    $('#main').innerHTML = html;

    renderQuickBtns(kid);
    // 渲染历史消息
    var area = $('#msg-area');
    if (!sess.history || !sess.history.length) {
      var first = AIEngine.builtinStart(sess);
      sess.history = [{ role: 'assistant', content: first.text }];
      save();
      appendMsg(area, 'assistant', first.text, null);
    } else {
      sess.history.forEach(function (m) { appendMsg(area, m.role, m.content, m.opts || null); });
    }
    area.scrollTop = area.scrollHeight;
    var inp = $('#chat-input');
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') App.sendChat(); });
  }
  function renderQuickBtns(kid) {
    var hints = AIEngine.builtinHint();
    var box = $('#quick-row');
    box.innerHTML = hints.map(function (h) {
      var cls = h === '我学会了' ? 'quick-btn primary' : 'quick-btn';
      return '<button class="' + cls + '" onclick="App.quickSend(\'' + h.replace(/'/g, '') + '\')">' + esc(h) + '</button>';
    }).join('') + '<span style="margin-left:auto;font-size:11.5px;color:var(--ink-3)" id="llm-indicator"></span>';
    var ind = $('#llm-indicator');
    ind.textContent = llmOn() ? 'AI 老师 · ' + state.settings.llm.model : '内置引擎（未接模型）';
  }
  function appendMsg(area, role, content, opts, streamingId) {
    var div = document.createElement('div');
    div.className = 'msg ' + (role === 'assistant' ? 'ai' : 'me');
    div.innerHTML = '<div class="ava">' + (role === 'assistant' ? '师' : '我') + '</div><div class="bubble">' + md(content) + '</div>';
    if (opts && opts.length) {
      var optBox = document.createElement('div');
      optBox.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';
      optBox.innerHTML = opts.map(function (o) {
        return '<button class="quick-btn" style="font-size:13px" onclick="App.sendOpt(\'' + (window.__curKid || '') + '\',\'' + esc(o.k) + '\')">' + o.k + '. ' + md(o.t) + '</button>';
      }).join('');
      div.querySelector('.bubble').appendChild(optBox);
    }
    if (streamingId) { div.id = streamingId; }
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
    return div;
  }
  var llmKeyVar = { key: '' };
  function isLocalBase(base) { return /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(String(base || '')); }
  function llmKey() { return sessionLLMKey || llmKeyVar.key || ''; }
  /* 本地模型免 Key；云端必须有 Key。配置齐全即可用。 */
  function llmOn() {
    var s = state.settings.llm;
    if (!s || !s.enabled || !s.base || !s.model) return false;
    if (!isLocalBase(s.base) && !llmKey()) return false;
    return true;
  }
  function llmConf() {
    var s = state.settings.llm || {};
    if (!s.base || !s.model) return null;
    if (!isLocalBase(s.base) && !llmKey()) return null;
    return { base: s.base, model: s.model, key: llmKey(), kind: s.kind || 'local' };
  }
  function switchLLMKind(kind) {
    var s = state.settings.llm;
    s.kind = kind;
    s.base = kind === 'cloud' ? s.cloudBase : s.localBase;
    s.model = kind === 'cloud' ? s.cloudModel : s.localModel;
    save();
  }

  /* ============ Agent 工具上下文 ============
   * 把工具需要的真实数据源统一注入。AI 通过它"看见"这名学生。
   */
  function createToolContext() {
    return {
      persona: function () { return state.settings.persona || 'strict'; },
      llmConf: llmConf,

      node: function (kid) { return NODE[kid] || null; },
      allNodes: flatNodes,
      questionsOf: function (kid) { return AIEngine.questionsOf(kid); },
      attemptsOf: function (kid) {
        return state.attempts.filter(function (a) { return a.kid === kid; });
      },
      nodeStatus: nodeStatus,
      correctRate: correctRateOf,

      mistakeCards: function () {
        var out = [];
        Object.keys(state.cards).forEach(function (id) {
          var c = state.cards[id];
          if (c.type !== 'mistake' || !c.questionId) return;
          var q = null;
          for (var i = 0; i < QDATA.length; i++) { if (QDATA[i].id === c.questionId) { q = QDATA[i]; break; } }
          if (!q) return;
          var n = NODE[q.kid] || {};
          out.push({
            qid: q.id, kid: q.kid, title: n.title || q.kid,
            stem: q.stem, answer: q.answer, analysis: q.analysis || '',
            lapses: c.lapses || 0
          });
        });
        return out;
      },

      publicQuestion: function (q) {
        return {
          id: q.id, kid: q.kid, type: q.type, stem: q.stem,
          options: q.options || null, difficulty: q.difficulty || 2,
          sourceType: q.sourceType || null, sourceYear: q.sourceYear || null
        };
      },

      weakNodes: function (limit) {
        var rows = [];
        flatNodes().forEach(function (n) {
          var arr = state.attempts.filter(function (a) { return a.kid === n.id; });
          if (!arr.length) return;
          var wrong = arr.filter(function (a) { return !a.correct; }).length;
          rows.push({
            kid: n.id, title: n.title, wrong: wrong,
            accuracy: Math.round((arr.length - wrong) / arr.length * 100)
          });
        });
        rows.sort(function (a, b) { return (b.wrong - a.wrong) || (a.accuracy - b.accuracy); });
        return rows.slice(0, limit || 4);
      },

      progress: function () {
        var all = flatNodes(), mastered = 0, learning = 0, untouched = 0;
        all.forEach(function (n) {
          var s = nodeStatus(n.id);
          if (s === 'mastered') mastered++;
          else if (s === 'learning') learning++;
          else untouched++;
        });
        var week = [];
        for (var i = 6; i >= 0; i--) week.push(addDaysStr(todayStr(), -i));
        var recent = state.attempts.filter(function (a) { return week.indexOf(a.date) >= 0; });
        var track = state.settings.examTrack || 'math1';
        return {
          trackName: track === 'math1' ? '数学一' : track === 'math2' ? '数学二' : '数学三',
          mastered: mastered, learning: learning, untouched: untouched, total: all.length,
          streak: calcStreak(),
          accuracy7d: recent.length ? recent.filter(function (a) { return a.correct; }).length / recent.length : null,
          attempts7d: recent.length,
          daysLeft: daysUntilExam(),
          examDate: state.settings.examDate || null,
          dueToday: dueCards().length
        };
      },

      notesOf: function (kid) {
        if (!state.notes) state.notes = {};
        return state.notes[kid] || [];
      },
      addNote: function (kid, text) {
        if (!state.notes) state.notes = {};
        if (!state.notes[kid]) state.notes[kid] = [];
        state.notes[kid].push({ text: text, date: todayStr(), ts: Date.now() });
        save();
      },
      markLearned: function (kid) { markLearned(kid); save(); }
    };
  }

  window.__curKid = '';
  App.sendChat = async function () {
    var kid = window.__curKid;
    if (!kid) return;
    var inp = $('#chat-input');
    var text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    var sess = ensureSess(kid);
    var area = $('#msg-area');
    sess.history.push({ role: 'user', content: text });
    save();
    appendMsg(area, 'user', text, null);

    if (llmOn()) {
      var ok = await runAgentTurn(sess, text, area);
      if (ok) return;
    }
    idleRespond(sess, text, area);
  };

  /* ----- Agent 回合：模型带着工具自主作答 ----- */
  async function runAgentTurn(sess, text, area) {
    var ctx = createToolContext();
    var pending = null;
    var indicator = $('#llm-indicator');
    if (indicator) indicator.textContent = '思考中…';
    try {
      var out = await Agent.run(sess, text, ctx, {
        onAssistantStart: function () {
          var el = appendMsg(area, 'assistant', '', null, null);
          var b = el.querySelector('.bubble');
          b.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
          pending = { el: el, bubble: b };
          return pending;
        },
        onAssistantDelta: function (b, full) {
          if (!b || !b.bubble) return;
          b.bubble.innerHTML = md(full);
          area.scrollTop = area.scrollHeight;
        },
        onAssistantDone: function (b, full) {
          if (!b || !b.bubble) return;
          b.bubble.innerHTML = md(full);
          area.scrollTop = area.scrollHeight;
          pending = null;
        },
        onAssistantDrop: function (b) {
          if (b && b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el);
          pending = null;
        },
        onToolStart: function (tc) { appendToolCard(area, tc); },
        onToolEnd: function (tc, res) { finishToolCard(area, tc, res); }
      });
      sess.history.push({ role: 'assistant', content: out.content });
      save();
      var marked = (out.usedTools || []).some(function (t) { return t.name === 'mark_mastered' && t.ok; });
      if (marked) toast('已标记学习完成，生成复习卡片', 'ok');
      refreshBadges();
      return true;
    } catch (e) {
      if (pending && pending.el && pending.el.parentNode) pending.el.parentNode.removeChild(pending.el);
      toast('AI 老师暂不可用，已切回内置引擎：' + String(e.message || e).slice(0, 60), 'no');
      return false;
    } finally {
      if (indicator) indicator.textContent = llmOn() ? '模型：' + state.settings.llm.model : '内置名师';
    }
  }

  /* ----- 工具调用卡片：让学生看见 AI 在干什么 ----- */
  function shortArgs(args) {
    if (!args) return '';
    var parts = [];
    Object.keys(args).forEach(function (k) {
      var v = args[k];
      if (v == null || v === '' || (Object.prototype.toString.call(v) === '[object Array]' && !v.length)) return;
      parts.push(k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    });
    var s = parts.join(' ');
    return s.length > 48 ? s.slice(0, 48) + '…' : s;
  }
  function summarizeResult(name, data) {
    if (!data) return '完成';
    if (name === 'query_weakness') return '找到 ' + ((data.weak || []).length) + ' 个薄弱点';
    if (name === 'get_mistakes') return (data.count || 0) + ' 道错题';
    if (name === 'pick_question') return data.found ? '抽到 1 题' : '该考点暂无题';
    if (name === 'get_node') return '已读取正文';
    if (name === 'search_nodes') return (data.hitCount || 0) + ' 个匹配';
    if (name === 'get_progress') return '已读取进度';
    if (name === 'draw_graph') return '图像已生成';
    if (name === 'save_note') return '已记入笔记';
    if (name === 'mark_mastered') return '已标记掌握';
    return '完成';
  }
  function appendToolCard(area, tc) {
    var label = (window.Tools && Tools.LABELS && Tools.LABELS[tc.name]) || tc.name;
    var el = document.createElement('div');
    el.className = 'tool-card running';
    el.id = 'toolcard-' + String(tc.id).replace(/[^a-zA-Z0-9_-]/g, '');
    el.innerHTML = '<span class="tc-dot"></span><span class="tc-name">' + esc(label) + '</span>' +
      (shortArgs(tc.args) ? '<span class="tc-args">' + esc(shortArgs(tc.args)) + '</span>' : '') +
      '<span class="tc-state">执行中</span>';
    area.appendChild(el);
    area.scrollTop = area.scrollHeight;
  }
  function finishToolCard(area, tc, res) {
    var el = document.getElementById('toolcard-' + String(tc.id).replace(/[^a-zA-Z0-9_-]/g, ''));
    if (!el) return;
    el.className = 'tool-card ' + (res.ok ? 'ok' : 'fail');
    var st = el.querySelector('.tc-state');
    if (st) st.textContent = res.ok ? summarizeResult(tc.name, res.data) : '执行失败';
    if (res.ok && res.render && res.render.type === 'svg') {
      var box = document.createElement('div');
      box.className = 'tool-graph';
      box.innerHTML = res.render.html;
      area.appendChild(box);
      area.scrollTop = area.scrollHeight;
    }
  }
  function idleRespond(sess, text, area) {
    var r = AIEngine.builtinRespond(sess, text);
    sess.history.push({ role: 'assistant', content: r.text });
    if (r.attempt) {
      var q = QDATA.filter(function (x) { return x.id === r.attempt.qid; })[0];
      if (q) addAttempt(q, r.attempt.answer, r.attempt.correct, 'chat');
    }
    if (r.acceptResult) markLearned(sess.kid);
    save();
    appendMsg(area, 'assistant', r.text, r.opts || null);
  }
  App.quickSend = function (h) {
    var inp = $('#chat-input');
    inp.value = h;
    App.sendChat();
  };
  App.sendOpt = function (kid, k) { App.quickSend(k); };
  App.learnNav = function (kid) { window.location.hash = '#/learn/' + kid; };

  /* ============ 讨论模式：老师 + 三个水平不同的学生 ============ */
  function discussOf(kid) {
    if (!state.discussions) state.discussions = {};
    return state.discussions[kid] || null;
  }
  function scrollDiscussBottom() {
    var s = $('#d-stream');
    if (s) s.scrollTop = s.scrollHeight;
  }
  function appendDiscussMsg(stream, role, text) {
    var r = Discuss.ROLES[role] || { name: role, avatar: '?', tag: '' };
    var el = document.createElement('div');
    el.className = 'd-msg d-' + role;
    el.innerHTML =
      '<div class="d-ava">' + esc(r.avatar) + '</div>' +
      '<div class="d-body">' +
        '<div class="d-name">' + esc(r.name) + (r.tag ? '<span class="d-tag">' + esc(r.tag) + '</span>' : '') + '</div>' +
        '<div class="d-bubble">' + (text ? md(text) : '') + '</div>' +
      '</div>';
    stream.appendChild(el);
    scrollDiscussBottom();
    return el;
  }
  /* 逐字打字，制造"正在说"的现场感 */
  function typeInto(bubble, text) {
    return new Promise(function (resolve) {
      var full = String(text || '');
      if (!full) { resolve(); return; }
      var step = Math.max(2, Math.ceil(full.length / 70));
      var i = 0;
      var timer = setInterval(function () {
        i += step;
        if (i >= full.length) {
          clearInterval(timer);
          bubble.innerHTML = md(full);
          scrollDiscussBottom();
          resolve();
        } else {
          bubble.innerHTML = md(full.slice(0, i));
          scrollDiscussBottom();
        }
      }, 24);
    });
  }
  function discussRosterHtml() {
    return ['teacher', 'smart', 'average', 'weak'].map(function (k) {
      var r = Discuss.ROLES[k];
      return '<div class="d-roster-item">' +
        '<span class="d-roster-ava d-' + k + '">' + esc(r.avatar) + '</span>' +
        '<div><div class="d-roster-name">' + esc(r.name) + '</div>' +
        '<div class="d-roster-tag">' + esc(r.tag || '主讲') + '</div></div></div>';
    }).join('');
  }
  function pageDiscuss(kid) {
    var n = NODE[kid];
    if (!n) {
      $('#main').innerHTML = head('未找到知识点', '该知识点不存在或不在当前考试范围内') + '<p class="muted">返回 <a href="#/learn">知识树</a></p>';
      return;
    }
    var session = discussOf(kid);
    var chap = chapOf(n) || { cat: { name: '' } };
    var live = !!(session && session.turns && session.turns.length);
    var statusText = !session ? '未开始' : session.stage === 'done' ? '已结束' : '进行中';

    var html = head('讨论室', esc(n.title) + ' · 老师带三个学生掰扯一轮') +
      '<div class="discuss-layout">' +
        '<div class="discuss-main">' +
          '<div class="d-panel">' +
            '<div class="d-topbar">' +
              '<span class="kh-tag">' + esc(chap.cat.name || '') + '</span>' +
              '<span class="d-status" id="d-status">' + statusText + '</span>' +
            '</div>' +
            '<div class="d-stream" id="d-stream"></div>' +
            '<div class="d-input-row">' +
              '<input id="d-input" placeholder="你也可以插话 —— 讨论会停下来等你" autocomplete="off"' + (live ? '' : ' disabled') + '>' +
              '<button id="d-send" onclick="App.discussInterject()"' + (live ? '' : ' disabled') + '>插话</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="discuss-side">' +
          '<div class="card"><div class="sub-title">参与的人</div><div class="d-roster">' + discussRosterHtml() + '</div></div>' +
          '<div class="card"><div class="sub-title">这一局</div>' +
            '<div class="side-note" id="d-meta">' + (session && session.reason ? esc(session.reason) : '点下面的按钮开始') + '</div>' +
            '<button class="btn primary" style="width:100%;margin-top:10px" onclick="App.startDiscuss()">' + (session ? '重开一局' : '开一局讨论') + '</button>' +
            (session ? '<button class="btn" style="width:100%;margin-top:8px" onclick="App.clearDiscuss()">清空本考点讨论</button>' : '') +
          '</div>' +
          '<div class="card"><div class="sub-title">为什么他们会吵起来</div><div class="side-note">' +
            '甲看得到完整正文和例题，乙只学过正文，丙只记得第一句定义 —— 三个人掌握的信息不一样，所以必然有分歧。' +
            '丙犯的错是从你的错题本和题目干扰项里挖出来的，不是随便编的。' +
          '</div></div>' +
        '</div>' +
      '</div>';
    $('#main').innerHTML = html;

    if (live) {
      var stream = $('#d-stream');
      if (session.topic) appendDiscussMsg(stream, 'teacher', '我们来看这道题：' + session.topic);
      session.turns.forEach(function (t) { appendDiscussMsg(stream, t.role, t.text); });
      if (session.userTurns && session.userTurns.length) {
        session.userTurns.forEach(function (u) {
          appendDiscussMsg(stream, 'me', u.text);
          if (u.reply) appendDiscussMsg(stream, 'teacher', u.reply);
        });
      }
      if (session.summary) {
        appendDiscussMsg(stream, 'teacher', session.summary).classList.add('d-summary');
      }
      var inp = $('#d-input');
      if (inp && !inp.disabled) {
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') App.discussInterject(); });
      }
    }
  }
  function setDiscussStatus(t) {
    var el = $('#d-status');
    if (el) el.textContent = t;
  }
  App.goDiscuss = function (kid) { window.location.hash = '#/discuss/' + kid; };

  App.startDiscuss = async function () {
    var kid = window.__curKid;
    if (!kid) return;
    if (!llmOn()) {
      toast('讨论模式需要真实 AI，请先在设置里接入模型', 'no');
      window.location.hash = '#/settings';
      return;
    }
    var ctx = createToolContext();
    var topic = Discuss.pickTopic(ctx, kid);
    if (!topic) { toast('这个考点还没有可讨论的题目', 'no'); return; }

    var session = {
      kid: topic.kid, topic: '', question: topic.question,
      reason: topic.reason, turns: [], userTurns: [],
      summary: '', stage: 'discussing', ts: Date.now()
    };
    if (!state.discussions) state.discussions = {};
    state.discussions[kid] = session;
    save();
    pageDiscuss(kid);

    var stream = $('#d-stream');
    var loading = appendDiscussMsg(stream, 'teacher', '');
    loading.querySelector('.d-bubble').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    loading.querySelector('.d-name').textContent = '正在组织讨论…';
    setDiscussStatus('生成中');

    var gen;
    try {
      gen = await Discuss.generate(topic, ctx);
    } catch (e) {
      loading.querySelector('.d-bubble').innerHTML = '<span class="d-err">讨论生成失败：' + esc(String(e.message || e)) + '</span>';
      loading.querySelector('.d-name').textContent = '老师';
      session.stage = 'failed';
      save();
      setDiscussStatus('失败');
      toast('讨论生成失败', 'no');
      return;
    }

    session.topic = gen.topic;
    session.turns = gen.turns;
    save();
    loading.remove();

    setDiscussStatus('进行中');
    var tEl = appendDiscussMsg(stream, 'teacher', '');
    await typeInto(tEl.querySelector('.d-bubble'), '我们来看这道题：' + session.topic);
    await Discuss.sleep(420);

    for (var i = 0; i < session.turns.length; i++) {
      var t = session.turns[i];
      var el = appendDiscussMsg(stream, t.role, '');
      await typeInto(el.querySelector('.d-bubble'), t.text);
      await Discuss.sleep(360);
    }

    // 老师点评
    var sEl = appendDiscussMsg(stream, 'teacher', '');
    var sBubble = sEl.querySelector('.d-bubble');
    sBubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    setDiscussStatus('点评中');
    try {
      var summary = await Discuss.summarize(session, ctx, function (full) {
        sBubble.innerHTML = md(full);
        scrollDiscussBottom();
      });
      sBubble.innerHTML = md(summary);
      sEl.classList.add('d-summary');
      session.summary = summary;
      session.stage = 'done';
      save();
      setDiscussStatus('已结束');
      refreshBadges();
    } catch (e) {
      sBubble.innerHTML = '<span class="d-err">点评生成失败：' + esc(String(e.message || e).slice(0, 90)) + '</span>';
      session.stage = 'done';
      save();
      setDiscussStatus('已结束');
    }
  };

  App.discussInterject = async function () {
    var kid = window.__curKid;
    var session = discussOf(kid);
    if (!session || !session.turns.length) return;
    var inp = $('#d-input');
    var text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    var stream = $('#d-stream');
    appendDiscussMsg(stream, 'me', text);
    session.userTurns.push({ text: text, ts: Date.now() });
    save();

    var el = appendDiscussMsg(stream, 'teacher', '');
    var bubble = el.querySelector('.d-bubble');
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    var ctx = createToolContext();
    try {
      var reply = await Discuss.replyToUser(session, text, ctx, function (full) {
        bubble.innerHTML = md(full);
        scrollDiscussBottom();
      });
      bubble.innerHTML = md(reply);
      session.userTurns[session.userTurns.length - 1].reply = reply;
      save();
    } catch (e) {
      bubble.innerHTML = '<span class="d-err">回应失败：' + esc(String(e.message || e).slice(0, 90)) + '</span>';
    }
  };

  App.clearDiscuss = function () {
    var kid = window.__curKid;
    if (!state.discussions || !state.discussions[kid]) return;
    if (!confirmDialog('清空这个考点的讨论记录？')) return;
    delete state.discussions[kid];
    save();
    pageDiscuss(kid);
    toast('已清空');
  };

  /* ----- 做题页 ----- */
  var quizState = { qids: [], done: {}, results: [] };
  function pageQuiz(mode, qidsOverride) {
    if (qidsOverride && qidsOverride.length) {
      quizState.qids = qidsOverride;
      quizState.filtered = false;
    } else if (mode === 'retry' || window.__keepFiltered) {
      window.__keepFiltered = false;   // 保留筛选练习的题目
    } else {
      quizState.filtered = false;
      var d = dailyProgress();
      quizState.qids = d.quizIds.slice();
    }
    quizState.done = {}; quizState.results = [];
    renderQuizList();
  }
  function renderQuizList() {
    var isFiltered = !!quizState.filtered;
    var modeLabel = isFiltered ? '筛选练习' : '每日一练';
    var remaining = quizState.qids.filter(function (id) { return !quizState.done[id]; });
    var txt = remaining.length ? '<b>' + remaining.length + '</b> 道待做 · ' + (isFiltered ? '按所选条件随机抽取' : '抽题策略：优先掌握度低与错题多的知识点') : '全部完成';
    var html = head(modeLabel, txt, isFiltered ? '<button class="btn small" onclick="location.hash=\'#/settings\'">重新筛选</button>' : '') +
      '<div id="quiz-list"></div>';
    $('#main').innerHTML = html;
    var list = $('#quiz-list');
    quizState.qids.forEach(function (qid, idx) {
      var q = QDATA.filter(function (x) { return x.id === qid; })[0];
      if (!q) return;
      var done = quizState.done[qid];
      var box = document.createElement('div');
      box.className = 'q-card' + (idx > 0 ? ' mt16' : '');
      box.innerHTML = '<div class="q-meta"><span class="q-type">' + (q.type === 'choice' ? '选择题' : '填空题') + '</span>' +
        srcBadge(q) +
        '<span class="q-src">' + esc((NODE[q.kid] || {}).title || '') + ' · 难度 ' + q.difficulty + '</span>' +
        '<span class="q-tools"><button class="speak-btn" onclick="App.speakById(\'' + q.id + '\')" title="朗读题干">🔊</button>' +
        '<button class="speak-btn" onclick="App.similar(\'' + q.kid + '\',\'' + q.id + '\')" title="同类型题推荐">🧩</button></span></div>' +
        '<div class="q-stem">' + md(q.stem) + '</div>' +
        '<div id="qbody-' + qid + '"></div>';
      list.appendChild(box);
      renderQBody(q, box.querySelector('#qbody-' + qid));
    });
    // 进度条
    var doneN = quizState.qids.filter(function (id) { return quizState.done[id]; }).length;
    if (doneN >= quizState.qids.length && quizState.qids.length) renderQuizResult(list);
  }
  function renderQBody(q, slot) {
    if (quizState.done[q.id]) {
      var r = quizState.done[q.id];
      slot.innerHTML = '<div class="q-feedback ' + (r.correct ? 'ok' : 'no') + '">' +
        (r.correct ? '✓ 回答正确' : '✗ 回答错误，我的答案：' + esc(r.answer)) + '<br>' +
        '<span class="ans">' + AIEngine.Judge.answerText(q) + '</span></div>';
      return;
    }
    if (q.type === 'choice') {
      slot.innerHTML = q.options.map(function (o) {
        return '<div class="opt" onclick="App.pickAnswer(\'' + q.id + '\',\'' + o.k + '\')"><span class="ok">' + o.k + '</span><span>' + md(o.t) + '</span></div>';
      }).join('');
    } else {
      slot.innerHTML = '<div class="fill-row"><input id="fill-' + q.id + '" placeholder="输入你的答案（如 1/2、\\pi、x^2）" autocomplete="off">' +
        '<button class="btn primary" onclick="App.pickFill(\'' + q.id + '\')">提交</button></div>';
    }
  }
  function submitAnswer(q, userAns) {
    var correct = AIEngine.Judge.check(q, userAns);
    quizState.done[q.id] = { correct: correct, answer: userAns };
    addAttempt(q, userAns, correct, 'daily');
    var d = state.daily;
    if (d && d.date === todayStr() && d.quizIds.indexOf(q.id) >= 0 && d.quizDoneIds.indexOf(q.id) < 0) {
      d.quizDoneIds.push(q.id);
    }
    checkDailyAllDone();
    // 数据展示重新渲染整题列表保持进度
    renderQuizList();
  }
  App.pickAnswer = function (qid, k) {
    var q = QDATA.filter(function (x) { return x.id === qid; })[0];
    submitAnswer(q, k);
  };
  App.pickFill = function (qid) {
    var q = QDATA.filter(function (x) { return x.id === qid; })[0];
    var v = $('#fill-' + qid).value.trim();
    if (!v) { toast('先输入答案', 'no'); return; }
    submitAnswer(q, v);
  };
  function renderQuizResult(list) {
    var okN = Object.keys(quizState.done).filter(function (id) { return quizState.done[id].correct; }).length;
    var total = quizState.qids.length;
    var btn = '<div style="display:flex;gap:10px;justify-content:center;margin-top:18px">' +
      '<button class="btn" onclick="location.hash=\'#/mistakes\'">看错题本</button>' +
      '<a class="btn primary" href="#/">回仪表盘</a></div>';
    list.insertAdjacentHTML('beforebegin',
      '<div class="card result-panel"><div class="result-score">' + okN + ' / ' + total + '</div>' +
      '<div class="result-sub">' + (okN === total ? '全对，今天状态很棒！' : okN >= total / 2 ? '不错，错的题已收进错题本，明天会安排复习。' : '错题会进入明天的复习队列，稳住节奏。') + '</div>' +
      btn + '</div>');
  }

  /* ----- 复习页 ----- */
  var reviewState = { list: [], idx: 0 };
  function pageReview() {
    reviewState.list = dueCards();
    reviewState.idx = 0;
    renderReview();
  }
  function renderReview() {
    var list = reviewState.list;
    var box = $('#main');
    if (!list.length) {
      box.innerHTML = head('复习队列', '今天没有到期的卡片') +
        '<div class="card result-panel"><div style="font-size:40px">🎓</div><div class="result-score" style="font-size:22px;margin-top:10px">队列已清空</div>' +
        '<div class="result-sub">到期复习卡已全部搞定。学新知识让队列保持转动。</div>' +
        '<a class="btn primary" href="#/learn">去知识树学新内容</a></div>';
      return;
    }
    var card = list[reviewState.idx];
    var node = NODE[card.knowledgeId];
    var isMistake = card.type === 'mistake' && card.questionId;
    var q = isMistake ? QDATA.filter(function (x) { return x.id === card.questionId; })[0] : null;
    var html = head('复习队列', '先回忆，再自评',
      '<span class="rev-stat" style="margin:0"><span class="rs">剩余 <b>' + (list.length - reviewState.idx) + '</b> 张</span>' +
      '<span class="rs">今日已评 <b>' + list.length + '</b> 张</span></span>') +
      '<div class="review-area"><div class="rev-card" id="rev-card">' +
        '<div><span class="rc-type">' + (isMistake ? '错题卡' : '知识点卡') + '</span></div>' +
        '<div class="rc-q">' + (isMistake ? '回忆这道题的解法：' + truncate(md(q.stem), 120) : '回忆「' + esc(node.title) + '」' ) + '</div>' +
        '<div class="rc-prompt">' + (isMistake ? '先在脑中演算，再点"显示答案"核对你自己是否真的会了。' : '默想它的定义、结论与考法，想不起来就点"显示要点"。') + '</div>' +
        '<button class="btn" id="rev-show" onclick="App.revShow()">' + (isMistake ? '显示答案与解析' : '显示知识点要点') + '</button>' +
        '<div class="rc-ans" id="rev-ans">' + (isMistake ? md(q.stem + '\n\n**解析**：' + q.analysis) : md(node.content)) + '</div>' +
        '<div class="rate-row mt20">' +
          '<button class="rate-btn r1" onclick="App.revRate(1)"><span class="rk">1</span><span class="rl">忘了</span></button>' +
          '<button class="rate-btn r2" onclick="App.revRate(2)"><span class="rk">2</span><span class="rl">困难</span></button>' +
          '<button class="rate-btn r3" onclick="App.revRate(3)"><span class="rk">3</span><span class="rl">记得</span></button>' +
          '<button class="rate-btn r4" onclick="App.revRate(4)"><span class="rk">4</span><span class="rl">轻松</span></button>' +
        '</div>' +
      '</div></div>';
    box.innerHTML = html;
  }
  function truncate(html, n) {
    var t = html.replace(/<[^>]+>/g, '');
    return esc(t.length > n ? t.slice(0, n) + '…' : t);
  }
  App.revShow = function () {
    var c = $('#rev-card'); c.classList.add('show');
    $('#rev-show').style.display = 'none';
  };
  App.revRate = function (rating) {
    var card = reviewState.list[reviewState.idx];
    if (!card) return;
    gradeReview(card.id, rating);
    var hints = ['（忘了，明天再见）', '（困难，很快再见）', '（记得，间隔拉长）', '（轻松，间隔最远）'];
    toast('第 ' + rating + ' 档' + hints[rating - 1], 'ok');
    reviewState.idx++;
    renderReview();
    if (reviewState.idx >= reviewState.list.length) {
      toast('今日复习队列已清空！', 'ok');
    }
  };

  /* ----- 错题本 ----- */
  function pageMistakes() {
    var list = mistakeList();
    var html = head('错题本', '答错的题自动收录，按知识点归类重练');
    var kids = [];
    list.forEach(function (a) { if (kids.indexOf(a.kid) < 0) kids.push(a.kid); });
    if (!list.length) {
      html += '<div class="card result-panel"><div style="font-size:40px">🎉</div><div class="result-sub">暂无错题，继续保持！</div><a class="btn primary" href="#/quiz">去每日一练</a></div>';
      $('#main').innerHTML = html;
      return;
    }
    html += '<div class="card"><div class="filter-row">' +
      '<button class="filter-chip on" data-kid="all" onclick="App.filterMistake()">全部（' + list.length + '）</button>' +
      kids.map(function (kid) {
        var n = list.filter(function (a) { return a.kid === kid; }).length;
        return '<button class="filter-chip" data-kid="' + kid + '" onclick="App.filterMistake(\'' + kid + '\')">' + esc(NODE[kid].title) + '（' + n + '）</button>';
      }).join('') + '</div><div id="mistake-list"></div></div>';
    $('#main').innerHTML = html;
    renderMistakeItems(list);
  }
  function renderMistakeItems(list) {
    var holder = $('#mistake-list');
    var html = list.map(function (a) {
      var q = QDATA.filter(function (x) { return x.id === a.qid; })[0];
      if (!q) return '';
      return '<div class="mistake-item"><span class="mi-tag">错题</span> ' + srcBadge(q) + ' <span style="font-size:12px;color:var(--ink-3)">' + esc((NODE[q.kid] || {}).title || '') + ' · ' + (a.date || '') + '</span>' +
        '<div class="mt8">' + md(q.stem) + '</div>' +
        '<div class="q-feedback no mt8"><b>我的答案：</b>' + (a.answer || '（未作答）') + '<br><b>正确答案：</b>' + esc(q.answer) + '<br>' + esc(q.analysis) + '</div>' +
        '<div class="mt8">' +
        '<button class="btn small primary" onclick="location.hash=\'#/quiz/r/' + q.id + '\'">重练这题</button> ' +
        '<button class="btn small" onclick="App.similar(\'' + q.kid + '\',\'' + q.id + '\')">练同类题</button> ' +
        '<button class="speak-btn" onclick="App.speakById(\'' + q.id + '\')" title="朗读题干">🔊</button>' +
        '</div></div>';
    }).join('');
    holder.innerHTML = html;
  }
  App.filterMistake = function (kid) {
    $$('.filter-chip').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-kid') === (kid || 'all'));
    });
    var list = mistakeList().filter(function (a) { return !kid || a.kid === kid; });
    renderMistakeItems(list);
  };

  /* ----- 同类型题推荐 ----- */
  window.__sim = { list: [], idx: 0, total: 0, correct: 0 };
  App.similar = function (kid, excludeQid) {
    var pool = (kidOfQ[kid] || []).filter(function (q) { return q.id !== excludeQid; });
    if (!pool.length) { toast('该知识点暂无更多题目', 'no'); return; }
    // 按来源与难度加权抽取 3 道（真题改编优先，难度贴近知识点难度）
    var target = (NODE[kid] || {}).difficulty || 2;
    var weights = pool.map(function (q) {
      var w = 2;
      if (q.sourceType === '真题改编') w = 3;
      else if (q.sourceType === '经典例题') w = 2.2;
      else if (q.sourceType === '模拟题') w = 1.6;
      var d = Math.abs((q.difficulty || 2) - target);
      if (d > 1) w *= 0.55;
      return w;
    });
    var wsum = weights.reduce(function (a, b) { return a + b; }, 0);
    var list = [], picked = {};
    while (list.length < 3 && list.length < pool.length) {
      var r = Math.random() * wsum, sel = -1;
      for (var i = 0; i < pool.length; i++) {
        if (picked[i]) continue;
        r -= weights[i];
        if (r <= 0) { sel = i; break; }
      }
      if (sel < 0) {
        for (var j = 0; j < pool.length; j++) { if (!picked[j]) { sel = j; break; } }
      }
      picked[sel] = true;
      list.push(pool[sel]);
    }
    window.__sim = { list: list, idx: 0, total: 0, correct: 0 };
    window.__sim.total = window.__sim.list.length;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'sim-overlay';
    overlay.innerHTML = '<div class="modal-box"><div class="modal-head"><b>同类型题推荐</b><span class="sub">知识点：' + esc((NODE[kid] || {}).title || '') + ' · 共 ' + window.__sim.total + ' 道</span><button class="modal-close" onclick="App.closeModal()">×</button></div><div id="sim-body"></div><div class="modal-foot"><button class="btn" onclick="App.closeModal()">关闭</button> <button class="btn primary" id="sim-next" onclick="App.simNext()">下一题</button></div></div>';
    document.body.appendChild(overlay);
    renderSimItem();
  };
  function renderSimItem() {
    var s = window.__sim;
    var q = s.list[s.idx];
    var done = !!s.ans;
    var html = '<div class="sim-progress">第 ' + (s.idx + 1) + ' / ' + s.total + ' 题</div>';
    html += '<div class="sim-q-body"><div class="q-meta"><span class="q-type">' + (q.type === 'choice' ? '选择题' : '填空题') + '</span>' + srcBadge(q) + '<span class="q-src">难度 ' + q.difficulty + '</span></div>';
    html += '<div class="q-stem">' + md(q.stem) + '</div>';
    if (q.type === 'choice') {
      html += q.options.map(function (o) {
        var cls = 'opt';
        var tail = '';
        if (done) {
          if (o.k === q.answer) { cls += ' opt-correct'; tail = ' <span class="sim-flag">✓</span>'; }
          else if (o.k === s.ans) { cls += ' opt-wrong'; tail = ' <span class="sim-flag">✗</span>'; }
        }
        return '<div class="' + cls + '"' + (done ? '' : ' onclick="App.simPick(\'' + o.k + '\')"') + '><span class="ok">' + o.k + '</span><span>' + md(o.t) + '</span>' + tail + '</div>';
      }).join('');
    } else {
      html += '<div class="fill-row"><input id="sim-fill" placeholder="输入你的答案（如 1/2、\\pi、x^2）"' + (done ? ' disabled value="' + esc(s.ans) + '"' : '') + '><button class="btn primary" onclick="App.simFill()">' + (done ? '已提交' : '提交') + '</button></div>';
    }
    if (done) {
      html += '<div class="q-feedback ' + (s.win ? 'ok' : 'no') + ' mt8"><b>' + (s.win ? '✓ 答对了！' : '✗ 这道题答错了') + '</b><br><span class="ans">' + AIEngine.Judge.answerText(q) + '</span></div>';
    }
    html += '</div>';
    $('#sim-body').innerHTML = html;
    var btn = $('#sim-next');
    if (btn) {
      if (!done) btn.style.display = 'none';
      else {
        btn.style.display = '';
        btn.textContent = s.idx + 1 < s.total ? '下一题' : '查看结果';
      }
    }
  }
  App.simPick = function (k) {
    var s = window.__sim;
    if (s.ans) return;
    var q = s.list[s.idx];
    s.ans = k;
    s.win = AIEngine.Judge.check(q, k);
    if (s.win) { s.correct++; } else { ensureMistakeCard(q); save(); }
    renderSimItem();
  };
  App.simFill = function () {
    var s = window.__sim;
    if (s.ans) return;
    var q = s.list[s.idx];
    var v = $('#sim-fill').value.trim();
    if (!v) { toast('先输入答案', 'no'); return; }
    s.ans = v;
    s.win = AIEngine.Judge.check(q, v);
    if (s.win) { s.correct++; } else { ensureMistakeCard(q); save(); }
    renderSimItem();
  };
  App.simNext = function () {
    var s = window.__sim;
    if (!s.ans) return;
    if (s.idx + 1 < s.total) { s.idx++; s.ans = null; renderSimItem(); return; }
    // 结束
    var html = '<div class="sim-done"><div style="font-size:44px">' + (s.correct === s.total ? '🎉' : '💪') + '</div><div class="sim-done-score">' + s.correct + ' / ' + s.total + '</div><div class="sim-done-tip">' +
      (s.correct === s.total ? '全部答对，掌握不错！' : '做错的题已收录到错题本，可去"错题本"重练。') + '</div>';
    $('#sim-body').innerHTML = html;
    var btn = $('#sim-next');
    if (btn) btn.style.display = 'none';
  };
  App.closeModal = function () {
    var o = $('#sim-overlay');
    if (o) o.remove();
  };

  /* ----- 语音朗读题干 ----- */
  function stripTex(text) {
    return String(text == null ? '' : text)
      .replace(/\$\$/g, ' ').replace(/\$/g, ' ')
      .replace(/\\frac\s*\{([^}]*)\}\s*\{([^}]*)\}/g, '($1 分之 $2)')
      .replace(/\\lim/g, '极限 ')
      .replace(/\\infty/g, '无穷大')
      .replace(/\\to|\\rightarrow|\\Rightarrow/g, '趋向')
      .replace(/\\ge|\\geq/g, '大于等于')
      .replace(/\\le|\\leq/g, '小于等于')
      .replace(/\\pi/g, '派')
      .replace(/\\sqrt|\\sqrt/g, '根号')
      .replace(/\\sin/g, '正弦').replace(/\\cos/g, '余弦').replace(/\\tan/g, '正切')
      .replace(/\\cdot/g, '乘以')
      .replace(/[\\{}^]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  App.speak = function (text) {
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音朗读', 'no'); return; }
    var clean = stripTex(text);
    if (!clean) return;
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(clean);
    u.lang = 'zh-CN';
    u.rate = 0.9;
    var vs = window.speechSynthesis.getVoices();
    var zh = vs.filter(function (v) { return /^zh|cmn|Chinese/i.test(v.lang) || /汉语|中文/i.test(v.name); })[0];
    if (zh) u.voice = zh;
    window.speechSynthesis.speak(u);
  };
  App.speakById = function (qid) {
    var q = QDATA.filter(function (x) { return x.id === qid; })[0];
    if (q) App.speak(q.stem);
  };

  /* ----- 自定义题库导入 ----- */
  function rebuildKidOfQ() {
    kidOfQ = {};
    QDATA.forEach(function (q) { (kidOfQ[q.kid] = kidOfQ[q.kid] || []).push(q); });
    if (window.AIEngine && AIEngine.rebuildIndex) AIEngine.rebuildIndex();
  }
  App.importQuestions = function (raw) {
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { toast('JSON 解析失败：' + e.message.slice(0, 60), 'no'); return; }
    if (!Array.isArray(arr)) arr = [arr];
    var ok = [], errs = [];
    arr.forEach(function (item, i) {
      if (!item || typeof item !== 'object') { errs.push('第' + (i + 1) + '项不是对象'); return; }
      if (!item.stem) { errs.push('第' + (i + 1) + '项缺少 stem（题干）'); return; }
      if (!item.kid || !NODE[item.kid]) { errs.push('第' + (i + 1) + '项 kid 不存在：' + (item.kid || '(空)')); return; }
      var type = item.type === 'blank' ? 'blank' : 'choice';
      if (type === 'choice') {
        if (!Array.isArray(item.options) || item.options.length < 2) { errs.push('第' + (i + 1) + '项选择题缺少 options'); return; }
        if (!item.answer) { errs.push('第' + (i + 1) + '项缺少 answer'); return; }
      } else if (item.answer === undefined || item.answer === '') {
        errs.push('第' + (i + 1) + '项填空题缺少 answer'); return;
      }
      var q = {
        id: 'u' + Date.now().toString(36) + '_' + (i + 1) + '_' + (ok.length + 1),
        kid: item.kid,
        type: type,
        difficulty: Math.max(1, Math.min(5, +item.difficulty || 2)),
        stem: String(item.stem),
        answer: String(item.answer),
        analysis: item.analysis ? String(item.analysis) : '（导入题，暂无解析）',
        _custom: true
      };
      if (type === 'choice') {
        q.options = item.options.map(function (o, oi) {
          return { k: item.optionKeys && item.optionKeys[oi] ? String(item.optionKeys[oi]) : ['A', 'B', 'C', 'D'][oi] || 'X', t: String(o.t || o) };
        });
      }
      QDATA.push(q);
      ok.push(q);
    });
    if (ok.length) { rebuildKidOfQ(); if (!state.customQ) state.customQ = []; state.customQ = state.customQ.concat(ok); save(); }
    var msg = '成功导入 ' + ok.length + ' 题';
    if (errs.length) msg += '，' + errs.length + ' 项被跳过：' + errs.slice(0, 3).join('；');
    toast(msg, errs.length ? 'no' : 'ok');
    if (window.__importRefresh) window.__importRefresh(ok.length);
  };
  /* 加载时回填自定义题 */
  function mergeCustomQ() {
    if (state.customQ && state.customQ.length) {
      var known = {};
      QDATA.forEach(function (q) { known[q.id] = 1; });
      var added = 0;
      state.customQ.forEach(function (q) {
        if (q && q.id && !known[q.id] && NODE[q.kid]) { QDATA.push(q); added++; }
      });
      if (added) rebuildKidOfQ();
    }
  }

  /* ----- 统计页 ----- */
  function pageStats() {
    var all = state.attempts;
    var doneCount = flatNodes().filter(function (n) { return state.cards[n.id]; }).length;
    var html = head('学习统计', '数据都在本地，越练越懂你');
    html += '<div class="grid-2">' +
      '<div class="card"><div class="card-title">学习热力图 <span class="sub">近 26 周</span></div>' + svgHeatmap() + '</div>' +
      '<div class="card"><div class="card-title">最近 14 天正确率</div>' + svgTrend() +
        '<div style="font-size:12px;color:var(--ink-3);margin-top:8px">共完成 ' + all.length + ' 次作答，累计打卡 ' + Object.keys(state.checkins).filter(function (d) { return checkinOK(d); }).length + ' 天</div></div>' +
      '</div>';
    html += '<div class="grid-2 mt16">' +
      '<div class="card"><div class="card-title">科目掌握度（雷达）</div>' + svgRadar() + '</div>' +
      '<div class="card"><div class="card-title">各章节正确率</div>' + chapterBars() + '</div>' +
      '</div>';
    $('#main').innerHTML = html;
  }

  /* ----- 设置页 ----- */
  function pageSettings() {
    var s = state.settings;
    var html = head('设置', '全部配置保存在本机浏览器');
    html += '<div class="card"><div class="card-title">学习计划</div>' +
      '<div class="set-row"><div><div class="slabel">考试范围</div><div class="sdesc">决定知识树与题库的覆盖范围</div></div>' +
        '<select id="set-track">' +
          '<option value="math1"' + (s.examTrack === 'math1' ? ' selected' : '') + '>数学一（全量）</option>' +
          '<option value="math2"' + (s.examTrack === 'math2' ? ' selected' : '') + '>数学二（不含概率）</option>' +
          '<option value="math3"' + (s.examTrack === 'math3' ? ' selected' : '') + '>数学三</option>' +
        '</select></div>' +
      '<div class="set-row"><div><div class="slabel">每日新学知识点数</div><div class="sdesc">影响每日任务单中新内容数量</div></div>' +
        '<input type="number" id="set-new" min="1" max="6" value="' + (s.dailyNew || 2) + '" style="width:80px"></div>' +
      '<div class="set-row"><div><div class="slabel">目标考试日期</div><div class="sdesc">用于倒排计划（可选）</div></div>' +
        '<input type="date" id="set-exam" value="' + esc(s.examDate || '') + '"></div>' +
      '</div>';
    html += '<div class="card mt16"><div class="card-title">AI 老师 <span class="sub">' + (llmOn() ? '已接入 ' + esc(s.llm.model) : '当前使用内置引擎（未接模型）') + '</span></div>' +
      '<div class="set-row"><div><div class="slabel">启用真实 AI</div><div class="sdesc">关闭时使用内置教学引擎；开启后 AI 会读你的错题本、按水平出题、画函数图像</div></div>' +
        '<label class="switch"><input type="checkbox" id="set-llm-on"' + (s.llm.enabled ? ' checked' : '') + '><span class="sl"></span></label></div>' +
      '<div class="set-row"><div><div class="slabel">老师风格</div><div class="sdesc">同一套内核，四种语气与策略</div></div>' +
        '<select id="set-persona">' +
          Object.keys(Agent.PERSONAS).map(function (k) {
            var p = Agent.PERSONAS[k];
            return '<option value="' + k + '"' + (s.persona === k ? ' selected' : '') + '>' + esc(p.name) + ' —— ' + esc(p.desc) + '</option>';
          }).join('') +
        '</select></div>' +
      '</div>';

    var kind = s.llm.kind || 'local';
    html += '<div class="card mt16"><div class="card-title">模型通道 <span class="sub">本地模型免 Key、离线、数据不出本机</span></div>' +
      '<div class="seg-row">' +
        '<button class="seg-btn' + (kind === 'local' ? ' on' : '') + '" onclick="App.setLLMKind(\'local\')">本地模型</button>' +
        '<button class="seg-btn' + (kind === 'cloud' ? ' on' : '') + '" onclick="App.setLLMKind(\'cloud\')">云端 API</button>' +
      '</div>';
    if (kind === 'local') {
      html += '<div class="set-row"><div><div class="slabel">服务地址</div><div class="sdesc">LM Studio 默认 127.0.0.1:1234/v1 · Ollama 默认 127.0.0.1:11434/v1</div></div>' +
          '<input type="text" id="set-local-base" value="' + esc(s.llm.localBase || '') + '" style="width:280px"></div>' +
        '<div class="set-row"><div><div class="slabel">本机服务</div><div class="sdesc" id="local-hint">' + (s.llm.localName ? '上次探测到：' + esc(s.llm.localName) : '点右侧按钮自动扫描本机在跑的推理服务') + '</div></div>' +
          '<div><button class="btn" onclick="App.detectLocal()">探测本机</button></div></div>' +
        '<div class="set-row"><div><div class="slabel">模型</div><div class="sdesc">' + (s.llm.localModel ? '当前：' + esc(s.llm.localModel) : '尚未选择，先点"探测本机"') + '</div></div>' +
          '<select id="set-local-model" style="min-width:240px"><option value="' + esc(s.llm.localModel || '') + '">' + esc(s.llm.localModel || '（未选择）') + '</option></select></div>' +
        '<div class="tip-box">用 file:// 直接打开页面时，浏览器会拦截对 localhost 的请求。请在本项目目录执行 <code>python3 -m http.server 8080</code>，再用 http://localhost:8080 打开本页。LM Studio 还需在 Server 设置里开启 CORS。</div>';
    } else {
      html += '<div class="set-row"><div><div class="slabel">API 地址（Base URL）</div><div class="sdesc">兼容 OpenAI 格式：DeepSeek / Kimi / 通义千问</div></div>' +
          '<input type="text" id="set-cloud-base" value="' + esc(s.llm.cloudBase || '') + '" style="width:280px" placeholder="https://api.deepseek.com"></div>' +
        '<div class="set-row"><div><div class="slabel">模型名称</div><div class="sdesc">如 deepseek-chat / moonshot-v1-8k / qwen-max</div></div>' +
          '<input type="text" id="set-cloud-model" value="' + esc(s.llm.cloudModel || '') + '" style="width:220px"></div>' +
        '<div class="set-row"><div><div class="slabel">API Key</div><div class="sdesc">仅保存在内存，刷新页面后需重新输入；不会写入本地存储</div></div>' +
          '<input type="password" id="set-llm-key" value="" style="width:280px" placeholder="sk-..."></div>';
    }
    html += '<div class="set-row"><div><div class="slabel"> &nbsp; </div><div class="sdesc" id="llm-test-result"></div></div><button class="btn" onclick="App.testLLM()">测试连接</button></div>' +
      '</div>';
    html += '<div class="card mt16"><div class="card-title">自定义题库导入</div>' +
      '<div class="sdesc" style="margin-bottom:10px">支持从 JSON 文件或文本导入题目（纯前端解析，不上传）。每条题目字段：<code>stem</code>、<code>kid</code>（知识点 id）、<code>type</code>（choice/blank）、<code>answer</code>，选择题还需 <code>options</code>（数组，可为字符串或 {k,t} 对象）；<code>analysis</code>/<code>difficulty</code>/<code>optionKeys</code> 可选。已导入 <b id="import-count">' + (state.customQ ? state.customQ.length : 0) + '</b> 题。</div>' +
      '<div class="import-zone" id="import-zone" onclick="document.getElementById(\'import-file\').click()">📂 点击选择 JSON 文件<br><span class="sub">或把 JSON 文本粘贴到下方</span><input type="file" id="import-file" accept=".json,application/json" style="display:none"></div>' +
      '<textarea id="import-text" rows="6" style="width:100%;box-sizing:border-box;margin-top:10px;font-family:ui-monospace,Menlo,monospace;font-size:12px" placeholder="[{\n  &quot;stem&quot;: &quot;计算 \\\\int_0^1 x\\\\,\\\\mathrm{d}x&quot;,\n  &quot;kid&quot;: &quot;c1n2&quot;,\n  &quot;type&quot;: &quot;blank&quot;,\n  &quot;answer&quot;: &quot;1/2&quot;\n}]"></textarea>' +
      '<div class="mt8"><button class="btn primary" onclick="App.doImport()">开始导入</button> <button class="btn" onclick="App.importSample()">填充示例</button> <button class="btn danger" onclick="App.clearCustomQ()">清空导入题</button></div>' +
      '</div>';
    html += '<div class="card mt16"><div class="card-title">题库筛选练习 <span class="sub">按来源 / 年份 / 难度挑选题目针对性训练</span></div>' +
      '<div class="set-row"><div><div class="slabel">题目来源</div><div class="sdesc">经典例题、真题改编或模拟题</div></div>' +
        '<select id="f-src">' +
          '<option value="">全部来源</option>' +
          '<option value="经典例题">经典例题</option>' +
          '<option value="真题改编">真题改编</option>' +
          '<option value="模拟题">模拟题</option>' +
        '</select></div>' +
      '<div class="set-row"><div><div class="slabel">改编 / 年份</div><div class="sdesc">真题改编题按年份过滤</div></div>' +
        '<select id="f-year">' +
          '<option value="">全部年份</option>' +
          yearsOptions().join('') +
        '</select></div>' +
      '<div class="set-row"><div><div class="slabel">难度级别</div><div class="sdesc">1 基础 · 2 常规 · 3 进阶 · 4 压轴</div></div>' +
        '<select id="f-diff">' +
          '<option value="">全部难度</option>' +
          '<option value="1">难度 1</option><option value="2">难度 2</option>' +
          '<option value="3">难度 3</option><option value="4">难度 4</option><option value="5">难度 5</option>' +
        '</select></div>' +
      '<div class="set-row"><div><div class="slabel">单轮题量</div><div class="sdesc">筛选后随机抽取练习</div></div>' +
        '<input type="number" id="f-num" min="1" max="20" value="5" style="width:80px"></div>' +
      '<div class="set-row"><div><div class="slabel"> &nbsp; </div><div class="sdesc"><span id="f-count"></span></div></div>' +
        '<button class="btn primary" onclick="App.startFilteredQuiz()">开始练习 →</button></div>' +
      '</div>';
    html += '<div class="card mt16"><div class="card-title">数据</div>' +
      '<div class="set-row"><div><div class="slabel">重置全部学习数据</div><div class="sdesc">清空卡片、作答、打卡、聊天记录（不可恢复）</div></div>' +
        '<button class="btn danger" onclick="App.resetData()">清空数据</button></div>' +
      '</div>';
    html += '<div class="card mt16"><div class="card-title">关于</div><div class="side-note">研数 v1.0 · 考研数学 AI 自学系统（单人本地 MVP）。' +
      '间隔重复采用 SM-2 算法（开发文档 8.4.3），知识库覆盖数一数二数三核心考点，题库 ' + QDATA.length + ' 题。开发者文档见项目 README。</div></div>';
    $('#main').innerHTML = html;
    $('#set-track').addEventListener('change', function () { s.examTrack = this.value; save(); toast('考试范围已更新，知识树与题库即时生效'); });
    $('#set-new').addEventListener('change', function () { s.dailyNew = Math.max(1, Math.min(6, +this.value || 2)); save(); });
    $('#set-exam').addEventListener('change', function () { s.examDate = this.value; save(); });
    $('#set-llm-on').addEventListener('change', function () {
      s.llm.enabled = this.checked;
      if (!this.checked) { sessionLLMKey = ''; var k0 = $('#set-llm-key'); if (k0) k0.value = ''; }
      save();
      toast(this.checked ? '已启用真实 AI 老师' : '已切回内置教学引擎');
      pageSettings();
    });
    $('#set-persona').addEventListener('change', function () {
      s.persona = this.value;
      save();
      toast('老师风格已切换为「' + Agent.PERSONAS[this.value].name + '」');
    });
    var lb = $('#set-local-base');
    if (lb) lb.addEventListener('change', function () {
      s.llm.localBase = this.value.trim();
      if (s.llm.kind === 'local') s.llm.base = s.llm.localBase;
      save();
    });
    var lm = $('#set-local-model');
    if (lm) lm.addEventListener('change', function () {
      s.llm.localModel = this.value;
      if (s.llm.kind === 'local') s.llm.model = s.llm.localModel;
      save();
      toast(this.value ? '已选择模型：' + this.value : '已取消模型选择');
    });
    var cb = $('#set-cloud-base');
    if (cb) cb.addEventListener('change', function () {
      s.llm.cloudBase = this.value.trim();
      if (s.llm.kind === 'cloud') s.llm.base = s.llm.cloudBase;
      save();
    });
    var cm = $('#set-cloud-model');
    if (cm) cm.addEventListener('change', function () {
      s.llm.cloudModel = this.value.trim();
      if (s.llm.kind === 'cloud') s.llm.model = s.llm.cloudModel;
      save();
    });
    var kk = $('#set-llm-key');
    if (kk) kk.addEventListener('input', function () { sessionLLMKey = this.value.trim(); });
    ['f-src', 'f-year', 'f-diff'].forEach(function (id) {
      var el = $('#' + id);
      if (el) el.addEventListener('change', refreshFilterCount);
    });
    refreshFilterCount();
  }
  function yearsOptions() {
    var yrs = [];
    QDATA.forEach(function (q) { if (q.sourceYear && yrs.indexOf(q.sourceYear) < 0) yrs.push(q.sourceYear); });
    yrs.sort(function (a, b) { return b - a; });
    return yrs.map(function (y) { return '<option value="' + y + '">' + y + ' 年</option>'; });
  }
  function filteredPool() {
    var src = ($('#f-src') ? $('#f-src').value : '');
    var yr = ($('#f-year') ? $('#f-year').value : '');
    var df = ($('#f-diff') ? $('#f-diff').value : '');
    return quesInTrack().filter(function (q) {
      if (src && q.sourceType !== src) return false;
      if (yr && String(q.sourceYear) !== yr) return false;
      if (df && String(q.difficulty) !== df) return false;
      return true;
    });
  }
  function refreshFilterCount() {
    var el = $('#f-count');
    if (!el) return;
    var n = filteredPool().length;
    el.textContent = n > 0 ? '匹配 <b>' + n + '</b> 道题' : '没有匹配的题目，试试放宽条件';
  }
  App.startFilteredQuiz = function () {
    var pool = filteredPool();
    if (!pool.length) { toast('当前筛选条件下没有题目，请放宽条件', 'no'); return; }
    var num = Math.max(1, Math.min(20, +($('#f-num') ? $('#f-num').value : 5) || 5));
    var pick = shuffle(pool).slice(0, num);
    quizState.qids = pick.map(function (q) { return q.id; });
    quizState.done = {}; quizState.results = [];
    quizState.filtered = true;
    window.__keepFiltered = true;
    location.hash = '#/quiz';
  };
  App.doImport = function () {
    var el = $('#import-file');
    if (el && el.files && el.files[0]) {
      var rd = new FileReader();
      rd.onload = function (e) { App.importQuestions(e.target.result); };
      rd.readAsText(el.files[0]);
      return;
    }
    var txt = $('#import-text').value.trim();
    if (!txt) { toast('请先选择文件或粘贴 JSON', 'no'); return; }
    App.importQuestions(txt);
  };
  App.importSample = function () {
    var s = $('#import-text');
    if (s) s.value = '[{"stem":"计算 \\\\int_0^1 x\\\\,\\\\mathrm{d}x 的值","kid":"c1n2","type":"blank","answer":"1/2","analysis":"原函数为 x^2/2，代入上下限得 1/2。"},{"stem":"函数 f(x)=\\\\frac{x^2-1}{x-1} 在 x=1 处的间断类型是","kid":"c1n5","type":"choice","options":["可去间断点","跳跃间断点","无穷间断点","振荡间断点"],"answer":"A"}]';
    toast('已填充示例，点击"开始导入"');
  };
  App.clearCustomQ = function () {
    if (!state.customQ || !state.customQ.length) { toast('暂无导入题'); return; }
    if (!confirmDialog('确定移除全部导入题？此操作不可恢复。')) return;
    for (var i = QDATA.length - 1; i >= 0; i--) { if (QDATA[i]._custom) QDATA.splice(i, 1); }
    state.customQ = [];
    rebuildKidOfQ();
    save();
    toast('已清空导入题');
    pageSettings();
  };
  window.__importRefresh = function (n) {
    var c = $('#import-count');
    if (c) c.textContent = String(state.customQ ? state.customQ.length : 0);
    var f = $('#import-file'); if (f) f.value = '';
  };
  App.setLLMKind = function (kind) {
    switchLLMKind(kind);
    pageSettings();
  };
  App.detectLocal = async function () {
    var hint = $('#local-hint');
    var box = $('#llm-test-result');
    if (hint) hint.textContent = '正在扫描本机推理服务…';
    try {
      var found = await LLM.detectLocal(function (msg) { if (hint) hint.textContent = msg; });
      if (!found) {
        if (hint) hint.textContent = '没探测到本机服务';
        if (box) box.textContent = '未发现正在运行的推理服务。请先启动 LM Studio 并开启 Local Server（默认端口 1234），或启动 Ollama（默认端口 11434）。';
        toast('未探测到本地模型服务', 'no');
        return;
      }
      var L = state.settings.llm;
      L.localBase = found.base;
      L.localName = found.name;
      L.kind = 'local';
      L.base = found.base;
      if (found.models.indexOf(L.localModel) < 0) L.localModel = found.models[0];
      L.model = L.localModel;
      save();
      var sel = $('#set-local-model');
      if (sel) {
        sel.innerHTML = found.models.map(function (m) {
          return '<option value="' + esc(m) + '"' + (m === L.localModel ? ' selected' : '') + '>' + esc(m) + '</option>';
        }).join('');
      }
      if (hint) hint.textContent = '已连接 ' + found.name + '（' + found.base + '），共 ' + found.models.length + ' 个模型';
      if (box) box.textContent = '可用模型：' + found.models.join('、');
      toast('探测到 ' + found.name + '，已选好模型', 'ok');
    } catch (e) {
      if (hint) hint.textContent = '探测失败';
      toast('探测失败：' + String(e.message || e).slice(0, 60), 'no');
    }
  };
  App.testLLM = async function () {
    var conf = llmConf();
    var box = $('#llm-test-result');
    if (!conf) {
      var L = state.settings.llm;
      if (!L.base || !L.model) { toast('请先选择模型', 'no'); return; }
      toast('云端通道需要先填 API Key（仅本次会话有效）', 'no');
      return;
    }
    toast('正在测试连接…');
    try {
      await LLM.testConnection(conf);
      state.settings.llm.enabled = true;
      save();
      if (box) box.textContent = '连接正常，模型：' + conf.model;
      toast('连接成功！AI 老师已启用：' + conf.model, 'ok');
      pageSettings();
    } catch (e) {
      if (box) box.textContent = String(e.message || e);
      toast('连接失败：' + String(e.message || e).slice(0, 70), 'no');
    }
  };
  App.resetData = function () {
    if (!confirmDialog('确定清空全部学习数据？此操作不可恢复。')) return;
    localStorage.removeItem(DB_KEY);
    location.hash = '#/';
    location.reload();
  };

  /* ----- 路由 ----- */
  function route() {
    var h = (location.hash || '').replace(/^#/, '') || '/';
    setActiveNav(h);
    refreshBadges();
    if (h === '/' || h === '') return pageDashboard();
    if (h === '/learn') return pageTree();
    var m = h.match(/^\/learn\/(.+)$/);
    if (m) { window.__curKid = m[1]; return pageLearn(m[1]); }
    m = h.match(/^\/discuss\/(.+)$/);
    if (m) { window.__curKid = m[1]; return pageDiscuss(m[1]); }
    m = h.match(/^\/quiz\/r\/(.+)$/);
    if (m) { quizState.qids = [m[1]]; quizState.done = {}; quizState.results = []; return renderQuizList(); }
    if (h === '/quiz') return pageQuiz('daily');
    if (h === '/review') return pageReview();
    if (h === '/mistakes') return pageMistakes();
    if (h === '/stats') return pageStats();
    if (h === '/settings') return pageSettings();
    return pageDashboard();
  }

  /* ----- 计时器控制 ----- */
  function updateTimerUI() {
    var mm = Math.floor(timer.seconds / 60), ss = timer.seconds % 60;
    if (timerEl) timerEl.textContent = pad2(mm) + ':' + pad2(ss);
    var btn = $('#timer-btn');
    if (btn) btn.textContent = timer.running ? '暂停' : '开始专注';
  }
  App.toggleTimer = function () {
    timer.running = !timer.running;
    if (timer.running) toast('开始计时，专注起来！');
    updateTimerUI();
  };
  App.resetTimer = function () { timer.seconds = 0; updateTimerUI(); };

  /* ----- 启动 ----- */
  window.App = App;
  state = load();
  mergeCustomQ();
  window.addEventListener('hashchange', route);
  window.addEventListener('load', route);
  if (document.readyState !== 'loading') route();
})();