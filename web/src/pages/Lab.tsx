import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ArrowUpRight, BookOpen, ChevronDown, FlaskConical, Info, Move3d, Search, Star,
} from 'lucide-react';
import { Panel, SectionTitle, Segmented, Badge } from '@/components/ui/Primitives';
import { InlineMath, RichText } from '@/components/ui/Math';
import { api, type Formula } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { cn, cssVar, MASTERY_STYLE } from '@/lib/utils';
import { canvasColor } from '@/components/fx/theme-colors';

/* 公式实验室 = 两个东西
 *
 *   ① 交互演示（Playground）：四个"可以拖"的模块，每个都是一张手写的 canvas。
 *      设计原则：先给生活场景钩子再给公式；拖动的效果必须"看得见地"趋向结论；
 *      结论用大白话写，不写成定理。
 *
 *   ② 公式手册（Handbook）：按考纲整理的公式库（257 条，覆盖 19 章 67 个考点）。
 *
 * ★ 为什么必须是两个，而不是「把手册也做成可拖的」：
 *   每个交互模块都是**手写的绘图逻辑**（割线的增量三角形、黎曼和的矩形、
 *   泰勒的近似区间、ε-N 的带宽 —— 各写一套）。这种东西不可能对几百条公式
 *   各写一遍。反过来，公式手册需要的是**覆盖面和可检索**，不是每个都动起来。
 *   把两者塞进一个视图，结果是两边都做不好。
 *
 *   所以这里的分工是：手册负责「查得到、不漏」，实验室负责「看得懂、记得住」，
 *   手册里的每条公式都挂着它对应的考点，点进去就是知识点详情。
 */

type ModuleId = 'secant' | 'riemann' | 'taylor' | 'epsilon';

const MODULES: {
  id: ModuleId; name: string; hook: string; formula: string; conclusion: string;
}[] = [
  {
    id: 'secant',
    name: '割线 → 切线',
    hook: '开车时仪表盘上的「瞬时速度」，其实是把一段很短的平均速度无限缩短得到的。',
    formula: "f'(a)=\\lim_{h\\to 0}\\frac{f(a+h)-f(a)}{h}",
    conclusion: '让 h 趋近于 0，割线就变成了切线 —— 这就是导数的几何意义。',
  },
  {
    id: 'riemann',
    name: '黎曼和逼近面积',
    hook: '不规则的地块怎么量面积？切成很多细长条，一条条加起来。',
    formula: '\\int_a^b f(x)\\,dx=\\lim_{n\\to\\infty}\\sum_{i=1}^{n} f(\\xi_i)\\Delta x',
    conclusion: '切得越细，矩形面积和越接近真实面积。n 取极限，和就变成了积分。',
  },
  {
    id: 'taylor',
    name: '泰勒展开的局部有效性',
    hook: '再复杂的曲线，在一点附近都能用多项式「假装」得很好 —— 但只在附近。',
    formula: 'f(x)=\\sum_{n=0}^{\\infty}\\frac{f^{(n)}(a)}{n!}(x-a)^n',
    conclusion: '项数越多、离展开点越近，逼近越准；一旦走远，多项式就管不住了。',
  },
  {
    id: 'epsilon',
    name: 'ε-N 语言的直觉',
    hook: '「无限接近」是句文学描述，数学需要把它变成一个能验算的陈述。',
    formula: '\\forall\\varepsilon>0,\\ \\exists N,\\ n>N \\Rightarrow |a_n-A|<\\varepsilon',
    conclusion: '你随便给多小的 ε，我都能找到一个 N；过了 N 之后所有项都落进那条带子里。',
  },
];

export default function Lab() {
  const [tab, setTab] = useState<'play' | 'handbook'>('play');

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-violet/25 bg-violet/10 text-violet">
              <FlaskConical size={18} />
            </div>
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-fg">公式实验室</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-mute">
                {tab === 'play'
                  ? '拖动滑块，看公式怎么「动」起来 —— 四个模块都是可交互的'
                  : '按考纲整理的公式库 —— 每条都带成立条件与易错点'}
              </p>
            </div>
          </div>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'play', label: <span className="flex items-center gap-1.5"><Move3d size={12} /> 交互演示</span> },
              { value: 'handbook', label: <span className="flex items-center gap-1.5"><BookOpen size={12} /> 公式手册</span> },
            ]}
          />
        </div>
      </Panel>

      {tab === 'play' ? <Playground /> : <Handbook />}
    </div>
  );
}

/* ============================================================
   ① 交互演示
   ============================================================ */
function Playground() {
  const [mod, setMod] = useState<ModuleId>('secant');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 各模块的参数
  const [a, setA] = useState(1);
  const [h, setH] = useState(1.2);
  const [n, setN] = useState(4);
  const [terms, setTerms] = useState(1);
  const [eps, setEps] = useState(0.25);

  const meta = MODULES.find((m) => m.id === mod)!;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let raf = 0;
    let cleanup: (() => void) | undefined;

    const setup = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = rect.width;
      const H = Math.max(300, Math.min(420, rect.width * 0.55));
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.height = `${H}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, W, H);
    };

    const draw = (ctx: CanvasRenderingContext2D, W: number, H: number) => {
      ctx.clearRect(0, 0, W, H);
      switch (mod) {
        case 'secant': return drawSecant(ctx, W, H, a, h);
        case 'riemann': return drawRiemann(ctx, W, H, n);
        case 'taylor': return drawTaylor(ctx, W, H, terms);
        case 'epsilon': return drawEpsilon(ctx, W, H, eps);
      }
    };

    setup();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(setup);
    });
    ro.observe(wrap);
    cleanup = () => ro.disconnect();

    return () => { cancelAnimationFrame(raf); cleanup?.(); };
  }, [mod, a, h, n, terms, eps]);

  return (
    <div className="space-y-5">
      {/* 标题在 Lab() 那层统一渲染 —— 这里只放「选哪个模块」。
          两处都写标题的话，切到手册再切回来会看到两个 h1。 */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            value={mod}
            onChange={setMod}
            options={MODULES.map((m) => ({ value: m.id, label: m.name }))}
          />
          <Badge tone="violet"><Move3d size={10} /> 可拖动</Badge>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
        {/* 画布 */}
        <Panel className="relative overflow-hidden p-4">
          <div className="pointer-events-none absolute -left-16 -top-16 h-48 w-48 rounded-full bg-cyan/8 blur-[80px]" />
          <div ref={wrapRef} className="relative">
            <canvas ref={canvasRef} className="w-full rounded-xl" aria-label={`${meta.name} 交互演示`} />
          </div>
        </Panel>

        {/* 控制 */}
        <div className="space-y-4">
          <Panel className="p-5">
            <SectionTitle title={meta.name} className="mb-3" />
            <div className="mb-4 text-[12.5px] leading-relaxed text-fg-soft">
              <span className="text-fg-mute">场景 · </span>{meta.hook}
            </div>

            <div className="rounded-xl border border-veil/8 bg-veil/3 px-3.5 py-3 text-center">
              <InlineMath text={`$$${meta.formula}$$`} />
            </div>

            <div className="mt-5 space-y-4">
              {mod === 'secant' && (
                <>
                  <Slider label="切点 a" value={a} min={-2} max={2.4} step={0.05} onChange={setA} fmt={(v) => v.toFixed(2)} />
                  <Slider label="增量 h" value={h} min={0.02} max={3} step={0.02} onChange={setH} fmt={(v) => v.toFixed(2)} />
                  <div className="rounded-lg border border-cyan/22 bg-cyan/6 px-3 py-2.5 text-[12px] text-cyan-100">
                    当前割线斜率 = <span className="font-mono">{((((a + h) ** 2 - a ** 2) / h) || 0).toFixed(3)}</span>
                    <span className="ml-2 text-fg-mute">（h→0 时收敛到 {2 * a < 0 ? '-' : ''}{Math.abs(2 * a).toFixed(2)}，即 f'(a)=2a）</span>
                  </div>
                </>
              )}

              {mod === 'riemann' && (
                <>
                  <Slider label="分割数 n" value={n} min={1} max={60} step={1} onChange={setN} fmt={(v) => String(v)} />
                  <div className="rounded-lg border border-cyan/22 bg-cyan/6 px-3 py-2.5 text-[12px] text-cyan-100">
                    矩形面积和 ≈ <span className="font-mono">{riemannSum(n).toFixed(4)}</span>
                    <span className="ml-2 text-fg-mute">（精确值 ∫₀² x² dx = {((2 ** 3) / 3).toFixed(4)}）</span>
                  </div>
                </>
              )}

              {mod === 'taylor' && (
                <>
                  <Slider label="展开项数 n" value={terms} min={0} max={7} step={1} onChange={setTerms} fmt={(v) => `${v} 项`} />
                  <div className="rounded-lg border border-cyan/22 bg-cyan/6 px-3 py-2.5 text-[12px] leading-relaxed text-cyan-100">
                    橙色是 sin x 的 {terms} 项泰勒多项式。
                    <span className="text-fg-mute"> 项数越多，贴合的范围越宽；但无论多少项，远处都会跑飞。</span>
                  </div>
                </>
              )}

              {mod === 'epsilon' && (
                <>
                  <Slider label="ε" value={eps} min={0.02} max={0.5} step={0.01} onChange={setEps} fmt={(v) => v.toFixed(2)} />
                  <div className="rounded-lg border border-cyan/22 bg-cyan/6 px-3 py-2.5 text-[12px] text-cyan-100">
                    当 ε = {eps.toFixed(2)} 时，需要 N = <span className="font-mono">{Math.ceil(1 / eps) + 1}</span>
                    <span className="ml-2 text-fg-mute">（aₙ = 1 + 1/n，n &gt; N 后全部落进 A±ε）</span>
                  </div>
                </>
              )}
            </div>
          </Panel>

          <Panel className="p-4">
            <div className="flex items-start gap-2.5">
              <Info size={14} className="mt-0.5 shrink-0 text-cyan" />
              <p className="text-[12.5px] leading-relaxed text-fg-soft">
                <span className="text-fg-mute">一句话 · </span>{meta.conclusion}
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ---------- 滑块 ---------- */
function Slider({
  label, value, min, max, step, onChange, fmt,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; fmt: (v: number) => string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[12px]">
        <span className="text-fg-soft">{label}</span>
        <span className="font-mono text-cyan tabular">{fmt(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-veil/10 outline-none
          [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan
          slider-glow
          [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-115
          [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-cyan"
      />
    </div>
  );
}

/* ---------- 画布配色 ----------
 *
 * 一律从主题令牌取，**绘制时**求值（写成函数而不是常量 —— 常量会在
 * import 那一刻冻结，切主题不更新）。
 *
 * 原来这里全是写死的值，两个后果：
 *   1. 标签用 rgba(255,255,255,0.5) —— 亮色主题下白字压白底，**直接看不见**。
 *      而它承载的是「n = 4」「近似有效区间」「A = 1」这种关键信息。
 *   2. 曲线用 #22d3ee / #c084fc 这类浅色 —— 白底上对比度只有 2:1 左右。
 *
 * ⚠️ 透明度走 canvasColor()（内部拼 rgba），不用 lib/utils 的 withAlpha ——
 *   后者产出 color-mix()，canvas 支持得晚且**静默失效**。
 */
const C = {
  cyan: (a = 1) => canvasColor('--color-cyan', a, '#22d3ee'),
  violet: (a = 1) => canvasColor('--color-violet', a, '#a855f7'),
  emerald: (a = 1) => canvasColor('--color-emerald', a, '#34d399'),
  amber: (a = 1) => canvasColor('--color-amber', a, '#fbbf24'),
  rose: (a = 1) => canvasColor('--color-rose', a, '#fb7185'),
  /* 画布上的说明文字。原来是白色 50% —— 亮色下等于没画。 */
  text: (a = 0.75) => canvasColor('--color-fg-soft', a, '#a8b0c6'),
};

/* ---------- 绘图工具 ---------- */
function makeMapper(W: number, H: number, xr: [number, number], yr: [number, number]) {
  const pad = 26;
  const [x0, x1] = xr;
  const [y0, y1] = yr;
  return {
    X: (x: number) => pad + ((x - x0) / (x1 - x0)) * (W - pad * 2),
    Y: (y: number) => H - pad - ((y - y0) / (y1 - y0)) * (H - pad * 2),
    xr, yr, W, H, pad,
  };
}

function grid(ctx: CanvasRenderingContext2D, m: ReturnType<typeof makeMapper>) {
  const { X, Y, xr, yr, W, H, pad } = m;
  ctx.save();
  /* 画布只吃具体颜色字符串，塞不进 Tailwind 类名 —— 所以在这里读令牌。
   * 写死白色的话，亮色主题下网格线是白压白，整片消失（曲线还悬在空中）。 */
  ctx.strokeStyle = cssVar('--mesh-line', C.text(0.055));
  ctx.lineWidth = 1;
  for (let x = Math.ceil(xr[0]); x <= xr[1]; x++) {
    ctx.beginPath(); ctx.moveTo(X(x), pad); ctx.lineTo(X(x), H - pad); ctx.stroke();
  }
  for (let y = Math.ceil(yr[0]); y <= yr[1]; y++) {
    ctx.beginPath(); ctx.moveTo(pad, Y(y)); ctx.lineTo(W - pad, Y(y)); ctx.stroke();
  }
  // 坐标轴
  ctx.strokeStyle = cssVar('--color-hairline-strong', C.text(0.2));
  ctx.lineWidth = 1.2;
  if (yr[0] <= 0 && yr[1] >= 0) {
    ctx.beginPath(); ctx.moveTo(pad, Y(0)); ctx.lineTo(W - pad, Y(0)); ctx.stroke();
  }
  if (xr[0] <= 0 && xr[1] >= 0) {
    ctx.beginPath(); ctx.moveTo(X(0), pad); ctx.lineTo(X(0), H - pad); ctx.stroke();
  }
  ctx.restore();
}

function curve(ctx: CanvasRenderingContext2D, m: ReturnType<typeof makeMapper>, f: (x: number) => number, color: string, width = 2.4, glow = true) {
  const { X, Y, xr, W } = m;
  ctx.save();
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 12; }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const steps = Math.max(120, Math.floor(W));
  for (let i = 0; i <= steps; i++) {
    const x = xr[0] + (i / steps) * (xr[1] - xr[0]);
    const y = f(x);
    if (!Number.isFinite(y)) continue;
    if (i === 0) ctx.moveTo(X(x), Y(y));
    else ctx.lineTo(X(x), Y(y));
  }
  ctx.stroke();
  ctx.restore();
}

function dot(ctx: CanvasRenderingContext2D, m: ReturnType<typeof makeMapper>, x: number, y: number, color: string, r = 4.5) {
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 14;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(m.X(x), m.Y(y), r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, m: ReturnType<typeof makeMapper>, x: number, y: number, text: string, color?: string) {
  ctx.save();
  /* 默认色在函数体内解析 —— 写在参数默认值里会冻结在模块加载那一刻 */
  ctx.fillStyle = color ?? C.text(0.9);
  ctx.font = '11px "PingFang SC", system-ui, sans-serif';
  ctx.fillText(text, m.X(x) + 7, m.Y(y) - 7);
  ctx.restore();
}

/* ---------- 1. 割线 → 切线 ---------- */
function drawSecant(ctx: CanvasRenderingContext2D, W: number, H: number, a: number, h: number) {
  const m = makeMapper(W, H, [-3, 3.6], [-1.4, 9]);
  const f = (x: number) => x * x;
  grid(ctx, m);
  curve(ctx, m, f, C.violet());

  const a2 = a + h;
  const slope = (f(a2) - f(a)) / (a2 - a);
  const secLine = (x: number) => f(a) + slope * (x - a);
  const tanLine = (x: number) => f(a) + 2 * a * (x - a);

  // 切线（参考）
  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = C.emerald(0.55);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(m.X(m.xr[0]), m.Y(tanLine(m.xr[0])));
  ctx.lineTo(m.X(m.xr[1]), m.Y(tanLine(m.xr[1])));
  ctx.stroke();
  ctx.restore();

  // 割线
  ctx.save();
  ctx.strokeStyle = C.cyan();
  ctx.shadowColor = C.cyan();
  ctx.shadowBlur = 10;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(m.X(m.xr[0]), m.Y(secLine(m.xr[0])));
  ctx.lineTo(m.X(m.xr[1]), m.Y(secLine(m.xr[1])));
  ctx.stroke();
  ctx.restore();

  // 增量三角形
  ctx.save();
  ctx.strokeStyle = C.amber(0.75);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(m.X(a), m.Y(f(a)));
  ctx.lineTo(m.X(a2), m.Y(f(a)));
  ctx.lineTo(m.X(a2), m.Y(f(a2)));
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.fillStyle = C.amber(0.95);
  ctx.font = '11px "PingFang SC", system-ui';
  ctx.fillText('h', (m.X(a) + m.X(a2)) / 2 - 3, m.Y(f(a)) + 14);
  ctx.fillText('Δy', m.X(a2) + 5, (m.Y(f(a)) + m.Y(f(a2))) / 2);
  ctx.restore();

  dot(ctx, m, a, f(a), C.emerald());
  dot(ctx, m, a2, f(a2), C.cyan());
  label(ctx, m, a, f(a), `A(${a.toFixed(1)}, ${f(a).toFixed(1)})`, C.emerald());
  label(ctx, m, a2, f(a2), `B`, C.cyan());
  label(ctx, m, -2.8, 8.2, 'f(x) = x²', C.violet(0.85));
}

/* ---------- 2. 黎曼和 ---------- */
function riemannSum(n: number, a = 0, b = 2) {
  const dx = (b - a) / n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = a + i * dx + dx / 2;   // 中点法
    s += x * x * dx;
  }
  return s;
}

function drawRiemann(ctx: CanvasRenderingContext2D, W: number, H: number, n: number) {
  const m = makeMapper(W, H, [-0.5, 2.7], [-0.8, 4.8]);
  const f = (x: number) => x * x;
  const a = 0;
  const b = 2;
  const dx = (b - a) / n;

  grid(ctx, m);

  // 矩形
  for (let i = 0; i < n; i++) {
    const x0 = a + i * dx;
    const xm = x0 + dx / 2;
    const yTop = f(xm);
    const x1 = m.X(x0);
    const x2 = m.X(x0 + dx);
    const y0 = m.Y(0);
    const y1 = m.Y(yTop);

    const grad = ctx.createLinearGradient(0, y1, 0, y0);
    grad.addColorStop(0, C.cyan(0.42));
    grad.addColorStop(1, C.cyan(0.06));
    ctx.fillStyle = grad;
    ctx.fillRect(x1, y1, Math.max(0.8, x2 - x1), y0 - y1);
    if (n <= 24) {
      ctx.strokeStyle = C.cyan(0.7);
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, y1, Math.max(0.8, x2 - x1), y0 - y1);
    }
  }

  curve(ctx, m, f, C.violet(), 2.6);

  ctx.save();
  ctx.fillStyle = C.text(0.5);
  ctx.font = '11px "PingFang SC", system-ui';
  ctx.fillText(`n = ${n}`, m.X(-0.35), m.Y(4.4));
  ctx.restore();
  label(ctx, m, 1.05, 4.2, 'y = x²', C.violet(0.85));
}

/* ---------- 3. 泰勒展开 ---------- */
function taylorSin(x: number, terms: number) {
  // sin x 在 0 处：x - x³/3! + x⁵/5! - ...
  let sum = 0;
  for (let k = 0; k <= terms; k++) {
    const sign = k % 2 === 0 ? 1 : -1;
    const p = 2 * k + 1;
    sum += sign * Math.pow(x, p) / factorial(p);
  }
  return sum;
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function drawTaylor(ctx: CanvasRenderingContext2D, W: number, H: number, terms: number) {
  const m = makeMapper(W, H, [-8, 8], [-3.2, 3.2]);
  grid(ctx, m);

  // 真实 sin
  curve(ctx, m, Math.sin, C.cyan(), 2.4);

  // 泰勒多项式
  curve(ctx, m, (x) => taylorSin(x, terms), C.amber(), 2.4);

  // 展开点
  dot(ctx, m, 0, 0, C.emerald(), 4);

  // 有效范围提示
  const bound = Math.min(7.5, 2.2 + terms * 1.15);
  ctx.save();
  ctx.fillStyle = C.emerald(0.08);
  ctx.fillRect(m.X(-bound), m.Y(3.2), m.X(bound) - m.X(-bound), m.Y(-3.2) - m.Y(3.2));
  ctx.strokeStyle = C.emerald(0.35);
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(m.X(-bound), m.Y(3.2)); ctx.lineTo(m.X(-bound), m.Y(-3.2));
  ctx.moveTo(m.X(bound), m.Y(3.2)); ctx.lineTo(m.X(bound), m.Y(-3.2));
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = C.text(0.5);
  ctx.font = '11px "PingFang SC", system-ui';
  ctx.fillText('近似有效区间', m.X(-bound) + 6, m.Y(3.2) + 15);
  ctx.restore();

  label(ctx, m, -7.6, 2.9, 'sin x', C.cyan());
  label(ctx, m, -7.6, 2.3, `泰勒 ${terms} 项`, C.amber());
}

/* ---------- 4. ε-N ---------- */
function drawEpsilon(ctx: CanvasRenderingContext2D, W: number, H: number, eps: number) {
  const m = makeMapper(W, H, [-1, 22], [0.7, 2.3]);
  const a = 1;
  grid(ctx, m);

  const N = Math.ceil(1 / eps) + 1;

  // ε 带
  ctx.save();
  ctx.fillStyle = C.cyan(0.10);
  ctx.fillRect(m.X(m.xr[0]), m.Y(a + eps), m.X(m.xr[1]) - m.X(m.xr[0]), m.Y(a - eps) - m.Y(a + eps));
  ctx.strokeStyle = C.cyan(0.5);
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(m.X(m.xr[0]), m.Y(a + eps)); ctx.lineTo(m.X(m.xr[1]), m.Y(a + eps));
  ctx.moveTo(m.X(m.xr[0]), m.Y(a - eps)); ctx.lineTo(m.X(m.xr[1]), m.Y(a - eps));
  ctx.stroke();
  ctx.restore();

  // 极限线
  ctx.save();
  ctx.strokeStyle = C.emerald(0.8);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(m.X(m.xr[0]), m.Y(a)); ctx.lineTo(m.X(m.xr[1]), m.Y(a));
  ctx.stroke();
  ctx.restore();

  // N 竖线
  ctx.save();
  ctx.strokeStyle = C.amber(0.75);
  ctx.lineWidth = 1.6;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(m.X(N), m.Y(m.yr[0])); ctx.lineTo(m.X(N), m.Y(m.yr[1]));
  ctx.stroke();
  ctx.restore();

  // 数列点
  for (let i = 1; i <= 21; i++) {
    const y = 1 + 1 / i;
    const inside = i > N;
    dot(ctx, m, i, y, inside ? C.cyan() : C.rose(), 3.4);
  }

  ctx.save();
  ctx.fillStyle = C.text(0.55);
  ctx.font = '11px "PingFang SC", system-ui';
  ctx.fillText(`A = 1`, m.X(0.2), m.Y(a) - 6);
  ctx.fillText(`A + ε`, m.X(0.2), m.Y(a + eps) - 6);
  ctx.fillText(`A − ε`, m.X(0.2), m.Y(a - eps) + 15);
  ctx.fillStyle = C.amber(0.9);
  ctx.fillText(`n = N = ${N}`, m.X(N) + 5, m.Y(m.yr[1]) + 14);
  ctx.restore();
}

/* ============================================================
   ② 公式手册
   ============================================================
   257 条、19 章、67 个考点。设计上只有三件事：
     1. 查得到 —— 搜索同时匹配中文名、LaTeX 符号、条件、备注；
     2. 不漏 —— 每章都能整章展开，章头写着条数和必背数；
     3. 能对上号 —— 每条都挂着它对应的考点，点进去就是知识点详情。
   外加一个「只看必背」——考前一天真正会翻的是那个视图，不是全部 257 条。
   ============================================================ */
function Handbook() {
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');
  const [mustOnly, setMustOnly] = useState(false);
  /** 章节的展开状态。**没记过**的章节走默认（第一章展开）—— 用一个「只记显式操作」的表，
   *  而不是把 19 个默认值都初始化一遍（那样加章节就得同步改这里）。 */
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  /* 防抖 260ms。每打一个字就打一次接口，既浪费也让列表一直跳 ——
   * 输入框和「真正用于查询的值」必须分开，不然打「洛必达」会触发三次查询。 */
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim()), 260);
    return () => clearTimeout(t);
  }, [raw]);

  const data = useAsync(
    () => api.catalog.formulas({ q, must: mustOnly ? '1' : '' }),
    [q, mustOnly],
    /* key 把筛选条件带上 —— 来回切「只看必背」时结果是现成的。
     * 5 分钟新鲜期：公式库是静态内容，不跟着用户操作变。 */
    { key: `formulas:${q}|${mustOnly ? 1 : 0}`, staleTime: 5 * 60_000 },
  );

  const items = data.data?.items || [];
  const searching = q.length > 0;

  /* 按章节切连续段。服务端已经排好序（章节顺序 → 章内 sort_order），
   * 这里只切不排 —— 再排一次就可能和服务端的口径不一致。 */
  const sections = useMemo(() => {
    const out: { chapterId: string; chapterName: string; categoryName: string; items: Formula[] }[] = [];
    for (const f of items) {
      const last = out[out.length - 1];
      if (last && last.chapterId === f.chapterId) last.items.push(f);
      else out.push({ chapterId: f.chapterId, chapterName: f.chapterName, categoryName: f.categoryName, items: [f] });
    }
    return out;
  }, [items]);

  const isOpen = (id: string, idx: number) => {
    /* 搜索时全部展开 —— 搜完还要一个个点开，等于没搜。 */
    if (searching) return true;
    const v = closed[id];
    return v === undefined ? idx === 0 : !v;
  };
  const allClosed = sections.length > 0 && sections.every((s, i) => !isOpen(s.chapterId, i));

  const loading = data.loading && !data.data;

  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-faint" />
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              aria-label="搜索公式"
              placeholder="搜公式名或符号 ——「等价无穷小」「洛必达」「sin x」「AC-B²」"
              className="h-10 w-full rounded-xl border border-hairline bg-veil/4 pl-10 pr-3.5 text-[13.5px] text-fg outline-none transition-all placeholder:text-fg-faint focus:border-cyan/45 focus:bg-veil/6"
            />
          </div>
          <button
            onClick={() => setMustOnly((v) => !v)}
            aria-pressed={mustOnly}
            className={cn(
              'flex h-10 items-center gap-1.5 rounded-xl border px-3 text-[12.5px] transition-colors',
              mustOnly
                ? 'border-amber/45 bg-amber/12 text-amber-100'
                : 'border-hairline bg-veil/4 text-fg-mute hover:text-fg-soft',
            )}
          >
            <Star size={12} /> 只看必背
          </button>
          <button
            onClick={() => setClosed(allClosed ? {} : Object.fromEntries(sections.map((s) => [s.chapterId, true])))}
            className="h-10 rounded-xl border border-hairline bg-veil/4 px-3 text-[12.5px] text-fg-mute transition-colors hover:text-fg-soft"
          >
            {allClosed ? '展开全部' : '收起全部'}
          </button>
        </div>

        <p className="mt-2.5 text-[11.5px] text-fg-faint">
          {data.data
            ? `库里共 ${data.data.total} 条 · 覆盖 ${data.data.coveredKids} 个考点 · ${data.data.chapters} 章`
              + (searching || mustOnly ? ` · 当前筛选出 ${data.data.count} 条` : '')
            : '加载中…'}
        </p>
      </Panel>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-2xl" />)}
        </div>
      ) : !sections.length ? (
        <Panel>
          <div className="px-6 py-12 text-center">
            <p className="text-[14px] text-fg-soft">没有匹配的公式</p>
            <p className="mt-1.5 text-[12.5px] text-fg-mute">
              {mustOnly ? '试试关掉「只看必背」—— 有些条目是了解级的。' : '换个词试试，或者只打符号的一半（如「arctan」）。'}
            </p>
          </div>
        </Panel>
      ) : (
        sections.map((s, idx) => {
          const open = isOpen(s.chapterId, idx);
          const mustN = s.items.filter((x) => x.must).length;
          return (
            <Panel key={s.chapterId} className="overflow-hidden p-0">
              <button
                onClick={() => setClosed((m) => ({ ...m, [s.chapterId]: open }))}
                aria-expanded={open}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-veil/4"
              >
                <ChevronDown
                  size={15}
                  className={cn('shrink-0 text-fg-faint transition-transform duration-200', open && 'rotate-180')}
                />
                <span className="shrink-0 rounded border border-veil/10 bg-veil/5 px-1.5 py-[1px] text-[10.5px] text-fg-faint">
                  {s.categoryName}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg-soft">{s.chapterName}</span>
                <span className="shrink-0 text-[11.5px] tabular text-fg-faint">
                  {s.items.length} 条{mustN > 0 ? ` · 必背 ${mustN}` : ''}
                </span>
              </button>

              {open && (
                <div className="border-t border-hairline">
                  {groupRuns(s.items).map((g) => (
                    <div key={g.name}>
                      <div className="flex items-center gap-2 bg-veil/3 px-4 py-1.5">
                        <span className="text-[11px] font-medium tracking-wide text-cyan/80">{g.name}</span>
                        <span className="h-px flex-1 bg-hairline" />
                        <span className="text-[10.5px] tabular text-fg-faint">{g.items.length}</span>
                      </div>
                      <div className="divide-y divide-veil/5">
                        {g.items.map((f) => <FormulaCard key={f.id} f={f} />)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          );
        })
      )}
    </div>
  );
}

/** 章内按 group 再切一次连续段 —— 一张「表」一个标题 */
function groupRuns(items: Formula[]) {
  const out: { name: string; items: Formula[] }[] = [];
  for (const f of items) {
    const last = out[out.length - 1];
    if (last && last.name === f.group) last.items.push(f);
    else out.push({ name: f.group, items: [f] });
  }
  return out;
}

function FormulaCard({ f }: { f: Formula }) {
  const ms = f.mastery ? MASTERY_STYLE[f.mastery] : null;
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {f.must === 1 && (
          <span className="flex shrink-0 items-center gap-1 rounded border border-amber/35 bg-amber/10 px-1.5 py-[1px] text-[10px] text-amber-200/95">
            <Star size={9} /> 必背
          </span>
        )}
        <span className="text-[12.5px] font-medium text-fg-soft">{f.name}</span>
        <span className="flex-1" />
        {/* 挂回考点。掌握状态的小圆点用的是和知识树同一套色，
            这样「这条公式我学没学过」不用点进去就知道。 */}
        {f.kid && (
          <Link
            to={`/learn/${f.kid}`}
            className="group flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-veil/4 px-2 py-[3px] text-[11px] text-fg-mute transition-colors hover:border-cyan/35 hover:text-fg-soft"
          >
            {ms && <span className={cn('h-1.5 w-1.5 rounded-full', ms.dot)} />}
            <span className="max-w-[160px] truncate">{f.kidTitle}</span>
            <ArrowUpRight size={10} className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-veil/8 bg-veil/3 px-3.5 py-2.5 text-center">
        <InlineMath text={`$$${f.tex}$$`} />
      </div>

      {(f.cond || f.note) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
          {f.cond && (
            <span className="text-[11.5px] leading-relaxed text-fg-mute">
              条件 <InlineMath text={`$${f.cond}$`} className="text-amber-200/90" />
            </span>
          )}
          {f.note && (
            <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-fg-faint">{f.note}</span>
          )}
        </div>
      )}
    </div>
  );
}

export { motion, RichText, cn };
