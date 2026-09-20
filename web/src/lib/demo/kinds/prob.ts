/* 公式演示引擎 · 概率论与数理统计
 *
 * 这一片的演示形态有三类：
 *   · 集合图（Venn）—— 概率的加法、减法、条件、独立
 *   · 分布图（柱状 / 曲线 / 热力图）—— 分布律、密度、联合分布
 *   · 树图与数轴 —— 贝叶斯、期望方差、置信区间
 *
 * 和线代那一片一样，参数都做成滑块。概率论最容易「看公式都懂、一算就错」，
 * 拖一遍 P(A)、P(B)、P(AB) 看三个区域怎么变，比背公式有用。
 */
import { clamp, comb, fmt, integrate, type CurveSpec, type Params, type Palette, type Scene } from '../plot';
import { ctrl, int, type DemoRegistry, type Readout } from '../types';

/* ---------- 标准正态的分布函数（用数值积分，避免引入误差函数近似）---------- */
const npdf = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
const ncdf = (x: number) => 0.5 + integrate(npdf, 0, x, 400);

/* ---------- 阶乘 / 组合已在 plot.ts 里 ---------- */

/* ============================================================
   1. venn —— 概率基本公式 / 条件概率 / 独立性
   ============================================================ */
const venn: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'add').split(':');
  const what: Record<string, string> = {
    add: '加法公式：P(A∪B) = P(A) + P(B) − P(AB) —— 重叠部分被数了两次，要减掉一次',
    sub: '减法公式：P(A−B) = P(A) − P(AB)',
    complement: '对立事件：P(Ā) = 1 − P(A)',
    indep: '独立性：P(AB) = P(A)P(B) 时称 A 与 B 独立',
    cond: '条件概率：P(A|B) = P(AB)/P(B) —— 把样本空间缩到 B 里面看',
    mul: '乘法公式：P(AB) = P(A|B)P(B)',
  };
  return {
    what: what[mode] || what.add,
    controls: [
      ctrl('pa', 'P(A)', 0.05, 0.95, 0.01, 0.5, (v) => v.toFixed(2)),
      ctrl('pb', 'P(B)', 0.05, 0.95, 0.01, 0.4, (v) => v.toFixed(2)),
      ctrl('pab', 'P(AB)', 0, 0.95, 0.01, 0.15, (v) => v.toFixed(2)),
    ],
    view: { x: [-1, 1], y: [-1, 1] },
    readout: (p) => {
      /* 先把不合法的组合收拢到可行域 —— 否则会出现「P(AB) > P(A)」这种
       * 概率论上不可能、但滑块能拖出来的状态，界面上就成了错题。 */
      const pab = Math.min(p.pab, p.pa, p.pb);
      const union = p.pa + p.pb - pab;
      const indepTarget = p.pa * p.pb;
      /* 显式标成 Readout[]：不标的话 TS 会用数组字面量里的元素推断类型，
       * 后面 push 带 tone 的那几行就会报「tone 不存在」。 */
      const rows: Readout[] = [
        { label: 'P(A)', value: fmt(p.pa, 2) },
        { label: 'P(B)', value: fmt(p.pb, 2) },
        { label: 'P(AB)', value: fmt(pab, 2), hint: p.pab > pab ? `已收到可行上限 ${fmt(pab, 2)}` : undefined },
        { label: 'P(A∪B)', value: fmt(union, 2), hint: '= P(A)+P(B)−P(AB)' },
        { label: 'P(Ā)', value: fmt(1 - p.pa, 2) },
        { label: 'P(A−B)', value: fmt(p.pa - pab, 2) },
      ];
      if (mode === 'indep') {
        rows.push({
          label: 'P(A)·P(B)',
          value: fmt(indepTarget, 3),
          tone: Math.abs(pab - indepTarget) < 0.01 ? 'good' : 'default',
          hint: Math.abs(pab - indepTarget) < 0.01 ? '相等 → 独立' : '不等 → 不独立',
        });
      }
      if (mode === 'cond' || mode === 'mul') {
        rows.push({ label: 'P(A|B)', value: p.pb > 0 ? fmt(pab / p.pb, 4) : '—', hint: '= P(AB)/P(B)' });
        rows.push({ label: 'P(B|A)', value: p.pa > 0 ? fmt(pab / p.pa, 4) : '—' });
      }
      return rows;
    },
    custom: (ctx, W, H, p, pal) => {
      const pab = Math.min(p.pab, p.pa, p.pb);
      const R = Math.min(W, H) * 0.27;
      const cx = W / 2;
      const cy = H / 2;
      const dx = R * 0.62;
      const aOnly = p.pa - pab;
      const bOnly = p.pb - pab;

      const circle = (x: number, y: number, r: number, color: string, alpha: number) => {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.restore();
      };
      /* 透明度按概率取，但留一个下限 —— 全透明的话区域边界都看不见了 */
      circle(cx - dx, cy, R, pal.violet(), 0.08 + aOnly * 0.45);
      circle(cx + dx, cy, R, pal.cyan(), 0.08 + bOnly * 0.45);
      /* 交集单独画一块：两圆相交的透镜区域用 emerald 高亮 */
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx - dx, cy, R, -Math.PI / 3, Math.PI / 3);
      ctx.arc(cx + dx, cy, R, Math.PI - Math.PI / 3, Math.PI + Math.PI / 3, true);
      ctx.closePath();
      ctx.fillStyle = pal.emerald();
      ctx.globalAlpha = 0.1 + pab * 0.7;
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.font = '12px "PingFang SC", system-ui, sans-serif';
      ctx.fillStyle = pal.violet();
      ctx.fillText(`A 独占 ${fmt(aOnly, 2)}`, cx - dx - R * 0.72, cy + 4);
      ctx.fillStyle = pal.emerald();
      ctx.textAlign = 'center';
      ctx.fillText(`${fmt(pab, 2)}`, cx, cy + 4);
      ctx.textAlign = 'left';
      ctx.fillStyle = pal.cyan();
      ctx.fillText(`B 独占 ${fmt(bOnly, 2)}`, cx + dx + R * 0.12, cy + 4);
      ctx.fillStyle = pal.text(0.75);
      ctx.font = '11.5px "PingFang SC", system-ui, sans-serif';
      ctx.fillText('拖动右侧三个滑块，看三块区域怎么变', 12, H - 12);
      ctx.restore();
    },
  };
};

/* ============================================================
   2. bayes —— 全概率 / 贝叶斯
   ============================================================ */
const bayes: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'bayes').split(':');
  return {
    what: mode === 'total'
      ? '全概率公式：P(A) = Σ P(A|Bᵢ)P(Bᵢ) —— 把 A 按原因拆开再相加'
      : '贝叶斯公式：已知结果 A 发生了，反推它来自哪个原因 Bᵢ',
    controls: [
      ctrl('p1', 'P(B₁) 先验', 0.05, 0.95, 0.01, 0.6, (v) => v.toFixed(2)),
      ctrl('pa1', 'P(A|B₁)', 0.01, 0.5, 0.01, 0.01, (v) => v.toFixed(2)),
      ctrl('pa2', 'P(A|B₂)', 0.01, 0.5, 0.01, 0.02, (v) => v.toFixed(2)),
    ],
    view: { x: [-1, 1], y: [-1, 1] },
    readout: (p) => {
      const p2 = 1 - p.p1;
      const pa = p.pa1 * p.p1 + p.pa2 * p2;
      const post1 = pa > 0 ? (p.pa1 * p.p1) / pa : 0;
      return [
        { label: 'P(B₁)', value: fmt(p.p1, 2) },
        { label: 'P(B₂)', value: fmt(p2, 2) },
        { label: 'P(A|B₁)', value: fmt(p.pa1, 3) },
        { label: 'P(A|B₂)', value: fmt(p.pa2, 3) },
        { label: 'P(A)（全概率）', value: fmt(pa, 5), hint: '= P(A|B₁)P(B₁)+P(A|B₂)P(B₂)' },
        { label: 'P(B₁|A)（后验）', value: fmt(post1, 5), tone: 'good', hint: '= P(A|B₁)P(B₁)/P(A)' },
        { label: 'P(B₂|A)', value: fmt(1 - post1, 5) },
        { label: '先验 vs 后验', value: post1 > p.p1 ? '后验升高（A 更可能来自 B₁）' : post1 < p.p1 ? '后验降低' : '不变', tone: 'good' },
      ];
    },
    custom: (ctx, W, H, p, pal) => {
      const p2 = 1 - p.p1;
      const pa = p.pa1 * p.p1 + p.pa2 * p2;
      const post1 = pa > 0 ? (p.pa1 * p.p1) / pa : 0;
      const x0 = 26;
      const xB = W * 0.4;
      const xA = W * 0.78;
      const yTop = 34;
      const yBot = H - 34;
      const y1 = yTop + (yBot - yTop) * p.p1;

      ctx.save();
      ctx.font = '11.5px "PingFang SC", system-ui, sans-serif';
      /* 主干 */
      ctx.strokeStyle = pal.text(0.5);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(x0, (yTop + yBot) / 2); ctx.lineTo(xB, (yTop + yBot) / 2); ctx.stroke();
      /* 两条原因分支，线宽正比于先验 */
      const branch = (y: number, w: number, color: string, label: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, w * 10);
        ctx.beginPath(); ctx.moveTo(xB, (yTop + yBot) / 2); ctx.lineTo(xA, y); ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(label, xB + 6, y - 5);
      };
      branch(y1, p.p1, pal.violet(), `B₁  P=${fmt(p.p1, 2)}`);
      branch(yBot - (yBot - yTop) * p2 / 2 + (yBot - yTop) * 0.5, p2, pal.cyan(), `B₂  P=${fmt(p2, 2)}`);
      /* 结果节点 */
      const node = (y: number, w: number, color: string, label: string) => {
        ctx.beginPath();
        ctx.arc(xA + 12, y, 5 + w * 12, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.text(0.8);
        ctx.fillText(label, xA + 30, y + 4);
      };
      node(y1, p.pa1, pal.amber(), `P(A|B₁) = ${fmt(p.pa1, 3)}`);
      node(yBot - 26, p.pa2, pal.amber(), `P(A|B₂) = ${fmt(p.pa2, 3)}`);
      ctx.fillStyle = pal.emerald();
      ctx.font = '12px "PingFang SC", system-ui, sans-serif';
      ctx.fillText(`P(B₁|A) = ${fmt(post1, 3)}`, 12, H - 10);
      ctx.restore();
    },
  };
};

/* ============================================================
   3. classic —— 古典概型 / 几何概型 / 伯努利概型
   ============================================================ */
const classic: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'geometric').split(':');

  if (mode === 'classical') {
    return {
      what: '古典概型：P(A) = k/n —— 数清楚有利结果和总结果',
      controls: [int('n', '总结果数 n', 2, 60, 12), int('k', '有利结果数 k', 0, 60, 4)],
      view: { x: [-1, 1], y: [-1, 1] },
      readout: (p) => {
        const n = Math.max(2, Math.round(p.n));
        const k = clamp(Math.round(p.k), 0, n);
        return [
          { label: '总结果数 n', value: String(n) },
          { label: '有利结果数 k', value: String(k) },
          { label: 'P(A) = k/n', value: fmt(k / n, 5), tone: 'good' },
          { label: '前提', value: '每个基本事件等可能', hint: '这是古典概型成立的前提' },
        ];
      },
      custom: (ctx, W, H, p, pal) => {
        const n = Math.max(2, Math.round(p.n));
        const k = clamp(Math.round(p.k), 0, n);
        const cols = Math.ceil(Math.sqrt(n));
        const cell = Math.min((W - 40) / cols, (H - 40) / Math.ceil(n / cols)) - 3;
        const ox = (W - cols * (cell + 3)) / 2;
        const oy = (H - Math.ceil(n / cols) * (cell + 3)) / 2;
        ctx.save();
        for (let i = 0; i < n; i++) {
          const r = Math.floor(i / cols);
          const c = i % cols;
          ctx.fillStyle = i < k ? pal.emerald() : pal.text(0.18);
          ctx.globalAlpha = i < k ? 0.85 : 1;
          ctx.fillRect(ox + c * (cell + 3), oy + r * (cell + 3), cell, cell);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      },
    };
  }

  if (mode === 'bernoulli') {
    return {
      what: '伯努利概型：n 次独立重复试验中恰好成功 k 次的概率',
      controls: [
        int('n', '试验次数 n', 1, 30, 10),
        ctrl('pp', '单次成功概率 p', 0.05, 0.95, 0.01, 0.4, (v) => v.toFixed(2)),
        int('k', '成功次数 k', 0, 30, 4),
      ],
      view: { x: [-0.8, 31], y: [-0.03, 0.45] },
      scene: (p, pal) => {
        const n = Math.max(1, Math.round(p.n));
        const ks = Array.from({ length: n + 1 }, (_, i) => i);
        const probs = ks.map((i) => comb(n, i) * Math.pow(p.pp, i) * Math.pow(1 - p.pp, n - i));
        return {
          bars: [{
            at: () => ks, h: () => probs, w: 0.72, color: pal.cyan(0.55), outline: pal.cyan(0.8),
          }],
          markers: [{
            x: clamp(Math.round(p.k), 0, n),
            y: comb(n, clamp(Math.round(p.k), 0, n)) * Math.pow(p.pp, clamp(Math.round(p.k), 0, n)) * Math.pow(1 - p.pp, n - clamp(Math.round(p.k), 0, n)),
            color: pal.amber(), r: 4.5,
          }],
        };
      },
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        const k = clamp(Math.round(p.k), 0, n);
        const val = comb(n, k) * Math.pow(p.pp, k) * Math.pow(1 - p.pp, n - k);
        let sum = 0;
        for (let i = 0; i <= n; i++) sum += comb(n, i) * Math.pow(p.pp, i) * Math.pow(1 - p.pp, n - i);
        return [
          { label: 'C(n,k)', value: fmt(comb(n, k), 0) },
          { label: `P(X = ${k})`, value: fmt(val, 6), tone: 'good' },
          { label: '所有概率之和', value: fmt(sum, 6), hint: '应等于 1' },
          { label: '期望 np', value: fmt(n * p.pp, 3) },
        ];
      },
      note: '二项分布的期望是 np、方差是 np(1−p) —— 这两个在选择题里出现频率极高。',
    };
  }

  /* geometric：几何概型 —— 面积比 */
  return {
    what: '几何概型：P(A) = 面积之比。概率不再是「数个数」，而是「量面积」',
    controls: [
      ctrl('r', '内接区域大小', 0.1, 1, 0.02, 0.5, (v) => v.toFixed(2)),
      ctrl('t', '形状参数', 0.1, 2, 0.05, 1, (v) => v.toFixed(2)),
    ],
    view: { x: [-1, 1], y: [-1, 1] },
    readout: (p) => {
      const areaOuter = 4;
      const areaInner = Math.PI * p.r * p.r;
      return [
        { label: '总区域面积 μ(Ω)', value: fmt(areaOuter, 4) },
        { label: '目标区域面积 μ(A)', value: fmt(areaInner, 4) },
        { label: 'P(A) = μ(A)/μ(Ω)', value: fmt(areaInner / areaOuter, 5), tone: 'good' },
        { label: '特点', value: '单点概率为 0 但可能发生', hint: '这是几何概型和古典概型的本质区别' },
      ];
    },
    custom: (ctx, W, H, p, pal) => {
      const s = Math.min(W, H) * 0.4;
      const cx = W / 2;
      const cy = H / 2;
      ctx.save();
      ctx.fillStyle = pal.text(0.1);
      ctx.fillRect(cx - s, cy - s, s * 2, s * 2);
      ctx.strokeStyle = pal.text(0.4);
      ctx.lineWidth = 1.4;
      ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
      ctx.beginPath();
      ctx.arc(cx, cy, s * p.r, 0, Math.PI * 2);
      ctx.fillStyle = pal.violet();
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.violet();
      ctx.stroke();
      ctx.font = '12px "PingFang SC", system-ui, sans-serif';
      ctx.fillStyle = pal.text(0.85);
      ctx.fillText(`圆面积 / 正方形面积 = ${fmt(Math.PI * p.r * p.r / 4, 4)}`, 12, H - 12);
      ctx.restore();
    },
  };
};

/* ============================================================
   4. dist —— 离散分布 / 连续分布 / 分布函数
   ============================================================ */
const dist: DemoRegistry[string] = (variant) => {
  const [mode, sub] = (variant || 'normal').split(':');

  /* ---------- 离散型：柱状图 ---------- */
  if (['bern', 'binom', 'poisson', 'geom', 'hyper'].includes(mode)) {
    const spec: Record<string, { title: string; controls: () => ReturnType<typeof ctrl>[]; max: number; pmf: (k: number, p: Params) => number }> = {
      bern: {
        title: '0-1 分布（伯努利）：只有两个取值',
        controls: () => [ctrl('pp', '成功概率 p', 0.05, 0.95, 0.01, 0.4, (v) => v.toFixed(2))],
        max: 1,
        pmf: (k, p) => (k === 1 ? p.pp : k === 0 ? 1 - p.pp : 0),
      },
      binom: {
        title: '二项分布 B(n, p)',
        controls: () => [int('n', '试验次数 n', 1, 30, 10), ctrl('pp', '成功概率 p', 0.05, 0.95, 0.01, 0.4, (v) => v.toFixed(2))],
        max: 30,
        pmf: (k, p) => { const n = Math.round(p.n); return k < 0 || k > n ? 0 : comb(n, k) * Math.pow(p.pp, k) * Math.pow(1 - p.pp, n - k); },
      },
      poisson: {
        title: '泊松分布 P(λ)',
        controls: () => [ctrl('lam', '参数 λ', 0.5, 15, 0.1, 3, (v) => v.toFixed(1))],
        max: 30,
        pmf: (k, p) => (Math.exp(-p.lam) * Math.pow(p.lam, k)) / (k < 0 ? 1 : (() => { let r = 1; for (let i = 2; i <= k; i++) r *= i; return r; })()),
      },
      geom: {
        title: '几何分布 G(p)：第 k 次才首次成功',
        controls: () => [ctrl('pp', '成功概率 p', 0.05, 0.95, 0.01, 0.3, (v) => v.toFixed(2))],
        max: 20,
        pmf: (k, p) => (k < 1 ? 0 : Math.pow(1 - p.pp, k - 1) * p.pp),
      },
      hyper: {
        title: '超几何分布：不放回抽样',
        controls: () => [int('N', '总数 N', 5, 40, 20), int('M', '其中次品 M', 1, 20, 6), int('nn', '抽 n 个', 1, 15, 5)],
        max: 15,
        pmf: (k, p) => {
          const N = Math.round(p.N); const M = Math.min(Math.round(p.M), N); const n = Math.round(p.nn);
          return (comb(M, k) * comb(N - M, n - k)) / comb(N, n);
        },
      },
    };
    const s = spec[mode] || spec.binom;
    return {
      what: s.title + ' —— 每根柱子的高度就是取到那个值的概率',
      controls: s.controls(),
      view: { x: [-0.8, s.max + 0.8], y: [-0.02, 0.6] },
      scene: (p, pal) => {
        const ks = Array.from({ length: s.max + 1 }, (_, i) => i);
        const probs = ks.map((k) => s.pmf(k, p));
        const top = Math.max(0.05, ...probs.filter(Number.isFinite));
        return {
          bars: [{ at: () => ks, h: () => probs, w: 0.7, color: pal.cyan(0.55), outline: pal.cyan(0.8) }],
          hlines: [{ y: top * 1.05, color: pal.text(0.001) }],
        };
      },
      readout: (p) => {
        const probs = Array.from({ length: s.max + 1 }, (_, k) => s.pmf(k, p));
        let mean = 0;
        let e2 = 0;
        probs.forEach((v, k) => { if (Number.isFinite(v)) { mean += k * v; e2 += k * k * v; } });
        const sum = probs.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
        return [
          { label: '概率之和', value: fmt(sum, 5), hint: '应等于 1', tone: Math.abs(sum - 1) < 0.01 ? 'good' : 'warn' },
          { label: '期望 E(X)', value: fmt(mean, 4) },
          { label: '方差 D(X)', value: fmt(e2 - mean * mean, 4) },
          {
            label: '理论公式',
            value: mode === 'binom' ? 'E=np, D=np(1−p)'
              : mode === 'poisson' ? 'E=D=λ'
                : mode === 'geom' ? 'E=1/p, D=(1−p)/p²'
                  : mode === 'bern' ? 'E=p, D=p(1−p)'
                    : 'E=nM/N',
          },
        ];
      },
      note: '柱子高度是概率、不是密度 —— 离散型的每一根柱子都对应一个具体的取值。',
    };
  }

  /* ---------- 分布函数与密度 ---------- */
  if (mode === 'cdf') {
    return {
      what: sub === 'normalize'
        ? '密度的归一性：曲线下方的总面积恒为 1'
        : '分布函数 F(x) 与密度 f(x)：F 是 f 下方的累积面积',
      controls: [ctrl('x', '自变量 x', -4, 4, 0.05, 0.5, (v) => v.toFixed(2))],
      view: { x: [-4.2, 4.2], y: [-0.1, 1.3] },
      scene: (p, pal) => ({
        curves: [
          { f: npdf, color: pal.cyan(), label: '密度 f(x)' },
          { f: ncdf, color: pal.violet(), label: '分布函数 F(x)' },
        ],
        fills: [{ from: -6, to: (pp) => pp.x, top: npdf, color: pal.cyan(), alpha: 0.2 }],
        markers: [
          { x: (pp) => pp.x, y: (pp) => ncdf(pp.x), color: pal.violet(), r: 4 },
          { x: (pp) => pp.x, y: (pp) => npdf(pp.x), color: pal.cyan(), r: 4 },
        ],
        vlines: [{ x: (pp) => pp.x, color: pal.text(0.3), dash: [3, 3] }],
      }),
      readout: (p) => [
        { label: 'f(x)', value: fmt(npdf(p.x), 5) },
        { label: 'F(x) = P(X ≤ x)', value: fmt(ncdf(p.x), 5) },
        { label: 'F(+∞)', value: fmt(ncdf(6), 5), hint: '应等于 1', tone: 'good' },
        { label: '∫ 全域 f dx', value: fmt(integrate(npdf, -8, 8, 800), 5), tone: 'good' },
        { label: 'P(−1 < X < 1)', value: fmt(ncdf(1) - ncdf(-1), 5), hint: '≈ 0.6827' },
      ],
      note: sub === 'normalize'
        ? '归一性是把「密度」和「随便一个正函数」区分开的那条约束。'
        : 'F 的斜率就是 f：F(x) 增加得快的地方，说明那里的密度大。',
    };
  }

  if (mode === 'transform') {
    return {
      what: '随机变量函数的分布：X 的密度经过变换后变成 Y 的密度，面积要守恒',
      controls: [ctrl('a', '变换系数 a', 0.3, 3, 0.05, 2, (v) => v.toFixed(2))],
      view: { x: [-4.2, 4.2], y: [-0.1, 1.1] },
      scene: (p, pal) => ({
        curves: [
          { f: npdf, color: pal.cyan(), label: 'f_X(x)：标准正态' },
          { f: (y) => npdf(y / p.a) / p.a, color: pal.violet(), label: `f_Y(y)：Y = ${fmt(p.a, 1)}X` },
        ],
        fills: [
          { from: -4, to: -1, top: npdf, color: pal.cyan(), alpha: 0.16 },
          { from: -4 * p.a, to: -p.a, top: (y) => npdf(y / p.a) / p.a, color: pal.violet(), alpha: 0.16 },
        ],
      }),
      readout: (p) => [
        { label: '变换', value: `Y = ${fmt(p.a, 2)}X` },
        { label: 'D(Y) = a²D(X)', value: fmt(p.a * p.a, 4), hint: 'X 的方差为 1' },
        { label: 'σ(Y)', value: fmt(p.a, 4) },
        { label: '两个阴影面积', value: '相等', tone: 'good', hint: 'P(X<−1) = P(Y<−a)' },
        { label: 'P(X < −1)', value: fmt(ncdf(-1), 5) },
        { label: 'P(Y < −a)', value: fmt(ncdf(-1), 5) },
      ],
      note: '单调变换的密度公式里那个 |h\'(y)| 就是为了让面积守恒 —— 拉伸了高度就要压缩。',
    };
  }

  if (mode === 'uniform' || mode === 'exp') {
    const isU = mode === 'uniform';
    return {
      what: isU ? '均匀分布 U(a,b)：在区间内密度是常数' : '指数分布 E(λ)：密度指数衰减，具有无记忆性',
      controls: isU
        ? [
          ctrl('a', '左端点 a', -3, 0, 0.1, 0, (v) => v.toFixed(1)),
          ctrl('b', '右端点 b', 0.5, 4, 0.1, 2, (v) => v.toFixed(1)),
        ]
        : [ctrl('lam', '参数 λ', 0.2, 3, 0.05, 1, (v) => v.toFixed(2))],
      view: isU ? { x: [-3.5, 4.5], y: [-0.1, 1.2] } : { x: [-0.5, 5], y: [-0.1, 3.2] },
      scene: (p, pal) => ({
        curves: isU
          ? [{ f: (x) => (x >= p.a && x <= p.b ? 1 / (p.b - p.a) : 0), color: pal.violet(), label: '密度 f(x)' }]
          : [{ f: (x) => (x < 0 ? 0 : p.lam * Math.exp(-p.lam * x)), color: pal.violet(), label: '密度 f(x)' }],
        fills: isU
          ? [{ from: (pp) => pp.a, to: (pp) => pp.b, top: (x) => 1 / (p.b - p.a), color: pal.violet(), alpha: 0.2 }]
          : [{ from: 0, to: 4, top: (x) => p.lam * Math.exp(-p.lam * x), color: pal.violet(), alpha: 0.2 }],
        hlines: isU ? [{ y: 1 / (p.b - p.a), color: pal.emerald(0.6), dash: [4, 4], label: `1/(b−a) = ${fmt(1 / (p.b - p.a), 3)}` }] : [],
      }),
      /* ★ readout 必须是函数。写成 `readout: isU ? [ ... p.a ... ] : [...]`
       *   会在**构造时**就求值，而那时根本没有 p —— 抛 ReferenceError。
       *   tests/formula-demos.mjs 的「构造抛异常」那一条就是专门抓这个的。 */
      readout: (p) => (isU
        ? [
          { label: '区间长度 b−a', value: fmt(p.b - p.a, 3) },
          { label: '密度 1/(b−a)', value: fmt(1 / (p.b - p.a), 4) },
          { label: 'E(X) = (a+b)/2', value: fmt((p.a + p.b) / 2, 4) },
          { label: 'D(X) = (b−a)²/12', value: fmt((p.b - p.a) ** 2 / 12, 4) },
          { label: '矩形面积', value: fmt((p.b - p.a) * (1 / (p.b - p.a)), 4), hint: '恒等于 1', tone: 'good' as const },
        ]
        : [
          { label: 'E(X) = 1/λ', value: fmt(1 / p.lam, 4) },
          { label: 'D(X) = 1/λ²', value: fmt(1 / (p.lam * p.lam), 4) },
          { label: 'P(X > 1)', value: fmt(Math.exp(-p.lam), 5) },
          { label: 'P(X > s+t | X > s)', value: fmt(Math.exp(-p.lam * 1), 5), hint: '= P(X > t)：无记忆性', tone: 'good' as const },
        ]),
      note: isU
        ? '均匀分布的两个参数就是区间的两个端点，密度是区间长度的倒数。'
        : '无记忆性是指数分布独有的：已经等了 s 小时，再等 t 小时的概率和从头开始一样。',
    };
  }

  if (mode === 'stdnormal' || mode === 'standardize') {
    return {
      what: mode === 'standardize'
        ? '正态标准化：X ~ N(μ,σ²) 时 (X−μ)/σ ~ N(0,1)'
        : '标准正态分布函数 Φ(x)：查表用的就是它',
      controls: [
        ctrl('mu', '均值 μ', -2, 2, 0.1, 0, (v) => v.toFixed(1)),
        ctrl('sig', '标准差 σ', 0.3, 2, 0.05, 1, (v) => v.toFixed(2)),
        ctrl('x', '分位点 x', -4, 4, 0.05, 1, (v) => v.toFixed(2)),
      ],
      view: { x: [-4.5, 4.5], y: [-0.05, 0.95] },
      scene: (p, pal) => ({
        curves: [
          { f: (x) => npdf((x - p.mu) / p.sig) / p.sig, color: pal.violet(), label: `N(${fmt(p.mu, 1)}, ${fmt(p.sig, 2)}²)` },
          { f: npdf, color: pal.text(0.35), width: 1.5, dash: [4, 4], label: 'N(0,1) 对照' },
        ],
        fills: [{ from: -6, to: (pp) => pp.x, top: (x) => npdf((x - p.mu) / p.sig) / p.sig, color: pal.violet(), alpha: 0.18 }],
        vlines: [{ x: (pp) => pp.x, color: pal.amber(0.7), dash: [3, 3] }],
        hlines: [{ y: 0, color: pal.text(0.001) }],
      }),
      readout: (p) => {
        const z = (p.x - p.mu) / p.sig;
        return [
          { label: '标准化后的 z', value: fmt(z, 4), hint: '(x−μ)/σ' },
          { label: 'Φ(z)', value: fmt(ncdf(z), 5) },
          { label: 'P(X ≤ x)', value: fmt(ncdf(z), 5), tone: 'good' },
          { label: '68-95-99.7 规则', value: 'μ±σ 内约 68.3%', hint: 'μ±2σ 约 95.4%，μ±3σ 约 99.7%' },
        ];
      },
      note: '正态标准化是查表的前提 —— 把任何正态分布的问题都化成 Φ 的值。',
    };
  }

  /* normal 默认 */
  return {
    what: '正态分布 N(μ, σ²)：密度关于 μ 对称，σ 决定胖瘦',
    controls: [
      ctrl('mu', '均值 μ', -2, 2, 0.1, 0, (v) => v.toFixed(1)),
      ctrl('sig', '标准差 σ', 0.3, 2, 0.05, 1, (v) => v.toFixed(2)),
    ],
    view: { x: [-4.5, 4.5], y: [-0.05, 1.35] },
    scene: (p, pal) => ({
      curves: [{ f: (x) => npdf((x - p.mu) / p.sig) / p.sig, color: pal.violet(), label: '密度 f(x)' }],
      fills: [{ from: (pp) => pp.mu - pp.sig, to: (pp) => pp.mu + pp.sig, top: (x) => npdf((x - p.mu) / p.sig) / p.sig, color: pal.cyan(), alpha: 0.22 }],
      vlines: [{ x: (pp) => pp.mu, color: pal.emerald(0.8), dash: [4, 3], label: `μ = ${fmt(p.mu, 1)}` }],
      markers: [{ x: (pp) => pp.mu, y: (pp) => npdf(0) / pp.sig, color: pal.emerald(), r: 4, label: `峰值 ${fmt(npdf(0) / p.sig, 3)}` }],
    }),
    readout: (p) => [
      { label: '峰值高度', value: fmt(npdf(0) / p.sig, 4), hint: '1/(√(2π)σ)' },
      { label: '密度面积', value: fmt(integrate((x) => npdf((x - p.mu) / p.sig) / p.sig, -12, 12, 800), 5), hint: '恒为 1', tone: 'good' },
      { label: 'P(μ−σ < X < μ+σ)', value: fmt(ncdf(1) - ncdf(-1), 5), hint: '≈ 0.6827' },
      { label: 'P(μ−2σ < X < μ+2σ)', value: fmt(ncdf(2) - ncdf(-2), 5), hint: '≈ 0.9545' },
      { label: 'E(X), D(X)', value: `${fmt(p.mu, 2)}, ${fmt(p.sig * p.sig, 3)}` },
    ],
    note: 'σ 越小曲线越尖 —— 但不管多尖，曲线下方的面积永远是 1。',
  };
};

/* ============================================================
   5. joint —— 联合分布 / 边缘分布 / 独立性
   ============================================================ */
const joint: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'joint').split(':');
  return {
    what: mode === 'indep'
      ? '独立性：f(x,y) = f_X(x)·f_Y(y) 时两变量独立'
      : '联合密度与边缘密度：把二维密度「压扁」到一条轴上就是边缘密度',
    controls: [
      ctrl('rho', '相关系数 ρ', -0.95, 0.95, 0.05, 0.6, (v) => v.toFixed(2)),
      ctrl('sig', '标准差 σ', 0.4, 2, 0.05, 1, (v) => v.toFixed(2)),
    ],
    view: { x: [-3.4, 3.4], y: [-3.4, 3.4] },
    scene: (p, pal) => {
      /* 二维正态的密度（标准化形式） */
      const rho = p.rho;
      const det = 1 - rho * rho;
      const f = (x: number, y: number) => {
        const u = x / p.sig; const v = y / p.sig;
        const e = (u * u - 2 * rho * u * v + v * v) / (2 * det);
        return Math.exp(-e) / (2 * Math.PI * p.sig * p.sig * Math.sqrt(det));
      };
      const sig = p.sig;
      return {
        grid: false,
        heat: { f, x: [-3.4, 3.4], y: [-3.4, 3.4], cells: 48, color: (t, a = 1) => pal.violet(a * 0.85) },
        contours: {
          f, x: [-3.4, 3.4], y: [-3.4, 3.4],
          levels: [0.02, 0.05, 0.1, 0.15, 0.2].map((l) => l / (sig * sig)),
          color: pal.text(0.5),
        },
        curves: [
          { f: (x) => npdf(x / sig) / sig * 3.2 - 3.2, color: pal.cyan(0.9), width: 1.8, label: '边缘密度 f_X（贴在下边）' },
        ],
        vlines: [{ x: 0, color: pal.text(0.001) }],
      };
    },
    readout: (p) => [
      { label: 'ρ', value: fmt(p.rho, 2) },
      { label: 'σ', value: fmt(p.sig, 2) },
      { label: '联合密度面积', value: fmt(integrate((x) => npdf(x / p.sig) / p.sig, -10, 10, 600), 5), hint: '恒为 1', tone: 'good' },
      { label: '独立性', value: Math.abs(p.rho) < 1e-9 ? '独立（ρ=0）' : '不独立', tone: Math.abs(p.rho) < 1e-9 ? 'good' : 'warn' },
      { label: '边缘分布', value: `X ~ N(0, ${fmt(p.sig * p.sig, 2)}), Y ~ N(0, ${fmt(p.sig * p.sig, 2)})` },
      { label: '条件分布', value: 'X|Y=y 仍是正态', hint: '二维正态的重要性质' },
    ],
    note: mode === 'indep'
      ? '只有二维正态才有「不相关 ⇔ 独立」这条等价关系 —— 别的分布不成立。'
      : '等高线是一圈圈同心的椭圆。ρ 越大椭圆越扁，越贴近一条对角线。',
  };
};

/* ============================================================
   6. moments —— 期望 / 方差 / 协方差 / 相关系数
   ============================================================ */
const moments: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'disc').split(':');

  if (mode === 'corr' || mode === 'covdef' || mode === 'covops' || mode === 'sumvar' || mode === 'bivarnormal') {
    return {
      what: '相关系数 ρ：衡量两个变量的线性关系强度。ρ=0 叫不相关',
      controls: [ctrl('rho', '相关系数 ρ', -1, 1, 0.05, 0.7, (v) => v.toFixed(2))],
      view: { x: [-3.2, 3.2], y: [-3.2, 3.2] },
      scene: (p, pal) => {
        /* 用确定性伪随机点云表现相关性 —— 同一个 ρ 每次画出来一样，
         * 否则截图和「拖着看」的观感都对不上。 */
        const pts: { x: number; y: number; color: string }[] = [];
        const N = 160;
        for (let i = 0; i < N; i++) {
          const a = (i * 12.9898) % 1;
          const b = (i * 78.233) % 1;
          const u1 = Math.max(1e-6, ((a * 1000) % 1));
          const u2 = (b * 1000) % 1;
          const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          const z2 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
          const x = z1;
          const y = p.rho * z1 + Math.sqrt(Math.max(0, 1 - p.rho * p.rho)) * z2;
          pts.push({ x, y, color: pal.cyan(0.75) });
        }
        return {
          markers: pts.map((q) => ({ x: q.x, y: q.y, color: q.color, r: 2.6 })),
          segs: [
            { x1: -3, y1: -3 * p.rho, x2: 3, y2: 3 * p.rho, color: pal.amber(0.85), width: 2 },
            { x1: -3, y1: 0, x2: 3, y2: 0, color: pal.text(0.25) },
          ],
        };
      },
      readout: (p) => [
        { label: 'ρ', value: fmt(p.rho, 2) },
        { label: 'Cov(X,Y)', value: fmt(p.rho, 4), hint: '标准化后 Cov = ρ' },
        { label: '线性关系', value: Math.abs(p.rho) > 0.9 ? '极强' : Math.abs(p.rho) > 0.6 ? '较强' : Math.abs(p.rho) > 0.3 ? '较弱' : '几乎没有', tone: Math.abs(p.rho) > 0.6 ? 'good' : 'default' },
        { label: 'ρ = 0 时', value: '不相关（但不一定独立）', tone: 'warn' },
        { label: 'D(X+Y)', value: fmt(2 + 2 * p.rho, 4), hint: '= D(X)+D(Y)+2Cov = 2+2ρ' },
        { label: 'ρ = ±1 时', value: 'Y 与 X 有严格的线性关系', hint: '此时点云退化成一条直线' },
      ],
      note: '相关系数只衡量**线性**关系。ρ=0 不代表没关系 —— 可能是抛物线关系。',
    };
  }

  if (mode === 'vardef' || mode === 'varformula' || mode === 'varops') {
    return {
      what: mode === 'varformula'
        ? '方差的计算公式：D(X) = E(X²) − [E(X)]² —— 算方差一般走这条，比按定义算快'
        : mode === 'varops'
          ? '方差的性质：D(aX+b) = a²D(X) —— 平移不改变方差'
          : '方差：D(X) = E[(X − E(X))²] —— 偏离均值的平方的期望',
      controls: [
        ctrl('mu', '均值 μ', -2, 2, 0.1, 0, (v) => v.toFixed(1)),
        ctrl('sig', '标准差 σ', 0.3, 2.5, 0.05, 1, (v) => v.toFixed(2)),
        ctrl('a', '缩放系数 a', -3, 3, 0.1, 2, (v) => v.toFixed(1)),
        ctrl('b', '平移常数 b', -3, 3, 0.1, 1, (v) => v.toFixed(1)),
      ],
      view: { x: [-6, 6], y: [-0.05, 1.1] },
      scene: (p, pal) => {
        const f = (x: number) => npdf((x - p.mu) / p.sig) / p.sig;
        const fa = (x: number) => npdf((x - (p.a * p.mu + p.b)) / (Math.abs(p.a) * p.sig)) / (Math.abs(p.a) * p.sig);
        return {
          curves: [
            { f, color: pal.violet(), label: `X ~ N(${fmt(p.mu, 1)}, ${fmt(p.sig * p.sig, 2)})` },
            { f: fa, color: pal.cyan(), width: 1.8, dash: [4, 4], label: `aX+b ~ N(${fmt(p.a * p.mu + p.b, 2)}, ${fmt(p.a * p.a * p.sig * p.sig, 2)})` },
          ],
          vlines: [
            { x: (pp) => pp.mu, color: pal.violet(0.7), dash: [3, 3], label: 'μ' },
            { x: (pp) => pp.mu - pp.sig, color: pal.text(0.3), dash: [2, 3] },
            { x: (pp) => pp.mu + pp.sig, color: pal.text(0.3), dash: [2, 3] },
          ],
          fills: [{ from: (pp) => pp.mu - pp.sig, to: (pp) => pp.mu + pp.sig, top: f, color: pal.violet(), alpha: 0.16 }],
        };
      },
      readout: (p) => {
        const dx = p.sig * p.sig;
        return [
          { label: 'E(X)', value: fmt(p.mu, 3) },
          { label: 'D(X) = σ²', value: fmt(dx, 4) },
          { label: 'E(X²) = D(X)+[E(X)]²', value: fmt(dx + p.mu * p.mu, 4), hint: '这正是计算公式的由来' },
          { label: 'D(aX+b) = a²D(X)', value: fmt(p.a * p.a * dx, 4), tone: 'good' },
          { label: '平移 b 的影响', value: '方差不变', hint: 'b 只改变位置，不改变胖瘦', tone: 'good' },
          { label: 'a = 0 时', value: 'D = 0（退化成一个常数）', tone: p.a === 0 ? 'warn' : 'default' },
        ];
      },
      note: 'D(aX+b) = a²D(X) 里那个**平方**是踩坑重灾区：b 完全不起作用，a 要平方。',
    };
  }

  if (mode === 'chebyshev') {
    return {
      what: '切比雪夫不等式：P(|X−μ| ≥ ε) ≤ D(X)/ε² —— 不用知道分布就能估概率上界',
      controls: [
        ctrl('eps', 'ε（偏离量）', 0.2, 4, 0.05, 1.5, (v) => v.toFixed(2)),
        ctrl('sig', '标准差 σ', 0.3, 2, 0.05, 1, (v) => v.toFixed(2)),
      ],
      view: { x: [-5, 5], y: [-0.05, 1.1] },
      scene: (p, pal) => ({
        curves: [{ f: (x) => npdf(x / p.sig) / p.sig, color: pal.violet(), label: '密度 f(x)（以正态为例）' }],
        fills: [
          { from: -8, to: (pp) => -pp.eps, top: (x) => npdf(x / p.sig) / p.sig, color: pal.rose(), alpha: 0.25 },
          { from: (pp) => pp.eps, to: 8, top: (x) => npdf(x / p.sig) / p.sig, color: pal.rose(), alpha: 0.25 },
        ],
        vlines: [
          { x: (pp) => -pp.eps, color: pal.rose(0.8), dash: [4, 3], label: '−ε' },
          { x: (pp) => pp.eps, color: pal.rose(0.8), dash: [4, 3], label: '+ε' },
        ],
      }),
      readout: (p) => {
        const bound = (p.sig * p.sig) / (p.eps * p.eps);
        const real = 2 * (1 - ncdf(p.eps / p.sig));
        return [
          { label: '上界 D(X)/ε²', value: fmt(Math.min(1, bound), 4), tone: 'good' },
          { label: '真实概率（正态）', value: fmt(real, 4) },
          { label: '不等式成立？', value: real <= bound + 1e-9 ? '成立' : '不成立', tone: real <= bound + 1e-9 ? 'good' : 'warn' },
          { label: 'ε = 2σ 时', value: `上界 ${fmt(1 / 4, 3)}，真实值 ${fmt(2 * (1 - ncdf(2)), 4)}`, hint: '上界很松，但不需要知道分布' },
        ];
      },
      note: '切比雪夫给的是**上界**，通常比真实概率松很多 —— 它的价值在于不依赖分布。',
    };
  }

  if (mode === 'cont' || mode === 'func') {
    return {
      what: '连续型期望：E(g(X)) = ∫ g(x)f(x)dx —— 用密度加权求和',
      controls: [
        ctrl('mu', '均值 μ', -2, 2, 0.1, 0, (v) => v.toFixed(1)),
        ctrl('sig', '标准差 σ', 0.4, 2, 0.05, 1, (v) => v.toFixed(2)),
      ],
      view: { x: [-5, 5], y: [-0.05, 1.1] },
      scene: (p, pal) => {
        const f = (x: number) => npdf((x - p.mu) / p.sig) / p.sig;
        /* 曲线数组显式标类型：下面那个条件展开（mode === 'func' 时多一条）
         * 会让 TS 推不出元素类型，于是 `(x) =>` 的 x 变成隐式 any。 */
        const curves: CurveSpec[] = [
          { f, color: pal.violet(), label: '密度 f(x)' },
          { f: (x) => f(x) * x * 0.6, color: pal.cyan(), width: 1.8, label: 'x·f(x)（被积函数）' },
        ];
        if (mode === 'func') {
          curves.push({ f: (x) => f(x) * x * x * 0.4, color: pal.emerald(), width: 1.6, label: 'x²·f(x)' });
        }
        return {
          curves,
          fills: [{ from: (pp) => pp.mu - pp.sig, to: (pp) => pp.mu + pp.sig, top: f, color: pal.violet(), alpha: 0.18 }],
          vlines: [{ x: (pp) => pp.mu, color: pal.amber(0.8), dash: [4, 3], label: 'μ' }],
        };
      },
      readout: (p) => {
        const f = (x: number) => npdf((x - p.mu) / p.sig) / p.sig;
        const mean = integrate((x) => x * f(x), -10, 10, 800);
        const e2 = integrate((x) => x * x * f(x), -10, 10, 800);
        return [
          { label: 'E(X) = ∫x·f dx', value: fmt(mean, 5), hint: `参数 μ = ${fmt(p.mu, 1)}` },
          { label: 'E(X²) = ∫x²·f dx', value: fmt(e2, 5) },
          { label: 'D(X) = E(X²)−[E(X)]²', value: fmt(e2 - mean * mean, 5), hint: `σ² = ${fmt(p.sig * p.sig, 3)}` },
          { label: 'E(g(X)) 的口诀', value: '把 x 换成 g(x)，密度不动', hint: '不需要求 g(X) 的分布' },
        ];
      },
      note: 'E(g(X)) 不需要先求 g(X) 的分布 —— 直接对 g(x)f(x) 积分就行，这是最省事的一条。',
    };
  }

  if (mode === 'linear' || mode === 'product') {
    return {
      what: mode === 'linear'
        ? '期望的线性性：E(aX+bY+c) = aE(X)+bE(Y)+c —— 不需要独立性'
        : '乘积的期望：X、Y 独立时 E(XY) = E(X)E(Y)',
      controls: [
        ctrl('a', '系数 a', -3, 3, 0.1, 2, (v) => v.toFixed(1)),
        ctrl('b', '系数 b', -3, 3, 0.1, 1, (v) => v.toFixed(1)),
        ctrl('c', '常数 c', -3, 3, 0.1, 0, (v) => v.toFixed(1)),
      ],
      view: { x: [-1, 1], y: [-1, 1] },
      readout: (p) => {
        const ex = 1; const ey = 2;   /* 取 E(X)=1, E(Y)=2 作示例 */
        return [
          { label: 'E(X)', value: String(ex) },
          { label: 'E(Y)', value: String(ey) },
          { label: 'E(aX+bY+c)', value: fmt(p.a * ex + p.b * ey + p.c, 4), tone: 'good' },
          { label: 'aE(X)+bE(Y)+c', value: fmt(p.a * ex + p.b * ey + p.c, 4), hint: '两者必然相等' },
          { label: '需要独立性吗', value: mode === 'linear' ? '不需要' : '需要（乘积那条要）', tone: 'good' },
          { label: 'E(XY)（独立时）', value: fmt(ex * ey, 4) },
        ];
      },
      custom: (ctx, W, H, p, pal) => {
        /* 用一条「数轴 + 权重」的示意表现线性性 */
        ctx.save();
        ctx.font = '13px "PingFang SC", system-ui, sans-serif';
        ctx.fillStyle = pal.text(0.85);
        const rows = [
          `E(X) = 1,   E(Y) = 2`,
          `a = ${fmt(p.a, 1)},  b = ${fmt(p.b, 1)},  c = ${fmt(p.c, 1)}`,
          `E(aX + bY + c) = ${fmt(p.a, 1)}×1 + ${fmt(p.b, 1)}×2 + ${fmt(p.c, 1)}`,
          `             = ${fmt(p.a * 1 + p.b * 2 + p.c, 3)}`,
        ];
        rows.forEach((t, i) => ctx.fillText(t, 26, 60 + i * 30));
        ctx.fillStyle = pal.emerald();
        ctx.fillText('期望的线性性对任意随机变量成立，不需要独立', 26, 60 + rows.length * 30 + 14);
        ctx.restore();
      },
    };
  }

  /* disc：离散型期望 */
  return {
    what: '离散型期望：E(X) = Σ xᵢpᵢ —— 用概率给每个取值加权',
    controls: [
      ctrl('p1', 'p₁', 0.02, 0.9, 0.01, 0.2, (v) => v.toFixed(2)),
      ctrl('p2', 'p₂', 0.02, 0.9, 0.01, 0.5, (v) => v.toFixed(2)),
      ctrl('p3', 'p₃', 0.02, 0.9, 0.01, 0.3, (v) => v.toFixed(2)),
    ],
    view: { x: [-0.6, 4.6], y: [-0.05, 0.95] },
    scene: (p, pal) => {
      const raw = [p.p1, p.p2, p.p3];
      const s = raw.reduce((a, b) => a + b, 0) || 1;
      const probs = raw.map((v) => v / s);   /* 归一化，保证是合法分布律 */
      const xs = [1, 2, 3];
      return {
        bars: [{ at: () => xs, h: () => probs, w: 0.5, color: pal.cyan(0.6), outline: pal.cyan(0.85) }],
        vlines: [{
          x: probs.reduce((a, v, i) => a + v * xs[i], 0),
          color: pal.amber(0.85), dash: [4, 3], label: 'E(X)',
        }],
      };
    },
    readout: (p) => {
      const raw = [p.p1, p.p2, p.p3];
      const s = raw.reduce((a, b) => a + b, 0) || 1;
      const probs = raw.map((v) => v / s);
      const xs = [1, 2, 3];
      const mean = probs.reduce((a, v, i) => a + v * xs[i], 0);
      const e2 = probs.reduce((a, v, i) => a + v * xs[i] * xs[i], 0);
      return [
        { label: '归一化后的 p', value: probs.map((v) => fmt(v, 3)).join(', '), hint: '原始输入已按比例缩放' },
        { label: '概率之和', value: fmt(probs.reduce((a, b) => a + b, 0), 5), tone: 'good' },
        { label: 'E(X) = Σxᵢpᵢ', value: fmt(mean, 4), tone: 'good' },
        { label: 'E(X²)', value: fmt(e2, 4) },
        { label: 'D(X)', value: fmt(e2 - mean * mean, 4), hint: '= E(X²) − [E(X)]²' },
      ];
    },
    note: '期望是「加权平均」，不一定等于某个可能的取值 —— 骰子的期望是 3.5。',
  };
};

/* ============================================================
   7. limittheorem —— 大数定律 / 中心极限定理
   ============================================================ */
const limittheorem: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'iid').split(':');

  if (mode === 'chebyshev' || mode === 'bernoulli') {
    const isBern = mode === 'bernoulli';
    return {
      what: isBern
        ? '伯努利大数定律：频率 n_A/n 依概率收敛到概率 p'
        : '切比雪夫大数定律：样本均值依概率收敛到期望',
      controls: [
        int('n', '样本量 n', 1, 200, 40),
        ctrl('pp', '真实概率 p', 0.05, 0.95, 0.01, 0.4, (v) => v.toFixed(2)),
      ],
      view: { x: [0, 210], y: [0, 1] },
      scene: (p, pal) => {
        const n = Math.max(1, Math.round(p.n));
        /* 用确定性伪随机序列算频率 —— 每次画出来一样，便于对照 */
        let hit = 0;
        const pts: { x: number; y: number }[] = [];
        for (let i = 1; i <= n; i++) {
          const r = ((i * 9301 + 49297) % 233280) / 233280;
          if (r < p.pp) hit++;
          pts.push({ x: i, y: hit / i });
        }
        return {
          markers: pts.map((q) => ({ x: q.x, y: q.y, color: pal.cyan(), r: 2 })),
          hlines: [{ y: p.pp, color: pal.emerald(0.8), dash: [5, 4], label: `p = ${fmt(p.pp, 2)}` }],
        };
      },
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        let hit = 0;
        for (let i = 1; i <= n; i++) {
          const r = ((i * 9301 + 49297) % 233280) / 233280;
          if (r < p.pp) hit++;
        }
        const freq = hit / n;
        return [
          { label: '试验次数 n', value: String(n) },
          { label: '频率 n_A/n', value: fmt(freq, 5) },
          { label: '真实概率 p', value: fmt(p.pp, 2) },
          { label: '偏差', value: fmt(Math.abs(freq - p.pp), 5), tone: Math.abs(freq - p.pp) < 0.05 ? 'good' : 'default' },
          { label: '收敛方式', value: '依概率收敛', hint: '不是「必然相等」' },
        ];
      },
      note: '大数定律说的是「依概率收敛」：n 越大，频率偏离 p 的概率越小，但不保证每次都不偏。',
    };
  }

  if (mode === 'demoivre') {
    return {
      what: '棣莫弗-拉普拉斯定理：二项分布当 n 很大时近似正态',
      controls: [
        int('n', '试验次数 n', 5, 120, 30),
        ctrl('pp', '成功概率 p', 0.05, 0.95, 0.01, 0.4, (v) => v.toFixed(2)),
      ],
      view: { x: [-4.5, 4.5], y: [-0.05, 0.6] },
      scene: (p, pal) => {
        const n = Math.max(1, Math.round(p.n));
        const mu = n * p.pp;
        const sig = Math.sqrt(n * p.pp * (1 - p.pp)) || 1;
        const ks: number[] = [];
        const hs: number[] = [];
        for (let k = Math.max(0, Math.round(mu - 4 * sig)); k <= Math.min(n, Math.round(mu + 4 * sig)); k++) {
          ks.push((k - mu) / sig);
          hs.push((comb(n, k) * Math.pow(p.pp, k) * Math.pow(1 - p.pp, n - k)) * sig);
        }
        return {
          bars: [{ at: () => ks, h: () => hs, w: 1 / sig * 0.9, color: pal.cyan(0.5), outline: pal.cyan(0.8) }],
          curves: [{ f: npdf, color: pal.violet(), width: 2.2, label: 'N(0,1) 密度' }],
        };
      },
      readout: (p) => {
        const n = Math.max(1, Math.round(p.n));
        const mu = n * p.pp;
        const sig = Math.sqrt(n * p.pp * (1 - p.pp));
        return [
          { label: 'np', value: fmt(mu, 3) },
          { label: '√(np(1−p))', value: fmt(sig, 3) },
          { label: '标准化', value: '(Yₙ − np)/√(np(1−p)) → N(0,1)' },
          { label: '近似效果', value: n >= 30 ? '很好' : '一般，建议 n 更大', tone: n >= 30 ? 'good' : 'warn' },
        ];
      },
      note: '柱子的宽度是 1/σ，所以柱状图能直接和标准正态密度曲线比 —— 这就是标准化在做的事。',
    };
  }

  /* iid：独立同分布的中心极限定理 */
  return {
    what: '中心极限定理：不管总体是什么分布，样本均值的分布都趋向正态',
    controls: [int('n', '每组样本量 n', 1, 60, 10)],
    view: { x: [-4.5, 4.5], y: [-0.05, 0.7] },
    scene: (p, pal) => {
      const n = Math.max(1, Math.round(p.n));
      /* 用指数分布（明显偏斜）当总体，演示「不管总体什么样，均值都会正态」 */
      const bins = 41;
      const lo = -4; const hi = 4;
      const hist = new Array(bins).fill(0);
      const N = 4000;
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) {
          const r = (((i * 7919 + j * 104729) % 65536) / 65536) || 1e-6;
          s += -Math.log(r);      /* 均值 1 的指数分布 */
        }
        const z = (s / n - 1) / (1 / Math.sqrt(n));   /* 标准化 */
        const b = Math.floor(((z - lo) / (hi - lo)) * bins);
        if (b >= 0 && b < bins) hist[b]++;
      }
      const maxH = Math.max(...hist) || 1;
      const at = hist.map((_, i) => lo + ((i + 0.5) / bins) * (hi - lo));
      return {
        bars: [{ at: () => at, h: () => hist.map((h) => (h / maxH) * 0.55), w: (hi - lo) / bins * 0.9, color: pal.cyan(0.5), outline: pal.cyan(0.75) }],
        curves: [{ f: (x) => npdf(x) * 0.62, color: pal.violet(), width: 2.2, label: 'N(0,1) 密度（缩放后）' }],
      };
    },
    readout: (p) => {
      const n = Math.max(1, Math.round(p.n));
      return [
        { label: '每组样本量 n', value: String(n) },
        { label: '总体分布', value: '指数分布（右偏）' },
        { label: '样本均值的标准差', value: fmt(1 / Math.sqrt(n), 4), hint: 'σ/√n' },
        { label: '近似效果', value: n >= 30 ? '已非常接近正态' : n >= 10 ? '看得出正态的样子了' : '还很偏', tone: n >= 30 ? 'good' : 'default' },
      ];
    },
    note: '总体是明显右偏的指数分布，但样本均值标准化后越来越像正态 —— 这就是中心极限定理的力量。',
  };
};

/* ============================================================
   8. inference —— 抽样分布 / 参数估计 / 区间估计
   ============================================================ */
const inference: DemoRegistry[string] = (variant) => {
  const [mode] = (variant || 'mean').split(':');

  if (mode === 'chi2' || mode === 't') {
    const isT = mode === 't';
    /* Γ(k)，k 是整数或半整数 —— 卡方/t 分布的密度都要用它。
     * 用 Γ(x+1)=xΓ(x) 从 Γ(1/2)=√π 或 Γ(1)=1 起步递推，
     * 比引入 Lanczos 近似简单得多，而且这里只需要半整数点。 */
    const gammaHalf = (k: number): number => {
      const m = Math.round(k * 2);
      if (m % 2 === 0) {
        let r = 1;
        for (let i = 2; i <= m / 2 - 1; i++) r *= i;
        return r;
      }
      let r = Math.sqrt(Math.PI);
      const steps = (m - 1) / 2;
      for (let i = 0; i < steps; i++) r *= 0.5 + i;
      return r;
    };
    return {
      what: isT
        ? 't 分布：(X̄−μ)/(S/√n) ~ t(n−1)，σ 未知时用它'
        : 'χ² 分布：(n−1)S²/σ² ~ χ²(n−1)',
      controls: [int('df', '自由度 n−1', 1, 30, 8)],
      view: isT ? { x: [-5, 5], y: [-0.02, 0.45] } : { x: [0, 30], y: [-0.02, 0.5] },
      scene: (p, pal) => {
        const df = Math.max(1, Math.round(p.df));
        const chi2 = (x: number) => (x <= 0 ? 0
          : Math.pow(x, df / 2 - 1) * Math.exp(-x / 2) / (Math.pow(2, df / 2) * gammaHalf(df / 2)));
        const tdens = (x: number) => {
          const c = gammaHalf((df + 1) / 2) / (Math.sqrt(df * Math.PI) * gammaHalf(df / 2));
          return c * Math.pow(1 + (x * x) / df, -(df + 1) / 2);
        };
        return {
          curves: isT
            ? [
              { f: tdens, color: pal.violet(), label: `t(${df})` },
              { f: npdf, color: pal.text(0.35), width: 1.5, dash: [4, 4], label: 'N(0,1) 对照' },
            ]
            : [{ f: chi2, color: pal.violet(), label: `χ²(${df})` }],
        };
      },
      readout: (p) => {
        const df = Math.max(1, Math.round(p.df));
        return [
          { label: '自由度', value: String(df) },
          isT
            ? { label: 'E = 0, D = n/(n−2)', value: df > 2 ? fmt(df / (df - 2), 3) : '不存在', hint: 'n≤2 时方差不存在' }
            : { label: 'E = n, D = 2n', value: `${df}, ${2 * df}` },
          { label: isT ? 'n→∞ 时' : 'n 很大时', value: isT ? '趋近标准正态' : '趋近正态', tone: 'good' },
          { label: '用途', value: isT ? 'σ 未知时对 μ 做区间估计与检验' : '对方差做区间估计与检验' },
        ];
      },
      note: isT
        ? 't 分布比标准正态「胖」—— 尾巴更厚，所以区间更宽。自由度越大越接近正态。'
        : 'χ² 分布不对称、只取正值，形状由自由度决定。',
    };
  }

  if (mode === 'moment' || mode === 'likelihood' || mode === 'mle' || mode === 'unbiased') {
    return {
      what: mode === 'likelihood' || mode === 'mle'
        ? '极大似然估计：让观测到的这组样本出现概率最大的那个参数，就是估计值'
        : '矩估计：用样本矩去替换总体矩，解出参数',
      controls: [
        ctrl('theta', '候选参数 θ', 0.1, 3, 0.02, 1, (v) => v.toFixed(2)),
        ctrl('xbar', '样本均值 x̄', 0.1, 3, 0.02, 1.2, (v) => v.toFixed(2)),
      ],
      view: { x: [0, 3.2], y: [-0.05, 2.2] },
      scene: (p, pal) => {
        /* 指数分布 Exp(θ) 的似然（n=10 的样本，均值 x̄）：
         * L(θ) = θ^n e^{−nθx̄}，对数似然 n lnθ − nθx̄ */
        const n = 10;
        const ll = (th: number) => (th <= 0 ? -1e3 : n * Math.log(th) - n * th * p.xbar);
        return {
          curves: [
            { f: (th) => Math.exp(ll(th) / 8) * 0.9, color: pal.violet(), label: '似然函数 L(θ)（缩放）' },
            { f: (th) => (th <= 0 ? NaN : ll(th) / 10 + 1.2), color: pal.cyan(), width: 1.8, label: '对数似然 ln L(θ)' },
          ],
          vlines: [
            { x: 1 / p.xbar, color: pal.emerald(0.85), dash: [4, 3], label: 'θ̂ = 1/x̄（MLE）' },
            { x: (pp) => pp.theta, color: pal.amber(0.8), dash: [3, 3], label: '当前 θ' },
          ],
          markers: [{ x: (pp) => pp.theta, y: (pp) => (pp.theta <= 0 ? NaN : ll(pp.theta) / 10 + 1.2), color: pal.amber(), r: 4 }],
        };
      },
      readout: (p) => {
        const n = 10;
        const ll = (th: number) => n * Math.log(th) - n * th * p.xbar;
        return [
          { label: '样本均值 x̄', value: fmt(p.xbar, 3) },
          { label: '对数似然 ln L(θ)', value: fmt(ll(p.theta), 4) },
          { label: 'MLE：θ̂ = 1/x̄', value: fmt(1 / p.xbar, 4), tone: 'good' },
          { label: '矩估计：θ̂ = 1/x̄', value: fmt(1 / p.xbar, 4), hint: '这个例子里两者恰好相同' },
          { label: '无偏性', value: mode === 'unbiased' ? 'E(θ̂) ≠ θ，需要修正' : 'E(θ̂) = θ', tone: mode === 'unbiased' ? 'warn' : 'good' },
          { label: 'd lnL/dθ = 0', value: `n/θ − n x̄ = 0 ⇒ θ = 1/x̄` },
        ];
      },
      note: '极大似然的做法固定：写似然 → 取对数 → 求导等于零 → 解出参数。取对数是为了把乘积变成和。',
    };
  }

  /* 区间估计与假设检验 */
  if (mode === 'ci_known' || mode === 'ci_unknown') {
    const known = mode === 'ci_known';
    return {
      what: known
        ? 'μ 的置信区间（σ 已知）：x̄ ± u_{α/2}·σ/√n'
        : 'μ 的置信区间（σ 未知）：x̄ ± t_{α/2}(n−1)·S/√n',
      controls: [
        ctrl('xbar', '样本均值 x̄', -2, 2, 0.05, 0.3, (v) => v.toFixed(2)),
        int('n', '样本量 n', 2, 80, 16),
        ctrl('level', '置信水平', 0.5, 0.99, 0.01, 0.95, (v) => `${(v * 100).toFixed(0)}%`),
      ],
      view: { x: [-2.5, 2.5], y: [-1, 1] },
      readout: (p) => {
        const n = Math.max(2, Math.round(p.n));
        /* 常用置信水平对应的分位点，避免引入反函数求值 */
        const u = p.level >= 0.99 ? 2.576 : p.level >= 0.975 ? 2.24 : p.level >= 0.95 ? 1.96 : p.level >= 0.9 ? 1.645 : 1.15;
        const se = 1 / Math.sqrt(n);
        const half = u * se;
        return [
          { label: '标准误 σ/√n', value: fmt(se, 4), hint: 'σ 取 1 作示例' },
          { label: '分位点', value: known ? `u_{α/2} = ${fmt(u, 3)}` : `t_{α/2}(n−1) ≈ ${fmt(u * 1.05, 3)}`, hint: 't 比 u 略大' },
          { label: '半宽', value: fmt(half, 4) },
          { label: '置信区间', value: `[${fmt(p.xbar - half, 3)}, ${fmt(p.xbar + half, 3)}]`, tone: 'good' },
          { label: 'n 翻倍', value: `半宽变为 ${fmt(half / Math.SQRT2, 4)}`, hint: '半宽 ∝ 1/√n，不是 1/n' },
          { label: '置信水平的含义', value: `${(p.level * 100).toFixed(0)}% 的区间会盖住真值`, hint: '不是「真值落在这个区间里的概率」' },
        ];
      },
      custom: (ctx, W, H, p, pal) => {
        const n = Math.max(2, Math.round(p.n));
        const u = p.level >= 0.99 ? 2.576 : p.level >= 0.95 ? 1.96 : p.level >= 0.9 ? 1.645 : 1.15;
        const half = u / Math.sqrt(n);
        const y = H / 2;
        const X = (v: number) => W / 2 + v * (W / 6);
        ctx.save();
        ctx.strokeStyle = pal.axis;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W - 30, y); ctx.stroke();
        /* 真值 μ = 0 */
        ctx.strokeStyle = pal.emerald();
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(X(0), y - 40); ctx.lineTo(X(0), y + 40); ctx.stroke();
        ctx.fillStyle = pal.emerald();
        ctx.font = '12px "PingFang SC", system-ui, sans-serif';
        ctx.fillText('真值 μ = 0', X(0) + 6, y - 46);
        /* 置信区间 */
        ctx.strokeStyle = pal.violet();
        ctx.lineWidth = 6;
        ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(X(p.xbar - half), y); ctx.lineTo(X(p.xbar + half), y); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.violet();
        ctx.beginPath(); ctx.arc(X(p.xbar), y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillText('x̄', X(p.xbar) - 4, y + 24);
        /* 是否盖住真值 */
        const covers = p.xbar - half <= 0 && p.xbar + half >= 0;
        ctx.fillStyle = covers ? pal.emerald() : pal.rose();
        ctx.fillText(covers ? '这个区间盖住了真值' : '这个区间没盖住真值', 30, H - 16);
        ctx.restore();
      },
      note: '「95% 置信区间」的意思是：反复抽样构造的区间里，有 95% 会盖住真值 —— 不是真值有 95% 的概率落在里面。',
    };
  }

  if (mode === 'errors') {
    return {
      what: '假设检验的两类错误：α 是「弃真」，β 是「取伪」',
      controls: [
        ctrl('alpha', '显著性水平 α', 0.01, 0.3, 0.005, 0.05, (v) => v.toFixed(3)),
      ],
      view: { x: [-4, 8], y: [-0.05, 0.5] },
      scene: (p, pal) => ({
        curves: [
          { f: (x) => npdf(x), color: pal.violet(), label: 'H₀ 成立时 X̄ 的分布' },
          { f: (x) => npdf(x - 3), color: pal.cyan(), label: 'H₁ 成立时 X̄ 的分布' },
        ],
        fills: [{ from: (pp) => 1.645 + (pp.alpha - 0.05) * 4, to: 8, top: npdf, color: pal.rose(), alpha: 0.3 }],
        vlines: [{ x: (pp) => 1.645 + (pp.alpha - 0.05) * 4, color: pal.rose(0.9), dash: [4, 3], label: '拒绝域边界' }],
      }),
      readout: (p) => {
        const crit = 1.645 + (p.alpha - 0.05) * 4;
        return [
          { label: 'α（第一类错误）', value: fmt(p.alpha, 3), hint: 'H₀ 为真却拒绝 → 弃真', tone: 'warn' },
          { label: '拒绝域边界', value: fmt(crit, 3) },
          { label: 'β（第二类错误）', value: fmt(1 - ncdf(crit - 3), 4), hint: 'H₀ 为假却接受 → 取伪' },
          { label: 'α 与 β 的关系', value: '此消彼长', hint: '想两个都小，只能加大样本量' },
          { label: 'p 值', value: '观测到的显著性水平', hint: 'p < α 就拒绝 H₀' },
        ];
      },
      note: 'α 和 β 不能同时变小 —— 唯一的办法是增加样本量。这是假设检验里最反直觉的一条。',
    };
  }

  /* mean / meanvar：样本均值与样本方差 */
  return {
    what: '样本均值的分布：x̄ ~ N(μ, σ²/n) —— 样本量越大，均值越集中',
    controls: [
      int('n', '样本量 n', 1, 100, 16),
      ctrl('sig', '总体标准差 σ', 0.3, 3, 0.05, 1, (v) => v.toFixed(2)),
    ],
    view: { x: [-3.5, 3.5], y: [-0.05, 1.6] },
    scene: (p, pal) => {
      const n = Math.max(1, Math.round(p.n));
      const se = p.sig / Math.sqrt(n);
      return {
        curves: [
          { f: (x) => npdf(x / p.sig) / p.sig, color: pal.text(0.4), width: 1.6, dash: [4, 4], label: '总体分布 N(0, σ²)' },
          { f: (x) => npdf(x / se) / se, color: pal.violet(), label: `样本均值分布 N(0, σ²/${n})` },
        ],
        vlines: [{ x: 0, color: pal.emerald(0.7), dash: [3, 3], label: 'μ' }],
        fills: [{ from: (pp) => -pp.sig, to: (pp) => pp.sig, top: (x) => npdf(x / p.sig) / p.sig, color: pal.text(0.5), alpha: 0.08 }],
      };
    },
    readout: (p) => {
      const n = Math.max(1, Math.round(p.n));
      const se = p.sig / Math.sqrt(n);
      return [
        { label: '总体标准差 σ', value: fmt(p.sig, 3) },
        { label: '标准误 σ/√n', value: fmt(se, 4), tone: 'good' },
        { label: 'D(x̄)', value: fmt(se * se, 5), hint: '= σ²/n' },
        { label: 'n 翻倍', value: `标准误缩小到 ${fmt(se / Math.SQRT2, 4)}`, hint: '精度按 √n 提升，不是 n' },
        { label: 'E(S²)', value: fmt(p.sig * p.sig, 4), hint: '样本方差是总体方差的无偏估计' },
      ];
    },
    note: '分母为什么是 n−1？因为用 x̄ 代替 μ 会「吃掉」一个自由度，不修正就是有偏估计。',
  };
};

export const PROB_DEMOS: DemoRegistry = {
  venn,
  bayes,
  classic,
  dist,
  joint,
  moments,
  limittheorem,
  inference,
};

export const PROB_KINDS = Object.keys(PROB_DEMOS);
