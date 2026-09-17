/* 端到端冒烟测试
 *
 * 跑法（推荐）：npm test —— 由 tests/run-all.mjs 起一个一次性服务再跑。
 * 跑法（单独）：先 npm run start，再 node server/scripts/smoke.mjs
 *              想指到别的地址：BASE=http://127.0.0.1:5180 node server/scripts/smoke.mjs
 * 覆盖：注册 → 会话 → 知识树 → 真实判题作答 → 学情 → 复习卡 → 统计 → 成就
 *       → 课堂持久化 → 导出 → 登出 → 重新登录 → 鉴权边界 → 多账号数据隔离
 *
 * 为什么不用 shell + curl：cookie 要跨请求保持，用 fetch 手动管 cookie 更清楚；
 * 而且断言逻辑写在 JS 里比在 shell 里拼字符串可靠得多。
 */

const BASE = process.env.BASE || 'http://127.0.0.1:5180';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}

function section(t) { console.log(`\n\x1b[36m【${t}】\x1b[0m`); }

/* ---------- 极简 cookie jar ---------- */
const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  absorb(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}
const GET = (p) => req('GET', p);
const POST = (p, b) => req('POST', p, b);
const PUT = (p, b) => req('PUT', p, b);
const DEL = (p) => req('DELETE', p);

/* ============================================================ */
console.log('\x1b[1m研数 · 端到端冒烟测试\x1b[0m');
console.log(`目标 ${BASE}`);

/* 前置检查：服务到底在不在。
 *
 * 不做这一步的话，连不上时第一句 `await GET('/api/health')` 会抛一个
 * 「fetch failed / ECONNREFUSED」的栈，脚本直接崩在半路 ——
 * 汇总入口看到的是「没有输出汇总行」，于是报成「脚本崩了」，
 * 而真正的原因（服务没起）被埋在栈里。
 * 这里提前问一次，把话说清楚再退出。 */
{
  let reachable = false;
  let why = '';
  try {
    const r = await fetch(`${BASE}/api/health`);
    reachable = r.ok;
    if (!r.ok) why = `健康检查返回 ${r.status}`;
  } catch (e) {
    why = e?.cause?.code || e?.message || String(e);
  }
  if (!reachable) {
    console.log(`\x1b[31m✗ 连不上 ${BASE}（${why}）\x1b[0m`);
    console.log('  单独跑这个套件需要先起服务：\x1b[36mnpm run start\x1b[0m');
    console.log('  或者直接跑 \x1b[36mnpm test\x1b[0m —— 它会自己起一个一次性服务。\n');
    process.exit(1);
  }
}

section('0. 健康检查与鉴权边界');
{
  const h = await GET('/api/health');
  ok('健康检查 200', h.status === 200);
  ok('数据库 25 张表', h.data?.db?.tables === 25, `实得 ${h.data?.db?.tables}`);
  ok('数据库连接正常', h.data?.db?.ok === true);

  const guarded = await GET('/api/study/snapshot');
  ok('未登录访问受保护接口返回 401', guarded.status === 401, `实得 ${guarded.status}`);
  ok('401 带 UNAUTHENTICATED 码', guarded.data?.code === 'UNAUTHENTICATED', `实得 ${guarded.data?.code}`);

  const badRoute = await GET('/api/nonexistent');
  ok('不存在的接口返回 401（先过闸门）或 404', [401, 404].includes(badRoute.status), `实得 ${badRoute.status}`);
}

section('1. 注册');
const EMAIL = `smoke_${Date.now()}@test.local`;
let userId = null;
{
  const weak = await POST('/api/auth/register', { email: 'a@b.c', username: 'x', password: '123' });
  ok('弱密码被拒', weak.status === 400, `实得 ${weak.status}`);

  const badMail = await POST('/api/auth/register', { email: 'not-an-email', username: '国华', password: 'Kaoyan2027!' });
  ok('非法邮箱被拒', badMail.status === 400, `实得 ${badMail.status}`);

  const r = await POST('/api/auth/register', { email: EMAIL, username: '国华', password: 'Kaoyan2027!' });
  ok('注册成功 200/201', [200, 201].includes(r.status), `实得 ${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);
  ok('返回用户对象', !!r.data?.user?.id);
  ok('用户名正确', r.data?.user?.username === '国华', `实得 ${r.data?.user?.username}`);
  ok('响应里不含密码哈希', !JSON.stringify(r.data).includes('hash') && !JSON.stringify(r.data).includes('salt'));
  userId = r.data?.user?.id;

  const dup = await POST('/api/auth/register', { email: EMAIL, username: '别的名字', password: 'Kaoyan2027!' });
  ok('重复邮箱被拒', dup.status === 400 || dup.status === 409, `实得 ${dup.status}`);
}

section('2. 会话');
{
  const me = await GET('/api/auth/me');
  ok('cookie 会话有效', me.status === 200 && me.data?.user?.email === EMAIL, `实得 ${me.status}`);

  const sess = await GET('/api/auth/sessions');
  ok('能列出活跃会话', sess.status === 200 && sess.data?.count >= 1, `实得 ${JSON.stringify(sess.data)?.slice(0, 80)}`);
  ok('会话列表不含 token 原文', !JSON.stringify(sess.data).includes('yanshu_session'));
}

section('3. 知识树与题库');
let kid = null;
{
  const t = await GET('/api/catalog/tree');
  ok('知识树 200', t.status === 200);
  const cats = t.data?.categories || [];
  const chapters = cats.flatMap((c) => c.chapters);
  const nodes = chapters.flatMap((ch) => ch.nodes);
  ok('3 个科目', cats.length === 3, `实得 ${cats.length}`);
  ok('19 章', chapters.length === 19, `实得 ${chapters.length}`);
  ok('68 个知识点', nodes.length === 68, `实得 ${nodes.length}`);
  ok('每个节点都有掌握状态', nodes.every((n) => !!n.mastery));
  ok('初始全为未学', nodes.every((n) => n.mastery === 'new'), `非 new 的有 ${nodes.filter((n) => n.mastery !== 'new').length} 个`);
  kid = nodes[0]?.id;

  const q = await GET('/api/catalog/questions?limit=200');
  ok('题库返回 200', q.status === 200);
  ok('题目数量 > 0', (q.data?.questions?.length || 0) > 0, `实得 ${q.data?.questions?.length}`);

  const one = await GET(`/api/catalog/questions/${q.data.questions[0].id}`);
  ok('单题详情含答案解析', !!one.data?.question?.answer && !!one.data?.question?.analysis);

  const f = await GET('/api/catalog/facets');
  ok('筛选项可用', f.status === 200 && Array.isArray(f.data?.sources));

  const k = await GET(`/api/catalog/knowledge/${kid}`);
  ok('知识点详情可用', k.status === 200);
}

section('4. 作答（走真实判题 + XP + 连击 + 聚合）');
let firstAttempt = null;
{
  const q = await GET('/api/catalog/questions?limit=6');
  const qs = q.data.questions;

  // 4.1 故意答错，验证错题链路
  const wrongAns = qs[0].type === 'choice' ? 'ZZZ' : '绝对不是这个答案';
  const w = await POST('/api/study/answer', { qid: qs[0].id, answer: wrongAns, context: 'quiz' });
  ok('答错返回 200', w.status === 200, `实得 ${w.status} ${JSON.stringify(w.data)?.slice(0, 120)}`);
  ok('判为错误', w.data?.correct === false);
  ok('答错也给 XP（参与分）', w.data?.xp?.gained >= 1, `实得 ${w.data?.xp?.gained}`);
  ok('答错不增加连击', w.data?.combo?.combo === 0, `实得 ${w.data?.combo?.combo}`);
  ok('返回正确答案供复盘', !!w.data?.answer);
  ok('返回解析', !!w.data?.analysis);
  firstAttempt = w.data;

  // 4.2 其余题目逐题答对（qs[0] 刻意留着不答对，用来验证错题本）
  let correctCount = 0;
  for (const item of qs.slice(1)) {
    const detail = await GET(`/api/catalog/questions/${item.id}`);
    const a = detail.data.question.answer;
    const r = await POST('/api/study/answer', { qid: item.id, answer: a, context: 'quiz' });
    if (r.data?.correct) correctCount++;
  }
  ok('照着标准答案作答全部判对', correctCount === qs.length - 1, `对 ${correctCount}/${qs.length - 1}`);

  // 4.3 幂等性：重复答同一题不重复建卡
  const before = await GET('/api/cards/summary');
  const detail = await GET(`/api/catalog/questions/${qs[1].id}`);
  await POST('/api/study/answer', { qid: qs[1].id, answer: detail.data.question.answer, context: 'quiz' });
  const after = await GET('/api/cards/summary');
  ok('重复作答不重复建卡', before.data?.total === after.data?.total,
    `前 ${before.data?.total} 后 ${after.data?.total}`);

  // 4.4 判题容错：全角、空格、LaTeX 反斜杠
  // 从 qs[2] 起挑，别碰 qs[0] —— 那道题要留着当错题
  const choiceQ = qs.slice(2).find((x) => x.type === 'choice');
  if (choiceQ) {
    const d = await GET(`/api/catalog/questions/${choiceQ.id}`);
    const ans = d.data.question.answer;
    const fullWidth = ans.replace(/[A-Za-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    const tolerant = await POST('/api/study/answer', { qid: choiceQ.id, answer: `  ${fullWidth}  `, context: 'quiz' });
    ok('判题容忍全角字符与首尾空格', tolerant.data?.correct === true,
      `原答案 "${ans}" → 输入 "${fullWidth}"`);
  }

  // 4.4 非法题号
  const bad = await POST('/api/study/answer', { qid: 'NOT_A_REAL_QID', answer: 'x', context: 'quiz' });
  ok('不存在的题号返回 404', bad.status === 404, `实得 ${bad.status}`);
}

section('5. 学情快照');
{
  const s = await GET('/api/study/snapshot');
  ok('快照 200', s.status === 200);
  const snap = s.data?.snapshot;
  ok('作答数已累计', snap?.attempts >= 7, `实得 ${snap?.attempts}`);
  ok('正确数已累计', snap?.correct >= 6, `实得 ${snap?.correct}`);
  ok('XP 已发放', snap?.xp > 0, `实得 ${snap?.xp}`);
  ok('等级已计算', snap?.level >= 1);
  ok('已学考点数 > 0', snap?.learned > 0, `实得 ${snap?.learned}`);
  ok('有称号', !!snap?.title, `实得 ${snap?.title}`);
  ok('错题数 > 0', snap?.mistakes > 0, `实得 ${snap?.mistakes}`);
}

section('6. 错题与薄弱点');
{
  const m = await GET('/api/study/mistakes');
  ok('错题列表 200', m.status === 200);
  ok('至少 1 道错题', (m.data?.mistakes?.length || 0) >= 1, `实得 ${m.data?.mistakes?.length}`);
  const first = m.data?.mistakes?.[0];
  ok('错题带我的错误答案', !!first?.myAnswer);
  ok('错题带正确答案', !!first?.answer);

  const w = await GET('/api/study/weak?limit=8');
  ok('薄弱点列表可用', w.status === 200 && Array.isArray(w.data?.weak));
}

section('7. 复习卡（SM-2）');
{
  const sum0 = await GET('/api/cards/summary');
  ok('汇总 200', sum0.status === 200);
  ok('答过的题已建卡', sum0.data?.total > 0, `实得 total=${sum0.data?.total}`);
  ok('新卡首刷排在明天（SM-2 标准：首轮间隔 1 天）',
    sum0.data?.due === 0 && (sum0.data?.upcoming?.length || 0) > 0,
    `due=${sum0.data?.due} upcoming=${JSON.stringify(sum0.data?.upcoming)}`);

  const due = await GET('/api/cards/due');
  ok('到期队列 200', due.status === 200);
  ok('今天无待复习（刚建的新卡明天才到期）', due.data?.count === 0, `实得 ${due.data?.count}`);

  const all = await GET('/api/cards');
  ok('卡片总列表 200', all.status === 200);
  const card = all.data?.cards?.[0];
  ok('至少有一张卡可评', !!card, `实得 ${all.data?.cards?.length}`);

  if (card) {
    const g = await POST(`/api/cards/${card.id}/grade`, { rating: 3 });
    ok('评分 200', g.status === 200, `实得 ${g.status} ${JSON.stringify(g.data)?.slice(0, 120)}`);
    ok('SM-2 更新了间隔', g.data?.card?.interval >= 1, `interval=${g.data?.card?.interval}`);
    ok('SM-2 更新了 EF 且不低于下限 1.3',
      typeof g.data?.card?.ef === 'number' && g.data.card.ef >= 1.3, `ef=${g.data?.card?.ef}`);
    ok('评分给了 XP', (g.data?.xp?.gained ?? 0) >= 1, `实得 ${g.data?.xp?.gained}`);
    ok('评分后 reps 递增', (g.data?.card?.reps ?? 0) > (card.reps ?? 0), `${card.reps} → ${g.data?.card?.reps}`);
    ok('评分后到期日不早于原值', String(g.data?.card?.due) >= String(card.due), `${card.due} → ${g.data?.card?.due}`);
    ok('评分写入了 lastReview（今天）',
      /^\d{4}-\d{2}-\d{2}$/.test(String(g.data?.card?.lastReview)),
      `lastReview=${g.data?.card?.lastReview}`);

    const bad = await POST(`/api/cards/${card.id}/grade`, { rating: 99 });
    ok('非法评分被拒 400', bad.status === 400, `实得 ${bad.status}`);

    const badId = await POST('/api/cards/card_不存在/grade', { rating: 3 });
    ok('评分不存在的卡返回 404', badId.status === 404, `实得 ${badId.status}`);
  }

  const prog = await GET('/api/cards/progress');
  ok('复习进度 200', prog.status === 200);
}

section('8. 统计 / 成就 / 游戏化');
{
  const st = await GET('/api/study/stats');
  ok('统计 200', st.status === 200);
  const stKeys = Object.keys(st.data || {});
  ok('统计返回多个维度', stKeys.length >= 3, `字段 ${stKeys.join(',')}`);
  ok('统计含每日序列', stKeys.some((k) => /daily|day|heat|calendar/i.test(k)), `字段 ${stKeys.join(',')}`);

  const a = await GET('/api/game/achievements');
  ok('成就 200', a.status === 200);
  ok('共 25 项成就（与原项目一致）', a.data?.total === 25, `实得 ${a.data?.total}`);
  ok('至少解锁 1 项', a.data?.unlocked >= 1, `实得 ${a.data?.unlocked}`);
  ok('成就带进度信息', a.data?.items?.every((i) => i.unlockedAt !== undefined));
  ok('三档成就都有', (a.data?.tiers?.bronze || 0) > 0 && (a.data?.tiers?.silver || 0) > 0 && (a.data?.tiers?.gold || 0) > 0,
    JSON.stringify(a.data?.tiers));
  ok('成就总数 = 三档之和',
    a.data?.tiers?.bronze + a.data?.tiers?.silver + a.data?.tiers?.gold === a.data?.total,
    `${a.data?.tiers?.bronze}+${a.data?.tiers?.silver}+${a.data?.tiers?.gold} vs ${a.data?.total}`);

  const gs = await GET('/api/game/state');
  ok('游戏状态 200', gs.status === 200);

  const n = await GET('/api/game/next');
  ok('下一步建议 200', n.status === 200 && Array.isArray(n.data?.items));

  const lv = await GET('/api/game/levels');
  ok('等级表 200', lv.status === 200, `实得 ${lv.status} ${JSON.stringify(lv.data)?.slice(0, 100)}`);
  ok('12 个等级', lv.data?.levels?.length === 12, `实得 ${lv.data?.levels?.length}`);
  ok('每级称号各不相同（曾经 12 级全是「初识极限」）',
    new Set((lv.data?.levels || []).map((x) => x.title)).size === 12,
    JSON.stringify((lv.data?.levels || []).map((x) => x.title)));
  ok('等级所需 XP 递增',
    (lv.data?.levels || []).every((x, i, arr) => i === 0 || x.need > arr[i - 1].need),
    JSON.stringify((lv.data?.levels || []).map((x) => x.need)));
}

section('9. 每日任务与打卡');
{
  const d = await GET('/api/study/daily');
  ok('每日任务 200', d.status === 200);
  ok('有计划日期', !!d.data?.date);
  ok('有复习清单字段', Array.isArray(d.data?.review?.ids));
  ok('有新考点清单字段', Array.isArray(d.data?.newNodes));
  ok('有练习题清单字段', Array.isArray(d.data?.quiz));
  ok('今日计划非空', (d.data?.review?.ids?.length || 0) + (d.data?.newNodes?.length || 0) + (d.data?.quiz?.length || 0) > 0,
    `review=${d.data?.review?.ids?.length} new=${d.data?.newNodes?.length} quiz=${d.data?.quiz?.length}`);
  ok('计划里的题不含答案（防止前端白嫖）', (d.data?.quiz || []).every((q) => q.answer === undefined));

  const c = await POST('/api/study/checkin', { minutes: 45, tasksDone: false });
  ok('打卡 200', c.status === 200, `实得 ${c.status} ${JSON.stringify(c.data)?.slice(0, 100)}`);
  ok('专注 45 分钟即算达标', c.data?.checkin?.ok === true, JSON.stringify(c.data?.checkin));
  ok('打卡发放 XP', (c.data?.xp?.gained ?? 0) >= 1, JSON.stringify(c.data?.xp));
  ok('连续天数 >= 1', c.data?.streak >= 1, `实得 ${c.data?.streak}`);

  const f = await POST('/api/study/focus', { minutes: 25 });
  ok('专注记录 200', f.status === 200);
}

section('10. 课堂持久化');
{
  const payload = {
    turns: [
      { role: 'teacher', name: '老师', text: '先看导数的定义', round: 0 },
      { role: 'xiaoming', name: '小明', text: '可导是不是一定连续？', round: 0 },
    ],
    board: ['$f\'(x_0)=\\lim_{\\Delta x\\to 0}\\frac{\\Delta y}{\\Delta x}$'],
    prompt: '那么连续一定可导吗？举个反例。',
    round: 0,
    mode: 'lesson',
  };
  const w = await PUT(`/api/classroom/${kid}`, { payload });
  ok('保存课堂 200', w.status === 200);

  const r = await GET(`/api/classroom/${kid}`);
  ok('读回课堂 200', r.status === 200);
  // 后端 GET 返回的 classroom 就是 payload 本身 —— 前端曾按 { payload } 读，是个真 bug
  ok('返回结构就是 payload（不是嵌套的 {payload}）', r.data?.classroom?.board !== undefined,
    `keys=${Object.keys(r.data?.classroom || {}).join(',')}`);
  ok('轮次保留', r.data?.classroom?.round === 0, `实得 ${r.data?.classroom?.round}`);
  ok('板书保留', r.data?.classroom?.board?.length === 1, `实得 ${r.data?.classroom?.board?.length}`);
  ok('对话保留 2 条', r.data?.classroom?.turns?.length === 2, `实得 ${r.data?.classroom?.turns?.length}`);
  ok('LaTeX 未被破坏', String(r.data?.classroom?.board?.[0]).includes('\\lim'));
  ok('模式保留', r.data?.classroom?.mode === 'lesson', `实得 ${r.data?.classroom?.mode}`);

  await DEL(`/api/classroom/${kid}`);
  const after = await GET(`/api/classroom/${kid}`);
  ok('删除后读回为 null', after.data?.classroom === null);
}

section('11. 对话存档');
{
  const hist = [{ role: 'user', content: '什么是极限' }, { role: 'assistant', content: '先说直觉…' }];
  const w = await PUT(`/api/chat/${kid}`, { stage: 'explain', history: hist });
  ok('保存对话 200', w.status === 200);
  const r = await GET(`/api/chat/${kid}`);
  ok('读回对话', r.data?.chat?.history?.length === 2);
  ok('阶段保留', r.data?.chat?.stage === 'explain');
}

section('12. 设置与 LLM 配置');
{
  const s = await GET('/api/settings');
  ok('设置 200', s.status === 200);

  const l = await GET('/api/settings/llm');
  ok('LLM 配置 200', l.status === 200);
  ok('未配置时不回传 Key 原文', !JSON.stringify(l.data).includes('sk-'), JSON.stringify(l.data)?.slice(0, 120));

  const FAKE_KEY = 'sk-smoke-test-key-1234567890';
  const set = await PUT('/api/settings/llm', {
    enabled: true, kind: 'cloud',
    cloudBase: 'https://api.deepseek.com/v1', cloudModel: 'deepseek-chat', cloudKey: FAKE_KEY,
  });
  ok('写入 LLM 配置 200', set.status === 200, JSON.stringify(set.data)?.slice(0, 120));

  const l2 = await GET('/api/settings/llm');
  ok('回传 hasKey=true', l2.data?.llm?.hasKey === true, JSON.stringify(l2.data?.llm)?.slice(0, 150));
  ok('回传 keyPreview 而非原文',
    !!l2.data?.llm?.keyPreview && !JSON.stringify(l2.data).includes(FAKE_KEY),
    `preview=${l2.data?.llm?.keyPreview}`);
  ok('keyPreview 是脱敏形式', /^sk-smo…7890$/.test(l2.data?.llm?.keyPreview || ''), `实得 ${l2.data?.llm?.keyPreview}`);

  const ex = await GET('/api/export');
  ok('导出默认剥掉 Key', ex.status === 200 && ex.data?.keyStripped === true);
  ok('导出包里没有 Key 原文', !JSON.stringify(ex.data).includes(FAKE_KEY));
  ok('导出带版本号', ex.data?.schema >= 1, `实得 ${ex.data?.schema}`);
  ok('导出含作答明细', Array.isArray(ex.data?.data?.attempts) && ex.data.data.attempts.length >= 7,
    `实得 ${ex.data?.data?.attempts?.length}`);
  ok('导出含复习卡', Array.isArray(ex.data?.data?.cards) && ex.data.data.cards.length > 0);
  ok('导出含打卡记录', Array.isArray(ex.data?.data?.checkins));
  ok('导出不含内置题库（题库是种子数据，不属于个人）',
    ex.data?.data?.questions === undefined, `实得 ${typeof ex.data?.data?.questions}`);

  const st = await GET('/api/storage');
  ok('存储用量 200', st.status === 200 && typeof st.data?.dbMb === 'number', JSON.stringify(st.data)?.slice(0, 100));

  // 清掉，别把测试 Key 留在库里
  await PUT('/api/settings/llm', { enabled: false, kind: 'cloud', cloudBase: '', cloudModel: '', cloudKey: '' });
  const l3 = await GET('/api/settings/llm');
  ok('清空后 hasKey=false', l3.data?.llm?.hasKey === false, JSON.stringify(l3.data?.llm)?.slice(0, 120));
}

section('13. AI 接口的降级行为（没配模型时应给明确报错）');
{
  const c = await POST('/api/ai/classroom', { kid, mode: 'lesson', round: 0 });
  ok('未配模型时课堂返回 400 且带 NO_LLM', c.status === 400 && c.data?.code === 'NO_LLM',
    `实得 ${c.status} ${JSON.stringify(c.data)?.slice(0, 120)}`);

  const p = await GET('/api/ai/personas');
  ok('人格列表 200', p.status === 200 && p.data?.personas?.length === 4, `实得 ${p.data?.personas?.length}`);
}

section('14. 登出与重新登录');
{
  const out = await POST('/api/auth/logout');
  ok('登出 200', out.status === 200);

  const after = await GET('/api/auth/me');
  ok('登出后 /me 返回 401', after.status === 401, `实得 ${after.status}`);

  const wrong = await POST('/api/auth/login', { email: EMAIL, password: '肯定不对的密码' });
  ok('错误密码被拒 401', wrong.status === 401, `实得 ${wrong.status}`);

  const noUser = await POST('/api/auth/login', { email: 'nobody@nowhere.local', password: 'Kaoyan2027!' });
  ok('不存在的账号也返回 401（不泄露账号是否存在）', noUser.status === 401, `实得 ${noUser.status}`);

  const back = await POST('/api/auth/login', { email: EMAIL, password: 'Kaoyan2027!' });
  ok('重新登录成功', back.status === 200, `实得 ${back.status} ${JSON.stringify(back.data)?.slice(0, 100)}`);

  const me = await GET('/api/auth/me');
  ok('新会话有效', me.status === 200 && me.data?.user?.email === EMAIL);

  const snap = await GET('/api/study/snapshot');
  ok('学习数据跨会话保留', snap.data?.snapshot?.attempts >= 7, `实得 ${snap.data?.snapshot?.attempts}`);
}

section('15. 数据隔离（另一个账号看不到你的数据）');
{
  const savedJar = new Map(jar);
  jar.clear();
  const other = `other_${Date.now()}@test.local`;
  const reg = await POST('/api/auth/register', { email: other, username: '路人甲', password: 'Another2027!' });
  ok('第二个账号注册成功', reg.status === 200 || reg.status === 201, `实得 ${reg.status}`);

  const s2 = await GET('/api/study/snapshot');
  ok('新账号作答数为 0（数据隔离）', s2.data?.snapshot?.attempts === 0, `实得 ${s2.data?.snapshot?.attempts}`);

  const d2 = await GET('/api/cards/due');
  ok('新账号没有复习卡', d2.data?.count === 0, `实得 ${d2.data?.count}`);

  jar.clear();
  for (const [k, v] of savedJar) jar.set(k, v);
}

/* ============================================================
   收尾。输出格式必须和 tests/run-all.mjs 的正则对齐：
     ✅ 接口冒烟：N 项全部通过
     ❌ 接口冒烟：N 项通过，失败 M 项
   格式一漂，汇总入口就抓不到，会把「全过」报成「脚本崩了」。
   ============================================================ */
console.log('\n' + '─'.repeat(46));
if (fail) {
  console.log(`\x1b[31m❌ 接口冒烟：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
} else {
  console.log(`\x1b[32m✅ 接口冒烟：${pass} 项全部通过\x1b[0m`);
  process.exit(0);
}
