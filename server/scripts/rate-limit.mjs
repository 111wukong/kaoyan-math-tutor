/* 限流与存量数据兜底
 *
 * ── 为什么要单独起一台服务 ────────────────────────────────────────
 * 功能套件那台把 RATE_LIMIT_MAX 开到了 100000（见 tests/lib/server.mjs）——
 * 几十次页面导航叠起来很容易撞默认上限，然后报一堆看不懂的 429 假红。
 * 要验限流就得把上限压下来，所以这里自己起一台。
 *
 * ── 这两条守的都是「静默失效」────────────────────────────────────
 *   1. rate-limit 注册时写成 global:false：那组 max/timeWindow 不会被
 *      任何路由继承，实际只有显式挂了 config.rateLimit 的登录和注册受限。
 *      配置项存在、数字也在，读代码完全看不出来 —— 实测对四个接口
 *      各打 120 次，一个 429 都没有。
 *   2. 上游地址只在写入口校验：库里可能存着**这次改动之前**就填好的
 *      内网地址，读的时候不再校验一次，那些老数据照样能打出去。
 *
 * 输出格式必须和 tests/run-all.mjs 的正则对齐，否则汇总入口抓不到，
 * 会把「全过」报成「脚本崩了」。
 */
import Database from 'better-sqlite3';
import { startServer } from '../../tests/lib/server.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
};
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

/* 测试账号口令现场拼，不写字面量：「邮箱 + 口令」成对出现在源码里，
 * 正是 no-secrets 套件要拦的形状，没必要自己给自己找豁免。 */
const TEST_PW = `Rl-${Math.random().toString(36).slice(2, 12)}`;
const DUMMY_KEY = 'x'.repeat(12);
/* 链路本地地址的样本。故意不用那个最有名的实例元数据地址 ——
 * 它在源码里出现会被静态扫描器当成 IOC，给仓库平添噪音；
 * 校验逻辑覆盖整个 169.254/16，用段内任意地址验的是同一件事。 */
const LINK_LOCAL_SAMPLE = '169.254.7.7';

/* ---------- 1. 限流闸门 ---------- */
section('1. 限流闸门（私有服务，上限压到 40）');
{
  const priv = await startServer({ tag: 'ratelimit', env: { RATE_LIMIT_MAX: '40' } });
  try {
    const P = priv.base;

    /* 注册接口自己也有 10/10min 的限流，所以只注册一次。 */
    const r = await fetch(`${P}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rl@test.local', username: 'rl', password: TEST_PW }),
    });
    const ck = (r.headers.get('set-cookie') || '').split(';')[0];
    ok('私有服务注册成功', r.status === 200, `实得 ${r.status}`);

    /* 1a. 只读接口也要受限 —— global:false 时打 120 次都不会 429。 */
    let hit = null;
    for (let i = 0; i < 60; i += 1) {
      const res = await fetch(`${P}/api/catalog/tree`, { headers: { Cookie: ck } });
      if (res.status === 429) { hit = await res.json(); break; }
    }
    ok('★ 只读接口打满上限后出现 429', hit !== null, '打满 60 次都没被拦');

    /* 429 的文案必须是中文的 —— 走 index.js 的统一错误处理器。
     * 处理器没生效时这里是框架默认的 "Too Many Requests"，
     * 而前端读 body.error 当提示文案，于是中文界面弹英文。 */
    ok('429 文案是中文', hit?.error === '操作太频繁了，缓一缓再试',
      `实得 ${JSON.stringify(hit?.error)}`);

    /* 1b. AI 接口有独立更紧的一档（每次调用都要打上游，很贵）。
     * 没配模型时业务层会回 400 NO_LLM，但限流在 onRequest 就拦了，
     * 所以打满之后拿到的是 429 而不是 400。 */
    let aiHit = false;
    for (let i = 0; i < 40; i += 1) {
      const res = await fetch(`${P}/api/ai/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ck },
        body: JSON.stringify({ kid: 'c1n1', count: 1 }),
      });
      if (res.status === 429) { aiHit = true; break; }
    }
    ok('★ AI 接口有独立更紧的限流档', aiHit);
  } finally {
    await priv.stop();
  }
}

/* ---------- 2. 存量数据的兜底 ---------- */
section('2. 库里已存的旧地址也要拦');
{
  /* 写入时校验只能挡新数据。库可能是**这次改动之前**建的，里面就躺着
   * 一条内网地址 —— 所以读取时（llmOrError / 测试连接）必须再校验一次。
   * 这里直接改库来模拟那个状态。 */
  const priv = await startServer({ tag: 'staleaddr' });
  try {
    const P = priv.base;
    const r = await fetch(`${P}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'stale@test.local', username: 's', password: TEST_PW }),
    });
    const ck = (r.headers.get('set-cookie') || '').split(';')[0];
    ok('私有服务注册成功', r.status === 200, `实得 ${r.status}`);

    /* 绕过接口直接改库，模拟「改动之前就已经存进去的地址」。 */
    const db = new Database(priv.dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(`UPDATE llm_settings
      SET enabled = 1, kind = ?, cloud_base = ?, cloud_model = ?, cloud_key = ?`)
      .run('cloud', `http://${LINK_LOCAL_SAMPLE}/v1`, 'x', DUMMY_KEY);
    db.close();

    const t = await fetch(`${P}/api/settings/llm/test`, { method: 'POST', headers: { Cookie: ck } });
    const tb = await t.json().catch(() => ({}));
    ok('测试连接拒绝存量内网地址', t.status === 400, `实得 ${t.status}`);
    ok('带 code=BAD_LLM_BASE', tb.code === 'BAD_LLM_BASE', `实得 ${JSON.stringify(tb.code)}`);

    const g = await fetch(`${P}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ck },
      body: JSON.stringify({ kid: 'c1n1', count: 1 }),
    });
    const gb = await g.json().catch(() => ({}));
    ok('★ AI 接口也拦存量内网地址（六个接口共用一道闸门）',
      g.status === 400 && gb.code === 'BAD_LLM_BASE',
      `实得 ${g.status} ${JSON.stringify(gb.code)}`);
  } finally {
    await priv.stop();
  }
}

console.log('\n' + '─'.repeat(46));
if (fail) {
  console.log(`\x1b[31m❌ 限流与地址兜底：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 限流与地址兜底：${pass} 项全部通过\x1b[0m`);
process.exit(0);
