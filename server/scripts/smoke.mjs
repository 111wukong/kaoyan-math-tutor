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

/* 假的 OpenAI 兼容上游 —— 用来测 AI 的**正常路径**。
 * 用假模型而不是真模型：CI 上拉不起 12G 的 GGUF，而且真模型输出不确定、没法断言。
 * 要验的是我们自己的代码（提示词拼装 / SSE 中转 / 错误解释），上游越假，失败越指向我们。 */
import { startLlmStub } from '../../tests/lib/llm-stub.mjs';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from '../../tests/lib/server.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180';

/* 引导管理员的凭据。
 *
 * 以前这里写死了某个真实邮箱和一个可用的口令 —— 和源码、README 里那份一样。
 * 现在服务端不再有内置默认密码（现场随机生成并打印一次），
 * 所以测试必须自己指定；`npm test` 起的临时服务会用同一组值。
 *
 * 对着别的服务跑时，用 ADMIN_EMAIL / ADMIN_PASSWORD 覆盖。 */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || TEST_ADMIN_PASSWORD;

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
const PATCH = (p, b) => req('PATCH', p, b);
const DELETE = (p) => req('DELETE', p);
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
  ok('数据库连接正常', h.data?.db?.ok === true);
  /* ★ 这个接口是**公开**的，所以它只能回「活着没有」。
   *
   * 以前它把整个 health() 返回了，里面有 DB_PATH 的绝对路径、用户数、
   * 作答数 —— 等于匿名告诉全世界「你的服务器装在哪、有多少人在用」。
   * 下面两条就是钉住这件事，免得哪天又被加回去。 */
  ok('公开健康检查不回数据库路径',
    h.data?.db?.path === undefined, `实得 ${h.data?.db?.path}`);
  ok('公开健康检查不回表数/用户数',
    h.data?.db?.tables === undefined && h.data?.db?.users === undefined);
  /* isTemp 是唯一保留的库信息：run-all 靠它拦住
   * 「BASE=… 指着一个真实库跑测试」。布尔值不泄露路径。 */
  ok('公开健康检查标明库是一次性的', h.data?.db?.isTemp === true,
    `实得 ${h.data?.db?.isTemp}`);

  /* 「建表脚本有没有被误改」的哨兵搬到了 tests/graph.mjs ——
   * 那里直接开库数表，不用 HTTP，也不用先拿到管理员会话。
   * 表数这个信息本身属于内部细节，不该从公开接口拿。 */

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

/* ============================================================
   1b. 上线加固回归
   ============================================================
   下面这几条守的都是「读代码看不出来、只有真发请求才知道」的加固 ——
   代码就在那儿、长得完全正确，但顺序或配置一错就静默失效：

     · 统一错误处理器写在路由注册之后 → 从未生效，
       表现是中文界面弹英文的 "Bad Request"；
     · 上游地址没做校验 → 服务端会替用户访问任意地址。

   放在接口套件里而不是单开一个：都是 HTTP 断言，复用这里的服务、
   cookie jar 和 PUT/GET 包装，没必要再起一台。
   ============================================================ */
section('1b. 加固：安全响应头 / 错误格式 / 上游地址');
{
  /* ---------- 安全响应头 ---------- */
  const home = await fetch(`${BASE}/`);
  const need = [
    ['content-security-policy', /frame-ancestors 'none'/],
    ['x-content-type-options', /nosniff/],
    ['x-frame-options', /DENY/],
    ['referrer-policy', /strict-origin-when-cross-origin/],
    ['permissions-policy', /camera=\(\)/],
  ];
  for (const [h, re] of need) {
    const v = home.headers.get(h) || '';
    ok(`响应头 ${h} 正确`, re.test(v), `实得 ${JSON.stringify(v)}`);
  }
  /* HSTS 只该在 https 下发。本地 http 开发时发它，
   * 浏览器会把 127.0.0.1 也升级成 https，把自己锁在门外。 */
  ok('http 下不发 HSTS', !home.headers.get('strict-transport-security'));
  const apiRes = await fetch(`${BASE}/api/health`);
  ok('接口响应也带 nosniff', apiRes.headers.get('x-content-type-options') === 'nosniff');

  /* ---------- 统一错误格式 ---------- */
  const bad = await POST('/api/auth/register', {});
  ok('缺参数回 400', bad.status === 400, `实得 ${bad.status}`);
  ok('★ 校验错误是中文文案', bad.data?.error === '请求参数不正确',
    `实得 ${JSON.stringify(bad.data?.error)}`);
  ok('不是框架默认错误体',
    bad.data?.error !== 'Bad Request' && bad.data?.code !== 'FST_ERR_VALIDATION');

  /* ---------- 上游地址校验 ---------- */
  const { checkLlmBase } = await import('../src/lib/llmUrl.js');

  const mustReject = [
    ['http://169.254.7.7', '链路本地地址'],
    ['http://10.1.2.3/v1', '10/8 私有网段'],
    ['http://172.16.5.5/v1', '172.16/12 私有网段'],
    ['http://192.168.1.9:1234/v1', '192.168/16 私有网段'],
    ['http://100.64.1.1/v1', '运营商级 NAT 段'],
    ['http://[fd00::1]:1234/v1', 'IPv6 唯一本地地址'],
    ['file:///tmp/x', 'file:// 协议'],
    ['ftp://1.1.1.1/v1', 'ftp:// 协议'],
    ['not a url', '非 URL'],
  ];
  for (const [url, why] of mustReject) {
    ok(`拒绝${why}`, (await checkLlmBase(url, {})) !== null, url);
  }
  /* 环回必须放行 —— 本地模型（LM Studio / Ollama）就跑在这儿。
   * 拦掉它等于把「本地模型」这个功能一起废了。 */
  ok('环回放行（本地模型靠它）', (await checkLlmBase('http://127.0.0.1:1234/v1', {})) === null);
  ok('公网 https 放行', (await checkLlmBase('https://1.1.1.1/v1', {})) === null);
  /* 云端那栏额外要求 https：明文发 API Key 是不能接受的。 */
  ok('★ 云端填 http 被拒（密钥会明文发出去）',
    (await checkLlmBase('http://1.1.1.1/v1', { forCloud: true })) !== null);
  ok('空值放行（交给「没配模型」提示）', (await checkLlmBase('', {})) === null);

  /* 写入口也要真的拒，而且要带可识别的 code —— 只在发请求时拦的话，
   * 用户填完点保存会「成功」，直到某次提问才炸，且报错指向别处。 */
  const putMeta = await PUT('/api/settings/llm', {
    cloudBase: 'http://169.254.7.7', cloudModel: 'x', cloudKey: 'x'.repeat(12),
  });
  ok('写入口拒绝链路本地地址', putMeta.status === 400, `实得 ${putMeta.status}`);
  ok('带 code=BAD_LLM_BASE', putMeta.data?.code === 'BAD_LLM_BASE',
    `实得 ${JSON.stringify(putMeta.data?.code)}`);

  const putLan = await PUT('/api/settings/llm', { localBase: 'http://192.168.1.9:1234/v1', localModel: 'x' });
  ok('写入口拒绝内网地址', putLan.status === 400, `实得 ${putLan.status}`);

  /* 用公网 IP 字面量而不是域名：域名要过 DNS，解析不了也会回 400，
   * 于是这条断言会因为「解析失败」而通过 —— 绿得没有意义。
   * IP 字面量不依赖网络，验的确实是「云端必须 https」这条规则。 */
  const putPlain = await PUT('/api/settings/llm', { cloudBase: 'http://1.1.1.1/v1', cloudModel: 'x' });
  ok('云端填 http 被拒', putPlain.status === 400, `实得 ${putPlain.status}`);

  const putLoop = await PUT('/api/settings/llm', { localBase: 'http://127.0.0.1:1234/v1', localModel: 'qwen' });
  ok('本地模型填环回被接受', putLoop.status === 200, `实得 ${putLoop.status}`);
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
  /* 图谱加成字段必须存在（哪怕值是 null）——
   * 少了这个字段，前端会静默地不显示「先补哪个」，而不是报错。 */
  ok('薄弱点带 rootCause 字段', w.data?.weak?.every((x) => 'rootCause' in x));
}

section('6b. 知识图谱与根因诊断');
{
  const g = await GET('/api/graph');
  ok('图谱 200', g.status === 200);
  ok('图谱返回 68 个节点', g.data?.nodes?.length === 68, `实得 ${g.data?.nodes?.length}`);
  ok('图谱边数合理', (g.data?.edges?.length || 0) > 80, `实得 ${g.data?.edges?.length}`);
  ok('图谱边全是 prereq 或 confusable',
    (g.data?.edges || []).every((e) => ['prereq', 'confusable', 'related'].includes(e.type)));
  /* 悬空边会让诊断走到一个没有标题的空节点；孤立节点意味着从它出发查不到任何东西 */
  ok('图谱无悬空边', (g.data?.health?.dangling?.length || 0) === 0,
    `实得 ${JSON.stringify(g.data?.health?.dangling)}`);
  ok('图谱无孤立节点', (g.data?.health?.isolated?.length || 0) === 0,
    `实得 ${JSON.stringify(g.data?.health?.isolated)}`);
  /* 影响面：极限这种地基必须显著大于末章叶子，否则前端按影响面画不出层次 */
  const byId = Object.fromEntries((g.data?.nodes || []).map((n) => [n.id, n]));
  ok('影响面能区分地基与叶子', (byId.c1n1?.impact || 0) > (byId.c6n3?.impact || 0),
    `c1n1=${byId.c1n1?.impact} c6n3=${byId.c6n3?.impact}`);

  const gn = await GET('/api/graph/node/c2n5');
  ok('单节点图谱 200', gn.status === 200);
  ok('洛必达有前置', (gn.data?.prerequisites?.length || 0) > 0);
  ok('前置带 reason（能回答为什么）', gn.data?.prerequisites?.every((p) => !!p.reason));
  ok('洛必达与泰勒互为易混', (gn.data?.confusable || []).some((c) => c.id === 'c2n6'));

  const roots = await GET('/api/study/roots?limit=5');
  ok('根因诊断 200', roots.status === 200);
  ok('根因有症状计数', typeof roots.data?.symptomCount === 'number');
  ok('根因有说明文案', typeof roots.data?.message === 'string' && roots.data.message.length > 0);
  for (const r of roots.data?.roots || []) {
    ok(`根因 ${r.nodeId} 带 kind`, r.kind === 'gap' || r.kind === 'weak');
    ok(`根因 ${r.nodeId} 有 why`, typeof r.why === 'string' && r.why.length > 5);
  }

  /* 知识点详情里要带上依赖关系 —— 这是「学这个之前得先会什么」的唯一来源 */
  const kn = await GET('/api/catalog/knowledge/c2n5');
  ok('知识点详情带 graph 字段', !!kn.data?.graph);
  ok('知识点详情有前置列表', (kn.data?.graph?.prerequisites?.length || 0) > 0);
  ok('知识点详情有影响面', typeof kn.data?.graph?.impact === 'number');

  /* 下一步建议要同时给出「今天干什么」和「具体学哪几个」。
   * 只有前者的话，用户点进去还得自己挑 —— 而挑错顺序正是刷题不涨分的根源。 */
  const nx = await GET('/api/game/next');
  ok('下一步建议 200', nx.status === 200);
  ok('下一步建议带 path', !!nx.data?.path && Array.isArray(nx.data.path.items));
  ok('下一步建议带 roots', !!nx.data?.roots && Array.isArray(nx.data.roots.roots));
  ok('path 带 blocked 计数', typeof nx.data?.path?.blocked === 'number');

  const pathItems = nx.data?.path?.items || [];
  const firstRootIdx = pathItems.findIndex((x) => x.isRoot);
  ok('根因若出现在推荐里就必须排最前', firstRootIdx <= 0,
    `第一个根因在第 ${firstRootIdx + 1} 位`);

  const learnItem = (nx.data?.items || []).find((i) => i.kind === 'learn');
  ok('有候选时 learn 项要给出具体节点',
    !learnItem || pathItems.length === 0 || Array.isArray(learnItem.nodes));
}

section('7. 复习卡（FSRS）');
{
  const sum0 = await GET('/api/cards/summary');
  ok('汇总 200', sum0.status === 200);
  ok('答过的题已建卡', sum0.data?.total > 0, `实得 total=${sum0.data?.total}`);
  ok('新卡首刷排在明天（首轮间隔 1 天）',
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
    ok('FSRS 更新了间隔', g.data?.card?.interval >= 1, `interval=${g.data?.card?.interval}`);
    /* FSRS 的核心状态：稳定度（保留率降到 90% 所需天数）与难度（1–10）。
     * 新卡第一次评分后这两列必须落地 —— 否则下次复习算不出「现在还记得多少」，
     * 调度会退化成「每次都当新卡」。 */
    ok('★ 评分写入了 FSRS 稳定度',
      typeof g.data?.card?.stability === 'number' && g.data.card.stability > 0,
      `stability=${g.data?.card?.stability}`);
    ok('★ 评分写入了 FSRS 难度且在 1–10',
      typeof g.data?.card?.difficulty === 'number'
      && g.data.card.difficulty >= 1 && g.data.card.difficulty <= 10,
      `difficulty=${g.data?.card?.difficulty}`);
    ok('卡片状态已离开 new',
      !!g.data?.card?.state && g.data.card.state !== 'new', `state=${g.data?.card?.state}`);
    ok('★ 返回可回忆概率（0–1）',
      typeof g.data?.card?.retrievability === 'number'
      && g.data.card.retrievability > 0 && g.data.card.retrievability <= 1,
      `retrievability=${g.data?.card?.retrievability}`);
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

  /* ---------- 主题 ----------
   * 主题 id 是「服务端白名单 + 前端注册表」两份。这里盯服务端这一半：
   * 合法值要存得住，非法值要收敛回默认（而不是 400，也不是原样落库）。 */
  const themes = await GET('/api/settings');
  ok('设置返回主题清单', Array.isArray(themes.data?.settings?.themes) && themes.data.settings.themes.length >= 8,
    `实得 ${JSON.stringify(themes.data?.settings?.themes)}`);
  ok('主题清单含默认值', themes.data?.settings?.defaultTheme === 'deep-space',
    `实得 ${themes.data?.settings?.defaultTheme}`);

  const setPaper = await PUT('/api/settings', { theme: 'paper' });
  ok('保存合法主题', setPaper.data?.settings?.theme === 'paper', `实得 ${setPaper.data?.settings?.theme}`);
  const readBack = await GET('/api/settings');
  ok('主题能读回', readBack.data?.settings?.theme === 'paper', `实得 ${readBack.data?.settings?.theme}`);

  const setBad = await PUT('/api/settings', { theme: '不存在的主题<script>' });
  ok('★ 非法主题被收敛成默认（不是 400、不是原样落库）',
    setBad.data?.settings?.theme === 'deep-space', `实得 ${setBad.data?.settings?.theme}`);
  await PUT('/api/settings', { theme: 'deep-space' });

  // 清掉，别把测试 Key 留在库里
  await PUT('/api/settings/llm', { enabled: false, kind: 'cloud', cloudBase: '', cloudModel: '', cloudKey: '' });
  const l3 = await GET('/api/settings/llm');
  ok('清空后 hasKey=false', l3.data?.llm?.hasKey === false, JSON.stringify(l3.data?.llm)?.slice(0, 120));
}

section('13. AI 接口的降级行为（没配模型时应给明确报错）');
{
  /* 先把「云端填了 Base 和模型名、但没填密钥」这个状态摆出来。
   *
   * 这是最容易出问题的配置：请求会带着**空的 Authorization** 打到上游，
   * 拿回一句 401 —— 而不是「你还没填密钥」。上一节把 cloudBase 清空了，
   * 所以这里必须显式设回来，否则测的是「啥都没填」而不是「只差密钥」。 */
  await PUT('/api/settings/llm', {
    enabled: true, kind: 'cloud',
    cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat',
    cloudKey: '',
  });

  const c = await POST('/api/ai/classroom', { kid, mode: 'lesson', round: 0 });
  ok('未配模型时课堂返回 400 且带 NO_LLM', c.status === 400 && c.data?.code === 'NO_LLM',
    `实得 ${c.status} ${JSON.stringify(c.data)?.slice(0, 120)}`);

  const p = await GET('/api/ai/personas');
  ok('人格列表 200', p.status === 200 && p.data?.personas?.length === 4, `实得 ${p.data?.personas?.length}`);

  /* ★ 每一个会打上游的接口都必须过同一道闸门。
   *
   * 这里曾经漏了五个：只有 /api/ai/chat 检查了「云端有没有填密钥」，
   * 其余接口会把请求带着**空的 Authorization** 发到 DeepSeek，
   * 拿回一句「401 Authentication Fails」再透传给用户 ——
   * 用户完全不知道是自己没填密钥。
   *
   * 默认配置是 kind=cloud + 空 key（schema 里的默认值就是这样），
   * 所以这一节测的正是「刚注册、还没配模型」的真实状态。 */
  const aiEndpoints = [
    ['对话', () => POST('/api/ai/chat', { messages: [{ role: 'user', content: 'hi' }] })],
    ['知识点提取', () => POST('/api/ai/extract', { text: '一段对话' })],
    ['多智能体课堂', () => POST('/api/ai/classroom', { kid, mode: 'lesson' })],
    ['错因归类', () => POST('/api/ai/error-type', { qid: 'q01' })],
    ['批量错因归类', () => POST('/api/ai/error-types', { limit: 3 })],
    ['变式题生成', () => POST('/api/ai/generate', { kid, count: 2 })],
    /* AI 批改和讲解也要走同一道闸门（llmOrError）。漏掉的话，
     * 没配模型的用户点「让 AI 批改」会拿到一个看不懂的上游 401。 */
    ['AI 批改', () => POST('/api/ai/grade', { qid: 'q01', answer: 'x' })],
    ['AI 讲解', () => POST('/api/ai/explain', { qid: 'q01' })],
  ];
  for (const [label, call] of aiEndpoints) {
    const r = await call();
    ok(`★ 未配密钥时「${label}」给 NO_LLM 而不是上游 401`,
      r.status === 400 && r.data?.code === 'NO_LLM',
      `实得 ${r.status} ${JSON.stringify(r.data)?.slice(0, 110)}`);
  }

  /* 云端缺密钥时的提示要能指出「是密钥的问题」，
   * 不能只说「还没配置模型」—— 用户明明填了 Base URL 和模型名。 */
  const chatNoKey = await POST('/api/ai/chat', { messages: [{ role: 'user', content: 'hi' }] });
  ok('★ 缺密钥的提示明确提到 API Key',
    String(chatNoKey.data?.error || '').includes('Key'),
    JSON.stringify(chatNoKey.data)?.slice(0, 110));
}

/* AI 的**正常路径**。上面那节只证明了「没配模型会优雅报错」，
 * 而招牌功能跑不跑得通，只有这一节能证明。 */
section('13b. AI 正常路径（对着本地 stub 模型跑通）');
{
  const stub = await startLlmStub();
  try {
    const put = await PUT('/api/settings/llm', {
      enabled: true, kind: 'local', localBase: stub.base, localModel: 'stub-model',
    });
    ok('配置本地模型 200', put.status === 200, `实得 ${put.status}`);

    const read = await GET('/api/settings/llm');
    ok('配置读回一致', read.data?.llm?.localBase === stub.base && read.data?.llm?.kind === 'local',
      JSON.stringify(read.data?.llm)?.slice(0, 140));

    /* ---------- 连通性测试 ---------- */
    const t = await POST('/api/settings/llm/test', {});
    ok('连通性测试 ok=true', t.status === 200 && t.data?.ok === true,
      `实得 ${t.status} ${JSON.stringify(t.data)?.slice(0, 140)}`);
    ok('连通性测试报出耗时', typeof t.data?.ms === 'number', `ms=${t.data?.ms}`);

    /* ---------- 流式答疑 ---------- */
    const chat = await POST('/api/ai/chat', {
      kid, stage: 'explain', persona: 'socratic',
      messages: [{ role: 'user', content: '讲讲极限的定义' }],
    });
    ok('对话返回 200', chat.status === 200, `实得 ${chat.status} ${JSON.stringify(chat.data)?.slice(0, 140)}`);

    const raw = String(chat.data?.raw || '');
    const frames = [...raw.matchAll(/^data: (.+)$/gm)]
      .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
      .filter(Boolean);
    const streamed = frames.map((f) => f.delta || '').join('');
    const doneFrame = frames.find((f) => f.done);

    ok('收到 SSE 增量分片', streamed.length > 0, `拼出 ${streamed.length} 字`);
    ok('★ 收尾帧 done=true 且 full 与增量一致', !!doneFrame && doneFrame.full === streamed,
      `full=${JSON.stringify(doneFrame?.full)?.slice(0, 60)} streamed=${JSON.stringify(streamed)?.slice(0, 60)}`);
    ok('中转没有篡改内容（与 stub 原文一致）', streamed.includes('代进去看看分子分母'),
      JSON.stringify(streamed).slice(0, 80));

    /* ---------- ★ 系统提示词是否真的注入了学情 ----------
     * 这是这个项目区别于「套壳聊天框」的地方：AI 必须知道学生学到哪了。
     * 光测「返回 200」证明不了这件事 —— 必须去上游收到的请求体里翻。 */
    const sent = stub.captured.last;
    const sys = sent?.messages?.find((m) => m.role === 'system')?.content || '';
    ok('★ 上游收到 system 提示词', sys.length > 100, `${sys.length} 字`);
    ok('★ 注入了真实学情快照', /累计作答\s*\d+\s*次/.test(sys),
      (sys.match(/累计作答[^\n]*/) || ['(没找到)'])[0].slice(0, 60));
    ok('★ 注入了当前知识点正文', sys.includes('【当前教学知识点】') && sys.includes('--- 正文 ---'));
    ok('★ 教学铁律「不许直接给答案」在提示词里', sys.includes('不许直接给答案'));
    ok('★ 人格切换生效（socratic → 苏格拉底）', sys.includes('苏格拉底'));
    ok('★ 阶段参数生效（explain）', sys.includes('explain'));
    ok('★ 上游收到 stream:true', sent?.stream === true);
    ok('上游收到的是配置里的模型名', sent?.model === 'stub-model', `实得 ${sent?.model}`);

    /* ---------- 多角色课堂 ---------- */
    const cls = await POST('/api/ai/classroom', { kid, mode: 'lesson', round: 0 });
    ok('课堂返回 200', cls.status === 200, `实得 ${cls.status} ${JSON.stringify(cls.data)?.slice(0, 140)}`);
    const turns = cls.data?.turns || [];
    ok('课堂发言 3-5 条', turns.length >= 3 && turns.length <= 5, `实得 ${turns.length}`);
    ok('★ 三个学生各错各的（发言互不重复）', new Set(turns.map((t) => t.text)).size === turns.length);
    ok('课堂角色名已映射成中文', turns.every((t) => ['老师', '小明', '小红', '小刚'].includes(t.name)),
      turns.map((t) => t.name).join('/'));
    ok('★ 板书是数学步骤（含 LaTeX）', (cls.data?.board || []).some((b) => b.includes('$')),
      JSON.stringify(cls.data?.board?.[0])?.slice(0, 60));
    ok('课堂留下了给学生的提问', String(cls.data?.prompt || '').length > 5,
      JSON.stringify(cls.data?.prompt)?.slice(0, 60));
    ok('课堂没有 parseFailed 标记', cls.data?.parseFailed !== true);

    /* ============================================================
       ★ 课堂阶段状态机（走 HTTP 的那一半）
       ============================================================
       纯逻辑那一半在 tests/classroom.mjs 里测了（分类、推演、提示词、过滤）。
       这里验的是**真的发一次请求之后**接口回给前端的东西对不对 ——
       尤其是「提示词有没有按阶段拼」，只有翻上游收到的请求体才知道。
       两边都要有：纯函数测不出「接口忘了把 phase 传给提示词构造函数」这种漏接。
       ============================================================ */
    const upstreamPrompt = () =>
      String((stub.captured.last?.messages || []).map((m) => m.content).join('\n'));

    ok('★ 首轮判为 lecture（把理论讲透，而不是热身）',
      cls.data?.phase === 'lecture', `实得 ${cls.data?.phase}`);
    ok('★ 首轮结尾是回忆式问题（不出计算题）',
      cls.data?.promptKind === 'recall', `实得 ${cls.data?.promptKind}`);
    ok('★ 上游提示词要求首轮讲透理论',
      upstreamPrompt().includes('把理论讲透'), '提示词里没有「讲透」这条');
    ok('★ 上游提示词放宽了首轮字数（120 字讲不透）',
      upstreamPrompt().includes('400 字'), '还是老的一刀切 120 字');

    /* ---------- 说「不知道」→ 三个学生必须静默 ----------
     * 这是用户报的第一个问题：「我在说不知道的时候，那三个学生还是一直跟着提问」。
     * stub 每轮固定回 4 条（老师 + 三个学生），所以只要过滤没生效，
     * turns 就会是 4 条 —— 断言直接看得出来。 */
    const confused = await POST('/api/ai/classroom', {
      kid, mode: 'lesson', round: 1, userInput: '我不知道',
      lastPrompt: cls.data?.prompt, lastPromptRound: 0, prevPhase: 'lecture',
    });
    ok('说「不知道」→ clarify 阶段', confused.data?.phase === 'clarify', `实得 ${confused.data?.phase}`);
    ok('意图判定为 confused', confused.data?.intent === 'confused', `实得 ${confused.data?.intent}`);
    ok('★ 三个学生全部静默（stub 回了 4 条，只剩老师 1 条）',
      (confused.data?.turns || []).length === 1 && confused.data?.turns?.[0]?.role === 'teacher',
      `实得 ${(confused.data?.turns || []).map((t) => t.role).join('/')}`);
    ok('★ 静默条数如实上报（前端要能显示「同学已安静」）',
      confused.data?.silenced === 3, `实得 ${confused.data?.silenced}`);
    ok('★ 这一轮结尾是理解确认，不是算题',
      confused.data?.promptKind === 'check', `实得 ${confused.data?.promptKind}`);
    ok('★ 上游提示词要求三个学生全部静默',
      upstreamPrompt().includes('三个学生全部静默'), '提示词里没有静默要求');
    ok('★ 上游提示词明令这一轮不许出题',
      upstreamPrompt().includes('不许出题'), '提示词里没有禁出题那条');

    /* ---------- 留痕：老师得知道自己在回答哪一问 ---------- */
    ok('★ 上游提示词带上了「学生正在回答的问题」',
      upstreamPrompt().includes('学生正在回答的问题'), '提示词里没有在回答哪一问的上下文');
    ok('★ 并且标明是第几轮留的',
      upstreamPrompt().includes('第 1 轮老师留的'), '没有轮次标注');
    ok('★ 要求老师先点明在回应哪一问',
      upstreamPrompt().includes('先点明在回应哪一问'), '没有这条要求');

    /* ---------- 模型不听劝时，硬过滤要顶上 ----------
     * 提示词是请求，不是保证。这里故意让 stub 在答疑阶段回一道算题，
     * 验「说好的只讲不考」有没有被兜住。 */
    stub.setRaw(JSON.stringify({
      board: ['换个角度：先看左边的定义'],
      turns: [
        { role: 'teacher', name: '老师', text: '行，我们退回去看定义。' },
        { role: 'xiaoming', name: '小明', text: '那我先求个导试试？' },
      ],
      prompt: '求 $\\lim_{x\\to 0}\\frac{\\sin x}{x}$ 的值',
    }));
    const stillCalc = await POST('/api/ai/classroom', {
      kid, mode: 'lesson', round: 2, userInput: '还是不懂', prevPhase: 'clarify',
    });
    ok('★ 答疑阶段里模型出的算题被拦下来了',
      stillCalc.data?.promptAdjusted === true, `实得 ${stillCalc.data?.promptAdjusted}`);
    ok('★ 被换成理解确认，且明确说了「先不做题」',
      /先不做题/.test(String(stillCalc.data?.prompt || '')), JSON.stringify(stillCalc.data?.prompt)?.slice(0, 80));
    ok('★ 学生插话同样被静默（只剩老师）',
      (stillCalc.data?.turns || []).length === 1, `实得 ${(stillCalc.data?.turns || []).length}`);
    stub.setRaw(null);

    /* ---------- 说「懂了」才进练习 ---------- */
    const gotIt = await POST('/api/ai/classroom', {
      kid, mode: 'lesson', round: 3, userInput: '懂了',
      lastPrompt: stillCalc.data?.prompt, lastPromptRound: 2, prevPhase: 'clarify',
    });
    ok('说「懂了」→ practice 阶段', gotIt.data?.phase === 'practice', `实得 ${gotIt.data?.phase}`);
    ok('★ 练习阶段结尾才是「一道题」',
      gotIt.data?.promptKind === 'practice', `实得 ${gotIt.data?.promptKind}`);
    ok('★ 练习阶段学生恢复发言（不再静默）',
      (gotIt.data?.turns || []).length === 4, `实得 ${(gotIt.data?.turns || []).length}`);

    /* ---------- 答疑阶段里继续追问，不许被推进练习 ----------
     * 这条是「人家还在问，你就让他算」的防线。 */
    const stillAsking = await POST('/api/ai/classroom', {
      kid, mode: 'lesson', round: 4, userInput: '为什么这里一定要加上那个条件？', prevPhase: 'clarify',
    });
    ok('★ 答疑阶段里追问 → 仍留在 clarify',
      stillAsking.data?.phase === 'clarify', `实得 ${stillAsking.data?.phase}`);
    ok('追问的意图判为 question',
      stillAsking.data?.intent === 'question', `实得 ${stillAsking.data?.intent}`);
    ok('★ 答疑阶段里点「继续」但没说话 → 也不许滑进练习',
      (await POST('/api/ai/classroom', { kid, mode: 'lesson', round: 5, userInput: '', prevPhase: 'clarify' }))
        .data?.phase === 'clarify', '没说话就被推去出题了');

    /* ---------- ★ 小模型的不完美输出 ----------
     * 提示词里写着「role 用 teacher|xiaoming|xiaohong|xiaogang」
     * 和「不要 markdown 代码块」，但 9B 级别的小模型基本不听。
     * 这些不是理论情况，是实测会出现的。前端用 `ROLES[turn.role]` 取样式的，
     * 所以角色一旦被压成同一个，「三个学生各错各的」这个卖点就看不见了。 */
    const GOOD = '{"board":["用夹逼"],"turns":['
      + '{"role":"teacher","name":"老师","text":"先看定义"},'
      + '{"role":"xiaoming","name":"小明","text":"是0吧"},'
      + '{"role":"xiaohong","name":"小红","text":"是1但我说不清"},'
      + '{"role":"xiaogang","name":"小刚","text":"去掉条件还成立吗"}'
      + '],"prompt":"你怎么想？"}';
    const roleOf = (d) => (d.turns || []).map((t) => t.role).join(',');

    const MALFORMED = [
      ['包在 ```json 围栏里 + 前后废话',
        '好的，这是课堂内容：\n\n```json\n' + GOOD + '\n```\n\n希望对你有帮助！',
        (d) => d.turns.length === 4],
      ['尾逗号',
        '{"board":["用夹逼",],"turns":[{"role":"teacher","text":"先看定义"},{"role":"xiaoming","text":"是0吧"},{"role":"xiaohong","text":"是1"},{"role":"xiaogang","text":"为什么"},],"prompt":"你怎么想？",}',
        (d) => d.turns.length === 4],
      ['role 写成中文',
        GOOD.replace(/"role":"teacher"/g, '"role":"老师"').replace(/"role":"xiaoming"/g, '"role":"小明"')
            .replace(/"role":"xiaohong"/g, '"role":"小红"').replace(/"role":"xiaogang"/g, '"role":"小刚"'),
        (d) => new Set(d.turns.map((t) => t.role)).size === 4],
      ['只给 name 不给 role',
        GOOD.replace(/"role":"(teacher|xiaoming|xiaohong|xiaogang)",/g, ''),
        (d) => new Set(d.turns.map((t) => t.role)).size === 4],
      ['turns 写成字符串数组（带名字前缀）',
        '{"board":["用夹逼"],"turns":["老师：先看定义","小明：是0吧","小红：是1","小刚：去掉条件呢"],"prompt":"你怎么想？"}',
        (d) => d.turns.length === 4 && new Set(d.turns.map((t) => t.role)).size === 4],
    ];

    for (const [label, payload, check] of MALFORMED) {
      stub.setRaw(payload);
      const r = await POST('/api/ai/classroom', { kid, mode: 'lesson' });
      const d = r.data || {};
      ok(`★ 能救回「${label}」`, r.status === 200 && check(d),
        `turns=${d.turns?.length} roles=${roleOf(d)} parseFailed=${d.parseFailed === true}`);
    }

    /* 救不回来的，必须明确报 parseFailed ——
     * 以前「模型给了 turns 但一条都救不回」时会返回 parseFailed=false，
     * 前端拿到「有板书、有问题、没有讨论」的半个课堂，看不出哪里坏了。 */
    for (const [label, payload] of [
      ['纯散文（完全不按格式）', '同学们，今天我们来讲极限。首先大家回忆一下……'],
      ['turns 全是空对象', '{"board":["x"],"turns":[{},{},{}],"prompt":"q"}'],
    ]) {
      stub.setRaw(payload);
      const r = await POST('/api/ai/classroom', { kid, mode: 'lesson' });
      ok(`★ 救不回的「${label}」明确报 parseFailed`,
        r.status === 200 && r.data?.parseFailed === true && (r.data?.turns || []).length === 0,
        `parseFailed=${r.data?.parseFailed} turns=${r.data?.turns?.length}`);
    }

    /* 字符串数组、但没有名字前缀 —— 兜成老师可以接受，
     * 但绝不能整条丢掉（那是静默丢内容）。 */
    stub.setRaw('{"board":["用夹逼"],"turns":["先看定义","是0吧"],"prompt":"你怎么想？"}');
    const noPrefix = await POST('/api/ai/classroom', { kid, mode: 'lesson' });
    ok('★ 字符串数组没前缀也不丢内容', (noPrefix.data?.turns || []).length === 2,
      `turns=${noPrefix.data?.turns?.length}`);

    stub.setRaw(null);

    /* ---------- 错因归类 ----------
     * 验两件事：
     *   1. 标准 JSON 能解析出 errorType
     *   2. **模型说人话时也能认出类别** —— 小模型基本不会老老实实只输出 JSON，
     *      这条才是实际可用性的关键。分类失败等于这个功能完全没用。 */
    const mis = await GET('/api/study/mistakes');
    const mq = mis.data?.mistakes?.[0]?.qid;
    ok('错因归类有题可测', !!mq);

    if (mq) {
      stub.setRaw('{"errorType":"concept","reason":"把可导和连续混为一谈"}');
      const et = await POST('/api/ai/error-type', { qid: mq });
      ok('错因归类 200', et.status === 200, `实得 ${et.status}`);
      ok('识别出概念类', et.data?.errorType === 'concept', `实得 ${et.data?.errorType}`);
      ok('给出中文标签', et.data?.label === '概念混淆', `实得 ${et.data?.label}`);
      ok('概念类附带图谱回溯建议', !!et.data?.rootHint,
        JSON.stringify(et.data?.rootHint)?.slice(0, 90));

      stub.setRaw('这道题的错误类型是「概念不清」，学生把两个定理记混了。');
      const et2 = await POST('/api/ai/error-type', { qid: mq });
      ok('★ 模型说人话（不输出 JSON）时也能认出类别',
        et2.data?.errorType === 'concept', `实得 ${et2.data?.errorType}`);

      stub.setRaw('学生算错了一个符号，属于运算失误。');
      const et3 = await POST('/api/ai/error-type', { qid: mq });
      ok('★ 同义变体「运算失误」能归到 calc',
        et3.data?.errorType === 'calc', `实得 ${et3.data?.errorType}`);

      const stats = await GET('/api/ai/error-stats');
      ok('错因统计 200', stats.status === 200);
      ok('统计里有已判定的错因', (stats.data?.judged || 0) > 0,
        JSON.stringify(stats.data)?.slice(0, 110));
      ok('统计给出人话建议', typeof stats.data?.advice === 'string' && stats.data.advice.length > 5,
        JSON.stringify(stats.data?.advice)?.slice(0, 70));

      /* 批量接口只处理「还没判过」的错题，所以这里不断言 items 非空 ——
       * 上面单题已经把第一道判过了，批量跳过它是**正确行为**。 */
      stub.setRaw(`[{"qid":"${mq}","errorType":"calc","reason":"符号写错"}]`);
      const batch = await POST('/api/ai/error-types', { limit: 3 });
      ok('批量错因归类 200', batch.status === 200, `实得 ${batch.status}`);
      ok('批量返回 items 数组', Array.isArray(batch.data?.items));
      ok('批量不重复消耗已判过的题', (batch.data?.items || []).every((x) => x.qid !== mq),
        `实得 ${JSON.stringify(batch.data?.items)?.slice(0, 110)}`);
    }

    stub.setRaw(null);

    /* ---------- 变式题生成（举一反三）----------
     * 这个功能最容易出的错是「生成的题判不了分」：模型爱出开放题、
     * 根号答案、多解题，而判题器只对数值做容差比对。
     * 一旦混进去，用户答对了系统说错 —— 比没有这个功能还糟。
     * 所以下面一半断言是在验「判不了的题有没有被拦住」。 */
    const GOOD_Q = JSON.stringify([
      {
        type: 'choice', difficulty: 2,
        stem: '求极限 $\\lim_{x\\to 0}\\frac{\\sin 5x}{x}$ 的值',
        options: [{ k: 'A', t: '5' }, { k: 'B', t: '1' }, { k: 'C', t: '0' }, { k: 'D', t: '不存在' }],
        answer: 'A', analysis: '拆成 $5\\cdot\\frac{\\sin 5x}{5x}$，由重要极限得 5。',
      },
      {
        type: 'blank', difficulty: 3,
        stem: '计算 $\\lim_{x\\to 0}\\frac{e^x-1}{x}$ 的值',
        answer: '1', analysis: '等价无穷小代换。',
      },
    ]);

    stub.setRaw(GOOD_Q);
    const gen = await POST('/api/ai/generate', { kid, count: 3 });
    ok('变式题生成 200', gen.status === 200, `实得 ${gen.status}`);
    ok('生成出题目', (gen.data?.created?.length || 0) > 0, JSON.stringify(gen.data)?.slice(0, 140));
    ok('生成的题都有答案', gen.data?.created?.every((q) => !!q.answer));
    ok('生成的题都有解析', gen.data?.created?.every((q) => !!q.analysis));

    /* 最要紧的一条：生成的题必须能被判题器判对、也能判错 */
    const genQ = gen.data?.created?.[0];
    if (genQ) {
      const right = await POST('/api/study/answer', { qid: genQ.id, answer: genQ.answer, context: 'quiz' });
      ok('★ 生成题的标准答案能判对', right.status === 200 && right.data?.correct === true,
        `status=${right.status} correct=${right.data?.correct} answer=${genQ.answer}`);
      const wrongAns = genQ.type === 'choice' ? 'Z' : '99999';
      const wrong = await POST('/api/study/answer', { qid: genQ.id, answer: wrongAns, context: 'quiz' });
      ok('★ 生成题的错答案能判错', wrong.data?.correct === false, `correct=${wrong.data?.correct}`);
    }

    /* 落库后要能出现在题库里，否则用户生成了却找不到 */
    const list = await GET(`/api/catalog/questions?kid=${kid}&limit=50`);
    const listedIds = (list.data?.questions || []).map((q) => q.id);
    ok('★ 生成的题出现在题库里',
      (gen.data?.created || []).every((q) => listedIds.includes(q.id)),
      `生成 ${gen.data?.created?.length} 道，题库里 g_ 开头的有 ${listedIds.filter((i) => i.startsWith('g_')).length} 道`);

    /* 判不了的题必须被拦住 —— 这一组全都是判题器处理不了的形状 */
    stub.setRaw(JSON.stringify([
      { type: 'blank', difficulty: 2, stem: '证明这个数列收敛', answer: '无解' },
      { type: 'blank', difficulty: 2, stem: '求这个长度的值是多少', answer: '\\sqrt{2}' },
      { type: 'blank', difficulty: 2, stem: '求所有解的值分别是多少', answer: 'x_1=1, x_2=2' },
      { type: 'choice', difficulty: 2, stem: '这是一道只有三个选项的题', options: [{ k: 'A', t: '1' }, { k: 'B', t: '2' }, { k: 'C', t: '3' }], answer: 'A' },
    ]));
    const badGen = await POST('/api/ai/generate', { kid, count: 3 });
    ok('★ 判不了分的题全部被丢弃', (badGen.data?.created?.length || 0) === 0,
      `实际生成了 ${badGen.data?.created?.length} 道`);
    ok('★ 一道都出不来时明确报 parseFailed', badGen.data?.parseFailed === true);
    ok('丢弃的题有计数（前端要能说明原因）', (badGen.data?.skippedUnjudgeable || 0) >= 3,
      `实得 ${badGen.data?.skippedUnjudgeable}`);

    /* LaTeX 分数与方程答案要被转成判题器认识的形式，而不是直接丢掉 */
    stub.setRaw(JSON.stringify([
      { type: 'blank', difficulty: 2, stem: '计算这个极限的值是多少', answer: '\\frac{1}{2}' },
      { type: 'blank', difficulty: 2, stem: '求这个方程的解的值是多少', answer: 'x=2' },
    ]));
    const fixed = await POST('/api/ai/generate', { kid, count: 2 });
    ok('★ LaTeX 分数答案被转成 1/2 形式', (fixed.data?.created || []).some((q) => q.answer === '1/2'),
      JSON.stringify((fixed.data?.created || []).map((q) => q.answer)));
    ok('★ 方程答案被剥成纯值', (fixed.data?.created || []).some((q) => q.answer === '2'),
      JSON.stringify((fixed.data?.created || []).map((q) => q.answer)));

    stub.setRaw(null);

    /* ---------- AI 批改（解答题 / 证明题）----------
     *
     * 这一节守的核心是「算术不交给模型」：满分从库里的评分点求和、
     * 总分从各步相加。模型给的数一律不听 —— 它会在总分上写一个和分步
     * 对不上的数，用户一眼就看出来，然后整个功能就不可信了。 */
    const solveList = await GET('/api/catalog/questions?type=solve&limit=5');
    const solveId = solveList.data?.questions?.[0]?.id;
    ok('题库里有解答题可供批改', !!solveId, JSON.stringify(solveList.data)?.slice(0, 120));

    if (solveId) {
      /* 列表接口不给答案与评分点（考试中不能泄露），所以再拉一次单题详情 */
      const solveQ = await GET(`/api/catalog/questions/${solveId}`);
      const stepN = (solveQ.data?.question?.steps || []).length;
      ok('解答题带评分点', stepN >= 2, `${stepN} 条`);

      stub.setRaw(null);
      const g = await POST('/api/ai/grade', { qid: solveId, answer: '我的解答：先求导，再代入。' });
      ok('AI 批改返回 200', g.status === 200, `实得 ${g.status} ${JSON.stringify(g.data)?.slice(0, 140)}`);
      ok('★ 批改成功', g.data?.ok === true, JSON.stringify(g.data)?.slice(0, 140));
      ok('★ 逐条给出得分（条数与评分点一致）',
        (g.data?.steps?.length || 0) === stepN, `实得 ${g.data?.steps?.length} / ${stepN}`);
      ok('★ 总分 = 各步得分之和（不是模型报的那个数）',
        (g.data?.steps || []).reduce((a, s) => a + s.got, 0) === g.data?.score,
        `score=${g.data?.score} Σgot=${(g.data?.steps || []).reduce((a, s) => a + s.got, 0)}`);
      ok('★ 满分 = 各评分点分值之和（分母来自库里）',
        (g.data?.steps || []).reduce((a, s) => a + s.pts, 0) === g.data?.full,
        `full=${g.data?.full}`);
      ok('每步得分都落在 [0, 该步满分] 内',
        (g.data?.steps || []).every((s) => s.got >= 0 && s.got <= s.pts));
      ok('批改带总评', !!g.data?.comment);
      ok('批改标明用的哪个模型', !!g.data?.model);

      /* 客观题不该走这条路 —— 它有确定答案，让模型介入是倒退 */
      const onChoice = await POST('/api/ai/grade', { qid: 'q01', answer: 'A' });
      ok('★ 客观题请求 AI 批改被拒（400）', onChoice.status === 400,
        `实得 ${onChoice.status} ${JSON.stringify(onChoice.data)?.slice(0, 100)}`);

      const empty = await POST('/api/ai/grade', { qid: solveId, answer: '   ' });
      ok('空作答被拒（400）', empty.status === 400, `实得 ${empty.status}`);

      const noSuch = await POST('/api/ai/grade', { qid: 'no-such-q', answer: 'x' });
      ok('批改不存在的题返回 404', noSuch.status === 404, `实得 ${noSuch.status}`);

      /* ★ 模型输出解析不了时：200 + ok:false，不是 5xx。
       *   5xx 会走全局错误提示，用户看到「出错了」——
       *   而实际上自评那条路还在，功能是可用的。 */
      stub.setRaw('这道题我不会批，你自己看吧。');
      const broken = await POST('/api/ai/grade', { qid: solveId, answer: '我的解答' });
      ok('★ 模型输出解析不了时返回 200 + ok:false（回退自评，不是报错）',
        broken.status === 200 && broken.data?.ok === false && broken.data?.parseFailed === true,
        `status=${broken.status} ${JSON.stringify(broken.data)?.slice(0, 120)}`);
      ok('解析失败时把模型原文带回来（便于排查）', typeof broken.data?.raw === 'string');
      stub.setRaw(null);
    }

    /* ---------- AI 讲透一道题 ---------- */
    {
      const target = solveId || 'q01';
      const ex = await POST('/api/ai/explain', { qid: target });
      ok('AI 讲解返回 200', ex.status === 200, `实得 ${ex.status} ${JSON.stringify(ex.data)?.slice(0, 120)}`);
      ok('讲解有实质内容', (ex.data?.text || '').length > 20, `${(ex.data?.text || '').length} 字`);
      const miss = await POST('/api/ai/explain', { qid: 'no-such-question' });
      ok('讲解不存在的题返回 404', miss.status === 404, `实得 ${miss.status}`);
    }

    /* ---------- AI 生成主观题 ---------- */
    {
      stub.setRaw(JSON.stringify([
        {
          type: 'solve', difficulty: 3,
          stem: '求 $\\lim_{x\\to 0}\\frac{\\tan x-\\sin x}{x^{3}}$',
          answer: '\\frac{1}{2}',
          analysis: '化成 sin x(1-cos x)/(x³cos x)。',
          steps: [
            { t: '通分并提取 sin x', pts: 4 },
            { t: '用 1-cos x ~ x²/2', pts: 4 },
            { t: '代入得 1/2', pts: 2 },
          ],
        },
        /* 只有一条评分点的要作废：一条评分点的「分步给分」等于不分步，
         * 而且 AI 批改也没法指出「卡在哪一步」 */
        { type: 'solve', difficulty: 2, stem: '求这个极限的值是多少', answer: '1', steps: [{ t: '算出结果', pts: 10 }] },
        /* 完全没有评分点的更要作废 */
        { type: 'proof', difficulty: 2, stem: '证明这个数列收敛', answer: '由单调有界准则可知收敛。' },
      ]));
      const sub = await POST('/api/ai/generate', { kid, count: 3, mode: 'subjective' });
      ok('主观题生成返回 200', sub.status === 200, `实得 ${sub.status}`);
      const made = sub.data?.created || [];
      ok('★ 生成出主观题', made.length >= 1, JSON.stringify(sub.data)?.slice(0, 160));
      ok('★ 生成的都是解答题 / 证明题',
        made.length > 0 && made.every((q) => q.type === 'solve' || q.type === 'proof'),
        JSON.stringify(made.map((q) => q.type)));
      ok('★ 每条都带评分点', made.length > 0 && made.every((q) => (q.steps || []).length >= 2),
        JSON.stringify(made.map((q) => (q.steps || []).length)));
      ok('★ 带题型中文名与自评标记（作答卡靠这两个字段渲染）',
        made.length > 0 && made.every((q) => !!q.typeLabel && q.selfGraded === true),
        JSON.stringify(made.map((q) => [q.typeLabel, q.selfGraded])));
      ok('没有评分点 / 评分点太少的题被丢弃', (sub.data?.skippedUnjudgeable || 0) >= 2,
        `实得 ${sub.data?.skippedUnjudgeable}`);

      /* 生成的主观题落库后要能作答，而且走的是「亮答案 → 判分」那条路 */
      const genSolve = made[0];
      if (genSolve) {
        const listed = await GET(`/api/catalog/questions?kid=${kid}&limit=50`);
        ok('★ 生成的主观题出现在题库里',
          (listed.data?.questions || []).some((q) => q.id === genSolve.id));
        const first = await POST('/api/study/answer', { qid: genSolve.id, answer: '我的过程', context: 'quiz' });
        ok('★ 生成的主观题先返回参考答案（correct=null，不记账）',
          first.data?.correct === null && first.data?.selfGrade === true,
          `correct=${first.data?.correct} selfGrade=${first.data?.selfGrade}`);
        ok('★ 参考答案带回评分点', (first.data?.steps || []).length >= 2,
          `${(first.data?.steps || []).length} 条`);

        /* 批改一道刚生成的题：走完整链路。
         * ★ 先把 setRaw 清掉 —— 不清的话 stub 还在吐那段「出题 JSON」，
         *   批改接口拿到的就是一堆题而不是批改结果，报 parseFailed。
         *   这是 stub 的状态，不是产品的问题。 */
        stub.setRaw(null);
        const g2 = await POST('/api/ai/grade', { qid: genSolve.id, answer: '我的过程' });
        ok('★ 生成的主观题能被 AI 批改', g2.data?.ok === true, JSON.stringify(g2.data)?.slice(0, 140));
      }
      stub.setRaw(null);
    }

    /* ---------- AI 批量生成 ----------
     *
     * 单考点生成是「点补」（这道错了，给我几道同类型的）；
     * 批量是「面补」（这一章一道大题都没有）。
     *
     * 这里最要紧的一条断言是「上游全挂时每个考点各记一笔失败」——
     * 如果实现成「第一个考点失败就整批抛异常」，用户等一分钟只拿到一个 500，
     * 而前面考点已经生成好的题也一并丢了。这正是批量接口存在的意义之一。 */
    {
      const tr = await GET('/api/catalog/tree');
      const ns = [];
      for (const c of tr.data?.categories || []) {
        for (const ch of c.chapters || []) {
          for (const n of ch.nodes || []) ns.push(n.id);
        }
      }
      const three = ns.slice(0, 3);
      ok('拿得到考点列表（批量生成要用）', three.length === 3, `实得 ${three.length}`);

      const BATCH_Q = JSON.stringify([
        {
          type: 'choice', difficulty: 2, stem: '批量生成的选择题一',
          options: [{ k: 'A', t: '1' }, { k: 'B', t: '2' }, { k: 'C', t: '3' }, { k: 'D', t: '4' }],
          answer: 'A', analysis: '略。',
        },
        { type: 'blank', difficulty: 2, stem: '批量生成的填空题二', answer: '1', analysis: '略。' },
      ]);
      stub.setRaw(BATCH_Q);

      const b = await POST('/api/ai/generate-batch', { kids: three, perKid: 2 });
      ok('批量生成返回 200', b.status === 200, `实得 ${b.status} ${JSON.stringify(b.data)?.slice(0, 160)}`);
      ok('★ 每个考点都出了题（不是只有第一个）',
        three.every((k) => (b.data?.perKid?.[k] || 0) > 0),
        JSON.stringify(b.data?.perKid));
      ok('★ 每个考点不超过要求的道数',
        three.every((k) => (b.data?.perKid?.[k] || 0) <= 2),
        JSON.stringify(b.data?.perKid));
      ok('上报的考点数对得上', b.data?.requested === 3, `实得 ${b.data?.requested}`);
      ok('正常批次里没有 failed', (b.data?.failed || []).length === 0,
        JSON.stringify(b.data?.failed)?.slice(0, 160));

      /* 无效考点要单独报出来 —— 混进 failed 会让人以为是模型坏了，
       * 然后去查上游，实际只是前端传了个不存在的 id。 */
      const mixed = await POST('/api/ai/generate-batch', { kids: [three[0], 'no-such-kid'] });
      ok('★ 不存在的考点进 unknownKids', (mixed.data?.unknownKids || []).length === 1,
        JSON.stringify(mixed.data?.unknownKids));
      ok('★ 无效考点不影响有效考点出题', (mixed.data?.total || 0) > 0,
        `total=${mixed.data?.total}`);

      /* 一个考点都不认时应当明确报 404，而不是空手返回 200 假装成功 */
      const none = await POST('/api/ai/generate-batch', { kids: ['nope-1', 'nope-2'] });
      ok('全是无效考点时返回 404', none.status === 404, `实得 ${none.status}`);

      stub.setMode('500');
      const allFail = await POST('/api/ai/generate-batch', { kids: three, perKid: 1 });
      ok('★ 上游全挂时接口仍返回 200（不是整批抛异常）',
        allFail.status === 200, `实得 ${allFail.status}`);
      ok('★★ 每个失败考点都记了一笔（说明没有在第一个就中断）',
        (allFail.data?.failed || []).length === 3,
        `实得 ${(allFail.data?.failed || []).length} 笔`);
      ok('全挂时 total 为 0 且 ok=false',
        allFail.data?.total === 0 && allFail.data?.ok === false,
        JSON.stringify({ total: allFail.data?.total, ok: allFail.data?.ok }));
      stub.setMode('ok');
      stub.setRaw(null);
    }

    /* ---------- 错误路径 ---------- */
    stub.setMode('401');
    const bad = await POST('/api/ai/classroom', { kid, mode: 'lesson' });
    ok('上游 401 时状态码透传', bad.status === 401, `实得 ${bad.status}`);

    stub.setMode('ok');
    await PUT('/api/settings/llm', {
      kind: 'local', localBase: 'http://127.0.0.1:1/v1', localModel: 'nobody',
    });
    const dead = await POST('/api/ai/classroom', { kid, mode: 'lesson' });
    ok('连不上模型时返回 502', dead.status === 502, `实得 ${dead.status} ${JSON.stringify(dead.data)?.slice(0, 120)}`);
    ok('502 的报错可读（带「连不上模型服务」）', String(dead.data?.error || '').includes('连不上模型服务'),
      JSON.stringify(dead.data?.error)?.slice(0, 80));
  } finally {
    // 收干净：别把 stub 地址留在库里，否则后面几节跑的是「配了模型」的状态
    await PUT('/api/settings/llm', { enabled: false, kind: 'local', localBase: '', localModel: '' });
    await stub.stop();
  }
}

section('13c. 录题（自建题的增删改与判分）');
{
  /* 录题这条链最容易出的错是「录进去却判不了分」——
   * 用户之后每次答对都被判错，而且看不出哪里不对。
   * 所以下面一半断言是在验「判不了的答案有没有被拦住」。 */

  // 1. 录一道选择题
  const c1 = await POST('/api/questions', {
    kid,
    type: 'choice',
    difficulty: 3,
    stem: '设数列 $\\{x_n\\}$ 满足 $x_n \\to 2$，则下列哪个说法一定成立？',
    options: [
      { k: 'A', t: '$x_n$ 单调递增' }, { k: 'B', t: '$x_n$ 有界' },
      { k: 'C', t: '$x_n > 1$' }, { k: 'D', t: '$x_n$ 收敛到 0' },
    ],
    answer: 'B',
    analysis: '收敛数列必有界。',
    sourceType: '真题',
    sourceYear: 2023,
  });
  ok('录选择题 200', c1.status === 200 && c1.data?.ok === true,
    `实得 ${c1.status} ${JSON.stringify(c1.data)?.slice(0, 100)}`);
  const myQid = c1.data?.question?.id;
  ok('自建题 id 前缀是 u_', String(myQid).startsWith('u_'), `实得 ${myQid}`);

  // 2. 录一道填空题，LaTeX 分数应被规范化
  const c2 = await POST('/api/questions', {
    kid, type: 'blank', stem: '计算这个极限的值是多少', answer: '\\frac{1}{2}', difficulty: 2,
  });
  ok('录填空题 200', c2.status === 200, `实得 ${c2.status}`);
  ok('★ LaTeX 分数被规范成 1/2', c2.data?.question?.answer === '1/2',
    `实得 ${c2.data?.question?.answer}`);

  // 3. 判不了分的答案必须被拒，且理由要能看懂
  const rej = [
    ['根号答案', { kid, type: 'blank', stem: '计算长度的值是多少', answer: '\\sqrt{2}' }],
    ['中文答案', { kid, type: 'blank', stem: '判断这个方程解的情况', answer: '无解' }],
    ['多解', { kid, type: 'blank', stem: '求所有解的值分别是多少', answer: 'x_1=1, x_2=2' }],
    ['三个选项', { kid, type: 'choice', stem: '这是一道只有三个选项的题', options: [{ k: 'A', t: '1' }, { k: 'B', t: '2' }, { k: 'C', t: '3' }], answer: 'A' }],
    ['有选项没填内容', { kid, type: 'choice', stem: '这是一道有选项没填内容的题', options: [{ k: 'A', t: '1' }, { k: 'B', t: '' }, { k: 'C', t: '3' }, { k: 'D', t: '4' }], answer: 'A' }],
    ['答案不是字母', { kid, type: 'choice', stem: '这是一道答案不是字母的题', options: [{ k: 'A', t: '1' }, { k: 'B', t: '2' }, { k: 'C', t: '3' }, { k: 'D', t: '4' }], answer: '对' }],
    ['考点不存在', { kid: '不存在的考点', stem: '这是一道考点不存在的题', answer: '1' }],
    ['题干太短', { kid, type: 'blank', stem: '求值', answer: '1' }],
  ];
  for (const [label, body] of rej) {
    const r = await POST('/api/questions', body);
    ok(`★ 拒绝「${label}」`, r.status === 400, `实得 ${r.status} ${JSON.stringify(r.data)?.slice(0, 80)}`);
    ok(`「${label}」的拒绝理由可读`, typeof r.data?.error === 'string' && r.data.error.length > 4);
  }

  // 4. 录的题要出现在题库里，并带 mine 标记
  const list = await GET(`/api/catalog/questions?kid=${kid}&limit=200`);
  const mineRow = (list.data?.questions || []).find((q) => q.id === myQid);
  ok('录的题出现在题库里', !!mineRow);
  ok('★ 自建题带 mine 标记（前端靠它决定能不能改删）', mineRow?.mine === true);
  /* 内置题的 id 是 q01 这种；u_ 是手工录的、g_ 是 AI 生成的，
   * 后两者都属于当前用户，只有 q 开头才是真正「不是我的」。 */
  const builtinRow = (list.data?.questions || []).find((q) => /^q\d+$/.test(q.id));
  ok('内置题 mine 为 false', builtinRow?.mine === false,
    `实得 ${JSON.stringify(builtinRow)?.slice(0, 80)}`);

  // 5. 录的题要能被判对也能被判错 —— 这是录题功能的成败点
  const right = await POST('/api/study/answer', { qid: myQid, answer: 'B', context: 'quiz' });
  ok('★ 自建题的正确答案能判对', right.data?.correct === true, `correct=${right.data?.correct}`);
  const wrong = await POST('/api/study/answer', { qid: myQid, answer: 'A', context: 'quiz' });
  ok('★ 自建题的错答案能判错', wrong.data?.correct === false);

  // 6. 部分更新：只传题干，不该被「缺 options」拒掉
  const up = await PUT(`/api/questions/${myQid}`, { stem: '改过之后的题干内容够长了' });
  ok('★ 部分更新能成功（只传题干）', up.status === 200,
    `实得 ${up.status} ${JSON.stringify(up.data)?.slice(0, 90)}`);
  ok('题干已更新', String(up.data?.question?.stem).includes('改过之后'));
  ok('★ 没传的字段沿用原值（考点没被挪走）', up.data?.question?.kid === kid,
    `实得 ${up.data?.question?.kid}`);
  ok('★ 没传的字段沿用原值（选项还在）', (up.data?.question?.options || []).length === 4,
    `实得 ${(up.data?.question?.options || []).length} 个选项`);

  // 7. 内置题改不了也删不了
  const bUp = await PUT('/api/questions/q01', { stem: '试图改内置题' });
  ok('内置题改不了（404）', bUp.status === 404, `实得 ${bUp.status}`);
  const bDel = await DELETE('/api/questions/q01');
  ok('内置题删不了（404）', bDel.status === 404, `实得 ${bDel.status}`);

  // 8. 删自己的题，作答记录要一起清掉
  const beforeDel = await GET('/api/study/snapshot');
  const del = await DELETE(`/api/questions/${myQid}`);
  ok('删自己的题 200', del.status === 200, `实得 ${del.status}`);
  const afterDel = await GET('/api/study/snapshot');
  ok('★ 删题带走它的作答记录', afterDel.data?.snapshot?.attempts === beforeDel.data?.snapshot?.attempts - 2,
    `${beforeDel.data?.snapshot?.attempts} → ${afterDel.data?.snapshot?.attempts}`);

  const gone = await GET(`/api/catalog/questions?kid=${kid}&limit=200`);
  ok('删掉的题不在题库里了', !(gone.data?.questions || []).some((q) => q.id === myQid));
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

section('16. 管理员与权限');
/* 这一节测的是「权限真的被挡住了」，不是「按钮藏起来了」。
 * 前端把管理入口藏掉只是不碍眼 —— 手敲 /admin、直接 curl 接口都绕得过去，
 * 所以每一条都必须打到服务端上验。
 *
 * 引导管理员由服务端启动时自动创建，见 db/migrate.js。
 * 凭据取 ADMIN_EMAIL / ADMIN_PASSWORD（npm test 起的临时服务会用同一组）。 */
{
  /* ---------- 16.1 普通用户越权 ----------
   * 此刻 jar 里还是上一个普通用户的会话（第 15 节末尾恢复的）。
   * 专门用它去撞管理接口 —— 这是本节最有价值的一组断言：
   * 前端把入口藏掉不算数，服务端必须自己挡。 */
  const denyRead = await GET('/api/admin/users');
  ok('普通用户读用户列表 403', denyRead.status === 403, `实得 ${denyRead.status}`);
  ok('403 带 FORBIDDEN 码', denyRead.data?.code === 'FORBIDDEN', JSON.stringify(denyRead.data));
  ok('403 里不含任何用户数据', !JSON.stringify(denyRead.data).includes('@'), JSON.stringify(denyRead.data).slice(0, 80));

  const denyOverview = await GET('/api/admin/overview');
  ok('普通用户读总览 403', denyOverview.status === 403, `实得 ${denyOverview.status}`);

  const denyWrite = await PATCH('/api/admin/users/1', { role: 'admin' });
  ok('★ 普通用户改别人角色 403', denyWrite.status === 403, `实得 ${denyWrite.status}`);

  const denyDelete = await DEL('/api/admin/users/1');
  ok('★ 普通用户删账号 403', denyDelete.status === 403, `实得 ${denyDelete.status}`);

  const denyLogs = await GET('/api/admin/logs');
  ok('普通用户读审计日志 403', denyLogs.status === 403, `实得 ${denyLogs.status}`);

  /* ---------- 16.2 管理员登录 ---------- */
  jar.clear();
  const badPwd = await POST('/api/auth/login', { email: ADMIN_EMAIL, password: '肯定不是这个' });
  ok('管理员错误密码被拒 401', badPwd.status === 401, `实得 ${badPwd.status}`);

  const adm = await POST('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  ok('引导管理员能登录', adm.status === 200, JSON.stringify(adm.data).slice(0, 120));
  ok('★ /me 里带 role=admin', adm.data?.user?.role === 'admin', `实得 ${adm.data?.user?.role}`);
  const adminId = adm.data?.user?.id;
  ok('管理员 id 有效', Number.isInteger(adminId), `实得 ${adminId}`);

  /* ---------- 16.3 总览 ---------- */
  const ov = await GET('/api/admin/overview');
  ok('总览 200', ov.status === 200, JSON.stringify(ov.data)?.slice(0, 140));
  ok('总览统计了用户数', (ov.data?.totals?.users || 0) >= 3, `实得 ${ov.data?.totals?.users}`);
  ok('总览统计了管理员数', ov.data?.totals?.admins >= 1, `实得 ${ov.data?.totals?.admins}`);
  ok('总览含全库作答数', typeof ov.data?.activity?.attempts === 'number', JSON.stringify(ov.data?.activity));
  ok('总览返回最近注册的用户', Array.isArray(ov.data?.recentUsers), '');

  /* ---------- 16.4 列表与隐私 ---------- */
  const list = await GET('/api/admin/users?limit=200');
  ok('用户列表 200', list.status === 200);
  ok('列表返回了多个用户', (list.data?.users?.length || 0) >= 3, `实得 ${list.data?.users?.length}`);
  ok('列表带学情统计', typeof list.data?.users?.[0]?.stats?.level === 'number',
    JSON.stringify(list.data?.users?.[0]?.stats));
  ok('列表带角色与状态', !!list.data?.users?.[0]?.role && !!list.data?.users?.[0]?.status,
    JSON.stringify(list.data?.users?.[0])?.slice(0, 140));

  const listRaw = JSON.stringify(list.data);
  ok('★ 列表不泄露密码哈希/盐', !/password_(hash|salt)/.test(listRaw));
  ok('★ 列表不泄露任何人的 API Key', !listRaw.includes('cloud_key') && !listRaw.includes('sk-'));
  ok('列表不含聊天记录正文', !listRaw.includes('"history"'));

  /* 搜索词从管理员邮箱里取，别写死 —— 写死的话换个引导邮箱这条就废了
   * （以前写的是某个真实邮箱的片段）。 */
  const search = await GET(`/api/admin/users?q=${encodeURIComponent(ADMIN_EMAIL)}`);
  ok('按邮箱/昵称搜索生效', (search.data?.users || []).length === 1
    && search.data.users[0].email === ADMIN_EMAIL, JSON.stringify(search.data?.users?.map((u) => u.email)));
  const noHit = await GET('/api/admin/users?q=绝对搜不到的东西zzz');
  ok('搜不到时返回空列表而非报错', noHit.status === 200 && noHit.data?.users?.length === 0, `实得 ${noHit.data?.users?.length}`);

  const byRole = await GET('/api/admin/users?role=admin');
  ok('按角色筛选生效', (byRole.data?.users || []).every((u) => u.role === 'admin'), '');
  const byStatus = await GET('/api/admin/users?status=disabled');
  ok('按状态筛选生效', (byStatus.data?.users || []).every((u) => u.status === 'disabled'), '');

  /* 排序是**白名单映射**，不是把前端字符串拼进 ORDER BY。
   * 这条断言验的就是那个白名单：注入串会被当成未知 key 落回默认排序。 */
  const injectSort = await GET(`/api/admin/users?sort=${encodeURIComponent('1;DROP TABLE users')}`);
  ok('★ 排序参数注入被白名单挡住', injectSort.status === 200, `实得 ${injectSort.status}`);
  const stillAlive = await GET('/api/admin/users');
  ok('★ 注入尝试后 users 表还在', stillAlive.status === 200 && (stillAlive.data?.users?.length || 0) >= 3,
    `实得 ${stillAlive.data?.users?.length}`);

  /* ---------- 16.5 新建 ---------- */
  const TARGET = `managed_${Date.now()}@test.local`;
  const created = await POST('/api/admin/users', {
    email: TARGET, username: '被管理的', password: 'Managed2027!', role: 'user', note: '冒烟测试建的',
  });
  ok('管理员新建用户 200', created.status === 200, JSON.stringify(created.data)?.slice(0, 140));
  const tid = created.data?.user?.id;
  ok('新用户带备注', created.data?.user?.note === '冒烟测试建的', created.data?.user?.note);
  ok('新用户默认 active', created.data?.user?.status === 'active', created.data?.user?.status);

  const dup = await POST('/api/admin/users', { email: TARGET, username: 'x', password: 'Managed2027!' });
  ok('重复邮箱被拒 409', dup.status === 409, `实得 ${dup.status}`);
  const weakNew = await POST('/api/admin/users', { email: `w_${Date.now()}@t.local`, username: 'x', password: '123' });
  ok('新建时的弱密码被拒 400', weakNew.status === 400, `实得 ${weakNew.status}`);
  const badMail = await POST('/api/admin/users', { email: '不是邮箱', username: 'x', password: 'Managed2027!' });
  ok('新建时的非法邮箱被拒 400', badMail.status === 400, `实得 ${badMail.status}`);

  /* ---------- 16.6 修改 ---------- */
  const upd = await PATCH(`/api/admin/users/${tid}`, { username: '改过名的', note: '备注也改了' });
  ok('改昵称/备注 200', upd.status === 200 && upd.data?.user?.username === '改过名的',
    JSON.stringify(upd.data?.user)?.slice(0, 140));
  ok('★ 返回改动前后值（审计要用）', Array.isArray(upd.data?.changed?.username),
    JSON.stringify(upd.data?.changed));

  const noop = await PATCH(`/api/admin/users/${tid}`, { username: '改过名的' });
  ok('改成同样的值不算改动', Object.keys(noop.data?.changed || {}).length === 0,
    JSON.stringify(noop.data?.changed));

  const badRole = await PATCH(`/api/admin/users/${tid}`, { role: 'superuser' });
  ok('非法角色被拒 400', badRole.status === 400, `实得 ${badRole.status}`);
  const badStatus = await PATCH(`/api/admin/users/${tid}`, { status: 'frozen' });
  ok('非法状态被拒 400', badStatus.status === 400, `实得 ${badStatus.status}`);
  const emailTaken = await PATCH(`/api/admin/users/${tid}`, { email: ADMIN_EMAIL });
  ok('改成已占用的邮箱 409', emailTaken.status === 409, `实得 ${emailTaken.status}`);

  /* ---------- 16.7 护栏：不能把系统搞成"没有管理员" ---------- */
  const selfDemote = await PATCH(`/api/admin/users/${adminId}`, { role: 'user' });
  ok('★ 不能取消自己的管理员权限', selfDemote.status === 400 && selfDemote.data?.code === 'SELF_DEMOTE',
    JSON.stringify(selfDemote.data));
  const selfDisable = await PATCH(`/api/admin/users/${adminId}`, { status: 'disabled' });
  ok('★ 不能停用自己的账号', selfDisable.status === 400 && selfDisable.data?.code === 'SELF_DISABLE',
    JSON.stringify(selfDisable.data));
  const selfDelete = await DEL(`/api/admin/users/${adminId}`);
  ok('★ 不能删除自己的账号', selfDelete.status === 400 && selfDelete.data?.code === 'SELF_DELETE',
    JSON.stringify(selfDelete.data));
  const stillAdmin = await GET('/api/auth/me');
  ok('★ 护栏生效后自己仍是管理员', stillAdmin.data?.user?.role === 'admin', stillAdmin.data?.user?.role);

  // 提一个临时管理员，验「最后一个管理员不能降级」
  const promoted = await PATCH(`/api/admin/users/${tid}`, { role: 'admin' });
  ok('能把别人提为管理员', promoted.status === 200 && promoted.data?.user?.role === 'admin',
    promoted.data?.user?.role);
  const demoteOther = await PATCH(`/api/admin/users/${tid}`, { role: 'user' });
  ok('管理员数量 >1 时降级别人是允许的', demoteOther.status === 200, `实得 ${demoteOther.status}`);

  /* ---------- 16.8 重置密码 ---------- */
  const reset = await POST(`/api/admin/users/${tid}/password`, { password: 'Reset2027!' });
  ok('重置密码 200', reset.status === 200, JSON.stringify(reset.data));
  const weakReset = await POST(`/api/admin/users/${tid}/password`, { password: 'abc' });
  ok('重置时的弱密码被拒 400', weakReset.status === 400, `实得 ${weakReset.status}`);

  const auditNow = await GET('/api/admin/logs');
  ok('★ 审计日志里不含密码原文', !JSON.stringify(auditNow.data).includes('Reset2027!'), '');
  ok('★ 审计日志里不含密码哈希', !/password_(hash|salt)/.test(JSON.stringify(auditNow.data)));

  // 被重置的人能用新密码登录 → 证明重置真的改了密码，不只是写了个字段
  const outerJar = new Map(jar);
  jar.clear();
  const relogin = await POST('/api/auth/login', { email: TARGET, password: 'Reset2027!' });
  ok('★ 被重置的账号能用新密码登录', relogin.status === 200, JSON.stringify(relogin.data)?.slice(0, 100));
  const oldPwd = await POST('/api/auth/login', { email: TARGET, password: 'Managed2027!' });
  ok('★ 旧密码已失效', oldPwd.status === 401, `实得 ${oldPwd.status}`);

  /* ---------- 16.9 停用：当场踢会话 + 拦住登录 ---------- */
  const innerJar = new Map(jar);
  jar.clear();
  for (const [k, v] of outerJar) jar.set(k, v);

  const disable = await PATCH(`/api/admin/users/${tid}`, { status: 'disabled' });
  ok('停用 200', disable.status === 200 && disable.data?.user?.status === 'disabled',
    JSON.stringify(disable.data?.changed));

  // 被停用的人手里那个 cookie 必须当场失效，不能等它自然过期
  jar.clear();
  for (const [k, v] of innerJar) jar.set(k, v);
  const killedSession = await GET('/api/auth/me');
  ok('★ 停用后他手里的会话立刻失效', killedSession.status === 401, `实得 ${killedSession.status}`);
  jar.clear();
  const blocked = await POST('/api/auth/login', { email: TARGET, password: 'Reset2027!' });
  ok('★ 停用后登录被拦 403', blocked.status === 403 && blocked.data?.code === 'ACCOUNT_DISABLED',
    JSON.stringify(blocked.data));
  jar.clear();
  for (const [k, v] of outerJar) jar.set(k, v);
  const reEnable = await PATCH(`/api/admin/users/${tid}`, { status: 'active' });
  ok('恢复启用 200', reEnable.status === 200 && reEnable.data?.user?.status === 'active');

  /* ---------- 16.10 详情 ---------- */
  const detail = await GET(`/api/admin/users/${tid}`);
  ok('详情 200', detail.status === 200, JSON.stringify(detail.data)?.slice(0, 120));
  ok('详情含备考设置', detail.data?.settings !== null && detail.data?.settings !== undefined, '');
  ok('详情含活跃会话列表', Array.isArray(detail.data?.sessions), '');
  ok('★ 详情不返回会话 token', !JSON.stringify(detail.data).includes('token_hash'), '');
  ok('★ 详情不泄露用户的 LLM 密钥', !JSON.stringify(detail.data).includes('cloud_key'), '');
  ok('详情含该账号被管理过的记录', (detail.data?.logs || []).length > 0, `${detail.data?.logs?.length} 条`);
  const missing = await GET('/api/admin/users/999999');
  ok('不存在的用户 404', missing.status === 404, `实得 ${missing.status}`);

  /* ---------- 16.11 强制下线 ---------- */
  const kick = await POST(`/api/admin/users/${tid}/logout`);
  ok('强制下线 200', kick.status === 200, JSON.stringify(kick.data));

  /* ---------- 16.12 删除（级联清数据） ---------- */
  const del = await DEL(`/api/admin/users/${tid}`);
  ok('删除 200', del.status === 200, JSON.stringify(del.data));
  ok('★ 删除返回被清掉的数据量', typeof del.data?.wiped?.attempts === 'number', JSON.stringify(del.data?.wiped));
  const gone = await GET(`/api/admin/users/${tid}`);
  ok('删完查不到', gone.status === 404, `实得 ${gone.status}`);
  const delAgain = await DEL(`/api/admin/users/${tid}`);
  ok('重复删除 404', delAgain.status === 404, `实得 ${delAgain.status}`);
  const delMissing = await DEL('/api/admin/users/999999');
  ok('删不存在的用户 404', delMissing.status === 404, `实得 ${delMissing.status}`);

  /* ---------- 16.13 审计 ---------- */
  const logs = await GET('/api/admin/logs');
  ok('审计日志 200', logs.status === 200 && (logs.data?.logs?.length || 0) > 0, `${logs.data?.logs?.length} 条`);
  const first = logs.data?.logs?.[0];
  ok('日志带操作者与目标', !!first?.actorEmail && !!first?.action, JSON.stringify(first)?.slice(0, 140));
  ok('日志带时间戳', !!first?.at, '');
  const actions = new Set((logs.data?.logs || []).map((l) => l.action));
  ok('★ 建/改/删/重置密码都留了痕',
    ['user_create', 'user_update', 'user_delete', 'password_reset'].every((a) => actions.has(a)),
    JSON.stringify([...actions]));

  /* ---------- 恢复：后续没有别的节了，但保持一致的收尾习惯 ---------- */
  jar.clear();
  for (const [k, v] of outerJar) jar.set(k, v);
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
