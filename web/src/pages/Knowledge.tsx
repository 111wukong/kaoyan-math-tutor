import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, ChevronRight, Circle, LayoutList, Lock, Network, Orbit, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Panel, Skeleton, Badge, Segmented, EmptyState } from '@/components/ui/Primitives';
import { Meter } from '@/components/fx/Motion';
import { HudPanel } from '@/components/fx/Hud';
import { KnowledgeGalaxy } from '@/components/fx/KnowledgeGalaxy';
import { cn, pct, DIFFICULTY, MASTERY_STYLE } from '@/lib/utils';

const TRACKS = [
  { value: 'math1', label: '数学一' },
  { value: 'math2', label: '数学二' },
  { value: 'math3', label: '数学三' },
] as const;

export default function Knowledge() {
  const [track, setTrack] = useState<'math1' | 'math2' | 'math3'>('math1');
  const [query, setQuery] = useState('');
  /* 星系是"看"的入口，列表是"用"的入口。
   * 两个都要：星系负责一眼看出哪里空、哪里亮；
   * 列表负责搜索、逐条读、键盘操作。默认给星系，因为它更像这个产品。 */
  const [view, setView] = useState<'galaxy' | 'list'>('galaxy');
  const [openChapters, setOpenChapters] = useState<Record<string, boolean>>({});
  const { data, loading } = useAsync(() => api.catalog.tree(track), [track]);

  const categories = data?.categories || [];
  const mastery = data?.mastery;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories
      .map((c) => ({
        ...c,
        chapters: c.chapters
          .map((ch) => ({ ...ch, nodes: ch.nodes.filter((n) => n.title.toLowerCase().includes(q)) }))
          .filter((ch) => ch.nodes.length > 0),
      }))
      .filter((c) => c.chapters.length > 0);
  }, [categories, query]);

  const searching = query.trim().length > 0;
  /* 搜索时强制回列表 —— 星系里没法"高亮匹配项"，
   * 让人在球上找一个小圆点是折磨。 */
  const showGalaxy = view === 'galaxy' && !searching && categories.length > 0;

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[100px] rounded-2xl" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[180px] rounded-2xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 总览 */}
      <HudPanel index="NAV" tag="KNOWLEDGE MAP" sweep className="relative overflow-hidden rounded-2xl p-5">
        <div className="pointer-events-none absolute -right-20 -top-20 h-52 w-52 rounded-full bg-cyan/10 blur-[90px]" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan/25 bg-cyan/10 text-cyan">
                <Network size={18} />
              </div>
              <div>
                <h1 className="text-[18px] font-semibold tracking-tight text-fg">知识树</h1>
                <p className="mt-0.5 text-[12.5px] text-fg-mute">
                  {mastery ? `${mastery.total} 个考点 · 已学 ${mastery.learned} 个` : '加载中'}
                </p>
              </div>
            </div>

            {mastery && (
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                {([
                  ['mastered', '精通'],
                  ['proficient', '熟练'],
                  ['learning', '学习中'],
                  ['new', '未学'],
                ] as const).map(([k, label]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', MASTERY_STYLE[k].dot)} />
                    <span className="text-[12px] text-fg-mute">{label}</span>
                    <span className="font-mono text-[12.5px] font-medium text-fg-soft tabular">{mastery.dist[k] ?? 0}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col items-end gap-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Segmented value={track} onChange={setTrack} options={TRACKS.map((t) => ({ value: t.value, label: t.label }))} />
              <Segmented
                value={view}
                onChange={setView}
                size="sm"
                options={[
                  { value: 'galaxy', label: <span className="flex items-center gap-1.5"><Orbit size={12} /> 星系</span> },
                  { value: 'list', label: <span className="flex items-center gap-1.5"><LayoutList size={12} /> 列表</span> },
                ]}
              />
            </div>
            {mastery && (
              <div className="w-full min-w-[180px]">
                <div className="mb-1.5 flex justify-between text-[11.5px] text-fg-mute">
                  <span>覆盖率</span>
                  <span className="font-mono tabular">{pct(mastery.learned, mastery.total)}%</span>
                </div>
                <Meter value={pct(mastery.learned, mastery.total)} height={5} />
              </div>
            )}
          </div>
        </div>

        {/* 搜索 */}
        <div className="relative mt-4">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜考点名，比如「罗尔定理」「重要极限」"
            className="h-10 w-full rounded-xl border border-hairline bg-white/4 pl-10 pr-3.5 text-[13.5px] text-fg outline-none transition-all placeholder:text-fg-faint focus:border-cyan/45 focus:bg-white/6"
          />
        </div>
      </HudPanel>

      {/* 星系视图 */}
      {showGalaxy && (
        <HudPanel index={1} tag={`GALAXY · ${TRACKS.find((t) => t.value === track)?.label}`} corners={false} className="overflow-hidden rounded-2xl">
          <KnowledgeGalaxy categories={categories} />
        </HudPanel>
      )}

      {/* 列表视图 */}
      {!showGalaxy && (
        filtered.length === 0 ? (
          <Panel>
            <EmptyState icon={<Search size={22} />} title="没找到匹配的考点" desc={`「${query}」在${TRACKS.find((t) => t.value === track)?.label}考纲里没有匹配项。`} />
          </Panel>
        ) : (
          <div className="space-y-4">
            {filtered.map((cat) => (
              <CategoryBlock
                key={cat.id}
                cat={cat}
                openChapters={openChapters}
                setOpenChapters={setOpenChapters}
                forceOpen={searching}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

function CategoryBlock({
  cat, openChapters, setOpenChapters, forceOpen,
}: {
  cat: any;
  openChapters: Record<string, boolean>;
  setOpenChapters: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  forceOpen: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const allNodes = cat.chapters.flatMap((c: any) => c.nodes);
  const learned = allNodes.filter((n: any) => n.hasCard).length;
  const mastered = allNodes.filter((n: any) => n.mastery === 'mastered').length;

  return (
    <Panel className="overflow-hidden">
      {/* 科目头 */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-white/3"
      >
        <span
          className="h-9 w-1.5 shrink-0 rounded-full"
          style={{ background: cat.color, boxShadow: `0 0 12px -2px ${cat.color}` }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[15.5px] font-semibold tracking-tight text-fg">{cat.name}</h2>
            <span className="text-[11.5px] text-fg-mute">
              {cat.chapters.length} 章 · {allNodes.length} 考点
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <div className="w-32">
              <Meter value={pct(learned, allNodes.length)} height={3} from={cat.color} to={cat.color} />
            </div>
            <span className="text-[11.5px] text-fg-mute tabular">
              已学 {learned}/{allNodes.length}
              {mastered > 0 && <span className="ml-1.5 text-emerald-300/85">精通 {mastered}</span>}
            </span>
          </div>
        </div>
        <ChevronDown size={16} className={cn('shrink-0 text-fg-faint transition-transform duration-300', !collapsed && 'rotate-180')} />
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-hairline"
          >
            <div className="divide-y divide-white/5">
              {cat.chapters.map((ch: any) => {
                const key = ch.id;
                const open = forceOpen || openChapters[key];
                return (
                  <div key={key}>
                    <button
                      onClick={() => setOpenChapters((m) => ({ ...m, [key]: !m[key] }))}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-white/3"
                    >
                      <ChevronRight size={14} className={cn('shrink-0 text-fg-faint transition-transform duration-250', open && 'rotate-90')} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-soft">{ch.name}</span>
                      {ch.lit && (
                        <Badge tone="emerald" className="shrink-0">
                          <Circle size={7} fill="currentColor" /> 已点亮
                        </Badge>
                      )}
                      <span className="shrink-0 text-[11.5px] text-fg-mute tabular">{ch.mastered}/{ch.total}</span>
                    </button>

                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                          className="overflow-hidden bg-ink-900/40"
                        >
                          <div className="space-y-1 px-3 py-2">
                            {ch.nodes.map((n: any) => (
                              <NodeRow key={n.id} node={n} />
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  );
}

function NodeRow({ node }: { node: any }) {
  const ms = MASTERY_STYLE[node.mastery as keyof typeof MASTERY_STYLE] || MASTERY_STYLE.new;
  const diff = DIFFICULTY[node.difficulty] || DIFFICULTY[2];
  return (
    <Link
      to={`/learn/${node.id}`}
      className="group flex items-center gap-3 rounded-xl px-3 py-2 transition-all duration-200 hover:bg-white/5"
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', ms.dot)} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-soft transition-colors group-hover:text-fg">
        {node.title}
      </span>
      <span className={cn('shrink-0 rounded border px-1.5 py-px text-[10.5px]', diff.cls)}>{diff.label}</span>
      <span className={cn('shrink-0 rounded border px-1.5 py-px text-[10.5px]', ms.cls)}>{ms.label}</span>
      {node.attempts > 0 && (
        <span className="hidden shrink-0 text-[11px] text-fg-faint tabular sm:block">
          {Math.round(node.accuracy * 100)}%
        </span>
      )}
      <ChevronRight size={13} className="shrink-0 text-fg-faint transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  );
}

export { Lock };
