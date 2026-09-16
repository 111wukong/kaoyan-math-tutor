/* 本地可观测性回归测试（js/telemetry.js）
 *
 * 最重要的一条不是"事件记得住"，而是：
 *
 *   **诊断包里不能出现任何用户内容。**
 *
 * 用户愿意把诊断包发给你，不等于愿意把跟 AI 的聊天记录、笔记正文、
 * 错题原文一起发给你。这条如果失守，是把用户按在地上摩擦的事故。
 * 所以第 1 段直接构造一份"每处都是敏感内容"的 state，逐项检查报告里找不到它们。
 */
'use strict';
const path = require('path');
const BASE = path.join(__dirname, '..');

/* telemetry 直接用全局 localStorage，先装一个内存版 */
const mem = {};
global.localStorage = {
  getItem: k => (mem[k] === undefined ? null : mem[k]),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
global.window = {};
require(path.join(BASE, 'js/telemetry.js'));
const T = global.window.Telemetry;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  => ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }
function no(hay, needle, label) {
  const found = String(hay).indexOf(needle) >= 0;
  ok(!found, label, found ? { 泄露了: needle } : undefined);
}
function yes(hay, needle, label) {
  ok(String(hay).indexOf(needle) >= 0, label, { got: String(hay).slice(0, 200) });
}

/* ---------- 一份"处处是隐私"的存档 ---------- */
const SECRET_KEY = 'sk-LEAK-CANARY-9931';
const CHAT_TEXT = '我跟AI说：我失恋了所以学不进去';
const NOTE_TEXT = '我的私人笔记：这个知识点我总是算错';
const STEM_TEXT = '求极限 \\lim_{x\\to0} 某道具体题目的题干';
const ANSWER_TEXT = '我填的答案是 3/7';
const QID_TEXT = 'q01';

const PRIVACY_STATE = {
  attempts: [{ id: 'a1', qid: QID_TEXT, kid: 'c1n1', answer: ANSWER_TEXT, correct: false, context: 'practice', date: '2026-09-14', ts: 1 }],
  cards: { c1n1: { knowledgeId: 'c1n1', questionId: QID_TEXT, note: NOTE_TEXT, stem: STEM_TEXT } },
  chats: { chat1: { title: CHAT_TEXT, messages: [{ role: 'user', content: CHAT_TEXT }] } },
  notes: { c1n1: { text: NOTE_TEXT } },
  classrooms: { cls1: { transcript: CHAT_TEXT } },
  customQ: [{ id: 'cq1', stem: STEM_TEXT, answer: ANSWER_TEXT }],
  checkins: { '2026-09-14': { minutes: 30 } },
  cardDeck: {}, daily: null,
  game: { xp: 120, achievements: { a1: true }, combo: 0, bestCombo: 0, boss: {}, flags: {}, seen: {} },
  settings: {
    examTrack: 'math1',
    llm: { kind: 'cloud', cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat', cloudKey: SECRET_KEY, rememberKey: true }
  }
};

/* 每个测试段都要从"干净的内存 + 干净的 localStorage"开始，
   否则上一段留下的 sessions/events 会串到下一段。 */
function hardReset() {
  T.clear();
  T._reset();
  for (const k of Object.keys(mem)) delete mem[k];
}

function freshExtra() {
  return {
    version: '1.0', schema: 2, statsV: 1,
    storageOk: true, katexOk: true,
    usage: { kb: 42, attempts: 1, totalAttempts: 1, days: 1 }
  };
}

console.log('\n=== 1. ★ 诊断包不泄露用户内容（本模块存在的底线）===');
{
  hardReset();
  T.install(null);
  T.event('answer', { kid: 'c1n1', correct: false, ctx: 'practice' });
  T.event('page', { route: '/quiz' });
  T.error('js', '某个普通的 TypeError');
  T._flush();

  const r = T.report(PRIVACY_STATE, freshExtra());

  no(r, SECRET_KEY, '★ 不含 API Key');
  no(r, CHAT_TEXT, '★ 不含聊天内容');
  no(r, NOTE_TEXT, '★ 不含笔记正文');
  no(r, STEM_TEXT, '★ 不含题目题干');
  no(r, ANSWER_TEXT, '★ 不含用户填的答案');
  no(r, 'sk-', '★ 连 "sk-" 前缀都搜不到');
  no(r, 'deepseek-chat', '★ 不含模型名（配置细节也没必要带）');
  no(r, 'api.deepseek.com', '★ 不含接口地址');

  yes(r, 'answer', '该有的还是有：事件名在');
  yes(r, '某个普通的 TypeError', '错误消息在（这是诊断的意义所在）');
  yes(r, '不含 API Key', '报告自带一句"不含什么"的声明');
}

console.log('\n=== 2. 事件属性不会进报告（只进计数）===');
{
  hardReset();
  T.install(null);
  /* 就算调用方手滑把敏感值塞进 props，报告里也只出计数 */
  T.event('weird', { secret: SECRET_KEY, long: 'x'.repeat(500) });
  T._flush();
  const r = T.report(PRIVACY_STATE, freshExtra());
  no(r, SECRET_KEY, '★ props 里的敏感值不进报告');
  no(r, 'x'.repeat(100), '★ props 里的长文本也不进报告');
  eq(T.eventCounts().weird, 1, '但事件名被计数了');
}

console.log('\n=== 3. 错误去重与计数 ===');
{
  hardReset();
  T.install(null);
  for (let i = 0; i < 50; i++) T.error('js', '同一条错误');
  T.error('js', '另一条错误');
  T.error('promise', '同一条错误');
  T._flush();

  eq(T.errors().length, 3, '★ 50 次同一条只留 1 条记录（否则缓冲区会被同一条塞满）');
  const first = T.errors().filter(e => e.msg === '同一条错误' && e.kind === 'js')[0];
  eq(first.count, 50, '★ 但计数如实记了 50 次');
  ok(first.last >= first.first, '记录了首次与最近时间');
  eq(T.errors().filter(e => e.kind === 'promise').length, 1, '同名不同 kind 分开记（来源不同）');
}

console.log('\n=== 4. 错误条数封顶，丢的是最早的 ===');
{
  hardReset();
  T.install(null);
  const N = T.CAP_ERRORS + 20;
  for (let i = 0; i < N; i++) {
    T.error('js', '错误编号 ' + i);
    /* 手动把 first 拉开，让"最早"可判定 */
  }
  T._flush();
  eq(T.errors().length, T.CAP_ERRORS, '★ 错误条数封顶在 ' + T.CAP_ERRORS);
  const msgs = T.errors().map(e => e.msg).join('|');
  no(msgs, '错误编号 0', '★ 最早的那条被丢掉了');
  yes(msgs, '错误编号 ' + (N - 1), '最近的那条还在');
}

console.log('\n=== 5. 事件环形缓冲 ===');
{
  hardReset();
  T.install(null);
  for (let i = 0; i < T.CAP_EVENTS + 60; i++) T.event('e' + i, { i: i });
  T._flush();
  eq(T.recentEvents(99999).length, T.CAP_EVENTS, '★ 事件条数封顶在 ' + T.CAP_EVENTS);
  eq(T.recentEvents(1)[0].n, 'e' + (T.CAP_EVENTS + 59), '最近的一条在最前（recentEvents 倒序）');
  const names = T.recentEvents(99999).map(e => e.n);
  no(names.join(','), 'e0,', '最早的事件被环形挤出');
}

console.log('\n=== 6. 事件属性压缩 ===');
{
  hardReset();
  T.install(null);
  T.event('big', {
    s: 'y'.repeat(200), n: 3, b: true, nul: null,
    obj: { deep: 1 }, arr: [1, 2], fn: function () { },
    k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, k8: 8, k9: 9
  });
  T._flush();
  const p = T.recentEvents(1)[0].p;
  eq(p.s.length, 60, '★ 长字符串被截断到 60 字符上限');
  eq(p.n, 3, '数字原样保留');
  eq(p.b, true, '布尔原样保留');
  eq(p.nul, null, 'null 原样保留');
  eq(p.obj, undefined, '★ 嵌套对象被丢弃（只留短标量）');
  eq(p.arr, undefined, '★ 数组被丢弃');
  eq(p.fn, undefined, '★ 函数被丢弃');
  ok(Object.keys(p).length <= 8, '★ 属性最多留 8 个键（' + Object.keys(p).length + '）');
}

console.log('\n=== 7. 环境摘要 ===');
{
  hardReset();
  const env = T.environment(PRIVACY_STATE, freshExtra());
  yes(JSON.stringify(env), '1.0', '带应用版本');
  eq(env.存档KB, 42, '带存档体积');
  eq(env.累计作答, 1, '带累计作答次数');
  no(JSON.stringify(env), SECRET_KEY, '★ 环境摘要同样不含 Key');
  no(JSON.stringify(env), CHAT_TEXT, '★ 也不含聊天内容');

  const env2 = T.environment(PRIVACY_STATE, {});
  ok(env2.应用版本 === '1.0', 'extra 缺字段时有默认值，不炸');
}

console.log('\n=== 8. 存储不可用时不炸 ===');
{
  const saved = global.localStorage;
  global.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  hardReset();
  T.install(null);
  T.event('still-works', { a: 1 });
  T.error('js', '也要能记');
  ok(true, '★ 存储被禁用时 event/error 都不抛异常（诊断绝不能拖垮主流程）');
  const r = T.report(PRIVACY_STATE, freshExtra());
  yes(r, '===== 研数 · 诊断信息 =====', '报告仍能生成');
  T.clear();
  ok(true, 'clear() 在存储不可用时也不炸');
  global.localStorage = saved;
}

console.log('\n=== 9. install 的边界 ===');
{
  hardReset();
  T.install(null);
  T.install({});
  ok(true, '★ install 在 window 没有 addEventListener 时不炸（Node 测试环境）');

  /* 真的装一次，确认能收到 error / unhandledrejection */
  hardReset();
  const handlers = {};
  const fakeWin = {
    addEventListener(name, fn) { handlers[name] = fn; }
  };
  T.install(fakeWin);
  ok(!!handlers.error, '装上了 error 处理器');
  ok(!!handlers.unhandledrejection, '装上了 unhandledrejection 处理器');

  handlers.error({ message: 'boom', filename: 'a.js', lineno: 3, colno: 9 });
  T._flush();
  const e1 = T.errors()[0];
  eq(e1.kind, 'js', 'JS 异常归类为 js');
  yes(e1.msg, 'boom', '消息记下了');
  yes(e1.msg, 'a.js:3:9', '★ 记下了出错位置（没有这个等于没记）');

  /* 资源加载失败：没有 message，要单独归类 —— 这跟 JS 抛异常是两件事 */
  handlers.error({ target: { tagName: 'SCRIPT', src: 'https://cdn.jsdelivr.net/katex.min.js' } });
  T._flush();
  const res = T.errors().filter(e => e.kind === 'resource')[0];
  ok(!!res, '★ 资源加载失败单独归为 resource');
  yes(res.msg, 'katex.min.js', '★ 记下了是哪个资源挂了');

  handlers.unhandledrejection({ reason: new Error('promise 炸了') });
  T._flush();
  eq(T.errors().filter(e => e.kind === 'promise').length, 1, 'Promise 拒绝归类为 promise');
}

console.log('\n=== 10. 会话计数与清空 ===');
{
  hardReset();
  T.install(null);
  T.install(null);
  T._flush();
  eq(T.environment(null, {}).会话次数, 1, '★ 同一次会话重复 install 只算一次');

  T.event('a', {});
  T.error('js', 'x');
  T._flush();
  ok(T.recentEvents(10).length > 0, '清空前有事件');
  T.clear();
  eq(T.recentEvents(10).length, 0, '★ clear 之后事件为空');
  eq(T.errors().length, 0, '★ clear 之后错误为空');
  eq(mem['kaoyan_math_tutor_diag_v1'], undefined, '★ 连 localStorage 里的记录也删掉了');
}

console.log('\n=== 11. 报告结构 ===');
{
  hardReset();
  T.install(null);
  T.event('page', { route: '/quiz' });
  T.error('js', '示例错误');
  T._flush();
  const r = T.report(PRIVACY_STATE, freshExtra());
  yes(r, '--- 环境 ---', '有环境段');
  yes(r, '--- 事件计数 ---', '有事件计数段');
  yes(r, '--- 错误（1 类）---', '有错误段并标明类别数');
  yes(r, 'page: 1', '事件按名字计数');
  no(r, '（无）', '有内容时不显示"（无）"占位');

  hardReset();
  T.install(null);
  T._flush();
  const r2 = T.report(PRIVACY_STATE, freshExtra());
  yes(r2, '（无）', '没有任何记录时给出"（无）"占位而不是空白');
  yes(r2, '--- 错误（0 类）---', '错误数为 0');
}

console.log('\n──────────────────────────────');
if (fail === 0) console.log('✅ 可观测性全部通过：' + pass + ' 项');
else console.log('❌ 有失败：' + pass + ' 项，失败 ' + fail);
process.exit(fail ? 1 : 0);
