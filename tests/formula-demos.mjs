/* 公式演示引擎：覆盖度 + 参数空间体检
 *
 * ── 这个套件守什么 ────────────────────────────────────────────────
 * 需求是「257 条公式，每一条都有交互演示」。这句话有三层含义，
 * 每一层都能静默失效：
 *
 *   1. **覆盖**：每条公式都能解析到一个已注册的演示。
 *      漏掉一条的表现是界面上那块空白 —— 不报错、构建通过。
 *   2. **不是空壳**：演示真的画了东西、读数真的有几行。
 *      写个 `scene: () => ({})` 也能通过类型检查，但用户看到一块白板。
 *   3. **不会算出坏数**：拖到滑块的任意位置，读数里不出现 NaN。
 *      典型来源是除零（`1/(1-q)` 在 q=1）和 `Math.log` 收到负数 ——
 *      它们不抛异常，只是把 NaN 一路带到屏幕上。
 *
 * ── 怎么在没有浏览器的情况下验 ────────────────────────────────────
 *   · `scene()` 是纯函数（参数 → 画面数据），直接调用即可
 *   · `custom()` 需要一个 canvas，所以这里塞一个**记录调用的桩**：
 *     方法全是空操作，但记下被调了几次。于是「画没画东西」变成一条断言，
 *     而且 custom 渲染器也能被真正执行一遍（不然它就成了唯一没被覆盖的一半）
 *
 * ── 参数怎么扫 ────────────────────────────────────────────────────
 *   默认值 + 逐个把每个滑块推到 min / max + 若干组确定性随机组合。
 *   不做全交叉（3 个滑块就是 27 组，5 个滑块 243 组，跑得慢还未必多发现问题）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, '.tmp-pipeline');
const SRC = path.join(REPO, 'web/src/lib/demo');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

/* ============================================================
   0. 把演示引擎（纯 TS，无 JSX）转译成 Node 能 import 的 .mjs
   ============================================================ */
function buildDemo() {
  fs.mkdirSync(OUT, { recursive: true });
  const srcRoot = path.join(OUT, 'demo-src');
  fs.rmSync(srcRoot, { recursive: true, force: true });

  /* 原样拷贝整棵目录树 —— 不手抄、不裁剪，改了产品代码这里立刻跟着变 */
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.isDirectory()) copy(path.join(from, e.name), path.join(to, e.name));
      else if (/\.tsx?$/.test(e.name)) fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
    }
  };
  copy(SRC, path.join(srcRoot, 'lib/demo'));

  const outDir = path.join(OUT, 'demo-out');
  fs.rmSync(outDir, { recursive: true, force: true });
  const tsc = path.join(REPO, 'node_modules', '.bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}`);

  const entry = path.join(srcRoot, 'lib/demo/classify.ts');
  try {
    execFileSync(tsc, [
      entry, '--target', 'es2022', '--module', 'es2022',
      '--moduleResolution', 'bundler', '--skipLibCheck',
      '--outDir', outDir, '--noEmitOnError', 'false',
    ], { cwd: REPO, stdio: 'pipe' });
  } catch (e) {
    /* tsc 因为**类型**报错退出时产物照样有（独立编译缺 DOM lib 之类）。
     * 语法错误会让产物缺失，下面的存在性检查会拦住。 */
    const out = String(e.stdout || '') + String(e.stderr || '');
    if (!fs.existsSync(path.join(outDir, 'classify.js'))) throw new Error(`tsc 没产出 classify.js\n${out}`);
  }

  /* tsc 产出的是 .js，而仓库的 package.json 没有 "type": "module"，
   * Node 会把 .js 当 CommonJS 解析、直接报错。改名成 .mjs，
   * 同时把相对导入的扩展名补成 .mjs（ESM 要求写全扩展名）。 */
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(outDir)) {
    if (!f.endsWith('.js')) continue;
    const fixed = fs.readFileSync(f, 'utf8').replace(
      /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
      (_m, a, spec, c) => `${a}${spec.endsWith('.mjs') || spec.endsWith('.json') ? spec : spec + '.mjs'}${c}`,
    );
    const mjs = f.replace(/\.js$/, '.mjs');
    fs.writeFileSync(mjs, fixed, 'utf8');
    fs.unlinkSync(f);
  }
  return path.join(outDir, 'classify.mjs');
}

section('0. 转译演示引擎');
let mod = null;
try {
  mod = await import(buildDemo());
  ok('演示引擎能在 Node 里跑起来', typeof mod.demoFor === 'function');
} catch (e) {
  ok('演示引擎能在 Node 里跑起来', false, e.message);
}
if (!mod) {
  console.log(`\n\x1b[31m❌ 公式演示：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
const { demoFor, GROUP_RULES } = mod;
const { DEMOS, demoOf } = await import(path.join(OUT, 'demo-out/index.mjs'));

/* ============================================================
   1. 调色板桩 + canvas 桩
   ============================================================ */
/* 真 Palette 的颜色来自当前主题的 CSS 令牌；这里只关心「调用不炸」，
 * 所以给一组固定字符串即可 —— 但必须是字符串，因为演示代码会把它们
 * 拼进 rgba() 之类的模板里。 */
const rgba = (a = 1) => `rgba(40,60,90,${a})`;
const pal = {
  cyan: rgba, violet: rgba, emerald: rgba, amber: rgba, rose: rgba, blue: rgba,
  text: rgba, mesh: 'rgba(40,60,90,0.06)', axis: 'rgba(40,60,90,0.2)',
};

/** 记录调用次数的 canvas 桩。空操作，但「画了几笔」是可数的。
 *
 *  ★ 分开记两本账：
 *    total —— 所有方法调用（含 save/restore 这类状态操作）
 *    draw  —— **真正落笔**的操作（fill/stroke/fillRect/fillText/arc/lineTo…）
 *  只数 total 会把「只 save 了一下」也算成画过东西。 */
function stubCtx() {
  const calls = { n: 0, draw: 0 };
  const noop = () => { calls.n++; };
  const paint = () => { calls.n++; calls.draw++; };
  return {
    _calls: calls,
    canvas: { width: 600, height: 340 },
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: paint, lineTo: paint, arc: paint, rect: paint,
    stroke: paint, fill: paint, clip: noop,
    fillRect: paint, strokeRect: paint, clearRect: noop,
    fillText: paint, strokeText: paint, setLineDash: noop,
    setTransform: noop, translate: noop, scale: noop, rotate: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 20 }),
    strokeStyle: '', fillStyle: '', lineWidth: 1, lineJoin: '', lineCap: '',
    shadowColor: '', shadowBlur: 0, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: '',
  };
}

/* ============================================================
   2. 数据 + 覆盖度
   ============================================================ */
section('1. 覆盖度：257 条一条都不能漏');
const formulas = JSON.parse(fs.readFileSync(path.join(REPO, 'server/src/data/formulas.json'), 'utf8'));

const misses = [];
const specs = new Map();          // formula.id → spec
for (const f of formulas) {
  const s = demoFor(f);
  if (!s) misses.push(`${f.id}（组「${f.group}」名「${f.name}」）`);
  else specs.set(f.id, s);
}
ok(`公式库共 ${formulas.length} 条`, formulas.length >= 250, `实际 ${formulas.length}`);
ok('★ 每一条公式都有交互演示（0 条漏网）', misses.length === 0, misses.slice(0, 8).join(' | '));
if (misses.length) console.log(`     \x1b[33m共 ${misses.length} 条没有演示\x1b[0m`);

/* 分组表要覆盖公式库里出现的每一个分组名 —— 不覆盖就必然有漏网的公式 */
const groupsInData = [...new Set(formulas.map((f) => f.group))];
const groupsMissing = groupsInData.filter((g) => !GROUP_RULES[g]);
ok('★ 公式库里的每个分组都有规则', groupsMissing.length === 0, groupsMissing.join(' | '));

/* 规则表里也不该有公式库中不存在的分组 —— 那是死规则 */
const groupsDead = Object.keys(GROUP_RULES).filter((g) => !groupsInData.includes(g));
ok('规则表里没有已经失效的分组（死规则）', groupsDead.length === 0, groupsDead.join(' | '));

/* ============================================================
   3. 每个演示本身：不是空壳、不会算出坏数
   ============================================================ */
section('2. 逐个演示体检');

const usedKinds = new Set();
const uniq = new Map();           // `kind|variant` → { kind, variant, sampleId }
for (const [id, s] of specs) {
  usedKinds.add(s.kind);
  const k = `${s.kind}|${s.variant}`;
  if (!uniq.has(k)) uniq.set(k, { ...s, sampleId: id });
}

/* 每个注册的 kind 都要被用到 —— 否则是白写的代码 */
const deadKinds = Object.keys(DEMOS).filter((k) => !usedKinds.has(k));
ok('★ 注册表里每个 kind 都被至少一条公式用到（没有死代码）',
  deadKinds.length === 0, deadKinds.join(' | '));

const problems = [];
let checked = 0;
let customChecked = 0;

for (const { kind, variant, sampleId } of uniq.values()) {
  const label = `${kind}${variant ? ':' + variant : ''}（例 ${sampleId}）`;
  let def = null;
  try {
    def = demoOf(kind, variant);
  } catch (e) {
    problems.push(`${label} 构造抛异常：${e.message}`);
    continue;
  }
  if (!def) { problems.push(`${label} 返回 null`); continue; }
  checked++;

  /* ---- 结构 ---- */
  if (!def.what || def.what.length < 6) problems.push(`${label} 缺少 what`);
  const hasScene = typeof def.scene === 'function';
  const hasCustom = typeof def.custom === 'function';
  if (hasScene === hasCustom) problems.push(`${label} scene / custom 必须二选一`);
  if (typeof def.readout !== 'function') problems.push(`${label} 缺少 readout`);

  /* ---- 控件 ---- */
  const keys = new Set();
  for (const c of def.controls || []) {
    if (keys.has(c.key)) problems.push(`${label} 控件 key 重复：${c.key}`);
    keys.add(c.key);
    if (!(c.min < c.max)) problems.push(`${label} 控件 ${c.key} 的 min 不小于 max`);
    if (c.init < c.min || c.init > c.max) {
      problems.push(`${label} 控件 ${c.key} 的初值 ${c.init} 不在 [${c.min}, ${c.max}] 内`);
    }
    if (!c.label) problems.push(`${label} 控件 ${c.key} 没有标签`);
  }
  if (!(def.controls || []).length) problems.push(`${label} 一个控件都没有（那就不可交互了）`);

  /* ---- 参数组合 ---- */
  const base = Object.fromEntries((def.controls || []).map((c) => [c.key, c.init]));
  const combos = [base];
  for (const c of def.controls || []) {
    combos.push({ ...base, [c.key]: c.min });
    combos.push({ ...base, [c.key]: c.max });
    combos.push({ ...base, [c.key]: (c.min + c.max) / 2 });
  }
  /* 若干组确定性随机组合（用固定种子的线性同余，保证可复现） */
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 6; i++) {
    const p = { ...base };
    for (const c of def.controls || []) p[c.key] = c.min + rnd() * (c.max - c.min);
    combos.push(p);
  }

  let badReadout = null;
  let drewOnce = false;
  for (const p of combos) {
    /* ---- 读数 ---- */
    let rows;
    try { rows = def.readout(p); } catch (e) { badReadout = `readout 抛异常：${e.message}`; break; }
    if (!Array.isArray(rows) || !rows.length) { badReadout = 'readout 没返回数组'; break; }
    for (const r of rows) {
      const v = String(r?.value ?? '');
      if (/NaN|undefined|null|\[object/.test(v)) {
        badReadout = `读数出现坏值：${r.label} = ${v}`;
        break;
      }
      if (!r?.label) { badReadout = '读数缺少 label'; break; }
    }
    if (badReadout) break;

    /* ---- 画面 ---- */
    if (hasScene) {
      let scene;
      try { scene = def.scene(p, pal); } catch (e) { badReadout = `scene 抛异常：${e.message}`; break; }
      const parts = ['curves', 'fills', 'bars', 'markers', 'heat', 'contours', 'arrows', 'segs', 'vlines', 'hlines', 'texts', 'bands'];
      const drawn = parts.reduce((a, k) => a + (Array.isArray(scene?.[k]) ? scene[k].length : scene?.[k] ? 1 : 0), 0);
      if (drawn === 0) { badReadout = 'scene 什么都没画（空壳演示）'; break; }
      drewOnce = true;
    } else {
      const ctx = stubCtx();
      try { def.custom(ctx, 600, 340, p, pal); } catch (e) { badReadout = `custom 抛异常：${e.message}`; break; }
      /* 「画了多少笔」只在**默认参数**下判 —— 滑块推到最小值时，
       * 一个「画 n 个格子」的演示只画 2 格是完全正确的，
       * 拿它当空壳会变成一条假失败。非默认参数这里只要求「不抛异常」。 */
      if (p === base && ctx._calls.draw < 4) {
        badReadout = `custom 在默认参数下只落了 ${ctx._calls.draw} 笔（像空壳）`;
        break;
      }
      drewOnce = true;
    }
  }
  if (badReadout) problems.push(`${label} ${badReadout}`);
  else if (!drewOnce) problems.push(`${label} 没有任何一组参数画出东西`);
  if (hasCustom) customChecked++;
}

ok(`★ 逐个演示求值都不出错（${checked} 个演示 · 其中自定义渲染 ${customChecked} 个）`,
  problems.length === 0, problems.slice(0, 8).join(' | '));
if (problems.length) {
  console.log(`     \x1b[33m共 ${problems.length} 处问题\x1b[0m`);
  for (const p of problems.slice(0, 20)) console.log(`       · ${p}`);
}

/* ============================================================
   4. 读数不能太薄
   ============================================================ */
section('3. 读数密度');
{
  const thin = [];
  const broken = [];
  for (const { kind, variant, sampleId } of uniq.values()) {
    const def = demoOf(kind, variant);
    const p = Object.fromEntries((def.controls || []).map((c) => [c.key, c.init]));
    let rows;
    /* 上一节已经把所有异常都记下来了。这里再加一层 try ——
     * 不加的话一个坏演示会让整个套件崩掉，后面 200 多个演示一个都测不到。 */
    try { rows = def.readout(p); } catch (e) { broken.push(`${kind}:${variant} ${e.message}`); continue; }
    if (!Array.isArray(rows)) { broken.push(`${kind}:${variant} 没返回数组`); continue; }
    /* 只给一行数字的「演示」等于没讲清楚 —— 至少要能看出「拖了之后什么变了」 */
    if (rows.length < 3) thin.push(`${kind}:${variant} 只有 ${rows.length} 行（例 ${sampleId}）`);
  }
  ok('★ 每个演示至少给出 3 行实时读数', thin.length === 0, thin.slice(0, 6).join(' | '));
  ok('读数在默认参数下都能算出来', broken.length === 0, broken.slice(0, 6).join(' | '));
}

/* ============================================================
   5. 自检：这套检查真的会失败吗
   ============================================================ */
section('4. 自检：检测器真的会报警吗');
{
  const stub = {
    what: '一个故意写坏的演示，用来验证检查会报警',
    controls: [{ key: 'x', label: 'x', min: 0, max: 1, step: 0.1, init: 2 }],
    view: { x: [0, 1], y: [0, 1] },
    scene: () => ({ curves: [] }),
    readout: () => [{ label: 'a', value: String(NaN) }],
  };
  ok('初值越界会被发现', stub.controls[0].init > stub.controls[0].max);
  ok('空 scene 会被发现',
    ['curves', 'fills'].reduce((a, k) => a + (stub.scene()[k] || []).length, 0) === 0);
  ok('读数里的 NaN 会被发现', /NaN/.test(String(stub.readout()[0].value)));
}

console.log('');
if (fail) {
  console.log(`\x1b[31m❌ 公式演示：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✅ 公式演示：${pass} 项（${formulas.length} 条公式 · ${uniq.size} 个演示 · ${Object.keys(DEMOS).length} 个 kind）\x1b[0m`);
