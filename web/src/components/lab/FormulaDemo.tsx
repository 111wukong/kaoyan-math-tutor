import { useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, RotateCcw } from 'lucide-react';
import { InlineMath } from '@/components/ui/Math';
import { canvasColor } from '@/components/fx/theme-colors';
import { cssVar, cn } from '@/lib/utils';
import { useTheme } from '@/stores/theme';
import type { Formula } from '@/lib/api';
import { drawScene, type Palette, type Params } from '@/lib/demo/plot';
import { demoFor } from '@/lib/demo/classify';
import { demoOf } from '@/lib/demo';

/* 单条公式的交互演示
 *
 * ── 它和 Lab.tsx 里原来那 4 个手写 canvas 的区别 ──────────────────
 * 原来每个演示都要自己写网格、坐标轴、曲线、标注。现在这些都在
 * lib/demo/plot.ts 里，演示定义只声明「画什么」（见 lib/demo/kinds/*）。
 * 所以这个组件对 257 条公式是同一套代码 —— 这正是「每条公式都有演示」
 * 能成立的前提。
 *
 * ── 颜色必须在这里取 ──────────────────────────────────────────────
 * canvas 只吃具体颜色字符串，塞不进 Tailwind 类名。所以调色板由这个组件
 * 按当前主题构造后传给演示。写死的话亮色主题下就是白压白 ——
 * 标注承载的是「n = 4」「近似有效区间」这类关键信息，看不见就等于没画。
 *
 * ★ 调色板的每个函数都是**绘制时才求值**的（写成箭头函数而不是常量），
 *   否则会在组件挂载那一刻把颜色冻结住，切主题不更新。
 */
export function FormulaDemo({ formula, compact = false }: { formula: Formula; compact?: boolean }) {
  const spec = useMemo(() => demoFor(formula), [formula]);
  const def = useMemo(() => (spec ? demoOf(spec.kind, spec.variant) : null), [spec]);

  const palette = useDemoPalette();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /* ---------- 参数 ----------
   *
   * ★ 这里只存**用户拖过的值**，完整的参数表在渲染期算出来。
   *
   * 为什么不能像原来那样「useState 存一份完整的 params，换演示时用 useEffect 重置」：
   *   useEffect 在**提交之后**才跑，而 def 已经变了的那一次渲染里，
   *   params 还是**上一条公式**的表。两条公式的控件键不一样时
   *   （比如从 `{x}` 切到 `{x0}`），`params[c.key]` 就是 undefined，
   *   Slider 拿它去调 `toFixed` 直接抛 TypeError ——
   *   整个实验室页面被 ErrorBoundary 替换成「页面出错了」。
   *   实测 257 条里有 7 条一点就崩，全是这个原因。
   *
   * 现在的写法把「每个控件都一定有一个数」变成**结构性保证**：
   *   `touched[k] ?? c.init` —— 缺键就退回该控件的初值，
   *   永远不可能把 undefined 交给 Slider。
   */
  const [touched, setTouched] = useState<Params>({});
  const [lastDef, setLastDef] = useState(def);

  /* 换演示时清掉用户拖过的值。
   * 这是 React 认可的「渲染期调整 state」写法（只对自己 setState）——
   * React 会在本次渲染返回后**立刻**重渲染，不会有一次带着旧值的提交，
   * 所以既不会闪一下旧值，也不会有 useEffect 那种「晚一帧」的窗口。 */
  if (def !== lastDef) {
    setLastDef(def);
    setTouched({});
  }

  const params = useMemo<Params>(() => {
    const p: Params = {};
    for (const c of def?.controls || []) p[c.key] = touched[c.key] ?? c.init;
    return p;
  }, [def, touched]);

  const reset = () => setTouched({});

  const height = compact ? 220 : 320;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !def) return;

    let raf = 0;
    const setup = () => {
      const rect = wrap.getBoundingClientRect();
      if (rect.width < 10) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = rect.width;
      const H = height;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.height = `${H}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (def.custom) {
        ctx.clearRect(0, 0, W, H);
        try {
          def.custom(ctx, W, H, params, palette);
        } catch (e) {
          /* 演示代码抛异常不该让整页白屏。画一句提示，用户至少知道发生了什么。
           * （正常情况下 tests/formula-demos.mjs 已经把这类问题拦在 CI 里了） */
          ctx.save();
          ctx.fillStyle = palette.rose(0.9);
          ctx.font = '12px "PingFang SC", system-ui, sans-serif';
          ctx.fillText('这个演示渲染出错了', 14, 22);
          ctx.restore();
        }
        return;
      }

      const view = typeof def.view === 'function' ? def.view(params) : def.view;
      drawScene(ctx, W, H, view, def.scene!(params, palette), params, palette);
    };

    setup();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(setup);
    });
    ro.observe(wrap);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [def, params, palette, height]);

  if (!spec || !def) {
    return (
      <div className="rounded-xl border border-hairline bg-veil/3 px-3.5 py-3 text-[12.5px] leading-relaxed text-fg-mute">
        这条公式还没有配交互演示。
        <span className="text-fg-faint">
          （公式库里新加的分组需要同步在 lib/demo/classify.ts 里加一条规则，
          测试会拦住这种情况）
        </span>
      </div>
    );
  }

  const readout = def.readout(params);

  return (
    <div className={cn('space-y-3', compact && 'space-y-2.5')}>
      {/* 演示在演示什么 */}
      <div className="flex items-start gap-2">
        <FlaskConical size={13} className="mt-[3px] shrink-0 text-violet" />
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-fg-soft">{def.what}</p>
      </div>

      {/* 公式本体。compact 模式（公式手册里就地展开）不重复渲染 ——
          卡片上方刚显示过公式和条件，再来一遍纯属占地方。 */}
      {!compact && (
        <div className="overflow-x-auto rounded-xl border border-veil/8 bg-veil/3 px-3 py-2 text-center">
          <InlineMath text={`$$${formula.tex}$$`} />
          {formula.cond && (
            <div className="mt-1 text-[11px] text-fg-mute">
              条件 <InlineMath text={`$${formula.cond}$`} className="text-amber-200/90" />
            </div>
          )}
        </div>
      )}

      <div className={cn('grid gap-3', compact ? 'lg:grid-cols-1' : 'lg:grid-cols-[1.6fr_1fr]')}>
        {/* 画布 */}
        <div className="relative overflow-hidden rounded-xl border border-veil/8 bg-veil/2 p-2">
          <div ref={wrapRef}>
            <canvas ref={canvasRef} className="w-full rounded-lg" aria-label={`${formula.name} 的交互演示`} />
          </div>
        </div>

        {/* 控件 + 读数 */}
        <div className="space-y-3">
          <div className="space-y-3 rounded-xl border border-veil/8 bg-veil/3 px-3 py-3">
            {def.controls.map((c) => (
              <Slider
                key={c.key}
                label={c.label}
                value={params[c.key]}
                min={c.min}
                max={c.max}
                step={c.step}
                fmt={c.fmt}
                onChange={(v) => setTouched((prev) => ({ ...prev, [c.key]: v }))}
              />
            ))}
            <button
              onClick={reset}
              className="flex items-center gap-1.5 text-[11.5px] text-fg-faint transition-colors hover:text-fg-soft"
            >
              <RotateCcw size={11} /> 复位
            </button>
          </div>

          <div className="space-y-1 rounded-xl border border-veil/8 bg-veil/3 px-3 py-2.5">
            {readout.map((r, i) => (
              <div key={`${r.label}-${i}`} className="flex items-baseline justify-between gap-3 py-[3px]">
                <span className="shrink-0 text-[11.5px] text-fg-mute">{r.label}</span>
                <span
                  className={cn(
                    'min-w-0 truncate text-right font-mono text-[12px] tabular',
                    r.tone === 'good' ? 'text-emerald-200' : r.tone === 'warn' ? 'text-amber-200' : 'text-fg-soft',
                  )}
                  title={r.hint ? `${r.value} —— ${r.hint}` : String(r.value)}
                >
                  {r.value}
                </span>
              </div>
            ))}
            {readout.some((r) => r.hint) && (
              <div className="mt-1 border-t border-veil/6 pt-1.5 text-[11px] leading-relaxed text-fg-faint">
                {readout.filter((r) => r.hint).map((r) => (
                  <div key={`${r.label}-h`}>· {r.hint}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {def.note && (
        <p className="text-[12px] leading-relaxed text-fg-mute">
          <span className="text-fg-faint">一句话 · </span>{def.note}
        </p>
      )}
    </div>
  );
}

/** 按当前主题构造画布调色板。必须在**绘制时**求值，不能冻结成常量。 */
function useDemoPalette(): Palette {
  const themeId = useTheme((s) => s.id);
  return useMemo(() => ({
    cyan: (a = 1) => canvasColor('--color-cyan', a, '#22d3ee'),
    violet: (a = 1) => canvasColor('--color-violet', a, '#a855f7'),
    emerald: (a = 1) => canvasColor('--color-emerald', a, '#34d399'),
    amber: (a = 1) => canvasColor('--color-amber', a, '#fbbf24'),
    rose: (a = 1) => canvasColor('--color-rose', a, '#fb7185'),
    blue: (a = 1) => canvasColor('--color-blue', a, '#3b82f6'),
    text: (a = 0.75) => canvasColor('--color-fg-soft', a, '#a8b0c6'),
    /* 网格与坐标轴走 CSS 令牌本身（它们已经是颜色，不需要再拼透明度） */
    mesh: cssVar('--mesh-line', canvasColor('--color-fg-soft', 0.055, '#a8b0c6')),
    axis: cssVar('--color-hairline-strong', canvasColor('--color-fg-soft', 0.2, '#a8b0c6')),
  }), [themeId]);
}

function Slider({
  label, value, min, max, step, onChange, fmt,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; fmt?: (v: number) => string;
}) {
  const text = fmt ? fmt(value) : Number.isInteger(step) ? String(value) : value.toFixed(2);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11.5px]">
        <span className="text-fg-soft">{label}</span>
        <span className="font-mono tabular text-cyan">{text}</span>
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
          [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan
          slider-glow
          [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-115
          [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-cyan"
      />
    </div>
  );
}
