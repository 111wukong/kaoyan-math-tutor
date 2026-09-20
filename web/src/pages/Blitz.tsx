import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Heart, Play, RotateCcw, Timer, Trophy, Zap } from 'lucide-react';
import { api, type Question } from '@/lib/api';
import { useApp } from '@/stores/app';
import { Panel, Button, Badge, Skeleton } from '@/components/ui/Primitives';
import { InlineMath } from '@/components/ui/Math';
import { NumberTicker } from '@/components/fx/Motion';
import { announceAchievements } from '@/components/ui/Toaster';
import { sfxCorrect, sfxWrong, sfxUrgent } from '@/lib/sfx';
import { cn } from '@/lib/utils';

const DURATION = 60;
const MAX_LIVES = 3;
const COMBO_STEPS = [
  { at: 20, mult: 5 }, { at: 10, mult: 4 }, { at: 5, mult: 3 }, { at: 3, mult: 2 },
];

function multiplierOf(combo: number) {
  for (const s of COMBO_STEPS) if (combo >= s.at) return s.mult;
  return combo >= 1 ? 1.5 : 1;
}

type Phase = 'idle' | 'playing' | 'over';

export default function Blitz() {
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);

  const [phase, setPhase] = useState<Phase>('idle');
  const [pool, setPool] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [best, setBest] = useState<any>(null);

  const [idx, setIdx] = useState(0);
  const [timeLeft, setTimeLeft] = useState(DURATION);
  const [lives, setLives] = useState(MAX_LIVES);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [wrong, setWrong] = useState(0);
  const [flash, setFlash] = useState<'right' | 'wrong' | null>(null);
  const [locked, setLocked] = useState(false);

  const lastTick = useRef(DURATION);

  const loadPool = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.catalog.questions({ type: 'choice', random: 1, limit: 60 });
      setPool(r.questions || []);
    } catch { /* 忽略 */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPool();
    api.game.state().then((r) => setBest(r?.blitz ?? null)).catch(() => {});
  }, [loadPool]);

  // 倒计时
  useEffect(() => {
    if (phase !== 'playing') return;
    const t = setInterval(() => {
      setTimeLeft((s) => {
        const next = s - 1;
        if (next <= 3 && next > 0) sfxUrgent();
        if (next <= 0) return 0;
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  // 时间到 / 命尽 → 结束
  useEffect(() => {
    if (phase !== 'playing') return;
    if (timeLeft <= 0 || lives <= 0) {
      setPhase('over');
      finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft, lives, phase]);

  const finish = async () => {
    try {
      const r = await api.game.blitz({ score, correct, wrong, bestCombo, seconds: DURATION - timeLeft });
      if (r?.best) setBest(r.best);
      if (r?.achievements?.length) announceAchievements(r.achievements, pushToast);
      refreshSnapshot();
    } catch { /* 忽略 */ }
  };

  const start = () => {
    if (!pool.length) return;
    setPhase('playing');
    setIdx(0);
    setTimeLeft(DURATION);
    lastTick.current = DURATION;
    setLives(MAX_LIVES);
    setScore(0);
    setCombo(0);
    setBestCombo(0);
    setCorrect(0);
    setWrong(0);
    setFlash(null);
    setLocked(false);
  };

  const current = pool[idx % Math.max(1, pool.length)];

  const answer = async (optKey: string) => {
    if (locked || !current || phase !== 'playing') return;
    setLocked(true);

    const mult = multiplierOf(combo);
    let ok = false;
    try {
      const r = await api.study.answer(current.id, optKey, 'blitz');
      /* 闪电战只抽单选题（见上面 questions({ type: 'choice' })），
       * 所以 correct 一定不是 null。这层兜底是给「服务端将来放宽题型」留的 ——
       * 真出现 null 时按「没答对」处理，不能让计时赛卡住。 */
      ok = r.correct === true;
      if (r.achievements?.length) announceAchievements(r.achievements, pushToast);
    } catch {
      ok = false;
    }

    if (ok) {
      const gained = Math.round(10 * mult);
      setScore((s) => s + gained);
      setCorrect((c) => c + 1);
      setCombo((c) => {
        const next = c + 1;
        setBestCombo((b) => Math.max(b, next));
        return next;
      });
      setFlash('right');
      sfxCorrect(combo + 1);
    } else {
      setWrong((w) => w + 1);
      setCombo(0);
      setLives((l) => l - 1);
      setFlash('wrong');
      sfxWrong();
    }

    setTimeout(() => setFlash(null), 380);
    setIdx((i) => i + 1);
    setLocked(false);
  };

  const mult = multiplierOf(combo);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[130px] rounded-2xl" />
        <Skeleton className="h-[300px] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* 状态条 */}
      <Panel className="relative overflow-hidden p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div>
              <div className="text-[11px] text-fg-mute">得分</div>
              <div className="text-[22px] font-bold leading-none text-fg tabular">
                <NumberTicker value={score} duration={300} />
              </div>
            </div>
            <div className="h-8 w-px bg-hairline" />
            <div>
              <div className="text-[11px] text-fg-mute">连击</div>
              <div className={cn('text-[22px] font-bold leading-none tabular', combo > 0 ? 'text-cyan' : 'text-fg-mute')}>
                {combo}
                {mult > 1 && <span className="ml-1 text-[12px] text-violet">×{mult}</span>}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              {Array.from({ length: MAX_LIVES }).map((_, i) => (
                <Heart
                  key={i}
                  size={16}
                  className={cn(
                    'transition-all duration-300',
                    i < lives ? 'fill-rose text-rose' : 'text-veil/15',
                  )}
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Timer size={15} className={cn(timeLeft <= 10 && phase === 'playing' ? 'text-rose' : 'text-fg-mute')} />
              <span className={cn('text-[19px] font-bold tabular', timeLeft <= 10 && phase === 'playing' ? 'text-rose' : 'text-fg')}>
                {timeLeft}
              </span>
            </div>
          </div>
        </div>

        {phase === 'playing' && (
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-veil/8">
            <div
              className={cn('h-full rounded-full transition-all duration-1000 ease-linear', timeLeft <= 10 ? 'bg-rose' : 'bg-gradient-to-r from-cyan to-violet')}
              style={{ width: `${(timeLeft / DURATION) * 100}%` }}
            />
          </div>
        )}
      </Panel>

      {/* 主区 */}
      <AnimatePresence mode="wait">
        {phase === 'idle' && (
          <motion.div key="idle" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            <Panel className="relative overflow-hidden p-7 text-center">
              <div className="pointer-events-none absolute -top-20 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-violet/14 blur-[80px]" />
              <div className="relative">
                <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-violet/25 bg-violet/12 text-violet">
                  <Zap size={26} />
                </div>
                <h1 className="text-[22px] font-semibold tracking-tight text-fg">闪电战</h1>
                <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-fg-soft">
                  {DURATION} 秒，{MAX_LIVES} 条命。答对连击加分，答错扣命。
                  抽题优先推你的薄弱考点，不是随机。
                </p>

                <div className="mx-auto mt-6 grid max-w-sm grid-cols-3 gap-3 text-left">
                  {[
                    { k: '3 连', v: '×2' },
                    { k: '5 连', v: '×3' },
                    { k: '10 连', v: '×4' },
                  ].map((x) => (
                    <div key={x.k} className="glass-subtle rounded-xl px-3 py-2.5">
                      <div className="text-[11px] text-fg-mute">{x.k}</div>
                      <div className="mt-0.5 text-[16px] font-semibold text-violet">{x.v}</div>
                    </div>
                  ))}
                </div>

                {best && (
                  <div className="mt-5 inline-flex items-center gap-2 rounded-xl border border-amber/25 bg-amber/8 px-3.5 py-2 text-[12.5px]">
                    <Trophy size={13} className="text-amber" />
                    <span className="text-fg-soft">最好成绩</span>
                    <span className="font-semibold text-amber-200 tabular">{best.score}</span>
                    <span className="text-fg-mute">· {best.date}</span>
                  </div>
                )}

                <div className="mt-7">
                  <Button size="lg" onClick={start} disabled={!pool.length} shimmer>
                    <Play size={16} /> 开始挑战
                  </Button>
                </div>
                <p className="mt-3 text-[11.5px] text-fg-faint">键盘 1-4 选选项，比鼠标快</p>
              </div>
            </Panel>
          </motion.div>
        )}

        {phase === 'playing' && current && (
          <motion.div
            key={current.id}
            initial={{ opacity: 0, y: 16, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <Panel
              className={cn(
                'p-5 transition-colors duration-200',
                flash === 'right' && 'border-emerald/45 bg-emerald/6',
                flash === 'wrong' && 'border-rose/45 bg-rose/6',
              )}
            >
              <div className="mb-4 text-[15px] leading-[1.85] text-fg">
                <InlineMath text={current.stem} />
              </div>
              <div className="space-y-2">
                {(current.options || []).map((o, i) => (
                  <button
                    key={o.k}
                    disabled={locked}
                    onClick={() => answer(o.k)}
                    className="group flex w-full items-center gap-3 rounded-xl border border-hairline bg-veil/3 px-3.5 py-2.5 text-left transition-all duration-150 hover:border-cyan/40 hover:bg-veil/7 active:scale-[0.99] disabled:opacity-60"
                  >
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-veil/10 bg-veil/5 text-[11.5px] font-semibold text-fg-mute transition-colors group-hover:border-cyan/35 group-hover:text-cyan">
                      {o.k}
                    </span>
                    <span className="min-w-0 flex-1 text-[13.5px] text-fg-soft">
                      <InlineMath text={o.t} />
                    </span>
                    <kbd className="hidden shrink-0 rounded border border-veil/8 px-1.5 py-0.5 text-[10px] text-fg-faint group-hover:block">
                      {i + 1}
                    </kbd>
                  </button>
                ))}
              </div>
            </Panel>
          </motion.div>
        )}

        {phase === 'over' && (
          <motion.div key="over" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <Panel className="relative overflow-hidden p-7 text-center">
              <div className="pointer-events-none absolute -top-20 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-cyan/12 blur-[80px]" />
              <div className="relative">
                <h2 className="text-[21px] font-semibold tracking-tight text-fg">
                  {lives <= 0 ? '命用完了' : '时间到'}
                </h2>
                <div className="mx-auto mt-6 grid max-w-md grid-cols-4 gap-2.5">
                  <ResultStat label="得分" value={score} accent="text-cyan" />
                  <ResultStat label="答对" value={correct} accent="text-emerald" />
                  <ResultStat label="答错" value={wrong} accent="text-rose" />
                  <ResultStat label="最高连击" value={bestCombo} accent="text-violet" />
                </div>

                {best && score >= (best.score || 0) && score > 0 && (
                  <div className="mt-5 inline-flex items-center gap-2 rounded-xl border border-amber/30 bg-amber/10 px-4 py-2.5">
                    <Trophy size={15} className="text-amber" />
                    <span className="text-[13px] font-medium text-amber-100">新纪录！</span>
                  </div>
                )}

                <div className="mt-7 flex flex-wrap justify-center gap-2.5">
                  <Button variant="outline" onClick={() => { setPhase('idle'); loadPool(); }}>
                    <RotateCcw size={14} /> 再来一局
                  </Button>
                  <Button onClick={start} disabled={!pool.length} shimmer>
                    <Play size={14} /> 立即重开
                  </Button>
                </div>
              </div>
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 键盘 */}
      <KeyboardBinder enabled={phase === 'playing' && !locked} options={current?.options?.length || 0} onPick={answer} />
    </div>
  );
}

function ResultStat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="glass-subtle rounded-xl px-2 py-3">
      <div className={cn('text-[20px] font-bold tabular', accent)}>
        <NumberTicker value={value} duration={700} />
      </div>
      <div className="mt-1 text-[10.5px] text-fg-mute">{label}</div>
    </div>
  );
}

function KeyboardBinder({ enabled, options, onPick }: { enabled: boolean; options: number; onPick: (k: string) => void }) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= options) {
        e.preventDefault();
        onPick(['A', 'B', 'C', 'D'][n - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, options, onPick]);
  return null;
}
