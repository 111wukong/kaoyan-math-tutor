/* 公式演示引擎 · 线性代数
 *
 * 这一片的演示和前面不一样：没有「函数图像」可画，主角是**矩阵**。
 * 所以走 custom 渲染 —— 画矩阵、画向量、画行列式对应的平行四边形/平行六面体，
 * 数值结论（行列式、秩、特征值）走右侧读数。
 *
 * 交互设计上有一条贯穿始终的原则：**矩阵元素本身做成滑块**。
 * 拖 a₁₁ 看行列式怎么变，比看一行公式有用得多 —— 尤其是
 * 「行列式为 0 ⇔ 两列共线 ⇔ 平行四边形压扁成一条线」这件事，
 * 只有拖出来才真的相信。
 */
import { fmt, type Params, type Palette } from '../plot';
import { ctrl, mat, int, type DemoDef, type DemoRegistry } from '../types';

/* ============================================================
   小工具：2×2 / 3×3 的行列式与乘法
   ============================================================ */
const M2 = (p: Params, pre = 'a'): [number, number, number, number] =>
  [p[`${pre}11`], p[`${pre}12`], p[`${pre}21`], p[`${pre}22`]];

const det2 = (m: number[]) => m[0] * m[3] - m[1] * m[2];

const mul2 = (a: number[], b: number[]) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
];

const inv2 = (m: number[]) => {
  const d = det2(m);
  if (Math.abs(d) < 1e-9) return null;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d];
};

const transpose2 = (m: number[]) => [m[0], m[2], m[1], m[3]];

/** 2×2 的伴随矩阵：主对角互换、副对角变号 */
const adj2 = (m: number[]) => [m[3], -m[1], -m[2], m[0]];

/** 行阶梯化求秩（2×3 够用）。返回秩与阶梯形，界面上把过程显示出来。 */
function rank23(rows: number[][]): { rank: number; rref: number[][] } {
  const m = rows.map((r) => [...r]);
  let r = 0;
  for (let c = 0; c < m[0].length && r < m.length; c++) {
    let piv = r;
    for (let i = r; i < m.length; i++) if (Math.abs(m[i][c]) > Math.abs(m[piv][c])) piv = i;
    if (Math.abs(m[piv][c]) < 1e-9) continue;
    [m[r], m[piv]] = [m[piv], m[r]];
    const p = m[r][c];
    for (let j = c; j < m[0].length; j++) m[r][j] /= p;
    for (let i = 0; i < m.length; i++) {
      if (i === r) continue;
      const f = m[i][c];
      if (Math.abs(f) < 1e-12) continue;
      for (let j = c; j < m[0].length; j++) m[i][j] -= f * m[r][j];
    }
    r++;
  }
  const cleaned = m.map((row) => row.map((v) => (Math.abs(v) < 1e-9 ? 0 : v)));
  return { rank: r, rref: cleaned };
}

/* ============================================================
   矩阵绘制
   ============================================================ */
interface MatDrawOpts {
  label?: string;
  color: string;
  /** 逐格上色（返回 null 用默认色） */
  tint?: (i: number, j: number) => string | null;
  /** 单元格边长 */
  cell?: number;
}

/** 画一个矩阵，返回它的像素宽度 */
function drawMatrix(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  rows: number, cols: number,
  get: (i: number, j: number) => number,
  pal: Palette,
  o: MatDrawOpts,
): number {
  const cell = o.cell ?? 34;
  const w = cols * cell;
  const h = rows * cell;
  ctx.save();
  ctx.font = '12px "PingFang SC", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  /* 括号：两条竖线 + 四个小横钩，比画圆弧省事也更清楚 */
  ctx.strokeStyle = o.color;
  ctx.lineWidth = 1.4;
  const hook = 7;
  for (const side of [0, 1]) {
    const px = side === 0 ? x - 6 : x + w + 6;
    ctx.beginPath();
    ctx.moveTo(px + (side === 0 ? hook : -hook), y - 4);
    ctx.lineTo(px, y - 4);
    ctx.lineTo(px, y + h + 4);
    ctx.lineTo(px + (side === 0 ? hook : -hook), y + h + 4);
    ctx.stroke();
  }

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const v = get(i, j);
      const tint = o.tint?.(i, j);
      if (tint) {
        ctx.fillStyle = tint;
        ctx.globalAlpha = 0.14;
        ctx.fillRect(x + j * cell + 1, y + i * cell + 1, cell - 2, cell - 2);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = tint ?? pal.text(0.92);
      ctx.fillText(fmt(v, 1), x + j * cell + cell / 2, y + i * cell + cell / 2 + 1);
    }
  }
  if (o.label) {
    ctx.textAlign = 'left';
    ctx.fillStyle = pal.text(0.6);
    ctx.fillText(o.label, x, y - 14);
  }
  ctx.restore();
  return w;
}

/** 画一个二维向量（箭头 + 标签），返回末端坐标 */
function drawVec(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, vx: number, vy: number,
  color: string, label: string, pal: Palette, scale = 1,
) {
  const x2 = ox + vx * scale;
  const y2 = oy - vy * scale;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const ang = Math.atan2(y2 - oy, x2 - ox);
  const len = Math.hypot(x2 - ox, y2 - oy);
  if (len > 6) {
    const head = Math.min(9, len * 0.4);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - 0.4), y2 - head * Math.sin(ang - 0.4));
    ctx.lineTo(x2 - head * Math.cos(ang + 0.4), y2 - head * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
  }
  if (label) {
    ctx.font = '11px "PingFang SC", system-ui, sans-serif';
    ctx.fillText(label, x2 + 5, y2 - 5);
  }
  ctx.restore();
}

/** 画一个平面坐标系（矩阵演示常用），返回原点像素坐标 */
function plane(ctx: CanvasRenderingContext2D, W: number, H: number, range: number, pal: Palette, scale: number) {
  const ox = W / 2;
  const oy = H / 2;
  ctx.save();
  ctx.strokeStyle = pal.mesh;
  ctx.lineWidth = 1;
  for (let i = -range; i <= range; i++) {
    ctx.beginPath(); ctx.moveTo(ox + i * scale, 0); ctx.lineTo(ox + i * scale, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, oy + i * scale); ctx.lineTo(W, oy + i * scale); ctx.stroke();
  }
  ctx.strokeStyle = pal.axis;
  ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(W, oy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, H); ctx.stroke();
  ctx.restore();
  return { ox, oy };
}

/** 把矩阵的两列画成一个平行四边形（行列式的几何意义 = 面积） */
function drawParallelogram(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, m: number[],
  scale: number, pal: Palette, color: string, alpha = 0.16,
) {
  const p1 = { x: ox + m[0] * scale, y: oy - m[2] * scale };
  const p2 = { x: ox + m[1] * scale, y: oy - m[3] * scale };
  const p3 = { x: ox + (m[0] + m[1]) * scale, y: oy - (m[2] + m[3]) * scale };
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(ox, oy); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p2.x, p2.y);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ============================================================
   1. matrix —— 行列式 / 矩阵运算 / 逆矩阵 / 秩
   ============================================================ */
const matrix: DemoRegistry[string] = (variant) => {
  const [mode, sub] = (variant || 'det').split(':');

  /* ---------- 秩（2×3 矩阵，能展示 r=2/1/0 三种情形）---------- */
  if (mode === 'rank') {
    const rowsOf = (p: Params) => [[p.a11, p.a12, p.a13], [p.a21, p.a22, p.a23]];
    return {
      what: '矩阵的秩 = 行阶梯形里非零行的个数。拖元素让两行成比例，秩就会掉下来',
      controls: [
        /* 默认两行不成比例（秩 2），把 a₂₃ 拖到 2 就能看到秩掉成 1 ——
         * 这是「两行成比例 ⇒ 秩减少」最直观的演示路径。 */
        mat('a11', 'a₁₁', 1), mat('a12', 'a₁₂', 2), mat('a13', 'a₁₃', 2),
        mat('a21', 'a₂₁', 1), mat('a22', 'a₂₂', 2), mat('a23', 'a₂₃', 3),
      ],
      view: { x: [-1, 1], y: [-1, 1] },
      readout: (p) => {
        const { rank, rref } = rank23(rowsOf(p));
        return [
          { label: '秩 r(A)', value: String(rank), tone: rank < 2 ? 'warn' : 'good' },
          { label: '行阶梯形第一行', value: rref[0].map((v) => fmt(v, 2)).join('  ') },
          { label: '行阶梯形第二行', value: rref[1].map((v) => fmt(v, 2)).join('  ') },
          { label: '两行是否成比例', value: rank < 2 ? '是 → 秩为 1' : '否 → 秩为 2' },
          {
            label: sub === 'product' ? 'r(AB) ≤ min{r(A), r(B)}' : sub === 'inv' ? 'r(AB) = r(B)（A 可逆）' : sub === 'sum' ? 'r(A+B) ≤ r(A)+r(B)' : '秩的定义',
            value: '见上',
          },
        ];
      },
      custom: (ctx, W, H, p, pal) => {
        const rows = rowsOf(p);
        const { rref } = rank23(rows);
        ctx.save();
        drawMatrix(ctx, 40, H / 2 - 34, 2, 3, (i, j) => rows[i][j], pal, {
          label: 'A', color: pal.violet(), tint: (i) => (i === 1 && Math.abs(rref[1][0]) < 1e-9 && Math.abs(rref[1][1]) < 1e-9 && Math.abs(rref[1][2]) < 1e-9 ? pal.rose() : null),
        });
        ctx.fillStyle = pal.text(0.7);
        ctx.font = '18px system-ui';
        ctx.fillText('→', 40 + 3 * 34 + 22, H / 2);
        drawMatrix(ctx, 40 + 3 * 34 + 54, H / 2 - 34, 2, 3, (i, j) => rref[i][j], pal, {
          label: '行阶梯形', color: pal.cyan(),
        });
        ctx.restore();
      },
    };
  }

  /* ---------- 逆矩阵 ---------- */
  if (mode === 'inv') {
    return {
      what: 'A⁻¹ = A*/|A| —— 可逆的充要条件是 |A| ≠ 0',
      controls: [mat('a11', 'a₁₁', 2), mat('a12', 'a₁₂', 1), mat('a21', 'a₂₁', 1), mat('a22', 'a₂₂', 1)],
      view: { x: [-1, 1], y: [-1, 1] },
      readout: (p) => {
        const m = M2(p);
        const d = det2(m);
        const inv = inv2(m);
        const prod = inv ? mul2(m, inv) : null;
        return [
          { label: '|A|', value: fmt(d, 3), tone: Math.abs(d) < 1e-9 ? 'warn' : 'good' },
          { label: '可逆？', value: Math.abs(d) < 1e-9 ? '否（|A|=0）' : '是', tone: Math.abs(d) < 1e-9 ? 'warn' : 'good' },
          { label: 'A⁻¹ 第一行', value: inv ? `${fmt(inv[0], 3)}  ${fmt(inv[1], 3)}` : '不存在' },
          { label: 'A⁻¹ 第二行', value: inv ? `${fmt(inv[2], 3)}  ${fmt(inv[3], 3)}` : '不存在' },
          { label: 'A·A⁻¹', value: prod ? `${fmt(prod[0], 2)} ${fmt(prod[1], 2)} / ${fmt(prod[2], 2)} ${fmt(prod[3], 2)}` : '—', hint: '应当等于单位矩阵 E' },
          { label: sub === 'adjbasic' ? 'AA* = |A|E' : sub === 'adjformula' ? 'A⁻¹ = A*/|A|' : '伴随矩阵 A*', value: adj2(m).map((v) => fmt(v, 2)).join(' ') },
        ];
      },
      custom: (ctx, W, H, p, pal) => {
        const m = M2(p);
        const d = det2(m);
        const inv = inv2(m);
        const { ox, oy } = plane(ctx, W, H, 3, pal, 26);
        drawParallelogram(ctx, ox, oy, m, 26, pal, pal.violet());
        drawVec(ctx, ox, oy, m[0], m[2], pal.violet(), 'A 的第一列', pal, 26);
        drawVec(ctx, ox, oy, m[1], m[3], pal.cyan(), 'A 的第二列', pal, 26);
        if (inv) {
          drawVec(ctx, ox, oy, inv[0], inv[2], pal.emerald(), 'A⁻¹ 的第一列', pal, 26);
        } else {
          ctx.save();
          ctx.fillStyle = pal.rose();
          ctx.font = '13px "PingFang SC", system-ui';
          ctx.fillText('|A| = 0：两列共线，平行四边形被压扁成一条线', 14, H - 12);
          ctx.restore();
        }
      },
    };
  }

  /* ---------- 克拉默法则 ---------- */
  if (mode === 'cramer') {
    return {
      what: '克拉默法则：x_j = |A_j| / |A| —— 用行列式的比值直接解出未知数',
      controls: [
        mat('a11', 'a₁₁', 2), mat('a12', 'a₁₂', 1),
        mat('a21', 'a₂₁', 1), mat('a22', 'a₂₂', 3),
        mat('b1', 'b₁', 5, -8, 8), mat('b2', 'b₂', 8, -8, 8),
      ],
      view: { x: [-1, 1], y: [-1, 1] },
      readout: (p) => {
        const m = M2(p);
        const d = det2(m);
        /* A₁：把第一列换成 b */
        const d1 = det2([p.b1, m[1], p.b2, m[3]]);
        /* A₂：把第二列换成 b */
        const d2 = det2([m[0], p.b1, m[2], p.b2]);
        return [
          { label: '|A|', value: fmt(d, 3), tone: Math.abs(d) < 1e-9 ? 'warn' : 'good' },
          { label: '|A₁|', value: fmt(d1, 3) },
          { label: '|A₂|', value: fmt(d2, 3) },
          { label: 'x₁ = |A₁|/|A|', value: Math.abs(d) < 1e-9 ? '无唯一解' : fmt(d1 / d, 4) },
          { label: 'x₂ = |A₂|/|A|', value: Math.abs(d) < 1e-9 ? '无唯一解' : fmt(d2 / d, 4) },
          { label: '有唯一解的条件', value: '|A| ≠ 0', tone: Math.abs(d) < 1e-9 ? 'warn' : 'good' },
        ];
      },
      custom: (ctx, W, H, p, pal) => {
        const m = M2(p);
        const d1 = [p.b1, m[1], p.b2, m[3]];
        const d2 = [m[0], p.b1, m[2], p.b2];
        const cy = H / 2 - 34;
        let x = 34;
        x += drawMatrix(ctx, x, cy, 2, 2, (i, j) => m[i * 2 + j], pal, { label: 'A', color: pal.violet() }) + 34;
        x += drawMatrix(ctx, x, cy, 2, 1, (i) => [p.b1, p.b2][i], pal, { label: 'b', color: pal.cyan(), cell: 30 }) + 40;
        x += drawMatrix(ctx, x, cy, 2, 2, (i, j) => d1[i * 2 + j], pal, { label: 'A₁（第一列换成 b）', color: pal.amber(), cell: 30 }) + 30;
        drawMatrix(ctx, x, cy, 2, 2, (i, j) => d2[i * 2 + j], pal, { label: 'A₂', color: pal.emerald(), cell: 30 });
      },
    };
  }

  /* ---------- 矩阵运算 ---------- */
  if (mode === 'ops') {
    /* B 固定成 [[1,1],[0,1]]：这样 AB 与 BA 一般不同，能直接展示「乘法无交换律」 */
    const B = [1, 1, 0, 1];
    return {
      what: sub === 'commute'
        ? '矩阵乘法不满足交换律：AB 一般不等于 BA'
        : sub === 'det'
          ? '|AB| = |A||B| —— 行列式对乘法是「可分」的'
          : '矩阵运算：拖 A 的元素看结果怎么变',
      controls: [mat('a11', 'a₁₁', 2), mat('a12', 'a₁₂', 1), mat('a21', 'a₂₁', 1), mat('a22', 'a₂₂', 1)],
      view: { x: [-1, 1], y: [-1, 1] },
      readout: (p) => {
        const m = M2(p);
        const ab = mul2(m, B);
        const ba = mul2(B, m);
        const dA = det2(m);
        const dB = det2(B);
        const dAB = det2(ab);
        return [
          { label: 'AB', value: `${fmt(ab[0], 2)} ${fmt(ab[1], 2)} / ${fmt(ab[2], 2)} ${fmt(ab[3], 2)}` },
          { label: 'BA', value: `${fmt(ba[0], 2)} ${fmt(ba[1], 2)} / ${fmt(ba[2], 2)} ${fmt(ba[3], 2)}` },
          { label: 'AB = BA ？', value: ab.every((v, i) => Math.abs(v - ba[i]) < 1e-9) ? '相等（巧合）' : '不相等', tone: ab.every((v, i) => Math.abs(v - ba[i]) < 1e-9) ? 'good' : 'warn' },
          { label: '|A|', value: fmt(dA, 3) },
          { label: '|B|', value: fmt(dB, 3) },
          { label: '|A|·|B|', value: fmt(dA * dB, 3) },
          { label: '|AB|', value: fmt(dAB, 3), tone: Math.abs(dAB - dA * dB) < 1e-6 ? 'good' : 'warn' },
          { label: '(AB)ᵀ = BᵀAᵀ', value: transpose2(ab).map((v) => fmt(v, 2)).join(' ') },
          { label: 'BᵀAᵀ', value: mul2(transpose2(B), transpose2(m)).map((v) => fmt(v, 2)).join(' ') },
        ];
      },
      custom: (ctx, W, H, p, pal) => {
        const m = M2(p);
        const ab = mul2(m, B);
        const ba = mul2(B, m);
        const cy = H / 2 - 34;
        let x = 30;
        x += drawMatrix(ctx, x, cy, 2, 2, (i, j) => m[i * 2 + j], pal, { label: 'A', color: pal.violet() }) + 30;
        x += drawMatrix(ctx, x, cy, 2, 2, (i, j) => B[i * 2 + j], pal, { label: 'B', color: pal.cyan() }) + 34;
        x += drawMatrix(ctx, x, cy, 2, 2, (i, j) => ab[i * 2 + j], pal, { label: 'AB', color: pal.emerald() }) + 40;
        drawMatrix(ctx, x, cy, 2, 2, (i, j) => ba[i * 2 + j], pal, { label: 'BA（不一样）', color: pal.amber() });
      },
    };
  }

  /* ---------- 默认：行列式 ---------- */
  const m2 = (p: Params) => M2(p);
  return {
    what: sub === 'vander'
      ? '范德蒙德行列式：∏(x_j − x_i) —— 任意两个 x 相等它就为零'
      : '行列式的几何意义：两列向量张成的平行四边形面积（带符号）',
    controls: sub === 'vander'
      ? [mat('a11', 'x₁', 1, -2, 2), mat('a22', 'x₂', 2, -2, 3), mat('a33', 'x₃', 3, -2, 4)]
      : [mat('a11', 'a₁₁', 2), mat('a12', 'a₁₂', 1), mat('a21', 'a₂₁', 1), mat('a22', 'a₂₂', 3)],
    view: { x: [-1, 1], y: [-1, 1] },
    readout: (p) => {
      if (sub === 'vander') {
        const [x1, x2, x3] = [p.a11, p.a22, p.a33];
        const v = (x2 - x1) * (x3 - x1) * (x3 - x2);
        return [
          { label: 'x₁, x₂, x₃', value: `${fmt(x1, 1)}, ${fmt(x2, 1)}, ${fmt(x3, 1)}` },
          { label: '范德蒙德行列式', value: fmt(v, 4), tone: Math.abs(v) < 1e-9 ? 'warn' : 'good' },
          { label: '为零的条件', value: '任意两个 x 相等', tone: Math.abs(v) < 1e-9 ? 'warn' : 'default' },
        ];
      }
      const m = m2(p);
      const d = det2(m);
      return [
        { label: '|A|', value: fmt(d, 4), tone: Math.abs(d) < 1e-6 ? 'warn' : 'good' },
        { label: '平行四边形面积', value: fmt(Math.abs(d), 4), hint: '行列式的绝对值' },
        { label: '符号', value: d > 0 ? '正（右手系）' : d < 0 ? '负（左手系）' : '零（退化）' },
        {
          label: sub === 'transpose' ? '|Aᵀ| = |A|' : sub === 'swap' ? '交换两行 ⇒ 变号' : sub === 'scale' ? '|kA| = kⁿ|A|' : '转置不变',
          value: sub === 'transpose' ? fmt(det2(transpose2(m)), 4) : '见上',
        },
      ];
    },
    custom: (ctx, W, H, p, pal) => {
      if (sub === 'vander') {
        const xs = [p.a11, p.a22, p.a33];
        const rows = xs.map((x) => [1, x, x * x]);
        drawMatrix(ctx, 40, H / 2 - 50, 3, 3, (i, j) => rows[i][j], pal, { label: '范德蒙德矩阵', color: pal.violet(), cell: 40 });
        ctx.save();
        ctx.fillStyle = pal.text(0.75);
        ctx.font = '13px "PingFang SC", system-ui';
        ctx.fillText(`= (x₂−x₁)(x₃−x₁)(x₃−x₂) = ${fmt((xs[1] - xs[0]) * (xs[2] - xs[0]) * (xs[2] - xs[1]), 3)}`, 40 + 3 * 40 + 24, H / 2);
        ctx.restore();
        return;
      }
      const m = m2(p);
      const { ox, oy } = plane(ctx, W, H, 3, pal, 30);
      drawParallelogram(ctx, ox, oy, m, 30, pal, pal.violet(), Math.abs(det2(m)) < 1e-9 ? 0.32 : 0.16);
      drawVec(ctx, ox, oy, m[0], m[2], pal.violet(), '第 1 列', pal, 30);
      drawVec(ctx, ox, oy, m[1], m[3], pal.cyan(), '第 2 列', pal, 30);
      ctx.save();
      ctx.fillStyle = pal.text(0.8);
      ctx.font = '12px "PingFang SC", system-ui';
      ctx.fillText(`面积 = |A| = ${fmt(Math.abs(det2(m)), 3)}`, 14, H - 14);
      ctx.restore();
    },
  };
};

/* ============================================================
   2. vectors —— 线性相关 / 线性表示 / 基变换
   ============================================================ */
const vectors: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'dep').split(':');
  return {
    what: mode === 'trans'
      ? '过渡矩阵与坐标变换：换一组基，同一个向量的坐标就变了'
      : mode === 'express'
        ? '可线性表示：β 落在 α₁、α₂ 张成的「面」里，就能被表示'
        : '线性相关：两个向量共线时，它们的线性组合只能覆盖一条直线',
    controls: [
      mat('a1', 'α₁ 的 x', 2), mat('a2', 'α₁ 的 y', 1),
      mat('b1', 'α₂ 的 x', 1), mat('b2', 'α₂ 的 y', 2),
      ctrl('k1', '组合系数 k₁', -2, 2, 0.05, 1, (v) => v.toFixed(2)),
      ctrl('k2', '组合系数 k₂', -2, 2, 0.05, 1, (v) => v.toFixed(2)),
    ],
    view: { x: [-1, 1], y: [-1, 1] },
    readout: (p) => {
      const v1 = [p.a1, p.a2];
      const v2 = [p.b1, p.b2];
      const det = v1[0] * v2[1] - v1[1] * v2[0];
      const kx = p.k1 * v1[0] + p.k2 * v2[0];
      const ky = p.k1 * v1[1] + p.k2 * v2[1];
      return [
        { label: 'α₁', value: `(${fmt(v1[0], 1)}, ${fmt(v1[1], 1)})` },
        { label: 'α₂', value: `(${fmt(v2[0], 1)}, ${fmt(v2[1], 1)})` },
        { label: '行列式 |α₁ α₂|', value: fmt(det, 3), tone: Math.abs(det) < 1e-9 ? 'warn' : 'good' },
        { label: '线性相关？', value: Math.abs(det) < 1e-9 ? '是（共线）' : '否', tone: Math.abs(det) < 1e-9 ? 'warn' : 'good' },
        { label: 'k₁α₁ + k₂α₂', value: `(${fmt(kx, 2)}, ${fmt(ky, 2)})` },
        { label: '张成的空间', value: Math.abs(det) < 1e-9 ? '一条直线（1 维）' : '整个平面（2 维）' },
      ];
    },
    custom: (ctx, W, H, p, pal) => {
      const { ox, oy } = plane(ctx, W, H, 4, pal, 26);
      const v1 = [p.a1, p.a2];
      const v2 = [p.b1, p.b2];
      drawVec(ctx, ox, oy, v1[0], v1[1], pal.violet(), 'α₁', pal, 26);
      drawVec(ctx, ox, oy, v2[0], v2[1], pal.cyan(), 'α₂', pal, 26);
      const kx = p.k1 * v1[0] + p.k2 * v2[0];
      const ky = p.k1 * v1[1] + p.k2 * v2[1];
      drawVec(ctx, ox, oy, kx, ky, pal.amber(), 'k₁α₁+k₂α₂', pal, 26);
    },
  };
};

/* ============================================================
   3. linsolve —— 线性方程组（几何：两条直线的交点）
   ============================================================ */
const linsolve: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'cases').split(':');
  return {
    what: '线性方程组的三种情形：唯一解（两线相交）、无解（平行）、无穷多解（重合）',
    controls: [
      mat('a11', 'a₁₁', 1), mat('a12', 'a₁₂', 1), mat('b1', 'b₁', 4, -8, 8),
      mat('a21', 'a₂₁', 2), mat('a22', 'a₂₂', 2), mat('b2', 'b₂', 8, -8, 8),
    ],
    view: { x: [-1, 1], y: [-1, 1] },
    readout: (p) => {
      const A = [p.a11, p.a12, p.a21, p.a22];
      const d = det2(A);
      const d1 = det2([p.b1, A[1], p.b2, A[3]]);
      const d2 = det2([A[0], p.b1, A[2], p.b2]);
      const rA = rank23([[p.a11, p.a12], [p.a21, p.a22]]).rank;
      const rAb = rank23([[p.a11, p.a12, p.b1], [p.a21, p.a22, p.b2]]).rank;
      const kind = Math.abs(d) > 1e-9 ? '唯一解'
        : rA === rAb ? '无穷多解' : '无解';
      return [
        { label: '|A|', value: fmt(d, 3) },
        { label: 'r(A)', value: String(rA) },
        { label: 'r(A, b)', value: String(rAb) },
        { label: '解的判定', value: kind, tone: kind === '唯一解' ? 'good' : kind === '无解' ? 'warn' : 'default' },
        { label: 'x₁', value: Math.abs(d) > 1e-9 ? fmt(d1 / d, 3) : '—' },
        { label: 'x₂', value: Math.abs(d) > 1e-9 ? fmt(d2 / d, 3) : '—' },
        {
          label: mode === 'hom' ? '齐次（b=0）有非零解？' : 'r(A)=r(A,b) ？',
          value: mode === 'hom'
            ? (rA < 2 ? '是（r(A)<n）' : '否，只有零解')
            : (rA === rAb ? '是 → 有解' : '否 → 无解'),
        },
      ];
    },
    custom: (ctx, W, H, p, pal) => {
      const { ox, oy } = plane(ctx, W, H, 4, pal, 26);
      /* 把每条方程画成一条直线：a₁x + a₂y = b */
      const line = (a1: number, a2: number, b: number, color: string, label: string) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (Math.abs(a2) > 1e-6) {
          const x1 = -4; const x2 = 4;
          ctx.moveTo(ox + x1 * 26, oy - ((b - a1 * x1) / a2) * 26);
          ctx.lineTo(ox + x2 * 26, oy - ((b - a1 * x2) / a2) * 26);
        } else if (Math.abs(a1) > 1e-6) {
          const x = b / a1;
          ctx.moveTo(ox + x * 26, 0);
          ctx.lineTo(ox + x * 26, H);
        }
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = '11px "PingFang SC", system-ui, sans-serif';
        ctx.fillText(label, 8, 16 + (label === 'L2' ? 14 : 0));
        ctx.restore();
      };
      line(p.a11, p.a12, p.b1, pal.violet(), 'L1');
      line(p.a21, p.a22, p.b2, pal.cyan(), 'L2');
    },
  };
};

/* ============================================================
   4. eigen —— 特征值 / 相似对角化 / 实对称
   ============================================================ */
const eigen: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'eq').split(':');

  if (mode === 'diag' || mode === 'sym' || mode === 'orth') {
    return {
      what: mode === 'orth'
        ? '实对称矩阵一定可以正交对角化：QᵀAQ = Λ'
        : '相似对角化：P⁻¹AP = Λ —— 对角元就是特征值',
      controls: [mat('a11', 'a₁₁', 2), mat('a12', 'a₁₂', 1), mat('a21', 'a₂₁', 1), mat('a22', 'a₂₂', 2)],
      view: { x: [-1, 1], y: [-1, 1] },
      readout: (p) => {
        const m = M2(p);
        const tr = m[0] + m[3];
        const dt = det2(m);
        const disc = tr * tr - 4 * dt;
        const l1 = (tr + Math.sqrt(Math.max(0, disc))) / 2;
        const l2 = (tr - Math.sqrt(Math.max(0, disc))) / 2;
        return [
          { label: 'tr(A)', value: fmt(tr, 3) },
          { label: '|A|', value: fmt(dt, 3) },
          { label: '判别式 tr²−4|A|', value: fmt(disc, 3) },
          { label: 'λ₁', value: disc >= 0 ? fmt(l1, 3) : `${fmt(tr / 2, 2)} ± ${fmt(Math.sqrt(-disc) / 2, 2)}i` },
          { label: 'λ₂', value: disc >= 0 ? fmt(l2, 3) : `${fmt(tr / 2, 2)} ∓ ${fmt(Math.sqrt(-disc) / 2, 2)}i` },
          { label: 'λ₁ + λ₂ = tr(A)', value: disc >= 0 ? fmt(l1 + l2, 3) : fmt(tr, 3), tone: 'good' },
          { label: 'λ₁·λ₂ = |A|', value: disc >= 0 ? fmt(l1 * l2, 3) : fmt(dt, 3), tone: 'good' },
          { label: '可对角化？', value: disc > 0 ? '是（两个不同实根）' : disc === 0 ? '看几何重数' : '复数域上可以', tone: disc > 0 ? 'good' : 'default' },
          { label: '是否实对称', value: Math.abs(m[1] - m[2]) < 1e-9 ? '是' : '否', tone: Math.abs(m[1] - m[2]) < 1e-9 ? 'good' : 'default' },
        ];
      },
      custom: (ctx, W, H, p, pal) => {
        const m = M2(p);
        const { ox, oy } = plane(ctx, W, H, 3, pal, 28);
        /* 画一个探测向量 v 和它的像 Av —— 当 v 与 Av 共线时，v 就是特征向量 */
        const ang = 0.7;
        const v = [Math.cos(ang) * 1.6, Math.sin(ang) * 1.6];
        const av = [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
        drawVec(ctx, ox, oy, v[0], v[1], pal.cyan(), 'v', pal, 28);
        drawVec(ctx, ox, oy, av[0], av[1], pal.violet(), 'Av', pal, 28);
        ctx.save();
        ctx.fillStyle = pal.text(0.7);
        ctx.font = '11px "PingFang SC", system-ui';
        ctx.fillText('Av 与 v 共线时，v 就是特征向量', 10, H - 12);
        ctx.restore();
      },
    };
  }

  return {
    what: '特征值：拖矩阵元素，看 λ₁+λ₂ 是否始终等于主对角元之和（迹）',
    controls: [mat('a11', 'a₁₁', 3), mat('a12', 'a₁₂', 1), mat('a21', 'a₂₁', 2), mat('a22', 'a₂₂', 2)],
    view: { x: [-1, 1], y: [-1, 1] },
    readout: (p) => {
      const m = M2(p);
      const tr = m[0] + m[3];
      const dt = det2(m);
      const disc = tr * tr - 4 * dt;
      const l1 = (tr + Math.sqrt(Math.max(0, disc))) / 2;
      const l2 = (tr - Math.sqrt(Math.max(0, disc))) / 2;
      const m2 = mul2(m, m);
      return [
        { label: '特征方程', value: `λ² − ${fmt(tr, 2)}λ + ${fmt(dt, 2)} = 0` },
        { label: '判别式', value: fmt(disc, 3), tone: disc >= 0 ? 'good' : 'warn' },
        { label: 'λ₁', value: disc >= 0 ? fmt(l1, 3) : `${fmt(tr / 2, 2)} + ${fmt(Math.sqrt(-disc) / 2, 2)}i` },
        { label: 'λ₂', value: disc >= 0 ? fmt(l2, 3) : `${fmt(tr / 2, 2)} − ${fmt(Math.sqrt(-disc) / 2, 2)}i` },
        { label: 'λ₁+λ₂', value: fmt(tr, 3), hint: '= tr(A)' },
        { label: 'λ₁λ₂', value: fmt(dt, 3), hint: '= |A|' },
        { label: 'A² 的特征值（应为 λ²）', value: disc >= 0 ? `${fmt(l1 * l1, 3)}, ${fmt(l2 * l2, 3)}` : '—' },
        { label: 'tr(A²)', value: fmt(m2[0] + m2[3], 3), hint: '= λ₁²+λ₂²' },
      ];
    },
    custom: (ctx, W, H, p, pal) => {
      const m = M2(p);
      const tr = m[0] + m[3];
      const dt = det2(m);
      const disc = tr * tr - 4 * dt;
      const l1 = (tr + Math.sqrt(Math.max(0, disc))) / 2;
      const l2 = (tr - Math.sqrt(Math.max(0, disc))) / 2;
      /* 把两个特征值画在数轴上 —— 「特征值」这个概念本身是一组数 */
      const axisY = H / 2 + 30;
      ctx.save();
      ctx.strokeStyle = pal.axis;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(30, axisY); ctx.lineTo(W - 30, axisY); ctx.stroke();
      const lo = Math.min(l1, l2, -1) - 1;
      const hi = Math.max(l1, l2, 1) + 1;
      const X = (v: number) => 30 + ((v - lo) / (hi - lo)) * (W - 60);
      for (const [v, color, name] of [[l1, pal.violet(), 'λ₁'], [l2, pal.cyan(), 'λ₂']] as [number, string, string][]) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(X(v), axisY, 5, 0, Math.PI * 2); ctx.fill();
        ctx.font = '12px "PingFang SC", system-ui';
        ctx.fillText(`${name} = ${fmt(v, 2)}`, X(v) - 20, axisY - 12);
      }
      ctx.restore();
      drawMatrix(ctx, 40, 50, 2, 2, (i, j) => m[i * 2 + j], pal, { label: 'A', color: pal.text(0.85) });
    },
  };
};

/* ============================================================
   5. quadform —— 二次型 / 正定
   ============================================================ */
const quadform: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'matrix').split(':');
  const q = (x: number, y: number, p: Params) => p.a11 * x * x + 2 * p.a12 * x * y + p.a22 * y * y;
  return {
    what: mode === 'posdef'
      ? '正定二次型：等高线是一圈圈的椭圆，函数值恒为正（除原点）'
      : '二次型 f = xᵀAx：等高线的形状由 A 的特征值决定',
    controls: [
      ctrl('a11', 'a₁₁', -2, 3, 0.05, 2, (v) => v.toFixed(2)),
      ctrl('a12', 'a₁₂ = a₂₁', -2, 2, 0.05, 0.5, (v) => v.toFixed(2)),
      ctrl('a22', 'a₂₂', -2, 3, 0.05, 1, (v) => v.toFixed(2)),
    ],
    view: { x: [-2.4, 2.4], y: [-2.4, 2.4] },
    scene: (p, pal) => {
      const m = [p.a11, p.a12, p.a12, p.a22];
      const tr = m[0] + m[3];
      const dt = det2(m);
      const disc = tr * tr - 4 * dt;
      return {
        grid: false,
        heat: { f: q, x: [-2.4, 2.4], y: [-2.4, 2.4], cells: 44, color: (t, a = 1) => pal.violet(a * 0.75) },
        contours: {
          f: q, x: [-2.4, 2.4], y: [-2.4, 2.4],
          levels: disc >= 0
            ? [0.5, 1, 2, 3, 4, 6]
            : [0.5, 1, 2, 3],
          color: pal.text(0.5),
        },
        markers: [{ x: 0, y: 0, color: pal.amber(), r: 4 }],
      };
    },
    readout: (p) => {
      const m = [p.a11, p.a12, p.a12, p.a22];
      const tr = m[0] + m[3];
      const dt = det2(m);
      const disc = tr * tr - 4 * dt;
      const l1 = (tr + Math.sqrt(Math.max(0, disc))) / 2;
      const l2 = (tr - Math.sqrt(Math.max(0, disc))) / 2;
      const posdef = disc > 0 && l1 > 0 && l2 > 0;
      return [
        { label: '矩阵 A', value: `${fmt(m[0], 2)} ${fmt(m[1], 2)} / ${fmt(m[2], 2)} ${fmt(m[3], 2)}` },
        { label: 'λ₁', value: fmt(l1, 3) },
        { label: 'λ₂', value: fmt(l2, 3) },
        { label: 'D₁ = a₁₁', value: fmt(p.a11, 3), hint: '顺序主子式' },
        { label: 'D₂ = |A|', value: fmt(dt, 3) },
        { label: '正定？', value: posdef ? '是（D₁>0 且 D₂>0）' : '否', tone: posdef ? 'good' : 'warn' },
        { label: '惯性指数', value: `正 ${[l1, l2].filter((v) => v > 1e-9).length} · 负 ${[l1, l2].filter((v) => v < -1e-9).length}` },
        { label: mode === 'posdef' ? '正定 ⇔ 与 E 合同' : '标准形', value: `${fmt(l1, 2)}y₁² + ${fmt(l2, 2)}y₂²` },
      ];
    },
    note: '顺序主子式全大于 0 才正定。只看对角元是不够的 —— 那是最常见的误判。',
  };
};

export const LINEAR_DEMOS: DemoRegistry = {
  matrix,
  vectors,
  linsolve,
  eigen,
  quadform,
};

export const LINEAR_KINDS = Object.keys(LINEAR_DEMOS);
