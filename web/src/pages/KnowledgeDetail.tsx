import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, BookOpen, ChevronRight, Lightbulb, Link2, MessagesSquare,
  PenLine, Plus, Sparkles, StickyNote, Target, Trash2, Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { Panel, Button, Skeleton, Badge, SectionTitle, TextArea, EmptyState } from '@/components/ui/Primitives';
import { RichText } from '@/components/ui/Math';
import { ProgressRing } from '@/components/fx/Motion';
import { QuestionCard } from '@/components/QuestionCard';
import { announceAchievements } from '@/components/ui/Toaster';
import { cn, DIFFICULTY, MASTERY_STYLE, relTime, cssVar } from '@/lib/utils';

export default function KnowledgeDetail() {
  const { kid = '' } = useParams();
  const nav = useNavigate();
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);
  const { data, loading, reload } = useAsync(() => api.catalog.knowledge(kid), [kid], { key: `catalog.knowledge:${kid}` });

  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [practice, setPractice] = useState<any>(null);
  /* 举一反三生成的题排成队列，答完一道自动出下一道 ——
   * 一次只生成一道的话，用户得反复点按钮，生成出来的题也没法连着做。 */
  const [queue, setQueue] = useState<any[]>([]);
  const [genLoading, setGenLoading] = useState(false);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[200px] rounded-2xl" />
        <Skeleton className="h-[300px] rounded-2xl" />
      </div>
    );
  }

  if (!data?.node) {
    return (
      <Panel>
        <EmptyState
          icon={<BookOpen size={22} />}
          title="找不到这个考点"
          desc="链接可能过期了，或者知识点被移除。"
          action={<Button onClick={() => nav('/learn')}>返回知识树</Button>}
        />
      </Panel>
    );
  }

  const { node, mastery, related, notes, questions, graph } = data;
  const ms = MASTERY_STYLE[mastery.level as keyof typeof MASTERY_STYLE] || MASTERY_STYLE.new;
  const diff = DIFFICULTY[node.difficulty] || DIFFICULTY[2];

  const startPractice = () => {
    if (!questions.length) {
      pushToast({ kind: 'warn', title: '这个考点还没有配套题目' });
      return;
    }
    const q = questions[Math.floor(Math.random() * questions.length)];
    setQueue([]);
    setPractice(q);
  };

  /* 举一反三：让模型按这个考点出几道可自动判分的变式题。
   *
   * 生成的题会落库成「我的题」，同时进入掌握度计算 ——
   * 练了不涨分的话，用户没理由继续用这个功能。 */
  const genVariants = async () => {
    setGenLoading(true);
    try {
      const r = await api.ai.generate(kid, { count: 3 });
      if (!r.created.length) {
        pushToast({
          kind: 'warn',
          title: '模型这次没给出可用的题',
          desc: r.skippedUnjudgeable
            ? `有 ${r.skippedUnjudgeable} 道因为判不了分被丢掉了，再点一次试试`
            : '再点一次试试，或者换个考点',
        });
        return;
      }
      setQueue(r.created.slice(1));
      setPractice(r.created[0]);
      const extra = [
        r.skippedUnjudgeable ? `${r.skippedUnjudgeable} 道判不了分已丢弃` : '',
        r.skippedDuplicate ? `${r.skippedDuplicate} 道重复已跳过` : '',
      ].filter(Boolean).join(' · ');
      pushToast({
        kind: 'success',
        title: `生成了 ${r.created.length} 道变式题`,
        desc: extra || undefined,
      });
    } catch (e: any) {
      pushToast({ kind: 'error', title: e?.message || '生成失败' });
    } finally {
      setGenLoading(false);
    }
  };

  const addNote = async () => {
    const t = noteText.trim();
    if (!t) return;
    setSavingNote(true);
    try {
      await api.study.addNote(kid, t);
      setNoteText('');
      reload();
      pushToast({ kind: 'success', title: '笔记已保存' });
    } catch {
      pushToast({ kind: 'error', title: '保存失败' });
    } finally {
      setSavingNote(false);
    }
  };

  const removeNote = async (id: string) => {
    try {
      await api.study.deleteNote(id);
      reload();
    } catch { /* 忽略 */ }
  };

  return (
    <div className="space-y-5">
      {/* 面包屑 */}
      <div className="flex items-center gap-1.5 text-[12.5px] text-fg-mute">
        <Link to="/learn" className="flex items-center gap-1 transition-colors hover:text-cyan">
          <ArrowLeft size={13} /> 知识树
        </Link>
        <ChevronRight size={12} className="text-fg-faint" />
        <span style={{ color: node.color }}>{node.categoryName}</span>
        <ChevronRight size={12} className="text-fg-faint" />
        <span className="truncate text-fg-soft">{node.chapterName}</span>
      </div>

      {/* 标题区 */}
      <Panel className="relative overflow-hidden p-5 sm:p-6">
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full opacity-20 blur-[90px]"
          style={{ background: node.color }}
        />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={cn('rounded-md border px-2 py-0.5 text-[11.5px]', diff.cls)}>
                难度 · {diff.label}
              </span>
              <span className={cn('rounded-md border px-2 py-0.5 text-[11.5px]', ms.cls)}>
                {ms.label}
              </span>
              <Badge tone="neutral">
                {Array.isArray(node.exam) ? (node.exam.includes('all') ? '数一/二/三' : node.exam.join(' · ')) : '全部'}
              </Badge>
            </div>
            <h1 className="text-[23px] font-semibold leading-tight tracking-tight text-fg sm:text-[26px]">
              {node.title}
            </h1>
            <p className="mt-2 text-[12.5px] text-fg-mute">
              配套 {questions.length} 道题
              {mastery.attempts > 0 && ` · 已作答 ${mastery.attempts} 次 · 正确率 ${Math.round(mastery.accuracy * 100)}%`}
            </p>
          </div>

          <div className="flex items-center gap-5">
            <ProgressRing
              value={mastery.attempts > 0 ? Math.round(mastery.accuracy * 100) : 0}
              size={92}
              stroke={7}
              gradient={
                mastery.level === 'mastered' ? [cssVar('--color-emerald', '#34d399'), cssVar('--color-cyan', '#22d3ee')]
                  : mastery.level === 'proficient' ? [cssVar('--color-cyan', '#22d3ee'), cssVar('--color-blue', '#3b82f6')]
                    : mastery.level === 'learning' ? [cssVar('--color-amber', '#fbbf24'), cssVar('--color-amber', '#f59e0b')]
                      : [cssVar('--color-hairline-strong', 'rgba(255,255,255,0.2)'), cssVar('--color-hairline', 'rgba(255,255,255,0.1)')]
              }
              label={
                <div className="text-center">
                  <div className="text-[19px] font-bold leading-none text-fg tabular">
                    {mastery.attempts > 0 ? `${Math.round(mastery.accuracy * 100)}` : '—'}
                    {mastery.attempts > 0 && <span className="text-[11px] text-fg-mute">%</span>}
                  </div>
                  <div className="mt-0.5 text-[9.5px] text-fg-mute">正确率</div>
                </div>
              }
            />
          </div>
        </div>

        <div className="relative mt-5 flex flex-wrap gap-2.5">
          <Button onClick={startPractice} shimmer>
            <Zap size={14} /> 练一道
          </Button>
          <Button variant="outline" onClick={genVariants} loading={genLoading}>
            <Sparkles size={14} /> 举一反三
          </Button>
          <Button variant="outline" onClick={() => nav(`/chat?kid=${kid}`)}>
            <MessagesSquare size={14} /> 让 AI 讲这个考点
          </Button>
          {mastery.attempts >= 3 && mastery.allRight && (
            <Badge tone="emerald" className="self-center">
              <Sparkles size={10} /> 该考点下每道题都答对过
            </Badge>
          )}
        </div>
        {mastery.ownQuestions > 0 && (
          <p className="relative mt-3 text-[11.5px] text-fg-mute">
            已有 {mastery.ownQuestions} 道自建题（含 AI 变式题）参与掌握度计算
            {mastery.allRight ? '' : '，但「精通」只按内置题算'}
          </p>
        )}
      </Panel>

      {/* 练习 */}
      <AnimatePresence>
        {practice && (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            <QuestionCard
              key={practice.id}
              question={practice}
              index={0}
              total={queue.length + 1}
              context="quiz"
              onAnswer={async (ans) => {
                const r = await api.study.answer(practice.id, ans, 'quiz');
                if (r.achievements?.length) announceAchievements(r.achievements, pushToast);
                return r;
              }}
              onNext={() => {
                /* 队列里还有就接着出下一道，否则收工。
                 * 收工时才 reload —— 中途 reload 会让下面的题目列表闪一下。 */
                if (queue.length) {
                  setPractice(queue[0]);
                  setQueue(queue.slice(1));
                } else {
                  setPractice(null);
                  reload();
                  refreshSnapshot();
                }
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          {/* 正文 */}
          <Panel className="p-5">
            <SectionTitle title="考点内容" desc="公式用 KaTeX 渲染，可复制" className="mb-3" />
            <div className="text-[14px]">
              <RichText text={node.content} bareLatex />
            </div>
          </Panel>

          {/* 例题 */}
          {node.example && (
            <Panel className="relative overflow-hidden p-5">
              <div className="pointer-events-none absolute -left-10 -top-10 h-32 w-32 rounded-full bg-amber/8 blur-[60px]" />
              <SectionTitle
                title={<span className="flex items-center gap-2"><Lightbulb size={15} className="text-amber" /> 典型例题</span>}
                className="mb-3"
              />
              <div className="text-[13.5px]">
                <RichText text={node.example} bareLatex />
              </div>
            </Panel>
          )}

          {/* 笔记 */}
          <Panel className="p-5">
            <SectionTitle
              title={<span className="flex items-center gap-2"><StickyNote size={15} className="text-cyan" /> 我的笔记</span>}
              desc="写下你自己的话 —— 用自己的语言复述，记得最牢"
              className="mb-3"
            />
            <div className="flex gap-2.5">
              <TextArea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="比如：罗尔定理的关键是先构造 F(x) 让两端相等…"
                rows={2}
                className="flex-1"
              />
              <Button onClick={addNote} loading={savingNote} disabled={!noteText.trim()} className="self-end">
                <Plus size={14} /> 记下
              </Button>
            </div>

            {notes?.length > 0 && (
              <div className="mt-4 space-y-2">
                {notes.map((n: any) => (
                  <div key={n.id} className="group flex items-start gap-3 rounded-xl border border-veil/7 bg-veil/3 px-3.5 py-2.5">
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-fg-soft">{n.text}</p>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-fg-faint">{n.date}</span>
                      <button
                        onClick={() => removeNote(n.id)}
                        aria-label="删除笔记"
                        className="grid h-6 w-6 place-items-center rounded-md text-fg-faint opacity-0 transition-all hover:bg-rose/12 hover:text-rose group-hover:opacity-100"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* 侧栏 */}
        <div className="space-y-4">
          {/* 掌握度明细 */}
          <Panel className="p-5">
            <SectionTitle title="掌握情况" className="mb-3" />
            <div className="space-y-3 text-[12.5px]">
              <Row label="当前状态" value={<span className={cn('rounded border px-1.5 py-px', ms.cls)}>{ms.label}</span>} />
              <Row label="作答次数" value={<span className="tabular text-fg">{mastery.attempts}</span>} />
              <Row label="答对次数" value={<span className="tabular text-fg">{mastery.correct}</span>} />
              <Row label="已见题目" value={<span className="tabular text-fg">{mastery.questionsSeen} / {mastery.questions}</span>} />
              <Row label="全部答对过" value={mastery.allRight ? <span className="text-emerald">是</span> : <span className="text-fg-mute">否</span>} />
            </div>
            {mastery.level !== 'mastered' && (
              <p className="mt-3.5 rounded-lg border border-veil/7 bg-veil/3 px-3 py-2.5 text-[11.5px] leading-relaxed text-fg-mute">
                评上「精通」需要：作答 ≥ 3 次、正确率 ≥ 90%，且该考点下每道题都答对过。
              </p>
            )}
          </Panel>

          {/* 依赖关系（有向图边）
           *
           * 与下面「相关考点」的区别，界面上要让人一眼看出来：
           *   相关 = 无向，常一起考，先学哪个都行
           *   依赖 = 有向，hard 前置缺了根本学不懂
           * 把两者画成一个样子，用户就分不清「该先补哪个」了。 */}
          {(graph?.prerequisites?.length > 0 || graph?.unlocks?.length > 0 || graph?.confusable?.length > 0) && (
            <Panel className="p-5">
              <SectionTitle
                title={<span className="flex items-center gap-2"><ArrowDown size={14} className="text-amber" /> 依赖关系</span>}
                desc={graph.impact > 0
                  ? `有 ${graph.impact} 个下游考点建立在它之上`
                  : '没有下游考点依赖它'}
                className="mb-3"
              />

              {graph.prerequisites?.length > 0 && (
                <div className="mb-3.5">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-fg-mute">
                    <ArrowDown size={11} /> 学它之前应该先会
                  </div>
                  <div className="space-y-1.5">
                    {graph.prerequisites.map((p: any) => (
                      <Link
                        key={p.id}
                        to={`/learn/${p.id}`}
                        className="group flex items-start gap-2.5 rounded-lg border border-veil/7 bg-veil/3 px-3 py-2 transition-all hover:border-amber/25 hover:bg-veil/6"
                      >
                        <span
                          className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                            p.strength === 'hard' ? 'bg-rose' : 'bg-amber')}
                          title={p.strength === 'hard' ? '硬前置：缺了学不动' : '软前置：缺了能学但吃力'}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] text-fg-soft">{p.title}</div>
                          {p.reason && (
                            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fg-faint">{p.reason}</div>
                          )}
                        </div>
                        <ChevronRight size={12} className="mt-0.5 shrink-0 text-fg-faint transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {graph.unlocks?.length > 0 && (
                <div className="mb-3.5">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-fg-mute">
                    <ArrowUp size={11} /> 学会它能解锁
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {graph.unlocks.map((u: any) => (
                      <Link
                        key={u.id}
                        to={`/learn/${u.id}`}
                        className="rounded-md border border-veil/7 bg-veil/3 px-2 py-1 text-[11.5px] text-fg-soft transition-colors hover:border-emerald/25 hover:text-emerald"
                      >
                        {u.title}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {graph.confusable?.length > 0 && (
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-fg-mute">
                    <AlertTriangle size={11} className="text-rose" /> 最容易和它搞混
                  </div>
                  <div className="space-y-1.5">
                    {graph.confusable.map((c: any) => (
                      <Link
                        key={c.id}
                        to={`/learn/${c.id}`}
                        className="group flex items-start gap-2.5 rounded-lg border border-rose/12 bg-rose/4 px-3 py-2 transition-all hover:border-rose/30"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] text-fg-soft">{c.title}</div>
                          {c.reason && (
                            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fg-faint">{c.reason}</div>
                          )}
                        </div>
                        <ChevronRight size={12} className="mt-0.5 shrink-0 text-fg-faint transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          )}

          {/* 关联 */}
          {related?.length > 0 && (
            <Panel className="p-5">
              <SectionTitle
                title={<span className="flex items-center gap-2"><Link2 size={14} className="text-violet" /> 相关考点</span>}
                desc="常在同一道大题里前后衔接"
                className="mb-3"
              />
              <div className="space-y-1.5">
                {related.map((r: any) => (
                  <Link
                    key={r.id}
                    to={`/learn/${r.id}`}
                    className="group flex items-center gap-2 rounded-lg border border-veil/7 bg-veil/3 px-3 py-2 text-[12.5px] text-fg-soft transition-all hover:border-violet/25 hover:bg-veil/6"
                  >
                    <Target size={12} className="shrink-0 text-fg-faint" />
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    <ChevronRight size={12} className="shrink-0 text-fg-faint transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ))}
              </div>
            </Panel>
          )}

          {/* 作答历史 */}
          {data.history?.length > 0 && (
            <Panel className="p-5">
              <SectionTitle title="最近作答" className="mb-3" />
              <div className="space-y-1.5">
                {data.history.slice(0, 8).map((h: any, i: number) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-lg border border-veil/6 bg-veil/2 px-3 py-2">
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', h.correct ? 'bg-emerald' : 'bg-rose')} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-soft">{h.answer || '—'}</span>
                    <span className="shrink-0 text-[10.5px] text-fg-faint">{relTime(h.ts)}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel className="p-4">
            <div className="flex items-start gap-2.5 text-[11.5px] leading-relaxed text-fg-mute">
              <PenLine size={13} className="mt-0.5 shrink-0 text-fg-faint" />
              <span>做错的题会自动进错题本；每答一次，FSRS 都会重新估算这个考点下次该什么时候复习。</span>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-mute">{label}</span>
      {value}
    </div>
  );
}
