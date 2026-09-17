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
  { name: '接口冒烟', file: 'server/scripts/smoke.mjs' },
  { name: '浏览器冒烟', file: 'tests/browser-smoke.mjs' },
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
  const alive = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
  if (!alive) {
    console.log(`\x1b[31m✗ ${base} 上没有响应 —— 检查一下服务是不是没起。\x1b[0m\n`);
    process.exit(1);
  }
} else {
  try {
    server = await startServer({ tag: 'all' });
    base = server.base;
    const h = server.health;
    console.log(`\x1b[36m起了一个一次性服务：${base}\x1b[0m`);
    console.log(`  数据库 ${server.dbPath}`);
    console.log(`  （表 ${h.db?.tables} 张 / 用户 ${h.db?.users} 个 —— 空的，跑完就删）`);
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
