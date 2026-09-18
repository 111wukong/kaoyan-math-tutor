/* 多智能体课堂
 *
 * 设计意图（不是装饰）：
 *   自学最大的问题是「不知道自己不知道什么」。老师讲一遍你点头，其实没懂。
 *   所以这里放了三个各错各的同学 —— 小明错概念、小红错计算、小刚追本质。
 *   他们踩的坑，大概率就是你会踩的坑。看别人踩，比自己踩便宜。
 *
 * 交互铁律（沿用原项目）：你不动手，这节课就不往下走。
 *   每轮老师会留一个问题给你。你不回答就只能看别人说 —— 这是故意的。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Eraser, GraduationCap, MessageSquarePlus, PenLine, Sparkles, Users, Zap,
} from 'lucide-react';
import { api, type ClassRole, type ClassroomTurn } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { Panel, Button, Badge, EmptyState, Skeleton, Segmented } from '@/components/ui/Primitives';
import { RichText } from '@/components/ui/Math';
import { sfxTick } from '@/lib/sfx';
import { cn } from '@/lib/utils';

/* ============================================================
   角色设定 —— 每个人的颜色、头像、以及"他负责犯哪类错"
   ============================================================ */
const ROLES: Record<ClassRole, {
  name: string;
  avatar: string;
  tag: string;
  avatarCls: string;
  bubbleCls: string;
  accentCls: string;
  dotCls: string;
}> = {
  teacher: {
    name: '老师',
    avatar: '师',
    tag: '主讲',
    avatarCls: 'border-cyan/30 bg-cyan/12 text-cyan',
    bubbleCls: 'border-cyan/20 bg-cyan/6',
    accentCls: 'text-cyan',
    dotCls: 'bg-cyan',
  },
  xiaoming: {
    name: '小明',
    avatar: '明',
    tag: '概念性错误',
    avatarCls: 'border-amber/30 bg-amber/12 text-amber',
    bubbleCls: 'border-amber/18 bg-amber/5',
    accentCls: 'text-amber',
    dotCls: 'bg-amber',
  },
  xiaohong: {
    name: '小红',
    avatar: '红',
    tag: '计算细节',
    avatarCls: 'border-violet/30 bg-violet/12 text-violet',
    bubbleCls: 'border-violet/18 bg-violet/5',
    accentCls: 'text-violet',
    dotCls: 'bg-violet',
  },
  xiaogang: {
    name: '小刚',
    avatar: '刚',
    tag: '追问本质',
    avatarCls: 'border-emerald/30 bg-emerald/12 text-emerald',
    bubbleCls: 'border-emerald/18 bg-emerald/5',
    accentCls: 'text-emerald',
    dotCls: 'bg-emerald',
  },
};

const ROLE_ORDER: ClassRole[] = ['teacher', 'xiaoming', 'xiaohong', 'xiaogang'];

const MODES = [
  { value: 'lesson' as const, label: '讲授' },
  { value: 'discuss' as const, label: '研讨' },
];

interface SavedPayload {
  turns?: ClassroomTurn[];
  board?: string[];
  prompt?: string;
  round?: number;
  mode?: 'lesson' | 'discuss';
}

export default function Classroom() {
  const [params, setParams] = useSearchParams();
  const pushToast = useApp((s) => s.pushToast);

  const tree = useAsync(() => api.catalog.tree('math1'), []);
  const llm = useAsync(() => api.settings.llm(), []);

  const [kid, setKid] = useState(params.get('kid') || '');
  const [mode, setMode] = useState<'lesson' | 'discuss'>('lesson');
  const [turns, setTurns] = useState<ClassroomTurn[]>([]);
  const [board, setBoard] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [round, setRound] = useState(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  /** 每次板书更新就 +1，用来强制重放"逐笔写出"的动画 */
  const [boardSeq, setBoardSeq] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const nodes = useMemo(() => {
    const out: { id: string; title: string; category: string }[] = [];
    tree.data?.categories.forEach((c) => {
      c.chapters.forEach((ch) => {
        ch.nodes.forEach((n) => out.push({ id: n.id, title: n.title, category: c.name }));
      });
    });
    return out;
  }, [tree.data]);

  const current = nodes.find((n) => n.id === kid);
  const llmReady = !!llm.data?.llm?.hasKey || llm.data?.llm?.kind === 'local';
  const started = turns.length > 0;

  /* ---------- 载入这一课的存档 ---------- */
  useEffect(() => {
    if (!kid) {
      setTurns([]); setBoard([]); setPrompt(''); setRound(0);
      return;
    }
    let alive = true;
    api.classroom.get(kid).then((r) => {
      if (!alive) return;
      // 注意：后端 GET 返回的 classroom 就是 payload 本身，不是 { payload }
      const p = (r.classroom || null) as SavedPayload | null;
      if (p && Array.isArray(p.turns) && p.turns.length) {
        setTurns(p.turns);
        setBoard(Array.isArray(p.board) ? p.board : []);
        setPrompt(typeof p.prompt === 'string' ? p.prompt : '');
        setRound(typeof p.round === 'number' ? p.round : 0);
        setMode(p.mode === 'discuss' ? 'discuss' : 'lesson');
        setBoardSeq((n) => n + 1);
      } else {
        setTurns([]); setBoard([]); setPrompt(''); setRound(0);
      }
    }).catch(() => {
      if (alive) { setTurns([]); setBoard([]); setPrompt(''); setRound(0); }
    });
    return () => { alive = false; };
  }, [kid]);

  /* ---------- 新内容出现时滚到底 ---------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [turns.length, busy]);

  const persist = useCallback((k: string, payload: SavedPayload) => {
    if (!k) return;
    api.classroom.save(k, payload).catch(() => {});
  }, []);

  /* ---------- 推进一轮 ---------- */
  const runRound = async (userInput = '') => {
    if (busy) return;
    if (!kid) {
      pushToast({ kind: 'warn', title: '先选一个知识点', desc: '课堂得围绕具体考点，不然老师不知道讲什么' });
      return;
    }
    if (!llmReady) {
      pushToast({ kind: 'warn', title: '还没配置模型', desc: '去「设置 → 模型接入」填一个 Base URL 和模型名' });
      return;
    }

    const text = userInput.trim();
    const nextRound = started ? round + 1 : 0;

    // 学生插话先上屏，别让用户等半天看不到自己说的话
    const optimistic: ClassroomTurn[] = text
      ? [...turns, { role: 'teacher', name: '我', text, round: nextRound }]
      : turns;
    if (text) {
      setTurns(optimistic);
      setInput('');
    }
    setBusy(true);

    try {
      const r = await api.ai.classroom({
        kid,
        mode,
        userInput: text,
        round: nextRound,
        history: turns.slice(-10).map((t) => ({ role: t.role, name: t.name, text: t.text })),
      });

      if (r.parseFailed || !r.turns?.length) {
        pushToast({
          kind: 'warn',
          title: '模型这次没按格式回',
          desc: r.raw ? r.raw.slice(0, 90) : '换一个模型试试，或者再点一次',
        });
        // 模型没按格式回：把刚才乐观上屏的那句也撤掉，别留下一条没人接的话
        setTurns(turns);
        setBusy(false);
        return;
      }

      const tagged: ClassroomTurn[] = r.turns.map((t) => ({ ...t, round: nextRound }));
      const merged = [...optimistic, ...tagged];
      const nextBoard = r.board?.length ? r.board : board;

      setTurns(merged);
      setBoard(nextBoard);
      setPrompt(r.prompt || '');
      setRound(nextRound);
      setBoardSeq((n) => n + 1);
      sfxTick();

      persist(kid, { turns: merged, board: nextBoard, prompt: r.prompt || '', round: nextRound, mode });
    } catch (e: any) {
      pushToast({ kind: 'error', title: '这一轮没上成', desc: e?.message });
      if (text) setTurns(turns);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 重开一课 ---------- */
  const restart = async () => {
    if (!kid) return;
    await api.classroom.clear(kid).catch(() => {});
    setTurns([]); setBoard([]); setPrompt(''); setRound(0); setInput('');
    setBoardSeq((n) => n + 1);
    pushToast({ kind: 'info', title: '黑板擦了', desc: '点「开始上课」重新讲一遍' });
  };

  /* ---------- 把这一课提取成复习卡 ---------- */
  const extract = async () => {
    if (!turns.length) return;
    const text = turns.map((t) => `${t.name}：${t.text}`).join('\n\n');
    setExtracting(true);
    try {
      const r = await api.ai.extract(text, kid);
      if (r.cards?.length) {
        pushToast({ kind: 'success', title: `提取了 ${r.cards.length} 张卡片`, desc: '已存进卡片库' });
      } else {
        pushToast({ kind: 'warn', title: '这节课没提取到值得复习的内容' });
      }
    } catch (e: any) {
      pushToast({ kind: 'error', title: '提取失败', desc: e?.message });
    } finally {
      setExtracting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runRound(input);
    }
  };

  /* 按轮次分组，好画分隔线 */
  const grouped = useMemo(() => {
    const map = new Map<number, ClassroomTurn[]>();
    turns.forEach((t) => {
      const r = t.round ?? 0;
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(t);
    });
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [turns]);

  if (tree.loading && !tree.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[64px] rounded-2xl" />
        <Skeleton className="h-[180px] rounded-2xl" />
        <Skeleton className="h-[320px] rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ============ 顶部控制 ============ */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-violet/25 bg-violet/10 text-violet">
            <GraduationCap size={17} />
          </div>

          <div className="min-w-[200px] flex-1">
            <select
              value={kid}
              onChange={(e) => { setKid(e.target.value); setParams(e.target.value ? { kid: e.target.value } : {}); }}
              className="h-9 w-full rounded-xl border border-hairline bg-ink-850 px-3 text-[13px] text-fg outline-none transition-colors focus:border-cyan/45"
            >
              <option value="">选择这节课讲什么…</option>
              {tree.data?.categories.map((c) => (
                <optgroup key={c.id} label={c.name}>
                  {c.chapters.flatMap((ch) => ch.nodes).map((n) => (
                    <option key={n.id} value={n.id}>{n.title}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={MODES}
          />

          <div className="flex flex-wrap gap-2">
            {started && (
              <>
                <Button variant="outline" size="sm" onClick={extract} loading={extracting}>
                  <Sparkles size={13} /> 存成复习卡
                </Button>
                <Button variant="ghost" size="sm" onClick={restart} aria-label="重开一课">
                  <Eraser size={13} /> 擦黑板
                </Button>
              </>
            )}
            {!started && (
              <Button size="sm" onClick={() => runRound()} disabled={!kid} shimmer>
                <Zap size={13} /> 开始上课
              </Button>
            )}
          </div>
        </div>

        {current && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-fg-mute">
            <Badge tone="violet">{current.category}</Badge>
            <span>{current.title}</span>
            <span className="text-fg-faint">·</span>
            <span>
              {mode === 'discuss'
                ? '研讨课：老师只抛问题，先让三个同学各自试'
                : '讲授 + 问答：老师讲一个点，同学随即犯错'}
            </span>
          </div>
        )}
      </Panel>

      {/* ============ 黑板 ============ */}
      <AnimatePresence>
        {(board.length > 0 || started) && (
          <motion.div
            initial={{ opacity: 0, y: -12, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -12, height: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            <Blackboard steps={board} seq={boardSeq} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ============ 对话流 ============ */}
      <Panel className="flex min-h-[420px] flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2 text-[12.5px] text-fg-mute">
            <Users size={13} />
            <span>小班 · 4 人</span>
            <span className="text-fg-faint">·</span>
            <span className="tabular">第 {round + 1} 轮</span>
          </div>
          <div className="hidden items-center gap-2.5 sm:flex">
            {ROLE_ORDER.map((r) => (
              <span key={r} className="flex items-center gap-1.5 text-[11px] text-fg-faint">
                <span className={cn('h-1.5 w-1.5 rounded-full', ROLES[r].dotCls)} />
                {ROLES[r].name}
              </span>
            ))}
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          {!started ? (
            <div className="flex h-full min-h-[280px] items-center justify-center">
              <EmptyState
                icon={<Users size={22} />}
                title={kid ? '准备好了就上课' : '先选一个知识点'}
                desc={kid
                  ? '三个同学会各错各的 —— 小明错概念、小红错计算、小刚追本质。每轮老师会留一个问题给你，不回答这节课就不往下走。'
                  : '课堂要围绕具体考点展开，先在左上角选一个。'}
                className="py-0"
              />
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(([r, list]) => (
                <div key={r} className="space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="shrink-0 text-[11px] font-medium tracking-wider text-fg-faint">
                      第 {r + 1} 轮
                    </span>
                    <span className="h-px flex-1 bg-hairline" />
                  </div>
                  {list.map((t, i) => (
                    <TurnBubble key={`${r}-${i}`} turn={t} index={i} />
                  ))}
                </div>
              ))}

              {busy && <ThinkingBubble />}
            </div>
          )}
        </div>

        {/* ============ 底部：学生插话 ============ */}
        <div className="shrink-0 border-t border-hairline p-3.5">
          {prompt && !busy && (
            <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-cyan/22 bg-cyan/6 px-3.5 py-3">
              <span className="mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-full border border-cyan/40 text-[9px] font-bold text-cyan">
                ?
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[11px] font-medium tracking-wide text-cyan-200/90">
                  老师留了个问题给你
                </div>
                <RichText text={prompt} className="text-[13px] leading-relaxed text-fg-soft" />
              </div>
            </div>
          )}

          <div className="flex items-end gap-2.5">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={
                !kid ? '先在左上角选一个知识点'
                  : started ? '把你的答案打出来 —— Enter 发言，Shift+Enter 换行'
                    : '点右上角「开始上课」，或者先说说你卡在哪'
              }
              disabled={!kid || busy}
              className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-hairline bg-veil/4 px-3.5 py-3 text-[13.5px] leading-relaxed text-fg outline-none transition-all placeholder:text-fg-faint focus:border-cyan/45 focus:bg-veil/6 disabled:opacity-50"
            />
            <Button
              onClick={() => runRound(input)}
              disabled={busy || !kid}
              loading={busy}
              className="h-11"
              title={started ? '发言并推进一轮' : '开始上课'}
            >
              {input.trim() ? <MessageSquarePlus size={15} /> : <Zap size={15} />}
              <span className="hidden sm:inline">{input.trim() ? '发言' : started ? '继续' : '开课'}</span>
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11.5px] text-fg-faint">
              {started
                ? '不说话也能点「继续」—— 但你自己答一遍，这节才有用。'
                : '老师会先建直觉，再让三个同学轮流踩坑。'}
            </p>
            {!llmReady && (
              <p className="text-[11.5px] text-amber-300/85">
                还没配置模型 —— 去「设置 → 模型接入」填 Base URL 与模型名。
              </p>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   黑板
   ============================================================ */
function Blackboard({ steps, seq }: { steps: string[]; seq: number }) {
  return (
    <Panel className="relative overflow-hidden p-0">
      {/* 深色板面 + 粉笔网格：两件事都得用 background-image，所以只能写在一处 */}
      <div
        className="relative px-5 py-4"
        style={{
          backgroundColor: '#050a0c',
          backgroundImage: [
            'linear-gradient(rgba(255,255,255,0.024) 1px, transparent 1px)',
            'linear-gradient(90deg, rgba(255,255,255,0.024) 1px, transparent 1px)',
            'linear-gradient(160deg, #060b0d 0%, #050a0c 45%, #070d10 100%)',
          ].join(','),
          backgroundSize: '28px 28px, 28px 28px, 100% 100%',
        }}
      >
        {/* 左上角一角冷光 */}
        <div className="pointer-events-none absolute -left-16 -top-16 h-40 w-40 rounded-full bg-cyan/8 blur-3xl" />

        <div className="relative mb-3 flex items-center gap-2">
          <PenLine size={13} className="text-cyan/70" />
          <span className="text-[11px] font-medium tracking-[0.18em] text-cyan/70">板书</span>
          <span className="h-px flex-1 bg-veil/6" />
          <span className="text-[10.5px] text-fg-faint">每轮重写</span>
        </div>

        {steps.length === 0 ? (
          <p className="relative py-3 text-[12.5px] text-fg-faint">
            老师还没落笔 —— 点「开始上课」，板书会一条条写出来。
          </p>
        ) : (
          <motion.ol
            key={seq}
            className="relative grid gap-2.5 sm:grid-cols-2"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.14 } } }}
          >
            {steps.map((s, i) => (
              <motion.li
                key={i}
                variants={{
                  hidden: { opacity: 0, x: -14, filter: 'blur(6px)' },
                  show: { opacity: 1, x: 0, filter: 'blur(0px)' },
                }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="flex items-start gap-2.5 rounded-xl border border-veil/6 bg-veil/3 px-3.5 py-2.5"
              >
                <span className="mt-[1px] shrink-0 font-mono text-[11px] font-semibold text-cyan/60">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <RichText
                  text={s}
                  className="min-w-0 flex-1 text-[13px] leading-[1.9] text-[#dfe7e6] [text-shadow:0_0_14px_rgba(180,240,240,0.10)]"
                />
              </motion.li>
            ))}
          </motion.ol>
        )}
      </div>
    </Panel>
  );
}

/* ============================================================
   一条发言
   ============================================================ */
function TurnBubble({ turn, index }: { turn: ClassroomTurn; index: number }) {
  const me = turn.name === '我';
  const cfg = me
    ? {
        name: '我',
        avatar: '我',
        tag: '学生本人',
        avatarCls: 'border-veil/12 bg-veil/7 text-fg-soft',
        bubbleCls: 'border-veil/10 bg-veil/6',
        accentCls: 'text-fg-soft',
      }
    : ROLES[turn.role] || ROLES.teacher;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, delay: Math.min(index, 4) * 0.06, ease: [0.16, 1, 0.3, 1] }}
      className={cn('flex gap-3', me && 'flex-row-reverse')}
    >
      <div
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-xl border text-[12px] font-semibold',
          cfg.avatarCls,
        )}
      >
        {cfg.avatar}
      </div>

      <div className={cn('min-w-0 max-w-[86%]', me && 'text-right')}>
        <div className={cn('mb-1.5 flex items-center gap-2', me && 'flex-row-reverse')}>
          <span className={cn('text-[12px] font-medium', cfg.accentCls)}>{cfg.name}</span>
          <span className="rounded border border-veil/8 bg-veil/4 px-1.5 py-[1px] text-[10px] text-fg-faint">
            {cfg.tag}
          </span>
        </div>
        <div
          className={cn(
            'rounded-2xl border px-4 py-3 text-[13.5px] leading-[1.9] text-fg-soft',
            cfg.bubbleCls,
            me ? 'text-left' : '',
          )}
        >
          <RichText text={turn.text} />
        </div>
      </div>
    </motion.div>
  );
}

/* ============================================================
   等待下一轮
   ============================================================ */
function ThinkingBubble() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex items-center gap-3 pl-12"
    >
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan/70"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
      <span className="text-[12px] text-fg-mute">课堂进行中…</span>
    </motion.div>
  );
}
