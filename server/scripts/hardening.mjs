/* 加固回归（需要自起服务的那几项）
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────
 * 这里验的三件事，共享那台服务都验不了：
 *
 *   1. **限流上限**：功能套件把 RATE_LIMIT_MAX 开到了 100000
 *      （几十次页面导航叠起来会撞默认上限，报一堆假红），
 *      要验闸门真的会拦就得把上限压下来。
 *   2. **注册开关**：默认是开的，要验「关掉之后真的关掉了」，
 *      得用一台设了 REGISTRATION_ENABLED=false 的服务。
 *   3. **存量坏地址**：要绕过接口直接改库来模拟「改动之前就填好的内网地址」，
 *      改的是这台私有服务的库，不能碰共享那台。
 *
 * ── 这几条守的都是「静默失效」────────────────────────────────────
 *   · rate-limit 写成 global:false：那组 max/timeWindow 不会被任何路由继承，
 *     实际只有显式挂了 config.rateLimit 的登录注册受限。配置项存在、
 *     数字也在，读代码完全看不出来 —— 实测四个接口各打 120 次，0 个 429。
 *   · 上游地址只在写入口校验：库里存着改动之前填好的内网地址，
 *     不再校验一次的话那些老数据照样能打出去。
 *   · 注册开关只做了一半：接口关了但前端还显示表单，
 *     用户填完被拒会以为是自己填错了。
 *
 * 输出格式必须和 tests/run-all.mjs 的正则对齐，否则汇总入口抓不到，
 * 会把「全过」报成「脚本崩了」。
 */
import Database from 'better-sqlite3';
import { startServer, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from '../../tests/lib/server.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
};
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

/* 测试账号口令现场拼，不写字面量：「邮箱 + 口令」成对出现在源码里，
 * 正是 no-secrets 套件要拦的形状，没必要自己给自己找豁免。 */
const TEST_PW = `Hg-${Math.random().toString(36).slice(2, 12)}`;
const DUMMY_KEY = 'x'.repeat(12);
/* 链路本地地址的样本。故意不用那个最有名的实例元数据地址 ——
 * 它在源码里出现会被静态扫描器当成 IOC，给仓库平添噪音；
 * 校验逻辑覆盖整个 169.254/16，用段内任意地址验的是同一件事。 */
const LINK_LOCAL_SAMPLE = '169.254.7.7';

const jsonOf = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 160) }; } };

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
      if (res.status === 429) { hit = await jsonOf(res); break; }
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

/* ---------- 2. 注册开关 ---------- */
section('2. 注册开关');
{
  const priv = await startServer({ tag: 'regclosed', env: { REGISTRATION_ENABLED: 'false' } });
  try {
    const P = priv.base;

    /* 公开配置接口：前端据此决定显示表单还是「已关闭」。
     * 让用户填完一整张表再被 403 顶回来，看起来像系统坏了。 */
    const cfgRes = await fetch(`${P}/api/auth/config`);
    const cfg = await jsonOf(cfgRes);
    ok('配置接口未登录也能读', cfgRes.status === 200, `实得 ${cfgRes.status}`);
    ok('如实报告注册已关闭', cfg.registrationEnabled === false, `实得 ${JSON.stringify(cfg)}`);

    const regRes = await fetch(`${P}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nope@test.local', username: 'n', password: TEST_PW }),
    });
    const reg = await jsonOf(regRes);
    ok('注册接口 403', regRes.status === 403, `实得 ${regRes.status}`);
    ok('带 code=REGISTRATION_CLOSED', reg.code === 'REGISTRATION_CLOSED',
      `实得 ${JSON.stringify(reg.code)}`);
    ok('文案说明是「关闭注册」而不是「参数错误」',
      /关闭注册/.test(reg.error || ''), `实得 ${JSON.stringify(reg.error)}`);

    /* ★ 关掉注册不能把管理通道一起关掉 —— 这是「关掉不会把人锁在外面」
     * 那条承诺的验证。库里没有管理员时启动会引导一个出来，
     * 之后账号由管理员在后台建。 */
    const alog = await fetch(`${P}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }),
    });
    const ack = (alog.headers.get('set-cookie') || '').split(';')[0];
    ok('管理员仍能登录', alog.status === 200, `实得 ${alog.status}`);

    const mk = await fetch(`${P}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ack },
      body: JSON.stringify({ email: 'by-admin@test.local', username: '后台建的', password: TEST_PW }),
    });
    ok('★ 管理员仍能在后台建号', mk.status === 200, `实得 ${mk.status}`);
  } finally {
    await priv.stop();
  }
}

/* 默认值与「看起来像关闭」的写法。 */
{
  const cases = [
    [undefined, true, '不设这个变量时默认是开着的（不给已有部署制造意外）'],
    ['0', true, "★ 写 '0' 仍是开着 —— 只有 'false' 才算关，别猜"],
  ];
  for (const [val, expect, name] of cases) {
    const env = val === undefined ? {} : { REGISTRATION_ENABLED: val };
    const priv = await startServer({ tag: 'regdefault', env });
    try {
      const cfg = await jsonOf(await fetch(`${priv.base}/api/auth/config`));
      ok(name, cfg.registrationEnabled === expect, `实得 ${JSON.stringify(cfg)}`);
    } finally {
      await priv.stop();
    }
  }
}

/* ---------- 3. 存量数据的兜底 ---------- */
section('3. 库里已存的旧地址也要拦');
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
    const tb = await jsonOf(t);
    ok('测试连接拒绝存量内网地址', t.status === 400, `实得 ${t.status}`);
    ok('带 code=BAD_LLM_BASE', tb.code === 'BAD_LLM_BASE', `实得 ${JSON.stringify(tb.code)}`);

    const g = await fetch(`${P}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ck },
      body: JSON.stringify({ kid: 'c1n1', count: 1 }),
    });
    const gb = await jsonOf(g);
    ok('★ AI 接口也拦存量内网地址（六个接口共用一道闸门）',
      g.status === 400 && gb.code === 'BAD_LLM_BASE',
      `实得 ${g.status} ${JSON.stringify(gb.code)}`);
  } finally {
    await priv.stop();
  }
}

/* ---------- 4. 错误响应格式 ----------
 *
 * 守的是 setErrorHandler 的**注册位置**：它必须早于所有插件和路由，
 * 否则 Fastify 不会把它继承给已注册的子上下文，整块变死代码 ——
 * 于是 429 回框架默认的英文、参数校验回 FST_ERR_VALIDATION、
 * 未捕获异常把 err.message 原文（SQL 报错、文件路径）吐出去。
 *
 * ★ 这一节原来不存在。`server/src/index.js` 的注释里写着
 *   「下面留了断言（tests/security.mjs）」，但**那个文件从来没存在过**
 *   （这套东西实际落在 server/scripts/hardening.mjs，注释没跟着改）。
 *   也就是说「参数校验是中文」和「不泄露内部信息」这两条修复
 *   一直没有回归测试守着 —— 谁把 setErrorHandler 挪个位置都不会被发现。
 *   写「留了断言」的注释而不写断言，比不写注释更糟：它让人以为有人守着。
 */
section('4. 错误响应格式（中文、不泄露内部信息）');
{
  const priv = await startServer({ tag: 'errors' });
  try {
    const P = priv.base;

    /* 参数校验错误必须是中文 —— 前端 api.ts 读 body.error 当提示文案，
     * 回框架默认的英文会让中文界面弹英文。 */
    const bad = await fetch(`${P}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const bj = await jsonOf(bad);
    ok('缺必填字段返回 400', bad.status === 400, `实得 ${bad.status}`);
    ok('★ 参数校验错误是中文（不是框架默认的 Bad Request）',
      typeof bj.error === 'string' && /[\u4e00-\u9fa5]/.test(bj.error),
      JSON.stringify(bj).slice(0, 160));
    ok('不外泄 FST_ERR_VALIDATION 这类内部错误码',
      !JSON.stringify(bj).includes('FST_ERR'),
      JSON.stringify(bj).slice(0, 160));

    /* 一组畸形请求，验同一条不变量：**响应体里不许出现堆栈 / 文件路径**。
     * 真去构造一个「必然抛未捕获异常」的接口代价太大（得加一条测试专用路由，
     * 而那条路由本身就是个攻击面），但「不泄露」这个性质可以用这批请求守住 ——
     * 它们覆盖了解析失败、路由不存在、方法不对、超长字段四类。 */
    const probes = [
      ['畸形 JSON', () => fetch(`${P}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
      })],
      ['不存在的路由', () => fetch(`${P}/api/definitely-not-a-route`)],
      ['方法不对', () => fetch(`${P}/api/auth/login`)],
      ['超长字段', () => fetch(`${P}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x'.repeat(5000), password: 'y' }),
      })],
    ];
    const leaky = [];
    for (const [label, fn] of probes) {
      const r = await fn();
      const body = await r.text();
      /* 堆栈帧、绝对路径、node_modules 都是内部信息的形状 */
      if (/at\s+[\w.$]+\s*\(|node_modules|\/Users\/|\.js:\d+:\d+/.test(body)) {
        leaky.push(`${label}(${r.status}): ${body.slice(0, 90)}`);
      }
    }
    ok('★ 畸形请求的响应体里不出现堆栈 / 文件路径',
      leaky.length === 0, leaky.slice(0, 3).join(' | '));

    /* 不存在的 /api/* 返回 **401 而不是 404** —— 这是全局闸门的自然结果：
     * 它在 onRequest 里对所有 /api/* 要求会话，路由还没匹配上就先拦了。
     * 这比 404 好：404 等于告诉扫描者「这个路径存在，只是你没权限」，
     * 401 什么也不说。只要不是 500（那说明异常处理漏了这一路）就对了。 */
    const nf = await fetch(`${P}/api/definitely-not-a-route`);
    ok('不存在的 /api 路由返回 401（闸门先于路由匹配，不泄露路径是否存在）',
      nf.status === 401, `实得 ${nf.status}`);
  } finally {
    await priv.stop();
  }
}

/* ---------- 5. /api/auth/ 前缀白名单下的敏感路由 ----------
 *
 * PUBLIC_PREFIXES 里有 `'/api/auth/'` —— 前缀匹配意味着这个前缀下**所有**
 * 路由都绕过了全局鉴权闸门，包括「改密码」和「删账号」。它们各自靠
 * `preHandler: fastify.requireAuth` 兜底，所以闸门其实还在，只是换了个地方。
 *
 * ★ 打这些路由必须传**合法参数**。
 *   用空 body 打会得到 400（Fastify 的顺序是 schema 校验 → preHandler），
 *   看起来"有反应"，实际掩盖了真实的鉴权行为 —— 实测把 requireAuth 删掉，
 *   空 body 的断言照样绿。这就是本节存在的理由。
 *
 * （`/api/auth/logout` 故意不在列表里：匿名调用返回 200 是有意设计 ——
 *   没会话就没得清，幂等返回成功比报错更合理，也避免泄露「这个 cookie 还有效吗」。）
 */
section('5. /api/auth/ 前缀白名单下的敏感路由');
{
  const priv = await startServer({ tag: 'authprefix' });
  try {
    const P = priv.base;
    const cases = [
      ['POST', '/api/auth/password', { current: 'whatever', next: 'Whatever-12345' }],
      ['DELETE', '/api/auth/account', { password: 'whatever' }],
      ['GET', '/api/auth/sessions', null],
      ['POST', '/api/auth/logout-all', {}],
      ['GET', '/api/auth/me', null],
    ];
    const open = [];
    for (const [m, p, b] of cases) {
      const r = await fetch(P + p, {
        method: m,
        headers: b ? { 'Content-Type': 'application/json' } : {},
        body: b ? JSON.stringify(b) : undefined,
      });
      if (r.status !== 401) open.push(`${m} ${p} -> ${r.status}`);
    }
    ok('★ 白名单前缀下的敏感路由都各自要求登录（匿名一律 401）',
      open.length === 0, open.join(' | '));
  } finally {
    await priv.stop();
  }
}

console.log('\n' + '─'.repeat(46));
if (fail) {
  console.log(`\x1b[31m❌ 加固回归：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 加固回归：${pass} 项全部通过\x1b[0m`);
process.exit(0);
