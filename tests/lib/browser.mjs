/* 零依赖的 headless 浏览器工具 —— 给「起浏览器 + 走 CDP」这类脚本共用。
 *
 * 从 tests/screenshot.mjs 里抽出来的。抽出来是因为色带检测（tests/banding.mjs）
 * 也要起浏览器，而它需要的是**画布原生分辨率**下的采集（见那边的注释），
 * 不能直接读截图脚本产出的 DPR 2 图。
 *
 * 不用 playwright / puppeteer：这个项目的测试是零 npm 依赖的，
 * 而这里需要的只有「起一个带 WebGL2 的 Chromium + 说 CDP」。
 *
 * ⚠️ 软件 WebGL2 必须带那三个 --use-gl / --use-angle / --enable-unsafe-swiftshader，
 *    否则 headless 下 getContext('webgl2') 直接返回 null，
 *    于是测出来的全是 CSS 降级背景 —— 而"降级态长得对"不代表"WebGL 态长得对"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 找本机可用的 Chromium 内核。
 * 返回 { bin, kind }，找不到返回 null。
 *
 * 这个查找逻辑和 tests/browser-smoke.mjs 保持一致 ——
 * 那套逻辑已经在 CI（Ubuntu + Playwright 缓存）上验证过了。
 */
export function findBrowser() {
  const home = os.homedir();
  // Playwright 缓存的 headless shell：不需要显示器，启动最快
  for (const base of [`${home}/Library/Caches/ms-playwright`, `${home}/.cache/ms-playwright`]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('chromium_headless_shell-')) continue;
      for (const rel of [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell',
      ]) {
        const bin = path.join(base, d, rel);
        if (fs.existsSync(bin)) return { bin, kind: 'shell' };
      }
    }
  }
  const cands = [
    { bin: process.env.BROWSER, kind: 'chrome' },
    { bin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
    { bin: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chrome' },
    { bin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'chrome' },
    { bin: '/usr/bin/google-chrome', kind: 'chrome' },
    { bin: '/usr/bin/google-chrome-stable', kind: 'chrome' },
    { bin: '/usr/bin/chromium', kind: 'chrome' },
    { bin: '/usr/bin/chromium-browser', kind: 'chrome' },
    { bin: '/opt/google/chrome/chrome', kind: 'chrome' },
    { bin: '/snap/bin/chromium', kind: 'chrome' },
  ];
  for (const c of cands) {
    if (!c.bin) continue;
    try { if (fs.existsSync(c.bin)) return c; } catch { /* 权限问题就当没有 */ }
  }
  return null;
}

/** 极简 CDP 客户端。只做「发一条命令、等一条结果」。 */
export function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      listeners.forEach((fn) => fn(m));
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('CDP 连不上')));
  });
  return {
    ready,
    send(method, params, timeout = 25000) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => {
          if (waiting.has(id)) { waiting.delete(id); reject(new Error(method + ' 超时')); }
        }, timeout);
      });
    },
    on(fn) { listeners.push(fn); },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
}

/**
 * 起一个 headless Chromium，返回一个已经连好 CDP 的 page。
 * 用完必须调 kill()（它会 SIGKILL 进程并删掉临时 profile）。
 */
export async function launchPage({ width = 1440, height = 900, browser = null } = {}) {
  const found = browser ? { bin: browser, kind: 'chrome' } : findBrowser();
  if (!found) throw new Error('找不到 Chromium 内核（可用 BROWSER 环境变量指定）');
  const { bin, kind } = found;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wukong-cdp-'));
  const args = [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    /* ★ 软件 WebGL2，缺一不可（见文件头注释） */
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--window-size=${width},${height}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    'about:blank',
  ];
  /* Chrome / Edge 要显式进 headless；chrome-headless-shell 本身就是 headless，加了会报错 */
  if (kind === 'chrome') args.unshift('--headless=new');

  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  /* ★ stderr 必须**一直读**。接成管道却没人读，缓冲（64KB）一满，
   * 浏览器进程就阻塞在 write 上，所有 CDP 命令永久挂起 ——
   * 报出来的是"命令超时"，跟真正的原因差十万八千里。 */
  const stderrTail = [];
  proc.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue;
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    }
  });

  const kill = () => {
    try { proc.stderr?.destroy(); } catch { /* 已关 */ }
    try { proc.kill('SIGKILL'); } catch { /* 已退 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  };

  let dbgPort = null;
  for (let i = 0; i < 100; i++) {
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) { dbgPort = fs.readFileSync(f, 'utf8').trim().split('\n')[0]; break; }
    await sleep(200);
  }
  if (!dbgPort) { kill(); throw new Error('拿不到浏览器调试端口'); }

  const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('浏览器里没有 page 目标'); }

  const client = cdpClient(target.webSocketDebuggerUrl);
  await client.ready;

  return { client, bin, kill, stderrTail, dbgPort };
}

/**
 * 列出浏览器里当前所有 page 目标（标签页）。
 *
 * 走 HTTP 的 /json/list 而不是 CDP 的 Target.getTargets —— 后者只在
 * **浏览器级**会话上可用，而这里连的是某个 page 的会话，调它会报
 * "not allowed"。HTTP 端点没有这个限制，而且不用额外建连接。
 *
 * 用途：站内链接现在一律 target="_blank"，断言「真的新开了一个标签」
 * 只能靠对比点击前后这里的目标列表（见 tests/browser-smoke.mjs）。
 */
export async function listPages(dbgPort) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
    return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
  } catch {
    return [];
  }
}
