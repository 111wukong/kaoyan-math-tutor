/* 考点目录 —— 侧栏里的可展开目录树
 *
 * ── 为什么要有它 ─────────────────────────────────────────────────
 * 原来的侧栏是 14 个「页面」的平铺入口，缺的是「内容」这一层：
 * 想直接跳到「洛必达法则」，得先进知识树、展开章节、再往下找。
 * 目录补的就是这一段 —— 68 个考点全部可以直接点到，
 * 而且当前所在的那个考点会自动高亮、自动展开它所在的章节。
 *
 * ── 默认收起 ────────────────────────────────────────────────────
 * 展开后有 19 个章节 / 68 个考点，默认摊开会把侧栏挤爆，
 * 把原来那 14 个入口挤到看不见。所以默认收起，展开状态记在本地。
 *
 * ── 数据来源是共享缓存 ──────────────────────────────────────────
 * 用的 key 和知识树、课堂、AI 对话完全一样（catalog.tree:math1），
 * 所以这里拉过一次之后，那几个页面切过去是零等待 —— 反过来也一样。
 */
import { useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronRight, ListTree, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { cn } from '@/lib/utils';

const OPEN_KEY = 'yanshu:nav:topics';

export function TopicDirectory() {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === '1');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { pathname } = useLocation();

  /* 五分钟新鲜期：目录是**目录**，考点标题和章节归属几乎不变，
   * 没必要每次切页都去问一遍服务端。 */
  const tree = useAsync(() => api.catalog.tree('math1'), [], {
    key: 'catalog.tree:math1',
    staleTime: 5 * 60_000,
  });

  /* 当前正在看的考点（/learn/c1n1 → c1n1）。用来高亮 + 自动展开所属章节。 */
  const currentKid = pathname.startsWith('/learn/') ? pathname.slice('/learn/'.length) : '';

  const flat = useMemo(() => {
    const out: { id: string; title: string; chapterId: string; chapterName: string; category: string }[] = [];
    tree.data?.categories.forEach((c) => {
      c.chapters.forEach((ch) => {
        ch.nodes.forEach((n) => out.push({
          id: n.id, title: n.title, chapterId: ch.id, chapterName: ch.name, category: c.name,
        }));
      });
    });
    return out;
  }, [tree.data]);

  /* 搜索是「先找再看」：不搜索时按科目/章节分层，搜索时拍平成一张列表。
   * 分层视图在 68 个节点下没法用来找东西，搜索视图才是有用的那个。 */
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return flat
      .filter((n) => n.title.toLowerCase().includes(s) || n.chapterName.toLowerCase().includes(s))
      .slice(0, 40);
  }, [flat, q]);

  /* 当前考点所在的章节自动展开 —— 不展开的话，用户从知识树点进来，
   * 目录里看不出自己站在哪，得手动一层层找。 */
  const autoOpen = useMemo(() => {
    const hit = flat.find((n) => n.id === currentKid);
    return hit ? hit.chapterId : '';
  }, [flat, currentKid]);

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(OPEN_KEY, v ? '0' : '1');
      return !v;
    });
  };

  return (
    <nav aria-label="考点目录" className="mb-1">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-[9px] text-[13px] text-fg-mute transition-colors hover:bg-veil/5 hover:text-fg-soft"
      >
        <ListTree size={16} className="shrink-0 text-fg-mute" />
        <span className="flex-1 text-left font-medium">考点目录</span>
        {tree.data && (
          <span className="text-[10.5px] tabular text-fg-faint">{flat.length}</span>
        )}
        <ChevronRight
          size={13}
          className={cn('shrink-0 text-fg-faint transition-transform duration-200', open && 'rotate-90')}
        />
      </button>

      {open && (
        <div className="mt-1 rounded-xl border border-hairline bg-veil/3 p-1.5">
          <div className="relative mb-1.5">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="搜索考点"
              placeholder="搜考点…"
              className="h-7 w-full rounded-lg border border-hairline bg-ink-850 pl-7 pr-2 text-[12px] text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-cyan/40"
            />
          </div>

          {tree.loading && !tree.data ? (
            <div className="space-y-1 px-1 py-1">
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-5 rounded-md" />)}
            </div>
          ) : q.trim() ? (
            <DirList
              items={hits.map((h) => ({ id: h.id, title: h.title, sub: h.chapterName }))}
              empty="没有匹配的考点"
            />
          ) : (
            <div className="max-h-[42vh] overflow-y-auto pr-0.5">
              {tree.data?.categories.map((c) => (
                <div key={c.id} className="mb-1">
                  <div className="px-1.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-faint">
                    {c.name}
                  </div>
                  {c.chapters.map((ch) => {
                    const on = expanded[ch.id] || ch.id === autoOpen;
                    const hasCurrent = ch.nodes.some((n) => n.id === currentKid);
                    return (
                      <div key={ch.id}>
                        <button
                          onClick={() => setExpanded((m) => ({ ...m, [ch.id]: !on }))}
                          aria-expanded={on}
                          className={cn(
                            'flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-veil/5',
                            hasCurrent ? 'text-fg-soft' : 'text-fg-mute',
                          )}
                        >
                          <ChevronRight
                            size={11}
                            className={cn('shrink-0 text-fg-faint transition-transform duration-200', on && 'rotate-90')}
                          />
                          <span className="min-w-0 flex-1 truncate">{ch.name}</span>
                          <span className="shrink-0 text-[10px] tabular text-fg-faint">{ch.nodes.length}</span>
                        </button>
                        {on && (
                          <div className="ml-2.5 border-l border-hairline pl-1.5">
                            {ch.nodes.map((n) => (
                              <DirLink key={n.id} id={n.id} title={n.title} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

/** 一个考点。用 NavLink 而不是 Link：`end` 能让 /learn 与 /learn/c1n1 的高亮互不串味。 */
function DirLink({ id, title, sub }: { id: string; title: string; sub?: string }) {
  return (
    <NavLink
      to={`/learn/${id}`}
      className={({ isActive }) => cn(
        'block truncate rounded-lg px-2 py-[5px] text-[12px] transition-colors',
        isActive ? 'bg-cyan/12 text-cyan-100' : 'text-fg-mute hover:bg-veil/5 hover:text-fg-soft',
      )}
      title={sub ? `${title} · ${sub}` : title}
    >
      {title}
    </NavLink>
  );
}

function DirList({ items, empty }: { items: { id: string; title: string; sub: string }[]; empty: string }) {
  if (!items.length) return <p className="px-2 py-3 text-[11.5px] text-fg-faint">{empty}</p>;
  return (
    <div className="max-h-[42vh] overflow-y-auto pr-0.5">
      {items.map((n) => <DirLink key={n.id} id={n.id} title={n.title} sub={n.sub} />)}
    </div>
  );
}
