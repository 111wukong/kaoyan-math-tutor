/* 源码里不许出现可用的凭据
 *
 * ── 为什么值得一个专门的套件 ──────────────────────────────────────
 * 这个仓库曾经把管理员的**真实邮箱**和一个**可用口令**同时写在源码和 README 里，
 * 一共 5 个文件（migrate.js / README.md / smoke.mjs / browser-smoke.mjs / screenshot.mjs）。
 * 公开仓库里的凭据就是公开凭据。
 *
 * 而这类错误靠人眼 review 拦不住 —— 它看起来「只是个方便的默认值」，
 * 甚至还有一段听起来很合理的注释解释为什么要留着它。所以只能靠机器扫。
 *
 * ── 两道检查 ──────────────────────────────────────────────────────
 *   1. 回归：那几个具体值不许再出现（防止有人「顺手改回来」）
 *   2. 通用：敏感命名的变量不许直接赋字面量；已知的密钥形状一律拦
 *
 * 允许的写法：占位值（test / example / your / dummy…）和从环境变量读。
 * 如果扫描误报，**不要**放宽规则去迁就它 —— 把那个值改成明显的占位，
 * 或者加进下面的 ALLOW 并写清为什么。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; } else { fail += 1; console.error(`  \x1b[31m✗\x1b[0m ${msg}`); }
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

/* ---------- 要扫哪些文件 ---------- */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'screenshots', '.workbuddy-ai']);
const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.sql', '.yml', '.yaml', '.sh', '.command', '.html']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const rel = (p) => path.relative(ROOT, p);

/* ---------- 规则 ---------- */

/* 1. 回归：这几个值曾经真的泄漏过，不许再出现。
 *    即使它们已经作废（密码会换掉），留着也说明有人在往回抄。 */
const LEAKED = [
  { value: 'wgh123456', what: '曾经的默认管理员口令' },
  { value: 'wukong@qq.com', what: '管理员的真实邮箱' },
];

/* 2. 敏感命名 + 直接赋字面量。
 *    只认 `名字: '值'` / `名字 = '值'` 这种赋值形状，
 *    所以 `cloudKey: { type: 'string' }` 这类 schema 不会误报。 */
const SENSITIVE = /(password|passwd|secret|token|api[_-]?key|apikey|credential)\s*[:=]\s*(['"])([^'"]{4,})\2/gi;

/* 占位值白名单。故意宽松一点 —— 漏报一个占位值只是噪声，
 * 但漏报一个真凭据就是事故，所以宁可让规则吵。 */
const PLACEHOLDER = /^(test|example|your|dummy|fake|sample|placeholder|change|todo|xxx|none|null|undefined|string|boolean|number|object|array)/i;

/* 明显的**非**机密值：CSS 变量名、URL、路径。
 * 例子：Hud.tsx 里的 `token = "--color-cyan"` —— 那是设计令牌，不是凭据。 */
const NOT_SECRET = /^(--|https?:\/\/|\/|\.\/|\.\.\/)/;

/* 测试代码可以用字面量口令 —— 它们连的是一次性库，跑完连库一起删。
 * 但**生产代码和文档**不行，那才是会被部署出去的部分。
 *
 * 这个豁免是有代价的：真凭据被误粘进测试文件时，规则二抓不到。
 * 不过规则一（历史泄漏值回归）和规则三（密钥形状）对测试文件照样生效，
 * 而这次泄漏的 5 个文件里，测试文件占 3 个 —— 那 3 个是被规则一抓住的。 */
const LITERAL_OK_PREFIXES = ['tests/', 'server/scripts/'];

/* 3. 已知的密钥形状 —— 不管变量叫什么名字，长这样就拦。 */
const SECRET_SHAPES = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, what: 'OpenAI 风格的 API Key' },
  { re: /\bghp_[A-Za-z0-9]{20,}/, what: 'GitHub Personal Access Token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, what: 'GitHub 细粒度 Token' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/, what: 'Google API Key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: 'Slack Token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS Access Key ID' },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, what: 'JWT' },
];

/* 逐行豁免：确实需要写字面量的地方，写清理由。
 * 尽量别加 —— 每加一条，扫描就少一分用处。 */
const ALLOW = [
  // 测试用的临时库凭据，连的是一次性数据库（见 tests/lib/server.mjs 的注释）
  { file: 'tests/lib/server.mjs', contains: 'test-admin-pw', why: '测试引导密码，只连一次性库' },
  // 上面那段占位值白名单自己
  { file: 'tests/no-secrets.mjs', contains: 'PLACEHOLDER', why: '规则自身的定义' },
  { file: 'tests/no-secrets.mjs', contains: 'LEAKED', why: '规则自身的定义' },
];

const isAllowed = (file, line) => ALLOW.some((a) => file === a.file && line.includes(a.contains));

/* ---------- 开始扫 ---------- */
section('一、历史泄漏值的回归检查');

for (const { value, what } of LEAKED) {
  const hits = [];
  for (const f of files) {
    if (rel(f) === 'tests/no-secrets.mjs') continue;   // 规则自己写了这些值
    const text = fs.readFileSync(f, 'utf8');
    if (!text.includes(value)) continue;
    text.split('\n').forEach((line, i) => {
      if (line.includes(value)) hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  ok(hits.length === 0, `「${what}」(${value}) 又出现了：${hits.join('、')}`);
}

section('二、敏感命名直接赋字面量');

const suspicious = [];
for (const f of files) {
  const file = rel(f);
  if (LITERAL_OK_PREFIXES.some((p) => file.startsWith(p))) continue;

  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isAllowed(file, line)) return;
    // 跳过注释行 —— 注释里举例说明不算泄漏
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')) return;

    SENSITIVE.lastIndex = 0;
    let m;
    while ((m = SENSITIVE.exec(line)) !== null) {
      const value = m[3];
      if (PLACEHOLDER.test(value)) continue;
      if (NOT_SECRET.test(value)) continue;
      suspicious.push(`${file}:${i + 1}  ${m[1]} = "${value}"`);
    }
  });
}
ok(suspicious.length === 0,
  `发现 ${suspicious.length} 处敏感变量直接赋了字面量：\n      ${suspicious.join('\n      ')}`);

section('三、已知密钥形状');

for (const { re, what } of SECRET_SHAPES) {
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (isAllowed(rel(f), line)) return;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return;

      const m = line.match(re);
      if (!m) return;
      /* 长得像但明显是假的：`sk-smoke-test-key-1234567890` 这种。
       * 假 Key 必须能用 —— 测试要靠它验「未配置时不回传 Key 原文」，
       * 所以不能一律拦掉「像 Key 的字符串」，得看它里面有没有自曝身份的词。 */
      if (/(test|fake|example|stub|dummy|sample|placeholder)/i.test(m[0])) return;

      hits.push(`${rel(f)}:${i + 1}  ${m[0].slice(0, 24)}…`);
    });
  }
  ok(hits.length === 0, `扫到 ${what}：${hits.join('、')}`);
}

/* ---------- 四、扫描器自身的有效性 ----------
 * 不验这一条的话，正则写错（比如忘了 lastIndex 归零、或者 SENSITIVE 是全局正则
 * 导致 exec 在循环里跳行）也会一直报「全绿」—— 那比没有扫描更危险。 */
section('四、扫描器自身的有效性');

{
  const probe = (line) => {
    SENSITIVE.lastIndex = 0;
    const m = SENSITIVE.exec(line);
    return m ? m[3] : null;
  };
  ok(probe("const ADMIN_PASSWORD = 'hunter2xyz';") === 'hunter2xyz',
    '能抓出「敏感变量 = 字面量」');
  ok(probe("password: 'abcd1234',") === 'abcd1234',
    '能抓出对象字面量里的写法');
  ok(probe("const pw = process.env.ADMIN_PASSWORD || null;") === null,
    '不误报「从环境变量读」');
  ok(probe("cloudKey: { type: 'string' },") === null,
    '不误报 JSON schema 的 type 声明');
  ok(PLACEHOLDER.test('test-admin-pw') === true, '占位值白名单认得 test- 前缀');
  ok(PLACEHOLDER.test('hunter2xyz') === false, '占位值白名单不会把真口令当占位');
}

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ 凭据扫描：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  console.log('\x1b[33m   源码和 README 是公开的 —— 这里的每一条都等于把钥匙挂在门上。\x1b[0m');
  process.exit(1);
}
console.log(`\x1b[32m✅ 凭据扫描：${pass} 项\x1b[0m`);
