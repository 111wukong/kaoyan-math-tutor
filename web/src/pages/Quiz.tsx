import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { ArrowRight, RefreshCw, Sparkles, Target } from 'lucide-react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { Panel, Button, SectionTitle, Skeleton, Badge } from '@/components/ui/Primitives';
import { Meter } from '@/components/fx/Motion';
import { QuestionCard, QuizEmpty } from '@/components/QuestionCard';
import { announceAchievements } from '@/components/ui/Toaster';
import { NumberTicker } from '@/components/fx/Motion';
import { sfxLevelUp } from '@/lib/sfx';
import { pct } from '@/lib/utils';

export default function Quiz() {
  const nav = useNavigate();
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);
  const { data, loading, reload } = useAsync(() => api.study.daily(), [], { key: 'study.daily' });

  const [idx, setIdx] = useState(0);
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [xpGained, setXpGained] = useState(0);
  const [finished, setFinished] = useState(false);

  const questions = data?.quiz || [];
  const current = questions[idx];
  const doneCount = Object.keys(answered).length;

  const handleAnswer = async (ans: string) => {
    const r = await api.study.answer(current.id, ans, 'quiz');
    setAnswered((m) => ({ ...m, [current.id]: r.correct }));
    setXpGained((v) => v + (r.xp?.gained || 0));
    if (r.achievements?.length) announceAchievements(r.achievements, pushToast);
    if (r.xp?.levelUp) {
      sfxLevelUp();
      pushToast({ kind: 'xp', title: `升到 ${r.xp.to} 级 · ${r.xp.title}`, desc: '继续保持', ttl: 5000 });
    }
    return r;
  };

  const handleNext = () => {
    if (idx + 1 >= questions.length) {
      setFinished(true);
      refreshSnapshot();
      api.study.checkin(0, false).catch(() => {});
      return;
    }
    setIdx((i) => i + 1);
  };

  const restart = async () => {
    await api.study.refreshDaily();
    setIdx(0);
    setAnswered({});
    setXpGained(0);
    setFinished(false);
    reload();
  };

  const correctCount = useMemo(
    () => Object.values(answered).filter(Boolean).length,
    [answered],
  );

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[70px] rounded-2xl" />
        <Skeleton className="h-[340px] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight text-fg">每日一练</h1>
            <p className="mt-1 text-[12.5px] text-fg-mute">
              抽题优先「掌握度低 + 错题多」的考点，不是随机抽
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-[11.5px] text-fg-mute">进度</div>
              <div className="text-[15px] font-semibold text-fg tabular">
                {doneCount} / {questions.length}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={restart}>
              <RefreshCw size={13} /> 换一套
            </Button>
          </div>
        </div>
        <Meter
          value={questions.length ? (doneCount / questions.length) * 100 : 0}
          className="mt-4"
          height={4}
        />
      </Panel>

      {questions.length === 0 ? (
        <QuizEmpty
          title="题库是空的"
          desc="内置题库应该已经有 204 道题。如果这里是空的，去「设置」看看数据是否正常。"
          action={<Button onClick={() => nav('/settings')}>去设置</Button>}
        />
      ) : finished ? (
        <FinishCard
          total={questions.length}
          correct={correctCount}
          xp={xpGained}
          onRestart={restart}
          onReview={() => nav('/mistakes')}
        />
      ) : current ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-mute">
            <Target size={13} className="text-cyan" />
            <span>本套共 {questions.length} 题</span>
            {doneCount > 0 && (
              <>
                <span className="text-fg-faint">·</span>
                <span>已答对 {correctCount} 题</span>
              </>
            )}
            {xpGained > 0 && (
              <>
                <span className="text-fg-faint">·</span>
                <Badge tone="violet"><Sparkles size={10} /> +{xpGained} XP</Badge>
              </>
            )}
          </div>

          <QuestionCard
            key={current.id}
            question={current}
            index={idx}
            total={questions.length}
            context="quiz"
            onAnswer={handleAnswer}
            onNext={handleNext}
          />

          {/* 题目缩略进度 */}
          <div className="flex flex-wrap gap-1.5">
            {questions.map((q: any, i: number) => {
              const st = answered[q.id];
              const isCur = i === idx;
              return (
                <button
                  key={q.id}
                  onClick={() => setIdx(i)}
                  className={`h-7 w-7 rounded-lg border text-[11px] font-medium transition-all ${
                    isCur ? 'border-cyan/50 bg-cyan/15 text-cyan'
                      : st === true ? 'border-emerald/35 bg-emerald/12 text-emerald-200'
                        : st === false ? 'border-rose/35 bg-rose/12 text-rose-200'
                          : 'border-veil/8 bg-veil/3 text-fg-mute hover:border-veil/16'
                  }`}
                  aria-label={`第 ${i + 1} 题`}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

function FinishCard({
  total, correct, xp, onRestart, onReview,
}: {
  total: number; correct: number; xp: number; onRestart: () => void; onReview: () => void;
}) {
  const rate = pct(correct, total);
  const verdict = rate === 100 ? '全对，状态在线。'
    : rate >= 80 ? '整体不错，个别地方再瞄一眼。'
      : rate >= 60 ? '及格线附近，错的那几道值得重做。'
        : '今天手感一般 —— 错题比新题更值得花时间。';

  return (
    <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>
      <Panel className="relative overflow-hidden p-7 text-center">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-emerald/12 blur-[90px]" />
        <div className="relative">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-emerald/25 bg-emerald/10 text-emerald">
            <Sparkles size={24} />
          </div>
          <h2 className="text-[22px] font-semibold tracking-tight text-fg">今日一练完成</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-fg-soft">{verdict}</p>

          <div className="mx-auto mt-6 grid max-w-md grid-cols-3 gap-3">
            <div className="glass-subtle rounded-xl px-3 py-3">
              <div className="text-[22px] font-semibold text-fg tabular">
                <NumberTicker value={correct} /><span className="text-[14px] text-fg-mute">/{total}</span>
              </div>
              <div className="mt-1 text-[11px] text-fg-mute">答对</div>
            </div>
            <div className="glass-subtle rounded-xl px-3 py-3">
              <div className="text-[22px] font-semibold text-emerald tabular">
                <NumberTicker value={rate} suffix="%" />
              </div>
              <div className="mt-1 text-[11px] text-fg-mute">正确率</div>
            </div>
            <div className="glass-subtle rounded-xl px-3 py-3">
              <div className="text-[22px] font-semibold text-violet tabular">
                +<NumberTicker value={xp} />
              </div>
              <div className="mt-1 text-[11px] text-fg-mute">XP</div>
            </div>
          </div>

          <div className="mt-7 flex flex-wrap justify-center gap-2.5">
            <Button onClick={onRestart} variant="outline">
              <RefreshCw size={14} /> 再来一套
            </Button>
            <Button onClick={onReview}>
              看错题本 <ArrowRight size={14} />
            </Button>
          </div>
        </div>
      </Panel>
    </motion.div>
  );
}
