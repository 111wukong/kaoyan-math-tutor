/* 公式演示引擎 · 高等数学
 *
 * 19 章里的第 1~7 章（极限、微分、积分、多元、重积分、级数、微分方程）。
 * 每个工厂接收 variant，返回一个 DemoDef；variant 决定「演示哪一条公式」。
 *
 * 写法约定：scene() 是纯函数（参数 + 调色板 → 画面数据），
 * 这样 tests/formula-demos.mjs 能在 Node 里把参数空间扫一遍验证它不炸。
 */
import { clamp, comb, deriv, fact, fmt, integrate, type Params, type Palette, type Scene, type View } from '../plot';
import { ctrl, int, type DemoDef, type DemoRegistry } from '../types';

/* ============================================================
   1. 等价无穷小 —— 两条曲线在 x→0 时比值趋于 1
   ============================================================ */
type AsympCase = {
  f: (x: number, p: Params) => number;
  g: (x: number, p: Params) => number;
  extra?: ReturnType<typeof ctrl>[];
  view: View;
  /** 展示用的名字，读出来给用户看 */
  name: string;
};

const ASYMP: Record<string, AsympCase> = {
  sin: { name: '\\sin x 与 x', f: (x) => Math.sin(x), g: (x) => x, view: { x: [-2.2, 2.2], y: [-2.2, 2.2] } },
  tan: { name: '\\tan x 与 x', f: (x) => Math.tan(x), g: (x) => x, view: { x: [-1.2, 1.2], y: [-2.5, 2.5] } },
  arcsin: { name: '\\arcsin x 与 x', f: (x) => Math.asin(x), g: (x) => x, view: { x: [-1, 1], y: [-1.6, 1.6] } },
  arctan: { name: '\\arctan x 与 x', f: (x) => Math.atan(x), g: (x) => x, view: { x: [-2, 2], y: [-2, 2] } },
  cos1: { name: '1-\\cos x 与 \\frac{x^{2}}{2}', f: (x) => 1 - Math.cos(x), g: (x) => x * x / 2, view: { x: [-2, 2], y: [-0.3, 2.2] } },
  ln1p: { name: '\\ln(1+x) 与 x', f: (x) => Math.log1p(x), g: (x) => x, view: { x: [-0.9, 2], y: [-2, 2.2] } },
  exp1: { name: 'e^{x}-1 与 x', f: (x) => Math.exp(x) - 1, g: (x) => x, view: { x: [-1.5, 1.5], y: [-1.5, 3] } },
  aexp1: {
    name: 'a^{x}-1 与 x\\ln a', f: (x, p) => Math.pow(p.a, x) - 1,
    g: (x, p) => x * Math.log(p.a), view: { x: [-1.5, 1.5], y: [-2, 4] },
    extra: [ctrl('a', '底数 a', 1.2, 3, 0.05, 2, (v) => v.toFixed(2))],
  },
  pow1p: {
    name: '(1+x)^{\\alpha}-1 与 \\alpha x', f: (x, p) => Math.pow(1 + x, p.alpha) - 1,
    g: (x, p) => p.alpha * x, view: { x: [-0.8, 1.2], y: [-2, 3] },
    extra: [ctrl('alpha', '指数 α', 0.3, 3, 0.05, 2, (v) => v.toFixed(2))],
  },
  xsin: { name: 'x-\\sin x 与 \\frac{x^{3}}{6}', f: (x) => x - Math.sin(x), g: (x) => x ** 3 / 6, view: { x: [-1.6, 1.6], y: [-0.8, 0.8] } },
  tanx: { name: '\\tan x-x 与 \\frac{x^{3}}{3}', f: (x) => Math.tan(x) - x, g: (x) => x ** 3 / 3, view: { x: [-1.1, 1.1], y: [-0.6, 0.6] } },
  xln1p: { name: 'x-\\ln(1+x) 与 \\frac{x^{2}}{2}', f: (x) => x - Math.log1p(x), g: (x) => x * x / 2, view: { x: [-0.85, 1.6], y: [-0.2, 1.4] } },
  arcsinx: { name: '\\arcsin x-x 与 \\frac{x^{3}}{6}', f: (x) => Math.asin(x) - x, g: (x) => x ** 3 / 6, view: { x: [-1, 1], y: [-0.25, 0.25] } },
};

const asymp: DemoRegistry[string] = (variant) => {
  const c = ASYMP[variant] || ASYMP.sin;
  return {
    what: `把 ${c.name} 画在同一张图上，拖 x 看它们的比值怎么趋于 1`,
    controls: [ctrl('x', '自变量 x', 0.02, 1.4, 0.01, 0.8, (v) => v.toFixed(2)), ...(c.extra || [])],
    view: c.view,
    scene: (p, pal) => ({
      curves: [
        { f: c.f, color: pal.violet(), label: '左' },
        { f: c.g, color: pal.cyan(), label: '右' },
      ],
      markers: [
        { x: p.x, y: c.f(p.x, p), color: pal.violet(), r: 4 },
        { x: p.x, y: c.g(p.x, p), color: pal.cyan(), r: 4 },
      ],
      vlines: [{ x: (pp) => pp.x, color: pal.text(0.35), dash: [3, 3] }],
      hlines: [{ y: 1, color: pal.emerald(0.5), dash: [5, 4], label: '比值 → 1' }],
    }),
    readout: (p) => {
      const fv = c.f(p.x, p);
      const gv = c.g(p.x, p);
      const r = gv === 0 ? NaN : fv / gv;
      return [
        { label: '左式', value: fmt(fv) },
        { label: '右式', value: fmt(gv) },
        { label: '左 / 右', value: fmt(r, 4), tone: Math.abs(r - 1) < 0.05 ? 'good' : 'default' },
        { label: '相对误差', value: `${fmt(Math.abs(r - 1) * 100, 2)}%`, hint: 'x 越小越接近 0' },
      ];
    },
    note: '两条曲线在 x→0 时几乎重合 —— 这就是「等价」的意思：比值趋于 1。',
  };
};

/* ============================================================
   2. 函数极限 / 数列极限 / 洛必达
   ============================================================ */
const limit: DemoRegistry[string] = (variant) => {
  const v = variant || 'sinx_x';

  if (v === 'e') {
    return {
      what: '(1+x)^{1/x} 在 x→0 时趋近 e',
      controls: [ctrl('x', '自变量 x', 0.01, 2, 0.01, 0.5, (vv) => vv.toFixed(2))],
      view: { x: [-0.95, 2.2], y: [1.4, 3.4] },
      scene: (p, pal) => ({
        curves: [{ f: (x) => (x === 0 ? NaN : Math.pow(1 + x, 1 / x)), color: pal.violet() }],
        hlines: [{ y: Math.E, color: pal.emerald(0.7), dash: [5, 4], label: `y = e ≈ ${fmt(Math.E, 3)}` }],
        markers: [{ x: p.x, y: Math.pow(1 + p.x, 1 / p.x), color: pal.cyan() }],
        vlines: [{ x: (pp) => pp.x, color: pal.text(0.3), dash: [3, 3] }],
      }),
      readout: (p) => {
        const val = Math.pow(1 + p.x, 1 / p.x);
        return [
          { label: '当前值', value: fmt(val, 5) },
          { label: 'e', value: fmt(Math.E, 5) },
          { label: '误差', value: fmt(Math.abs(val - Math.E), 5), tone: Math.abs(val - Math.E) < 0.01 ? 'good' : 'default' },
        ];
      },
      note: '这就是「第二重要极限」：底数趋于 1、指数趋于无穷，结果不是 1 而是 e。',
    };
  }

  if (v === 'seq') {
    return {
      what: '数列 (1+1/n)^{n} 逐项逼近 e',
      controls: [int('n', '取到第 n 项', 1, 120, 12)],
      view: { x: [0, 125], y: [1.5, 3.1] },
      scene: (p, pal) => ({
        markers: Array.from({ length: Math.max(1, Math.round(p.n)) }, (_, i) => ({
          x: i + 1, y: Math.pow(1 + 1 / (i + 1), i + 1), color: pal.cyan(), r: 3,
        })),
        hlines: [{ y: Math.E, color: pal.emerald(0.7), dash: [5, 4], label: 'y = e' }],
      }),
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        const val = Math.pow(1 + 1 / n, n);
        return [
          { label: `第 ${n} 项`, value: fmt(val, 5) },
          { label: '与 e 的差', value: fmt(Math.abs(val - Math.E), 5), tone: Math.abs(val - Math.E) < 0.02 ? 'good' : 'default' },
          { label: '单调性', value: '单调递增', hint: '有上界 e，故收敛' },
        ];
      },
      note: '数列单调递增且有上界，所以收敛 —— 这是「单调有界准则」的样板。',
    };
  }

  if (v === 'powinf') {
    return {
      what: '1^{∞} 型：\\left(1+\\frac{a}{x}\\right)^{bx} → e^{ab}',
      controls: [
        ctrl('a', '分子系数 a', 0.5, 3, 0.1, 1, (x) => x.toFixed(1)),
        ctrl('b', '指数系数 b', 0.5, 3, 0.1, 2, (x) => x.toFixed(1)),
        ctrl('x', '自变量 x', 1, 40, 0.5, 8, (x) => x.toFixed(1)),
      ],
      view: { x: [0, 42], y: [0, 12] },
      scene: (p, pal) => ({
        curves: [{ f: (x) => Math.pow(1 + p.a / x, p.b * x), color: pal.violet() }],
        hlines: [{ y: Math.exp(p.a * p.b), color: pal.emerald(0.7), dash: [5, 4], label: `y = e^{ab}` }],
        markers: [{ x: p.x, y: Math.pow(1 + p.a / p.x, p.b * p.x), color: pal.cyan() }],
      }),
      readout: (p) => {
        const val = Math.pow(1 + p.a / p.x, p.b * p.x);
        const lim = Math.exp(p.a * p.b);
        return [
          { label: '当前值', value: fmt(val, 5) },
          { label: 'e^{ab}', value: fmt(lim, 5) },
          { label: 'a · b', value: fmt(p.a * p.b, 3), hint: '极限只由这个乘积决定' },
        ];
      },
      note: '1^{∞} 型不要用「底数→1、指数→∞」硬凑，统一化成 e^{lim αβ}。',
    };
  }

  if (v === 'lhopital') {
    return {
      what: '洛必达：原式 f/g 与求导后的 f\'/g\' 趋于同一个极限',
      controls: [ctrl('x', '自变量 x', 0.02, 1.5, 0.01, 0.6, (vv) => vv.toFixed(2))],
      view: { x: [-0.2, 1.6], y: [-0.2, 1.2] },
      scene: (p, pal) => ({
        curves: [
          { f: (x) => (x === 0 ? NaN : Math.sin(x) / x), color: pal.violet(), label: 'f/g = sin x / x' },
          { f: (x) => (x === 0 ? NaN : Math.cos(x) / 1), color: pal.cyan(), label: "f'/g' = cos x / 1" },
        ],
        hlines: [{ y: 1, color: pal.emerald(0.7), dash: [5, 4], label: '共同的极限 1' }],
        markers: [
          { x: p.x, y: Math.sin(p.x) / p.x, color: pal.violet(), r: 4 },
          { x: p.x, y: Math.cos(p.x), color: pal.cyan(), r: 4 },
        ],
      }),
      readout: (p) => [
        { label: '原式 sin x / x', value: fmt(Math.sin(p.x) / p.x, 5) },
        { label: "求导后 cos x / 1", value: fmt(Math.cos(p.x), 5) },
        { label: '两者之差', value: fmt(Math.abs(Math.sin(p.x) / p.x - Math.cos(p.x)), 5) },
        { label: '类型', value: '0/0 型', hint: '不满足类型就不能用' },
      ],
      note: '洛必达不是「求导就完了」——它要求 0/0 或 ∞/∞，而且求导后的极限必须存在。',
    };
  }

  if (v === 'epsN') {
    return {
      what: 'ε-N 语言：随便给多小的 ε，都能找到一个 N',
      controls: [ctrl('eps', 'ε', 0.02, 0.5, 0.01, 0.25, (vv) => vv.toFixed(2))],
      view: { x: [-1, 22], y: [0.7, 2.3] },
      scene: (p, pal) => {
        const N = Math.ceil(1 / p.eps) + 1;
        return {
          bands: [{ y0: 1 - p.eps, y1: 1 + p.eps, color: pal.cyan(), alpha: 0.1, dash: [5, 4] }],
          hlines: [{ y: 1, color: pal.emerald(0.8), label: 'A = 1' }],
          markers: Array.from({ length: 21 }, (_, i) => ({
            x: i + 1, y: 1 + 1 / (i + 1), color: i + 1 > N ? pal.cyan() : pal.rose(), r: 3.2,
          })),
          vlines: [{ x: N, color: pal.amber(0.85), dash: [4, 3], label: `N = ${N}`, labelY: 2.24 }],
        };
      },
      readout: (p) => {
        const N = Math.ceil(1 / p.eps) + 1;
        return [
          { label: 'ε', value: fmt(p.eps, 2) },
          { label: '需要的 N', value: String(N) },
          { label: 'N 之后的项', value: '全部落进带子里', tone: 'good' },
          { label: '带子宽度', value: fmt(2 * p.eps, 2), hint: 'A ± ε' },
        ];
      },
      note: '「无限接近」是文学描述；ε-N 把它变成了一个能验算的陈述。',
    };
  }

  /* 默认：第一重要极限 sin x / x */
  return {
    what: '第一重要极限：\\frac{\\sin x}{x} 在 x→0 时趋近 1',
    controls: [ctrl('x', '自变量 x', 0.01, 6, 0.01, 1.5, (vv) => vv.toFixed(2))],
    view: { x: [-7, 7], y: [-0.4, 1.25] },
    scene: (p, pal) => ({
      curves: [{ f: (x) => (x === 0 ? 1 : Math.sin(x) / x), color: pal.violet() }],
      hlines: [{ y: 1, color: pal.emerald(0.7), dash: [5, 4], label: 'y = 1' }],
      markers: [{ x: p.x, y: Math.sin(p.x) / p.x, color: pal.cyan() }],
      vlines: [{ x: (pp) => pp.x, color: pal.text(0.3), dash: [3, 3] }],
    }),
    readout: (p) => [
      { label: 'sin x / x', value: fmt(Math.sin(p.x) / p.x, 5) },
      { label: '与 1 的差', value: fmt(Math.abs(Math.sin(p.x) / p.x - 1), 5) },
      { label: 'x 的绝对值越小', value: '越接近 1', tone: 'good' },
    ],
    note: '注意它只对 x→0 成立。x→∞ 时这个比值趋于 0，完全是另一回事。',
  };
};

/* ============================================================
   3. 连续与间断 / 闭区间上连续函数的性质
   ============================================================ */
const continuity: DemoRegistry[string] = (variant) => {
  const v = variant || 'def';

  if (v === 'break') {
    return {
      what: '可去间断点：左右极限都存在且相等，但函数在那一点没有定义',
      controls: [ctrl('x', '自变量 x', 0.05, 2.5, 0.05, 1.5, (vv) => vv.toFixed(2))],
      view: { x: [-0.4, 3], y: [-0.3, 4.4] },
      scene: (p, pal) => ({
        curves: [{ f: (x) => (Math.abs(x - 1) < 1e-9 ? NaN : (x * x - 1) / (x - 1)), color: pal.violet(), label: '(x²-1)/(x-1)' }],
        markers: [{ x: 1, y: 2, color: pal.rose(), hollow: true, r: 5, label: '空心：f(1) 不存在' }],
        hlines: [{ y: 2, color: pal.emerald(0.5), dash: [4, 4] }],
        vlines: [{ x: 1, color: pal.amber(0.6), dash: [3, 3] }],
      }),
      readout: (p) => {
        const f = (x: number) => (x * x - 1) / (x - 1);
        return [
          { label: '左极限 x→1⁻', value: fmt(f(1 - 1e-6), 4) },
          { label: '右极限 x→1⁺', value: fmt(f(1 + 1e-6), 4) },
          { label: 'f(1)', value: '不存在', tone: 'warn' },
          { label: '间断类型', value: '可去间断点', hint: '补定义 f(1)=2 就连续了' },
          { label: '当前 f(x)', value: fmt(f(p.x), 4) },
        ];
      },
      note: '「左右极限相等」是连续的必要条件之一；这里缺的是「函数值存在且相等」。',
    };
  }

  if (v === 'bounded' || v === 'ivt') {
    return {
      what: v === 'ivt'
        ? '介值定理：闭区间上的连续函数取遍最大值与最小值之间的一切值'
        : '有界性与最值定理：闭区间上的连续函数一定取到最大最小值',
      controls: [
        ctrl('mu', '目标函数值 μ', -1.5, 3.5, 0.05, 1, (vv) => vv.toFixed(2)),
      ],
      view: { x: [-0.4, 3.4], y: [-2, 4] },
      scene: (p, pal) => {
        const f = (x: number) => x * x - 3 * x + 2;
        return {
          curves: [{ f, color: pal.violet(), label: 'f(x) = x²-3x+2' }],
          fills: [{ from: 0.2, to: 2.8, top: f, color: pal.violet(), alpha: 0.07 }],
          hlines: [
            { y: p.mu, color: pal.amber(0.85), dash: [5, 4], label: `μ = ${fmt(p.mu, 2)}` },
            { y: f(1.5), color: pal.rose(0.5), dash: [3, 3], label: `最小值 ${fmt(f(1.5), 2)}` },
            { y: Math.max(f(0.2), f(2.8)), color: pal.emerald(0.5), dash: [3, 3], label: `最大值 ${fmt(Math.max(f(0.2), f(2.8)), 2)}` },
          ],
          markers: [
            { x: 1.5, y: f(1.5), color: pal.rose(), r: 4 },
            { x: 0.2, y: f(0.2), color: pal.emerald(), r: 4 },
            { x: 2.8, y: f(2.8), color: pal.emerald(), r: 4 },
          ],
          vlines: [{ x: 0.2, color: pal.text(0.25), dash: [3, 3] }, { x: 2.8, color: pal.text(0.25), dash: [3, 3] }],
        };
      },
      readout: (p) => {
        const f = (x: number) => x * x - 3 * x + 2;
        const lo = Math.min(f(0.2), f(2.8));
        const hi = Math.max(f(0.2), f(2.8));
        const inside = p.mu >= lo && p.mu <= hi;
        /* 在 [0.2,2.8] 上解 f(x)=μ：x²-3x+(2-μ)=0 → x=(3±√(1+4μ))/2 */
        const disc = 1 + 4 * p.mu;
        const xi = disc >= 0 ? (3 - Math.sqrt(disc)) / 2 : NaN;
        return [
          { label: '区间端点值', value: `${fmt(f(0.2), 2)} 与 ${fmt(f(2.8), 2)}` },
          { label: '[最小值, 最大值]', value: `[${fmt(lo, 2)}, ${fmt(hi, 2)}]` },
          { label: 'μ 落在区间内？', value: inside ? '是' : '否', tone: inside ? 'good' : 'warn' },
          { label: '对应的 ξ', value: inside && xi >= 0.2 && xi <= 2.8 ? fmt(xi, 3) : '（不在区间内）' },
        ];
      },
      note: v === 'ivt'
        ? 'μ 一旦落在最值之间，就一定有 ξ 使 f(ξ)=μ —— 这就是介值定理。'
        : '两条虚线是函数能取到的最小值与最大值，中间那层就是值域。',
    };
  }

  /* def：连续的定义 —— 极限值等于函数值 */
  return {
    what: '连续的定义：\\lim_{x\\to x_0}f(x)=f(x_0) —— 极限值正好等于函数值',
    controls: [ctrl('x0', '考察点 x₀', -2.5, 2.5, 0.05, 0.6, (vv) => vv.toFixed(2))],
    view: { x: [-3.2, 3.2], y: [-1.6, 1.6] },
    scene: (p, pal) => {
      const f = (x: number) => (x === 0 ? 1 : Math.sin(x) / x);
      return {
        curves: [{ f, color: pal.violet(), label: 'f(x) = sin x / x（补定义 f(0)=1）' }],
        markers: [
          { x: p.x0, y: f(p.x0), color: pal.cyan(), label: 'f(x₀)' },
          { x: 0, y: 1, color: pal.emerald(), r: 4 },
        ],
        vlines: [{ x: (pp) => pp.x0, color: pal.text(0.3), dash: [3, 3] }],
        hlines: [{ y: (pp) => f(pp.x0), color: pal.cyan(0.35), dash: [3, 3] }],
      };
    },
    readout: (p) => {
      const f = (x: number) => (x === 0 ? 1 : Math.sin(x) / x);
      return [
        { label: 'f(x₀)', value: fmt(f(p.x0), 5) },
        { label: '左极限', value: fmt(f(p.x0 - 1e-6), 5) },
        { label: '右极限', value: fmt(f(p.x0 + 1e-6), 5) },
        { label: '三者相等？', value: '相等', tone: 'good', hint: '所以这一点连续' },
      ];
    },
    note: '连续 = 极限存在 + 函数值存在 + 两者相等，三条缺一不可。',
  };
};

/* ============================================================
   4. 割线 → 切线（导数的定义）
   ============================================================ */
const secant: DemoRegistry[string] = () => ({
  what: '让增量 h 趋于 0，割线就变成了切线',
  controls: [
    ctrl('a', '切点 a', -2, 2.4, 0.05, 1, (v) => v.toFixed(2)),
    ctrl('h', '增量 h', 0.02, 3, 0.02, 1.2, (v) => v.toFixed(2)),
  ],
  view: { x: [-3, 3.6], y: [-1.4, 9] },
  scene: (p, pal) => {
    const f = (x: number) => x * x;
    const a2 = p.a + p.h;
    const slope = (f(a2) - f(p.a)) / (a2 - p.a);
    const sec = (x: number) => f(p.a) + slope * (x - p.a);
    const tan = (x: number) => f(p.a) + 2 * p.a * (x - p.a);
    return {
      curves: [{ f, color: pal.violet(), label: 'f(x) = x²' }],
      segs: [
        { x1: -3, y1: tan(-3), x2: 3.6, y2: tan(3.6), color: pal.emerald(0.6), dash: [5, 5] },
        { x1: -3, y1: sec(-3), x2: 3.6, y2: sec(3.6), color: pal.cyan(), width: 2.2 },
        { x1: (pp) => pp.a, y1: (pp) => f(pp.a), x2: (pp) => pp.a + pp.h, y2: (pp) => f(pp.a), color: pal.amber(0.8), dash: [3, 3] },
        { x1: (pp) => pp.a + pp.h, y1: (pp) => f(pp.a), x2: (pp) => pp.a + pp.h, y2: (pp) => f(pp.a + pp.h), color: pal.amber(0.8), dash: [3, 3] },
      ],
      markers: [
        { x: (pp) => pp.a, y: (pp) => f(pp.a), color: pal.emerald(), label: 'A' },
        { x: (pp) => pp.a + pp.h, y: (pp) => f(pp.a + pp.h), color: pal.cyan(), label: 'B' },
      ],
      texts: [
        { x: (p.a + a2) / 2, y: f(p.a), text: 'h', align: 'center', color: pal.amber(0.95) },
        { x: a2, y: (f(p.a) + f(a2)) / 2, text: 'Δy', color: pal.amber(0.95) },
      ],
    };
  },
  readout: (p) => {
    const f = (x: number) => x * x;
    const a2 = p.a + p.h;
    const slope = (f(a2) - f(p.a)) / (a2 - p.a);
    return [
      { label: '割线斜率 Δy/Δx', value: fmt(slope, 4) },
      { label: "f'(a) = 2a", value: fmt(2 * p.a, 4) },
      { label: '两者之差', value: fmt(Math.abs(slope - 2 * p.a), 4), tone: Math.abs(slope - 2 * p.a) < 0.05 ? 'good' : 'default' },
      { label: 'h', value: fmt(p.h, 2), hint: 'h→0 时收敛' },
    ];
  },
  note: '导数的几何意义就是切线的斜率 —— 它是割线斜率的极限。',
});

/* ============================================================
   5. 基本导数公式表 / 高阶导数 / 曲率
   ============================================================ */
const DERIV_TABLE: Record<string, { f: (x: number) => number; df: (x: number) => number; name: string; view: View }> = {
  power: { f: (x) => x * x * x / 3, df: (x) => x * x, name: "(x^{\\alpha})' = \\alpha x^{\\alpha-1}", view: { x: [-2.5, 2.5], y: [-3, 3] } },
  aexp: { f: (x) => Math.pow(2, x), df: (x) => Math.pow(2, x) * Math.LN2, name: "(a^{x})' = a^{x}\\ln a", view: { x: [-2, 2.5], y: [-1, 8] } },
  exp: { f: (x) => Math.exp(x), df: (x) => Math.exp(x), name: "(e^{x})' = e^{x}", view: { x: [-2, 2], y: [-1, 8] } },
  logbase: { f: (x) => Math.log2(x), df: (x) => 1 / (x * Math.LN2), name: "(\\log_a x)' = \\frac{1}{x\\ln a}", view: { x: [0.05, 4], y: [-3, 3] } },
  ln: { f: (x) => Math.log(x), df: (x) => 1 / x, name: "(\\ln x)' = \\frac{1}{x}", view: { x: [0.05, 4], y: [-3, 3] } },
  sin: { f: (x) => Math.sin(x), df: (x) => Math.cos(x), name: "(\\sin x)' = \\cos x", view: { x: [-7, 7], y: [-1.6, 1.6] } },
  cos: { f: (x) => Math.cos(x), df: (x) => -Math.sin(x), name: "(\\cos x)' = -\\sin x", view: { x: [-7, 7], y: [-1.6, 1.6] } },
  tan: { f: (x) => Math.tan(x), df: (x) => 1 / (Math.cos(x) ** 2), name: "(\\tan x)' = \\sec^{2}x", view: { x: [-1.3, 1.3], y: [-4, 4] } },
  cot: { f: (x) => 1 / Math.tan(x), df: (x) => -1 / (Math.sin(x) ** 2), name: "(\\cot x)' = -\\csc^{2}x", view: { x: [0.2, 3], y: [-6, 6] } },
  sec: { f: (x) => 1 / Math.cos(x), df: (x) => (1 / Math.cos(x)) * Math.tan(x), name: "(\\sec x)' = \\sec x\\tan x", view: { x: [-1.3, 1.3], y: [-5, 5] } },
  csc: { f: (x) => 1 / Math.sin(x), df: (x) => -(1 / Math.sin(x)) * (1 / Math.tan(x)), name: "(\\csc x)' = -\\csc x\\cot x", view: { x: [0.2, 3], y: [-5, 5] } },
  asin: { f: (x) => Math.asin(x), df: (x) => 1 / Math.sqrt(Math.max(1e-9, 1 - x * x)), name: "(\\arcsin x)' = \\frac{1}{\\sqrt{1-x^{2}}}", view: { x: [-0.98, 0.98], y: [-2, 2] } },
  acos: { f: (x) => Math.acos(x), df: (x) => -1 / Math.sqrt(Math.max(1e-9, 1 - x * x)), name: "(\\arccos x)' = -\\frac{1}{\\sqrt{1-x^{2}}}", view: { x: [-0.98, 0.98], y: [-4, 4] } },
  atan: { f: (x) => Math.atan(x), df: (x) => 1 / (1 + x * x), name: "(\\arctan x)' = \\frac{1}{1+x^{2}}", view: { x: [-3, 3], y: [-1.8, 1.8] } },
  acot: { f: (x) => Math.atan(1 / x), df: (x) => -1 / (1 + x * x), name: "(\\operatorname{arccot} x)' = -\\frac{1}{1+x^{2}}", view: { x: [-3, 3], y: [-1.8, 1.8] } },
};

const higherCases: Record<string, { f: (x: number, n: number) => number; name: string; view: View }> = {
  exp: { f: (x) => Math.exp(x), name: '(e^{x})^{(n)} = e^{x}', view: { x: [-2, 2], y: [-1, 8] } },
  sin: { f: (x, n) => Math.sin(x + (n * Math.PI) / 2), name: '(\\sin x)^{(n)} = \\sin\\left(x+\\frac{n\\pi}{2}\\right)', view: { x: [-7, 7], y: [-1.6, 1.6] } },
  cos: { f: (x, n) => Math.cos(x + (n * Math.PI) / 2), name: '(\\cos x)^{(n)} = \\cos\\left(x+\\frac{n\\pi}{2}\\right)', view: { x: [-7, 7], y: [-1.6, 1.6] } },
  ln: { f: (x, n) => (n === 0 ? Math.log(x) : (Math.pow(-1, n - 1) * fact(n - 1)) / Math.pow(x, n)), name: '(\\ln x)^{(n)} = \\frac{(-1)^{n-1}(n-1)!}{x^{n}}', view: { x: [0.2, 3], y: [-4, 4] } },
  leibniz: { f: (x, n) => deriv((t) => t * t * Math.sin(t), x, Math.max(1e-4, 0.01 / (1 + n))), name: '(uv)^{(n)} = \\sum C_n^k u^{(n-k)}v^{(k)}', view: { x: [-4, 4], y: [-8, 8] } },
};

const derivtable: DemoRegistry[string] = (variant) => {
  /* variant 可以带子参数：`higher:sin` 表示「高阶导数这条公式，演示 sin」。
   * 分类器负责拼这个字符串，工厂负责拆 —— 这样同一个交互形态能覆盖
   * 一整组公式，而不用给每条公式各写一个工厂。 */
  const [v, sub] = (variant || 'table').split(':');

  if (v === 'curvature') {
    return {
      what: '曲率：曲线在某点弯得多厉害 —— 用密切圆（最贴合的圆）的半径倒数来量',
      controls: [ctrl('x0', '考察点 x₀', -2.2, 2.2, 0.05, 0.8, (vv) => vv.toFixed(2))],
      view: { x: [-3, 3], y: [-2, 3] },
      scene: (p, pal) => {
        const f = (x: number) => x * x / 2;
        const d1 = (x: number) => x;
        const d2 = () => 1;
        const k = Math.abs(d2()) / Math.pow(1 + d1(p.x0) ** 2, 1.5);
        const R = k === 0 ? 1e6 : 1 / k;
        /* 曲率中心：沿法线方向偏 R */
        const nx = -d1(p.x0);
        const ny = 1;
        const nl = Math.hypot(nx, ny);
        const cx = p.x0 + (nx / nl) * R;
        const cy = f(p.x0) + (ny / nl) * R;
        return {
          curves: [
            { f, color: pal.violet(), label: 'y = x²/2' },
            { f: (x) => { const dx = x - cx; const t = R * R - dx * dx; return t < 0 ? NaN : cy - Math.sqrt(t); }, color: pal.cyan(0.8), width: 1.6 },
          ],
          markers: [
            { x: p.x0, y: f(p.x0), color: pal.amber(), label: '切点' },
            { x: cx, y: cy, color: pal.cyan(), r: 3.5, label: '曲率中心' },
          ],
          segs: [{ x1: p.x0, y1: f(p.x0), x2: cx, y2: cy, color: pal.cyan(0.5), dash: [4, 4] }],
        };
      },
      readout: (p) => {
        const k = 1 / Math.pow(1 + p.x0 ** 2, 1.5);
        return [
          { label: '曲率 K', value: fmt(k, 4) },
          { label: '曲率半径 R = 1/K', value: fmt(1 / k, 4) },
          { label: '顶点处 (x₀=0)', value: 'K = 1', hint: '抛物线最弯的地方' },
        ];
      },
      note: 'K 越大越弯。直线的 K 恒为 0 —— 半径无穷大的圆就是直线。',
    };
  }

  if (v === 'higher') {
    const hc = higherCases[sub || 'sin'] || higherCases.sin;
    return {
      what: '高阶导数：把求导这个动作重复 n 次，看图像怎么变',
      controls: [
        int('n', '阶数 n', 0, 8, 2),
        ctrl('x', '自变量 x', -5, 5, 0.05, 1, (vv) => vv.toFixed(2)),
      ],
      view: hc.view,
      scene: (p, pal) => ({
        curves: [
          { f: (x) => hc.f(x, 0), color: pal.text(0.35), width: 1.6, dash: [4, 4], label: '原函数' },
          { f: (x) => hc.f(x, Math.round(p.n)), color: pal.violet(), label: `${Math.round(p.n)} 阶导` },
        ],
        markers: [{ x: p.x, y: hc.f(p.x, Math.round(p.n)), color: pal.cyan() }],
      }),
      readout: (p) => {
        const n = Math.round(p.n);
        return [
          { label: '阶数 n', value: String(n) },
          { label: `${n} 阶导在 x 处`, value: fmt(hc.f(p.x, n), 5) },
          { label: '规律', value: n === 0 ? '原函数' : n % 4 === 0 ? '回到原函数' : '按 4 循环', hint: 'sin / cos 的 n 阶导以 4 为周期' },
        ];
      },
      note: 'sin 与 cos 的高阶导以 4 为周期循环 —— 记住这条能省很多推导。',
    };
  }

  const c = DERIV_TABLE[v] || DERIV_TABLE.sin;
  return {
    what: `${c.name} —— 拖 x₀ 看切线的斜率怎么变`,
    controls: [ctrl('x0', '切点 x₀', c.view.x[0] + 0.05, c.view.x[1] - 0.05, 0.01, (c.view.x[0] + c.view.x[1]) / 2, (vv) => vv.toFixed(2))],
    view: c.view,
    scene: (p, pal) => {
      const tan = (x: number) => c.f(p.x0) + c.df(p.x0) * (x - p.x0);
      return {
        curves: [
          { f: c.f, color: pal.violet(), label: 'f(x)' },
          { f: c.df, color: pal.cyan(), width: 2, label: "f'(x)" },
        ],
        segs: [{ x1: c.view.x[0], y1: tan(c.view.x[0]), x2: c.view.x[1], y2: tan(c.view.x[1]), color: pal.emerald(0.7), dash: [5, 4] }],
        markers: [{ x: p.x0, y: c.f(p.x0), color: pal.amber(), label: `切线斜率 ${fmt(c.df(p.x0), 3)}` }],
        vlines: [{ x: (pp) => pp.x0, color: pal.text(0.28), dash: [3, 3] }],
      };
    },
    readout: (p) => [
      { label: 'f(x₀)', value: fmt(c.f(p.x0), 4) },
      { label: "f'(x₀)", value: fmt(c.df(p.x0), 4) },
      { label: '切线方程', value: `y = ${fmt(c.df(p.x0), 3)}(x - ${fmt(p.x0, 2)}) + ${fmt(c.f(p.x0), 3)}` },
    ],
    note: '橙色点是切点，虚线是切线。f\' 的图像就是切线斜率随 x 变化的曲线。',
  };
};

/* ============================================================
   6. 求导法则
   ============================================================ */
const derivrule: DemoRegistry[string] = (variant) => {
  const v = variant || 'product';

  if (v === 'quotient') {
    return {
      what: "商法则：\\left(\\frac{u}{v}\\right)'=\\frac{u'v-uv'}{v^{2}}",
      controls: [ctrl('x', '自变量 x', 0.3, 3, 0.05, 1.2, (vv) => vv.toFixed(2))],
      view: { x: [0.1, 3.2], y: [-4, 4] },
      scene: (p, pal) => ({
        curves: [
          { f: (x) => x * x / Math.sin(x), color: pal.violet(), label: 'u/v = x²/sin x' },
          { f: (x) => (2 * x * Math.sin(x) - x * x * Math.cos(x)) / (Math.sin(x) ** 2), color: pal.cyan(), label: '按商法则算出的导数' },
        ],
        markers: [{ x: p.x, y: (2 * p.x * Math.sin(p.x) - p.x * p.x * Math.cos(p.x)) / (Math.sin(p.x) ** 2), color: pal.amber() }],
      }),
      readout: (p) => {
        const u = p.x * p.x; const du = 2 * p.x;
        const w = Math.sin(p.x); const dw = Math.cos(p.x);
        const formula = (du * w - u * dw) / (w * w);
        const numeric = deriv((x) => (x * x) / Math.sin(x), p.x);
        return [
          { label: "u'v - uv'", value: fmt(du * w - u * dw, 4) },
          { label: 'v²', value: fmt(w * w, 4) },
          { label: '商法则结果', value: fmt(formula, 4) },
          { label: '数值求导（对照）', value: fmt(numeric, 4), tone: Math.abs(formula - numeric) < 1e-3 ? 'good' : 'default' },
        ];
      },
      note: '分子是「上导下不导，减去上不导下导」，顺序反了会差一个负号。',
    };
  }

  if (v === 'chain') {
    return {
      what: '链式法则：\\frac{dy}{dx}=\\frac{dy}{du}\\cdot\\frac{du}{dx}',
      controls: [ctrl('x', '自变量 x', 0.1, 3, 0.05, 1.2, (vv) => vv.toFixed(2))],
      view: { x: [0, 3.2], y: [-1.5, 4] },
      scene: (p, pal) => ({
        curves: [
          { f: (x) => Math.sin(x * x), color: pal.violet(), label: 'y = sin(u)，u = x²' },
          { f: (x) => Math.cos(x * x) * 2 * x, color: pal.cyan(), label: 'dy/dx' },
        ],
        markers: [
          { x: p.x, y: Math.sin(p.x * p.x), color: pal.violet(), r: 4 },
          { x: p.x, y: Math.cos(p.x * p.x) * 2 * p.x, color: pal.cyan(), r: 4 },
        ],
      }),
      readout: (p) => {
        const u = p.x * p.x;
        const dydy = Math.cos(u);
        const dudx = 2 * p.x;
        return [
          { label: 'u = x²', value: fmt(u, 4) },
          { label: 'dy/du = cos u', value: fmt(dydy, 4) },
          { label: 'du/dx = 2x', value: fmt(dudx, 4) },
          { label: '相乘 = dy/dx', value: fmt(dydy * dudx, 4), tone: 'good' },
          { label: '数值求导（对照）', value: fmt(deriv((x) => Math.sin(x * x), p.x), 4) },
        ];
      },
      note: '复合函数求导就是「一层一层剥」：外层导数 × 内层导数。',
    };
  }

  if (v === 'inverse') {
    return {
      what: "反函数求导：[f^{-1}(y)]'=\\frac{1}{f'(x)} —— 图像关于 y=x 对称，斜率互为倒数",
      controls: [ctrl('x', '原函数上的 x', -2.5, 2.5, 0.05, 0.6, (vv) => vv.toFixed(2))],
      view: { x: [-2.6, 3.4], y: [-2.6, 3.4] },
      scene: (p, pal) => {
        const f = (x: number) => Math.exp(x);
        const finv = (y: number) => Math.log(y);
        const y = f(p.x);
        return {
          curves: [
            { f, color: pal.violet(), label: 'y = eˣ' },
            { f: finv, color: pal.cyan(), label: 'y = ln x（反函数）' },
            { f: (x) => x, color: pal.text(0.35), width: 1.4, dash: [4, 4], label: 'y = x' },
          ],
          markers: [
            { x: p.x, y, color: pal.violet(), r: 4, label: '(x, y)' },
            { x: y, y: p.x, color: pal.cyan(), r: 4, label: '(y, x)' },
          ],
          segs: [
            { x1: p.x, y1: y, x2: y, y2: p.x, color: pal.amber(0.5), dash: [3, 3] },
          ],
        };
      },
      readout: (p) => {
        const y = Math.exp(p.x);
        const fp = Math.exp(p.x);
        return [
          { label: "f'(x)", value: fmt(fp, 4) },
          { label: "1/f'(x)", value: fmt(1 / fp, 4) },
          { label: '(f⁻¹)\'(y)', value: fmt(deriv(Math.log, y), 4), tone: 'good' },
          { label: '两点关系', value: '关于 y = x 对称' },
        ];
      },
      note: '反函数的图像是原图关于 y=x 的镜像，所以切线斜率互为倒数。',
    };
  }

  if (v === 'param') {
    return {
      what: '参数方程求导：\\frac{dy}{dx}=\\frac{\\psi\'(t)}{\\varphi\'(t)}',
      controls: [ctrl('t', '参数 t', -1.6, 1.6, 0.05, 0.7, (vv) => vv.toFixed(2))],
      view: { x: [-1, 3], y: [-2.2, 2.2] },
      scene: (p, pal) => {
        const px = (t: number) => t * t;
        const py = (t: number) => t ** 3;
        const dx = 2 * p.t;
        const dy = 3 * p.t * p.t;
        const slope = dx === 0 ? NaN : dy / dx;
        const len = 1.4;
        return {
          curves: [{ f: (x) => (x < 0 ? NaN : Math.pow(x, 1.5)), color: pal.violet(), label: 'x=t², y=t³' }],
          segs: [{
            x1: px(p.t) - len, y1: py(p.t) - slope * len,
            x2: px(p.t) + len, y2: py(p.t) + slope * len,
            color: pal.emerald(0.8), dash: [5, 4],
          }],
          markers: [{ x: px(p.t), y: py(p.t), color: pal.amber(), label: '切点' }],
        };
      },
      readout: (p) => {
        const dx = 2 * p.t;
        const dy = 3 * p.t * p.t;
        return [
          { label: "φ'(t) = dx/dt", value: fmt(dx, 4) },
          { label: "ψ'(t) = dy/dt", value: fmt(dy, 4) },
          { label: 'dy/dx', value: dx === 0 ? '不存在（竖直切线）' : fmt(dy / dx, 4), tone: dx === 0 ? 'warn' : 'good' },
        ];
      },
      note: '参数方程求导就是「分别对 t 求导再相除」。dx/dt=0 时切线竖直，斜率不存在。',
    };
  }

  if (v === 'implicit') {
    return {
      what: '隐函数求导：F(x,y)=0 \\Rightarrow y\'=-\\frac{F_x}{F_y}',
      controls: [ctrl('x', '圆上的 x', -2.2, 2.2, 0.05, 1, (vv) => vv.toFixed(2))],
      view: { x: [-2.6, 2.6], y: [-2.6, 2.6] },
      scene: (p, pal) => {
        const r = 2;
        const y = Math.sqrt(Math.max(0, r * r - p.x * p.x));
        const slope = y === 0 ? NaN : -p.x / y;
        const len = 1.2;
        return {
          curves: [
            { f: (x) => Math.sqrt(Math.max(0, r * r - x * x)), color: pal.violet(), label: 'x² + y² = 4' },
            { f: (x) => -Math.sqrt(Math.max(0, r * r - x * x)), color: pal.violet() },
          ],
          segs: [{
            x1: p.x - len, y1: y - slope * len,
            x2: p.x + len, y2: y + slope * len,
            color: pal.emerald(0.8), dash: [5, 4],
          }],
          markers: [{ x: p.x, y, color: pal.amber(), label: `y' = ${fmt(slope, 2)}` }],
          arrows: [{ x: 0, y: 0, dx: p.x, dy: y, color: pal.cyan(0.7) }],
        };
      },
      readout: (p) => {
        const y = Math.sqrt(Math.max(0, 4 - p.x * p.x));
        return [
          { label: 'y', value: fmt(y, 4) },
          { label: "-x/y", value: y === 0 ? '∞' : fmt(-p.x / y, 4) },
          { label: '几何含义', value: '切线与半径垂直', hint: '圆心在原点的圆' },
        ];
      },
      note: '隐函数求导不用解出 y —— 两边同时对 x 求导，把 y 当成 x 的函数即可。',
    };
  }

  /* product 默认 */
  return {
    what: "乘积法则：(uv)'=u'v+uv' —— 两项分别求导再相加",
    controls: [ctrl('x', '自变量 x', 0, 3, 0.05, 1, (vv) => vv.toFixed(2))],
    view: { x: [-0.3, 3.2], y: [-4, 8] },
    scene: (p, pal) => ({
      curves: [
        { f: (x) => x * x * Math.sin(x), color: pal.violet(), label: 'uv = x² sin x' },
        { f: (x) => 2 * x * Math.sin(x) + x * x * Math.cos(x), color: pal.cyan(), label: "u'v + uv'" },
      ],
      markers: [{ x: p.x, y: 2 * p.x * Math.sin(p.x) + p.x * p.x * Math.cos(p.x), color: pal.amber() }],
    }),
    readout: (p) => {
      const u = p.x * p.x; const du = 2 * p.x;
      const w = Math.sin(p.x); const dw = Math.cos(p.x);
      const formula = du * w + u * dw;
      const numeric = deriv((x) => x * x * Math.sin(x), p.x);
      return [
        { label: "u'v", value: fmt(du * w, 4) },
        { label: "uv'", value: fmt(u * dw, 4) },
        { label: '两项之和', value: fmt(formula, 4) },
        { label: '数值求导（对照）', value: fmt(numeric, 4), tone: Math.abs(formula - numeric) < 1e-3 ? 'good' : 'default' },
      ];
    },
    note: '乘积的导数不是「导数之积」。用数值求导对照一下就看得很清楚。',
  };
};

/* ============================================================
   7. 中值定理
   ============================================================ */
const mvt: DemoRegistry[string] = (variant) => {
  const v = variant || 'lagrange';

  if (v === 'rolle') {
    return {
      what: '罗尔定理：两端点函数值相等时，中间必有一点切线水平',
      controls: [ctrl('xi', '考察点 ξ', 0.2, 2.8, 0.05, 1.5, (vv) => vv.toFixed(2))],
      view: { x: [-0.3, 3.3], y: [-1.5, 2] },
      scene: (p, pal) => {
        const f = (x: number) => Math.sin(Math.PI * x / 3) * 1.2;
        return {
          curves: [{ f, color: pal.violet(), label: 'f(x)，f(0)=f(3)=0' }],
          hlines: [{ y: 0, color: pal.emerald(0.6), dash: [5, 4], label: 'f(a) = f(b)' }],
          segs: [{ x1: p.xi - 0.7, y1: f(p.xi), x2: p.xi + 0.7, y2: f(p.xi), color: pal.amber(0.85), dash: [4, 3] }],
          markers: [
            { x: p.xi, y: f(p.xi), color: pal.amber(), label: `ξ = ${fmt(p.xi, 2)}` },
            { x: 0, y: 0, color: pal.emerald(), r: 4, label: 'a' },
            { x: 3, y: 0, color: pal.emerald(), r: 4, label: 'b' },
          ],
        };
      },
      readout: (p) => {
        const f = (x: number) => Math.sin(Math.PI * x / 3) * 1.2;
        const slope = deriv(f, p.xi);
        return [
          { label: 'f(a) 与 f(b)', value: '0 与 0', tone: 'good' },
          { label: "当前点 f'(ξ)", value: fmt(slope, 4) },
          { label: 'ξ = 1.5 处', value: "f' = 0", hint: '这就是定理保证的那个点' },
        ];
      },
      note: '罗尔定理的三个条件缺一不可。少了「两端相等」，结论就不一定成立。',
    };
  }

  if (v === 'cauchy') {
    return {
      what: '柯西中值定理：两个函数的增量之比，等于同一点处导数之比',
      controls: [ctrl('xi', '考察点 ξ', 0.4, 2.6, 0.05, 1.4, (vv) => vv.toFixed(2))],
      view: { x: [-0.3, 3.3], y: [-1, 5] },
      scene: (p, pal) => {
        const f = (x: number) => x * x;
        const g = (x: number) => x * x * x / 3;
        return {
          curves: [
            { f, color: pal.violet(), label: 'f(x) = x²' },
            { f: g, color: pal.cyan(), label: 'g(x) = x³/3' },
          ],
          markers: [
            { x: p.xi, y: f(p.xi), color: pal.violet(), r: 4 },
            { x: p.xi, y: g(p.xi), color: pal.cyan(), r: 4 },
          ],
          vlines: [{ x: (pp) => pp.xi, color: pal.text(0.28), dash: [3, 3] }],
        };
      },
      readout: (p) => {
        const f = (x: number) => x * x;
        const g = (x: number) => x ** 3 / 3;
        const a = 0.5; const b = 3;
        const lhs = (f(b) - f(a)) / (g(b) - g(a));
        const rhs = deriv(f, p.xi) / deriv(g, p.xi);
        return [
          { label: 'Δf / Δg（整体）', value: fmt(lhs, 4) },
          { label: "f'(ξ)/g'(ξ)（该点）", value: fmt(rhs, 4) },
          { label: 'ξ = 1.5 处', value: '两者相等', tone: 'good' },
        ];
      },
      note: '拉格朗日是中值定理取 g(x)=x 的特例；柯西是把两个函数绑在一起看。',
    };
  }

  return {
    what: '拉格朗日中值定理：曲线上的弦，一定能找到一条平行的切线',
    controls: [ctrl('xi', '切点 ξ', 0.3, 2.7, 0.05, 1.5, (vv) => vv.toFixed(2))],
    view: { x: [-0.3, 3.3], y: [-0.5, 3.2] },
    scene: (p, pal) => {
      const f = (x: number) => Math.log1p(x) * 1.6 + 0.2;
      const a = 0.5; const b = 3;
      const chord = (f(b) - f(a)) / (b - a);
      const slope = deriv(f, p.xi);
      const half = 0.75;
      return {
        curves: [{ f, color: pal.violet(), label: 'f(x)' }],
        segs: [
          /* 弦：连接两端点 */
          { x1: a, y1: f(a), x2: b, y2: f(b), color: pal.cyan(), width: 2.2 },
          /* 平行于弦的切线：由 ξ 决定，斜率与弦相等（数值上近似） */
          { x1: p.xi - half, y1: f(p.xi) - chord * half, x2: p.xi + half, y2: f(p.xi) + chord * half, color: pal.amber(0.85), dash: [5, 4] },
          /* 实际切线（用真导数画）—— 与上面那条重合时就说明找到了 ξ */
          { x1: p.xi - half, y1: f(p.xi) - slope * half, x2: p.xi + half, y2: f(p.xi) + slope * half, color: pal.emerald(0.9) },
        ],
        markers: [
          { x: a, y: f(a), color: pal.emerald(), r: 4, label: 'a' },
          { x: b, y: f(b), color: pal.emerald(), r: 4, label: 'b' },
          { x: p.xi, y: f(p.xi), color: pal.amber(), label: `ξ = ${fmt(p.xi, 2)}` },
        ],
      };
    },
    readout: (p) => {
      const f = (x: number) => Math.log1p(x) * 1.6 + 0.2;
      const a = 0.5; const b = 3;
      const chord = (f(b) - f(a)) / (b - a);
      const slope = deriv(f, p.xi);
      return [
        { label: '弦的斜率', value: fmt(chord, 4), hint: '[f(b)-f(a)]/(b-a)' },
        { label: "该点切线斜率 f'(ξ)", value: fmt(slope, 4) },
        { label: '两者之差', value: fmt(Math.abs(slope - chord), 4), tone: Math.abs(slope - chord) < 0.02 ? 'good' : 'default' },
        { label: 'ξ 的位置', value: p.xi > 1.9 && p.xi < 2.3 ? '定理保证的点在附近' : '拖到 2.1 附近试试' },
      ];
    },
    note: '弦的斜率等于某点切线斜率 —— 这就是「整体平均变化率 = 某点瞬时变化率」。',
  };
};

/* ============================================================
   8. 泰勒公式 / 麦克劳林展开
   ============================================================ */
type TaylorCase = { f: (x: number) => number; series: (x: number, n: number) => number; name: string; view: View; x0: number };
const TAYLOR: Record<string, TaylorCase> = {
  exp: { f: Math.exp, series: (x, n) => { let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(x, k) / fact(k); return s; }, name: 'e^{x}', view: { x: [-3.5, 3.5], y: [-2, 12] }, x0: 0 },
  sin: { f: Math.sin, series: (x, n) => { let s = 0; for (let k = 0; k <= n; k++) s += (k % 2 === 0 ? 1 : -1) * Math.pow(x, 2 * k + 1) / fact(2 * k + 1); return s; }, name: '\\sin x', view: { x: [-8, 8], y: [-3, 3] }, x0: 0 },
  cos: { f: Math.cos, series: (x, n) => { let s = 0; for (let k = 0; k <= n; k++) s += (k % 2 === 0 ? 1 : -1) * Math.pow(x, 2 * k) / fact(2 * k); return s; }, name: '\\cos x', view: { x: [-8, 8], y: [-3, 3] }, x0: 0 },
  ln1p: { f: Math.log1p, series: (x, n) => { let s = 0; for (let k = 1; k <= n; k++) s += (k % 2 === 1 ? 1 : -1) * Math.pow(x, k) / k; return s; }, name: '\\ln(1+x)', view: { x: [-0.9, 2], y: [-3, 2] }, x0: 0 },
  pow1p: { f: (x) => Math.pow(1 + x, 1.5), series: (x, n) => { let s = 0; let c = 1; for (let k = 0; k <= n; k++) { s += c * Math.pow(x, k); c = c * (1.5 - k) / (k + 1); } return s; }, name: '(1+x)^{\\alpha}', view: { x: [-0.85, 1.5], y: [-1, 4] }, x0: 0 },
  geom: { f: (x) => 1 / (1 - x), series: (x, n) => { let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(x, k); return s; }, name: '\\frac{1}{1-x}', view: { x: [-1.5, 1.5], y: [-4, 4] }, x0: 0 },
  geom2: { f: (x) => 1 / (1 + x), series: (x, n) => { let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(-x, k); return s; }, name: '\\frac{1}{1+x}', view: { x: [-1.5, 1.5], y: [-4, 4] }, x0: 0 },
  arctan: { f: Math.atan, series: (x, n) => { let s = 0; for (let k = 0; k <= n; k++) s += (k % 2 === 0 ? 1 : -1) * Math.pow(x, 2 * k + 1) / (2 * k + 1); return s; }, name: '\\arctan x', view: { x: [-2, 2], y: [-1.6, 1.6] }, x0: 0 },
  tan: { f: Math.tan, series: (x, n) => { let s = 0; for (let k = 0; k <= n; k++) s += (k % 2 === 0 ? 1 : -1) * Math.pow(x, 2 * k + 1) / fact(2 * k + 1); return s; }, name: '\\tan x', view: { x: [-1.3, 1.3], y: [-3, 3] }, x0: 0 },
  general: { f: Math.sin, series: (x, n) => { let s = 0; for (let k = 0; k <= n; k++) s += (k % 2 === 0 ? 1 : -1) * Math.pow(x, 2 * k + 1) / fact(2 * k + 1); return s; }, name: 'f(x)', view: { x: [-7, 7], y: [-3, 3] }, x0: 0 },
};

const taylor: DemoRegistry[string] = (variant) => {
  const key = variant === 'general' || variant === 'peano' ? 'general' : variant;
  const c = TAYLOR[key] || TAYLOR.sin;
  return {
    what: `${c.name} 的泰勒多项式：项数越多，贴合的范围越宽 —— 但只在展开点附近管用`,
    controls: [
      int('n', '展开项数 n', 0, 9, 3),
      /* 麦克劳林展开的展开点固定是 0，给一个拖不动的滑块只会让人困惑 ——
       * 所以只有「泰勒公式」这两条（展开点可动）才给这个控件。 */
      ...(key === 'general' ? [ctrl('x0', '展开点 x₀', -2, 2, 0.1, 0, (v) => v.toFixed(1))] : []),
    ],
    view: c.view,
    scene: (p, pal) => {
      const n = Math.round(p.n);
      const x0 = key === 'general' ? p.x0 : c.x0;
      const bound = Math.min(c.view.x[1], x0 + 1.1 + n * 0.62);
      return {
        curves: [
          { f: c.f, color: pal.cyan(), label: `${c.name} 本身` },
          { f: (x) => c.series(x - x0, n), color: pal.amber(), label: `泰勒 ${n} 项` },
        ],
        vlines: [
          { x: Math.max(c.view.x[0], x0 - (bound - x0)), color: pal.emerald(0.35), dash: [4, 4] },
          { x: bound, color: pal.emerald(0.35), dash: [4, 4], label: '近似有效区间', labelY: c.view.y[1] },
        ],
        markers: [{ x: x0, y: c.f(x0), color: pal.emerald(), r: 4, label: '展开点' }],
      };
    },
    readout: (p) => {
      const n = Math.round(p.n);
      const x0 = key === 'general' ? p.x0 : c.x0;
      const probe = clamp(x0 + 1, c.view.x[0] + 0.1, c.view.x[1] - 0.1);
      const err = Math.abs(c.f(probe) - c.series(probe - x0, n));
      return [
        { label: '项数 n', value: String(n) },
        { label: '展开点 x₀', value: fmt(x0, 2) },
        { label: `在 x=${fmt(probe, 2)} 处`, value: fmt(c.series(probe - x0, n), 5), hint: '多项式给出的值' },
        { label: '真值', value: fmt(c.f(probe), 5) },
        { label: '误差', value: fmt(err, 5), tone: err < 0.01 ? 'good' : err > 1 ? 'warn' : 'default' },
      ];
    },
    note: '泰勒多项式的误差由余项控制。离展开点越远、项数越少，误差越大 —— 这是「局部」两个字的意思。',
  };
};

/* ============================================================
   9. 单调性 / 极值 / 凹凸
   ============================================================ */
const monotone: DemoRegistry[string] = (variant) => {
  const v = variant || 'first';
  const f = (x: number) => x ** 3 / 3 - x;
  const d1 = (x: number) => x * x - 1;
  const d2 = (x: number) => 2 * x;

  if (v === 'concavity') {
    return {
      what: '凹凸性与拐点：f\'\' 的符号决定曲线弯向哪一边',
      controls: [ctrl('x', '自变量 x', -2.2, 2.2, 0.05, 0.8, (vv) => vv.toFixed(2))],
      view: { x: [-2.4, 2.4], y: [-2.2, 2.2] },
      scene: (p, pal) => ({
        curves: [
          { f, color: pal.violet(), label: 'f(x)' },
          { f: d2, color: pal.amber(), width: 1.8, label: "f''(x) = 2x" },
        ],
        vlines: [{ x: 0, color: pal.emerald(0.7), dash: [4, 4], label: '拐点 x = 0' }],
        markers: [{ x: p.x, y: f(p.x), color: pal.cyan() }],
      }),
      readout: (p) => [
        { label: "f''(x)", value: fmt(d2(p.x), 3) },
        { label: '凹凸性', value: d2(p.x) > 0 ? '凹（下凸）' : d2(p.x) < 0 ? '凸（上凸）' : '拐点', tone: d2(p.x) === 0 ? 'warn' : 'good' },
        { label: '拐点位置', value: 'x = 0', hint: "f'' 变号的地方" },
      ],
      note: 'f\'\' 由负变正的那个点就是拐点 —— 曲线在这里从「上凸」翻成「下凸」。',
    };
  }

  if (v === 'second') {
    return {
      what: '极值第二充分条件：f\'(x₀)=0 且 f\'\'(x₀)<0 ⇒ 极大值',
      controls: [ctrl('x', '自变量 x', -2.2, 2.2, 0.05, 1, (vv) => vv.toFixed(2))],
      view: { x: [-2.4, 2.4], y: [-2.2, 2.2] },
      scene: (p, pal) => ({
        curves: [
          { f, color: pal.violet(), label: 'f(x)' },
          { f: d1, color: pal.cyan(), width: 1.8, label: "f'(x)" },
        ],
        markers: [
          { x: -1, y: f(-1), color: pal.emerald(), r: 5, label: '极大 f(-1)' },
          { x: 1, y: f(1), color: pal.rose(), r: 5, label: '极小 f(1)' },
          { x: p.x, y: f(p.x), color: pal.amber(), r: 3.5 },
        ],
      }),
      readout: (p) => [
        { label: "f'(x)", value: fmt(d1(p.x), 3) },
        { label: "f''(x)", value: fmt(d2(p.x), 3) },
        { label: 'x₀ = -1 处', value: `f'=0, f''=-2<0 ⇒ 极大`, tone: 'good' },
        { label: 'x₀ = 1 处', value: `f'=0, f''=2>0 ⇒ 极小`, tone: 'good' },
      ],
      note: 'f\'\'(x₀)=0 时第二充分条件失效，要回到第一充分条件看 f\' 是否变号。',
    };
  }

  return {
    what: '极值第一充分条件：看 f\' 在驻点两侧是否变号',
    controls: [ctrl('x', '自变量 x', -2.2, 2.2, 0.05, -1.4, (vv) => vv.toFixed(2))],
    view: { x: [-2.4, 2.4], y: [-2.2, 2.2] },
    scene: (p, pal) => ({
      curves: [
        { f, color: pal.violet(), label: 'f(x) = x³/3 - x' },
        { f: d1, color: pal.cyan(), width: 1.8, label: "f'(x) = x²-1" },
      ],
      hlines: [{ y: 0, color: pal.text(0.3), dash: [3, 3] }],
      markers: [
        { x: -1, y: f(-1), color: pal.emerald(), r: 5, label: '极大值' },
        { x: 1, y: f(1), color: pal.rose(), r: 5, label: '极小值' },
        { x: p.x, y: f(p.x), color: pal.amber(), r: 3.5 },
      ],
      vlines: [{ x: -1, color: pal.emerald(0.4), dash: [3, 3] }, { x: 1, color: pal.rose(0.4), dash: [3, 3] }],
    }),
    readout: (p) => [
      { label: "f'(x)", value: fmt(d1(p.x), 3) },
      { label: '单调性', value: d1(p.x) > 0 ? '递增 ↗' : d1(p.x) < 0 ? '递减 ↘' : '驻点', tone: d1(p.x) === 0 ? 'warn' : 'default' },
      { label: '驻点', value: 'x = -1 与 x = 1' },
      { label: 'f(x)', value: fmt(f(p.x), 3) },
    ],
    note: 'f\' 由正变负 ⇒ 极大；由负变正 ⇒ 极小。不变号的话不是极值点。',
  };
};

/* ============================================================
   10. 基本积分表 —— f 与 F 对照 + 面积
   ============================================================ */
type AntiCase = {
  /* ★ 被积函数和原函数统一带 (x, p) 两个参数，哪怕大部分条目用不到 p。
   *   不给 p 的条目写成 (x) => ... 也能赋值（TS 允许少参数），
   *   但**调用方必须统一传两个** —— 之前这里分了 fp / f 两套，
   *   结果带参数的条目被当成单参函数调用，p 成了 undefined，
   *   readout 一算就抛 Cannot read properties of undefined。 */
  f: (x: number, p: Params) => number;
  F: (x: number, p: Params) => number;
  name: string;
  view: View;
  /** 面积演示的左端点 */
  a: number;
  /** 积分上限的默认值 */
  b: number;
  extra?: ReturnType<typeof ctrl>[];
};

const ANTI: Record<string, AntiCase> = {
  power: { f: (x) => x * x, F: (x) => x ** 3 / 3, name: '\\int x^{2}dx=\\frac{x^{3}}{3}+C', view: { x: [-2, 2], y: [-3, 3] }, a: 0, b: 1.6 },
  inv: { f: (x) => 1 / x, F: (x) => Math.log(Math.abs(x)), name: '\\int\\frac{dx}{x}=\\ln|x|+C', view: { x: [0.1, 4], y: [-2, 3] }, a: 0.5, b: 3 },
  exp: { f: Math.exp, F: Math.exp, name: '\\int e^{x}dx=e^{x}+C', view: { x: [-2, 2], y: [-1, 6] }, a: -1, b: 1.5 },
  aexp: { f: (x) => Math.pow(2, x), F: (x) => Math.pow(2, x) / Math.LN2, name: '\\int a^{x}dx=\\frac{a^{x}}{\\ln a}+C', view: { x: [-2, 2.5], y: [-2, 8] }, a: 0, b: 2 },
  sin: { f: Math.sin, F: (x) => -Math.cos(x), name: '\\int\\sin x\\,dx=-\\cos x+C', view: { x: [-7, 7], y: [-3, 3] }, a: 0, b: 4 },
  cos: { f: Math.cos, F: Math.sin, name: '\\int\\cos x\\,dx=\\sin x+C', view: { x: [-7, 7], y: [-3, 3] }, a: 0, b: 4 },
  sec2: { f: (x) => 1 / Math.cos(x) ** 2, F: Math.tan, name: '\\int\\sec^{2}x\\,dx=\\tan x+C', view: { x: [-1.3, 1.3], y: [-4, 4] }, a: -1, b: 1 },
  csc2: { f: (x) => 1 / Math.sin(x) ** 2, F: (x) => -1 / Math.tan(x), name: '\\int\\csc^{2}x\\,dx=-\\cot x+C', view: { x: [0.2, 3], y: [-4, 4] }, a: 0.5, b: 2.5 },
  sectan: { f: (x) => Math.tan(x) / Math.cos(x), F: (x) => 1 / Math.cos(x), name: '\\int\\sec x\\tan x\\,dx=\\sec x+C', view: { x: [-1.3, 1.3], y: [-3, 4] }, a: -1, b: 1 },
  csccot: { f: (x) => Math.cos(x) / Math.sin(x) ** 2, F: (x) => -1 / Math.sin(x), name: '\\int\\csc x\\cot x\\,dx=-\\csc x+C', view: { x: [0.2, 3], y: [-4, 4] }, a: 0.6, b: 2.4 },
  atan: { f: (x) => 1 / (1 + x * x), F: Math.atan, name: '\\int\\frac{dx}{1+x^{2}}=\\arctan x+C', view: { x: [-3.5, 3.5], y: [-2, 2] }, a: 0, b: 3 },
  asin: { f: (x) => 1 / Math.sqrt(Math.max(1e-9, 1 - x * x)), F: Math.asin, name: '\\int\\frac{dx}{\\sqrt{1-x^{2}}}=\\arcsin x+C', view: { x: [-1, 1], y: [-2, 2] }, a: 0, b: 0.9 },
  tan: { f: Math.tan, F: (x) => -Math.log(Math.abs(Math.cos(x))), name: '\\int\\tan x\\,dx=-\\ln|\\cos x|+C', view: { x: [-1.3, 1.3], y: [-3, 3] }, a: 0, b: 1.2 },
  cot: { f: (x) => 1 / Math.tan(x), F: (x) => Math.log(Math.abs(Math.sin(x))), name: '\\int\\cot x\\,dx=\\ln|\\sin x|+C', view: { x: [0.2, 3], y: [-3, 3] }, a: 0.5, b: 2.5 },
  sec: { f: (x) => 1 / Math.cos(x), F: (x) => Math.log(Math.abs(1 / Math.cos(x) + Math.tan(x))), name: '\\int\\sec x\\,dx=\\ln|\\sec x+\\tan x|+C', view: { x: [-1.3, 1.3], y: [-3, 4] }, a: 0, b: 1.2 },
  csc: { f: (x) => 1 / Math.sin(x), F: (x) => Math.log(Math.abs(1 / Math.tan(x) - 1 / Math.sin(x))), name: '\\int\\csc x\\,dx=\\ln|\\csc x-\\cot x|+C', view: { x: [0.2, 3], y: [-2, 3] }, a: 0.5, b: 2.5 },
  a2x2: {
    f: (x, p) => 1 / (p.a * p.a + x * x), F: (x, p) => Math.atan(x / p.a) / p.a,
    name: '\\int\\frac{dx}{a^{2}+x^{2}}=\\frac{1}{a}\\arctan\\frac{x}{a}+C',
    view: { x: [-4, 4], y: [-1, 2] }, a: 0, b: 3,
    extra: [ctrl('a', '参数 a', 0.5, 3, 0.1, 1, (v) => v.toFixed(1))],
  },
  a2mx2: {
    f: (x, p) => 1 / Math.sqrt(Math.max(1e-9, p.a * p.a - x * x)), F: (x, p) => Math.asin(clamp(x / p.a, -1, 1)),
    name: '\\int\\frac{dx}{\\sqrt{a^{2}-x^{2}}}=\\arcsin\\frac{x}{a}+C',
    view: { x: [-3, 3], y: [-2, 2] }, a: 0, b: 2,
    extra: [ctrl('a', '参数 a', 1, 3, 0.1, 2, (v) => v.toFixed(1))],
  },
  x2ma2: {
    f: (x, p) => 1 / (x * x - p.a * p.a),
    F: (x, p) => (1 / (2 * p.a)) * Math.log(Math.abs((x - p.a) / (x + p.a))),
    name: '\\int\\frac{dx}{x^{2}-a^{2}}=\\frac{1}{2a}\\ln\\left|\\frac{x-a}{x+a}\\right|+C',
    view: { x: [-4, 4], y: [-3, 3] }, a: 0.3, b: 2.5,
    extra: [ctrl('a', '参数 a', 0.5, 2, 0.1, 1, (v) => v.toFixed(1))],
  },
};

const antideriv: DemoRegistry[string] = (variant) => {
  const c = ANTI[variant] || ANTI.power;
  const fOf = (x: number, p: Params) => c.f(x, p);
  const FOf = (x: number, p: Params) => c.F(x, p);
  return {
    what: `${c.name} —— 蓝色面积就是 F(b)-F(a)`,
    controls: [
      ctrl('x', '积分上限 x', c.view.x[0] + 0.05, c.view.x[1] - 0.05, 0.01, c.b, (v) => v.toFixed(2)),
      ...(c.extra || []),
    ],
    view: c.view,
    scene: (p, pal) => ({
      curves: [
        { f: (x) => fOf(x, p), color: pal.violet(), label: '被积函数 f(x)' },
        { f: (x) => FOf(x, p), color: pal.cyan(), label: '原函数 F(x)' },
      ],
      fills: [{ from: c.a, to: (pp) => pp.x, top: (x) => fOf(x, p), color: pal.violet(), alpha: 0.2 }],
      markers: [{ x: (pp) => pp.x, y: (pp) => fOf(pp.x, pp), color: pal.amber(), r: 4 }],
    }),
    readout: (p) => {
      const area = integrate((x) => fOf(x, p), c.a, p.x);
      const diff = FOf(p.x, p) - FOf(c.a, p);
      return [
        { label: '面积 ∫ f dx', value: fmt(area, 4) },
        { label: 'F(x) - F(a)', value: fmt(diff, 4) },
        { label: '两者之差', value: fmt(Math.abs(area - diff), 4), tone: Math.abs(area - diff) < 1e-2 ? 'good' : 'default', hint: '数值积分与公式法应当一致' },
        { label: 'f(x)', value: fmt(fOf(p.x, p), 4) },
      ];
    },
    note: '面积由 f 决定，数值由 F 的增量给出 —— 这两条路必须走出同一个答案。',
  };
};

/* ============================================================
   11. 定积分（黎曼和 / 牛顿-莱布尼茨 / 换元 / 分部 / 奇偶 / 华里士 / 反常）
   ============================================================ */
const integral: DemoRegistry[string] = (variant) => {
  const v = variant || 'riemann';

  if (v === 'riemann') {
    const f = (x: number) => x * x;
    const a = 0; const b = 2;
    return {
      what: '黎曼和：把面积切成细长条，条数越多越接近真实面积',
      controls: [int('n', '分割数 n', 1, 80, 6)],
      view: { x: [-0.5, 2.7], y: [-0.8, 4.8] },
      scene: (p, pal) => {
        const n = Math.max(1, Math.round(p.n));
        const dx = (b - a) / n;
        const at = Array.from({ length: n }, (_, i) => a + i * dx + dx / 2);
        return {
          bars: [{ at: () => at, h: () => at.map(f), w: dx * 0.98, color: pal.cyan(0.35), outline: n <= 26 ? pal.cyan(0.7) : undefined }],
          curves: [{ f, color: pal.violet(), width: 2.6, label: 'y = x²' }],
          texts: [{ x: -0.35, y: 4.4, text: `n = ${n}` }],
        };
      },
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        const dx = (b - a) / n;
        let s = 0;
        for (let i = 0; i < n; i++) { const x = a + i * dx + dx / 2; s += f(x) * dx; }
        const exact = integrate(f, a, b);
        return [
          { label: '矩形面积和', value: fmt(s, 5) },
          { label: '精确值 ∫₀²x²dx', value: fmt(exact, 5) },
          { label: '误差', value: fmt(Math.abs(s - exact), 5), tone: Math.abs(s - exact) < 0.01 ? 'good' : 'default' },
        ];
      },
      note: 'n 取极限，和就变成了积分 —— 这就是定积分的定义。',
    };
  }

  if (v === 'odd') {
    return {
      what: '奇函数在对称区间上积分为零：正负面积正好抵消',
      controls: [ctrl('a', '对称半径 a', 0.2, 3, 0.05, 2, (vv) => vv.toFixed(2))],
      view: { x: [-3.4, 3.4], y: [-1.2, 1.2] },
      scene: (p, pal) => ({
        curves: [{ f: Math.sin, color: pal.violet(), label: 'f(x) = sin x（奇函数）' }],
        fills: [
          { from: (pp) => -pp.a, to: 0, top: Math.sin, color: pal.rose(), alpha: 0.25 },
          { from: 0, to: (pp) => pp.a, top: Math.sin, color: pal.cyan(), alpha: 0.25 },
        ],
        vlines: [{ x: (pp) => pp.a, color: pal.text(0.35), dash: [3, 3] }, { x: (pp) => -pp.a, color: pal.text(0.35), dash: [3, 3] }],
      }),
      readout: (p) => {
        const left = integrate(Math.sin, -p.a, 0);
        const right = integrate(Math.sin, 0, p.a);
        return [
          { label: '左半 ∫₋ₐ⁰', value: fmt(left, 5) },
          { label: '右半 ∫₀ᵃ', value: fmt(right, 5) },
          { label: '合计', value: fmt(left + right, 5), tone: Math.abs(left + right) < 1e-6 ? 'good' : 'default' },
          { label: '结论', value: '奇函数 ⇒ 恒为 0' },
        ];
      },
      note: '偶函数则是对称的两倍：∫₋ₐᵃ f = 2∫₀ᵃ f。先看奇偶性能省一半计算。',
    };
  }

  if (v === 'wallis') {
    return {
      what: '华里士（点火）公式：\\int_0^{\\pi/2}\\sin^{n}x\\,dx 的规律',
      controls: [int('n', '幂次 n', 1, 12, 4)],
      view: { x: [-0.2, Math.PI / 2 + 0.2], y: [-0.15, 1.15] },
      scene: (p, pal) => {
        const n = Math.max(1, Math.round(p.n));
        return {
          curves: [
            { f: (x) => Math.pow(Math.sin(x), n), color: pal.violet(), label: `sin^${n} x` },
            { f: Math.sin, color: pal.text(0.3), width: 1.4, dash: [4, 4], label: 'sin x（对照）' },
          ],
          fills: [{ from: 0, to: Math.PI / 2, top: (x) => Math.pow(Math.sin(x), n), color: pal.cyan(), alpha: 0.18 }],
        };
      },
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        const val = integrate((x) => Math.pow(Math.sin(x), n), 0, Math.PI / 2);
        /* 点火公式的闭式：n 为奇数/偶数时形式不同 */
        let closed: number;
        if (n % 2 === 1) {
          let num = 1;
          for (let k = n; k >= 1; k -= 2) num *= k === 1 ? 1 : k;
          let den = 1;
          for (let k = n + 1; k >= 3; k -= 2) den *= k;
          closed = num / den;
        } else {
          closed = (comb(n, n / 2) * Math.PI) / Math.pow(2, n + 1);
        }
        return [
          { label: '积分值（数值）', value: fmt(val, 6) },
          { label: '闭式公式值', value: fmt(closed, 6) },
          { label: '奇偶', value: n % 2 === 1 ? '奇数' : '偶数', hint: n % 2 === 1 ? '结果是有理数' : '结果带 π' },
        ];
      },
      note: 'n 为奇数时结果是有理数，n 为偶数时结果含 π —— 「点火」名字就是这么来的。',
    };
  }

  if (v === 'improper') {
    return {
      what: '反常积分：上限推到无穷，看积分值是否收敛到一个有限的数',
      controls: [
        ctrl('b', '积分上限 b', 1.5, 60, 0.5, 10, (vv) => vv.toFixed(1)),
        ctrl('p', '幂次 p', 0.3, 3, 0.05, 1.5, (vv) => vv.toFixed(2)),
      ],
      view: { x: [0, 62], y: [-0.2, 3.2] },
      scene: (p, pal) => ({
        curves: [
          { f: (x) => (x < 1 ? NaN : 1 / Math.pow(x, p.p)), color: pal.violet(), label: '1/x^p' },
          { f: (x) => (x < 1 ? NaN : 1 / x), color: pal.text(0.3), width: 1.4, dash: [4, 4], label: '1/x（分界）' },
        ],
        fills: [{ from: 1, to: (pp) => pp.b, top: (x, pp) => 1 / Math.pow(x, pp.p), color: pal.cyan(), alpha: 0.16 }],
        markers: [{ x: (pp) => pp.b, y: (pp) => 1 / Math.pow(pp.b, pp.p), color: pal.amber(), r: 4 }],
      }),
      readout: (p) => {
        const val = integrate((x) => 1 / Math.pow(x, p.p), 1, p.b, 2000);
        const conv = p.p > 1;
        const limit = conv ? 1 / (p.p - 1) : Infinity;
        return [
          { label: `∫₁^${fmt(p.b, 1)}`, value: fmt(val, 4) },
          { label: 'p > 1 ?', value: conv ? '是 → 收敛' : '否 → 发散', tone: conv ? 'good' : 'warn' },
          { label: '收敛时的极限值', value: conv ? fmt(limit, 4) : '∞', hint: '1/(p-1)' },
        ];
      },
      note: 'p 积分是判据的基准：p>1 收敛，p≤1 发散。别的反常积分都跟它比。',
    };
  }

  if (v === 'byparts') {
    return {
      what: '分部积分：∫u dv = uv − ∫v du —— 一个矩形减掉另一半面积',
      controls: [ctrl('b', '上限 b', 0.3, Math.PI, 0.05, 2, (vv) => vv.toFixed(2))],
      view: { x: [-0.3, 3.4], y: [-0.4, 3.2] },
      scene: (p, pal) => ({
        curves: [
          { f: (x) => x * Math.sin(x), color: pal.violet(), label: 'u·v\' = x sin x' },
          { f: Math.sin, color: pal.cyan(), width: 1.8, label: "v = sin x" },
        ],
        fills: [{ from: 0, to: (pp) => pp.b, top: (x) => x * Math.sin(x), color: pal.violet(), alpha: 0.18 }],
        markers: [
          { x: (pp) => pp.b, y: (pp) => pp.b * Math.sin(pp.b), color: pal.amber(), r: 4 },
          { x: (pp) => pp.b, y: (pp) => Math.sin(pp.b), color: pal.cyan(), r: 4 },
        ],
      }),
      readout: (p) => {
        const lhs = integrate((x) => x * Math.sin(x), 0, p.b);
        const uv = p.b * Math.sin(p.b) - 0 * Math.sin(0);
        const vdu = integrate((x) => Math.sin(x), 0, p.b);
        return [
          { label: '∫ u dv（原式）', value: fmt(lhs, 5) },
          { label: 'uv', value: fmt(uv, 5) },
          { label: '∫ v du', value: fmt(vdu, 5) },
          { label: 'uv − ∫v du', value: fmt(uv - vdu, 5), tone: Math.abs(lhs - (uv - vdu)) < 1e-4 ? 'good' : 'default' },
        ];
      },
      note: '分部积分的价值在于「把难的换成容易的」—— 选谁当 u 是关键。',
    };
  }

  if (v === 'sub') {
    return {
      what: '换元积分：换掉的变量同时把 dx 也换掉，面积不变',
      controls: [ctrl('x', '积分上限 x', 0.1, 1.2, 0.02, 0.9, (vv) => vv.toFixed(2))],
      view: { x: [0, 1.3], y: [0, 10] },
      scene: (p, pal) => ({
        curves: [
          { f: (x) => 2 * x * Math.exp(x * x), color: pal.violet(), label: 'f(φ(x))φ\'(x) = 2x e^{x²}' },
          { f: (u) => Math.exp(u), color: pal.cyan(), width: 1.8, label: 'f(u) = e^u' },
        ],
        fills: [{ from: 0, to: (pp) => pp.x, top: (x) => 2 * x * Math.exp(x * x), color: pal.violet(), alpha: 0.18 }],
        markers: [{ x: (pp) => pp.x, y: (pp) => 2 * pp.x * Math.exp(pp.x * pp.x), color: pal.amber() }],
      }),
      readout: (p) => {
        const before = integrate((x) => 2 * x * Math.exp(x * x), 0, p.x, 800);
        const after = integrate(Math.exp, 0, p.x * p.x, 800);
        return [
          { label: '∫ 2x e^{x²} dx（原式）', value: fmt(before, 5) },
          { label: '∫ e^u du（换元后）', value: fmt(after, 5), hint: `u 从 0 到 ${fmt(p.x * p.x, 2)}` },
          { label: '两者之差', value: fmt(Math.abs(before - after), 5), tone: Math.abs(before - after) < 1e-3 ? 'good' : 'default' },
        ];
      },
      note: '换元三件事必须同时做：被积函数、dx、积分限。漏掉积分限就会算错。',
    };
  }

  if (v === 'expsin') {
    return {
      what: '∫e^{ax}sin bx dx：振荡衰减，用两次分部积分就能求出闭式',
      controls: [
        ctrl('a', '衰减 a', -1, 0.2, 0.05, -0.3, (vv) => vv.toFixed(2)),
        ctrl('b', '频率 b', 0.5, 5, 0.1, 3, (vv) => vv.toFixed(1)),
        ctrl('x', '上限 x', 0.5, 12, 0.1, 6, (vv) => vv.toFixed(1)),
      ],
      view: { x: [0, 12.5], y: [-2, 2] },
      scene: (p, pal) => ({
        curves: [{ f: (x) => Math.exp(p.a * x) * Math.sin(p.b * x), color: pal.violet() }],
        fills: [{ from: 0, to: (pp) => pp.x, top: (x, pp) => Math.exp(pp.a * x) * Math.sin(pp.b * x), color: pal.cyan(), alpha: 0.16 }],
      }),
      readout: (p) => {
        const val = integrate((x) => Math.exp(p.a * x) * Math.sin(p.b * x), 0, p.x, 1200);
        /* 闭式：∫e^{ax}sin bx dx = e^{ax}(a sin bx - b cos bx)/(a²+b²) */
        const F = (x: number) => (Math.exp(p.a * x) * (p.a * Math.sin(p.b * x) - p.b * Math.cos(p.b * x))) / (p.a * p.a + p.b * p.b);
        return [
          { label: '数值积分', value: fmt(val, 5) },
          { label: '闭式公式', value: fmt(F(p.x) - F(0), 5) },
          { label: '两者之差', value: fmt(Math.abs(val - (F(p.x) - F(0))), 5), tone: 'good' },
          { label: 'a² + b²', value: fmt(p.a * p.a + p.b * p.b, 4) },
        ];
      },
      note: '这类积分要「分部两次转回自己」，然后解方程 —— 死磕分部是解不出来的。',
    };
  }

  /* nlb：牛顿-莱布尼茨 */
  return {
    what: '牛顿-莱布尼茨公式：\\int_a^b f = F(b) - F(a)',
    controls: [ctrl('b', '积分上限 b', 0, 3, 0.05, 2, (vv) => vv.toFixed(2))],
    view: { x: [-0.3, 3.3], y: [-1, 3.2] },
    scene: (p, pal) => ({
      curves: [
        { f: (x) => x * x, color: pal.violet(), label: 'f(x) = x²' },
        { f: (x) => x ** 3 / 3, color: pal.cyan(), width: 1.8, label: 'F(x) = x³/3' },
      ],
      fills: [{ from: 0, to: (pp) => pp.b, top: (x) => x * x, color: pal.violet(), alpha: 0.18 }],
      markers: [
        { x: (pp) => pp.b, y: (pp) => pp.b * pp.b, color: pal.amber(), r: 4 },
        { x: (pp) => pp.b, y: (pp) => pp.b ** 3 / 3, color: pal.cyan(), r: 4, label: 'F(b)' },
      ],
      vlines: [{ x: (pp) => pp.b, color: pal.text(0.3), dash: [3, 3] }],
    }),
    readout: (p) => {
      const area = integrate((x) => x * x, 0, p.b);
      return [
        { label: '面积（数值积分）', value: fmt(area, 5) },
        { label: 'F(b) - F(0)', value: fmt(p.b ** 3 / 3, 5) },
        { label: 'b³/3', value: fmt(p.b ** 3 / 3, 5) },
        { label: '是否相等', value: Math.abs(area - p.b ** 3 / 3) < 1e-3 ? '相等' : '不等', tone: 'good' },
      ];
    },
    note: '这条公式把「求面积」和「求原函数」这两件看似无关的事绑在了一起。',
  };
};

/* ============================================================
   12. 变限积分
   ============================================================ */
const varlimit: DemoRegistry[string] = (variant) => {
  const v = variant || 'prim';
  const f = (x: number) => Math.sin(x) + 1.2;
  const chain = v === 'chain';
  return {
    what: chain
      ? '变限积分求导：上限是复合函数时，还要乘上内层导数（链式法则）'
      : '变限积分是原函数：\\Phi(x)=\\int_a^x f \\Rightarrow \\Phi\'(x)=f(x)',
    controls: [ctrl('x', '上限 x', 0.05, 5, 0.05, 2, (vv) => vv.toFixed(2))],
    view: { x: [-0.3, 6.2], y: [-0.6, 4] },
    scene: (p, pal) => {
      const upper = chain ? p.x * p.x : p.x;
      return {
        curves: [
          { f, color: pal.violet(), label: 'f(t)' },
          { f: (t) => integrate(f, 0, t, 300), color: pal.cyan(), label: 'Φ(x) = ∫₀^x f' },
        ],
        fills: [{ from: 0, to: upper, top: f, color: pal.violet(), alpha: 0.16 }],
        vlines: [{ x: upper, color: pal.amber(0.8), dash: [4, 3], label: chain ? `x² = ${fmt(upper, 2)}` : `x = ${fmt(upper, 2)}` }],
        markers: [
          { x: upper, y: f(upper), color: pal.violet(), r: 4 },
          { x: p.x, y: integrate(f, 0, upper, 300), color: pal.cyan(), r: 4 },
        ],
      };
    },
    readout: (p) => {
      const upper = chain ? p.x * p.x : p.x;
      const phi = integrate(f, 0, upper, 400);
      const dphi = deriv((t) => integrate(f, 0, chain ? t * t : t, 400), p.x, 1e-4);
      return [
        { label: 'Φ(x)', value: fmt(phi, 5) },
        { label: 'Φ\'(x)（数值）', value: fmt(dphi, 5) },
        { label: chain ? 'f(φ(x))·φ\'(x)' : 'f(x)', value: fmt(chain ? f(upper) * 2 * p.x : f(upper), 5), tone: 'good' },
        { label: '上限', value: chain ? `φ(x) = x² = ${fmt(upper, 2)}` : fmt(upper, 2) },
      ];
    },
    note: chain
      ? '上限不是 x 而是 φ(x) 时，多出来的那一项 φ\'(x) 最容易漏 —— 漏了答案就错一半。'
      : '变限积分把 f 变成了它的原函数：这是「积分与求导互为逆运算」的精确表述。',
  };
};

/* ============================================================
   13. 定积分的应用（面积 / 旋转体 / 柱壳 / 弧长 / 侧面积 / 形心）
   ============================================================ */
const solid: DemoRegistry[string] = (variant) => {
  const v = variant || 'area';
  const f = (x: number) => Math.sqrt(x) * 1.3;
  const g = (x: number) => x * x * 0.28;

  if (v === 'revolveX' || v === 'shell') {
    return {
      what: v === 'shell'
        ? '柱壳法：把图形切成一个个圆柱壳，展开后每个壳的体积是 2πx·f(x)·dx'
        : '旋转体体积：绕 x 轴转一圈，每个薄片是一个半径 f(x) 的圆盘',
      controls: [ctrl('x0', '薄片位置 x', 0.1, 3.6, 0.05, 1.6, (vv) => vv.toFixed(2))],
      view: { x: [-0.4, 4.2], y: [-1.6, 3] },
      scene: (p, pal) => {
        const x = p.x0;
        const y = f(x);
        return {
          curves: [
            { f, color: pal.violet(), label: 'y = f(x)' },
            { f: (t) => -f(t), color: pal.violet(0.5), width: 1.6 },
          ],
          fills: [{ from: 0, to: 3.6, top: f, bottom: (t) => -f(t), color: pal.violet(), alpha: 0.08 }],
          segs: v === 'revolveX'
            ? [{ x1: x, y1: -y, x2: x, y2: y, color: pal.cyan(), width: 3 }]
            : [
              { x1: x, y1: 0, x2: x, y2: y, color: pal.cyan(), width: 2.4 },
              { x1: x, y1: y, x2: 3.6, y2: y, color: pal.cyan(0.6), dash: [4, 3] },
            ],
          markers: [{ x, y, color: pal.amber(), r: 4, label: v === 'revolveX' ? `半径 ${fmt(y, 2)}` : `高 ${fmt(y, 2)}` }],
          vlines: [{ x, color: pal.cyan(0.35), dash: [3, 3] }],
        };
      },
      readout: (p) => {
        const x = p.x0;
        const y = f(x);
        return v === 'shell'
          ? [
            { label: '壳半径', value: fmt(x, 3) },
            { label: '壳高 f(x)', value: fmt(y, 3) },
            { label: '侧面积 2πx·f(x)', value: fmt(2 * Math.PI * x * y, 4) },
            { label: '总体积 V_y', value: fmt(integrate((t) => 2 * Math.PI * t * f(t), 0, 3.6), 4), hint: '2π∫x·f(x)dx' },
          ]
          : [
            { label: '圆盘半径 f(x)', value: fmt(y, 3) },
            { label: '截面积 πf²(x)', value: fmt(Math.PI * y * y, 4) },
            { label: '总体积 V_x', value: fmt(integrate((t) => Math.PI * f(t) ** 2, 0, 3.6), 4), hint: 'π∫f²(x)dx' },
          ];
      },
      note: v === 'shell'
        ? '绕 y 轴转用柱壳法：V = 2π∫x·f(x)dx。别和绕 x 轴的圆盘法搞混。'
        : '绕 x 轴转用圆盘法：V = π∫f²(x)dx。平方是半径变面积那一步来的。',
    };
  }

  if (v === 'arclen' || v === 'surface') {
    return {
      what: v === 'surface'
        ? '旋转体侧面积：S = 2π∫|f(x)|√(1+f\'²)dx'
        : '弧长：把曲线切成小段，每段用勾股定理 —— s = ∫√(1+y\'²)dx',
      controls: [ctrl('x0', '小段位置 x', 0.2, 3.4, 0.05, 1.6, (vv) => vv.toFixed(2))],
      view: { x: [-0.3, 4], y: [-0.5, 3] },
      scene: (p, pal) => {
        const dx = 0.22;
        const y1 = f(p.x0); const y2 = f(p.x0 + dx);
        return {
          curves: [{ f, color: pal.violet(), label: 'y = f(x)' }],
          segs: [{ x1: p.x0, y1, x2: p.x0 + dx, y2, color: pal.cyan(), width: 3 }],
          markers: [{ x: p.x0, y: y1, color: pal.amber(), r: 3.5 }],
          texts: [{ x: p.x0 + dx / 2, y: y1 - 0.25, text: 'ds', align: 'center', color: pal.cyan() }],
        };
      },
      readout: (p) => {
        const x = p.x0;
        const dy = deriv(f, x);
        const factor = Math.sqrt(1 + dy * dy);
        return v === 'surface'
          ? [
            { label: 'f(x)', value: fmt(f(x), 4) },
            { label: "f'(x)", value: fmt(dy, 4) },
            { label: '√(1+f\'²)', value: fmt(factor, 4) },
            { label: '侧面积 S', value: fmt(integrate((t) => 2 * Math.PI * Math.abs(f(t)) * Math.sqrt(1 + deriv(f, t) ** 2), 0, 3.6, 200), 4) },
          ]
          : [
            { label: 'f(x)', value: fmt(f(x), 4) },
            { label: "f'(x)", value: fmt(dy, 4) },
            { label: '√(1+f\'²)', value: fmt(factor, 4), hint: '这就是 ds/dx' },
            { label: '弧长 s', value: fmt(integrate((t) => Math.sqrt(1 + deriv(f, t) ** 2), 0, 3.6, 200), 4) },
          ];
      },
      note: v === 'surface'
        ? '侧面积比弧长多一个 2πf(x)：转一圈扫过的长度。'
        : '弧长公式里那个 √(1+y\'²) 就是勾股定理的微分形式。',
    };
  }

  if (v === 'centroid') {
    return {
      what: '形心坐标：图形的「重心」位置',
      controls: [ctrl('k', '上边界斜率 k', 0.3, 2, 0.05, 1, (vv) => vv.toFixed(2))],
      view: { x: [-0.3, 3.4], y: [-0.4, 3.4] },
      scene: (p, pal) => {
        const top = (x: number) => p.k * x;
        const bot = (x: number) => x * x * 0.22;
        const A = integrate((x) => top(x) - bot(x), 0, 3, 400);
        const Mx = integrate((x) => x * (top(x) - bot(x)), 0, 3, 400);
        const cx = Mx / A;
        const cy = integrate((x) => (top(x) ** 2 - bot(x) ** 2) / 2, 0, 3, 400) / A;
        return {
          curves: [
            { f: top, color: pal.violet(), label: 'y₁ = kx' },
            { f: bot, color: pal.cyan(), label: 'y₂ = 0.22x²' },
          ],
          fills: [{ from: 0, to: 3, top, bottom: bot, color: pal.violet(), alpha: 0.16 }],
          markers: [{ x: cx, y: cy, color: pal.amber(), r: 5, label: `形心 (${fmt(cx, 2)}, ${fmt(cy, 2)})` }],
          vlines: [{ x: cx, color: pal.amber(0.35), dash: [3, 3] }],
        };
      },
      readout: (p) => {
        const top = (x: number) => p.k * x;
        const bot = (x: number) => x * x * 0.22;
        const A = integrate((x) => top(x) - bot(x), 0, 3, 400);
        const cx = integrate((x) => x * (top(x) - bot(x)), 0, 3, 400) / A;
        const cy = integrate((x) => (top(x) ** 2 - bot(x) ** 2) / 2, 0, 3, 400) / A;
        return [
          { label: '面积 A', value: fmt(A, 4) },
          { label: 'x̄', value: fmt(cx, 4), hint: '∫x·f dx / A' },
          { label: 'ȳ', value: fmt(cy, 4), hint: '∫(f²-g²)/2 dx / A' },
        ];
      },
      note: '形心公式的分子是「矩」，分母是「面积」—— 分子分母量纲差一次方，这是最好记的检查。',
    };
  }

  /* area 默认 */
  return {
    what: '平面图形面积：\\int_a^b|f(x)-g(x)|dx —— 上减下',
    controls: [ctrl('b', '右端点 b', 0.3, 3.4, 0.05, 3, (vv) => vv.toFixed(2))],
    view: { x: [-0.3, 3.8], y: [-0.4, 3.2] },
    scene: (p, pal) => ({
      curves: [
        { f, color: pal.violet(), label: 'y = f(x)' },
        { f: g, color: pal.cyan(), label: 'y = g(x)' },
      ],
      fills: [{ from: 0, to: (pp) => pp.b, top: f, bottom: g, color: pal.violet(), alpha: 0.18 }],
      markers: [
        { x: 0, y: 0, color: pal.emerald(), r: 4, label: 'a' },
        { x: (pp) => pp.b, y: (pp) => f(pp.b), color: pal.amber(), r: 4, label: 'b' },
      ],
    }),
    readout: (p) => [
      { label: '面积 S', value: fmt(integrate((x) => Math.abs(f(x) - g(x)), 0, p.b, 600), 4) },
      { label: '上边界在 x=b 处', value: f(p.b) > g(p.b) ? 'f 在上' : 'g 在上', tone: 'good' },
      { label: '两条曲线的交点', value: 'x ≈ 0 与 x ≈ 3.0', hint: '先解交点定限' },
    ],
    note: '先解交点定积分限，再判断哪条在上 —— 符号搞反会算出负面积。',
  };
};

/* ============================================================
   14. 多元函数微分学
   ============================================================ */
const multivar: DemoRegistry[string] = (variant) => {
  const v = variant || 'grad';

  if (v === 'need' || v === 'sufficient') {
    const quad = (x: number, y: number, p: Params) =>
      p.a * x * x + 2 * p.b * x * y + p.c * y * y;
    const disc = (p: Params) => p.a * p.c - p.b * p.b;
    return {
      what: '多元函数极值的充分条件：用 AC − B² 判别',
      controls: [
        ctrl('a', 'A = f_xx', -2, 2, 0.1, 1, (x) => x.toFixed(1)),
        ctrl('b', 'B = f_xy', -2, 2, 0.1, 0, (x) => x.toFixed(1)),
        ctrl('c', 'C = f_yy', -2, 2, 0.1, 1, (x) => x.toFixed(1)),
      ],
      view: { x: [-2.5, 2.5], y: [-2.5, 2.5] },
      scene: (p, pal) => ({
        grid: false,
        heat: {
          f: (x, y, pp) => quad(x, y, pp),
          x: [-2.5, 2.5], y: [-2.5, 2.5], cells: 44,
          color: (t, a) => pal.violet(a),
        },
        contours: {
          f: (x, y, pp) => quad(x, y, pp),
          x: [-2.5, 2.5], y: [-2.5, 2.5],
          levels: [-3, -1.5, -0.6, 0.6, 1.5, 3],
          color: pal.text(0.55),
        },
        markers: [{ x: 0, y: 0, color: pal.amber(), r: 5, label: '驻点 (0,0)' }],
      }),
      readout: (p) => {
        const D = disc(p);
        const verdict = D > 0 ? (p.a > 0 ? '极小值' : p.a < 0 ? '极大值' : '退化') : D < 0 ? '鞍点（不是极值）' : '需要进一步判断';
        return [
          { label: 'A', value: fmt(p.a, 2) },
          { label: 'B', value: fmt(p.b, 2) },
          { label: 'C', value: fmt(p.c, 2) },
          { label: 'AC − B²', value: fmt(D, 3), tone: D > 0 ? 'good' : D < 0 ? 'warn' : 'default' },
          { label: '结论', value: verdict, tone: D > 0 ? 'good' : D < 0 ? 'warn' : 'default' },
        ];
      },
      note: 'AC−B²>0 才有极值（再看 A 的符号）；<0 一定是鞍点；=0 时判别法失效。',
    };
  }

  if (v === 'lagrange') {
    return {
      what: '拉格朗日乘数法：在约束曲线上找 f 的最值',
      controls: [ctrl('t', '约束曲线上的参数', 0, Math.PI * 2, 0.02, 0.6, (vv) => vv.toFixed(2))],
      view: { x: [-2.2, 2.2], y: [-2.2, 2.2] },
      scene: (p, pal) => {
        const f = (x: number, y: number) => x + 2 * y;
        return {
          grid: false,
          contours: {
            f: (x, y) => f(x, y), x: [-2.2, 2.2], y: [-2.2, 2.2],
            levels: [-2, -1, 0, 1, 2, 3], color: pal.violet(0.5),
          },
          curves: [{ f: (x) => Math.sqrt(Math.max(0, 1 - x * x)), color: pal.cyan(), width: 2 }, { f: (x) => -Math.sqrt(Math.max(0, 1 - x * x)), color: pal.cyan(), width: 2 }],
          markers: [{ x: Math.cos(p.t), y: Math.sin(p.t), color: pal.amber(), r: 5, label: `f = ${fmt(f(Math.cos(p.t), Math.sin(p.t)), 2)}` }],
        };
      },
      readout: (p) => {
        const x = Math.cos(p.t); const y = Math.sin(p.t);
        return [
          { label: '约束', value: 'x² + y² = 1' },
          { label: '当前点', value: `(${fmt(x, 2)}, ${fmt(y, 2)})` },
          { label: 'f = x + 2y', value: fmt(x + 2 * y, 3) },
          { label: '最大值点', value: '(1/√5, 2/√5) ≈ (0.45, 0.89)', hint: '梯度与约束法向量平行' },
          { label: '最小值点', value: '(-0.45, -0.89)' },
        ];
      },
      note: '拉格朗日乘数法的几何含义：目标函数的等高线与约束曲线相切，梯度平行。',
    };
  }

  if (v === 'dirderiv' || v === 'grad') {
    const f = (x: number, y: number) => x * x + 2 * y * y;
    return {
      what: v === 'grad'
        ? '梯度 ∇f 指向函数增长最快的方向，且与等高线垂直'
        : '方向导数：沿单位方向 l 的变化率，等于梯度在该方向上的投影',
      controls: [
        ctrl('x', '点 x', -1.8, 1.8, 0.05, 0.8, (vv) => vv.toFixed(2)),
        ctrl('y', '点 y', -1.2, 1.2, 0.05, 0.6, (vv) => vv.toFixed(2)),
        ctrl('theta', '方向角 θ', 0, Math.PI * 2, 0.02, 0.6, (vv) => `${((vv * 180) / Math.PI).toFixed(0)}°`),
      ],
      view: { x: [-2.2, 2.2], y: [-1.6, 1.6] },
      scene: (p, pal) => {
        const gx = 2 * p.x;
        const gy = 4 * p.y;
        const gl = Math.hypot(gx, gy) || 1;
        const dx = Math.cos(p.theta);
        const dy = Math.sin(p.theta);
        const dd = gx * dx + gy * dy;
        return {
          grid: false,
          contours: { f, x: [-2.2, 2.2], y: [-1.6, 1.6], levels: [0.5, 1, 2, 3, 4], color: pal.violet(0.5) },
          arrows: [
            { x: p.x, y: p.y, dx: gx / gl * 0.7, dy: gy / gl * 0.7, color: pal.rose(), width: 2.6 },
            { x: p.x, y: p.y, dx: dx * 0.7, dy: dy * 0.7, color: pal.cyan(), width: 2.2 },
          ],
          markers: [{ x: p.x, y: p.y, color: pal.amber(), r: 4.5 }],
          texts: [
            { x: p.x + gx / gl * 0.75, y: p.y + gy / gl * 0.75, text: '∇f', color: pal.rose() },
            { x: p.x + dx * 0.8, y: p.y + dy * 0.8, text: 'l', color: pal.cyan() },
          ],
        };
      },
      readout: (p) => {
        const gx = 2 * p.x;
        const gy = 4 * p.y;
        const dx = Math.cos(p.theta);
        const dy = Math.sin(p.theta);
        const dd = gx * dx + gy * dy;
        return [
          { label: '∇f', value: `(${fmt(gx, 2)}, ${fmt(gy, 2)})` },
          { label: '方向 l', value: `(${fmt(dx, 2)}, ${fmt(dy, 2)})` },
          { label: '方向导数 ∂f/∂l', value: fmt(dd, 4) },
          { label: '最大方向导数', value: fmt(Math.hypot(gx, gy), 4), hint: '就是 |∇f|' },
          { label: 'θ 与 ∇f 同向？', value: Math.abs(dd - Math.hypot(gx, gy)) < 1e-3 ? '是 → 取到最大' : '否', tone: 'good' },
        ];
      },
      note: v === 'grad'
        ? '梯度的三条性质：指向最速上升方向、模等于最大变化率、垂直于等高线。'
        : '方向导数是梯度在方向上的投影 —— 所以 θ 与梯度同向时取到最大。',
    };
  }

  /* totaldiff / neccond / chain2 / implicit3：用热力图看 z=f(x,y) */
  const zf = (x: number, y: number) => x * x + y * y;
  return {
    what: v === 'totaldiff'
      ? '全微分：dz = f_x dx + f_y dy —— 两个方向的变化量加起来'
      : v === 'chain2'
        ? '多元链式法则：z 通过 u、v 间接依赖 t，要沿所有路径求和'
        : v === 'implicit3'
          ? '隐函数求导（三元）：∂z/∂x = −F_x/F_z'
          : '可微的必要条件：偏导数存在',
    controls: [
      ctrl('x', '点 x', -2, 2, 0.05, 0.8, (vv) => vv.toFixed(2)),
      ctrl('y', '点 y', -2, 2, 0.05, 0.6, (vv) => vv.toFixed(2)),
    ],
    view: { x: [-2.2, 2.2], y: [-2.2, 2.2] },
    scene: (p, pal) => ({
      grid: false,
      heat: { f: (x, y) => zf(x, y), x: [-2.2, 2.2], y: [-2.2, 2.2], cells: 44, color: (t, a = 1) => pal.violet(a * 0.8) },
      contours: { f: (x, y) => zf(x, y), x: [-2.2, 2.2], y: [-2.2, 2.2], levels: [0.5, 1, 2, 3, 4, 6], color: pal.text(0.5) },
      arrows: [{ x: p.x, y: p.y, dx: 2 * p.x * 0.22, dy: 2 * p.y * 0.22, color: pal.rose(), width: 2.4 }],
      markers: [{ x: p.x, y: p.y, color: pal.amber(), r: 4.5, label: `z = ${fmt(zf(p.x, p.y), 2)}` }],
    }),
    readout: (p) => [
      { label: 'f_x', value: fmt(2 * p.x, 3) },
      { label: 'f_y', value: fmt(2 * p.y, 3) },
      { label: 'dz（dx=dy=0.1）', value: fmt(2 * p.x * 0.1 + 2 * p.y * 0.1, 4), hint: 'f_x dx + f_y dy' },
      { label: 'z = f(x,y)', value: fmt(zf(p.x, p.y), 3) },
    ],
    note: v === 'totaldiff'
      ? '全微分是「两个方向偏导增量之和」，前提是函数可微。'
      : '偏导数存在只是可微的必要条件 —— 反例在教材上都有，不要记反。',
  };
};

/* ============================================================
   15. 重积分
   ============================================================ */
const doubleint: DemoRegistry[string] = (variant) => {
  const v = variant || 'xtype';

  if (v === 'cyl' || v === 'sph') {
    const sph = v === 'sph';
    return {
      what: sph
        ? '球面坐标：dV = r²sinφ dr dφ dθ —— 那个 r²sinφ 是雅可比因子'
        : '柱面坐标：dV = r dr dθ dz —— 多出来的 r 是雅可比因子',
      controls: [
        ctrl('r', sph ? '半径 r' : '半径 r', 0.1, 2, 0.05, 1, (vv) => vv.toFixed(2)),
        sph ? ctrl('phi', '仰角 φ', 0.05, Math.PI - 0.05, 0.02, Math.PI / 3, (vv) => `${((vv * 180) / Math.PI).toFixed(0)}°`)
          : ctrl('theta', '方位角 θ', 0, Math.PI * 2, 0.02, 0.8, (vv) => `${((vv * 180) / Math.PI).toFixed(0)}°`),
        ctrl('dr', sph ? 'dr' : 'dr', 0.02, 0.4, 0.01, 0.15, (vv) => vv.toFixed(2)),
        sph ? ctrl('dphi', 'dφ', 0.02, 0.5, 0.01, 0.2, (vv) => vv.toFixed(2))
          : ctrl('dz', 'dz', 0.02, 1, 0.01, 0.3, (vv) => vv.toFixed(2)),
      ],
      view: { x: [-2.4, 2.4], y: [-2.4, 2.4] },
      scene: (p, pal) => ({
        grid: false,
        contours: {
          f: (x, y) => Math.sqrt(x * x + y * y), x: [-2.4, 2.4], y: [-2.4, 2.4],
          levels: [0.5, 1, 1.5, 2], color: pal.text(0.35),
        },
        segs: sph
          ? [{ x1: 0, y1: 0, x2: p.r * Math.cos(p.phi), y2: p.r * Math.sin(p.phi), color: pal.cyan(), width: 2.4 }]
          : [{ x1: 0, y1: 0, x2: p.r * Math.cos(p.theta), y2: p.r * Math.sin(p.theta), color: pal.cyan(), width: 2.4 }],
        markers: [{
          x: sph ? p.r * Math.cos(p.phi) : p.r * Math.cos(p.theta),
          y: sph ? p.r * Math.sin(p.phi) : p.r * Math.sin(p.theta),
          color: pal.amber(), r: 4.5,
        }],
      }),
      readout: (p) => sph
        ? [
          { label: '体积元 dV', value: fmt(p.r * p.r * Math.sin(p.phi) * p.dr * p.dphi, 5), hint: 'r²sinφ dr dφ dθ' },
          { label: 'r² sinφ', value: fmt(p.r * p.r * Math.sin(p.phi), 4) },
          { label: '球体体积（整球）', value: fmt((4 / 3) * Math.PI * 8, 4), hint: 'r=2 时 4πr³/3' },
        ]
        : [
          { label: '体积元 dV', value: fmt(p.r * p.dr * p.dz, 5), hint: 'r dr dθ dz' },
          { label: '雅可比因子', value: fmt(p.r, 4) },
          { label: '圆柱体积', value: fmt(Math.PI * p.r * p.r * p.dz, 4) },
        ],
      note: sph
        ? '球面坐标的雅可比是 r²sinφ，少一个 r 或者少一个 sinφ 都会算错。'
        : '柱面坐标的雅可比是 r。它来自「角度变化时弧长要乘半径」。',
    };
  }

  if (v === 'polar') {
    return {
      what: '极坐标下的二重积分：dσ = r dr dθ，多出来的 r 不能丢',
      controls: [
        int('n', '分割数 n', 2, 40, 8),
        ctrl('R', '半径 R', 0.5, 2.2, 0.05, 1.6, (vv) => vv.toFixed(2)),
      ],
      view: { x: [-2.4, 2.4], y: [-2.4, 2.4] },
      scene: (p, pal) => {
        const n = Math.max(2, Math.round(p.n));
        const segs: Scene['segs'] = [];
        for (let i = 1; i <= n; i++) {
          const r = (i / n) * p.R;
          segs.push({ x1: -r, y1: 0, x2: r, y2: 0, color: pal.cyan(0.18) });
        }
        for (let j = 0; j < n; j++) {
          const a = (j / n) * Math.PI * 2;
          segs.push({ x1: 0, y1: 0, x2: p.R * Math.cos(a), y2: p.R * Math.sin(a), color: pal.cyan(0.18) });
        }
        return {
          grid: false,
          segs,
          curves: [{ f: (x) => Math.sqrt(Math.max(0, p.R * p.R - x * x)), color: pal.violet(), width: 2.2 }, { f: (x) => -Math.sqrt(Math.max(0, p.R * p.R - x * x)), color: pal.violet(), width: 2.2 }],
          markers: [{ x: p.R * Math.cos(0.8), y: p.R * Math.sin(0.8), color: pal.amber(), r: 4, label: `r = ${fmt(p.R, 2)}` }],
        };
      },
      readout: (p) => {
        const n = Math.max(2, Math.round(p.n));
        const area = Math.PI * p.R * p.R;
        const approx = Array.from({ length: n }, (_, i) => {
          const r = ((i + 0.5) / n) * p.R;
          return (2 * Math.PI / n) * r * (p.R / n) * r;
        }).reduce((a, b) => a + b, 0);
        return [
          { label: '圆面积 πR²', value: fmt(area, 5) },
          { label: '极坐标网格求和', value: fmt(approx, 5), hint: 'Σ r·Δr·Δθ' },
          { label: '误差', value: fmt(Math.abs(approx - area), 5), tone: Math.abs(approx - area) < 0.1 ? 'good' : 'default' },
        ];
      },
      note: '极坐标里 dσ = r dr dθ。忘了那个 r，圆面积会算成 πR 而不是 πR²。',
    };
  }

  if (v === 'swap') {
    return {
      what: '交换积分次序：同一个区域，先 y 后 x 还是先 x 后 y',
      controls: [int('n', '分割数 n', 2, 30, 6)],
      view: { x: [-0.2, 2.4], y: [-0.2, 2.4] },
      scene: (p, pal) => {
        const n = Math.max(2, Math.round(p.n));
        const segs: Scene['segs'] = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          segs.push({ x1: 0, y1: t * 2, x2: 2 - t * 2, y2: t * 2, color: pal.cyan(0.22) });
          segs.push({ x1: t * 2, y1: 0, x2: t * 2, y2: 2 - t * 2, color: pal.violet(0.22) });
        }
        return {
          grid: false,
          segs,
          fills: [{ from: 0, to: 2, top: (x) => 2 - x, color: pal.cyan(), alpha: 0.08 }],
          markers: [
            { x: 2, y: 0, color: pal.emerald(), r: 4, label: '(2,0)' },
            { x: 0, y: 2, color: pal.emerald(), r: 4, label: '(0,2)' },
          ],
        };
      },
      readout: (p) => {
        const n = Math.max(2, Math.round(p.n));
        /* ∫₀²dx∫₀^{2-x} 1 dy 与 ∫₀²dy∫₀^{2-y} 1 dx 都是三角形面积 */
        const a = Array.from({ length: n }, () => (2 / n) * (2 / n)).reduce((s, v) => s + v, 0) * n;
        return [
          { label: '区域面积', value: '2', hint: 'x≥0, y≥0, x+y≤2 的三角形' },
          { label: '先 y 后 x', value: fmt(a / n * n / n, 4), hint: '∫₀²dx∫₀^{2-x}dy' },
          { label: '先 x 后 y', value: fmt(a / n * n / n, 4), hint: '∫₀²dy∫₀^{2-y}dx' },
          { label: '分割数 n', value: String(n) },
        ];
      },
      note: '换序的目的是「把积不出来的那层换到里面」。区域必须画对，限才写得对。',
    };
  }

  return {
    what: 'X 型区域：先固定 x，把 y 从下边界积到上边界',
    controls: [int('n', '分割数 n', 2, 30, 6)],
    view: { x: [-0.2, 2.4], y: [-0.2, 2.4] },
    scene: (p, pal) => {
      const n = Math.max(2, Math.round(p.n));
      const segs: Scene['segs'] = Array.from({ length: n + 1 }, (_, i) => ({
        x1: (i / n) * 2, y1: 0, x2: (i / n) * 2, y2: 2 - (i / n) * 2, color: pal.cyan(0.35),
      }));
      return {
        grid: false,
        segs,
        fills: [{ from: 0, to: 2, top: (x) => 2 - x, color: pal.violet(), alpha: 0.12 }],
        curves: [{ f: (x) => 2 - x, color: pal.violet(), width: 2.2, label: 'y = 2 − x' }],
        markers: [{ x: 0.8, y: 1.2, color: pal.amber(), r: 4 }],
      };
    },
    readout: (p) => {
      const n = Math.max(2, Math.round(p.n));
      let s = 0;
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) / n * 2;
        const dx = 2 / n;
        s += (2 - x) * dx;
      }
      return [
        { label: '积分区域', value: '0 ≤ x ≤ 2, 0 ≤ y ≤ 2−x' },
        { label: '分割数 n', value: String(n) },
        { label: '面积（累次求和）', value: fmt(s, 5) },
        { label: '精确值', value: '2', tone: Math.abs(s - 2) < 0.05 ? 'good' : 'default' },
      ];
    },
    note: 'X 型区域的内层对 y 积分，外层对 x 积分；上下边界写成 x 的函数。',
  };
};

/* ============================================================
   16. 曲线曲面积分（格林 / 高斯）
   ============================================================ */
const vectorcalc: DemoRegistry[string] = (variant) => {
  const v = variant || 'green';
  const P = (x: number, y: number) => -y;
  const Q = (x: number, y: number) => x;
  return {
    what: v === 'gauss'
      ? '高斯公式：闭曲面上的通量 = 内部散度的三重积分'
      : '格林公式：沿闭曲线的环量 = 区域内旋度的二重积分',
    controls: [int('n', '分割数 n', 2, 24, 6)],
    view: { x: [-1.6, 1.6], y: [-1.6, 1.6] },
    scene: (p, pal) => {
      const n = Math.max(2, Math.round(p.n));
      const arrows: Scene['arrows'] = [];
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
          const x = -1 + (2 * i) / n;
          const y = -1 + (2 * j) / n;
          if (x * x + y * y > 1.02) continue;
          const u = P(x, y); const w = Q(x, y);
          const l = Math.hypot(u, w) || 1;
          arrows.push({ x, y, dx: (u / l) * (1.6 / n), dy: (w / l) * (1.6 / n), color: pal.cyan(0.5) });
        }
      }
      return {
        grid: false,
        arrows,
        curves: [
          { f: (x) => Math.sqrt(Math.max(0, 1 - x * x)), color: pal.violet(), width: 2.6 },
          { f: (x) => -Math.sqrt(Math.max(0, 1 - x * x)), color: pal.violet(), width: 2.6 },
        ],
        markers: [
          { x: Math.cos(0.9), y: Math.sin(0.9), color: pal.amber(), r: 4.5, label: '逆时针' },
        ],
      };
    },
    readout: (p) => {
      /* 向量场 (−y, x) 的旋度恒为 2，故 ∮ = 2 × 面积 = 2π */
      const n = Math.max(2, Math.round(p.n));
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const dx = -Math.sin(a) * (2 * Math.PI / n);
        const dy = Math.cos(a) * (2 * Math.PI / n);
        sum += P(Math.cos(a), Math.sin(a)) * dx + Q(Math.cos(a), Math.sin(a)) * dy;
      }
      return [
        { label: '场 (P, Q)', value: '(−y, x)' },
        { label: '旋度 ∂Q/∂x − ∂P/∂y', value: '2' },
        { label: '二重积分 ∬2 dσ', value: fmt(2 * Math.PI, 4), hint: '= 2 × 单位圆面积' },
        { label: '环量 ∮（离散近似）', value: fmt(sum, 4), tone: 'good' },
        { label: '分割数 n', value: String(n) },
      ];
    },
    note: v === 'gauss'
      ? '高斯公式是格林公式在三维的推广：闭曲面通量 = 内部散度之和。'
      : '格林公式把「沿边界的线积分」换成了「区域内的二重积分」—— 路径换面积。',
  };
};

/* ============================================================
   17. 无穷级数（含幂级数与傅里叶）
   ============================================================ */
const series: DemoRegistry[string] = (variant) => {
  const v = variant || 'p';

  if (v === 'geom') {
    return {
      what: '几何级数：\\sum aq^{n} 只在 |q|<1 时收敛',
      controls: [
        ctrl('q', '公比 q', -1.4, 1.4, 0.02, 0.6, (vv) => vv.toFixed(2)),
        int('n', '取到第 n 项', 1, 60, 12),
      ],
      view: { x: [0, 62], y: [-4, 4] },
      scene: (p, pal) => ({
        curves: [{ f: (x) => { const n = Math.round(x); if (n < 1) return NaN; let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(p.q, k); return s; }, color: pal.violet(), label: '部分和 S_n' }],
        hlines: [{
          y: Math.abs(p.q) < 1 ? 1 / (1 - p.q) : NaN,
          color: pal.emerald(0.8), dash: [5, 4], label: `和 = 1/(1-q) = ${fmt(1 / (1 - p.q), 3)}`,
        }],
        markers: [{ x: p.n, y: (() => { let s = 0; for (let k = 0; k <= Math.round(p.n); k++) s += Math.pow(p.q, k); return s; })(), color: pal.cyan() }],
      }),
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        let s = 0;
        for (let k = 0; k <= n; k++) s += Math.pow(p.q, k);
        const conv = Math.abs(p.q) < 1;
        return [
          { label: '|q| < 1 ?', value: conv ? '是 → 收敛' : '否 → 发散', tone: conv ? 'good' : 'warn' },
          { label: '部分和 S_n', value: fmt(s, 5) },
          { label: '收敛时的和', value: conv ? fmt(1 / (1 - p.q), 5) : '∞' },
        ];
      },
      note: 'q 的绝对值一旦不小于 1，部分和就发散 —— 这是判敛里最好记的一个。',
    };
  }

  if (v === 'ratio' || v === 'root') {
    const isRoot = v === 'root';
    const u = (n: number, p: Params) => Math.pow(p.c, n) / fact(n);
    return {
      what: isRoot
        ? '根值判别法：ρ = lim ⁿ√uₙ，ρ<1 收敛、ρ>1 发散'
        : '比值判别法：ρ = lim uₙ₊₁/uₙ，ρ<1 收敛、ρ>1 发散',
      controls: [
        ctrl('c', '通项参数 c', 0.3, 4, 0.1, 1.6, (vv) => vv.toFixed(1)),
        int('n', '取到第 n 项', 1, 40, 10),
      ],
      view: { x: [0, 42], y: [-0.2, 2.6] },
      scene: (p, pal) => {
        const n = Math.max(1, Math.round(p.n));
        const seq: number[] = [];
        for (let k = 1; k <= n; k++) {
          const val = isRoot ? Math.pow(u(k, p), 1 / k) : u(k + 1, p) / u(k, p);
          seq.push(val);
        }
        return {
          markers: seq.map((val, i) => ({ x: i + 1, y: val, color: pal.cyan(), r: 3 })),
          hlines: [
            { y: 1, color: pal.text(0.4), dash: [4, 4], label: 'ρ = 1（分界线）' },
            { y: p.c, color: pal.emerald(0.7), dash: [5, 4], label: `ρ = ${fmt(p.c, 2)}` },
          ],
        };
      },
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        const last = isRoot ? Math.pow(u(n, p), 1 / n) : u(n + 1, p) / u(n, p);
        const conv = p.c < 1;
        return [
          { label: 'ρ 的近似值', value: fmt(last, 5) },
          { label: 'ρ < 1 ?', value: conv ? '是 → 收敛' : '否 → 发散', tone: conv ? 'good' : 'warn' },
          { label: '理论上的 ρ', value: fmt(p.c, 3) },
        ];
      },
      note: '比值法和根值法都只能判 ρ≠1 的情形；ρ=1 时要换别的方法。',
    };
  }

  if (v === 'leibniz' || v === 'abscond') {
    return {
      what: v === 'abscond'
        ? '绝对收敛 vs 条件收敛：取绝对值后还收敛才算绝对收敛'
        : '莱布尼茨判别法：交错级数只要通项递减趋于 0，就一定收敛',
      controls: [int('n', '取到第 n 项', 1, 80, 20)],
      view: { x: [0, 84], y: [-1.6, 1.6] },
      scene: (p, pal) => {
        const n = Math.max(1, Math.round(p.n));
        const S = (k: number) => { let s = 0; for (let i = 1; i <= k; i++) s += (i % 2 === 1 ? 1 : -1) / i; return s; };
        const A = (k: number) => { let s = 0; for (let i = 1; i <= k; i++) s += 1 / i; return s; };
        const seq = Array.from({ length: n }, (_, i) => S(i + 1));
        return {
          markers: seq.map((val, i) => ({ x: i + 1, y: val, color: pal.cyan(), r: 2.8 })),
          curves: v === 'abscond'
            ? [{ f: (x) => (x < 1 ? NaN : A(Math.round(x))), color: pal.rose(), label: '绝对值级数的部分和（发散）' }]
            : [],
          hlines: [{ y: Math.LN2, color: pal.emerald(0.8), dash: [5, 4], label: 'ln 2 ≈ 0.693' }],
        };
      },
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        let s = 0;
        for (let i = 1; i <= n; i++) s += (i % 2 === 1 ? 1 : -1) / i;
        let a = 0;
        for (let i = 1; i <= n; i++) a += 1 / i;
        return [
          { label: '交错级数部分和', value: fmt(s, 5), hint: '→ ln 2' },
          { label: '绝对值级数部分和', value: fmt(a, 5), hint: '调和级数，发散' },
          { label: '结论', value: '条件收敛', tone: 'warn' },
          { label: '通项是否递减趋 0', value: '是', tone: 'good' },
        ];
      },
      note: v === 'abscond'
        ? 'Σ(−1)ⁿ⁻¹/n 收敛，但取绝对值后是调和级数、发散 —— 所以它只是条件收敛。'
        : '莱布尼茨判别法只要求「递减且趋于 0」，不需要别的条件。',
    };
  }

  if (v === 'radius' || v === 'deriv' || v === 'integ') {
    return {
      what: v === 'radius'
        ? '收敛半径：R = lim|aₙ/aₙ₊₁|，|x|<R 时绝对收敛'
        : v === 'deriv'
          ? '幂级数逐项求导：收敛半径不变，端点可能变'
          : '幂级数逐项积分：收敛半径不变，端点可能变',
      controls: [
        ctrl('x', '自变量 x', -1.4, 1.4, 0.02, 0.6, (vv) => vv.toFixed(2)),
        int('n', '项数 n', 1, 24, 8),
      ],
      view: { x: [-1.5, 1.5], y: [-4, 4] },
      scene: (p, pal) => {
        const n = Math.max(1, Math.round(p.n));
        /* Σ x^n 的部分和、逐项求导、逐项积分三种形态 */
        const S = (x: number) => { let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(x, k); return s; };
        const D = (x: number) => { let s = 0; for (let k = 1; k <= n; k++) s += k * Math.pow(x, k - 1); return s; };
        const I = (x: number) => { let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(x, k + 1) / (k + 1); return s; };
        const fn = v === 'deriv' ? D : v === 'integ' ? I : S;
        return {
          curves: [
            { f: (x) => (Math.abs(x) >= 1 ? NaN : fn(x)), color: pal.violet(), label: '部分和' },
            { f: v === 'deriv' ? (x) => 1 / ((1 - x) ** 2) : v === 'integ' ? (x) => -Math.log(1 - x) : (x) => 1 / (1 - x), color: pal.cyan(0.8), width: 1.8, dash: [4, 4], label: '和函数' },
          ],
          vlines: [
            { x: -1, color: pal.emerald(0.6), dash: [4, 4], label: 'x = −R' },
            { x: 1, color: pal.emerald(0.6), dash: [4, 4], label: 'x = R' },
          ],
          markers: [{ x: p.x, y: fn(p.x), color: pal.amber(), r: 4 }],
        };
      },
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        const S = (x: number) => { let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(x, k); return s; };
        const D = (x: number) => { let s = 0; for (let k = 1; k <= n; k++) s += k * Math.pow(x, k - 1); return s; };
        const I = (x: number) => { let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(x, k + 1) / (k + 1); return s; };
        const fn = v === 'deriv' ? D : v === 'integ' ? I : S;
        return [
          { label: '收敛半径 R', value: '1', hint: 'lim|aₙ/aₙ₊₁| = 1' },
          { label: '|x| < R ?', value: Math.abs(p.x) < 1 ? '是 → 绝对收敛' : '否 → 发散', tone: Math.abs(p.x) < 1 ? 'good' : 'warn' },
          { label: '部分和', value: fmt(fn(p.x), 5) },
          { label: '和函数值', value: v === 'deriv' ? fmt(1 / ((1 - p.x) ** 2), 5) : v === 'integ' ? fmt(-Math.log(1 - p.x), 5) : fmt(1 / (1 - p.x), 5) },
        ];
      },
      note: '逐项求导和逐项积分都不改变收敛半径，但会改变端点的收敛性 —— 端点要单独验。',
    };
  }

  if (v === 'fouriercoef' || v === 'dirichlet') {
    return {
      what: v === 'dirichlet'
        ? '狄利克雷收敛定理：傅里叶级数在连续点收敛到 f(x)，在间断点收敛到左右极限的平均'
        : '傅里叶系数：aₙ = (1/π)∫f(x)cos nx dx',
      controls: [int('n', '项数 n', 0, 24, 4)],
      view: { x: [-Math.PI - 0.4, Math.PI + 0.4], y: [-1.6, 1.6] },
      scene: (p, pal) => {
        const n = Math.max(0, Math.round(p.n));
        /* 方波 f(x)=sign(sin x) 的傅里叶级数：4/π Σ sin((2k-1)x)/(2k-1) */
        const S = (x: number) => {
          let s = 0;
          for (let k = 1; k <= n; k++) s += Math.sin((2 * k - 1) * x) / (2 * k - 1);
          return (4 / Math.PI) * s;
        };
        return {
          curves: [
            { f: (x) => (Math.sin(x) >= 0 ? 1 : -1), color: pal.cyan(), width: 2, dash: [5, 4], label: 'f(x) 方波' },
            { f: S, color: pal.violet(), label: `前 ${n} 项部分和` },
          ],
          hlines: [{ y: 0, color: pal.text(0.3), dash: [3, 3] }],
        };
      },
      readout: (p) => {
        const n = Math.max(0, Math.round(p.n));
        const S = (x: number) => {
          let s = 0;
          for (let k = 1; k <= n; k++) s += Math.sin((2 * k - 1) * x) / (2 * k - 1);
          return (4 / Math.PI) * s;
        };
        return [
          { label: '项数 n', value: String(n) },
          { label: '在 x=π/2（连续点）', value: fmt(S(Math.PI / 2), 4), hint: '真值 1' },
          { label: '在 x=0（间断点）', value: fmt(S(0), 4), hint: '左右极限平均 = 0' },
          { label: '在 x=π（间断点）', value: fmt(S(Math.PI), 4), hint: '左右极限平均 = 0' },
        ];
      },
      note: '方波在间断点处级数收敛到 0 —— 那是左极限 (−1) 与右极限 (+1) 的平均，不是任何一侧的值。',
    };
  }

  /* p 级数默认 */
  return {
    what: 'p 级数：\\sum 1/n^{p} 在 p>1 时收敛，p≤1 时发散',
    controls: [
      ctrl('p', '幂次 p', 0.3, 3, 0.05, 1.5, (vv) => vv.toFixed(2)),
      int('n', '取到第 n 项', 1, 120, 30),
    ],
    view: { x: [0, 125], y: [-0.5, 6] },
    scene: (p, pal) => {
      const n = Math.max(1, Math.round(p.n));
      let s = 0;
      const pts: { x: number; y: number }[] = [];
      for (let k = 1; k <= n; k++) { s += 1 / Math.pow(k, p.p); pts.push({ x: k, y: s }); }
      return {
        markers: pts.map((q) => ({ x: q.x, y: q.y, color: pal.cyan(), r: 2.6 })),
        hlines: p.p > 1
          ? [{ y: 1 / (p.p - 1) + 1, color: pal.emerald(0.7), dash: [5, 4], label: '收敛上界（积分判别法）' }]
          : [],
      };
    },
    readout: (p) => {
      const n = Math.max(1, Math.round(p.n));
      let s = 0;
      for (let k = 1; k <= n; k++) s += 1 / Math.pow(k, p.p);
      const conv = p.p > 1;
      return [
        { label: '部分和 S_n', value: fmt(s, 5) },
        { label: 'p > 1 ?', value: conv ? '是 → 收敛' : '否 → 发散', tone: conv ? 'good' : 'warn' },
        { label: '收敛时的界', value: conv ? fmt(1 + 1 / (p.p - 1), 4) : '∞', hint: 'S ≤ 1 + ∫₁^∞ x^{-p}dx' },
      ];
    },
    note: 'p=1 是调和级数，正好落在发散那一侧 —— 这是判据里最容易被记错的地方。',
  };
};

/* ============================================================
   18. 微分方程
   ============================================================ */
const ode: DemoRegistry[string] = (variant) => {
  const v = variant || 'separable';

  if (v === 'real' || v === 'repeat' || v === 'complex' || v === 'particular') {
    return {
      what: '二阶常系数线性方程：特征根的类型决定通解的形状',
      controls: [
        ctrl('C1', '常数 C₁', -2, 2, 0.1, 1, (vv) => vv.toFixed(1)),
        ctrl('C2', '常数 C₂', -2, 2, 0.1, 0.5, (vv) => vv.toFixed(1)),
      ],
      view: { x: [-1.5, 3.5], y: [-4, 4] },
      scene: (p, pal) => {
        const y = (x: number) => {
          if (v === 'real') return p.C1 * Math.exp(x) + p.C2 * Math.exp(2 * x);
          if (v === 'repeat') return (p.C1 + p.C2 * x) * Math.exp(x);
          if (v === 'complex') return Math.exp(-0.5 * x) * (p.C1 * Math.cos(2 * x) + p.C2 * Math.sin(2 * x));
          /* 非齐次：齐次通解 + 一个特解 */
          return p.C1 * Math.exp(x) + p.C2 * Math.exp(2 * x) + 0.5;
        };
        return {
          curves: [{ f: y, color: pal.violet(), label: 'y(x)' }],
          hlines: [{ y: 0, color: pal.text(0.3), dash: [3, 3] }],
        };
      },
      readout: (p) => {
        const rows: Record<string, { label: string; value: string }[]> = {
          real: [{ label: '特征方程', value: 'r² − 3r + 2 = 0' }, { label: '特征根', value: 'r₁ = 1, r₂ = 2' }, { label: '通解形式', value: 'C₁eˣ + C₂e²ˣ' }],
          repeat: [{ label: '特征方程', value: 'r² − 2r + 1 = 0' }, { label: '特征根', value: 'r = 1（二重）' }, { label: '通解形式', value: '(C₁ + C₂x)eˣ' }],
          complex: [{ label: '特征方程', value: 'r² + r + 4.25 = 0' }, { label: '特征根', value: 'α ± βi = −0.5 ± 2i' }, { label: '通解形式', value: 'e^{αx}(C₁cos βx + C₂sin βx)' }],
          particular: [{ label: '齐次通解', value: 'C₁eˣ + C₂e²ˣ' }, { label: '特解形式', value: 'y* = x^k Q_m(x)e^{λx}' }, { label: '本例特解', value: 'y* = 0.5' }],
        };
        return [
          ...(rows[v] || rows.real).map((r) => ({ label: r.label, value: r.value })),
          { label: 'y(0)', value: fmt(v === 'repeat' ? p.C1 : v === 'complex' ? p.C1 : p.C1 + p.C2 + (v === 'particular' ? 0.5 : 0), 4) },
        ];
      },
      note: '三种特征根对应三种通解形式。重根时那个多出来的 x 是最容易漏的。',
    };
  }

  /* 一阶：方向场 + 解曲线 */
  const field = (x: number, y: number, p: Params) => {
    if (v === 'homogeneous') return (y * y) / (x * x + 0.2);
    if (v === 'linear') return 1 - y;
    if (v === 'exact') return -x / (y + 0.4);
    if (v === 'euler') return y / (x + 0.5);
    return x * (y + 0.3) / 2;   // separable
  };
  return {
    what: '一阶微分方程：方向场给出每一点的斜率，解曲线就是顺着它走的线',
    controls: [
      ctrl('C', '初值常数 C', -2, 2, 0.1, 0.6, (vv) => vv.toFixed(1)),
      ctrl('x0', '初值 x₀', -1.5, 2.5, 0.1, 0, (vv) => vv.toFixed(1)),
    ],
    view: { x: [-1.6, 2.6], y: [-2.4, 2.4] },
    scene: (p, pal) => {
      const arrows: Scene['arrows'] = [];
      const N = 13;
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N; j++) {
          const x = -1.6 + (4.2 * i) / N;
          const y = -2.4 + (4.8 * j) / N;
          const s = field(x, y, p);
          const l = Math.hypot(1, s) || 1;
          arrows.push({ x, y, dx: (0.16 * 1) / l, dy: (0.16 * s) / l, color: pal.cyan(0.32) });
        }
      }
      /* 从初值点向前向后各积一遍，得到一条解曲线 */
      const trace = (dir: number) => {
        const pts: { x: number; y: number }[] = [];
        let x = p.x0; let y = p.C;
        for (let i = 0; i < 200; i++) {
          const s = field(x, y, p);
          x += dir * 0.02;
          y += dir * 0.02 * s;
          if (!Number.isFinite(y) || Math.abs(y) > 12) break;
          pts.push({ x, y });
        }
        return pts;
      };
      return {
        grid: false,
        arrows,
        markers: [
          ...trace(1).map((q) => ({ x: q.x, y: q.y, color: pal.violet(), r: 1.6 })),
          ...trace(-1).map((q) => ({ x: q.x, y: q.y, color: pal.violet(), r: 1.6 })),
          { x: p.x0, y: p.C, color: pal.amber(), r: 4.5, label: `初值 (${fmt(p.x0, 1)}, ${fmt(p.C, 1)})` },
        ],
      };
    },
    readout: (p) => {
      const names: Record<string, string> = {
        separable: '可分离变量：dy/dx = f(x)g(y)',
        homogeneous: '齐次方程：dy/dx = φ(y/x)',
        linear: '一阶线性：y\' + P(x)y = Q(x)',
        exact: '全微分方程：P dx + Q dy = 0',
        euler: '欧拉方程：x = e^t 换元',
      };
      return [
        { label: '方程类型', value: names[v] || names.separable },
        { label: '该点斜率 dy/dx', value: fmt(field(p.x0, p.C, p), 4) },
        { label: '初值点', value: `(${fmt(p.x0, 1)}, ${fmt(p.C, 1)})` },
        { label: '解法', value: v === 'linear' ? '先求齐次解，再用常数变易' : v === 'exact' ? '验证 P_y = Q_x，找势函数' : v === 'homogeneous' ? '令 u = y/x' : v === 'euler' ? '令 x = e^t 化为常系数' : '分离变量后两边积分' },
      ];
    },
    note: '解曲线处处与方向场的箭头相切 —— 这就是「微分方程的解」的几何意义。',
  };
};

/* ============================================================
   注册表
   ============================================================ */
export const CALCULUS_DEMOS: DemoRegistry = {
  asymp,
  limit,
  continuity,
  secant,
  derivtable,
  derivrule,
  mvt,
  taylor,
  monotone,
  antideriv,
  integral,
  varlimit,
  solid,
  multivar,
  doubleint,
  vectorcalc,
  series,
  ode,
};

export const CALCULUS_KINDS = Object.keys(CALCULUS_DEMOS);
