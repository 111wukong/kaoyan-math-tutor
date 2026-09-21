import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, ListChecks, Plus, Sparkles, SquarePen, Trash2, X } from 'lucide-react';
import { api, type QuestionDraft, type QuestionType, type QuestionStep } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import {
  Panel, Button, Badge, Skeleton, EmptyState, SectionTitle, Input, TextArea, Segmented,
} from '@/components/ui/Primitives';
import { RichText } from '@/components/ui/Math';
import { cn, DIFFICULTY } from '@/lib/utils';

const LETTERS = 'ABCDEF';

const blankOptions = (n = 4) =>
  Array.from({ length: n }, (_, i) => ({ k: LETTERS[i], t: '' }));

/* 题型元信息。**只有这一份** —— 界面文案、默认答案、能不能自动判分，
 * 都从这里取。上一版是 if/else 散在各处，加一种题型要改五个地方。 */
const TYPES: {
  value: QuestionType; label: string; hint: string;
  auto: boolean; needsOptions: boolean;
}[] = [
  { value: 'choice', label: '单选', hint: '考研卷面 10 题 × 5 分。答案是一个字母', auto: true, needsOptions: true },
  { value: 'multi', label: '多选', hint: '练习用。全部选对才得分，答案写成 ACD 这样', auto: true, needsOptions: true },
  { value: 'blank', label: '填空', hint: '考研卷面 6 题 × 5 分。答案只能是整数、小数或分数', auto: true, needsOptions: false },
  { value: 'judge', label: '判断', hint: '练习用。判断命题真假，适合概念辨析和反例训练', auto: true, needsOptions: false },
  { value: 'solve', label: '解答', hint: '卷面上最大的一块（约 70 分）。不自动判分，你写完自己对照评分点打分', auto: false, needsOptions: false },
  { value: 'proof', label: '证明', hint: '与解答同属大题。评分看论证链，同样自评', auto: false, needsOptions: false },
];

const typeMeta = (t: QuestionType) => TYPES.find((x) => x.value === t) || TYPES[0];

const emptyDraft = (kid: string): QuestionDraft => ({
  kid,
  type: 'choice',
  stem: '',
  options: blankOptions(),
  answer: 'A',
  analysis: '',
  difficulty: 2,
  sourceType: '真题',
});

/** 解答/证明题默认给三行评分点 —— 空白表比让人自己点「加一条」友好 */
const blankSteps = (): QuestionStep[] => [
  { t: '', pts: 4 }, { t: '', pts: 4 }, { t: '', pts: 4 },
];

/**
 * 我的题库 —— 录真题卷子上的错题。
 *
 * 内置题库只有 200 多道；而真正的短板在真题卷子上，那些题原来一道都进不来。
 * 录进来的题和内置题一视同仁：能作答、进错题本、参与掌握度、
 * 能被 AI 分析错因，也能被「举一反三」当参考。
 *
 * ── 为什么录题时要卡答案 ────────────────────────────────────────
 * 判题器只认特定形态的答案（判据在 judge.js 的 answerIssue）。
 * 录一道判不了的题，用户之后每次答对都会被判错，而且没有任何提示。
 * 但**解答题/证明题例外**：它们本来就不自动判分，靠参考答案自评，
 * 所以答案栏放的是「参考解答」而不是「一个值」，校验口径也完全不同。
 */
export default function Questions() {
  const pushToast = useApp((s) => s.pushToast);
  const [kidFilter, setKidFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft(''));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  /* ---------- AI 批量补题 ---------- */
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchKids, setBatchKids] = useState<string[]>([]);
  const [perKid, setPerKid] = useState(3);
  const [batchMode, setBatchMode] = useState<'objective' | 'subjective' | 'mixed'>('mixed');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState<null | {
    total: number; perKid: Record<string, number>;
    failed: { kid: string; title: string; reason: string }[];
    skippedDuplicate: number; skippedUnjudgeable: number;
  }>(null);

  const list = useAsync(() => api.catalog.questions({ limit: 500 }), [], { key: 'catalog.questions:500' });
  const tree = useAsync(() => api.catalog.tree(), [], { key: 'catalog.tree:math1' });

  /* 把「分类 → 章节 → 知识点」拍平成下拉选项。
   * 录题时必须挂到一个具体考点上 —— 不然它不参与任何掌握度计算，
   * 也就失去了「录进来干嘛」的意义。 */
  const nodes = useMemo(() => {
    const out: { id: string; title: string; chapterName: string }[] = [];
    for (const c of tree.data?.categories || []) {
      for (const ch of c.chapters || []) {
        for (const n of ch.nodes || []) out.push({ id: n.id, title: n.title, chapterName: ch.name });
      }
    }
    return out;
  }, [tree.data]);

  const all = list.data?.questions || [];
  const shown = useMemo(() => {
    let out = all;
    if (kidFilter) out = out.filter((q) => q.kid === kidFilter);
    if (typeFilter) out = out.filter((q) => q.type === typeFilter);
    if (mineOnly) out = out.filter((q) => q.mine);
    return out;
  }, [all, kidFilter, typeFilter, mineOnly]);

  const mineCount = all.filter((q) => q.mine).length;
  const meta = typeMeta(draft.type);

  const openCreate = () => {
    setEditingId('');
    setDraft(emptyDraft(kidFilter || nodes[0]?.id || ''));
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (q: any) => {
    setEditingId(q.id);
    setDraft({
      kid: q.kid,
      type: q.type,
      stem: q.stem,
      options: q.options || blankOptions(),
      steps: undefined,
      answer: q.answer ?? '',
      analysis: '',
      difficulty: q.difficulty,
      sourceType: q.sourceType || '真题',
      sourceYear: q.sourceYear ?? undefined,
    });
    setFormError('');
    setFormOpen(true);
    /* 编辑时要把答案、解析、评分点取回来 —— 列表接口刻意不返回它们
     * （考试中不能泄露），所以这里单独拉一次单题详情。 */
    api.catalog.question(q.id).then((r) => {
      setDraft((d) => ({
        ...d,
        answer: r.question.answer,
        analysis: r.question.analysis,
        steps: (r.question as any).steps || undefined,
      }));
    }).catch(() => { /* 取不到就留空，用户重填 */ });
  };

  /* ── 题最少的考点 ──
   *
   * 「批量补题」的默认目标。不给一张 46 个考点的清单让人自己挑 ——
   * 那等于把「哪里缺题」这个本来该程序回答的问题推回给用户。
   * 直接按现有题数升序排，缺得最狠的排在最前面，默认勾上。
   *
   * 上限 12 个是和服务端一致的（generate-batch 串行跑，再大就该换异步任务了）。 */
  const scarce = useMemo(() => {
    const byKid = new Map<string, number>();
    for (const q of all) byKid.set(q.kid, (byKid.get(q.kid) || 0) + 1);
    return nodes
      .map((n) => ({ ...n, n: byKid.get(n.id) || 0 }))
      .sort((a, b) => a.n - b.n || a.id.localeCompare(b.id))
      .slice(0, 12);
  }, [all, nodes]);

  const openBatch = () => {
    /* 默认勾前 8 个：太少补不满，太多一次等太久 */
    setBatchKids(scarce.slice(0, 8).map((n) => n.id));
    setBatchResult(null);
    setBatchOpen(true);
  };

  const toggleBatchKid = (id: string) => {
    setBatchKids((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const runBatch = async () => {
    if (!batchKids.length || batchBusy) return;
    setBatchBusy(true);
    setBatchResult(null);
    try {
      const r = await api.ai.generateBatch(batchKids, { perKid, mode: batchMode });
      setBatchResult({
        total: r.total, perKid: r.perKid, failed: r.failed,
        skippedDuplicate: r.skippedDuplicate, skippedUnjudgeable: r.skippedUnjudgeable,
      });

      if (r.total > 0) {
        pushToast({
          kind: 'success',
          title: `生成了 ${r.total} 道题`,
          desc: [
            `${batchKids.length} 个考点，每个要 ${perKid} 道`,
            r.skippedDuplicate ? `跳过 ${r.skippedDuplicate} 道重复` : '',
            r.failed.length ? `${r.failed.length} 个考点没跑成` : '',
          ].filter(Boolean).join(' · '),
        });
      } else {
        pushToast({
          kind: 'warn',
          title: '一道都没生成',
          desc: r.failed.length
            ? `${r.failed.length} 个考点调用失败：${r.failed[0].reason.slice(0, 80)}`
            : '模型这次给的内容全都判不了分，换个考点或再试一次',
        });
      }
      /* 新题已经落库，列表要重拉 —— 不然用户得手动刷新才看得到 */
      list.reload();
    } catch (e: any) {
      pushToast({
        kind: 'error',
        title: '批量生成失败',
        desc: String(e?.message || e).slice(0, 160),
      });
    } finally {
      setBatchBusy(false);
    }
  };

  /** 换题型时把上一型的残留字段清掉 —— 不然「多选答案 ACD」会跟着
   *  一起提交到填空题上，服务端按填空题校验就会报一个看不懂的错。 */
  const switchType = (v: QuestionType) => {
    const m = typeMeta(v);
    setDraft({
      ...draft,
      type: v,
      options: m.needsOptions ? (draft.options?.length ? draft.options : blankOptions()) : undefined,
      steps: v === 'solve' || v === 'proof' ? (draft.steps?.length ? draft.steps : blankSteps()) : undefined,
      answer: v === 'choice' ? 'A' : v === 'multi' ? '' : v === 'judge' ? 'T' : '',
    });
    setFormError('');
  };

  const save = async () => {
    setSaving(true);
    setFormError('');
    try {
      /* 按题型只提交它认的字段。多选题要带选项，判断题的选项由服务端写死
       * （就「正确/错误」两个键），解答题要带评分点。 */
      const body: QuestionDraft = {
        ...draft,
        options: meta.needsOptions ? draft.options : undefined,
        steps: meta.auto ? undefined : (draft.steps || []).filter((s) => s.t.trim()),
      };
      if (editingId) {
        await api.questions.update(editingId, body);
        pushToast({ kind: 'success', title: '已保存' });
      } else {
        await api.questions.create(body);
        pushToast({ kind: 'success', title: '已加入题库' });
      }
      setFormOpen(false);
      list.reload();
    } catch (e: any) {
      /* 服务端的拒绝理由写得很具体（「答案含根号，判题器没法比对」），
       * 直接显示出来 —— 比笼统的「保存失败」有用得多。 */
      setFormError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (q: any) => {
    try {
      await api.questions.remove(q.id);
      pushToast({ kind: 'success', title: '已删除' });
      list.reload();
    } catch (e: any) {
      pushToast({ kind: 'error', title: e?.message || '删除失败' });
    }
  };

  /* ---------- 可提交性 ---------- */
  const answerOk = (() => {
    const a = String(draft.answer ?? '').trim();
    if (draft.type === 'choice') return /^[A-Fa-f]$/.test(a);
    if (draft.type === 'multi') return a.replace(/[^A-Fa-f]/g, '').length >= 2;
    if (draft.type === 'judge') return a === 'T' || a === 'F';
    if (meta.auto) return a.length > 0;
    return a.length >= 2;   // 解答/证明：参考答案
  })();

  const optionsOk = !meta.needsOptions
    || (draft.options || []).length >= 4
    && (draft.options || []).every((o) => o.t.trim());

  const canSave = !!draft.kid && draft.stem.trim().length >= 5 && answerOk && optionsOk;

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan/25 bg-cyan/10 text-cyan">
              <SquarePen size={18} />
            </div>
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-fg">我的题库</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-mute">
                真题卷子上的错题录进来，就能作答、进错题本、算进掌握度
                {mineCount > 0 && ` · 已有 ${mineCount} 道自建题`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <Button
              variant="outline"
              onClick={openBatch}
              disabled={!nodes.length}
              title="用 AI 给题最少的考点批量补题（需要在设置里配好模型）"
            >
              <Sparkles size={14} /> AI 批量补题
            </Button>
            <Button onClick={openCreate} shimmer disabled={!nodes.length}>
              <Plus size={14} /> 录一道题
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <select
            value={kidFilter}
            onChange={(e) => setKidFilter(e.target.value)}
            className="max-w-[240px] rounded-xl border border-hairline bg-veil/4 px-3 py-1.5 text-[12.5px] text-fg-soft outline-none transition-colors hover:border-veil/20 focus:border-cyan/40"
          >
            <option value="">全部考点（{all.length}）</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>{n.title}</option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-xl border border-hairline bg-veil/4 px-3 py-1.5 text-[12.5px] text-fg-soft outline-none transition-colors hover:border-veil/20 focus:border-cyan/40"
          >
            <option value="">全部题型</option>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}题</option>)}
          </select>
          <Segmented
            size="sm"
            value={mineOnly ? 'mine' : 'all'}
            onChange={(v) => setMineOnly(v === 'mine')}
            options={[{ value: 'all', label: '全部' }, { value: 'mine', label: `只看我的 ${mineCount}` }]}
          />
        </div>
      </Panel>

      {/* ---------- AI 批量补题 ---------- */}
      <AnimatePresence>
        {batchOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            <Panel className="p-5">
              <SectionTitle
                title="AI 批量补题"
                desc="按现有题数升序排列 —— 缺得最狠的考点在最前面。生成的题落库后和内置题一视同仁：能作答、进错题本、算进掌握度"
                right={
                  <Button variant="ghost" size="sm" onClick={() => setBatchOpen(false)}>
                    <X size={14} /> 收起
                  </Button>
                }
                className="mb-4"
              />

              <div className="space-y-4">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[12px] text-fg-mute">
                      选考点（已选 {batchKids.length} 个 · 上限 12）
                    </span>
                    <div className="flex gap-2.5">
                      <button
                        className="text-[11.5px] text-cyan transition-opacity hover:opacity-70"
                        onClick={() => setBatchKids(scarce.map((n) => n.id))}
                      >
                        全选
                      </button>
                      <button
                        className="text-[11.5px] text-fg-faint transition-colors hover:text-fg-soft"
                        onClick={() => setBatchKids([])}
                      >
                        清空
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {scarce.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => toggleBatchKid(n.id)}
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors',
                          batchKids.includes(n.id)
                            ? 'border-cyan/40 bg-cyan/8 text-fg'
                            : 'border-hairline bg-veil/3 text-fg-mute hover:border-veil/20',
                        )}
                      >
                        <span className="truncate">{n.title}</span>
                        <span
                          className={cn(
                            'shrink-0 tabular text-[11px]',
                            n.n === 0 ? 'text-rose' : n.n <= 2 ? 'text-amber' : 'text-fg-faint',
                          )}
                        >
                          {n.n} 题
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="每个考点几道">
                    <Segmented
                      value={String(perKid)}
                      onChange={(v) => setPerKid(Number(v))}
                      options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
                    />
                  </Field>
                  <Field
                    label="题型"
                    hint="真题卷面是 10 选 / 6 填 / 6 道大题，所以默认「混合」"
                  >
                    <Segmented
                      value={batchMode}
                      onChange={(v) => setBatchMode(v as 'objective' | 'subjective' | 'mixed')}
                      options={[
                        { value: 'objective', label: '客观' },
                        { value: 'subjective', label: '大题' },
                        { value: 'mixed', label: '混合' },
                      ]}
                    />
                  </Field>
                </div>

                {batchResult && (
                  <div className="rounded-xl border border-hairline bg-veil/3 px-3.5 py-3 text-[12.5px] leading-relaxed">
                    <div className="font-medium text-fg">
                      生成 {batchResult.total} 道
                      {batchResult.skippedDuplicate > 0 && ` · 跳过重复 ${batchResult.skippedDuplicate} 道`}
                      {batchResult.skippedUnjudgeable > 0 && ` · 判不了分丢掉 ${batchResult.skippedUnjudgeable} 道`}
                    </div>
                    {batchResult.failed.length > 0 && (
                      <div className="mt-1 text-amber-200/90">
                        {batchResult.failed.length} 个考点没跑成：
                        {batchResult.failed.map((f) => f.title || f.kid).join('、')}
                        （可以只勾这几个再跑一次）
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2.5">
                  <Button onClick={runBatch} loading={batchBusy} disabled={!batchKids.length}>
                    <Sparkles size={14} />
                    {batchBusy ? '生成中…' : `开始生成（约 ${batchKids.length * perKid} 道）`}
                  </Button>
                  <span className="text-[11.5px] text-fg-faint">
                    串行调用模型，{batchKids.length} 个考点可能要等一分钟左右
                  </span>
                </div>
              </div>
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- 录题 / 改题表单 ---------- */}
      <AnimatePresence>
        {formOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            <Panel className="p-5">
              <SectionTitle
                title={editingId ? '改这道题' : '录一道新题'}
                desc={meta.auto
                  ? '答案必须能被自动判分 —— 判不了的题录进来，你以后答对也会被判错'
                  : '解答题和证明题不自动判分：写好参考答案和评分点，作答时你对照着给自己打分'}
                right={
                  <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
                    <X size={14} /> 收起
                  </Button>
                }
                className="mb-4"
              />

              <div className="space-y-4">
                <Field label="题型" hint={meta.hint}>
                  <Segmented
                    value={draft.type}
                    onChange={(v) => switchType(v as QuestionType)}
                    options={TYPES.map((t) => ({ value: t.value, label: t.label }))}
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="挂在哪个考点下">
                    <select
                      value={draft.kid}
                      onChange={(e) => setDraft({ ...draft, kid: e.target.value })}
                      className="w-full rounded-xl border border-hairline bg-veil/4 px-3 py-2 text-[13px] text-fg-soft outline-none focus:border-cyan/40"
                    >
                      {nodes.map((n) => (
                        <option key={n.id} value={n.id}>{n.chapterName} · {n.title}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="难度">
                    <Segmented
                      size="sm"
                      value={String(draft.difficulty ?? 2)}
                      onChange={(v) => setDraft({ ...draft, difficulty: Number(v) })}
                      options={[
                        { value: '1', label: '基础' }, { value: '2', label: '常规' },
                        { value: '3', label: '较难' }, { value: '4', label: '压轴' },
                      ]}
                    />
                  </Field>
                </div>

                <Field label="题干" hint="公式用 LaTeX，行内写成 $...$">
                  <TextArea
                    rows={3}
                    value={draft.stem}
                    onChange={(e) => setDraft({ ...draft, stem: e.target.value })}
                    placeholder="例：求极限 $\lim_{x \to 0}\frac{\sin 3x}{2x}$ 的值"
                  />
                </Field>

                {/* ---------- 选项 + 答案 ---------- */}
                {draft.type === 'choice' && (
                  <Field label="选项与答案" hint="点左侧字母设为正确答案">
                    <div className="space-y-2">
                      {(draft.options || []).map((o, i) => (
                        <div key={o.k} className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => setDraft({ ...draft, answer: o.k })}
                            className={cn(
                              'grid h-8 w-8 shrink-0 place-items-center rounded-lg border text-[13px] font-semibold transition-all',
                              draft.answer === o.k
                                ? 'border-emerald/45 bg-emerald/15 text-emerald'
                                : 'border-hairline bg-veil/4 text-fg-mute hover:border-veil/22',
                            )}
                            title="设为正确答案"
                          >
                            {o.k}
                          </button>
                          <Input
                            value={o.t}
                            onChange={(e) => {
                              const next = [...(draft.options || [])];
                              next[i] = { ...o, t: e.target.value };
                              setDraft({ ...draft, options: next });
                            }}
                            placeholder={`选项 ${o.k}`}
                          />
                        </div>
                      ))}
                    </div>
                  </Field>
                )}

                {draft.type === 'multi' && (
                  <Field
                    label="选项与答案"
                    hint="点字母切换「这个选项对不对」，至少要选 2 个"
                  >
                    <div className="space-y-2">
                      {(draft.options || []).map((o, i) => {
                        const on = String(draft.answer || '').toUpperCase().includes(o.k);
                        return (
                          <div key={o.k} className="flex items-center gap-2.5">
                            <button
                              type="button"
                              onClick={() => {
                                const cur = String(draft.answer || '').toUpperCase();
                                const next = on
                                  ? cur.replace(o.k, '')
                                  : [...cur, o.k].sort().join('');
                                setDraft({ ...draft, answer: next });
                              }}
                              className={cn(
                                'grid h-8 w-8 shrink-0 place-items-center rounded-lg border text-[13px] font-semibold transition-all',
                                on
                                  ? 'border-emerald/45 bg-emerald/15 text-emerald'
                                  : 'border-hairline bg-veil/4 text-fg-mute hover:border-veil/22',
                              )}
                              title={on ? '取消这个正确答案' : '设为正确答案之一'}
                            >
                              {on ? '✓' : o.k}
                            </button>
                            <Input
                              value={o.t}
                              onChange={(e) => {
                                const next = [...(draft.options || [])];
                                next[i] = { ...o, t: e.target.value };
                                setDraft({ ...draft, options: next });
                              }}
                              placeholder={`选项 ${o.k}`}
                            />
                            {(draft.options || []).length > 4 && (
                              <button
                                type="button"
                                onClick={() => {
                                  const next = (draft.options || [])
                                    .filter((x) => x.k !== o.k)
                                    .map((x, j) => ({ ...x, k: LETTERS[j] }));
                                  setDraft({
                                    ...draft,
                                    options: next,
                                    answer: String(draft.answer || '').replace(o.k, ''),
                                  });
                                }}
                                aria-label={`删除选项 ${o.k}`}
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-faint transition-colors hover:bg-rose/12 hover:text-rose"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {(draft.options || []).length < 6 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDraft({
                            ...draft,
                            options: [...(draft.options || []), { k: LETTERS[(draft.options || []).length], t: '' }],
                          })}
                        >
                          <Plus size={13} /> 加一个选项
                        </Button>
                      )}
                      <p className="text-[11.5px] text-fg-mute">
                        当前答案：<span className="font-mono text-fg-soft">{draft.answer || '（还没选）'}</span>
                      </p>
                    </div>
                  </Field>
                )}

                {draft.type === 'judge' && (
                  <Field label="答案" hint="判断题只有两个选项，界面会渲染成「正确 / 错误」两个按钮">
                    <Segmented
                      value={draft.answer || 'T'}
                      onChange={(v) => setDraft({ ...draft, answer: v })}
                      options={[{ value: 'T', label: '正确' }, { value: 'F', label: '错误' }]}
                    />
                  </Field>
                )}

                {draft.type === 'blank' && (
                  <Field
                    label="答案"
                    hint="只能是整数、小数或分数（2 / -1/2 / 0.5）。写 \frac{1}{2} 也行，会自动转换"
                  >
                    <Input
                      value={draft.answer}
                      onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
                      placeholder="例：1/2"
                    />
                  </Field>
                )}

                {(draft.type === 'solve' || draft.type === 'proof') && (
                  <>
                    <Field
                      label="参考答案"
                      hint="作答时你会先看到它，再给自己打分。写结论 + 关键中间结果"
                    >
                      <TextArea
                        rows={3}
                        value={draft.answer}
                        onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
                        placeholder={draft.type === 'proof'
                          ? '例：由 $f$ 在 $[a,b]$ 连续、在 $(a,b)$ 可导，且 $f(a)=f(b)$，故存在 $\\xi\\in(a,b)$ 使 $f\'(\\xi)=0$。'
                          : '例：$\\lim_{x\\to0}\\frac{\\sin 3x}{2x}=\\frac{3}{2}$'}
                      />
                    </Field>

                    <Field
                      label="评分点"
                      hint="分步给分的依据。作答时会逐条列出来让你对照，所以每条要能独立判断对错"
                    >
                      <div className="space-y-2">
                        {(draft.steps || []).map((s, i) => (
                          <div key={i} className="flex items-start gap-2">
                            <span className="mt-2.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-veil/10 bg-veil/5 text-[11px] text-fg-mute">
                              {i + 1}
                            </span>
                            <Input
                              value={s.t}
                              onChange={(e) => {
                                const next = [...(draft.steps || [])];
                                next[i] = { ...s, t: e.target.value };
                                setDraft({ ...draft, steps: next });
                              }}
                              placeholder={`第 ${i + 1} 步 —— 例：写出导数定义式`}
                            />
                            <input
                              type="number"
                              min={0}
                              max={20}
                              value={s.pts}
                              onChange={(e) => {
                                const next = [...(draft.steps || [])];
                                next[i] = { ...s, pts: Number(e.target.value) || 0 };
                                setDraft({ ...draft, steps: next });
                              }}
                              aria-label={`第 ${i + 1} 步的分值`}
                              className="h-10 w-16 shrink-0 rounded-xl border border-hairline bg-veil/4 px-2 text-center text-[12.5px] tabular text-fg outline-none focus:border-cyan/40"
                            />
                            <button
                              type="button"
                              onClick={() => setDraft({ ...draft, steps: (draft.steps || []).filter((_, j) => j !== i) })}
                              aria-label={`删除第 ${i + 1} 步`}
                              className="mt-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-fg-faint transition-colors hover:bg-rose/12 hover:text-rose"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                        <div className="flex items-center gap-3">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={(draft.steps || []).length >= 12}
                            onClick={() => setDraft({ ...draft, steps: [...(draft.steps || []), { t: '', pts: 4 }] })}
                          >
                            <Plus size={13} /> 加一个评分点
                          </Button>
                          {(draft.steps || []).length > 0 && (
                            <span className="flex items-center gap-1 text-[11.5px] text-amber-200/90">
                              <ListChecks size={12} />
                              合计 {(draft.steps || []).reduce((a, s) => a + (s.pts || 0), 0)} 分
                            </span>
                          )}
                        </div>
                      </div>
                    </Field>
                  </>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="来源（可选）">
                    <Input
                      value={draft.sourceType || ''}
                      onChange={(e) => setDraft({ ...draft, sourceType: e.target.value })}
                      placeholder="例：2023 真题"
                    />
                  </Field>
                  <Field label="年份（可选）">
                    <Input
                      value={draft.sourceYear ? String(draft.sourceYear) : ''}
                      onChange={(e) => setDraft({
                        ...draft,
                        sourceYear: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : undefined,
                      })}
                      placeholder="例：2023"
                    />
                  </Field>
                </div>

                <Field label="解析（可选）" hint="写清关键步骤，复盘时看的就是这里">
                  <TextArea
                    rows={2}
                    value={draft.analysis || ''}
                    onChange={(e) => setDraft({ ...draft, analysis: e.target.value })}
                    placeholder="例：拆成 $3/2 \cdot \frac{\sin 3x}{3x}$，由重要极限得 $3/2$"
                  />
                </Field>

                {formError && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-rose/25 bg-rose/8 px-3.5 py-3">
                    <CircleAlert size={14} className="mt-0.5 shrink-0 text-rose" />
                    <p className="text-[12.5px] leading-relaxed text-rose-100">{formError}</p>
                  </div>
                )}

                <div className="flex items-center gap-2.5">
                  <Button onClick={save} loading={saving} disabled={!canSave}>
                    {editingId ? '保存修改' : '加入题库'}
                  </Button>
                  <Button variant="ghost" onClick={() => setFormOpen(false)}>取消</Button>
                </div>
              </div>
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- 列表 ---------- */}
      {list.loading && !list.data ? (
        <div className="space-y-2.5">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[76px] rounded-2xl" />)}
        </div>
      ) : shown.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<SquarePen size={22} />}
            title={mineOnly ? '你还没录过题' : '这个筛选下还没有题'}
            desc={mineOnly
              ? '点右上角「录一道题」，把真题卷子上的错题录进来。'
              : '换个考点或题型，或者取消筛选。'}
          />
        </Panel>
      ) : (
        <div className="space-y-2.5">
          {shown.map((q, i) => {
            const diff = DIFFICULTY[q.difficulty] || DIFFICULTY[2];
            const node = nodes.find((n) => n.id === q.kid);
            return (
              <motion.div
                key={q.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: Math.min(i * 0.02, 0.3) }}
              >
                <Panel className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-[13.5px] leading-relaxed text-fg-soft">
                        <RichText text={q.stem} bareLatex inline />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {node && <span className="text-[11.5px] text-cyan">{node.title}</span>}
                        <span className={cn('rounded border px-1.5 py-px text-[10.5px]', diff.cls)}>{diff.label}</span>
                        <span className="text-[11px] text-fg-faint">{q.typeLabel || q.type}</span>
                        {q.sourceType && <span className="text-[11px] text-fg-faint">{q.sourceType}</span>}
                        {q.mine && <Badge tone="cyan">我的</Badge>}
                      </div>
                    </div>
                    {q.mine && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(q)}>改</Button>
                        <button
                          onClick={() => remove(q)}
                          aria-label="删除这道题"
                          className="grid h-7 w-7 place-items-center rounded-lg text-fg-faint transition-colors hover:bg-rose/12 hover:text-rose"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                </Panel>
              </motion.div>
            );
          })}
        </div>
      )}

      <Panel className="p-4">
        <div className="flex items-start gap-2.5 text-[11.5px] leading-relaxed text-fg-mute">
          <CircleAlert size={13} className="mt-0.5 shrink-0 text-fg-faint" />
          <span>
            录题时会检查答案能不能被自动判分。判不了的（答案含根号、π 或「无解」这类描述）
            会被拒绝并说明原因 —— 放进去的话，你以后答对也会被判错，而且看不出哪里不对。
            这类题建议改成选择题。解答题和证明题不受这条限制，它们本来就不自动判分。
          </span>
        </div>
      </Panel>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[12px] font-medium text-fg-soft">{label}</span>
        {hint && <span className="text-[11px] text-fg-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
