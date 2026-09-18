import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { FlaskConical, Info, Move3d } from 'lucide-react';
import { Panel, SectionTitle, Segmented, Badge } from '@/components/ui/Primitives';
import { InlineMath, RichText } from '@/components/ui/Math';
import { cn, cssVar } from '@/lib/utils';
import { canvasColor } from '@/components/fx/theme-colors';

/* 公式实验室
 * 四个"可以拖"的数学模块。设计原则：
 *   1. 每个模块先给一个生活场景钩子，再给公式 —— 直觉先于符号；
 *   2. 拖动的效果必须"看得见地"趋向结论（割线真的变成切线，矩形真的填满面积）；
 *   3. 结论用一句大白话写在下面，不写成定理。
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
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-violet/25 bg-violet/10 text-violet">
              <FlaskConical size={18} />
            </div>
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-fg">公式实验室</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-mute">
                拖动滑块，看公式怎么"动"起来 —— 四个模块都是可交互的
              </p>
            </div>
          </div>
          <Badge tone="violet"><Move3d size={10} /> 可拖动</Badge>
        </div>

        <div className="mt-4">
          <Segmented
            value={mod}
            onChange={setMod}
            options={MODULES.map((m) => ({ value: m.id, label: m.name }))}
          />
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

export { motion, RichText, cn };
