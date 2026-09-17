import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* 数字滚动
 * 直接跳到目标值会让人怀疑「是不是没更新」；滚动过去才有"涨了"的实感。
 * 缓动用 easeOutExpo，前段快后段稳，读起来最舒服。
 */
export function NumberTicker({
  value,
  duration = 950,
  decimals = 0,
  prefix = '',
  suffix = '',
  className,
}: {
  value: number;
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number.isFinite(value) ? value : 0;
    if (from === to) { setDisplay(to); return; }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setDisplay(to); fromRef.current = to; return; }

    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3.2);
      setDisplay(from + (to - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return (
    <span className={cn('tabular', className)}>
      {prefix}
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/* 鼠标跟随的 3D 倾斜卡片
 *
 * 关键在克制：最大倾角 6° 左右就够了。倾到 15° 会像廉价 PPT 特效，
 * 而且文字会明显变形、读起来费劲。
 * 内部用 .tilt-layer 抬起的元素会浮在卡片上方，产生真实纵深。
 */
export function TiltCard({
  children,
  className,
  max = 6,
  scale = 1.012,
  glare = true,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
  scale?: number;
  glare?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = bodyRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const rx = (0.5 - py) * max * 2;
      const ry = (px - 0.5) * max * 2;
      el.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg) scale(${scale})`;
      el.style.setProperty('--mx', `${px * 100}%`);
      el.style.setProperty('--my', `${py * 100}%`);
    });
  };

  const reset = () => {
    const el = bodyRef.current;
    if (!el) return;
    cancelAnimationFrame(rafRef.current);
    el.style.transform = 'rotateX(0deg) rotateY(0deg) scale(1)';
  };

  return (
    <div
      className={cn('tilt-scene', className)}
      onPointerMove={onMove}
      onPointerLeave={reset}
    >
      <div ref={bodyRef} className="tilt-body h-full">
        {children}
        {glare && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{
              background:
                'radial-gradient(300px circle at var(--mx, 50%) var(--my, 50%), rgba(255,255,255,0.07), transparent 62%)',
            }}
          />
        )}
      </div>
    </div>
  );
}

/* 进度环：SVG 描边动画。仪表盘上比进度条更有"仪式感"。 */
export function ProgressRing({
  value,
  size = 96,
  stroke = 7,
  label,
  sublabel,
  gradient = ['#22d3ee', '#a855f7'],
  className,
}: {
  value: number;              // 0-100
  size?: number;
  stroke?: number;
  label?: ReactNode;
  sublabel?: ReactNode;
  gradient?: [string, string] | string[];
  className?: string;
}) {
  const id = useRef('ring-' + Math.random().toString(36).slice(2, 9)).current;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const [dash, setDash] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDash((v / 100) * c), 90);
    return () => clearTimeout(t);
  }, [v, c]);

  return (
    <div className={cn('relative inline-grid place-items-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={gradient[0]} />
            <stop offset="100%" stopColor={gradient[1]} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.075)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - dash}
          style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(0.16,1,0.3,1)' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center leading-none">
        {label}
        {sublabel && <div className="mt-1 text-[10px] text-fg-mute">{sublabel}</div>}
      </div>
    </div>
  );
}

/* 横向进度条 */
export function Meter({
  value,
  className,
  barClassName,
  from = '#22d3ee',
  to = '#a855f7',
  height = 6,
}: {
  value: number;
  className?: string;
  barClassName?: string;
  from?: string;
  to?: string;
  height?: number;
}) {
  const v = Math.max(0, Math.min(100, value));
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setW(v), 80);
    return () => clearTimeout(t);
  }, [v]);
  return (
    <div
      className={cn('w-full overflow-hidden rounded-full bg-white/6', className)}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full', barClassName)}
        style={{
          width: `${w}%`,
          background: `linear-gradient(90deg, ${from}, ${to})`,
          transition: 'width 1s cubic-bezier(0.16,1,0.3,1)',
          boxShadow: `0 0 12px -2px ${from}88`,
        }}
      />
    </div>
  );
}

/* 鼠标跟随光晕容器（配合 CSS .spotlight） */
export function Spotlight({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    el.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };
  return (
    <div ref={ref} className={cn('spotlight', className)} onPointerMove={onMove}>
      {children}
    </div>
  );
}
