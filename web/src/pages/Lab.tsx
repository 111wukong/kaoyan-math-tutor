import { Fragment, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowUpRight, BookOpen, ChevronDown, FlaskConical, Info, Move3d, Play, Search, Star,
} from 'lucide-react';
import { Panel, SectionTitle, Segmented, Badge } from '@/components/ui/Primitives';
import { InlineMath } from '@/components/ui/Math';
import { AppLink as Link } from '@/lib/links';
import { api, type Formula } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { cn, MASTERY_STYLE } from '@/lib/utils';
import { FormulaDemo } from '@/components/lab/FormulaDemo';
import { DEMO_KINDS } from '@/lib/demo';

/* 公式实验室 = 两个东西
 *
 *   ① 交互演示（Playground）：**公式库里每一条都能拖**。
 *      上一版只有 4 个手写 canvas（割线、黎曼和、泰勒、ε-N），
 *      而公式手册有 257 条 —— 用户看到的是「怎么就这几个能动」。
 *
 *      现在改成「参数化演示引擎」：lib/demo/ 里有一组通用绘图原语
 *      （曲线、填充、柱、等高线、向量、矩阵…）和 30 多个演示形态，
 *      再由 classify.ts 把 257 条公式按**分组**映射到这些形态上。
 *      于是「每条公式都有演示」不再是 257 份工作量。
 *
 *   ② 公式手册（Handbook）：按考纲整理的公式库，每条都带成立条件与易错点，
 *      并且**每张卡片都能就地展开演示** —— 查到了就能立刻动手看。
 *
 * ★ 为什么手册和演示要能互相跳转：
 *   手册负责「查得到、不漏」，演示负责「看得懂、记得住」。
 *   查公式时最想做的事就是「看看它长什么样」，所以手册卡片上直接给按钮，
 *   而不是让用户切到另一个 tab 再自己搜一遍。
 */

/** 精选：第一次打开时最值得先看的几条（按分组挑，不写死 id —— id 会变） */
const PICKS: { group: string; name?: RegExp; label: string }[] = [
  { group: '导数的定义', label: '割线 → 切线' },
  { group: '定积分', name: /牛顿/, label: '牛顿-莱布尼茨' },
  { group: '泰勒公式', label: '泰勒展开' },
  { group: '两个重要极限', label: '重要极限' },
  { group: '常用连续型分布', name: /^正态分布/, label: '正态分布' },
  { group: '特征值与特征向量', name: /特征方程/, label: '特征值' },
  { group: '行列式的性质', name: /转置/, label: '行列式的几何意义' },
  { group: '概率基本公式', name: /加法/, label: '加法公式' },
  { group: '方向导数与梯度', name: /梯度/, label: '梯度' },
  { group: '敛散性判据', name: /p 级数/, label: 'p 级数' },
];

export default function Lab() {
  const [tab, setTab] = useState<'play' | 'handbook'>('play');

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-violet/25 bg-violet/10 text-violet">
              <FlaskConical size={18} />
            </div>
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight text-fg">公式实验室</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-mute">
                {tab === 'play'
                  ? '公式库里每一条都能拖 —— 不只是精选的那几个'
                  : '按考纲整理的公式库 —— 每条都带成立条件，卡片上就能展开演示'}
              </p>
            </div>
          </div>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'play', label: <span className="flex items-center gap-1.5"><Move3d size={12} /> 交互演示</span> },
              { value: 'handbook', label: <span className="flex items-center gap-1.5"><BookOpen size={12} /> 公式手册</span> },
            ]}
          />
        </div>
      </Panel>

      {tab === 'play' ? <Playground /> : <Handbook />}
    </div>
  );
}

/* ============================================================
   ① 交互演示
   ============================================================ */
function Playground() {
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');
  const [chapter, setChapter] = useState('');
  const [pickedId, setPickedId] = useState('');

  /* 防抖 260ms。每打一个字就重算列表，会让列表一直跳。 */
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim()), 260);
    return () => clearTimeout(t);
  }, [raw]);

  /* 一次把整库拉下来，筛选在本地做。
   * 演示台和手册用的是同一个接口、同一个缓存 key —— 来回切 tab 不重拉。 */
  const data = useAsync(() => api.catalog.formulas({}), [], {
    key: 'formulas:all',
    staleTime: 5 * 60_000,
  });

  const items = useMemo(() => data.data?.items || [], [data.data]);

  const chapters = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    for (const f of items) {
      if (!out.some((c) => c.id === f.chapterId)) out.push({ id: f.chapterId, name: f.chapterName });
    }
    return out;
  }, [items]);

  const shown = useMemo(() => {
    const needle = q.toLowerCase();
    return items.filter((f) => {
      if (chapter && f.chapterId !== chapter) return false;
      if (!needle) return true;
      return `${f.name} ${f.tex} ${f.cond} ${f.note} ${f.group}`.toLowerCase().includes(needle);
    });
  }, [items, q, chapter]);

  const picks = useMemo(() => {
    const out: { label: string; f: Formula }[] = [];
    for (const p of PICKS) {
      const f = items.find((x) => x.group === p.group && (!p.name || p.name.test(x.name)));
      if (f) out.push({ label: p.label, f });
    }
    return out;
  }, [items]);

  /* 选中的公式。没选过就取筛选结果里的第一条 —— 打开页面就有东西可拖，
   * 而不是先让用户面对一块空画布。 */
  const current = useMemo(
    () => items.find((f) => f.id === pickedId) || shown[0] || items[0] || null,
    [items, pickedId, shown],
  );

  const loading = data.loading && !data.data;

  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[220px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-faint" />
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              aria-label="搜索公式"
              placeholder={`在 ${items.length || '…'} 条公式里搜 ——「洛必达」「sin x」「AC-B²」「特征值」`}
              className="h-10 w-full rounded-xl border border-hairline bg-veil/4 pl-10 pr-3.5 text-[13.5px] text-fg outline-none transition-all placeholder:text-fg-faint focus:border-cyan/45 focus:bg-veil/6"
            />
          </div>
          <select
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
            className="h-10 max-w-[260px] rounded-xl border border-hairline bg-veil/4 px-3 text-[12.5px] text-fg-soft outline-none transition-colors hover:border-veil/20 focus:border-cyan/40"
          >
            <option value="">全部章节</option>
            {chapters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Badge tone="violet"><Move3d size={10} /> {DEMO_KINDS.length} 类交互</Badge>
        </div>

        {picks.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] text-fg-faint">精选</span>
            {picks.map((p) => (
              <button
                key={p.f.id}
                onClick={() => setPickedId(p.f.id)}
                className={cn(
                  'flex items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] transition-colors',
                  current?.id === p.f.id
                    ? 'border-cyan/45 bg-cyan/12 text-cyan-100'
                    : 'border-hairline bg-veil/4 text-fg-mute hover:border-cyan/30 hover:text-fg-soft',
                )}
              >
                <Play size={9} /> {p.label}
              </button>
            ))}
          </div>
        )}

        <p className="mt-2.5 text-[11.5px] text-fg-faint">
          {data.data
            ? `库里共 ${data.data.total} 条 · 覆盖 ${data.data.coveredKids} 个考点 · ${data.data.chapters} 章`
              + (q || chapter ? ` · 当前筛选出 ${shown.length} 条` : '')
            : '加载中…'}
        </p>
      </Panel>

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <div className="skeleton h-[420px] rounded-2xl" />
          <div className="skeleton h-[420px] rounded-2xl" />
        </div>
      ) : !current ? (
        <Panel>
          <div className="px-6 py-12 text-center">
            <p className="text-[14px] text-fg-soft">没有匹配的公式</p>
            <p className="mt-1.5 text-[12.5px] text-fg-mute">换个词试试，或者清掉章节筛选。</p>
          </div>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          {/* 公式列表 */}
          <Panel className="flex max-h-[640px] flex-col overflow-hidden p-0">
            <div className="border-b border-hairline px-3.5 py-2.5 text-[11.5px] text-fg-mute">
              {shown.length} 条{q ? '（已搜索）' : ''} —— 点一条就开始拖
            </div>
            <div className="flex-1 overflow-y-auto">
              {shown.slice(0, 200).map((f, i) => {
                /* 按「章节 → 分组」插表头，而不是每行都重复一遍
                 * 「第一章 函数、极限与连续 · 常用等价无穷小（x → 0）」——
                 * 257 条全列出来时，那种重复会把真正要看的东西淹掉。 */
                const prev = shown[i - 1];
                const newChapter = !prev || prev.chapterId !== f.chapterId;
                const newGroup = newChapter || prev.group !== f.group;
                return (
                  <Fragment key={f.id}>
                    {newChapter && (
                      <div className="border-y border-hairline bg-veil/6 px-3.5 py-1.5 text-[11px] font-medium text-fg-mute">
                        {f.chapterName}
                      </div>
                    )}
                    {newGroup && (
                      <div className="flex items-center gap-2 px-3.5 pb-1 pt-2">
                        <span className="text-[10.5px] tracking-wide text-cyan/75">{f.group}</span>
                        <span className="h-px flex-1 bg-hairline" />
                      </div>
                    )}
                    <button
                      data-formula={f.id}
                      onClick={() => setPickedId(f.id)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3.5 py-2 text-left transition-colors',
                        current.id === f.id ? 'bg-cyan/10' : 'hover:bg-veil/4',
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          current.id === f.id ? 'bg-cyan' : 'bg-veil/15',
                        )}
                      />
                      <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', current.id === f.id ? 'text-fg' : 'text-fg-soft')}>
                        {f.name}
                      </span>
                      {f.must === 1 && <Star size={10} className="shrink-0 text-amber" />}
                    </button>
                  </Fragment>
                );
              })}
              {shown.length > 200 && (
                <div className="px-3.5 py-3 text-[11.5px] text-fg-faint">
                  还有 {shown.length - 200} 条 —— 用搜索缩小范围
                </div>
              )}
            </div>
          </Panel>

          {/* 演示台 */}
          <Panel className="p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <SectionTitle title={current.name} className="min-w-0 flex-1" />
              {current.kid && (
                <Link
                  to={`/learn/${current.kid}`}
                  className="group flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-veil/4 px-2 py-[3px] text-[11px] text-fg-mute transition-colors hover:border-cyan/35 hover:text-fg-soft"
                >
                  {current.mastery && (
                    <span className={cn('h-1.5 w-1.5 rounded-full', MASTERY_STYLE[current.mastery].dot)} />
                  )}
                  <span className="max-w-[160px] truncate">{current.kidTitle}</span>
                  <ArrowUpRight size={10} className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </Link>
              )}
            </div>
            <FormulaDemo formula={current} />
          </Panel>
        </div>
      )}

      <Panel className="p-4">
        <div className="flex items-start gap-2.5">
          <Info size={14} className="mt-0.5 shrink-0 text-cyan" />
          <p className="text-[12px] leading-relaxed text-fg-mute">
            演示不是「把公式画一遍」，而是把公式里那个**动起来才看得见**的量做成滑块。
            拖到边界往往最有收获 —— 比如把 ε 拖到最小、把 n 拖到最大、
            把行列式的两列拖成共线。
          </p>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   ② 公式手册
   ============================================================
   257 条、19 章、67 个考点。设计上只有三件事：
     1. 查得到 —— 搜索同时匹配中文名、LaTeX 符号、条件、备注；
     2. 不漏 —— 每章都能整章展开，章头写着条数和必背数；
     3. 能对上号 —— 每条都挂着它对应的考点，点进去就是知识点详情。
   外加两个「真正会用的视图」：只看必背、以及**就地展开交互演示**。
   ============================================================ */
function Handbook() {
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');
  const [mustOnly, setMustOnly] = useState(false);
  /** 章节的展开状态。**没记过**的章节走默认（第一章展开）—— 用一个「只记显式操作」的表，
   *  而不是把 19 个默认值都初始化一遍（那样加章节就得同步改这里）。 */
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  /** 当前展开演示的公式 id。**同时只开一个** ——
   *  每个演示都带 canvas + ResizeObserver，全开一遍是几十个画布在同时重绘。 */
  const [demoId, setDemoId] = useState('');

  /* 防抖 260ms。每打一个字就打一次接口，既浪费也让列表一直跳 ——
   * 输入框和「真正用于查询的值」必须分开，不然打「洛必达」会触发三次查询。 */
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim()), 260);
    return () => clearTimeout(t);
  }, [raw]);

  const data = useAsync(
    () => api.catalog.formulas({ q, must: mustOnly ? '1' : '' }),
    [q, mustOnly],
    /* key 把筛选条件带上 —— 来回切「只看必背」时结果是现成的。
     * 5 分钟新鲜期：公式库是静态内容，不跟着用户操作变。 */
    { key: `formulas:${q}|${mustOnly ? 1 : 0}`, staleTime: 5 * 60_000 },
  );

  const items = data.data?.items || [];
  const searching = q.length > 0;

  /* 按章节切连续段。服务端已经排好序（章节顺序 → 章内 sort_order），
   * 这里只切不排 —— 再排一次就可能和服务端的口径不一致。 */
  const sections = useMemo(() => {
    const out: { chapterId: string; chapterName: string; categoryName: string; items: Formula[] }[] = [];
    for (const f of items) {
      const last = out[out.length - 1];
      if (last && last.chapterId === f.chapterId) last.items.push(f);
      else out.push({ chapterId: f.chapterId, chapterName: f.chapterName, categoryName: f.categoryName, items: [f] });
    }
    return out;
  }, [items]);

  const isOpen = (id: string, idx: number) => {
    /* 搜索时全部展开 —— 搜完还要一个个点开，等于没搜。 */
    if (searching) return true;
    const v = closed[id];
    return v === undefined ? idx === 0 : !v;
  };
  const allClosed = sections.length > 0 && sections.every((s, i) => !isOpen(s.chapterId, i));

  const loading = data.loading && !data.data;

  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-faint" />
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              aria-label="搜索公式"
              placeholder="搜公式名或符号 ——「等价无穷小」「洛必达」「sin x」「AC-B²」"
              className="h-10 w-full rounded-xl border border-hairline bg-veil/4 pl-10 pr-3.5 text-[13.5px] text-fg outline-none transition-all placeholder:text-fg-faint focus:border-cyan/45 focus:bg-veil/6"
            />
          </div>
          <button
            onClick={() => setMustOnly((v) => !v)}
            aria-pressed={mustOnly}
            className={cn(
              'flex h-10 items-center gap-1.5 rounded-xl border px-3 text-[12.5px] transition-colors',
              mustOnly
                ? 'border-amber/45 bg-amber/12 text-amber-100'
                : 'border-hairline bg-veil/4 text-fg-mute hover:text-fg-soft',
            )}
          >
            <Star size={12} /> 只看必背
          </button>
          <button
            onClick={() => setClosed(allClosed ? {} : Object.fromEntries(sections.map((s) => [s.chapterId, true])))}
            className="h-10 rounded-xl border border-hairline bg-veil/4 px-3 text-[12.5px] text-fg-mute transition-colors hover:text-fg-soft"
          >
            {allClosed ? '展开全部' : '收起全部'}
          </button>
        </div>

        <p className="mt-2.5 text-[11.5px] text-fg-faint">
          {data.data
            ? `库里共 ${data.data.total} 条 · 覆盖 ${data.data.coveredKids} 个考点 · ${data.data.chapters} 章`
              + (searching || mustOnly ? ` · 当前筛选出 ${data.data.count} 条` : '')
              + ' · 点卡片上的「动手」就地展开演示'
            : '加载中…'}
        </p>
      </Panel>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-2xl" />)}
        </div>
      ) : !sections.length ? (
        <Panel>
          <div className="px-6 py-12 text-center">
            <p className="text-[14px] text-fg-soft">没有匹配的公式</p>
            <p className="mt-1.5 text-[12.5px] text-fg-mute">
              {mustOnly ? '试试关掉「只看必背」—— 有些条目是了解级的。' : '换个词试试，或者只打符号的一半（如「arctan」）。'}
            </p>
          </div>
        </Panel>
      ) : (
        sections.map((s, idx) => {
          const open = isOpen(s.chapterId, idx);
          const mustN = s.items.filter((x) => x.must).length;
          return (
            <Panel key={s.chapterId} className="overflow-hidden p-0">
              <button
                onClick={() => setClosed((m) => ({ ...m, [s.chapterId]: open }))}
                aria-expanded={open}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-veil/4"
              >
                <ChevronDown
                  size={15}
                  className={cn('shrink-0 text-fg-faint transition-transform duration-200', open && 'rotate-180')}
                />
                <span className="shrink-0 rounded border border-veil/10 bg-veil/5 px-1.5 py-[1px] text-[10.5px] text-fg-faint">
                  {s.categoryName}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg-soft">{s.chapterName}</span>
                <span className="shrink-0 text-[11.5px] tabular text-fg-faint">
                  {s.items.length} 条{mustN > 0 ? ` · 必背 ${mustN}` : ''}
                </span>
              </button>

              {open && (
                <div className="border-t border-hairline">
                  {groupRuns(s.items).map((g) => (
                    <div key={g.name}>
                      <div className="flex items-center gap-2 bg-veil/3 px-4 py-1.5">
                        <span className="text-[11px] font-medium tracking-wide text-cyan/80">{g.name}</span>
                        <span className="h-px flex-1 bg-hairline" />
                        <span className="text-[10.5px] tabular text-fg-faint">{g.items.length}</span>
                      </div>
                      <div className="divide-y divide-veil/5">
                        {g.items.map((f) => (
                          <FormulaCard
                            key={f.id}
                            f={f}
                            open={demoId === f.id}
                            onToggle={() => setDemoId((v) => (v === f.id ? '' : f.id))}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          );
        })
      )}
    </div>
  );
}

/** 章内按 group 再切一次连续段 —— 一张「表」一个标题 */
function groupRuns(items: Formula[]) {
  const out: { name: string; items: Formula[] }[] = [];
  for (const f of items) {
    const last = out[out.length - 1];
    if (last && last.name === f.group) last.items.push(f);
    else out.push({ name: f.group, items: [f] });
  }
  return out;
}

function FormulaCard({ f, open, onToggle }: { f: Formula; open: boolean; onToggle: () => void }) {
  const ms = f.mastery ? MASTERY_STYLE[f.mastery] : null;
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {f.must === 1 && (
          <span className="flex shrink-0 items-center gap-1 rounded border border-amber/35 bg-amber/10 px-1.5 py-[1px] text-[10px] text-amber-200/95">
            <Star size={9} /> 必背
          </span>
        )}
        <span className="text-[12.5px] font-medium text-fg-soft">{f.name}</span>
        <span className="flex-1" />
        {/* 「动手」—— 查公式时最想做的事就是看看它长什么样，
            所以按钮就在卡片上，不用切 tab 再搜一遍。 */}
        <button
          onClick={onToggle}
          data-demo-toggle={f.id}
          aria-expanded={open}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-lg border px-2 py-[3px] text-[11px] transition-colors',
            open
              ? 'border-violet/45 bg-violet/12 text-violet-100'
              : 'border-hairline bg-veil/4 text-fg-mute hover:border-violet/35 hover:text-fg-soft',
          )}
        >
          <Play size={9} /> {open ? '收起' : '动手'}
        </button>
        {/* 挂回考点。掌握状态的小圆点用的是和知识树同一套色，
            这样「这条公式我学没学过」不用点进去就知道。 */}
        {f.kid && (
          <Link
            to={`/learn/${f.kid}`}
            className="group flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-veil/4 px-2 py-[3px] text-[11px] text-fg-mute transition-colors hover:border-cyan/35 hover:text-fg-soft"
          >
            {ms && <span className={cn('h-1.5 w-1.5 rounded-full', ms.dot)} />}
            <span className="max-w-[160px] truncate">{f.kidTitle}</span>
            <ArrowUpRight size={10} className="transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-veil/8 bg-veil/3 px-3.5 py-2.5 text-center">
        <InlineMath text={`$$${f.tex}$$`} />
      </div>

      {(f.cond || f.note) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
          {f.cond && (
            <span className="text-[11.5px] leading-relaxed text-fg-mute">
              条件 <InlineMath text={`$${f.cond}$`} className="text-amber-200/90" />
            </span>
          )}
          {f.note && (
            <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-fg-faint">{f.note}</span>
          )}
        </div>
      )}

      {open && (
        <div className="mt-3 border-t border-veil/8 pt-3">
          <FormulaDemo formula={f} compact />
        </div>
      )}
    </div>
  );
}
