import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, CircleAlert, Filter, RotateCcw, Trophy } from 'lucide-react';
import { api, type Mistake } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { Panel, Button, Skeleton, Badge, EmptyState } from '@/components/ui/Primitives';
import { RichText, InlineMath } from '@/components/ui/Math';
import { QuestionCard } from '@/components/QuestionCard';
import { announceAchievements } from '@/components/ui/Toaster';
import { cn, DIFFICULTY, relTime } from '@/lib/utils';

export default function Mistakes() {
  const nav = useNavigate();
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);
  const { data, loading, reload } = useAsync(() => api.study.mistakes(), []);

  const [filterKid, setFilterKid] = useState<string>('');
  const [openId, setOpenId] = useState<string>('');
  const [retrain, setRetrain] = useState<Mistake[] | null>(null);
  const [retrainIdx, setRetrainIdx] = useState(0);

  const all = data?.mistakes || [];
  const filtered = useMemo(
    () => (filterKid ? all.filter((m) => m.kid === filterKid) : all),
    [all, filterKid],
  );

  const kidGroups = useMemo(() => {
    const map = new Map<string, { kid: string; title: string; n: number }>();
    all.forEach((m) => {
      const g = map.get(m.kid) || { kid: m.kid, title: m.kidTitle || m.kid, n: 0 };
      g.n += 1;
      map.set(m.kid, g);
    });
    return [...map.values()].sort((a, b) => b.n - a.n);
  }, [all]);

  const startRetrain = () => {
    if (!filtered.length) return;
    setRetrain(filtered.slice(0, 10));
    setRetrainIdx(0);
  };

  // ---------- 重练模式 ----------
  if (retrain) {
    const cur = retrain[retrainIdx];
    if (!cur) {
      return (
        <Panel className="p-8 text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-emerald/25 bg-emerald/10 text-emerald">
            <Trophy size={24} />
          </div>
          <h2 className="text-[20px] font-semibold text-fg">重练结束</h2>
          <p className="mt-2 text-[13.5px] text-fg-soft">
            答对的题已经自动移出错题本了。剩下的说明还没吃透。
          </p>
          <div className="mt-6 flex justify-center gap-2.5">
            <Button variant="outline" onClick={() => { setRetrain(null); reload(); refreshSnapshot(); }}>
              返回错题本
            </Button>
            <Button onClick={() => { setRetrain(null); reload(); nav('/learn'); }}>
              去补知识点
            </Button>
          </div>
        </Panel>
      );
    }

    return (
      <div className="space-y-4">
        <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl border border-rose/25 bg-rose/10 text-rose">
              <RotateCcw size={16} />
            </div>
            <div>
              <div className="text-[14px] font-semibold text-fg">错题重练</div>
              <div className="text-[11.5px] text-fg-mute">第 {retrainIdx + 1} / {retrain.length} 题 · 答对自动移出</div>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setRetrain(null)}>退出重练</Button>
        </Panel>

        <QuestionCard
          key={cur.qid}
          question={{
            id: cur.qid, kid: cur.kid, type: cur.type as any, difficulty: cur.difficulty,
            stem: cur.stem, options: cur.options,
            sourceType: cur.sourceType, sourceYear: cur.sourceYear, source: '',
          }}
          index={retrainIdx}
          total={retrain.length}
          context="mistake"
          onAnswer={async (ans) => {
            const r = await api.study.answer(cur.qid, ans, 'mistake');
            if (r.achievements?.length) announceAchievements(r.achievements, pushToast);
            return r;
          }}
          onNext={() => {
            if (retrainIdx + 1 >= retrain.length) { setRetrainIdx(retrainIdx + 1); reload(); refreshSnapshot(); }
            else setRetrainIdx((i) => i + 1);
          }}
        />
      </div>
    );
  }

  // ---------- 列表模式 ----------
  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-[70px] rounded-2xl" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[92px] rounded-2xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-rose/25 bg-rose/10 text-rose">
              <CircleAlert size={18} />
            </div>
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-fg">错题本</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-mute">
                {all.length > 0
                  ? `${all.length} 道待攻克 · 每题只看最后一次作答`
                  : '干净，继续保持'}
              </p>
            </div>
          </div>
          {all.length > 0 && (
            <Button onClick={startRetrain} disabled={!filtered.length} shimmer>
              <RotateCcw size={14} /> 重练{filterKid ? '当前筛选' : ''}（最多 10 题）
            </Button>
          )}
        </div>

        {kidGroups.length > 1 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <Filter size={13} className="mr-1 text-fg-faint" />
            <FilterChip active={!filterKid} onClick={() => setFilterKid('')}>
              全部 {all.length}
            </FilterChip>
            {kidGroups.map((g) => (
              <FilterChip key={g.kid} active={filterKid === g.kid} onClick={() => setFilterKid(g.kid)}>
                {g.title} {g.n}
              </FilterChip>
            ))}
          </div>
        )}
      </Panel>

      {filtered.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Trophy size={24} />}
            title={all.length === 0 ? '错题本是空的' : '这个考点下没有错题'}
            desc={all.length === 0
              ? '做错的题会自动进来，答对之后自动移出。现在没有欠账。'
              : '换个考点看看，或者取消筛选。'}
            action={all.length === 0 ? <Button onClick={() => nav('/quiz')}>去做一套题</Button> : undefined}
          />
        </Panel>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((m, i) => (
            <MistakeRow
              key={m.qid}
              m={m}
              index={i}
              open={openId === m.qid}
              onToggle={() => setOpenId(openId === m.qid ? '' : m.qid)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-lg border px-2.5 py-1 text-[11.5px] transition-all duration-200',
        active
          ? 'border-cyan/35 bg-cyan/12 text-cyan'
          : 'border-veil/8 bg-veil/3 text-fg-mute hover:border-veil/16 hover:text-fg-soft',
      )}
    >
      {children}
    </button>
  );
}

function MistakeRow({ m, index, open, onToggle }: { m: Mistake; index: number; open: boolean; onToggle: () => void }) {
  const diff = DIFFICULTY[m.difficulty] || DIFFICULTY[2];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.035, 0.4), ease: [0.16, 1, 0.3, 1] }}
    >
      <Panel className={cn('overflow-hidden transition-colors duration-250', open && 'border-rose/22')}>
        <button onClick={onToggle} className="flex w-full items-start gap-3 p-4 text-left">
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-rose/28 bg-rose/10 text-[11px] font-semibold text-rose-200 tabular">
            {m.wrongCount}
          </span>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[13.5px] leading-relaxed text-fg-soft">
              <RichText text={m.stem} bareLatex inline />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link
                to={`/learn/${m.kid}`}
                onClick={(e) => e.stopPropagation()}
                className="text-[11.5px] text-cyan hover:text-cyan-200"
              >
                {m.kidTitle}
              </Link>
              <span className={cn('rounded border px-1.5 py-px text-[10.5px]', diff.cls)}>{diff.label}</span>
              <span className="text-[11px] text-fg-faint">
                答过 {m.attempts} 次 · 错 {m.wrongCount} 次
              </span>
              <span className="text-[11px] text-fg-faint">{relTime(m.lastAt)}</span>
            </div>
          </div>
          <ChevronDown
            size={15}
            className={cn('mt-1 shrink-0 text-fg-faint transition-transform duration-300', open && 'rotate-180')}
          />
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden border-t border-hairline"
            >
              <div className="space-y-3.5 p-4">
                <div>
                  <div className="mb-1.5 text-[11.5px] font-medium text-fg-mute">题干</div>
                  <div className="text-[13.5px] leading-relaxed text-fg">
                    <RichText text={m.stem} bareLatex />
                  </div>
                </div>

                {m.options && (
                  <div className="space-y-1.5">
                    {m.options.map((o) => (
                      <div
                        key={o.k}
                        className={cn(
                          'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px]',
                          String(m.answer).toUpperCase() === o.k.toUpperCase()
                            ? 'border-emerald/35 bg-emerald/8 text-emerald-100'
                            : 'border-veil/7 bg-veil/2 text-fg-soft',
                        )}
                      >
                        <span className="font-semibold">{o.k}</span>
                        <span><InlineMath text={o.t} /></span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-rose/22 bg-rose/6 px-3.5 py-2.5">
                    <div className="mb-1 text-[11.5px] font-medium text-rose-200/80">你的答案</div>
                    <div className="font-mono text-[13px] text-rose-100">
                      {m.myAnswer ? <InlineMath text={m.myAnswer} /> : '—'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-emerald/22 bg-emerald/6 px-3.5 py-2.5">
                    <div className="mb-1 text-[11.5px] font-medium text-emerald-200/80">正确答案</div>
                    <div className="font-mono text-[13px] text-emerald-100">
                      <InlineMath text={m.answer} />
                    </div>
                  </div>
                </div>

                {m.analysis && (
                  <div>
                    <div className="mb-1.5 text-[11.5px] font-medium text-fg-mute">解析</div>
                    <div className="text-[13px] leading-[1.85] text-fg-soft">
                      <RichText text={m.analysis} bareLatex />
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Panel>
    </motion.div>
  );
}
