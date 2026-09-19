import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronRight, Eye, Layers, Sparkles, Zap } from 'lucide-react';
import { api, type Card } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { Panel, Button, Skeleton, Badge, Segmented } from '@/components/ui/Primitives';
import { RichText, InlineMath } from '@/components/ui/Math';
import { ProgressRing } from '@/components/fx/Motion';
import { announceAchievements } from '@/components/ui/Toaster';
import { sfxLevelUp, sfxRating } from '@/lib/sfx';
import { cn, daysBetween, todayStr, cssVar } from '@/lib/utils';

const RATINGS = [
  { v: 1, label: '忘了', hint: '完全想不起来', key: '1', cls: 'border-rose/35 hover:bg-rose/12 text-rose-200' },
  { v: 2, label: '吃力', hint: '想起来了但很费劲', key: '2', cls: 'border-amber/35 hover:bg-amber/12 text-amber-200' },
  { v: 3, label: '记得', hint: '正常回忆起来', key: '3', cls: 'border-cyan/35 hover:bg-cyan/12 text-cyan-200' },
  { v: 4, label: '很熟', hint: '几乎不用想', key: '4', cls: 'border-emerald/35 hover:bg-emerald/12 text-emerald-200' },
];

export default function Review() {
  const nav = useNavigate();
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);
  const { data, loading, reload } = useAsync(() => api.cards.due(), []);

  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [sessionXp, setSessionXp] = useState(0);
  const [graded, setGraded] = useState(0);
  const [queue, setQueue] = useState<Card[]>([]);

  useEffect(() => {
    if (data?.cards) setQueue(data.cards);
  }, [data]);

  const card = queue[idx];
  const total = queue.length;
  const progress = total ? (graded / total) * 100 : 0;

  const reveal = () => setRevealed(true);

  const grade = async (rating: number) => {
    if (!card) return;
    sfxRating(rating);
    try {
      const r = await api.cards.grade(card.id, rating);
      setSessionXp((v) => v + (r.xp?.gained || 0));
      if (r.achievements?.length) announceAchievements(r.achievements, pushToast);
      if (r.xp?.levelUp) {
        sfxLevelUp();
        pushToast({ kind: 'xp', title: `升到 ${r.xp.to} 级 · ${r.xp.title}`, ttl: 5000 });
      }
    } catch { /* 继续下一张 */ }

    setGraded((g) => g + 1);
    setRevealed(false);
    if (idx + 1 >= total) {
      refreshSnapshot();
      api.study.checkin(0, false).catch(() => {});
    }
    setIdx((i) => i + 1);
  };

  // 键盘：空格看答案，1-4 评分
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); return; }
      if (revealed) {
        const n = Number(e.key);
        if (n >= 1 && n <= 4) { e.preventDefault(); grade(n); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, revealed]);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[80px] rounded-2xl" />
        <Skeleton className="h-[400px] rounded-2xl" />
      </div>
    );
  }

  // 队列清空
  if (!card) {
    const allDone = total > 0 && graded >= total;
    return (
      <Panel className="relative overflow-hidden p-8 text-center">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-cyan/12 blur-[90px]" />
        <div className="relative">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-emerald/25 bg-emerald/10 text-emerald">
            <Check size={26} />
          </div>
          <h2 className="text-[21px] font-semibold tracking-tight text-fg">
            {allDone ? '复习队列清空了' : '现在没有到期的卡片'}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-fg-soft">
            {allDone
              ? `本轮复习 ${total} 张，获得 ${sessionXp} XP。间隔重复的关键是「按时」—— 明天再来。`
              : '所有卡片的到期日都还没到。去学新知识点，或者做一套题，都会产生新的复习卡。'}
          </p>

          {allDone && (
            <div className="mx-auto mt-6 flex max-w-xs items-center justify-center gap-6">
              <ProgressRing
                value={100}
                size={88}
                stroke={7}
                gradient={[cssVar('--color-emerald', '#34d399'), cssVar('--color-cyan', '#22d3ee')]}
                label={<span className="text-[17px] font-bold text-emerald-200">{total}</span>}
                sublabel="张卡片"
              />
              <div className="text-left">
                <div className="text-[11.5px] text-fg-mute">本轮获得</div>
                <div className="text-[22px] font-semibold text-violet tabular">+{sessionXp}</div>
                <div className="text-[11.5px] text-fg-mute">XP</div>
              </div>
            </div>
          )}

          <div className="mt-7 flex flex-wrap justify-center gap-2.5">
            <Button variant="outline" onClick={reload}>
              <Layers size={14} /> 刷新队列
            </Button>
            <Button onClick={() => nav('/learn')}>
              去学新考点 <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </Panel>
    );
  }

  const overdue = card.due < todayStr() ? Math.abs(daysBetween(card.due, todayStr())) : 0;

  return (
    <div className="space-y-5">
      {/* 进度头 */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl border border-cyan/25 bg-cyan/10 text-cyan">
              <Layers size={16} />
            </div>
            <div>
              <div className="text-[14px] font-semibold text-fg">复习队列</div>
              <div className="text-[11.5px] text-fg-mute">
                第 {idx + 1} / {total} 张
                {overdue > 0 && <span className="ml-1.5 text-amber-300/90">· 逾期 {overdue} 天</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {sessionXp > 0 && <Badge tone="violet"><Sparkles size={10} /> +{sessionXp} XP</Badge>}
            <Badge tone="neutral">{card.type === 'mistake' ? '错题卡' : '知识卡'}</Badge>
          </div>
        </div>
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-veil/6">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan to-violet transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </Panel>

      {/* 卡片 */}
      <AnimatePresence mode="wait">
        <motion.div
          key={card.id}
          initial={{ opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.99 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          <Panel className="relative min-h-[320px] overflow-hidden p-6 sm:p-7">
            <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-violet/10 blur-[80px]" />

            <div className="relative">
              <div className="mb-4 flex items-center gap-2">
                <Badge tone="cyan">{card.kidTitle || '知识点'}</Badge>
                {card.reps > 0 && (
                  <span className="text-[11px] text-fg-faint">
                    已复习 {card.reps} 次 · 难度系数 {card.ef.toFixed(2)}
                  </span>
                )}
              </div>

              {/* 正面：先自己想 */}
              {card.stem ? (
                <div className="text-[15.5px] leading-[1.9] text-fg">
                  <RichText text={card.stem} bareLatex />
                </div>
              ) : (
                <>
                  <h3 className="text-[19px] font-semibold tracking-tight text-fg">{card.kidTitle}</h3>
                  <p className="mt-3 text-[13px] leading-relaxed text-fg-mute">
                    先在脑子里把这个考点过一遍 —— 定义是什么、怎么用、易错在哪。
                  </p>
                </>
              )}

              {/* 背面 */}
              <AnimatePresence>
                {revealed && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="mt-5 border-t border-hairline pt-5">
                      {card.answer && (
                        <div className="mb-4">
                          <div className="mb-1.5 text-[11.5px] font-medium text-fg-mute">答案</div>
                          <div className="text-[15px] text-emerald-200"><InlineMath text={card.answer} /></div>
                        </div>
                      )}
                      {card.content && (
                        <div className="text-[13.5px] leading-[1.9] text-fg-soft">
                          <RichText text={card.content} bareLatex />
                        </div>
                      )}
                      {card.analysis && (
                        <div className="mt-3 rounded-xl border border-veil/8 bg-veil/3 px-3.5 py-3">
                          <div className="mb-1.5 text-[11.5px] font-medium text-fg-mute">解析</div>
                          <div className="text-[13px] leading-relaxed text-fg-soft">
                            <RichText text={card.analysis} bareLatex />
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </Panel>
        </motion.div>
      </AnimatePresence>

      {/* 操作区 */}
      <div>
        {!revealed ? (
          <Button size="lg" className="w-full" onClick={reveal} shimmer>
            <Eye size={16} /> 看答案
            <kbd className="ml-1 rounded border border-black/20 px-1.5 py-0.5 text-[10px] opacity-70">空格</kbd>
          </Button>
        ) : (
          <div>
            <p className="mb-2.5 text-center text-[12px] text-fg-mute">
              诚实打分 —— 打高了，下次它会在你忘光的时候才出现
            </p>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {RATINGS.map((r) => (
                <button
                  key={r.v}
                  onClick={() => grade(r.v)}
                  className={cn(
                    'group flex flex-col items-center gap-1 rounded-xl border bg-veil/3 px-3 py-3.5 transition-all duration-200 active:scale-[0.97]',
                    r.cls,
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
                    {r.label}
                    <kbd className="rounded border border-current/25 px-1 text-[10px] opacity-60">{r.key}</kbd>
                  </span>
                  <span className="text-[11px] text-fg-mute">{r.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-1.5 text-[11.5px] text-fg-faint">
        <Zap size={11} />
        FSRS 会按你的评分，结合这张卡的记忆稳定度算出下次出现的时间
      </div>
    </div>
  );
}
