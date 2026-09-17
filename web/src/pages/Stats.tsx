import { useMemo } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, PolarAngleAxis, PolarGrid,
  PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Activity, ChartNoAxesColumn, Percent, Target } from 'lucide-react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Panel, Skeleton, SectionTitle, StatCard, Badge, EmptyState } from '@/components/ui/Primitives';
import { Heatmap } from '@/components/Heatmap';
import { NumberTicker } from '@/components/fx/Motion';
import { pct } from '@/lib/utils';

const AXIS = { stroke: 'rgba(255,255,255,0.07)', tick: { fill: '#6b7590', fontSize: 11 } };

const TOOLTIP_STYLE = {
  background: 'rgba(11,15,26,0.96)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 12,
  padding: '8px 12px',
  fontSize: 12,
  color: '#e9ebf4',
  boxShadow: '0 18px 44px -20px rgba(0,0,0,0.95)',
  backdropFilter: 'blur(12px)',
};

export default function Stats() {
  const { data, loading } = useAsync(() => api.study.stats(), []);

  const snap = data?.snapshot;

  const trend = useMemo(
    () => (data?.trend || []).map((d: any) => ({ ...d, label: d.date.slice(5) })),
    [data],
  );

  const radar = useMemo(
    () => (data?.radar || []).map((r: any) => ({
      subject: r.name,
      accuracy: r.accuracy,
      coverage: r.coverage,
      fullMark: 100,
    })),
    [data],
  );

  const chapters = useMemo(
    () => (data?.chapters || [])
      .filter((c: any) => c.attempts > 0)
      .sort((a: any, b: any) => b.accuracy - a.accuracy)
      .slice(0, 12)
      .map((c: any) => ({
        name: c.name.replace(/^第[一二三四五六七八九十]+章\s*/, '').slice(0, 10),
        accuracy: c.accuracy,
        attempts: c.attempts,
      })),
    [data],
  );

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)}
        </div>
        <Skeleton className="h-[280px] rounded-2xl" />
        <Skeleton className="h-[280px] rounded-2xl" />
      </div>
    );
  }

  const hasData = (snap?.attempts ?? 0) > 0;

  return (
    <div className="space-y-5">
      {/* 总览 */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="累计作答"
          value={<NumberTicker value={snap?.attempts ?? 0} />}
          sub={`答对 ${snap?.correct ?? 0} 次`}
          icon={<Activity size={16} />}
          accent="cyan"
        />
        <StatCard
          label="总体正确率"
          value={<NumberTicker value={snap ? pct(snap.correct, snap.attempts) : 0} suffix="%" />}
          sub={snap?.attempts ? '全部考纲范围' : '还没有作答记录'}
          icon={<Percent size={16} />}
          accent="emerald"
          delay={60}
        />
        <StatCard
          label="知识覆盖"
          value={<><NumberTicker value={snap?.learned ?? 0} /><span className="text-[15px] text-fg-mute">/{snap?.total ?? 68}</span></>}
          sub={`已点亮 ${snap?.chaptersDone ?? 0} / ${snap?.chaptersTotal ?? 19} 章`}
          icon={<Target size={16} />}
          accent="violet"
          delay={120}
        />
        <StatCard
          label="连续打卡"
          value={<NumberTicker value={snap?.streak ?? 0} suffix=" 天" />}
          sub={`最长纪录 ${snap?.bestStreak ?? 0} 天`}
          icon={<ChartNoAxesColumn size={16} />}
          accent="amber"
          delay={180}
        />
      </section>

      {!hasData && (
        <Panel>
          <EmptyState
            icon={<ChartNoAxesColumn size={22} />}
            title="还没有可统计的数据"
            desc="做过几道题之后，这里会出现正确率趋势、科目雷达图和章节强弱对比。"
          />
        </Panel>
      )}

      {hasData && (
        <>
          {/* 趋势 */}
          <Panel className="p-5">
            <SectionTitle
              title="近 14 天正确率"
              desc="有作答的日子才会有点 —— 没做的日子不画成 0，那会误导"
              className="mb-4"
            />
            <div className="h-[230px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="grad-acc" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.42} />
                      <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.055)" vertical={false} />
                  <XAxis dataKey="label" {...AXIS} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} {...AXIS} axisLine={false} tickLine={false} width={44} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelStyle={{ color: '#a8b0c6', marginBottom: 4 }}
                    formatter={(v: any, _n: any, p: any) => [`${v}%（${p.payload.correct}/${p.payload.total} 题）`, '正确率']}
                  />
                  <Area
                    type="monotone"
                    dataKey="pct"
                    stroke="#22d3ee"
                    strokeWidth={2.2}
                    fill="url(#grad-acc)"
                    dot={{ r: 3, fill: '#0b0f1a', stroke: '#22d3ee', strokeWidth: 2 }}
                    activeDot={{ r: 5, fill: '#22d3ee', stroke: '#0b0f1a', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          {/* 雷达 + 章节 */}
          <section className="grid gap-4 lg:grid-cols-2">
            <Panel className="p-5">
              <SectionTitle title="三科掌握度" desc="外圈为覆盖率，内圈为正确率" className="mb-2" />
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radar} outerRadius="72%">
                    <PolarGrid stroke="rgba(255,255,255,0.085)" />
                    <PolarAngleAxis dataKey="subject" tick={{ fill: '#a8b0c6', fontSize: 12 }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={{ fill: '#5d6580', fontSize: 10 }} axisLine={false} />
                    <Radar name="覆盖率" dataKey="coverage" stroke="#a855f7" fill="#a855f7" fillOpacity={0.16} strokeWidth={1.6} />
                    <Radar name="正确率" dataKey="accuracy" stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.22} strokeWidth={2} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any) => `${v}%`} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 flex justify-center gap-5 text-[11.5px]">
                <span className="flex items-center gap-1.5 text-fg-mute">
                  <span className="h-2 w-2 rounded-sm bg-cyan" /> 正确率
                </span>
                <span className="flex items-center gap-1.5 text-fg-mute">
                  <span className="h-2 w-2 rounded-sm bg-violet" /> 覆盖率
                </span>
              </div>
            </Panel>

            <Panel className="p-5">
              <SectionTitle title="各章正确率" desc="只显示做过的章节，从高到低" className="mb-2" />
              {chapters.length ? (
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chapters} layout="vertical" margin={{ top: 4, right: 18, bottom: 0, left: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.055)" horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} {...AXIS} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="name" width={92} {...AXIS} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        cursor={{ fill: 'rgba(255,255,255,0.035)' }}
                        formatter={(v: any, _n: any, p: any) => [`${v}%（${p.payload.attempts} 题）`, '正确率']}
                      />
                      <Bar dataKey="accuracy" radius={[0, 5, 5, 0]} barSize={13}>
                        {chapters.map((c: any, i: number) => (
                          <Cell
                            key={i}
                            fill={
                              c.accuracy >= 85 ? '#34d399'
                                : c.accuracy >= 65 ? '#22d3ee'
                                  : c.accuracy >= 40 ? '#fbbf24'
                                    : '#fb7185'
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <EmptyState icon={<ChartNoAxesColumn size={20} />} title="还没有章节数据" className="py-10" />
              )}
            </Panel>
          </section>

          {/* 热力图 */}
          <Panel className="p-5">
            <SectionTitle title="学习热力图" desc="近 26 周的作答分布" className="mb-4" />
            <div className="heatmap-host relative">
              <Heatmap data={data?.heatmap || []} />
            </div>
          </Panel>

          {/* 来源分布 */}
          {data?.bySource?.length > 0 && (
            <Panel className="p-5">
              <SectionTitle title="题源正确率" desc="真题改编 vs 经典例题 vs 模拟题 —— 看你在哪类题上掉分" className="mb-4" />
              <div className="grid gap-3 sm:grid-cols-3">
                {data.bySource.map((s: any) => {
                  const rate = s.n ? Math.round((s.c / s.n) * 100) : 0;
                  return (
                    <div key={s.sourceType} className="glass-subtle rounded-xl p-4">
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-medium text-fg-soft">{s.sourceType}</span>
                        <Badge tone={rate >= 75 ? 'emerald' : rate >= 50 ? 'cyan' : 'amber'}>
                          {rate}%
                        </Badge>
                      </div>
                      <div className="mt-2.5 text-[22px] font-semibold text-fg tabular">
                        <NumberTicker value={s.c} />
                        <span className="text-[13px] text-fg-mute"> / {s.n}</span>
                      </div>
                      <div className="mt-1 text-[11.5px] text-fg-mute">答对 / 总作答</div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
