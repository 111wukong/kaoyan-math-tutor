import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Copy, Download, FileText, Layers, Plus, Printer, Search, Sparkles, Trash2, Zap,
} from 'lucide-react';
import { AppLink as Link } from '@/lib/links';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useApp } from '@/stores/app';
import { Panel, Button, Skeleton, Badge, Segmented, EmptyState, Input, TextArea } from '@/components/ui/Primitives';
import { Modal } from '@/components/ui/Modal';
import { RichText } from '@/components/ui/Math';
import { announceAchievements } from '@/components/ui/Toaster';
import { cn, copyText, relTime } from '@/lib/utils';
import { printDeck, downloadDeckHtml, deckToText, type DeckCard } from '@/lib/deckExport';

const TYPE_META: Record<string, { label: string; tone: any }> = {
  point: { label: '必记结论', tone: 'cyan' },
  pitfall: { label: '易错点', tone: 'amber' },
  formula: { label: '公式', tone: 'violet' },
  problem: { label: '题型', tone: 'emerald' },
  question: { label: '疑问', tone: 'rose' },
};

export default function Deck() {
  const pushToast = useApp((s) => s.pushToast);
  const refreshSnapshot = useApp((s) => s.refreshSnapshot);
  const { data, loading, reload } = useAsync(() => api.deck.list(), [], { key: 'deck.list' });

  const [filter, setFilter] = useState<'all' | 'point' | 'pitfall' | 'formula' | 'problem'>('all');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ kid: '', title: '', front: '', back: '', type: 'point' });
  const [saving, setSaving] = useState(false);

  const all: DeckCard[] = data?.cards || [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((c) => {
      if (filter !== 'all' && c.type !== filter) return false;
      if (!q) return true;
      return c.title.toLowerCase().includes(q) || c.front.toLowerCase().includes(q) || (c.back || '').toLowerCase().includes(q);
    });
  }, [all, filter, query]);

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: all.length };
    all.forEach((c) => { m[c.type] = (m[c.type] || 0) + 1; });
    return m;
  }, [all]);

  const addCard = async () => {
    if (!form.kid.trim() || !form.title.trim() || !form.front.trim()) {
      pushToast({ kind: 'warn', title: '知识点 ID、标题、正面问题都要填' });
      return;
    }
    setSaving(true);
    try {
      const r = await api.deck.add({
        kid: form.kid.trim(), title: form.title.trim(), front: form.front.trim(),
        back: form.back.trim(), type: form.type, src: 'manual',
      });
      if (r?.achievements?.length) announceAchievements(r.achievements, pushToast);
      setAddOpen(false);
      setForm({ kid: '', title: '', front: '', back: '', type: 'point' });
      reload();
      refreshSnapshot();
      pushToast({ kind: 'success', title: '卡片已加入库' });
    } catch {
      pushToast({ kind: 'error', title: '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deck.remove(id);
      reload();
      refreshSnapshot();
    } catch { /* 忽略 */ }
  };

  const toReview = async (id: string) => {
    try {
      await api.deck.toCard(id);
      pushToast({ kind: 'success', title: '已加入复习队列', desc: '明天会出现在到期卡片里' });
      refreshSnapshot();
    } catch {
      pushToast({ kind: 'error', title: '操作失败' });
    }
  };

  const doPrint = () => {
    if (!filtered.length) return;
    if (printDeck(filtered)) pushToast({ kind: 'info', title: '已打开打印预览', desc: '选「另存为 PDF」即可' });
  };

  const doDownload = () => {
    if (!filtered.length) return;
    if (downloadDeckHtml(filtered)) pushToast({ kind: 'success', title: 'HTML 已下载', desc: '单文件，可直接分享' });
  };

  const doCopy = async () => {
    if (!filtered.length) return;
    const ok = await copyText(deckToText(filtered));
    pushToast({ kind: ok ? 'success' : 'error', title: ok ? '已复制到剪贴板' : '复制失败' });
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[110px] rounded-2xl" />
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[140px] rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 头部 */}
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan/25 bg-cyan/10 text-cyan">
              <Layers size={18} />
            </div>
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-fg">卡片库</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-mute">
                把考点蒸馏成能随时翻的小卡片 · 共 {all.length} 张
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={doPrint} disabled={!filtered.length}>
              <Printer size={13} /> 打印 / PDF
            </Button>
            <Button variant="outline" size="sm" onClick={doDownload} disabled={!filtered.length}>
              <Download size={13} /> 存 HTML
            </Button>
            <Button variant="outline" size="sm" onClick={doCopy} disabled={!filtered.length}>
              <Copy size={13} /> 复制文本
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={13} /> 新建卡片
            </Button>
          </div>
        </div>

        {/* 筛选 */}
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `全部 ${counts.all || 0}` },
              { value: 'point', label: `结论 ${counts.point || 0}` },
              { value: 'pitfall', label: `易错 ${counts.pitfall || 0}` },
              { value: 'formula', label: `公式 ${counts.formula || 0}` },
              { value: 'problem', label: `题型 ${counts.problem || 0}` },
            ]}
          />
          <div className="relative min-w-[180px] flex-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜卡片内容"
              className="h-9 w-full rounded-xl border border-hairline bg-veil/4 pl-9 pr-3 text-[12.5px] text-fg outline-none transition-all placeholder:text-fg-faint focus:border-cyan/45"
            />
          </div>
        </div>
      </Panel>

      {/* 列表 */}
      {filtered.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Layers size={22} />}
            title={all.length === 0 ? '卡片库还是空的' : '没有匹配的卡片'}
            desc={all.length === 0
              ? '去 AI 对话里聊一个考点，然后点「提取知识点」，卡片会自动进到这里。'
              : '换个筛选条件或清空搜索词。'}
            action={all.length === 0 ? <Button onClick={() => setAddOpen(true)}><Plus size={14} /> 手动新建一张</Button> : undefined}
          />
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <AnimatePresence>
            {filtered.map((c, i) => {
              const meta = TYPE_META[c.type] || TYPE_META.point;
              return (
                <motion.div
                  key={c.id}
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.35, delay: Math.min(i * 0.02, 0.3), ease: [0.16, 1, 0.3, 1] }}
                >
                  <Panel className="group flex h-full flex-col p-4">
                    <div className="mb-2.5 flex items-start gap-2">
                      <Badge tone={meta.tone} className="shrink-0">{meta.label}</Badge>
                      <Link
                        to={`/learn/${c.kid}`}
                        className="min-w-0 flex-1 truncate text-[11.5px] text-cyan/85 transition-colors hover:text-cyan"
                      >
                        {c.kidTitle || c.kid}
                      </Link>
                      <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => toReview(c.id)}
                          title="加入复习队列"
                          aria-label="加入复习队列"
                          className="grid h-6 w-6 place-items-center rounded-md text-fg-faint transition-colors hover:bg-violet/15 hover:text-violet"
                        >
                          <Zap size={12} />
                        </button>
                        <button
                          onClick={() => remove(c.id)}
                          title="删除"
                          aria-label="删除卡片"
                          className="grid h-6 w-6 place-items-center rounded-md text-fg-faint transition-colors hover:bg-rose/15 hover:text-rose"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                    <h3 className="text-[13.5px] font-medium leading-snug text-fg">{c.title}</h3>

                    <div className="mt-2.5 flex-1 text-[12.5px] leading-[1.75] text-fg-soft">
                      <RichText text={c.front} bareLatex />
                    </div>

                    {c.back && (
                      <div className="mt-3 border-t border-hairline pt-2.5">
                        <div className="mb-1 text-[10.5px] font-medium text-fg-mute">答</div>
                        <div className="text-[12.5px] leading-[1.75] text-fg-soft">
                          <RichText text={c.back} bareLatex />
                        </div>
                      </div>
                    )}

                    <div className="mt-3 flex items-center justify-between text-[10.5px] text-fg-faint">
                      <span>{c.src === 'ai' ? 'AI 提取' : c.src === 'manual' ? '手动添加' : '课堂生成'}</span>
                      <span>{relTime(c.ts)}</span>
                    </div>
                  </Panel>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* 新建 */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="新建卡片"
        desc="正面写成问题，背面写答案 —— 提问式才适合主动回忆"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>取消</Button>
            <Button size="sm" onClick={addCard} loading={saving}>保存</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="所属知识点 ID"
            placeholder="比如 c2n3（可以在知识树详情页的网址里看到）"
            value={form.kid}
            onChange={(e) => setForm({ ...form, kid: e.target.value })}
          />
          <Input
            label="标题"
            placeholder="一句话概括这张卡"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <TextArea
            label="正面（问题）"
            rows={3}
            placeholder="比如：罗尔定理的三个条件分别是什么？"
            value={form.front}
            onChange={(e) => setForm({ ...form, front: e.target.value })}
          />
          <TextArea
            label="背面（答案）"
            rows={3}
            placeholder="支持 LaTeX，比如 $f'(\\xi)=0$"
            value={form.back}
            onChange={(e) => setForm({ ...form, back: e.target.value })}
          />
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-fg-soft">类型</div>
            <Segmented
              size="sm"
              value={form.type as any}
              onChange={(v) => setForm({ ...form, type: v })}
              options={[
                { value: 'point', label: '必记结论' },
                { value: 'pitfall', label: '易错点' },
                { value: 'formula', label: '公式' },
                { value: 'problem', label: '题型' },
              ]}
            />
          </div>
        </div>
      </Modal>

      {/* 说明 */}
      <Panel className="p-4">
        <div className="flex items-start gap-2.5 text-[11.5px] leading-relaxed text-fg-mute">
          <FileText size={13} className="mt-0.5 shrink-0 text-fg-faint" />
          <span>
            导出的 A4 是两栏排版、按类型配色，卡片不会被分页切断 —— 打印出来直接能夹进书里。
            也可以点卡片右上角的闪电图标，把它加进 FSRS 复习队列。
          </span>
        </div>
      </Panel>
    </div>
  );
}
