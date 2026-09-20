/* 公式演示引擎 · 通用绘图层
 *
 * ── 为什么要有这一层 ──────────────────────────────────────────────
 * 需求是「257 条公式，每条都要有交互演示」。上一版是 4 个手写 canvas
 * （割线、黎曼和、泰勒、ε-N），每写一个就要重来一遍网格、坐标轴、曲线、
 * 标注 —— 按这个成本，257 条得写 257 遍。
 *
 * 所以把「画什么」和「怎么画」拆开：
 *   · 这一层只管**怎么画**（坐标映射、网格、曲线、填充、等高线、箭头…）
 *   · kinds.ts 里每个演示只管**画什么**，输出一个 Scene 数据结构
 * 结果是绝大多数演示退化成 10~25 行的声明式代码，而不是 60 行绘图指令。
 *
 * ── 三条硬约束 ────────────────────────────────────────────────────
 *  1. **颜色一律从 Palette 取，不在这一层写死。** canvas 只吃具体颜色字符串，
 *     塞不进 Tailwind 类名，所以颜色必须由调用方按当前主题算好传进来。
 *     写死的结果是亮色主题下白字压白底 —— 标注直接看不见，而它承载的
 *     往往是「n = 4」「近似有效区间」这种关键信息。
 *  2. **透明色由 Palette 内部拼 rgba，不用 CSS 的 color-mix()。**
 *     canvas 对 color-mix 支持得晚，而且不支持时是**静默失效**（画出来是透明）。
 *  3. **所有取值函数都接收 params。** 曲线是 (x, p) => y 而不是 (x) => y，
 *     这样同一份 Scene 定义能在滑块变化时直接重算，不用重建闭包。
 *
 * ── 这一层是纯函数、不碰 DOM 之外的东西 ────────────────────────────
 * 除了 ctx 上的绘制调用，没有任何副作用。所以 tests/formula-demos.mjs
 * 能在 Node 里把 scene() 求值一遍、扫一遍参数空间，验证「演示不是空壳、
 * 也不会算出 NaN」—— 不需要真浏览器。
 */

export type Params = Record<string, number>;

/** 画布配色。由调用方按当前主题构造（见 FormulaDemo.tsx）。 */
export interface Palette {
  cyan: (a?: number) => string;
  violet: (a?: number) => string;
  emerald: (a?: number) => string;
  amber: (a?: number) => string;
  rose: (a?: number) => string;
  blue: (a?: number) => string;
  /** 画布上的说明文字。默认色不能写死在参数默认值里 —— 那会冻结在模块加载那一刻 */
  text: (a?: number) => string;
  /** 网格线 */
  mesh: string;
  /** 坐标轴 */
  axis: string;
}

export interface View { x: [number, number]; y: [number, number] }

/* ---------- Scene 的各种元素 ---------- */

export interface CurveSpec {
  f: (x: number, p: Params) => number;
  color: string;
  width?: number;
  dash?: number[];
  glow?: boolean;
  /** 画在曲线起点附近的标签（坐标由采样自动取，不用手算） */
  label?: string;
}

export interface FillSpec {
  /** 积分/面积区间。给函数是为了区间本身也跟着滑块动 */
  from: number | ((p: Params) => number);
  to: number | ((p: Params) => number);
  top: (x: number, p: Params) => number;
  bottom?: (x: number, p: Params) => number;
  color: string;
  alpha?: number;
}

export interface BarSpec {
  /** 柱心的 x 坐标 */
  at: (p: Params) => number[];
  /** 柱高（可为负） */
  h: (p: Params) => number[];
  w: number;
  color: string;
  alpha?: number;
  outline?: string;
}

export interface BandSpec {
  /** 水平带：y0..y1 之间铺一层色 */
  y0: number | ((p: Params) => number);
  y1: number | ((p: Params) => number);
  color: string;
  alpha?: number;
  dash?: number[];
}

export interface SegSpec {
  x1: number | ((p: Params) => number);
  y1: number | ((p: Params) => number);
  x2: number | ((p: Params) => number);
  y2: number | ((p: Params) => number);
  color: string;
  width?: number;
  dash?: number[];
}

/** 竖直线（整屏高），常用于 N 线、分割线、收敛半径 */
export interface VLineSpec {
  x: number | ((p: Params) => number);
  color: string;
  dash?: number[];
  label?: string;
  /** 标签的纵向位置（数据坐标） */
  labelY?: number;
}

/** 水平线（整屏宽），常用于极限值、渐近线 */
export interface HLineSpec {
  y: number | ((p: Params) => number);
  color: string;
  dash?: number[];
  label?: string;
  /** 标签的横向位置（数据坐标） */
  labelX?: number;
}

export interface MarkerSpec {
  x: number | ((p: Params) => number);
  y: number | ((p: Params) => number);
  color: string;
  r?: number;
  label?: string;
  /** 空心圈 —— 用来区分「极限点」和「函数值」这类不能混的点 */
  hollow?: boolean;
}

export interface ArrowSpec {
  x: number | ((p: Params) => number);
  y: number | ((p: Params) => number);
  dx: number | ((p: Params) => number);
  dy: number | ((p: Params) => number);
  color: string;
  width?: number;
}

export interface TextSpec {
  x: number;
  y: number;
  text: string | ((p: Params) => string);
  color?: string;
  align?: 'left' | 'center' | 'right';
  size?: number;
}

/** 热力图：用来画 z=f(x,y) 的曲面投影、联合分布密度 */
export interface HeatSpec {
  f: (x: number, y: number, p: Params) => number;
  x: [number, number];
  y: [number, number];
  /** 采样格数（每边的格数，总格数 = cells^2） */
  cells?: number;
  color: (t: number, a?: number) => string;
  /** 是否按最大值归一化（默认 true） */
  normalize?: boolean;
}

/** 等高线：用「逐行 + 逐列找穿越点」的方式画，够用且实现短 */
export interface ContourSpec {
  f: (x: number, y: number, p: Params) => number;
  x: [number, number];
  y: [number, number];
  levels: number[];
  color: string;
  /** 采样密度（每边点数） */
  samples?: number;
}

export interface Scene {
  heat?: HeatSpec;
  contours?: ContourSpec;
  bands?: BandSpec[];
  fills?: FillSpec[];
  bars?: BarSpec[];
  curves?: CurveSpec[];
  segs?: SegSpec[];
  vlines?: VLineSpec[];
  hlines?: HLineSpec[];
  arrows?: ArrowSpec[];
  markers?: MarkerSpec[];
  texts?: TextSpec[];
  /** 默认画网格；热力图/等高线场景一般关掉 */
  grid?: boolean;
}

/* ============================================================
   坐标映射
   ============================================================ */
export interface Mapper {
  X: (x: number) => number;
  Y: (y: number) => number;
  view: View;
  W: number;
  H: number;
  pad: number;
}

export function makeMapper(W: number, H: number, view: View, pad = 26): Mapper {
  const [x0, x1] = view.x;
  const [y0, y1] = view.y;
  const dx = x1 - x0 || 1;
  const dy = y1 - y0 || 1;
  return {
    X: (x: number) => pad + ((x - x0) / dx) * (W - pad * 2),
    Y: (y: number) => H - pad - ((y - y0) / dy) * (H - pad * 2),
    view, W, H, pad,
  };
}

const num = (v: number | ((p: Params) => number), p: Params): number =>
  typeof v === 'function' ? (v as (p: Params) => number)(p) : v;

const finite = (v: number) => Number.isFinite(v);

/* ============================================================
   绘制
   ============================================================ */

function drawGrid(ctx: CanvasRenderingContext2D, m: Mapper, pal: Palette) {
  const { X, Y, view, W, H, pad } = m;
  ctx.save();
  ctx.strokeStyle = pal.mesh;
  ctx.lineWidth = 1;
  /* 网格步长跟着视野走：视野宽的时候每 1 格太密，按跨度自动取 1/2/5/10 */
  const span = view.x[1] - view.x[0];
  const step = span > 40 ? 10 : span > 16 ? 5 : span > 8 ? 2 : 1;
  for (let x = Math.ceil(view.x[0] / step) * step; x <= view.x[1]; x += step) {
    ctx.beginPath(); ctx.moveTo(X(x), pad); ctx.lineTo(X(x), H - pad); ctx.stroke();
  }
  const vspan = view.y[1] - view.y[0];
  const vstep = vspan > 40 ? 10 : vspan > 16 ? 5 : vspan > 8 ? 2 : 1;
  for (let y = Math.ceil(view.y[0] / vstep) * vstep; y <= view.y[1]; y += vstep) {
    ctx.beginPath(); ctx.moveTo(pad, Y(y)); ctx.lineTo(W - pad, Y(y)); ctx.stroke();
  }
  ctx.strokeStyle = pal.axis;
  ctx.lineWidth = 1.2;
  if (view.y[0] <= 0 && view.y[1] >= 0) {
    ctx.beginPath(); ctx.moveTo(pad, Y(0)); ctx.lineTo(W - pad, Y(0)); ctx.stroke();
  }
  if (view.x[0] <= 0 && view.x[1] >= 0) {
    ctx.beginPath(); ctx.moveTo(X(0), pad); ctx.lineTo(X(0), H - pad); ctx.stroke();
  }
  ctx.restore();
}

function drawHeat(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, spec: HeatSpec) {
  const cells = Math.max(8, Math.min(72, spec.cells ?? 36));
  const [x0, x1] = spec.x;
  const [y0, y1] = spec.y;
  /* 先扫一遍取极值：不归一化的话，量纲大的函数会整片糊成一个颜色 */
  let lo = Infinity;
  let hi = -Infinity;
  const buf: number[][] = [];
  for (let i = 0; i < cells; i++) {
    buf[i] = [];
    for (let j = 0; j < cells; j++) {
      const x = x0 + ((i + 0.5) / cells) * (x1 - x0);
      const y = y0 + ((j + 0.5) / cells) * (y1 - y0);
      const v = spec.f(x, y, p);
      buf[i][j] = v;
      if (finite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  if (!finite(lo) || !finite(hi)) return;
  const span = hi - lo || 1;
  const useNorm = spec.normalize !== false;
  const wpx = (m.W - m.pad * 2) / cells;
  const hpx = (m.H - m.pad * 2) / cells;
  ctx.save();
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const v = buf[i][j];
      if (!finite(v)) continue;
      const t = useNorm ? (v - lo) / span : v;
      ctx.fillStyle = spec.color(Math.max(0, Math.min(1, t)));
      /* 多画半像素，避免格子之间出现发丝缝 */
      ctx.fillRect(m.pad + i * wpx, m.H - m.pad - (j + 1) * hpx, wpx + 0.6, hpx + 0.6);
    }
  }
  ctx.restore();
}

function drawContours(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, spec: ContourSpec) {
  const n = Math.max(24, Math.min(160, spec.samples ?? 80));
  const [x0, x1] = spec.x;
  const [y0, y1] = spec.y;
  const grid: number[][] = [];
  for (let i = 0; i <= n; i++) {
    grid[i] = [];
    for (let j = 0; j <= n; j++) {
      grid[i][j] = spec.f(x0 + (i / n) * (x1 - x0), y0 + (j / n) * (y1 - y0), p);
    }
  }
  ctx.save();
  ctx.strokeStyle = spec.color;
  ctx.lineWidth = 1.4;
  for (const lv of spec.levels) {
    /* 沿 x 方向扫：相邻两点异号就线性插值出穿越点，连成小段。
     * 不做完整的 marching squares —— 对「看出等高线的形状」这个用途，
     * 横竖两遍扫描已经够了，而代码量只有十分之一。 */
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i < n; i++) {
        const a = grid[i][j] - lv;
        const b = grid[i + 1][j] - lv;
        if (!finite(a) || !finite(b) || a === 0 || b === 0 || a * b > 0) continue;
        const t = a / (a - b);
        const xa = x0 + ((i + t) / n) * (x1 - x0);
        const ya = y0 + (j / n) * (y1 - y0);
        const xb = x0 + ((i + 1 + t) / n) * (x1 - x0);
        ctx.beginPath();
        ctx.moveTo(m.X(xa), m.Y(ya));
        ctx.lineTo(m.X(xb), m.Y(ya));
        ctx.stroke();
      }
    }
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j < n; j++) {
        const a = grid[i][j] - lv;
        const b = grid[i][j + 1] - lv;
        if (!finite(a) || !finite(b) || a === 0 || b === 0 || a * b > 0) continue;
        const t = a / (a - b);
        const xa = x0 + (i / n) * (x1 - x0);
        const ya = y0 + ((j + t) / n) * (y1 - y0);
        const yb = y0 + ((j + 1 + t) / n) * (y1 - y0);
        ctx.beginPath();
        ctx.moveTo(m.X(xa), m.Y(ya));
        ctx.lineTo(m.X(xa), m.Y(yb));
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawBands(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, bands: BandSpec[]) {
  for (const b of bands) {
    const y0 = num(b.y0, p);
    const y1 = num(b.y1, p);
    if (!finite(y0) || !finite(y1)) continue;
    const top = m.Y(Math.max(y0, y1));
    const bot = m.Y(Math.min(y0, y1));
    ctx.save();
    ctx.fillStyle = b.color;
    ctx.globalAlpha = b.alpha ?? 0.1;
    ctx.fillRect(m.pad, top, m.W - m.pad * 2, Math.max(0.5, bot - top));
    ctx.globalAlpha = 1;
    if (b.dash) {
      ctx.setLineDash(b.dash);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(m.pad, top); ctx.lineTo(m.W - m.pad, top);
      ctx.moveTo(m.pad, bot); ctx.lineTo(m.W - m.pad, bot);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawFills(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, fills: FillSpec[]) {
  for (const f of fills) {
    const a = num(f.from, p);
    const b = num(f.to, p);
    if (!finite(a) || !finite(b) || a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    ctx.save();
    ctx.fillStyle = f.color;
    ctx.globalAlpha = f.alpha ?? 0.18;
    ctx.beginPath();
    const steps = Math.max(24, Math.floor(m.W / 2));
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const x = lo + (i / steps) * (hi - lo);
      const y = f.top(x, p);
      if (!finite(y)) continue;
      if (!started) { ctx.moveTo(m.X(x), m.Y(y)); started = true; }
      else ctx.lineTo(m.X(x), m.Y(y));
    }
    if (f.bottom) {
      for (let i = steps; i >= 0; i--) {
        const x = lo + (i / steps) * (hi - lo);
        const y = f.bottom(x, p);
        if (!finite(y)) continue;
        ctx.lineTo(m.X(x), m.Y(y));
      }
    } else {
      ctx.lineTo(m.X(hi), m.Y(0));
      ctx.lineTo(m.X(lo), m.Y(0));
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawBars(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, bars: BarSpec[]) {
  for (const b of bars) {
    const at = b.at(p);
    const h = b.h(p);
    ctx.save();
    ctx.fillStyle = b.color;
    ctx.globalAlpha = b.alpha ?? 0.85;
    for (let i = 0; i < at.length; i++) {
      const y = h[i];
      if (!finite(y) || !finite(at[i])) continue;
      const x1 = m.X(at[i] - b.w / 2);
      const x2 = m.X(at[i] + b.w / 2);
      const y0 = m.Y(0);
      const y1 = m.Y(y);
      const w = Math.max(1, x2 - x1);
      ctx.fillRect(x1, Math.min(y0, y1), w, Math.max(1, Math.abs(y1 - y0)));
    }
    ctx.globalAlpha = 1;
    if (b.outline) {
      ctx.strokeStyle = b.outline;
      ctx.lineWidth = 1;
      for (let i = 0; i < at.length; i++) {
        const y = h[i];
        if (!finite(y)) continue;
        const x1 = m.X(at[i] - b.w / 2);
        const x2 = m.X(at[i] + b.w / 2);
        const y0 = m.Y(0);
        const y1 = m.Y(y);
        ctx.strokeRect(x1, Math.min(y0, y1), Math.max(1, x2 - x1), Math.max(1, Math.abs(y1 - y0)));
      }
    }
    ctx.restore();
  }
}

function drawCurves(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, curves: CurveSpec[]) {
  const steps = Math.max(160, Math.floor(m.W));
  for (const c of curves) {
    ctx.save();
    if (c.glow !== false) { ctx.shadowColor = c.color; ctx.shadowBlur = 10; }
    ctx.strokeStyle = c.color;
    ctx.lineWidth = c.width ?? 2.4;
    ctx.lineJoin = 'round';
    if (c.dash) ctx.setLineDash(c.dash);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const x = m.view.x[0] + (i / steps) * (m.view.x[1] - m.view.x[0]);
      const y = c.f(x, p);
      if (!finite(y)) { started = false; continue; }
      /* 跳变（如 tan、1/x）处断开，否则会出现一条穿过整个画布的假竖线 */
      if (Math.abs(y) > (m.view.y[1] - m.view.y[0]) * 6) { started = false; continue; }
      if (!started) { ctx.moveTo(m.X(x), m.Y(y)); started = true; }
      else ctx.lineTo(m.X(x), m.Y(y));
    }
    ctx.stroke();
    if (c.label) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = c.color;
      ctx.font = '11px "PingFang SC", system-ui, sans-serif';
      ctx.fillText(c.label, m.pad + 6, m.pad + 13 + curves.indexOf(c) * 14);
    }
    ctx.restore();
  }
}

function drawSegs(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, segs: SegSpec[]) {
  for (const s of segs) {
    const x1 = num(s.x1, p); const y1 = num(s.y1, p);
    const x2 = num(s.x2, p); const y2 = num(s.y2, p);
    if (![x1, y1, x2, y2].every(finite)) continue;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 1.6;
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.beginPath();
    ctx.moveTo(m.X(x1), m.Y(y1));
    ctx.lineTo(m.X(x2), m.Y(y2));
    ctx.stroke();
    ctx.restore();
  }
}

function drawVLines(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, lines: VLineSpec[]) {
  for (const l of lines) {
    const x = num(l.x, p);
    if (!finite(x)) continue;
    ctx.save();
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 1.5;
    if (l.dash) ctx.setLineDash(l.dash);
    ctx.beginPath();
    ctx.moveTo(m.X(x), m.pad);
    ctx.lineTo(m.X(x), m.H - m.pad);
    ctx.stroke();
    if (l.label) {
      ctx.setLineDash([]);
      ctx.fillStyle = l.color;
      ctx.font = '11px "PingFang SC", system-ui, sans-serif';
      ctx.fillText(l.label, m.X(x) + 5, m.Y(l.labelY ?? m.view.y[1]) + 14);
    }
    ctx.restore();
  }
}

function drawHLines(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, lines: HLineSpec[]) {
  for (const l of lines) {
    const y = num(l.y, p);
    if (!finite(y)) continue;
    ctx.save();
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 1.6;
    if (l.dash) ctx.setLineDash(l.dash);
    ctx.beginPath();
    ctx.moveTo(m.pad, m.Y(y));
    ctx.lineTo(m.W - m.pad, m.Y(y));
    ctx.stroke();
    if (l.label) {
      ctx.setLineDash([]);
      ctx.fillStyle = l.color;
      ctx.font = '11px "PingFang SC", system-ui, sans-serif';
      ctx.fillText(l.label, m.X(l.labelX ?? m.view.x[0]) + 6, m.Y(y) - 5);
    }
    ctx.restore();
  }
}

function drawArrows(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, arrows: ArrowSpec[]) {
  for (const a of arrows) {
    const x = num(a.x, p); const y = num(a.y, p);
    const dx = num(a.dx, p); const dy = num(a.dy, p);
    if (![x, y, dx, dy].every(finite)) continue;
    const x1 = m.X(x); const y1 = m.Y(y);
    const x2 = m.X(x + dx); const y2 = m.Y(y + dy);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 3) continue;
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = a.width ?? 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.min(9, len * 0.35);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - 0.4), y2 - head * Math.sin(ang - 0.4));
    ctx.lineTo(x2 - head * Math.cos(ang + 0.4), y2 - head * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawMarkers(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, markers: MarkerSpec[]) {
  for (const k of markers) {
    const x = num(k.x, p); const y = num(k.y, p);
    if (!finite(x) || !finite(y)) continue;
    const r = k.r ?? 4.5;
    ctx.save();
    ctx.shadowColor = k.color;
    ctx.shadowBlur = 12;
    if (k.hollow) {
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(m.X(x), m.Y(y), r, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = k.color;
      ctx.beginPath();
      ctx.arc(m.X(x), m.Y(y), r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (k.label) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = k.color;
      ctx.font = '11px "PingFang SC", system-ui, sans-serif';
      ctx.fillText(k.label, m.X(x) + r + 3, m.Y(y) - r - 2);
    }
    ctx.restore();
  }
}

function drawTexts(ctx: CanvasRenderingContext2D, m: Mapper, p: Params, texts: TextSpec[], pal: Palette) {
  ctx.save();
  for (const t of texts) {
    const text = typeof t.text === 'function' ? t.text(p) : t.text;
    if (!text) continue;
    ctx.fillStyle = t.color ?? pal.text(0.9);
    ctx.font = `${t.size ?? 11}px "PingFang SC", system-ui, sans-serif`;
    ctx.textAlign = t.align ?? 'left';
    ctx.fillText(text, m.X(t.x), m.Y(t.y));
  }
  ctx.textAlign = 'left';
  ctx.restore();
}

/** 把整个 Scene 画到画布上。调用方负责清屏与 dpr 变换。 */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  view: View,
  scene: Scene,
  p: Params,
  pal: Palette,
) {
  const m = makeMapper(W, H, view);
  ctx.clearRect(0, 0, W, H);
  if (scene.grid !== false) drawGrid(ctx, m, pal);
  if (scene.heat) drawHeat(ctx, m, p, scene.heat);
  if (scene.contours) drawContours(ctx, m, p, scene.contours);
  if (scene.bands) drawBands(ctx, m, p, scene.bands);
  if (scene.fills) drawFills(ctx, m, p, scene.fills);
  if (scene.bars) drawBars(ctx, m, p, scene.bars);
  if (scene.segs) drawSegs(ctx, m, p, scene.segs);
  if (scene.vlines) drawVLines(ctx, m, p, scene.vlines);
  if (scene.hlines) drawHLines(ctx, m, p, scene.hlines);
  if (scene.curves) drawCurves(ctx, m, p, scene.curves);
  if (scene.arrows) drawArrows(ctx, m, p, scene.arrows);
  if (scene.markers) drawMarkers(ctx, m, p, scene.markers);
  if (scene.texts) drawTexts(ctx, m, p, scene.texts, pal);
}

/* ============================================================
   数值小工具（演示里到处要用，集中放一处）
   ============================================================ */

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function fact(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  return fact(n) / (fact(k) * fact(n - k));
}

/** 定积分的辛普森法。演示里到处要算「精确值」做对照，手写公式容易错。 */
export function integrate(f: (x: number) => number, a: number, b: number, n = 400): number {
  if (!finite(a) || !finite(b) || a === b) return 0;
  const m = n % 2 === 0 ? n : n + 1;
  const h = (b - a) / m;
  let s = f(a) + f(b);
  for (let i = 1; i < m; i++) {
    const v = f(a + i * h);
    if (!finite(v)) return NaN;
    s += v * (i % 2 === 0 ? 2 : 4);
  }
  return (s * h) / 3;
}

/** 数值求导（中心差分）。解析导数写不动的时候用它。 */
export function deriv(f: (x: number) => number, x: number, h = 1e-5): number {
  return (f(x + h) - f(x - h)) / (2 * h);
}

export function fmt(v: number, digits = 3): string {
  if (!finite(v)) return '—';
  if (Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-4)) return v.toExponential(2);
  const s = v.toFixed(digits);
  return s.replace(/\.?0+$/, '') || '0';
}
