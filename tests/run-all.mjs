/* 测试总入口：起一个一次性服务 → 依次跑各套件 → 汇总 → 收摊
 *
 * 跑法：npm test
 * 想对着已经在跑的服务测：BASE=http://127.0.0.1:5180 npm test
 *
 * ── 关于服务生命周期 ──────────────────────────────────────────────
 * 服务由这里起、这里杀，用的是自动挑的空闲端口 + 一次性数据库。
 * 以前两个套件各自假设「5180 上已经有人起好了服务」，于是：
 *   · 本机残留的旧服务占着端口 → 新服务起不来 → 满屏超时，报 44 项假失败；
 *   · 或者更糟 —— 残留服务恰好是好的，测试全绿，但你验证的其实是旧产物。
 * 现在这两个问题都不存在了。
 *
 * ── 关于输出 ──────────────────────────────────────────────────────
 * 子套件的输出先写临时文件，父进程读完再打印。
 * 为什么不直接 pipe：会形成「父 → 子 → Chromium」的嵌套管道。
 * Chromium 会派生 zygote / renderer，它们继承同一批文件描述符；
 * 外层再 `| tail` 时管道等不到 EOF，命令就永久挂住 ——
 * 单独跑子套件没事（只有一层管道），嵌在汇总里跑就卡死。
 *
 * 输出格式统一成 `✅ …：N 项` / `❌ …：N 项通过，失败 M 项`，方便用正则抓。
 * 注意「跳过」也打印 0 项 —— 所以浏览器套件自己会出声说明跳过了，
 * 别把「没测」当成「通过」。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, startServer } from './lib/server.mjs';

const SUITES = [
  /* 凭据扫描放最前面：它最快，而且挂掉的话其他都不用看了 ——
   * 源码和 README 是公开的，那里出现凭据是比任何功能 bug 都严重的事。 */
  { name: '凭据扫描', file: 'tests/no-secrets.mjs' },
  /* 这两个放最前面：纯静态、不用浏览器、1 秒出结果，而且都是**确定性全量**检查。
   *
   * 分工：
   *   latex-coverage 验「autoLatex 的包裹对不对」（$ 之外不该有裸 \command、不许增删字符）
   *   pipeline-leak  验「整条管线跑完，屏幕上会不会出现标记符号」—— 用真 katex
   *
   * 必须两层都有：包裹对了 ≠ KaTeX 解析得了。renderTex 用的是 throwOnError:false，
   * KaTeX 解析失败时不抛异常，而是吐一个 class="katex-error" 的 span 把源码原样显示出来；
   * 这个类名不含独立成词的 katex，所以浏览器套件那句 .katex 子树剔除**删不掉它**。
   * 实测就是这么漏的：CI 抽到 q01（题干带 \lim），本机没抽到。
   *
   * 浏览器套件里那条抽查是**随机抽题**的，同一份代码可能本机绿、CI 红 ——
   * 所以真正的门禁在这两个确定性套件上，浏览器那条只当补充。 */
  { name: 'LaTeX 全量检查', file: 'tests/latex-coverage.mjs' },
  { name: '渲染管线漏屏检查', file: 'tests/pipeline-leak.mjs' },
  /* 图谱套件也是**确定性全量**检查，而且自己建临时库、不走 HTTP ——
   * 放在这里跑得最快，挂了能立刻看出是数据问题还是接口问题。 */
  { name: '图谱与诊断', file: 'tests/graph.mjs' },
  /* FSRS 也是纯函数 + 临时库，不走 HTTP。调度算法错了不会报错，
   * 只会让间隔一天天变离谱 —— 所以必须靠断言钉住。 */
  { name: 'FSRS 调度器', file: 'tests/fsrs.mjs' },
  /* 课堂阶段机同样是纯函数 + 临时库。它的失效方式也是**静默走错分支**：
   * 「我还是没听懂」被判成听懂了 → 下一轮甩一道算题。
   * 放在接口套件之前跑，挂了能立刻看出是逻辑问题还是提示词问题。 */
  { name: '课堂阶段机', file: 'tests/classroom.mjs' },
  /* 日期口径放在接口套件之前：它自己起一个 TZ 特殊的服务，
   * 挂了的话能一眼看出是「时区」问题而不是业务逻辑问题。 */
  { name: '日期口径检查', file: 'tests/day-boundary.mjs' },
  { name: '接口冒烟', file: 'server/scripts/smoke.mjs' },
  /* 加固回归要**自己起服务**：限流上限得压到很小才能验「闸门真的会拦」，
   * 注册开关得用一台设了 REGISTRATION_ENABLED=false 的服务，
   * 存量坏地址要绕过接口直接改库 —— 共享那台一个都不能动。
   * 也因为它不碰共享服务，放在这里不会影响后面的套件。 */
  { name: '加固回归', file: 'server/scripts/hardening.mjs' },
  { name: '浏览器冒烟', file: 'tests/browser-smoke.mjs' },
  { name: '近黑渐变色带检测', file: 'tests/banding.mjs' },
];

const results = [];

function run(file, env) {
  const logPath = path.join(os.tmpdir(), `yanshu-suite-${path.basename(file)}.log`);
  const fd = fs.openSync(logPath, 'w');
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, file)], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
    });
    p.on('close', (code) => {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
      let out = '';
      try { out = fs.readFileSync(logPath, 'utf8'); } catch { /* 读不到就当空 */ }
      process.stdout.write(out);
      try { fs.unlinkSync(logPath); } catch { /* 删不掉无所谓 */ }
      resolve({ out, code });
    });
  });
}

console.log('\x1b[1m研数 · 全部测试\x1b[0m\n');

/* ---------- 0. 前置检查 ---------- */
/* 浏览器套件是靠后端托管 web/dist 来测真实页面的。
 * dist 不在的话后端会退化成「只提供 API」，页面全部 404 ——
 * 然后浏览器套件会报出一堆看不懂的超时。这里提前拦下来，把话说清楚。 */
const DIST = path.join(ROOT, 'web/dist/index.html');
if (!fs.existsSync(DIST)) {
  console.log('\x1b[31m✗ 没有找到 web/dist —— 浏览器套件测不了真实页面。\x1b[0m');
  console.log('  先跑一次 \x1b[36mnpm run build\x1b[0m，再回来跑测试。\n');
  process.exit(1);
}

/* ---------- 1. 起服务 ---------- */
let server = null;
let base = process.env.BASE;

if (base) {
  console.log(`\x1b[36m使用已有的服务：${base}\x1b[0m`);
  let h = null;
  try {
    const res = await fetch(`${base}/api/health`);
    if (res.ok) h = await res.json();
  } catch { /* 下面统一报「没响应」 */ }

  if (!h?.ok) {
    console.log(`\x1b[31m✗ ${base} 上没有响应 —— 检查一下服务是不是没起。\x1b[0m\n`);
    process.exit(1);
  }

  /* ★ 拒绝把测试跑在真实数据库上。
   *
   * 测试会往库里灌账号（browser_*@test.local、smoke_*@test.local）、
   * 灌作答记录、改设置。以前只检查「服务活着没」，于是
   * `BASE=http://127.0.0.1:5180 npm test` 这种对着 dev 服务测的用法
   * 会把测试数据永久写进 server/data/app.db —— 实测就这么污染过，
   * 一个真实账号旁边躺了 17 个测试账号。
   *
   * ★ 判据从「服务端报出 DB_PATH，客户端判断在不在临时目录」
   *   改成了「服务端自己判断，只回一个布尔 health.db.isTemp」。
   *   原因是 DB_PATH 是绝对路径，而 /api/health 是**公开**接口 ——
   *   匿名可读等于把「你的服务器装在哪」挂在公网上。
   *   判断逻辑本身在 server/src/lib/dbPath.js（macOS 的 /tmp 软链坑
   *   记在那儿），tests/lib/server.mjs 只是 re-export 一下给
   *   graph.mjs 的单测用。
   *
   * 缺 `db.isTemp` 时**按真实库处理**（fail closed）——
   * 对着一个不肯报自己库位置的旧服务跑测试，本来就该拒绝。 */
  const isTemp = h.db?.isTemp === true;

  if (!isTemp) {
    console.log(`\x1b[31m✗ 拒绝执行：${base} 连的不是一次性数据库。\x1b[0m`);
    console.log('');
    console.log('  测试会往库里灌账号和作答记录，跑完不会自己清理。');
    console.log('  想对着服务测，请让它用一个一次性数据库：');
    console.log('    \x1b[36mDB_PATH=/tmp/yanshu-test.db PORT=5199 npm run start\x1b[0m');
    console.log('    \x1b[36mBASE=http://127.0.0.1:5199 npm test\x1b[0m');
    console.log('');
    console.log('  不加 BASE 直接 \x1b[36mnpm test\x1b[0m 的话，会自己起一个临时服务，最省事。\n');
    process.exit(1);
  }

  console.log('  \x1b[90m数据库是一次性的，可以放心跑\x1b[0m');
} else {
  try {
    server = await startServer({ tag: 'all' });
    base = server.base;
    console.log(`\x1b[36m起了一个一次性服务：${base}\x1b[0m`);
    console.log(`  数据库 ${server.dbPath}`);
    console.log('  （空的，跑完就删）');
  } catch (e) {
    console.log(`\x1b[31m✗ 起服务失败\x1b[0m\n${e.message}\n`);
    process.exit(1);
  }
}

/* ---------- 2. 跑套件 ---------- */
try {
  for (const s of SUITES) {
    console.log(`\n\x1b[36m━━━ ${s.name} ━━━\x1b[0m`);
    const { out, code } = await run(s.file, { BASE: base });
    const okM = out.match(/✅[^\n]*?(\d+)\s*项/);
    const badM = out.match(/❌[^\n]*?(\d+)\s*项[^\n]*?失败\s*(\d+)\s*项/);
    /* ★ 跳过状态必须靠**显式标记**，不能靠「输出里有没有『跳过』两个字」。
     *   以前就是这么判的，结果某个套件里一条断言叫「花括号组要整体跳过」，
     *   整个套件被误标成「已跳过」—— 汇总行说没跑，其实跑得好好的。
     *   子串猜状态一定会被文案变化骗到。 */
    const skipped = /^\[SKIP\]/m.test(out);

    if (badM) {
      results.push({ name: s.name, pass: Number(badM[1]), fail: Number(badM[2]), skipped: false });
    } else if (okM) {
      results.push({ name: s.name, pass: Number(okM[1]), fail: 0, skipped });
    } else {
      // 连汇总行都没打出来 —— 脚本自己崩了，把尾部输出带出来
      console.log(`\x1b[31m  （${s.name} 没有输出汇总行，退出码 ${code}）\x1b[0m`);
      const tail = out.split('\n').filter((l) => l.trim()).slice(-6).join('\n    ');
      console.log('    ' + tail);
      results.push({ name: s.name, pass: 0, fail: 1, skipped: false });
    }
  }
} finally {
  /* 无论中间怎么炸，服务都要收掉 —— 否则端口和临时库会一直攒着。 */
  if (server) {
    await server.stop();
    console.log('\n\x1b[90m（一次性服务已停止，临时数据库已删除）\x1b[0m');
  }
}

/* ---------- 3. 汇总 ---------- */
const totalPass = results.reduce((a, r) => a + r.pass, 0);
const totalFail = results.reduce((a, r) => a + r.fail, 0);
const anySkipped = results.some((r) => r.skipped);

console.log('\n' + '─'.repeat(52));
for (const r of results) {
  const mark = r.fail ? '\x1b[31m✗\x1b[0m' : r.skipped ? '\x1b[33m·\x1b[0m' : '\x1b[32m✓\x1b[0m';
  const note = r.skipped ? '  \x1b[33m（跳过 —— 本机没有浏览器）\x1b[0m' : '';
  console.log(`  ${mark} ${r.name}：${r.pass} 通过${r.fail ? ` / ${r.fail} 失败` : ''}${note}`);
}
console.log('─'.repeat(52));

if (totalFail) {
  console.log(`\x1b[31m❌ 全部测试：${totalPass} 项通过，失败 ${totalFail} 项\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 全部测试：${totalPass} 项全部通过\x1b[0m`);
if (anySkipped) console.log('\x1b[33m   注意：有套件被跳过，不等于被验证过。\x1b[0m');
console.log('');
process.exit(0);
