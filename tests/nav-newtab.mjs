/* 站内链接约定：一律新标签页打开
 *
 * ── 为什么要有这个套件 ────────────────────────────────────────────
 * 「站内链接在新标签页打开」是一条**全局约定**，实现方式却是「每个链接都从
 * @/lib/links 取组件」。这种约定的失效方式是静默的：某次加新页面时
 * 顺手写了一句 `import { Link } from 'react-router-dom'`，
 * 那一个链接就悄悄回到了单标签页行为 —— 页面照常工作，没有任何报错，
 * 只有用户点下去才发现「上一个页面没了」。
 *
 * 所以这里静态扫一遍源码，把约定变成一条会失败的断言。
 *
 * ── 顺带守住服务端那一半 ──────────────────────────────────────────
 * 新标签页打开 `/quiz` 时，浏览器是**直接请求这个路径**的，
 * 不再经过前端路由。服务端必须把非 /api 的未知路径回退到 index.html，
 * 否则用户看到的是一个 404 而不是页面。这条也在下面断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'web/src');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

/** 递归收集 .ts/.tsx 源文件 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (p) => path.relative(REPO, p);

/* ============================================================
   1. 只有 links.tsx 允许直接从 react-router-dom 取 Link / NavLink
   ============================================================ */
section('1. 链接组件必须从 @/lib/links 取');
{
  /* 允许从 react-router-dom 取的东西：hook 和路由容器。
   * 这些和「跳转行为」无关，不需要包装。 */
  const ALLOWED = new Set(['useNavigate', 'useLocation', 'useParams', 'useSearchParams',
    'matchPath', 'Route', 'Routes', 'Navigate', 'BrowserRouter']);

  const offenders = [];
  for (const f of files) {
    if (rel(f) === 'web/src/lib/links.tsx') continue;   // 包装层自己当然要用原版
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'react-router-dom'/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const bad = names.filter((n) => !ALLOWED.has(n));
      if (bad.length) offenders.push(`${rel(f)} → ${bad.join(', ')}`);
    }
  }
  ok('★ 没有文件绕过 @/lib/links 直接用 Link / NavLink',
    offenders.length === 0,
    offenders.slice(0, 6).join(' | '));
}

/* ============================================================
   2. 包装层的默认行为确实是「新标签页」
   ============================================================ */
section('2. 包装层默认新标签页');
{
  const src = fs.readFileSync(path.join(SRC, 'lib/links.tsx'), 'utf8');
  ok('默认 target 是 _blank', /DEFAULT_TARGET[^=]*=\s*'_blank'/.test(src));
  ok('带了 rel=noopener（防 window.opener 反向操作原页面）',
    /noopener/.test(src) && /noreferrer/.test(src));
  ok('导出了 AppLink 与 AppNavLink', /export function AppLink/.test(src) && /export function AppNavLink/.test(src));
  ok('两个组件共用同一个默认值（改一处就全站生效）',
    (src.match(/DEFAULT_TARGET/g) || []).length >= 3);
}

/* ============================================================
   3. 服务端：非 /api 的未知路径要回退到 index.html
   ============================================================ */
section('3. 服务端 SPA 回退');
{
  const src = fs.readFileSync(path.join(REPO, 'server/src/index.js'), 'utf8');
  ok('有 setNotFoundHandler', /setNotFoundHandler/.test(src));
  ok('★ 非 /api 路径回退到 index.html（否则新标签打开 /quiz 是 404）',
    /startsWith\('\/api\/'\)[\s\S]{0,200}sendFile\('index\.html'\)/.test(src));
  ok('/api 路径仍然返回 404 JSON（不能把接口错误也回退成 HTML）',
    /接口不存在/.test(src));
}

/* ============================================================
   4. 自检：检测器真的会报警吗
   ============================================================ */
section('4. 自检：检测器真的会报警吗');
{
  const scan = (src) => {
    const ALLOWED = new Set(['useNavigate', 'useLocation', 'useParams', 'useSearchParams',
      'matchPath', 'Route', 'Routes', 'Navigate', 'BrowserRouter']);
    const bad = [];
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'react-router-dom'/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      bad.push(...names.filter((n) => !ALLOWED.has(n)));
    }
    return bad;
  };
  ok('对绕过包装层的写法会报警',
    scan("import { Link } from 'react-router-dom';").length === 1);
  ok('对 hook 不误报',
    scan("import { useNavigate, useLocation } from 'react-router-dom';").length === 0);
  ok('对别名写法也能抓到',
    scan("import { NavLink as L } from 'react-router-dom';").length === 1);
}

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ 站内链接约定：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 站内链接约定：${pass} 项\x1b[0m`);
