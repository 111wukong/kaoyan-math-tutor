import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* ============================================================
   HUD 装饰层 —— 把"玻璃卡片"变成"仪表读数区"
   ============================================================
   为什么需要这一层：
   深色 + 玻璃 + 圆角 + 渐变强调色，这套组合在 2024–2025 年已经被
   所有 AI 产品用烂了 —— 换个 logo 就能套在任何一个 SaaS 上。
   问题不在配色，在**结构语言**：那些界面看起来像"网页"，
   不像"仪器"。数学工具本该像精密仪表盘，有刻度、有编号、有读数。

   这一层只做四件事，都跟"仪器感"直接相关：
     1. 四角角标（corner bracket）—— 划定"读数区域"的边界
     2. 刻度尺（tick rule）—— 让宽度有"量程"的暗示
     3. 等宽编号与读数 —— 数字用 tabular，带前导零
     4. 指针跟随的描边高光 —— 卡片有"被照亮"的方向感

   纪律：装饰一律 aria-hidden，且全部 pointer-events-none ——
   它们绝不能挡住底下的按钮。 */
/* ============================================================ */

const TONE = {
  cyan: { line: 'border-cyan/45', glow: 'rgba(34,211,238,0.55)', text: 'text-cyan-200/80' },
  blue: { line: 'border-blue/45', glow: 'rgba(59,130,246,0.55)', text: 'text-blue-200/80' },
  violet: { line: 'border-violet/45', glow: 'rgba(168,85,247,0.55)', text: 'text-violet-200/80' },
  emerald: { line: 'border-emerald/45', glow: 'rgba(52,211,153,0.55)', text: 'text-emerald-200/80' },
  amber: { line: 'border-amber/45', glow: 'rgba(251,191,36,0.55)', text: 'text-amber-200/80' },
  rose: { line: 'border-rose/45', glow: 'rgba(251,113,133,0.55)', text: 'text-rose-200/80' },
} as const;

export type HudTone = keyof typeof TONE;

/** 把 tone 的半透明色改成指定 alpha。用于同一色系里区分"刻度"和"主刻度"。 */
function withAlpha(rgba: string, a: number): string {
  return rgba.replace(/[\d.]+\)$/, `${a})`);
}

/* ---------- 四角角标 ----------
 * 放在一个 relative 容器里，四条 L 形短线贴四角。
 * 每条只画两个边（border-l + border-t 之类），所以看起来是"框角"而不是"边框" ——
 * 完整边框会退回成普通卡片，只有角标才有"取景框"的意思。 */
export function HudCorners({
  tone = 'cyan',
  size = 10,
  className,
}: {
  tone?: HudTone;
  /** 角标臂长（px） */
  size?: number;
  className?: string;
}) {
  const c = TONE[tone].line;
  const s = { width: size, height: size };
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0', className)}>
      <span className={cn('absolute left-0 top-0 border-l border-t', c)} style={s} />
      <span className={cn('absolute right-0 top-0 border-r border-t', c)} style={s} />
      <span className={cn('absolute bottom-0 left-0 border-b border-l', c)} style={s} />
      <span className={cn('absolute bottom-0 right-0 border-b border-r', c)} style={s} />
    </div>
  );
}

/* ---------- 刻度条 ----------
 * 一条带等距刻度的细线。用 repeating-linear-gradient 画，**不生成 DOM 节点** ——
 * 一条 1200px 宽、8px 间距的尺子是 150 个刻度，
 * 换成 150 个 span 是不可接受的（一个页面十几条就是两千个节点）。 */
export function TickRule({
  className,
  tone = 'cyan',
  /** 刻度间距（px）。8 左右像尺子，20 以上像虚线。 */
  gap = 8,
  height = 5,
  /** 每 N 格加一根更长更亮的主刻度 */
  major = 5,
}: {
  className?: string;
  tone?: HudTone;
  gap?: number;
  height?: number;
  major?: number;
}) {
  const glow = TONE[tone].glow;
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none w-full', className)}
      style={{
        height,
        backgroundImage: [
          `repeating-linear-gradient(90deg, ${withAlpha(glow, 0.62)} 0 1px, transparent 1px ${gap * major}px)`,
          `repeating-linear-gradient(90deg, ${withAlpha(glow, 0.28)} 0 1px, transparent 1px ${gap}px)`,
        ].join(', '),
      }}
    />
  );
}

/* ---------- 等宽读数 ---------- */
export function Readout({
  label,
  value,
  unit,
  tone = 'cyan',
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: HudTone;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline gap-1.5', className)}>
      <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-fg-faint">{label}</span>
      <span className={cn('font-mono text-[12.5px] font-semibold leading-none tabular', TONE[tone].text)}>{value}</span>
      {unit && <span className="text-[10px] text-fg-faint">{unit}</span>}
    </div>
  );
}

/* ---------- HUD 面板 ----------
 * 玻璃面板 + 角标 + 顶部刻度 + 悬停扫描线 + 指针跟随描边高光。
 * 本层的主力组件：仪表盘/统计页的卡片换成它，观感立刻从"网页卡片"
 * 变成"仪表读数区"。
 *
 * 扫描线只在 hover 时跑 —— 十几张卡片同时跑，既费电又让人分心，
 * 而"悬停才亮"反而更像仪器在响应你。 */
export function HudPanel({
  children,
  className,
  tone = 'cyan',
  /** 左上角编号，如 3 → 显示 "03"。传了才占位。 */
  index,
  /** 右上角小标签，如 "LIVE" / "SM-2" */
  tag,
  corners = true,
  ticks = false,
  sweep = false,
  onPointerMove,
  style,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  tone?: HudTone;
  index?: string | number;
  tag?: ReactNode;
  corners?: boolean;
  ticks?: boolean;
  sweep?: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  /* 指针位置写进 --mx / --my，供 CSS 的径向高光定位。
   * 用 rAF 节流没太大必要 —— 只是两次 style 写入，浏览器会自己批处理；
   * 真正贵的是那层 radial-gradient 的重绘，而它只在 hover 时可见。 */
  const track = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(e);
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  };

  const hasHeader = index !== undefined || tag !== undefined;

  return (
    <div
      ref={ref}
      onPointerMove={track}
      className={cn('glass hud-edge group/hud relative rounded-xl', className)}
      style={{ ['--hud-glow' as string]: TONE[tone].glow, ...style }}
      {...rest}
    >
      {corners && <HudCorners tone={tone} />}

      {hasHeader && (
        <div className="relative flex items-center justify-between gap-3 px-3.5 pb-1 pt-2.5">
          {index !== undefined && (
            <span className={cn('font-mono text-[10.5px] font-semibold leading-none tabular', TONE[tone].text)}>
              {typeof index === 'number' ? String(index).padStart(2, '0') : index}
            </span>
          )}
          {tag !== undefined && (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-fg-faint">{tag}</span>
          )}
        </div>
      )}

      {ticks && <TickRule tone={tone} className="relative opacity-50" />}

      <div className="relative">{children}</div>

      {sweep && <div aria-hidden className="hud-sweep" />}
    </div>
  );
}

/* ---------- 仪表读数卡 ----------
 * 跟 Primitives 里的 StatCard 的区别：
 *   1. 有编号（01/02/03/04）—— 一排卡片立刻从"四个方块"变成"四个通道"
 *   2. 数值用等宽 + 补零，带单位槽
 *   3. 底部压一把刻度尺，宽度有了"量程"
 *   4. 悬停时边线在指针附近亮起 + 一条扫描线掠过
 * 数据接口刻意跟 StatCard 保持一致，换起来不用改调用方。 */
export function HudStatCard({
  index,
  label,
  value,
  unit,
  sub,
  icon,
  tone = 'cyan',
  meter,
  delay = 0,
  className,
}: {
  index?: string | number;
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: HudTone;
  /** 0–100。传了就画进度条。 */
  meter?: number;
  delay?: number;
  className?: string;
}) {
  const v = meter === undefined ? null : Math.max(0, Math.min(100, meter));
  return (
    <HudPanel
      index={index}
      tag={icon}
      tone={tone}
      sweep
      ticks
      className={cn('rise-in overflow-hidden', className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="px-3.5 pb-3.5 pt-1">
        <div className="text-[11.5px] font-medium tracking-wide text-fg-mute">{label}</div>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="font-mono text-[24px] font-semibold leading-none tracking-tight text-fg tabular">
            {value}
          </span>
          {unit && <span className="text-[11px] text-fg-faint">{unit}</span>}
        </div>
        {v !== null && (
          <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-white/6">
            <div
              className="h-full rounded-full"
              style={{
                width: `${v}%`,
                background: `linear-gradient(90deg, ${TONE[tone].glow}, transparent)`,
                boxShadow: `0 0 10px -2px ${TONE[tone].glow}`,
                transition: 'width 1s cubic-bezier(0.16,1,0.3,1)',
              }}
            />
          </div>
        )}
        {sub && <div className="mt-2 text-[11.5px] leading-snug text-fg-mute">{sub}</div>}
      </div>
    </HudPanel>
  );
}

/* ---------- 区块标题（仪器版） ----------
 * 跟 Primitives 里那个 SectionTitle 的区别：多了编号与刻度线 ——
 * 标题变"量程标签"，下面压一把尺子。 */
export function HudSectionTitle({
  index,
  title,
  desc,
  right,
  tone = 'cyan',
  className,
}: {
  index?: string | number;
  title: ReactNode;
  desc?: ReactNode;
  right?: ReactNode;
  tone?: HudTone;
  className?: string;
}) {
  return (
    <div className={cn('mb-3', className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-2.5">
          {index !== undefined && (
            <span className={cn('font-mono text-[11px] font-semibold leading-none tabular', TONE[tone].text)}>
              {typeof index === 'number' ? String(index).padStart(2, '0') : index}
            </span>
          )}
          <h2 className="text-[15.5px] font-semibold tracking-tight text-fg">{title}</h2>
        </div>
        {right}
      </div>
      {desc && <p className="mt-1 text-[12.5px] leading-relaxed text-fg-mute">{desc}</p>}
      <TickRule tone={tone} className="mt-2 opacity-30" gap={9} height={4} />
    </div>
  );
}
