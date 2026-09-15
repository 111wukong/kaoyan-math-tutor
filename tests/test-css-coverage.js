/* 类名 ↔ CSS 一致性检查
 *
 * 专治本轮踩到的那类坑：**JS 里生成了 class="xxx"，style.css 里没有 .xxx**。
 * 页面不会报错，只是那一块裸奔 —— 测试全绿、截图看不出、上线才发现。
 *
 * 做法：把 app.js / index.html 里所有 class="..." 的 token 抠出来，
 * 逐个到 style.css 里找有没有对应的选择器。
 *
 * 允许放行的两类：
 *   1) 纯 JS 钩子类（只被 querySelector 用来定位，本来就不该有样式）
 *   2) 明确的外部/运行时类（KaTeX 自己注入的）
 * 除这两类外，任何一个没样式的类名都算失败 —— 白名单要加就得写清理由。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');

const app = read('js/app.js');
const html = read('index.html');
const css = read('css/style.css');

/* ---------- 1. 抠出所有被生成的 class token ----------
 *
 * 两种属性要分开处理，否则误报会淹没真问题：
 *
 *  A) class="lab-canvas"          —— 纯字面量。里面的 token 必须精确有样式。
 *  B) class="blitz-mult' + (x ? ' hot' : '') + '"  —— 拼接。
 *     只取第一个 ' 之前的前导字面量（那一段必然在模板字符串里，一定是类名）。
 *     引号里面的东西分不清是类名还是 JS 里的比较值
 *     （`kind === 'cloud'` 里的 cloud 就不是类名），所以一律不取。
 *     前导字面量里以 - 结尾的是"运行时补全的前缀"（如 st- + 'classic'），
 *     单独放行；其余 token 允许是某个已定义类名的前缀（如 heat-l → heat-l0）。
 */
function scanClasses(src) {
  const strict = [], loose = [];
  (src.match(/class="[^"]*"/g) || []).forEach(function (a) {
    const content = a.slice(7, -1);
    if (content.indexOf("'") < 0) {
      content.split(/[^A-Za-z0-9_-]+/).forEach(function (t) { if (t) strict.push(t); });
    } else {
      content.split("'")[0].split(/[^A-Za-z0-9_-]+/).forEach(function (t) { if (t) loose.push(t); });
    }
  });
  return { strict: strict, loose: loose };
}

/* ---------- 2. 抠出 CSS 里定义过的类名 ---------- */
const defined = new Set((css.match(/\.-?[A-Za-z_][A-Za-z0-9_-]*/g) || [])
  .map(s => s.slice(1)));
const definedList = Array.from(defined);
const isPrefixOfDefined = t => definedList.some(d => d.length > t.length && d.indexOf(t) === 0);

/* ---------- 3. 白名单 ---------- */
/* 纯 JS 钩子：只被 querySelector 用来定位元素，故意没有样式 */
const HOOKS = new Set([
  'lab-canvas', 'blitz-bar', 'blitz-fill', 'blitz-feedback', 'blitz-clock',
  'lab-readout', 'lab-verdict'
]);
/* 纯结构容器：本身不需要任何样式，只负责给内部元素分组
   （例如 .brand-text 把两行品牌文字包成一块，好在 .brand 的 flex 里当一个子项）。
   这类必须真的含有子元素，否则就是白加的 div。 */
const STRUCTURAL = new Set(['brand-text']);
/* 运行时由外部库注入 */
const EXTERNAL = new Set(['katex', 'katex-display', 'katex-html', 'mathnormal', 'mord', 'mspace']);

const scanned = scanClasses(app + '\n' + html);
const strictSet = new Set(scanned.strict);
const looseSet = new Set(scanned.loose.filter(t => t.indexOf('-') !== t.length - 1));

const missing = [];
strictSet.forEach(function (t) {
  if (defined.has(t) || EXTERNAL.has(t) || HOOKS.has(t) || STRUCTURAL.has(t)) return;
  missing.push(t + '（纯字面量，必须精确有样式）');
});
looseSet.forEach(function (t) {
  if (defined.has(t) || EXTERNAL.has(t) || HOOKS.has(t)) return;
  if (isPrefixOfDefined(t)) return;          // 运行时补全的前缀
  missing.push(t + '（拼接属性里的前导字面量，既没样式也不是任何类名的前缀）');
});

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } }

console.log('扫描：app.js + index.html 里 ' + strictSet.size + ' 个纯字面量类名、' +
  looseSet.size + ' 个拼接前导类名；style.css 定义 ' + defined.size + ' 个');

console.log('\n=== 每个被生成的类名都要有样式（或明确豁免）===');
missing.sort().forEach(function (t) { console.log('  ✗ .' + t); });
ok(missing.length === 0, missing.length
  ? missing.length + ' 个类名缺样式：' + missing.join('、')
  : '全部 ' + (strictSet.size + looseSet.size) + ' 个类名都能在 style.css 里找到');

/* ---------- 4. 反向：豁免名单别变成垃圾桶 ----------
 * 白名单里的钩子类，必须真的被 querySelector / getElementById 用到。
 * 否则就是"当初忘了写样式，顺手塞进白名单"的遗留物。 */
console.log('\n=== 豁免名单没有变成垃圾桶 ===');
HOOKS.forEach(function (t) {
  const usedInJs = app.indexOf("'#" + t + "'") >= 0
    || app.indexOf('"#' + t + '"') >= 0
    || app.indexOf('.' + t + "'") >= 0
    || app.indexOf('#' + t) >= 0
    || html.indexOf('#' + t) >= 0;
  ok(usedInJs, '豁免的 .' + t + ' 确实在 JS/HTML 里被引用（不是僵尸豁免）');
});
STRUCTURAL.forEach(function (t) {
  const inMarkup = new RegExp('class="[^"]*\\b' + t + '\\b[^"]*"').test(app + html);
  ok(inMarkup, '结构容器 .' + t + ' 确实出现在标记里');
  /* 结构容器的唯一职责是包住子元素 —— 里面必须有东西 */
  const wrapsChild = new RegExp('class="[^"]*\\b' + t + '\\b[^"]*">\\s*<').test(html)
    || new RegExp("class=\"[^\"]*\\b" + t + "\\b[^\"]*\">'\\s*\\+").test(app);
  ok(wrapsChild, '★ 结构容器 .' + t + ' 里面确实包着子元素（不是白加的 div）');
});

/* ---------- 5. 本轮新增的关键类名必须存在 ----------
 * 显式钉住，防止以后重构时被静默删掉。 */
console.log('\n=== 本轮新增机制的关键样式 ===');
const REQUIRED = [
  /* 最小行动卡 */
  'focus-card', 'focus-k', 'focus-label', 'focus-reason',
  /* 备考投影 */
  'pace-bar', 'pace-legend', 'pace-note',
  /* XP 递减说明 */
  'xp-note', 'xp-why',
  /* 闪电战 */
  'blitz-hud', 'blitz-clock', 'life', 'blitz-score', 'blitz-mult',
  'blitz-track', 'blitz-feedback', 'blitz-result', 'blitz-final', 'blitz-best',
  'blitz-teaser', 'blitz-rules', 'blitz-cta',
  /* 公式实验室 */
  'lab-tabs', 'lab-tab', 'lab-grid', 'lab-main', 'lab-side', 'lab-title',
  'lab-hook', 'lab-formula', 'lab-note', 'lab-ctrl', 'lab-ctrl-head',
  'lab-btns', 'lab-row',
  /* 侧栏音效 */
  'side-sfx'
];
REQUIRED.forEach(function (t) {
  ok(defined.has(t), '.' + t + ' 在 style.css 里有定义');
});

/* ---------- 6. 设计纪律：不许出现被明令禁止的写法 ---------- */
console.log('\n=== 设计纪律（这些正是"AI 生成感"的来源）===');
/* 只看本轮新增段落，老代码的历史包袱不在这里追责 */
const NEW_SEC_START = css.indexOf('学习引擎 v2：最小行动');
const newSec = NEW_SEC_START >= 0 ? css.slice(NEW_SEC_START, css.indexOf('窄屏', NEW_SEC_START)) : '';
ok(NEW_SEC_START >= 0, '找得到本轮新增的 CSS 段落');
ok(newSec.length > 1000, '新增段落非空（' + newSec.length + ' 字符）');
ok(newSec.indexOf('linear-gradient') < 0, '★ 新增样式里没有渐变');
ok(!/transition:\s*all/.test(newSec), '★ 新增样式里没有 transition: all（只过渡具体属性）');
ok(newSec.indexOf('border-radius: 50%') < 0 || /\.life/.test(newSec), '圆角用法受控（仅 .life 这类圆点用 50%）');
const radiusVals = (newSec.match(/border-radius:\s*([^;]+);/g) || []).map(s => s.replace(/.*:\s*|\s*;/g, ''));
const bigRadius = radiusVals.filter(v => /(\d+)px/.test(v) && Math.max.apply(null, (v.match(/\d+/g) || [0]).map(Number)) > 9 && v.indexOf('50%') < 0);
ok(bigRadius.length === 0, '★ 圆角都收在 9px 以内（不用大圆角）' + (bigRadius.length ? ' 越界：' + bigRadius.join(' / ') : ''));
/* 颜色只能用设计系统变量或既有语义色，不许拍脑袋写新色值 */
const hexInNew = (newSec.match(/#[0-9a-fA-F]{3,8}\b/g) || []);
const ALLOWED_HEX = new Set(['#fff', '#ffffff']);
const strayHex = hexInNew.filter(h => !ALLOWED_HEX.has(h.toLowerCase()));
ok(strayHex.length === 0, '★ 新增样式不引入设计系统外的新色值' + (strayHex.length ? ' 越界：' + strayHex.join(' ') : ''));

console.log('\n──────────────────────────────');
console.log((fail === 0 ? '✅ 类名与样式一致性全部通过：' : '❌ 有失败：') + pass + ' 项' + (fail ? '，失败 ' + fail : ''));
process.exit(fail ? 1 : 0);
