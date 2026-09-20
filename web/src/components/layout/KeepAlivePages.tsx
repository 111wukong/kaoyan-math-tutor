/* 路由保活（keep-alive）
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────
 * 默认的路由切换是「卸载旧页 → 挂载新页」。带来三个用户直接能感到的后果：
 *   1. 页面里所有本地状态清零 —— 筛选条件、搜索框里打了半截的字、
 *      课堂输入框里还没发出去的那句话，切一下页面全没了；
 *   2. 滚动位置归零，从长列表中间点进详情再回来，得重新滚一遍；
 *   3. 数据重新拉一遍，屏幕闪一下骨架屏（这一半靠 lib/hooks.ts 的缓存解决）。
 * 保活解决的是前两条：页面切走时**不卸载**，只是藏起来。
 *
 * ── 怎么实现的 ───────────────────────────────────────────────────
 * 维护一个「已访问过的路由」列表，全部渲染出来，只显示当前那个，
 * 其余用 display:none 藏起来。React 不会卸载隐藏的子树，
 * 所以状态、DOM 实例、滚动都留着。
 *
 * ── 为什么每个页面还要包一层 <Routes location={…}> ───────────────
 * 隐藏的页面照样会跟着父组件重渲染。如果它们读的是**当前** location，
 * 那么在 /quiz 上待着的时候，藏在后面的课堂页会读到「没有 kid 参数」，
 * 一旦它按这个参数同步了自己的状态，切回去就发现课被清空了。
 * 所以给每个页面喂它**自己被激活时**的那个 location：
 * useParams / useSearchParams 拿到的就是它自己的值，与当前在哪一页无关。
 *
 * ── 两个必须处理的副作用 ─────────────────────────────────────────
 *   · 藏起来不等于停止工作：Canvas / rAF 类组件在 display:none 下量到
 *     尺寸为 0，切回来可能就画歪了。所以重新激活时补发一次 window.resize，
 *     让它们自己重新量（KnowledgeGalaxy 就是靠这个事件重算球半径的）。
 *   · 不重新挂载 = 没有「挂载时刷新」这个时机。所以激活时叫一次
 *     revalidatePath()，让该页的请求静默重拉一遍 —— 屏幕上留着旧数据，
 *     所以刷新过程不可见，但切回来看到的一定是新数据。
 *
 * ── 为什么滚动位置要「连续记录」而不是「切走时抓一次」 ─────────────
 * 切页时 DOM 已经换成了新页面，那一刻去读 scrollTop 拿到的是新页面的值
 * （旧页面高度没了，值被浏览器夹到 0 附近）。所以只能监听滚动事件持续记录。
 * restoreAt 是「刚恢复完的 150ms 内不记录」——
 * 不挡的话，恢复滚动自身触发的那次事件会把刚写进去的值又覆盖掉，
 * 表现为「滚动位置随机丢失」。
 *
 * ★ 滚的是 **window**，不是 #main-scroll。
 *   AppShell 里那个 <main id="main-scroll"> 并没有 overflow 和高度约束，
 *   所以它自己不滚 —— 滚动的是文档。原先 AppShell 里那句
 *   `document.getElementById('main-scroll')?.scrollTo({ top: 0 })`
 *   因此从来没生效过（一个没人发现的死代码）。这里按真实情况来。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { matchPath, Route, Routes, useLocation } from 'react-router-dom';
import { revalidatePath } from '@/lib/hooks';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export interface PageDef {
  /** 路由模式，支持 /learn/:kid 这种参数段 */
  path: string;
  node: ReactNode;
}

/** 最多保活几个页面。超了按访问顺序淘汰最旧的 ——
 *  不设上限的话，把 68 个知识点挨个点一遍就是 68 份 DOM 留在内存里。 */
const MAX_ALIVE = 10;

export function KeepAlivePages({ pages }: { pages: PageDef[] }) {
  const loc = useLocation();

  const active = pages.find((p) => matchPath({ path: p.path, end: true }, loc.pathname))?.path
    ?? pages[0].path;

  const [alive, setAlive] = useState<string[]>([active]);
  const scroll = useRef<Record<string, number>>({});
  /** 刚恢复完的这一小段时间里不要记录滚动，否则会把恢复的值覆盖掉 */
  const restoreAt = useRef(0);
  /* 每个页面最后一次被激活时的 location，给隐藏中的页面当上下文用 */
  const lastLoc = useRef<Record<string, { pathname: string; search: string }>>({});

  useEffect(() => {
    lastLoc.current[active] = { pathname: loc.pathname, search: loc.search };
  }, [active, loc.pathname, loc.search]);

  /* 挂载新页 + 淘汰最旧的 */
  useEffect(() => {
    setAlive((list) => (list.includes(active) ? list : [...list, active].slice(-MAX_ALIVE)));
  }, [active]);

  /* 连续记录当前页的滚动位置 */
  useEffect(() => {
    const onScroll = () => {
      if (Date.now() < restoreAt.current) return;
      scroll.current[active] = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [active]);

  /* 恢复滚动位置 + 让画布类组件重新量一次尺寸 */
  useLayoutEffect(() => {
    restoreAt.current = Date.now() + 150;
    window.scrollTo({ top: scroll.current[active] ?? 0, behavior: 'auto' });
    /* 补发 resize：display:none 期间 canvas 量到的是 0，
     * 不补这一下，切回知识树会看到星系缩成一团。 */
    window.dispatchEvent(new Event('resize'));
  }, [active, alive]);

  /* 页面重新出现在屏幕上 → 该页的请求静默重拉一遍 */
  useEffect(() => { revalidatePath(active); }, [active]);

  return (
    <>
      {pages.map((p) => {
        const on = p.path === active;
        const here = on ? loc : (lastLoc.current[p.path] ?? loc);
        return (
          <div
            key={p.path}
            data-page={p.path}
            data-active={on ? '1' : '0'}
            /* 用行内 display 而不是 hidden 属性：hidden 是 UA 样式，
             * 任何一条作者样式都能盖掉它，而这里的隐藏是功能性的，
             * 不能指望「没人会去覆盖它」。 */
            style={{ display: on ? 'block' : 'none' }}
          >
            {alive.includes(p.path) ? (
              /* 每个页面各自一个错误边界：保活之后，一个页面在渲染期抛异常
               * 会连累整个应用（以前它已经被卸载了，抛不出来）。
               * 关起来，坏掉的只是那一页。 */
              <ErrorBoundary>
                <Routes location={here}>
                  <Route path={p.path} element={p.node} />
                </Routes>
              </ErrorBoundary>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
