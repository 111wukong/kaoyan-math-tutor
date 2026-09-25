/* 卡片库导出：打印 / 独立 HTML 里的数学公式必须真的渲染出来
 *
 * ── 为什么单开一个套件 ────────────────────────────────────────────
 * 「打印 / PDF」和「存 HTML」走的是 web/src/lib/deckExport.ts，那是
 * **第二条渲染管线** —— 和页面上的 RichText 不是同一份代码。
 * 后果是页面里公式好好的，导出出来满屏 \frac、\lim 的源码。
 *
 * 这个 bug 之前一直没被发现，原因很直接：**导出功能一条断言都没有**。
 * 页面渲染有三层检查（包裹对不对 / 会不会漏屏 / KaTeX 认不认），
 * 导出层一层都没有，而它的失效方式恰恰是静默的 ——
 * 页面不报错、构建通过、截图里也看不出（屏幕上 #print-portal 是 display:none）。
 *
 * ── 断言分三层，缺一层就会漏 ──────────────────────────────────────
 *   1. 打印容器里公式是 KaTeX 结构，且正文里**不许残留 LaTeX 源码**
 *      （只看「有没有 .katex」不够：一张卡片里两个公式，渲染一个也算有）
 *   2. 打印容器的公式拿到了 KaTeX 字体（computed font-family）——
 *      证明 CSS 真的作用到了纸上要输出的那棵树上
 *   3. 导出的单文件 HTML：内联了 KaTeX CSS、字体路径是绝对地址、
 *      并且**用 file:// 独立打开后公式依然是渲染态**（这才是「发给别人能看」）
 *
 * ── 关于「自检」──────────────────────────────────────────────────
 * 末尾有一节专门验检测器本身会报警。一个永远为绿的检查比没有检查更糟，
 * 它会让人以为有保护（这条教训写在 latex-coverage.mjs 里）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launchPage, sleep } from './lib/browser.mjs';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from './lib/server.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`); }
}
const section = (t) => console.log(`\n\x1b[36m【${t}】\x1b[0m`);

/* ============================================================
   测试用的卡片
   刻意覆盖题库里真实出现过的四种形态 —— 只用「$x^2$」这种乖巧的公式
   是测不出问题的（真实数据里根本没有 $，全是裸 LaTeX）：
     · 裸 LaTeX（68 个知识点的正文全是这个形态，一个 $ 都没有）
     · 花括号包事件（概率论遍地都是，会把扫描器从中间截断）
     · 矩阵环境（含 & 和 \\，逐字符扫会被切断）
     · 填空横线（连续下划线不是下标，KaTeX 遇到会报错）
     · 模型输出形态（提示词要求写 $...$，所以这条也必须覆盖）
   ============================================================ */
const CARDS = [
  {
    kid: 'dx-test-limit', title: '重要极限', type: 'formula',
    front: '求极限：\n\\lim_{x\\to 0}\\frac{\\sin x}{x}=1',
    back: '等价无穷小替换：\\sin x\\sim x',
  },
  {
    kid: 'dx-test-prob', title: '分布函数定义', type: 'point',
    front: '分布函数定义：F(x)=P\\{X\\le x\\}',
    back: '右连续：\\lim_{x\\to a^+}F(x)=F(a)',
  },
  {
    kid: 'dx-test-matrix', title: '矩阵乘法', type: 'formula',
    front: '二阶方阵：\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}',
    back: '',
  },
  {
    kid: 'dx-test-blank', title: '待填空', type: 'pitfall',
    front: '若 f(x) 连续，则 a = ______',
    back: '答案：a=1',
  },
  {
    kid: 'dx-test-model', title: '模型输出形态', type: 'problem',
    front: '当 $x\\to 0$ 时，$\\frac{\\tan x}{x}\\to 1$',
    back: '**重点**：分子分母同阶',
  },
];

/** 卡片里出现的 LaTeX 命令 —— 打印正文里一个都不许剩 */
const TEX_COMMANDS = ['\\frac', '\\lim', '\\sin', '\\to', '\\begin{', '\\le', '\\int', '\\tan'];

console.log('\x1b[1m研数 · 卡片库导出（打印 / 独立 HTML）\x1b[0m');
console.log(`目标 ${BASE}`);

/* ============================================================
   0. 静态检查：不依赖浏览器，先跑
   ============================================================
   这几条盯的是**这个 bug 的根因**本身，而不是它的表现。
   浏览器那几节验的是「这次输出对了」；这几条验的是「写法没退回去」——
   下次有人图省事再写 `window.katex`，这里会立刻拦住。 */
section('0. 静态：导出模块自身的约定');
{
  const src = fs.readFileSync(path.join(REPO, 'web/src/lib/deckExport.ts'), 'utf8');
  /* 剥掉注释再搜。文件头的注释里**故意**写着 window.katex（解释当年为什么坏），
   * 不剥的话这条断言会把自己的说明文字当成违规。 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('不再从 window 取 KaTeX（那是这次坏掉的根因）',
    !/window\s*\.\s*katex|\(window as any\)\.katex/.test(code),
    'deckExport.ts 里又出现了 window.katex');

  ok('复用了产品的渲染管线 renderRich',
    /from\s+'@\/components\/ui\/Math'/.test(code) && /\brenderRich\s*\(/.test(code));

  ok('KaTeX 的 CSS 是内联进来的（?inline）',
    /katex\/dist\/katex\.min\.css\?inline/.test(code));

  /* 内联 CSS 里的字体是相对路径，导出文件旁边没有 fonts 目录 ——
   * 必须改写成绝对地址，否则字体静默 404。
   * 这里只验「改写这一步还在」（不抠正则细节，那种断言太脆）；
   * 真正的验证在浏览器那节：内联 CSS 里不许再出现 url(fonts/…)。 */
  ok('字体路径做了绝对化改写',
    /fonts\//.test(code) && /KATEX_FONT_BASE/.test(code));

  /* ---- 版本号一致性 ----
   * 上面那个 CDN 地址里写死了版本号，和装的 katex 对不上就会去取
   * 一个不存在的字体目录（404，静默退化成系统字体）。 */
  const m = src.match(/export const KATEX_VERSION = '([^']+)'/);
  ok('KATEX_VERSION 常量存在', !!m, m ? m[1] : '没找到');
  if (m) {
    const installed = JSON.parse(
      fs.readFileSync(path.join(REPO, 'node_modules/katex/package.json'), 'utf8'),
    ).version;
    ok('KATEX_VERSION 和 node_modules 里装的 katex 一致',
      m[1] === installed, `源码里是 ${m[1]}，装的是 ${installed}`);
  }
}

/* ============================================================ */
const browser = findBrowser();
if (!browser) {
  console.log('[SKIP] 本机没有 Chromium 内核');
  console.log('\n\x1b[33m· 本机没找到 Chromium 内核，浏览器部分跳过（静态检查已跑）\x1b[0m');
  console.log('\n' + '─'.repeat(46));
  if (fail) {
    console.log(`\x1b[31m❌ 卡片库导出：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
    failures.forEach((f) => console.log(`  · ${f}`));
    process.exit(1);
  }
  console.log(`\x1b[33m✅ 卡片库导出：${pass} 项通过（浏览器部分已跳过）\x1b[0m`);
  process.exit(0);
}

console.log(`内核 ${browser.bin.replace(os.homedir(), '~')}`);

let ctx = null;
const tmpFiles = [];

try {
  ctx = await launchPage({ width: 1440, height: 900 });
  const { client } = ctx;

  await client.send('Runtime.enable');
  await client.send('Page.enable');

  const ev = async (expr) => {
    const r = await client.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return { value: r.result?.value };
  };
  /* 包成 async 函数：探针里经常要 await（灌数据、等 Blob 文本），
   * 用同步 IIFE 的话 `await` 直接是语法错误，报出来的是
   * 「Unexpected token」这种跟真实原因差很远的错。 */
  const probe = async (body) => {
    const r = await ev(`(async function(){try{${body}}catch(e){return 'PROBE_ERROR: '+(e&&e.message)}})()`);
    return r.error ? 'PROBE_ERROR: ' + r.error : r.value;
  };
  const nav = async (p) => client.send('Page.navigate', { url: `${BASE}${p}` });
  const waitFor = async (expr, label, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await ev(expr)).value === true) return true;
      await sleep(180);
    }
    console.log(`  \x1b[31m✗ 等待超时（${timeout}ms）：${label}\x1b[0m`);
    fail++; failures.push('等待超时：' + label);
    return false;
  };

  /* ---------- 0. 登录 + 灌测试卡片 ---------- */
  section('0. 准备数据');
  {
    await nav('/');
    await waitFor('!!document.querySelector("input[name=email]")', '登录页就位');

    const login = await probe(`
      return fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ${JSON.stringify(TEST_ADMIN_EMAIL)}, password: ${JSON.stringify(TEST_ADMIN_PASSWORD)} })
      }).then(function(r){ return r.status + ':' + (r.ok ? 'ok' : 'bad'); });`);
    ok('管理员登录成功', login === '200:ok', String(login));

    /* ★ 先清掉上一次跑剩下的测试卡片。
     *
     * 不清的话，重复在本机跑（对着同一个库、或者不走 run-all）卡片会越积越多，
     * 「打印容器里的卡片数正好是 5」这类断言就会突然变红 ——
     * 而红的原因跟代码毫无关系。这正是「本机红、CI 绿」的经典形态。
     *
     * 只删 dx-test- 前缀的（真实知识点 ID 不会长这样），
     * 所以万一有人对着自己的库单跑，也碰不到他的卡片。 */
    const cleaned = await probe(`
      var all = await (await fetch('/api/deck')).json();
      var mine = (all.cards || []).filter(function(c){ return String(c.kid).indexOf('dx-test-') === 0; });
      for (var i = 0; i < mine.length; i++) {
        await fetch('/api/deck/' + encodeURIComponent(mine[i].id), { method: 'DELETE' });
      }
      return mine.length;`);
    console.log(`  \x1b[90m（清掉 ${cleaned} 张上次遗留的测试卡片）\x1b[0m`);

    const made = await probe(`
      var cards = ${JSON.stringify(CARDS)};
      var codes = [];
      for (var i = 0; i < cards.length; i++) {
        var r = await fetch('/api/deck', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cards[i])
        });
        codes.push(r.status);
      }
      return JSON.stringify(codes);`);
    const codes = JSON.parse(made);
    ok(`${CARDS.length} 张测试卡片已入库`, codes.every((c) => c === 200), made);
  }

  /* ---------- 1. 卡片库页面本身：公式是渲染态 ---------- */
  /* 先钉住「屏幕上是对的」。不先确认这一点的话，后面导出红了也说不清
   * 是导出坏了还是数据/渲染整体坏了。 */
  section('1. 页面上的卡片（对照组）');
  {
    await nav('/deck');
    await waitFor('document.body.innerText.indexOf("卡片库") >= 0', '卡片库页面就位');
    await waitFor('document.querySelectorAll(".katex").length >= 4', '页面公式渲染完成');

    const d = JSON.parse(await probe(`
      var text = document.body.innerText;
      var cmds = ${JSON.stringify(TEX_COMMANDS)};
      var left = cmds.filter(function(c){ return text.indexOf(c) >= 0; });
      return JSON.stringify({ katex: document.querySelectorAll('.katex').length, left: left });`));
    ok('页面上渲染出 KaTeX 公式', d.katex >= 4, `${d.katex} 个`);
    ok('页面上没有残留 LaTeX 源码', d.left.length === 0, d.left.join(' '));
  }

  /* ---------- 2. 打印 / PDF ---------- */
  section('2. 打印 / PDF（#print-portal）');
  {
    /* window.print 换成记账用的桩。
     *
     * 为什么不放它真跑：headless 下它本来也不弹框，但行为随内核版本变；
     * 而且真正要验的是**portal 里那棵树的形状** —— 那才是送去排版的输入。
     * 桩同时也把「按钮真的触发了打印」这件事钉住了（否则按钮被改坏，
     * 后面所有断言会因为 portal 恰好还在而假绿）。 */
    /* ★ 先切到「打印」媒体再点。
     *
     * 屏幕上 #print-portal 是 display:none（见 styles/index.css），
     * 真正送去排版的只有 print 媒体下可见的那棵树。
     * 不切的话，「打印出来是乱码」这件事根本没被复现 —— 验的还是屏幕态。 */
    await client.send('Emulation.setEmulatedMedia', { media: 'print' });

    const clicked = await probe(`
      window.__printCalls = 0;
      window.print = function(){ window.__printCalls++; };
      var btn = Array.prototype.slice.call(document.querySelectorAll('button'))
        .filter(function(b){ return /打印\\s*\\/\\s*PDF/.test(b.textContent); })[0];
      if (!btn) return 'NO_BUTTON';
      if (btn.disabled) return 'DISABLED';
      btn.click();
      /* printDeck 是同步的：建 portal → window.print() → 800ms 后才移除。
         这里立刻读，不等。 */
      var p = document.getElementById('print-portal');
      if (!p) return 'NO_PORTAL';
      var html = p.innerHTML;
      var text = p.textContent;
      var cmds = ${JSON.stringify(TEX_COMMANDS)};
      var left = cmds.filter(function(c){ return text.indexOf(c) >= 0; });
      var katexEls = p.querySelectorAll('.katex');
      var ff = katexEls.length ? getComputedStyle(katexEls[0]).fontFamily : '';
      /* 「本次这几张都在」——比数数更精确：库里可能有别的卡片，
       * 单看总数说不出漏的是哪一张。 */
      var titles = ${JSON.stringify(CARDS.map((c) => c.title))};
      var missing = titles.filter(function(t){ return html.indexOf(t) < 0; });
      return JSON.stringify({
        calls: window.__printCalls,
        cards: p.querySelectorAll('.p-card').length,
        katex: katexEls.length,
        err: (html.match(/katex-error/g) || []).length,
        left: left,
        font: ff,
        missing: missing,
        /* 打印媒体下：容器要显示、应用界面要藏起来。
         * 这两条一起才说明「纸上印的就是这份卡片」，只有一条不够 ——
         * 容器显示了但应用没藏，纸上会是两套内容叠在一起。
         *
         * ★ 判据用 getClientRects() 而不是读 display：
         *   display:none 是被加在 **#root** 上的（body > *:not(#print-portal)），
         *   而 main-scroll 在 #root 里面 —— 它自己的 computed display 还是 block，
         *   读它会得到「应用可见」这个**错误**结论。真正要看的是
         *   「有没有生成可渲染的盒子」，那才是纸上会发生的事。 */
        portalVisible: p.getClientRects().length > 0,
        appVisible: (function(){
          var m = document.getElementById('main-scroll');
          return m ? m.getClientRects().length > 0 : 'MISSING';
        })(),
      });`);

    if (clicked === 'NO_BUTTON' || clicked === 'DISABLED' || clicked === 'NO_PORTAL') {
      ok('打印按钮可用且生成了打印容器', false, String(clicked));
    } else {
      const d = JSON.parse(clicked);
      ok('点按钮真的触发了 window.print', d.calls === 1, `调用 ${d.calls} 次`);
      ok('打印容器里有卡片', d.cards >= CARDS.length, `${d.cards} 张`);
      ok('本次建的卡片一张不漏', d.missing.length === 0, `缺：${d.missing.join(' / ')}`);
      /* ★ 核心断言。以前这里恒为 0：deckExport 从 window.katex 取 KaTeX，
         而 katex 是 ESM import 进来的，从没挂到 window 上。 */
      ok('打印容器里的公式是 KaTeX 结构', d.katex >= CARDS.length, `${d.katex} 个（期望 ≥${CARDS.length}）`);
      ok('打印容器里没有 KaTeX 报错块', d.err === 0, `${d.err} 个`);
      ok('打印正文里没有残留 LaTeX 源码', d.left.length === 0, d.left.join(' '));
      ok('公式拿到了 KaTeX 字体（CSS 生效）', /KaTeX/i.test(d.font), `font-family="${d.font}"`);
      ok('打印媒体下：卡片容器真的可见', d.portalVisible === true, `可见=${d.portalVisible}`);
      ok('打印媒体下：应用界面不再生成盒子（纸上不会两套内容叠着）',
        d.appVisible === false, `应用可见=${d.appVisible}`);
    }

    /* 恢复屏幕媒体 —— 后面几节要在正常状态下跑。 */
    await client.send('Emulation.setEmulatedMedia', { media: '' });
  }

  /* ---------- 3. 独立 HTML ---------- */
  section('3. 存 HTML（单文件）');
  let exported = null;
  {
    /* 拦截 Blob 而不是去翻下载目录：
     * 下载路径随内核/系统变，而 createObjectURL 拿到的一定是**同一个 Blob**。
     * 在页面里换掉它，导出内容就到手了 —— 不用改产品代码，也不用碰文件系统。 */
    await probe(`
      window.__deckHtml = null;
      if (!window.__origCOU) {
        window.__origCOU = URL.createObjectURL;
        URL.createObjectURL = function(b){
          try { b.text().then(function(t){ window.__deckHtml = t; }); } catch (e) {}
          return window.__origCOU.call(URL, b);
        };
      }
      return true;`);

    const clicked = await probe(`
      var btn = Array.prototype.slice.call(document.querySelectorAll('button'))
        .filter(function(b){ return /存\\s*HTML/.test(b.textContent); })[0];
      if (!btn) return 'NO_BUTTON';
      if (btn.disabled) return 'DISABLED';
      btn.click();
      for (var i = 0; i < 40; i++) {
        if (window.__deckHtml) break;
        await new Promise(function(r){ setTimeout(r, 50); });
      }
      return window.__deckHtml ? 'OK' : 'NO_BLOB';`);

    ok('导出按钮产出了单文件 HTML', clicked === 'OK', String(clicked));

    if (clicked === 'OK') {
      exported = (await ev('window.__deckHtml')).value;
      ok('导出内容非空', typeof exported === 'string' && exported.length > 500, `${exported?.length} 字节`);
    }
  }

  if (exported) {
    /* ---- 3a. 导出文件内部结构 ---- */
    const bodyOnly = exported.replace(/<style>[\s\S]*?<\/style>/g, '');
    const styleOnly = (exported.match(/<style>([\s\S]*?)<\/style>/g) || []).join('');

    ok('导出文件里有 KaTeX 结构', /class="katex/.test(bodyOnly),
      `katex 出现 ${(bodyOnly.match(/class="katex/g) || []).length} 次`);
    ok('导出文件里没有 KaTeX 报错块', !/katex-error/.test(exported));

    const left = TEX_COMMANDS.filter((c) => bodyOnly.includes(c));
    ok('导出正文里没有残留 LaTeX 源码', left.length === 0, left.join(' '));

    /* ★ KaTeX 的排版全靠它自己的 CSS（根号是 CSS 画的、大符号靠字体度量）。
     *   只渲染 HTML 不给 CSS，离线打开就是一坨错位的字符 —— 同样是"乱码"。
     *   而以前这份 CSS 是 CDN 外链：断网 / CDN 被墙 = 公式废掉。
     *   所以必须内联。 */
    ok('导出文件内联了 KaTeX CSS', /\.katex\b/.test(styleOnly) && /katex-display|\.katex\s*\{/.test(styleOnly));
    /* 字体路径必须绝对化。内联的 CSS 里若还是 url(fonts/…)，导出文件旁边
     * 根本没有 fonts 目录 —— 字体静默 404，公式变成系统字体的凑合版。 */
    /* ★ 判据是「每一个 url() 都指向 CDN」+「数量不为 0」，而**不是**
     *   「没有出现 url(fonts/…)」。
     *
     * 后者是假绿，而且真的假绿过一次：Vite 在构建时就把 url(fonts/…)
     * 重写成了 url(/assets/KaTeX_AMS-Regular-BQhdFMY1.woff2) —— 一个
     * **根相对路径**，在导出的单文件里等于 file:///assets/… → 404。
     * 旧断言查的是一个根本不存在的形态，于是「字体全坏」照样全绿。
     *
     * 「数量不为 0」也是必需的：内联的 CSS 里要是压根没有 @font-face，
     * 或者替换正则改坏了把所有 url() 都吃掉，光判「没有相对路径」会空跑通过。 */
    const urls = [...styleOnly.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/g)].map((m) => m[2]);
    ok('内联 CSS 里确实有字体引用（不是空跑）', urls.length > 0, `${urls.length} 条 url()`);
    /* ★ 每个 url() 必须是**自包含**的两种形态之一：
     *   · `data:font/…` —— Vite 把小于 4KB 的字体直接内联成了 base64（最理想）
     *   · CDN 绝对地址 —— 大字体走这里（取舍见 deckExport.ts 的注释）
     *
     * 要明确排除的是**根相对路径**：Vite 会把大字体重写成
     * `/assets/KaTeX_AMS-Regular-<hash>.woff2`，那在导出的单文件里等于
     * `file:///assets/…` → 404。
     *
     * 旧断言只查「有没有出现 url(fonts/…)」—— 而那个形态在构建产物里
     * 根本不存在（早被 Vite 改写掉了），于是「字体全坏」也照样全绿。
     * 那次假绿的代价是：导出文件在离线时字体静默 404，我直到手搓了一份
     * 样例文件去数 url() 才发现。 */
    const badUrls = urls.filter((u) =>
      !/^data:font\//.test(u)
      && !/^https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[\d.]+\/dist\/fonts\//.test(u));
    ok('内联 CSS 里每个 url() 都自包含（data URI 或 CDN 绝对地址）',
      badUrls.length === 0, badUrls.slice(0, 3).map((u) => u.slice(0, 60)).join(' | '));
    /* 公式在生成时就渲染成了静态 HTML，所以导出文件**不该有任何脚本**。
     * 以前这里写的是「不含 cdn.jsdelivr.net/npm/katex」—— 本意是找那段
     * 从没被调用的 katex.min.js，但内联 CSS 里的**字体地址**同样长这样，
     * 于是正常的导出文件被误判成「依赖 CDN 脚本」。
     * 直接断言「没有 <script>」更准，也更严。 */
    ok('导出文件完全不需要 JS（没有任何 <script>）', !/<script/i.test(exported));

    /* ---- 3b. 真·独立打开：file:// 无服务、无应用 ---- */
    /* 这一条才是「发给别人能看」的证明。前面几条只验了字符串，
     * 而字符串对了不等于打开就渲染 —— 比如公式是等 JS 来渲染的话，
     * 这里就会原形毕露。 */
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yanshu-deck-')), 'deck.html');
    fs.writeFileSync(file, exported, 'utf8');
    tmpFiles.push(file);

    await client.send('Page.navigate', { url: 'file://' + file });
    await sleep(1200);

    const d = JSON.parse(await probe(`
      var cmds = ${JSON.stringify(TEX_COMMANDS)};
      var text = document.body.textContent || '';
      var left = cmds.filter(function(c){ return text.indexOf(c) >= 0; });
      var els = document.querySelectorAll('.katex');
      var ff = els.length ? getComputedStyle(els[0]).fontFamily : '';
      return JSON.stringify({
        cards: document.querySelectorAll('.p-card').length,
        katex: els.length,
        left: left,
        font: ff,
        /* @font-face 规则真的被浏览器解析了吗。
         * 内联的 CSS 是**字符串**，字符串里写着 @font-face 不等于它生效 ——
         * 语法坏了、或者被前面的规则吃掉，都会静默失效。document.fonts
         * 里出现 KaTeX 家族才说明这层真的立起来了（不依赖网络）。 */
        fontFaces: (function(){
          try {
            /* ★ 必须用 Array.from —— FontFaceSet 是 Set-like，**没有 length**，
             *   而 Array.prototype.slice.call 对 Set-like 会静默返回空数组，
             *   于是「0 条」看起来像产品问题，其实是探针写错了。 */
            return Array.from(document.fonts || [])
              .filter(function(f){ return /KaTeX/i.test(f.family); }).length;
          } catch (e) { return -1; }
        })(),
      });`));
    ok('file:// 独立打开：卡片全部渲染', d.cards >= CARDS.length, `${d.cards} 张`);
    ok('file:// 独立打开：公式仍是渲染态', d.katex >= CARDS.length, `${d.katex} 个`);
    ok('file:// 独立打开：没有残留 LaTeX 源码', d.left.length === 0, d.left.join(' '));
    ok('file:// 独立打开：KaTeX 字体已应用', /KaTeX/i.test(d.font), `font-family="${d.font}"`);
    ok('file:// 独立打开：@font-face 规则真的立起来了',
      d.fontFaces > 0, `document.fonts 里 ${d.fontFaces} 条 KaTeX 家族`);
  }

  /* ---------- 4. 自检：检测器真的会报警吗 ---------- */
  /* 上面所有断言都建立在「文本里出现 \frac 就是漏了」这条判据上。
   * 如果判据本身失效（比如 TEX_COMMANDS 拼错、或者 indexOf 用错），
   * 整套检查会永远为绿 —— 那比没有检查更糟。这里正反各验一次。 */
  section('4. 自检：判据本身有效吗');
  {
    ok('残留判据：对未渲染的 LaTeX 会报警',
      TEX_COMMANDS.some((c) => '求极限 \\lim_{x\\to 0}\\frac{1}{x}'.includes(c)));
    ok('残留判据：对已渲染的文本不误报',
      TEX_COMMANDS.every((c) => !'求极限：当 x 趋于 0 时，sin x / x 趋于 1'.includes(c)));
    ok('KaTeX 结构判据：对真实渲染结果认得出来',
      /class="katex/.test('<span class="katex"><span class="katex-mathml"></span></span>'));
    ok('KaTeX 结构判据：对降级输出不误认',
      !/class="katex/.test('<code>\\frac{1}{2}</code>'));
  }
} catch (e) {
  fail++;
  failures.push('套件抛异常：' + e.message);
  console.log(`\n\x1b[31m✗ 套件抛异常：${e.message}\x1b[0m`);
  if (ctx?.stderrTail?.length) {
    console.log('\x1b[90m浏览器 stderr 末尾：\x1b[0m');
    console.log(ctx.stderrTail.slice(-8).map((l) => '    ' + l).join('\n'));
  }
} finally {
  if (ctx) ctx.kill();
  for (const f of tmpFiles) {
    try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* 删不掉无所谓 */ }
  }
}

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(46));
if (fail) {
  console.log(`\x1b[31m❌ 卡片库导出：${pass} 项通过，失败 ${fail} 项\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
console.log(`\x1b[32m✅ 卡片库导出：${pass} 项全部通过\x1b[0m`);
process.exit(0);
