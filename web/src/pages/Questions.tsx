import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, Plus, SquarePen, Trash2, X } from 'lucide-react';
import { api, type QuestionDraft } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import {
  Panel, Button, Badge, Skeleton, EmptyState, SectionTitle, Input, TextArea, Segmented,
} from '@/components/ui/Primitives';
import { RichText } from '@/components/ui/Math';
import { cn, DIFFICULTY } from '@/lib/utils';

const blankOptions = () => [{ k: 'A', t: '' }, { k: 'B', t: '' }, { k: 'C', t: '' }, { k: 'D', t: '' }];

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

/**
 * 我的题库 —— 录真题卷子上的错题。
 *
 * 内置题库只有 204 道（每个考点 3 道），刷完就断了；
 * 而真正的短板在真题卷子上，那些题原来一道都进不来。
 *
 * 录进来的题和内置题一视同仁：能作答、进错题本、参与掌握度、
 * 能被 AI 分析错因，也能被「举一反三」当参考。
 */
export default function Questions() {
  const pushToast = useApp((s) => s.pushToast);
  const [kidFilter, setKidFilter] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft(''));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const list = useAsync(() => api.catalog.questions({ limit: 300 }), []);
  const tree = useAsync(() => api.catalog.tree(), []);

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
    if (mineOnly) out = out.filter((q) => q.mine);
    return out;
  }, [all, kidFilter, mineOnly]);

  const mineCount = all.filter((q) => q.mine).length;

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
      answer: q.answer ?? '',
      analysis: '',
      difficulty: q.difficulty,
      sourceType: q.sourceType || '真题',
      sourceYear: q.sourceYear ?? undefined,
    });
    setFormError('');
    setFormOpen(true);
    /* 编辑时要把答案和解析取回来 —— 列表接口刻意不返回它们（考试中不能泄露），
     * 所以这里单独拉一次单题详情。 */
    api.catalog.question(q.id).then((r) => {
      setDraft((d) => ({ ...d, answer: r.question.answer, analysis: r.question.analysis }));
    }).catch(() => { /* 取不到就留空，用户重填 */ });
  };

  const save = async () => {
    setSaving(true);
    setFormError('');
    try {
      const body: QuestionDraft = draft.type === 'choice'
        ? draft
        : { ...draft, options: undefined };
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

  const canSave = draft.kid && draft.stem.trim().length >= 5 && String(draft.answer).trim()
    && (draft.type === 'blank' || (draft.options || []).every((o) => o.t.trim()));

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
          <Button onClick={openCreate} shimmer disabled={!nodes.length}>
            <Plus size={14} /> 录一道题
          </Button>
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
          <Segmented
            size="sm"
            value={mineOnly ? 'mine' : 'all'}
            onChange={(v) => setMineOnly(v === 'mine')}
            options={[{ value: 'all', label: '全部' }, { value: 'mine', label: `只看我的 ${mineCount}` }]}
          />
        </div>
      </Panel>

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
                desc="答案必须能被自动判分 —— 判不了的题录进来，你以后答对也会被判错"
                right={
                  <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
                    <X size={14} /> 收起
                  </Button>
                }
                className="mb-4"
              />

              <div className="space-y-4">
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
                  <Field label="题型">
                    <Segmented
                      value={draft.type}
                      onChange={(v) => setDraft({
                        ...draft,
                        type: v,
                        answer: v === 'choice' ? 'A' : '',
                        options: v === 'choice' ? (draft.options?.length ? draft.options : blankOptions()) : undefined,
                      })}
                      options={[{ value: 'choice', label: '选择题' }, { value: 'blank', label: '填空题' }]}
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

                {draft.type === 'choice' ? (
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
                ) : (
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

                <div className="grid gap-3 sm:grid-cols-2">
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
                  <Field label="来源（可选）">
                    <Input
                      value={draft.sourceType || ''}
                      onChange={(e) => setDraft({ ...draft, sourceType: e.target.value })}
                      placeholder="例：2023 真题"
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
            title={mineOnly ? '你还没录过题' : '这个考点下还没有题'}
            desc={mineOnly
              ? '点右上角「录一道题」，把真题卷子上的错题录进来。'
              : '换个考点，或者取消筛选。'}
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
                        <span className="text-[11px] text-fg-faint">{q.type === 'choice' ? '选择' : '填空'}</span>
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
            这类题建议改成选择题。
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
