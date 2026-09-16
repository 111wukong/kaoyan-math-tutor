/* 本地验证：表达式求值器 / 函数绘图 / 工具执行 / agent 提示词构建 */
const path = require('path');
const BASE = path.join(__dirname, '..');

global.window = {};
require(path.join(BASE, 'js/tools.js'));
require(path.join(BASE, 'js/llm.js'));
require(path.join(BASE, 'js/agent.js'));

const T = global.window.Tools;
const LLM = global.window.LLM;
const Agent = global.window.Agent;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = (typeof want === 'number' && typeof got === 'number')
    ? Math.abs(got - want) < 1e-9
    : got === want;
  if (ok) { pass++; console.log('  ✓ ' + label + '  => ' + got); }
  else { fail++; console.log('  ✗ ' + label + '  => 得到 ' + got + '，期望 ' + want); }
}
function truthy(label, got, extra) {
  const tail = extra != null ? '  => ' + extra : '';
  if (got) { pass++; console.log('  ✓ ' + label + tail); }
  else { fail++; console.log('  ✗ ' + label + tail + '  (falsy)'); }
}

console.log('\n=== 1. 表达式求值器 ===');
const E = T.MathExpr;
eq('sin(pi/2)', E.evalAt('sin(pi/2)', 0), 1);
eq('cos(0)', E.evalAt('cos(0)', 0), 1);
eq('ln(e)', E.evalAt('ln(e)', 0), 1);
eq('log(100)', E.evalAt('log(100)', 0), 2);
eq('sqrt(16)', E.evalAt('sqrt(16)', 0), 4);
eq('x^2+2x+1  @x=3  (隐式乘法)', E.evalAt('x^2+2x+1', 3), 16);
eq('-x^2 @x=3  (一元负号优先级)', E.evalAt('-x^2', 3), -9);
eq('2^-1  (负指数)', E.evalAt('2^-1', 0), 0.5);
eq('1/x @x=4', E.evalAt('1/x', 4), 0.25);
eq('abs(-3)+1', E.evalAt('abs(-3)+1', 0), 4);
eq('sin(x)/x 极限点 @x=1e-6  (洛必达验证)', Math.round(E.evalAt('sin(x)/x', 1e-6) * 1e6) / 1e6, 1);
eq('3sin(x) 隐式乘法 @x=pi/2', E.evalAt('3sin(x)', Math.PI / 2), 3);
eq('(x+1)(x-1) 隐式乘法 @x=3', E.evalAt('(x+1)(x-1)', 3), 8);
eq('exp(-0)=1', E.evalAt('exp(0)', 0), 1);
eq('x^2^3 右结合 = x^(2^3) = x^8 @x=2', E.evalAt('x^2^3', 2), 256);
try { E.evalAt('alert(1)', 0); fail++; console.log('  ✗ 非法输入 alert(1) 竟然通过了'); }
catch (e) { pass++; console.log('  ✓ 非法输入被拦截：' + e.message); }
try { E.evalAt('x+', 0); fail++; console.log('  ✗ 残缺表达式竟然通过了'); }
catch (e) { pass++; console.log('  ✓ 残缺表达式被拦截'); }

console.log('\n=== 2. 函数绘图 ===');
const exprs = ['sin(x)/x', 'x^3-3x', 'ln(x)', '1/x', 'tan(x)', 'exp(-x^2)', 'x^2'];
exprs.forEach(function (ex) {
  const svg = T.drawGraphSVG(ex, {});
  if (svg && svg.indexOf('<svg') === 0 && svg.indexOf('</svg>') > 0 && svg.indexOf('<path') > 0) {
    pass++; console.log('  ✓ ' + ex + '  -> SVG ' + svg.length + ' 字节');
  } else {
    fail++; console.log('  ✗ ' + ex + '  绘图失败');
  }
});
truthy('非法表达式返回 null', T.drawGraphSVG('sin(', {}) === null);

console.log('\n=== 2b. 参数化表达式（参数值由调用方按次传进来）===');

const pf = E.compile('a*x^2+b*x+c', ['a', 'b', 'c']);
eq('a=1,b=0,c=0 @x=2', pf(2, { a: 1, b: 0, c: 0 }), 4);
eq('a=2,b=-3,c=1 @x=2', pf(2, { a: 2, b: -3, c: 1 }), 3);
truthy('换个 scope，同一个函数给出不同结果',
  pf(1, { a: 1, b: 0, c: 0 }) !== pf(1, { a: 5, b: 0, c: 0 }));

/* ★ 不传 varNames 时必须和以前一模一样 —— 老表达式全在这条路径上 */
eq('不带参数的老表达式照常求值', E.evalAt('sin(pi/2)', 0), 1);
eq('x^2+2x+1 @3 仍是 16', E.evalAt('x^2+2x+1', 3), 16);
try { E.compile('a*x'); fail++; console.log('  ✗ 未声明的 a 竟然通过了'); }
catch (e) { pass++; console.log('  ✓ 未声明的 a 仍报未知符号  => ' + e.message); }

/* 参数名不能撞 x / 常量 / 函数名 —— 否则 pi 会被一个叫 pi 的参数顶掉 */
[['x', 'x*a'], ['pi', 'pi*a'], ['sin', 'sin*a']].forEach(function (pair) {
  try { E.compile(pair[1], [pair[0]]); fail++; console.log('  ✗ 参数名叫 ' + pair[0] + ' 竟然通过了'); }
  catch (e) { pass++; console.log('  ✓ 参数名不能叫 ' + pair[0] + '  => ' + e.message); }
});

/* scope 里多传的 key 一律忽略 —— 顶不掉内置常数 */
const onlyA = E.compile('a*x', ['a']);
eq('多传的 pi 顶不掉内置常数', onlyA(1, { a: 2, pi: 999 }), 2);
eq('多传的未声明 key 被忽略', onlyA(3, { a: 1, zzz: 100 }), 3);

console.log('\n=== 2c. draw_graph 带 params（图上出现滑块）===');

const dg = function (args) { return T.execute('draw_graph', args, {}); };

/* 不带 params：必须和以前完全一样，老存档与老提示词都还走这条路径 */
const plain = dg({ expr: 'sin(x)' });
eq('不带 params 仍然 ok', plain.ok, true);
eq('item 里没有 params 字段', 'params' in plain.render.item, false);
eq('item 里没有 yRange 字段', 'yRange' in plain.render.item, false);

const live = dg({
  expr: 'a*x^2+b*x+c', xmin: -3, xmax: 3,
  params: [
    { name: 'a', value: 1, min: -3, max: 3, step: 0.1 },
    { name: 'b', value: 0, min: -5, max: 5, step: 0.1 },
    { name: 'c', value: 0, min: -5, max: 5, step: 0.5 }
  ]
});
eq('带 params 仍然 ok', live.ok, true);
eq('item.params 有 3 项', live.render.item.params.length, 3);
truthy('item.yRange 是 [lo, hi]',
  Array.isArray(live.render.item.yRange) && live.render.item.yRange.length === 2);
/* ★ yRange 必须是「参数取遍极值」的包络，不是按初始值算出来那点范围。
   否则滑块一拖曲线就出视野，或者坐标轴跟着抖 —— 两种都看不出参数在干什么。 */
truthy('★ yRange 是包络（远大于初始值那点范围）',
  live.render.item.yRange[1] - live.render.item.yRange[0] > 20,
  '跨度 ' + (live.render.item.yRange[1] - live.render.item.yRange[0]).toFixed(1));
/* ★ xmin/xmax 必须一起存：重绘要复用同一个 x 轴，不能退回默认的 -2π~2π */
truthy('★ item 存了 xmin / xmax', live.render.item.xmin === -3 && live.render.item.xmax === 3,
  live.render.item.xmin + ' ~ ' + live.render.item.xmax);
eq('step 缺省时自动推为 (max-min)/40',
  dg({ expr: 'a*x', params: [{ name: 'a', value: 1, min: 0, max: 4 }] }).render.item.params[0].step, 0.1);

/* 参数定义写错必须当场拦住 —— 否则会变成一个拖不动的坏控件 */
[
  ['参数名不是单字母', { expr: 'ab*x', params: [{ name: 'ab', value: 1, min: 0, max: 2 }] }],
  ['参数名重复', { expr: 'a*x', params: [{ name: 'a', value: 1, min: 0, max: 2 }, { name: 'a', value: 1, min: 0, max: 2 }] }],
  ['max 不大于 min', { expr: 'a*x', params: [{ name: 'a', value: 1, min: 2, max: 2 }] }],
  ['初始值跑出区间', { expr: 'a*x', params: [{ name: 'a', value: 99, min: 0, max: 2 }] }],
  ['参数超过 3 个', { expr: 'a*b*c*d*x', params: ['a', 'b', 'c', 'd'].map(function (n) { return { name: n, value: 1, min: 0, max: 2 }; }) }],
  ['声明了 a 但表达式用了 b', { expr: 'a*x+b', params: [{ name: 'a', value: 1, min: 0, max: 2 }] }]
].forEach(function (pair) {
  eq('★ 拦住「' + pair[0] + '」', dg(pair[1]).ok, false);
});

/* yRange 得真的罩住参数极值，不能只是「看起来够宽」 */
const env = dg({ expr: 'a*x^2', xmin: -2, xmax: 2, params: [{ name: 'a', value: 1, min: 1, max: 10 }] });
const yr = env.render.item.yRange;
truthy('★ yRange 罩住了 a 取最大时的 y=40（a=10、x=2）', yr[0] <= 40 && yr[1] >= 40,
  '[' + yr[0].toFixed(1) + ', ' + yr[1].toFixed(1) + ']');

console.log('\n=== 3. 工具执行（mock 学情数据）===');
const mockCtx = {
  persona: function () { return 'strict'; },
  llmConf: function () { return null; },
  node: function (kid) { return { id: kid, title: '两个重要极限（一）', difficulty: 3, exam: 'all', content: '正文', example: '例', related: ['c1n1'] }; },
  allNodes: function () { return [{ id: 'c1n2', title: '两个重要极限（一）', difficulty: 3, content: 'sin x / x' }]; },
  questionsOf: function () { return [{ id: 'q01', kid: 'c1n2', type: 'choice', stem: '题干', options: [{ k: 'A', t: '1' }], answer: 'A', analysis: '解析', difficulty: 2, sourceType: '真题改编', sourceYear: 2019 }]; },
  attemptsOf: function () { return [{ correct: true, date: '2026-09-13' }, { correct: false, date: '2026-09-13' }]; },
  nodeStatus: function () { return 'learning'; },
  correctRate: function () { return 0.5; },
  mistakeCards: function () { return [{ qid: 'q05', kid: 'c1n2', title: '极限', stem: 's', answer: '1', analysis: 'a', lapses: 2 }]; },
  publicQuestion: function (q) { return { id: q.id, kid: q.kid, type: q.type, stem: q.stem, options: q.options, difficulty: q.difficulty }; },
  weakNodes: function () { return [{ kid: 'c1n2', title: '两个重要极限（一）', wrong: 3, accuracy: 40 }]; },
  progress: function () { return { trackName: '数学一', mastered: 12, learning: 5, untouched: 51, total: 68, streak: 6, accuracy7d: 0.68, attempts7d: 25, daysLeft: 104, examDate: '2026-12-26', dueToday: 3 }; },
  notesOf: function () { return []; },
  addNote: function () {},
  markLearned: function () {}
};

Agent.names = null;
T.names.forEach(function (name) {
  const args = {
    query_weakness: { limit: 3 }, get_mistakes: { limit: 3 }, pick_question: { kid: 'c1n2' },
    get_node: { kid: 'c1n2' }, search_nodes: { query: '极限' }, get_progress: {},
    draw_graph: { expr: 'sin(x)/x' }, save_note: { kid: 'c1n2', text: '笔记' }, mark_mastered: { kid: 'c1n2' },
    write_steps: { title: '求极限', steps: ['两边同除 x', '取极限'] },
    write_latex: { tex: '\\lim_{x\\to 0}\\frac{\\sin x}{x}=1', note: '重要极限' },
    highlight: { target: '两边同除 x' },
    clear_board: {}
  }[name];
  const r = T.execute(name, args, mockCtx);
  if (r.ok) { pass++; console.log('  ✓ ' + name + '  -> ' + JSON.stringify(r.data).slice(0, 78) + (r.render ? ' [' + r.render.type + ':' + (r.render.item ? r.render.item.kind : r.render.type) + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + '  -> ' + r.error); }
});
const bad = T.execute('不存在的工具', {}, mockCtx);
truthy('未知工具返回友好错误', bad.ok === false && bad.error.indexOf('可用工具') > 0);

console.log('\n=== 3b. 黑板动作族（黑板不是一张图，是一串动作）===');
const boardArgs = {
  draw_graph: { expr: 'x^2' }, write_steps: { steps: ['第一步', '第二步'] },
  write_latex: { tex: 'a^2+b^2=c^2' }, highlight: { target: '第一步' }, clear_board: {}
};
['draw_graph', 'write_steps', 'write_latex', 'highlight', 'clear_board'].forEach(function (n) {
  const r = T.execute(n, boardArgs[n], mockCtx);
  truthy(n + ' 产出 board 动作', !!(r.ok && r.render && r.render.type === 'board' && r.render.item && r.render.item.kind));
});
eq('draw_graph 的 kind', T.execute('draw_graph', { expr: 'x^2' }, mockCtx).render.item.kind, 'graph');
eq('write_steps 的 kind', T.execute('write_steps', { steps: ['a'] }, mockCtx).render.item.kind, 'steps');
eq('write_steps 保留 3 步', T.execute('write_steps', { steps: ['a', 'b', 'c'] }, mockCtx).render.item.steps.length, 3);
eq('空步骤被剔掉', T.execute('write_steps', { steps: ['a', '', '   ', 'b'] }, mockCtx).render.item.steps.length, 2);
truthy('write_steps 空输入被拦', T.execute('write_steps', { steps: [] }, mockCtx).ok === false);
eq('write_latex 剥掉 $$ 定界符', T.execute('write_latex', { tex: '$$E=mc^2$$' }, mockCtx).render.item.tex, 'E=mc^2');
eq('write_latex 剥掉单 $ 定界符', T.execute('write_latex', { tex: '$E=mc^2$' }, mockCtx).render.item.tex, 'E=mc^2');
truthy('write_latex 空输入被拦', T.execute('write_latex', { tex: '  ' }, mockCtx).ok === false);
truthy('highlight 空 target 被拦', T.execute('highlight', {}, mockCtx).ok === false);
truthy('clear_board 返回 clear', T.execute('clear_board', {}, mockCtx).render.item.kind === 'clear');
truthy('曲线带 pathLength="1"（描线动画的前提）', T.drawGraphSVG('sin(x)', {}).indexOf('pathLength="1"') > 0);

console.log('\n=== 3c. 学生不该拿到「写完整解答」的工具 ===');
['write_steps', 'write_latex', 'clear_board'].forEach(function (n) {
  truthy('学生白名单不含 ' + n, T.STUDENT_TOOLS.indexOf(n) < 0);
});
truthy('学生能圈黑板（highlight）', T.STUDENT_TOOLS.indexOf('highlight') >= 0);
truthy('老师能写步骤', T.TEACHER_TOOLS.indexOf('write_steps') >= 0);
truthy('老师能写公式', T.TEACHER_TOOLS.indexOf('write_latex') >= 0);

console.log('\n=== 3d. 黑板分页（翻页是保留，不是擦掉）===');
const np = T.execute('new_page', { title: '  导数的几何意义  ' }, mockCtx);
eq('new_page 的 kind', np.render.item.kind, 'page');
truthy('new_page 产出 board 动作', !!(np.ok && np.render.type === 'board'));
eq('标题前后空白被 trim', np.render.item.title, '导数的几何意义');
truthy('data 里带 newPage 标记（UI 可以据此提示）', np.data.newPage === true);
const npBare = T.execute('new_page', {}, mockCtx);
eq('不给标题也能翻页', npBare.render.item.kind, 'page');
truthy('★ 没标题时不塞空 title 字段（渲染层才好判「这页没名字」）',
  !Object.prototype.hasOwnProperty.call(npBare.render.item, 'title'));
const npSchema = T.SCHEMA.filter(function (s) { return s.function.name === 'new_page'; })[0];
truthy('title 不是必填（schema 里没有 required）', npSchema.function.parameters.required === undefined);
truthy('老师能翻页', T.TEACHER_TOOLS.indexOf('new_page') >= 0);
truthy('★ 学生不能翻页 —— 节奏是老师安排的，学生要回头看得靠前端导航按钮',
  T.STUDENT_TOOLS.indexOf('new_page') < 0);
eq('LABELS 有中文名', T.LABELS.new_page, '翻新一页');
eq('工具表总数（老师 14 + 学生独有 4）', Object.keys(T.TABLE).length, 18);
eq('老师工具数', T.TEACHER_TOOLS.length, 14);

console.log('\n=== 4. system prompt 构建（学情是否真的进去了）===');
const sys = Agent.buildSystem({ kid: 'c1n2', history: [] }, mockCtx);
['已掌握 12', '连续打卡：6 天', '近 7 天正确率：68%', '两个重要极限（一）', '严格督学', 'query_weakness', 'draw_graph', '本考点'].forEach(function (k) {
  truthy('prompt 含「' + k + '」', sys.indexOf(k) >= 0);
});
console.log('  · prompt 总长度 ' + sys.length + ' 字符');

console.log('\n=== 5. compaction ===');
const longHist = [];
for (let i = 0; i < 30; i++) longHist.push({ role: i % 2 ? 'assistant' : 'user', content: '第' + i + '条消息内容' });
const comp = Agent.compactHistory(longHist, 12);
truthy('30 条压成 ' + comp.length + ' 条', comp.length === 13);
truthy('含压缩标记', comp[0].content.indexOf('已压缩') > 0);

console.log('\n=== 6. 工具调用文本兜底解析 ===');
const parsed = LLM.parseTextToolCalls('我先看看你的错题本。\n```tool\n{"name":"get_mistakes","arguments":{"kid":"c1n2","limit":5}}\n```');
truthy('从正文里解析出 1 个工具调用', parsed.length === 1 && parsed[0].name === 'get_mistakes');
eq('参数正确', JSON.stringify(parsed[0].args), '{"kid":"c1n2","limit":5}');
truthy('正文里的工具块被剥离', LLM.stripToolBlocks('我先看看你的错题本。\n```tool\n{"name":"x"}\n```').indexOf('```') < 0);

console.log('\n=== 7. 工具 schema 完整性 ===');
T.SCHEMA.forEach(function (s) {
  const f = s.function;
  if (f.name && f.description && f.parameters && f.parameters.type === 'object') { pass++; }
  else { fail++; console.log('  ✗ schema 不完整：' + f.name); }
});
console.log('  ✓ ' + T.SCHEMA.length + ' 个工具 schema 全部合法');

console.log('\n──────────────────────────────');
console.log(fail === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过');
process.exit(fail === 0 ? 0 : 1);
