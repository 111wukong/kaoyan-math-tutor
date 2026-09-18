/* 测试用的服务生命周期管理
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────
 * 之前两个套件都假设「127.0.0.1:5180 上已经有人把服务起好了」。
 * 于是测试结果不取决于代码，而取决于**当时那个服务是谁起的、连的哪个库、
 * 有没有被改过**。这个坑我踩过一次，代价很直观：
 *
 *   本机残留的旧服务占着 5180 → 新服务绑不上端口 →
 *   满屏「等待超时」→ 报出 44 项失败，而代码一行没错。
 *
 * 更坏的情况是反过来的：残留服务恰好是好的，测试全绿，
 * 但你其实是在验证一个**几分钟前就编译好的旧产物**。
 *
 * ── 现在的做法 ──────────────────────────────────────────────────
 * 自己挑一个空闲端口 → 用一次性数据库起服务 → 跑完杀掉 → 删库。
 * 测试不再依赖外部环境，也不会往 server/data/app.db 里灌测试账号。
 *
 * 想对已经跑着的服务做测试时，设 BASE 环境变量即可跳过起服务这一步。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

/* 测试用的引导管理员凭据。
 *
 * 必须显式指定，因为服务端现在**没有内置默认密码**了 —— 源码和 README 是公开的，
 * 写死一个能用的口令等于把钥匙挂在门上（这个仓库以前就犯过：README 里
 * 明写着某个真实邮箱和一个可用的口令）。
 *
 * 这组值只在测试里用，明文写出来没关系：它连的是一次性数据库，
 * 服务跑完就连库一起删了。 */
export const TEST_ADMIN_EMAIL = 'admin@test.local';
export const TEST_ADMIN_PASSWORD = 'test-admin-pw';

/**
 * 要一个当前空闲的端口。
 *
 * 做法是先让内核分配（bind 0）拿到号，再立刻释放，然后用它去起服务。
 * 这中间有一个理论上的竞态窗口 —— 别的进程可能正好抢走。
 * 但比起写死 5180，它把「必然冲突」降成了「几乎不可能冲突」。
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询 /api/health，直到服务可用、超时、或进程已经死了。 */
async function waitForHealth(base, { proc, logPath, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    // 进程已经退出 → 没必要再等，直接把服务端日志带出来
    if (proc.exitCode !== null) {
      const log = safeRead(logPath);
      throw new Error(
        `服务进程提前退出（退出码 ${proc.exitCode}）。服务端日志：\n` +
        indent(tail(log, 20))
      );
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.ok) return body;
      }
      lastErr = new Error(`健康检查返回 ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }

  const log = safeRead(logPath);
  throw new Error(
    `等待服务就绪超时（${timeoutMs}ms）：${lastErr?.message || '未知原因'}\n` +
    `服务端日志：\n${indent(tail(log, 20))}`
  );
}

/**
 * 起一个测试专用服务。
 *
 * @param {object}  opts
 * @param {number} [opts.port]    不传就自动挑空闲端口
 * @param {string} [opts.dbPath]  不传就在临时目录建一次性库
 * @param {string} [opts.tag]     日志文件名用的标记
 */
export async function startServer({ port, dbPath, tag = 'run' } = {}) {
  const usePort = port || (await freePort());
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `yanshu-${tag}-`));
  const useDb = dbPath || path.join(tmpDir, 'test.db');
  const logPath = path.join(tmpDir, 'server.log');

  const fd = fs.openSync(logPath, 'w');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(usePort),
      HOST: '127.0.0.1',
      DB_PATH: useDb,
      // 显式给一组确定的管理员凭据，否则服务端会现场随机生成一个并打印出来，
      // 测试没法知道它是什么（也就登不进管理台）。
      ADMIN_EMAIL: TEST_ADMIN_EMAIL,
      ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
      // 日志只留警告以上 —— 之前用 info 级别，一次全量测试的日志有 1.5MB，
      // 全在刷「incoming request」，真正有用的那行反而被埋了。
      LOG_LEVEL: 'warn',
    },
    // 直接写文件，不走管道：Chromium 之类的孙进程会继承 fd，
    // 嵌套管道会让外层 `| tail` 等不到 EOF（这个坑在 run-all 里已经踩过一次）。
    stdio: ['ignore', fd, fd],
  });

  const base = `http://127.0.0.1:${usePort}`;
  const health = await waitForHealth(base, { proc, logPath });

  return {
    base,
    port: usePort,
    dbPath: useDb,
    logPath,
    health,
    async stop() {
      try { proc.kill('SIGTERM'); } catch { /* 已经没了 */ }
      // 给它 3 秒优雅关闭（服务端自己会 app.close()），超时就强杀
      const deadline = Date.now() + 3000;
      while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
      if (proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* 已经没了 */ }
      }
      try { fs.closeSync(fd); } catch { /* 已关 */ }
      // 一次性库连同日志一起清掉。删不掉也不该让测试失败。
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 无所谓 */ }
    },
  };
}

/* ---------- 小工具 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 这个数据库路径在不在临时目录里。
 *
 * 用途：`BASE=… npm test` 对着已有服务测时，拒绝把测试跑在真实数据库上 ——
 * 测试会灌账号（browser_*@test.local）和作答记录，跑完不清理。
 * 实测污染过一次：一个真实账号旁边躺了 17 个测试账号。
 *
 * ★ 不能直接拿 os.tmpdir() 做字符串前缀比较。
 *   macOS 上 os.tmpdir() 返回 /var/folders/xx/…/T，而 /tmp 是指向
 *   /private/tmp 的软链 —— 谁都不是谁的前缀。直接比的话
 *   DB_PATH=/tmp/xxx.db 会被误判成真实库，把 README 里推荐的用法也挡掉。
 *   所以先把候选根目录 realpath 化再比。这个坑第一次就踩了。
 *
 * @param {string} dbPath 数据库文件的绝对路径
 * @returns {boolean} 路径为空时返回 false（信息不足时按「不确定」处理，由调用方决定）
 */
export function isTempDbPath(dbPath) {
  const p = String(dbPath || '');
  if (!p) return false;

  const roots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp']
    .map((r) => { try { return fs.realpathSync(r); } catch { return null; } })
    .filter(Boolean);

  /* 数据库文件可能还不存在，所以拿它的**目录**去 realpath。 */
  const dir = (() => {
    try { return fs.realpathSync(path.dirname(p)); } catch { return path.dirname(p); }
  })();

  return roots.some((r) => dir === r || dir.startsWith(r + path.sep));
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return '(读不到日志)'; }
}

function tail(s, n) {
  const lines = String(s).split('\n').filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

function indent(s) {
  return String(s).split('\n').map((l) => '    ' + l).join('\n');
}
