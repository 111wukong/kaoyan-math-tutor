import { useState } from 'react';
import { motion } from 'motion/react';
import { Lock, Sparkles, Trophy } from 'lucide-react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Panel, Skeleton, SectionTitle, Badge, Segmented } from '@/components/ui/Primitives';
import { Meter, NumberTicker, ProgressRing } from '@/components/fx/Motion';
import { TIER_STYLE, cn, pct, cssVar, veil } from '@/lib/utils';
import { useApp } from '@/stores/app';

const TIER_LABEL = { bronze: '铜', silver: '银', gold: '金' } as const;

export default function Achievements() {
  const snapshot = useApp((s) => s.snapshot);
  const { data, loading } = useAsync(() => api.game.achievements(), [], { key: 'game.achievements' });
  const [filter, setFilter] = useState<'all' | 'unlocked' | 'locked'>('all');

  const items = (data?.items || []).filter((a) =>
    filter === 'all' ? true : filter === 'unlocked' ? !!a.unlockedAt : !a.unlockedAt,
  );

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[160px] rounded-2xl" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[130px] rounded-2xl" />)}
        </div>
      </div>
    );
  }

  const unlocked = data?.unlocked ?? 0;
  const total = data?.total ?? 26;
  const tiers = data?.tiers ?? { bronze: 0, silver: 0, gold: 0 };

  return (
    <div className="space-y-5">
      {/* 总览 */}
      <Panel className="relative overflow-hidden p-5 sm:p-6">
        <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-amber/10 blur-[90px]" />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="grid h-11 w-11 place-items-center rounded-xl border border-amber/25 bg-amber/10 text-amber">
                <Trophy size={20} />
              </div>
              <div>
                <h1 className="text-[19px] font-semibold tracking-tight text-fg">成就墙</h1>
                <p className="mt-0.5 text-[12.5px] text-fg-mute">
                  已解锁 <span className="font-semibold text-fg tabular">{unlocked}</span> / {total}
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[12px]">
              {(['gold', 'silver', 'bronze'] as const).map((t) => (
                <span key={t} className="flex items-center gap-1.5 text-fg-mute">
                  <span className={cn('h-2 w-2 rounded-full', t === 'gold' ? 'bg-yellow-400' : t === 'silver' ? 'bg-slate-300' : 'bg-amber-700')} />
                  {TIER_LABEL[t]} {tiers[t]}
                </span>
              ))}
            </div>
          </div>

          <ProgressRing
            value={pct(unlocked, total)}
            size={116}
            stroke={9}
            gradient={[cssVar('--color-amber', '#fbbf24'), cssVar('--color-violet', '#a855f7')]}
            label={
              <div className="text-center">
                <div className="text-[24px] font-bold leading-none text-fg tabular">
                  <NumberTicker value={pct(unlocked, total)} suffix="%" />
                </div>
                <div className="mt-0.5 text-[10px] text-fg-mute">完成度</div>
              </div>
            }
          />
        </div>
      </Panel>

      {/* 等级进度 */}
      {snapshot && (
        <Panel className="p-5">
          <SectionTitle title="当前等级" desc={`${snapshot.levelInfo.title} · 累计 ${snapshot.xp} XP`} className="mb-3" />
          <Meter value={snapshot.levelInfo.pct} height={7}
            from={cssVar('--color-violet', '#a855f7')} to={cssVar('--color-cyan', '#22d3ee')} />
          <div className="mt-2 flex justify-between text-[11.5px] text-fg-mute">
            <span>LV {snapshot.level}</span>
            <span className="tabular">{snapshot.levelInfo.into} / {snapshot.levelInfo.need} XP</span>
          </div>
        </Panel>
      )}

      <div className="flex items-center justify-between">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `全部 ${total}` },
            { value: 'unlocked', label: `已解锁 ${unlocked}` },
            { value: 'locked', label: `未解锁 ${total - unlocked}` },
          ]}
        />
      </div>

      {/* 成就网格 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((a, i) => {
          const tier = TIER_STYLE[a.tier];
          const got = !!a.unlockedAt;
          return (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: Math.min(i * 0.025, 0.5), ease: [0.16, 1, 0.3, 1] }}
            >
              <Panel
                className={cn(
                  'group relative h-full overflow-hidden p-4 transition-all duration-300',
                  got ? cn('ring-1', tier.ring) : 'opacity-70 hover:opacity-95',
                )}
              >
                {got && (
                  <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br opacity-40', tier.grad)} />
                )}
                <div className="relative flex items-start gap-3">
                  <div
                    className={cn(
                      'grid h-11 w-11 shrink-0 place-items-center rounded-xl border text-[17px] font-semibold',
                      got
                        ? cn('border-veil/12 bg-veil/8', tier.text)
                        : 'border-veil/8 bg-veil/3 text-fg-faint',
                    )}
                  >
                    {got ? a.icon : <Lock size={15} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn('truncate text-[13.5px] font-medium', got ? 'text-fg' : 'text-fg-soft')}>
                        {a.name}
                      </span>
                      <Badge tone={a.tier === 'gold' ? 'amber' : a.tier === 'silver' ? 'neutral' : 'neutral'} className="shrink-0">
                        {TIER_LABEL[a.tier]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[12px] leading-snug text-fg-mute">{a.desc}</p>

                    {got ? (
                      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-faint">
                        <Sparkles size={10} className="text-amber" />
                        {a.unlockedAt} 解锁
                      </div>
                    ) : a.progress ? (
                      <div className="mt-2.5">
                        <Meter value={a.progress.pct} height={3} from={veil(0.2)} to={veil(0.35)} />
                        <div className="mt-1 text-[10.5px] text-fg-faint tabular">
                          {a.progress.have} / {a.progress.need}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-[10.5px] text-fg-faint">尚未达成条件</div>
                    )}
                  </div>
                </div>
              </Panel>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
