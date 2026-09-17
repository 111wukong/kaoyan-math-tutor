import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { addDays, todayStr } from '@/lib/utils';

/* 学习热力图：26 周 × 7 天
 *
 * 两个设计决定：
 *   1. 从今天往回排，而不是从"年初"排 —— 用户关心的是最近，不是日历；
 *   2. 有作答但很少的日子也要有颜色（1-4 档）—— 只标"有/无"会抹掉"我今天只做了 2 题"这种信息。
 */
export function Heatmap({
  data,
  weeks = 26,
  className,
}: {
  data: { date: string; n: number; c: number }[];
  weeks?: number;
  className?: string;
}) {
  const [hover, setHover] = useState<{ date: string; n: number; c: number; x: number; y: number } | null>(null);

  const map = useMemo(() => new Map(data.map((d) => [d.date, d])), [data]);

  const { cols, maxN, totalDays, totalAttempts } = useMemo(() => {
    const today = todayStr();
    // 找到本周的周日，作为网格最后一天的锚点
    const [ty, tm, td] = today.split('-').map(Number);
    const todayDate = new Date(ty, tm - 1, td);
    const dow = todayDate.getDay();            // 0=周日
    const lastSaturday = addDays(today, 6 - dow); // 本周末（周六）
    const start = addDays(lastSaturday, -(weeks * 7 - 1));

    const cells: { date: string; n: number; c: number }[] = [];
    let m = 0;
    let days = 0;
    let attempts = 0;
    for (let i = 0; i < weeks * 7; i++) {
      const date = addDays(start, i);
      const rec = map.get(date) || { date, n: 0, c: 0 };
      if (rec.n > m) m = rec.n;
      if (rec.n > 0) days += 1;
      attempts += rec.n;
      cells.push(rec);
    }

    const c: { date: string; n: number; c: number }[][] = [];
    for (let w = 0; w < weeks; w++) c.push(cells.slice(w * 7, w * 7 + 7));

    return { cols: c, maxN: m, totalDays: days, totalAttempts: attempts };
  }, [map, weeks]);

  const levelOf = (n: number) => {
    if (n <= 0) return 0;
    if (maxN <= 4) return Math.min(4, n);
    const r = n / maxN;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };

  const LEVEL_BG = [
    'bg-white/5',
    'bg-cyan/22',
    'bg-cyan/40',
    'bg-cyan/62',
    'bg-cyan/88',
  ];

  return (
    <div className={cn('relative', className)}>
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {cols.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((d) => {
              const lv = levelOf(d.n);
              const isFuture = d.date > todayStr();
              return (
                <button
                  key={d.date}
                  type="button"
                  disabled={isFuture}
                  aria-label={`${d.date}：作答 ${d.n} 题，答对 ${d.c} 题`}
                  onMouseEnter={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const host = (e.currentTarget.closest('.heatmap-host') as HTMLElement)?.getBoundingClientRect();
                    setHover({
                      ...d,
                      x: r.left - (host?.left || 0) + r.width / 2,
                      y: r.top - (host?.top || 0),
                    });
                  }}
                  onMouseLeave={() => setHover(null)}
                  className={cn(
                    'h-[11px] w-[11px] shrink-0 rounded-[2.5px] transition-all duration-150',
                    isFuture ? 'bg-transparent' : LEVEL_BG[lv],
                    !isFuture && 'hover:ring-1 hover:ring-cyan/60',
                    lv >= 3 && 'shadow-[0_0_6px_-1px_rgba(34,211,238,0.6)]',
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-fg-mute">
        <span>
          近 {weeks} 周 · 有效 {totalDays} 天 · 累计 {totalAttempts} 题
        </span>
        <span className="flex items-center gap-1.5">
          少
          {LEVEL_BG.map((b, i) => (
            <span key={i} className={cn('h-[9px] w-[9px] rounded-[2px]', b)} />
          ))}
          多
        </span>
      </div>

      {hover && (
        <div
          className="glass-strong pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11.5px]"
          style={{ left: hover.x, top: hover.y - 8 }}
        >
          <span className="text-fg-soft">{hover.date}</span>
          <span className="ml-2 text-fg-mute">
            {hover.n > 0 ? `${hover.n} 题 · 对 ${hover.c}` : '未学习'}
          </span>
        </div>
      )}
    </div>
  );
}
