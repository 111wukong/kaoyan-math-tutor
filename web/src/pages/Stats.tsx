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
import { cn, pct, cssVar } from '@/lib/utils';
import { useTheme } from '@/stores/theme';

/* 图表用色。
 *
 * ★ 网格线的透明度是调过的，别往回调。
 *
 * 最初写的是 0.055（直角坐标系）/ 0.085（雷达）。这个值在普通深色底
 * （#111827 一类）上没问题，但本站的底色是 #03040a —— 近黑。
 * 算一下：0.055 白叠在 #03040a 上 ≈ rgb(17,18,23)，对比度约 1.05:1，
 * 肉眼等于没画。雷达图尤其惨，整个网格消失，只剩一根数据线悬在空中。
 *
 * 现在按「能看见结构、但不抢数据」定：直角网格 ≈ rgb(41)、雷达 ≈ rgb(58)，
 * 对比度落在 1.4–1.8:1 —— 细线在这个区间刚好可辨。
 *
 * 注意别拿环形进度条的 0.07 当参照：那是 5px 宽的描边，7% 就够显形；
 * 1px 的细线在同样透明度下会直接消失。**透明度要跟着线宽走。**
 *
 * ★ 多主题改造：下面这些从「写死的白」改成「读当前主题的令牌」。
 *   白 16% 在深空底上是浅灰线，在宣纸底上就是白线压白底 —— 隐形。
 *   现在统一读 --color-hairline / --color-fg-mute 等，跟着主题走。
 *
 *   ⚠️ 必须在**组件内**求值（下面的 chartTheme()），不能提到模块顶层。
 *   模块顶层只在 import 那一刻算一次，切主题不会更新 ——
 *   表现是「主题换了，图表网格还是老颜色」。
 */
/* 错因配色。概念类给 rose 是因为它最该被立刻处理 ——
 * 学生常把它误当成「粗心」，于是继续刷题，越刷越错。 */
const ERROR_BAR: Record<string, string> = {
  concept: 'bg-rose',
  calc: 'bg-amber',
  condition: 'bg-amber',
  method: 'bg-cyan',
  misread: 'bg-violet',
  blank: 'bg-fg-faint',
};

function chartTheme() {
  return {
    axis: {
      stroke: cssVar('--color-hairline-strong', 'rgba(255,255,255,0.16)'),
      tick: { fill: cssVar('--color-fg-mute', '#6b7590'), fontSize: 11 },
    },
    /** 细网格线统一用这个 —— 别在调用处各写各的。 */
    gridStroke: cssVar('--color-hairline', 'rgba(255,255,255,0.15)'),
    /** 雷达图的网格既是刻度又是骨架，比直角网格再亮一档。 */
    polarGridStroke: cssVar('--color-hairline-strong', 'rgba(255,255,255,0.22)'),
    tooltip: {
      background: cssVar('--glass-sheet-strong', 'rgba(11,15,26,0.96)'),
      border: `1px solid ${cssVar('--color-hairline-strong', 'rgba(255,255,255,0.12)')}`,
      borderRadius: 12,
      padding: '8px 12px',
      fontSize: 12,
      color: cssVar('--color-fg', '#e9ebf4'),
      boxShadow: `0 18px 44px -20px ${cssVar('--glass-shadow-strong', 'rgba(0,0,0,0.95)')}`,
      backdropFilter: 'blur(12px)',
    },
    /** 悬停时那条指示带的填充 */
    cursorFill: cssVar('--color-glass-1', 'rgba(255,255,255,0.035)'),
    accent: {
      cyan: cssVar('--color-cyan', '#22d3ee'),
      violet: cssVar('--color-violet', '#a855f7'),
      emerald: cssVar('--color-emerald', '#34d399'),
      amber: cssVar('--color-amber', '#fbbf24'),
      rose: cssVar('--color-rose', '#fb7185'),
      blue: cssVar('--color-blue', '#3b82f6'),
    },
    /** 数据点描边用底色，制造"分离"感 */
    surface: cssVar('--color-ink-850', '#0b0f1a'),
  };
}

export default function Stats() {
  const { data, loading } = useAsync(() => api.study.stats(), []);
  /* 错因分布。一道都没判定过时后端返回 judged=0，整块不渲染 ——
   * 显示一个全 0 的图表比不显示更让人困惑。 */
  const errStats = useAsync(() => api.ai.errorStats(), []);
  const errData = errStats.data;

  /* 订阅主题 id —— 它一变这个组件就重渲染，chartTheme() 重新读一遍令牌。
   * 少了这一行，切主题后图表的网格/提示框颜色会停在旧主题上。 */
  const themeId = useTheme((s) => s.id);
  const T = useMemo(() => chartTheme(), [themeId]);
  const AXIS = T.axis;

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
                      <stop offset="0%" stopColor={T.accent.cyan} stopOpacity={0.42} />
                      <stop offset="100%" stopColor={T.accent.cyan} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.gridStroke} vertical={false} />
                  <XAxis dataKey="label" {...AXIS} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} {...AXIS} axisLine={false} tickLine={false} width={44} />
                  <Tooltip
                    contentStyle={T.tooltip}
                    labelStyle={{ color: cssVar('--color-fg-soft', '#a8b0c6'), marginBottom: 4 }}
                    formatter={(v: any, _n: any, p: any) => [`${v}%（${p.payload.correct}/${p.payload.total} 题）`, '正确率']}
                  />
                  <Area
                    type="monotone"
                    dataKey="pct"
                    stroke={T.accent.cyan}
                    strokeWidth={2.2}
                    fill="url(#grad-acc)"
                    dot={{ r: 3, fill: T.surface, stroke: T.accent.cyan, strokeWidth: 2 }}
                    activeDot={{ r: 5, fill: T.accent.cyan, stroke: T.surface, strokeWidth: 2 }}
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
                    <PolarGrid stroke={T.polarGridStroke} />
                    <PolarAngleAxis dataKey="subject" tick={{ fill: cssVar('--color-fg-soft', '#a8b0c6'), fontSize: 12 }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={{ fill: cssVar('--color-fg-faint', '#5d6580'), fontSize: 10 }} axisLine={false} />
                    <Radar name="覆盖率" dataKey="coverage" stroke={T.accent.violet} fill={T.accent.violet} fillOpacity={0.16} strokeWidth={1.6} />
                    <Radar name="正确率" dataKey="accuracy" stroke={T.accent.cyan} fill={T.accent.cyan} fillOpacity={0.22} strokeWidth={2} />
                    <Tooltip contentStyle={T.tooltip} formatter={(v: any) => `${v}%`} />
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
                      <CartesianGrid strokeDasharray="3 3" stroke={T.gridStroke} horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} {...AXIS} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="name" width={92} {...AXIS} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={T.tooltip}
                        cursor={{ fill: T.cursorFill }}
                        formatter={(v: any, _n: any, p: any) => [`${v}%（${p.payload.attempts} 题）`, '正确率']}
                      />
                      <Bar dataKey="accuracy" radius={[0, 5, 5, 0]} barSize={13}>
                        {chapters.map((c: any, i: number) => (
                          <Cell
                            key={i}
                            fill={
                              c.accuracy >= 85 ? T.accent.emerald
                                : c.accuracy >= 65 ? T.accent.cyan
                                  : c.accuracy >= 40 ? T.accent.amber
                                    : T.accent.rose
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

          {/* 错因分布 —— 答错和答错不是一回事。
              概念混淆要回去补前置，计算失误只要练熟练度，
              两种处置完全相反，混在「正确率」一个数字里就分不出来。 */}
          {errData && errData.judged > 0 && (
            <Panel className="p-5">
              <SectionTitle
                title="错因分布"
                desc="答错的题里，有多少是真不会，有多少只是算错"
                className="mb-4"
              />
              <div className="space-y-3">
                {errData.items.map((it) => {
                  const rate = errData.judged
                    ? Math.round((it.count / errData.judged) * 100)
                    : 0;
                  return (
                    <div key={it.type}>
                      <div className="mb-1.5 flex items-center justify-between text-[12.5px]">
                        <span className="text-fg-soft">{it.label}</span>
                        <span className="tabular text-fg-mute">{it.count} 次 · {rate}%</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-veil/8">
                        <div
                          className={cn('h-full rounded-full', ERROR_BAR[it.type] || 'bg-fg-faint')}
                          style={{ width: `${Math.max(2, rate)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              {errData.advice && (
                <p className="mt-4 rounded-xl border border-veil/8 bg-veil/3 px-3.5 py-3 text-[12.5px] leading-relaxed text-fg-soft">
                  {errData.advice}
                </p>
              )}
              {errData.unjudged > 0 && (
                <p className="mt-2.5 text-[11.5px] text-fg-faint">
                  还有 {errData.unjudged} 道错题没判定过错因 —— 去错题本点「分析错因」。
                </p>
              )}
            </Panel>
          )}

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
