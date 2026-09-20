import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ArrowRight, CalendarClock, CircleAlert, Crosshair, Flame, Layers, Pause, Play,
  RotateCcw, Sparkles, Target, Timer, TrendingUp, Trophy, Zap,
} from 'lucide-react';
import { AppLink as Link } from '@/lib/links';
import { api } from '@/lib/api';
import { useAsync, useCountdown } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { Panel, SectionTitle, Badge, Button, Skeleton, EmptyState } from '@/components/ui/Primitives';
import { NumberTicker, ProgressRing, Meter, TiltCard } from '@/components/fx/Motion';
import { HudPanel, HudStatCard, HudSectionTitle, TickRule, Readout } from '@/components/fx/Hud';
import { Heatmap } from '@/components/Heatmap';
import { announceAchievements } from '@/components/ui/Toaster';
import { cn, pct, cssVar } from '@/lib/utils';
import { levelTitle } from '@/lib/achievements';

const KIND_META: Record<string, { icon: any; tone: string; ring: string }> = {
  review: { icon: RotateCcw, tone: 'text-cyan', ring: 'from-cyan/22' },
  mistake: { icon: CircleAlert, tone: 'text-rose', ring: 'from-rose/22' },
  learn: { icon: Target, tone: 'text-violet', ring: 'from-violet/22' },
  quiz: { icon: Sparkles, tone: 'text-emerald', ring: 'from-emerald/22' },
};

export default function Dashboard() {
  const nav = useNavigate();
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);

  const next = useAsync(() => api.game.next(), [], { key: 'game.next' });
  const stats = useAsync(() => api.study.stats(), [], { key: 'study.stats' });
  const weak = useAsync(() => api.study.weak(6), [], { key: 'study.weak:6' });
  const settings = useAsync(() => api.settings.get(), [], { key: 'settings' });

  const snap = next.data?.snapshot;
  /* 根因单独取出来。写成 next.data?.roots?.roots?.length > 0 的话 TS 收窄不了，
   * 后面每处 next.data.roots 都要再判一次空 —— 取成变量最省事。 */
  const rootItems = next.data?.roots?.roots ?? [];
  const examDate = settings.data?.settings?.examDate || '';
  const countdown = useCountdown(examDate || undefined);

  useEffect(() => {
    if (next.data) refreshSnapshot();
  }, [next.data, refreshSnapshot]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return '还没睡？';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    if (h < 23) return '晚上好';
    return '夜深了';
  }, []);

  const loading = next.loading && !next.data;

  if (loading) return <DashboardSkeleton />;

  const masteryPct = snap ? pct(snap.learned, snap.total) : 0;

  return (
    <div className="space-y-6">
      {/* ---------- Hero ---------- */}
      <section className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <HudPanel
          index="SYS"
          tag="DAILY SCHEDULER"
          sweep
          ticks
          className="rise-in overflow-hidden rounded-2xl p-5 sm:p-6"
        >
          <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-cyan/10 blur-[90px]" />
          <div className="relative">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="cyan">
                <Sparkles size={11} /> {greeting}
              </Badge>
              {countdown.days !== null && (
                <Badge tone={countdown.urgent ? 'rose' : 'violet'}>
                  <CalendarClock size={11} />
                  距初试 {countdown.label}
                </Badge>
              )}
              {snap && snap.streak > 0 && (
                <Badge tone="amber">
                  <Flame size={11} /> 连续 {snap.streak} 天
                </Badge>
              )}
            </div>

            <h1 className="mt-4 text-[26px] font-semibold leading-tight tracking-tight text-fg sm:text-[30px]">
              今天该做的，
              <span className="text-spectrum">已经排好了。</span>
            </h1>
            <p className="mt-2.5 max-w-lg text-[13.5px] leading-relaxed text-fg-soft">
              {next.data?.items?.length
                ? `调度器给你排了 ${next.data.items.length} 件事。每件都写了为什么是它 —— 不用自己决定先干什么。`
                : '先按下面的建议开始，或者直接去知识树挑一个考点。'}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <Button onClick={() => nav('/quiz')} shimmer>
                开始今日一练 <ArrowRight size={15} />
              </Button>
              <Button variant="outline" onClick={() => nav('/learn')}>
                浏览知识树
              </Button>
            </div>

            {/* 底部读数条：把"今天的状态"压成一行仪器读数，
                比再堆一个卡片省地方，也更能坐实"控制台"的观感。 */}
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline pt-3.5">
              <Readout label="今日任务" value={String(next.data?.items?.length ?? 0).padStart(2, '0')} unit="项" />
              <Readout label="待复习" value={String(snap?.dueCount ?? 0).padStart(2, '0')} unit="张" tone="violet" />
              <Readout label="错题" value={String(snap?.wrong ?? 0).padStart(2, '0')} unit="道" tone="rose" />
              <Readout
                label="正确率"
                value={`${snap ? pct(snap.correct, snap.attempts) : 0}%`}
                tone="emerald"
              />
            </div>
          </div>
        </HudPanel>

        {/* 等级环 */}
        <HudPanel
          index="LV"
          tag="PROGRESS"
          sweep
          className="rise-in flex items-center gap-5 rounded-2xl p-5"
          style={{ animationDelay: '80ms' }}
        >
          <ProgressRing
            value={snap?.levelInfo?.pct ?? 0}
            size={104}
            stroke={8}
            label={
              <div className="text-center">
                <div className="text-[24px] font-bold leading-none text-fg tabular">{snap?.level ?? 1}</div>
                <div className="mt-0.5 text-[10px] text-fg-mute">LV</div>
              </div>
            }
          />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold tracking-tight text-fg">
              {levelTitle(snap?.level ?? 1)}
            </div>
            <div className="mt-1 text-[12px] text-fg-mute tabular">
              {snap?.levelInfo?.into ?? 0} / {snap?.levelInfo?.need ?? 100} XP
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11.5px]">
              <div>
                <div className="text-fg-mute">总 XP</div>
                <div className="mt-0.5 font-mono font-semibold text-fg tabular">
                  <NumberTicker value={snap?.xp ?? 0} />
                </div>
              </div>
              <div>
                <div className="text-fg-mute">最长连击</div>
                <div className="mt-0.5 font-mono font-semibold text-fg tabular">{snap?.bestCombo ?? 0}</div>
              </div>
            </div>
          </div>
        </HudPanel>
      </section>

      {/* ---------- 今日任务 ---------- */}
      <section>
        <HudSectionTitle
          index={1}
          title="今日任务"
          desc="按优先级排好，每件事都写清了理由"
          right={
            <Button variant="ghost" size="sm" onClick={() => api.study.refreshDaily().then(() => next.reload())}>
              <RotateCcw size={13} /> 重排
            </Button>
          }
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {next.data?.items?.map((item, i) => {
            const meta = KIND_META[item.kind] || KIND_META.quiz;
            const Icon = meta.icon;
            return (
              <motion.button
                key={item.kind + i}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: i * 0.07, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => nav(item.route)}
                className="group text-left"
              >
                <Panel
                  variant="default"
                  className={cn(
                    'relative overflow-hidden p-4 transition-all duration-300',
                    'hover:border-cyan/30 hover:lift-cyan',
                  )}
                >
                  <div className={cn('pointer-events-none absolute -left-10 -top-10 h-28 w-28 rounded-full bg-gradient-to-br to-transparent opacity-70 blur-2xl', meta.ring)} />
                  <div className="relative flex items-start gap-3">
                    <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-veil/8 bg-veil/5', meta.tone)}>
                      <Icon size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium leading-snug text-fg">{item.title}</div>
                      <div className="mt-1 text-[12px] leading-relaxed text-fg-mute">{item.why}</div>
                    </div>
                    <ArrowRight size={15} className="mt-1.5 shrink-0 text-fg-faint transition-all duration-300 group-hover:translate-x-0.5 group-hover:text-cyan" />
                  </div>
                </Panel>
              </motion.button>
            );
          })}
        </div>

        {/* ---------- 根因诊断 ----------
         * 放在「今日任务」里面而不是单开一节，是因为它回答的正是
         * 「为什么今天排的是这些」—— 两者是一件事的两面。
         *
         * 只显示前 3 条。根因列表给长了，用户又会陷入「先做哪个」的
         * 选择困难 —— 那正是这个功能要消灭的东西。 */}
        {rootItems.length > 0 && (
          <div className="mt-4">
            <div className="mb-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <div className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-amber/20 bg-amber/10 text-amber">
                <Crosshair size={13} />
              </div>
              <span className="text-[13px] font-medium text-fg">根因诊断</span>
              <span className="text-[11.5px] text-fg-mute">
                从 {next.data?.roots?.symptomCount ?? 0} 个出问题的考点往前回溯
              </span>
            </div>
            <div className="space-y-2">
              {rootItems.slice(0, 3).map((r) => (
                <Link
                  key={r.nodeId}
                  to={`/learn/${r.nodeId}`}
                  className="group flex items-start gap-3 rounded-xl border border-amber/12 bg-amber/4 px-3.5 py-3 transition-all hover:border-amber/30"
                >
                  {/* 「没学过」和「没打牢」是两种处境，动作不同：
                   * 前者要去学，后者要去补。标签必须区分，否则用户不知道该干嘛。 */}
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-[10.5px]',
                      r.kind === 'gap'
                        ? 'border-rose/25 bg-rose/10 text-rose'
                        : 'border-amber/25 bg-amber/10 text-amber',
                    )}
                  >
                    {r.kind === 'gap' ? '没学过' : '没打牢'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium leading-snug text-fg">{r.title}</div>
                    <div className="mt-1 text-[11.5px] leading-relaxed text-fg-mute">{r.why}</div>
                  </div>
                  <ArrowRight size={14} className="mt-1 shrink-0 text-fg-faint transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ---------- 统计卡 ---------- */}
      <section>
        <HudSectionTitle index={2} title="学习数据" desc="四个通道的当前读数" tone="emerald" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <HudStatCard
            index={1}
            label="知识树覆盖"
            value={<NumberTicker value={snap?.learned ?? 0} />}
            unit={`/ ${snap?.total ?? 68}`}
            meter={masteryPct}
            icon={<Target size={14} />}
            tone="cyan"
            delay={0}
          />
          <HudStatCard
            index={2}
            label="累计作答"
            value={<NumberTicker value={snap?.attempts ?? 0} />}
            unit="次"
            sub={`答对 ${snap?.correct ?? 0} 次 · 正确率 ${snap ? pct(snap.correct, snap.attempts) : 0}%`}
            meter={snap ? pct(snap.correct, snap.attempts) : 0}
            icon={<TrendingUp size={14} />}
            tone="emerald"
            delay={60}
          />
          <HudStatCard
            index={3}
            label="待复习"
            value={<NumberTicker value={snap?.dueCount ?? 0} />}
            unit="张"
            sub={snap?.dueCount ? '到期未复习的卡片' : '队列是空的'}
            icon={<Layers size={14} />}
            tone="violet"
            delay={120}
          />
          <HudStatCard
            index={4}
            label="错题本"
            value={<NumberTicker value={snap?.wrong ?? 0} />}
            unit="道"
            sub={snap?.wrong ? '答对后自动移出' : '干净，继续保持'}
            icon={<CircleAlert size={14} />}
            tone="rose"
            delay={180}
          />
        </div>
      </section>

      {/* ---------- 热力图 + 掌握度 ---------- */}
      <section className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <HudPanel
          index={3}
          tag="HEATMAP · 26W"
          sweep
          className="rise-in rounded-2xl p-5"
          style={{ animationDelay: '220ms' }}
        >
          <SectionTitle title="学习热力图" desc="近 26 周每天做了多少题" className="mb-3" />
          <div className="heatmap-host relative">
            {stats.data ? (
              <Heatmap data={stats.data.heatmap || []} />
            ) : (
              <Skeleton className="h-[110px] w-full" />
            )}
          </div>
        </HudPanel>

        <HudPanel
          index={4}
          tag="MASTERY"
          sweep
          className="rise-in rounded-2xl p-5"
          style={{ animationDelay: '280ms' }}
        >
          <SectionTitle title="掌握度分布" desc="按考点计数" className="mb-3" />
          {stats.data ? (
            <div className="space-y-3">
              {([
                ['mastered', '精通', cssVar('--color-emerald', '#34d399')],
                ['proficient', '熟练', cssVar('--color-cyan', '#22d3ee')],
                ['learning', '学习中', cssVar('--color-amber', '#fbbf24')],
                ['new', '未学', cssVar('--color-fg-faint', 'rgba(255,255,255,0.22)')],
              ] as const).map(([key, label, color]) => {
                const n = stats.data.masteryDist?.[key] ?? 0;
                const total = stats.data.snapshot?.total || 68;
                return (
                  <div key={key}>
                    <div className="mb-1.5 flex items-center justify-between text-[12px]">
                      <span className="flex items-center gap-2 text-fg-soft">
                        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                        {label}
                      </span>
                      <span className="font-mono text-fg-mute tabular">{n} 个 · {pct(n, total)}%</span>
                    </div>
                    <Meter value={pct(n, total)} height={5} from={color} to={color} />
                  </div>
                );
              })}
            </div>
          ) : (
            <Skeleton className="h-[150px] w-full" />
          )}
        </HudPanel>
      </section>

      {/* ---------- 薄弱点 + 专注 ---------- */}
      <section className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <HudPanel
          index={5}
          tag="WEAK SPOTS"
          sweep
          className="rise-in rounded-2xl p-5"
          style={{ animationDelay: '340ms' }}
        >
          <SectionTitle
            title="最该补的地方"
            desc="按「正确率低 × 难度高 × 错题多」排序"
            right={<Link to="/mistakes" className="text-[12px] text-cyan hover:text-cyan-200">全部错题 →</Link>}
            className="mb-3"
          />
          {weak.data?.weak?.length ? (
            <div className="space-y-2">
              {weak.data.weak.map((w: any, i: number) => (
                <Link
                  key={w.nodeId}
                  to={`/learn/${w.nodeId}`}
                  className="group flex items-center gap-3 rounded-xl border border-veil/6 bg-veil/3 px-3 py-2.5 transition-all duration-250 hover:border-cyan/25 hover:bg-veil/6"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-veil/6 font-mono text-[11px] font-semibold text-fg-mute tabular">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg-soft group-hover:text-fg">
                    {w.title}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-fg-mute">{w.why}</span>
                  <ArrowRight size={13} className="shrink-0 text-fg-faint transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Trophy size={22} />}
              title="还没有足够的数据"
              desc="做过几道题之后，这里会列出你最该补的考点。"
              className="py-8"
            />
          )}
        </HudPanel>

        <FocusTimer onDone={() => next.reload()} pushToast={pushToast} />
      </section>
    </div>
  );
}

/* ---------- 专注计时器 ---------- */
function FocusTimer({ onDone, pushToast }: { onDone: () => void; pushToast: any }) {
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef<string>('');

  useEffect(() => {
    if (running) {
      startedAt.current = startedAt.current || new Date().toISOString();
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [running]);

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  const finish = async () => {
    const mins = Math.max(1, Math.round(seconds / 60));
    setRunning(false);
    if (seconds < 60) { setSeconds(0); return; }
    try {
      const r = await api.study.focus(mins, startedAt.current);
      if (r?.achievements?.length) announceAchievements(r.achievements, pushToast);
      pushToast({ kind: 'success', title: `专注 ${mins} 分钟已记录`, desc: r?.todayMinutes ? `今天累计 ${r.todayMinutes} 分钟` : undefined });
    } catch { /* 忽略 */ }
    setSeconds(0);
    startedAt.current = '';
    onDone();
  };

  return (
    <HudPanel
      index={6}
      tag="FOCUS TIMER"
      sweep
      tone="violet"
      className="rise-in flex flex-col rounded-2xl p-5"
      style={{ animationDelay: '400ms' }}
    >
      <SectionTitle title="专注计时" desc="满 30 分钟自动打卡" className="mb-3" />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-2">
        <div className="relative grid h-32 w-32 place-items-center">
          {/* 仪表刻度圈：36 根刻度把"计时"变成"读数"。
              用 SVG line 而不是 CSS，因为要跟着圆环精确旋转。 */}
          <svg className="absolute inset-0" viewBox="0 0 128 128" aria-hidden>
            {Array.from({ length: 36 }).map((_, i) => {
              const major = i % 6 === 0;
              const a = (i / 36) * Math.PI * 2 - Math.PI / 2;
              const r1 = major ? 50 : 53;
              const r2 = 57;
              return (
                <line
                  key={i}
                  x1={64 + Math.cos(a) * r1}
                  y1={64 + Math.sin(a) * r1}
                  x2={64 + Math.cos(a) * r2}
                  y2={64 + Math.sin(a) * r2}
                  stroke={cssVar('--color-violet', '#a855f7')}
                  strokeOpacity={major ? 0.55 : 0.22}
                  strokeWidth={major ? 1.4 : 1}
                />
              );
            })}
          </svg>
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 128 128" aria-hidden>
            <circle cx="64" cy="64" r="58" fill="none" stroke={cssVar('--color-hairline', 'rgba(255,255,255,0.07)')} strokeWidth="5" />
            <circle
              cx="64" cy="64" r="58" fill="none"
              stroke="url(#focus-grad)" strokeWidth="5" strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 58}
              strokeDashoffset={2 * Math.PI * 58 * (1 - Math.min(1, (seconds % 1800) / 1800))}
              style={{ transition: 'stroke-dashoffset 1s linear' }}
            />
            <defs>
              <linearGradient id="focus-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={cssVar('--color-cyan', '#22d3ee')} />
                <stop offset="100%" stopColor={cssVar('--color-violet', '#a855f7')} />
              </linearGradient>
            </defs>
          </svg>
          <div className="text-center">
            <div className={cn('font-mono text-[30px] font-semibold leading-none tabular text-fg', running && 'text-spectrum')}>
              {mm}:{ss}
            </div>
            <div className="mt-1 text-[10.5px] text-fg-mute">{running ? '专注中' : '未开始'}</div>
          </div>
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant={running ? 'subtle' : 'primary'} onClick={() => setRunning((v) => !v)}>
            {running ? <><Pause size={13} /> 暂停</> : <><Play size={13} /> {seconds > 0 ? '继续' : '开始'}</>}
          </Button>
          {seconds > 0 && (
            <Button size="sm" variant="outline" onClick={finish}>
              <Timer size={13} /> 结束并记录
            </Button>
          )}
        </div>
      </div>
      <TickRule tone="violet" className="mt-3 opacity-30" />
      <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-fg-faint">
        计时结束会写入今日专注时长，满 30 分钟自动算作打卡
      </p>
    </HudPanel>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <Skeleton className="h-[230px] rounded-2xl" />
        <Skeleton className="h-[230px] rounded-2xl" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-[86px] rounded-2xl" />
        <Skeleton className="h-[86px] rounded-2xl" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)}
      </div>
    </div>
  );
}
