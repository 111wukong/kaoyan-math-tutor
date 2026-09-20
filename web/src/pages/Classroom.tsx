/* 多智能体课堂
 *
 * 设计意图（不是装饰）：
 *   自学最大的问题是「不知道自己不知道什么」。老师讲一遍你点头，其实没懂。
 *   所以这里放了三个各错各的同学 —— 小明错概念、小红错计算、小刚追本质。
 *   他们踩的坑，大概率就是你会踩的坑。看别人踩，比自己踩便宜。
 *
 * 交互铁律（沿用原项目）：你不动手，这节课就不往下走。
 *   每轮老师会留一个问题给你。你不回答就只能看别人说 —— 这是故意的。
 *
 * ── 2026-09-20 补的三件事 ─────────────────────────────────────────
 *   1. **留痕**：每一条「我」的发言都带上是回答了哪一轮的哪个问题，
 *      气泡里直接引出来；上面还有一块「问答留痕」把整节课的问答列成一张表。
 *      以前回完话根本看不出自己在回哪一问。
 *   2. **阶段可见**：服务端判出的阶段（讲授 / 答疑 / 练习）显示在顶栏，
 *      并且决定了结尾那一问的措辞 ——「老师留了个问题给你」和
 *      「老师想确认你听懂了没有」是两件事，后者不用动笔。
 *   3. **说不知道之后**：三个同学静默、老师换角度重讲、结尾只确认理解，
 *      而且「还是没懂 / 懂了」做成了两个按钮 —— 一句话都不用打。
 *      以前说不知道，下一轮照样甩一道算题出来。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  CheckCheck, ChevronDown, CornerDownRight, Eraser, GraduationCap, HelpCircle,
  History, MessageSquarePlus, PenLine, Sparkles, Users, VolumeX, Zap,
} from 'lucide-react';
import { api, type ClassPhase, type ClassRole, type ClassroomTurn, type PromptKind } from '@/lib/api';
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

/* ============================================================
   阶段与问题的措辞
   ============================================================
   阶段由服务端给，这里只决定「怎么说人话」。
   两张表分开是因为它们答的是两个问题：
     PHASE_META  —— 现在这节课处于什么状态（谁来发言）
     PROMPT_META —— 老师刚留的那一问要不要动笔（用户最关心这个）
   ============================================================ */
const PHASE_META: Record<ClassPhase, { label: string; desc: string; cls: string }> = {
  lecture: {
    label: '讲授 · 讲透理论',
    desc: '第一轮：老师会把定义、直观、适用条件和常见误区一次讲全。',
    cls: 'text-cyan-200/95 border-cyan-400/25 bg-cyan-400/10',
  },
  explain: {
    label: '讲授 · 问答',
    desc: '老师讲一个点，三个同学随即犯错，老师再纠正。',
    cls: 'text-cyan-200/95 border-cyan-400/25 bg-cyan-400/10',
  },
  clarify: {
    label: '答疑 · 只讲给你听',
    desc: '你说没听懂 —— 三个同学已静默，老师换一种讲法，这一轮不出题。',
    cls: 'text-amber-200/95 border-amber-400/30 bg-amber-400/10',
  },
  practice: {
    label: '练习 · 验收',
    desc: '你表示跟上了 —— 出一道小题验收，这一轮要动笔。',
    cls: 'text-violet-200/95 border-violet-400/25 bg-violet-400/10',
  },
  discuss: {
    label: '研讨',
    desc: '老师只抛问题，先让三个同学各自试，最后收口。',
    cls: 'text-emerald-200/95 border-emerald-400/25 bg-emerald-400/10',
  },
};

const PROMPT_META: Record<PromptKind, { title: string; hint: string; cls: string }> = {
  check: {
    title: '老师想确认你听懂了没有',
    hint: '先别动笔 —— 用自己的话说，说不清就直说「还是没懂」。',
    cls: 'border-amber/30 bg-amber/7',
  },
  practice: {
    title: '老师留了一道题给你',
    hint: '这一轮要动笔算。',
    cls: 'border-violet/28 bg-violet/7',
  },
  recall: {
    title: '老师留了个问题给你',
    hint: '回忆式的，不用算，说个大概就行。',
    cls: 'border-cyan/22 bg-cyan/6',
  },
  explore: {
    title: '老师抛了个问题',
    hint: '先自己想想，再看三个同学怎么说。',
    cls: 'border-emerald/25 bg-emerald/6',
  },
};

/** 一段留痕：老师问过什么 */
interface Asked {
  round: number;
  text: string;
  kind: PromptKind;
}

interface SavedPayload {
  turns?: ClassroomTurn[];
  board?: string[];
  prompt?: string;
  promptKind?: PromptKind;
  phase?: ClassPhase;
  round?: number;
  mode?: 'lesson' | 'discuss';
  asked?: Asked[];
}

export default function Classroom() {
  const [params, setParams] = useSearchParams();
  const pushToast = useApp((s) => s.pushToast);

  const tree = useAsync(() => api.catalog.tree('math1'), [], { key: 'catalog.tree:math1' });
  const llm = useAsync(() => api.settings.llm(), [], { key: 'settings.llm' });

  const [kid, setKid] = useState(params.get('kid') || '');
  const [mode, setMode] = useState<'lesson' | 'discuss'>('lesson');
  const [turns, setTurns] = useState<ClassroomTurn[]>([]);
  const [board, setBoard] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [promptKind, setPromptKind] = useState<PromptKind>('recall');
  const [phase, setPhase] = useState<ClassPhase>('lecture');
  /* 老师当前这个问题是在第几轮留的 —— 学生下一次发言回答的就是它。
   * 单独存是因为「轮次」记在发言上，而「问题」不在发言里。 */
  const [promptRound, setPromptRound] = useState(0);
  const [asked, setAsked] = useState<Asked[]>([]);
  const [round, setRound] = useState(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  /** 跳过去之后高亮一下，不然用户不知道跳到哪了 */
  const [flash, setFlash] = useState('');
  /** 每次板书更新就 +1，用来强制重放"逐笔写出"的动画 */
  const [boardSeq, setBoardSeq] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* 地址栏里的 kid 是唯一真源，但**只在它带了值的时候**。
   *
   * ★ 这里踩过一个坑，值得记下来：一开始写成「地址栏没有 kid 就同步成空」，
   *   结果从侧栏点回课堂时（侧栏链接是 /classroom，不带参数），
   *   整节课的对话当场被清空 —— 而且保活之后页面不会重新挂载，
   *   用户看到的不是"重新选一下"，而是"我的课没了"。
   *   地址栏没带 kid 通常意味着"从入口进来的"，不代表用户想清空；
   *   真清空是显式动作（在下拉里选「选择这节课讲什么…」），那条路会走 onChange。
   *
   * 顺便把选过的考点写回地址栏（replace，不污染后退历史）——
   * 这样刷新和收藏回来还是这一课。 */
  const paramKid = params.get('kid') || '';
  /** 用户是不是刚刚**主动**清空了考点。用来区分上面那两种情况 */
  const clearedByUser = useRef(false);

  useEffect(() => {
    if (paramKid) {
      clearedByUser.current = false;
      setKid(paramKid);
      return;
    }
    if (kid && !clearedByUser.current) {
      setParams({ kid }, { replace: true });
    }
  }, [paramKid, kid, setParams]);

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
      setTurns([]); setBoard([]); setPrompt(''); setRound(0); setAsked([]);
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
        setPromptKind(p.promptKind || 'recall');
        setPhase(p.phase || 'explain');
        setPromptRound(typeof p.round === 'number' ? p.round : 0);
        setAsked(Array.isArray(p.asked) ? p.asked : []);
        setRound(typeof p.round === 'number' ? p.round : 0);
        setMode(p.mode === 'discuss' ? 'discuss' : 'lesson');
        setBoardSeq((n) => n + 1);
      } else {
        setTurns([]); setBoard([]); setPrompt(''); setRound(0); setAsked([]);
        setPhase('lecture'); setPromptKind('recall'); setPromptRound(0);
      }
    }).catch(() => {
      if (alive) { setTurns([]); setBoard([]); setPrompt(''); setRound(0); setAsked([]); }
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

    /* ★ 留痕的落点：这一句是在回答「上一轮老师留的那个问题」。
     * 没有待答的问题（比如刚开课）就不挂引用 —— 凭空引用一句不存在的话
     * 比不引用更糟。 */
    const replyTo = text && prompt ? { text: prompt, round: promptRound } : undefined;

    // 学生插话先上屏，别让用户等半天看不到自己说的话
    const optimistic: ClassroomTurn[] = text
      ? [...turns, { role: 'teacher', name: '我', text, round: nextRound, replyTo }]
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
        /* 带上「在回答哪一问」和「当前阶段」—— 服务端靠这两个承接上下文。
         * 不传的话老师不知道自己在回哪一问，也不知道学生上一句说过没听懂。 */
        lastPrompt: prompt,
        lastPromptRound: promptRound,
        prevPhase: phase,
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
      const nextPrompt = r.prompt || '';
      const nextKind = r.promptKind || 'recall';
      const nextPhase = r.phase || 'explain';
      /* 只有真的留了问题才记进留痕 —— 记一条空的没意义 */
      const nextAsked: Asked[] = nextPrompt
        ? [...asked, { round: nextRound, text: nextPrompt, kind: nextKind }]
        : asked;

      setTurns(merged);
      setBoard(nextBoard);
      setPrompt(nextPrompt);
      setPromptKind(nextKind);
      setPhase(nextPhase);
      setPromptRound(nextRound);
      setAsked(nextAsked);
      setRound(nextRound);
      setBoardSeq((n) => n + 1);
      sfxTick();

      if (r.promptAdjusted) {
        pushToast({
          kind: 'info',
          title: '这一轮老师本来要出题',
          desc: '被换成了理解确认 —— 先确认这一步跟得上，再做题不迟',
          ttl: 4200,
        });
      }

      persist(kid, {
        turns: merged, board: nextBoard, prompt: nextPrompt, promptKind: nextKind,
        phase: nextPhase, round: nextRound, mode, asked: nextAsked,
      });
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
    setAsked([]); setPhase('lecture'); setPromptKind('recall'); setPromptRound(0);
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
        pushToast({ kind: 'success', title: `提取了 ${r.cards.length} 张卡片`, desc: '已存进卡库' });
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

  /* ---------- 问答留痕表 ----------
   * 每一条「老师问的」配上「我答的」。配对靠 replyTo.round ——
   * 那条「我」的发言是在回答第几轮的问题，是它**自己记下来的**，
   * 不是这里按顺序现推的（现推只要中间漏一轮就全部错位）。 */
  const qa = useMemo(() => {
    return asked.map((q) => {
      const inRound = turns.filter((t) => (t.round ?? 0) === (q.round + 1));
      const answer = inRound.find((t) => t.name === '我' && t.replyTo?.round === q.round);
      const anchor = answer
        ? `t-${answer.round}-${inRound.indexOf(answer)}`
        : `r-${q.round}`;
      return { ...q, answer: answer?.text || '', anchor };
    });
  }, [asked, turns]);

  const answeredCount = qa.filter((x) => x.answer).length;

  /* 跳到某一条发言（或某一轮的分隔线）并闪一下 */
  const jumpTo = (anchor: string) => {
    const el = scrollRef.current?.querySelector(`[data-anchor="${anchor}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(anchor);
    window.setTimeout(() => setFlash(''), 1600);
  };

  if (tree.loading && !tree.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[64px] rounded-2xl" />
        <Skeleton className="h-[180px] rounded-2xl" />
        <Skeleton className="h-[320px] rounded-2xl" />
      </div>
    );
  }

  const ph = PHASE_META[phase];
  const pm = PROMPT_META[promptKind];
  /* 答疑阶段：学生该安静。这件事必须写在界面上，否则用户只会觉得
   * 「这次怎么没人说话」，而不知道这是设计。 */
  const studentsMuted = phase === 'clarify';

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
              onChange={(e) => {
                const v = e.target.value;
                /* 显式清空：记一笔，否则上面那个「把考点写回地址栏」的 effect
                 * 会立刻把刚清掉的值又填回来，用户会发现选不空。 */
                clearedByUser.current = !v;
                setKid(v);
                setParams(v ? { kid: v } : {}, { replace: true });
              }}
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
            <span>{started ? ph.desc : '老师会先建直觉，再让三个同学轮流踩坑。'}</span>
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

      {/* ============ 问答留痕 ============ */}
      {qa.length > 0 && (
        <Panel className="overflow-hidden p-0">
          <button
            onClick={() => setIndexOpen((v) => !v)}
            aria-expanded={indexOpen}
            className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-veil/4"
          >
            <History size={14} className="shrink-0 text-cyan/75" />
            <span className="text-[12.5px] font-medium text-fg-soft">本课问答留痕</span>
            <span className="text-[11.5px] tabular text-fg-faint">
              {qa.length} 问 · {answeredCount} 答
              {answeredCount < qa.length && ` · ${qa.length - answeredCount} 未答`}
            </span>
            <span className="flex-1" />
            <ChevronDown
              size={14}
              className={cn('shrink-0 text-fg-faint transition-transform duration-200', indexOpen && 'rotate-180')}
            />
          </button>

          {indexOpen && (
            <ol className="border-t border-hairline px-2 py-1.5">
              {qa.map((x, i) => (
                <li key={`${x.round}-${i}`}>
                  <button
                    onClick={() => jumpTo(x.anchor)}
                    className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-veil/5"
                  >
                    <span className="mt-[3px] shrink-0 rounded border border-veil/10 bg-veil/5 px-1.5 py-[1px] text-[10px] tabular text-fg-faint">
                      第 {x.round + 1} 轮
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start gap-1.5">
                        <span className="mt-[2px] shrink-0 text-[10.5px] font-bold text-cyan/80">Q</span>
                        <RichText text={x.text} className="text-[12.5px] leading-relaxed text-fg-soft" />
                      </span>
                      <span className="mt-1 flex items-start gap-1.5">
                        <span className="mt-[2px] shrink-0 text-[10.5px] font-bold text-fg-mute">A</span>
                        {x.answer
                          ? <RichText text={x.answer} className="text-[12.5px] leading-relaxed text-fg-mute" />
                          : <span className="text-[12px] text-fg-faint">还没回答 —— 点这里跳过去</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      )}

      {/* ============ 对话流 ============ */}
      <Panel className="flex min-h-[420px] flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-fg-mute">
            <Users size={13} />
            <span className="shrink-0">小班 · 4 人</span>
            <span className="text-fg-faint">·</span>
            <span className="shrink-0 tabular">第 {round + 1} 轮</span>
            {started && (
              <span className={cn('truncate rounded-md border px-2 py-[2px] text-[11px] font-medium', ph.cls)}>
                {ph.label}
              </span>
            )}
          </div>
          <div className="hidden shrink-0 items-center gap-2.5 sm:flex">
            {ROLE_ORDER.map((r) => (
              <span
                key={r}
                className={cn(
                  'flex items-center gap-1.5 text-[11px]',
                  studentsMuted && r !== 'teacher' ? 'text-fg-faint/60' : 'text-fg-faint',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', studentsMuted && r !== 'teacher' ? 'bg-fg-faint/40' : ROLES[r].dotCls)} />
                {ROLES[r].name}
              </span>
            ))}
            {studentsMuted && (
              <span className="flex items-center gap-1 rounded-md border border-amber/25 bg-amber/8 px-1.5 py-[2px] text-[10.5px] text-amber">
                <VolumeX size={10} /> 静默
              </span>
            )}
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          {!started ? (
            <div className="flex h-full min-h-[280px] items-center justify-center">
              <EmptyState
                icon={<Users size={22} />}
                title={kid ? '准备好了就上课' : '先选一个知识点'}
                desc={kid
                  ? '老师会先把理论讲透，再让三个同学各错各的 —— 小明错概念、小红错计算、小刚追本质。每轮会留一个问题给你；说「不知道」也不会被催着做题，会换成只讲给你听。'
                  : '课堂要围绕具体考点展开，先在左上角选一个。'}
                className="py-0"
              />
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(([r, list]) => (
                <div key={r} className="space-y-4">
                  <div className="flex items-center gap-3" data-anchor={`r-${r}`}>
                    <span className="shrink-0 text-[11px] font-medium tracking-wider text-fg-faint">
                      第 {r + 1} 轮
                    </span>
                    <span className="h-px flex-1 bg-hairline" />
                  </div>
                  {list.map((t, i) => {
                    const anchor = `t-${r}-${i}`;
                    return (
                      <TurnBubble
                        key={`${r}-${i}`}
                        turn={t}
                        index={i}
                        anchor={anchor}
                        flash={flash === anchor}
                      />
                    );
                  })}
                </div>
              ))}

              {busy && <ThinkingBubble />}
            </div>
          )}
        </div>

        {/* ============ 底部：学生插话 ============ */}
        <div className="shrink-0 border-t border-hairline p-3.5">
          {prompt && !busy && (
            <div className={cn('mb-3 rounded-xl border px-3.5 py-3', pm.cls)}>
              <div className="flex items-start gap-2.5">
                <span className="mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-full border border-current/40 text-[9px] font-bold">
                  ?
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-medium tracking-wide">
                    <span>{pm.title}</span>
                    <span className="rounded border border-current/25 px-1.5 py-[1px] text-[10px] tabular opacity-80">
                      第 {promptRound + 1} 轮
                    </span>
                  </div>
                  <RichText text={prompt} className="text-[13px] leading-relaxed text-fg-soft" />
                  {pm.hint && <p className="mt-1.5 text-[11.5px] opacity-75">{pm.hint}</p>}
                </div>
              </div>

              {/* 理解确认给两个按钮：说不清就直说，不用打一段话。
                  这条链是「说不知道 → 老师重讲 → 确认是否理解」的闭环，
                  少一个按钮就断了 —— 用户会硬撑着说「懂了」。 */}
              {promptKind === 'check' && (
                <div className="mt-2.5 flex flex-wrap gap-2 pl-6">
                  <Button size="sm" variant="outline" onClick={() => runRound('还是没懂，换个说法再讲一遍')}>
                    <HelpCircle size={13} /> 还是没懂
                  </Button>
                  <Button size="sm" variant="success" onClick={() => runRound('懂了，继续')}>
                    <CheckCheck size={13} /> 懂了，继续
                  </Button>
                </div>
              )}
            </div>
          )}

          {studentsMuted && !busy && (
            <p className="mb-2.5 flex items-center gap-1.5 text-[11.5px] text-amber-300/85">
              <VolumeX size={12} />
              三个同学已静默 —— 这一轮老师只对你讲，不会出题。
            </p>
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
                  : !started ? '点右上角「开始上课」，或者先说说你卡在哪'
                    : promptKind === 'check' ? '说清楚卡在哪，老师好换个讲法 —— 也可以直接点上面的按钮'
                      : promptKind === 'practice' ? '把你的答案打出来 —— Enter 发言，Shift+Enter 换行'
                        : '把你的想法打出来 —— Enter 发言，Shift+Enter 换行'
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
                ? (promptKind === 'check'
                  ? '这一轮不用动笔。说不清就是没懂 —— 直说，老师会换个讲法。'
                  : '不说话也能点「继续」—— 但你自己答一遍，这节才有用。')
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
function TurnBubble({
  turn, index, anchor, flash,
}: {
  turn: ClassroomTurn; index: number; anchor: string; flash: boolean;
}) {
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
      data-anchor={anchor}
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
            'rounded-2xl border px-4 py-3 text-[13.5px] leading-[1.9] text-fg-soft transition-shadow duration-300',
            cfg.bubbleCls,
            me ? 'text-left' : '',
            flash && 'ring-1 ring-cyan/55',
          )}
        >
          {/* ★ 留痕：这一句在回答哪一问。
              直接引在气泡里 —— 过几轮之后回头看，不用往上翻就知道在说什么。
              没有它的时候，用户的原话是「回复了不知道回复的是哪个问题」。 */}
          {me && turn.replyTo && (
            <div className="mb-2 rounded-lg border-l-2 border-cyan/40 bg-cyan/6 px-2.5 py-1.5">
              <div className="flex items-center gap-1.5 text-[10.5px] text-cyan/85">
                <CornerDownRight size={10} />
                回答第 {turn.replyTo.round + 1} 轮老师的问题
              </div>
              <RichText
                text={turn.replyTo.text}
                className="mt-0.5 text-[12px] leading-relaxed text-fg-mute"
              />
            </div>
          )}
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
