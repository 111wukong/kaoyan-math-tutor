import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

/* ============================================================
   数据缓存 —— 切页不再"全部刷新"的第一层
   ============================================================
   原来的 useAsync 每次挂载都从 loading=true 开始，于是每切一次页面
   都是一轮「骨架屏 → 数据」的闪烁；更糟的是好几个页面要同一个接口
   （/api/catalog/tree 有四个页面在用），切过去就重拉一遍。

   现在按 key 存一份模块级缓存，规则三条：
     1. 有缓存 → 立刻显示缓存内容，**不显示骨架屏**；
     2. 缓存还新鲜（默认 30 秒内）→ 一次请求都不发；
     3. 缓存过期 → 先在屏幕上留着旧数据，新数据回来再替换（stale-while-revalidate）。
   第 3 条是关键：刷新可以有，但屏幕上不能空一下。

   key 是显式传的，不做自动推导。原因：同一个页面里可能有多个 useAsync
   （仪表盘有 4 个），自动推导要么撞 key、要么每次渲染换 key，
   两种都是难查的静默 bug。显式 key 还能**跨页面共享** ——
   知识树和课堂传同一个 'catalog.tree:math1'，第二个页面就是零等待。
   ============================================================ */

interface CacheEntry { data: unknown; ts: number }

const cache = new Map<string, CacheEntry>();

/** 默认新鲜期：这段时间内重挂载直接吃缓存，一次请求都不发 */
const DEFAULT_STALE = 30_000;

/* 缓存条数上限。
 * 不加这个的话，管理台的用户搜索是**每打一个字一个 key** ——
 * 搜十次就是十条，而且永远不会被清掉。
 * 超了淘汰最旧的（Map 保持插入顺序，所以第一个就是最旧的）。 */
const MAX_ENTRIES = 200;

function put(key: string, data: unknown) {
  /* 先删再插：让被更新的 key 挪到队尾，否则热门数据会被误当成最旧的淘汰 */
  cache.delete(key);
  cache.set(key, { data, ts: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 按路由登记的「静默重拉」回调，给 keep-alive 的页面重新激活时用 */
const registry = new Set<{ path: string; run: () => void }>();

/** 拿到缓存就直接给，没有就返回 null —— 不触发任何请求 */
function peek<T>(key?: string): T | null {
  if (!key) return null;
  return (cache.get(key)?.data as T | undefined) ?? null;
}

/**
 * 让某个路由下所有 useAsync 按新鲜度决定要不要重拉。
 *
 * 给 keep-alive 用：页面被切回来时组件并没有重新挂载，也就没有
 * 「挂载时刷新」这个时机 —— 不补这一步，用户刷完题切回错题本会看到旧数据。
 * 但也不能无脑重拉：那样「切回来不再打接口」就不成立了。
 * 所以交给每个 useAsync 自己的 revalidate 判新鲜度（见上面那条注释）。
 */
export function revalidatePath(path: string) {
  registry.forEach((e) => { if (e.path === path) e.run(); });
}

/**
 * 清空缓存。登录/登出/401 时必须调 ——
 * 缓存是模块级的、跟账号无关，A 登出后 B 登入会直接看到 A 的数据。
 * 这条不做的话就是一个跨账号的数据泄漏。
 */
export function clearAsyncCache() {
  cache.clear();
}

/** 简单的数据拉取 hook：统一 loading / error / reload 三态，外加跨页缓存 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  opts: { key?: string; staleTime?: number } = {},
) {
  const { key, staleTime = DEFAULT_STALE } = opts;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keyRef = useRef(key);
  keyRef.current = key;

  /* 初始值直接取缓存 —— 这是"不闪骨架屏"的落点。
   * loading 只在**真的没有缓存**时才为 true。 */
  const [state, setState] = useState<{ key?: string; data: T | null; loading: boolean; error: string | null }>(
    () => ({ key, data: peek<T>(key), loading: key ? !cache.has(key) : true, error: null }),
  );

  /* key 变了（比如 /learn/c1n1 → /learn/c1n2）就立刻换成新 key 的缓存。
   * 不这么做的话，切到下一个知识点时会先显示上一个的内容再被替换 ——
   * 那比骨架屏还糟，因为看起来像"内容就是错的"。
   * 在渲染期 setState 是 React 官方认可的"跟着 prop 调整 state"写法。 */
  if (state.key !== key) {
    setState({ key, data: peek<T>(key), loading: key ? !cache.has(key) : true, error: null });
  }

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /** 拉一次。silent=true 时不显示 loading，用来做后台刷新 */
  const load = useCallback(async (silent: boolean) => {
    const k = keyRef.current;
    if (!silent) setState((s) => ({ ...s, loading: s.data == null, error: null }));
    try {
      const r = await fnRef.current();
      if (!alive.current) return r;
      if (k) put(k, r);
      setState((s) => (s.key === k ? { key: k, data: r, loading: false, error: null } : s));
      return r;
    } catch (e: any) {
      if (alive.current) {
        setState((s) => (s.key === k ? { ...s, loading: false, error: e?.message || '加载失败' } : s));
      }
      return null;
    }
  }, []);

  /** 用户主动刷新（答题后、点了刷新按钮）：允许显示 loading */
  const reload = useCallback(async () => load(false), [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 后台静默刷新：屏幕上留着旧数据 */
  const refresh = useCallback(() => { void load(true); }, [load]);

  /**
   * 按新鲜度决定要不要重拉。
   *
   * ★ 这里必须判新鲜度，不能无脑 refresh ——
   *   保活的页面切回来时会调它（见 revalidatePath）。无脑重拉的话，
   *   「切回来不再打接口」就不成立了，缓存等于白做。
   *   而数据真的过期时（比如隔了几分钟回来）又必须重拉，否则看到的是陈旧的。
   */
  const revalidate = useCallback(() => {
    const c = key ? cache.get(key) : undefined;
    if (c && Date.now() - c.ts < staleTime) return;
    void load(true);
  }, [load, key, staleTime]);

  useEffect(() => {
    revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revalidate, ...deps]);

  /** 本地改数据（比如乐观更新）也要写回缓存，否则切走再切回来会退回旧值 */
  const setData = useCallback((v: T | null | ((prev: T | null) => T | null)) => {
    setState((s) => {
      const next = typeof v === 'function' ? (v as (p: T | null) => T | null)(s.data) : v;
      if (keyRef.current) put(keyRef.current, next);
      return { ...s, data: next };
    });
  }, []);

  /* 登记到路由表里，供 keep-alive 重新激活时按新鲜度决定要不要重拉 */
  const { pathname } = useLocation();
  useEffect(() => {
    const entry = { path: pathname, run: revalidate };
    registry.add(entry);
    return () => { registry.delete(entry); };
  }, [pathname, revalidate]);

  return { data: state.data, loading: state.loading, error: state.error, reload, refresh, setData };
}

/** 请求去重：同一时刻只有一个在飞，避免快速点击打爆接口 */
export function useMutex() {
  const busy = useRef(false);
  return useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    if (busy.current) return null;
    busy.current = true;
    try { return await fn(); } finally { busy.current = false; }
  }, []);
}

/** 倒计时（考试日期） */
export function useCountdown(target?: string) {
  const [info, setInfo] = useState(() => calc(target));
  useEffect(() => {
    setInfo(calc(target));
    const t = setInterval(() => setInfo(calc(target)), 60_000);
    return () => clearInterval(t);
  }, [target]);
  return info;
}

function calc(target?: string) {
  if (!target) return { days: null as number | null, label: '', urgent: false };
  const [y, m, d] = target.split('-').map(Number);
  if (!y || !m || !d) return { days: null, label: '', urgent: false };
  const end = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.max(0, Math.round((end - today) / 864e5));
  const label = days > 0 ? `${days} 天` : days === 0 ? '就是今天' : '已结束';
  return { days, label, urgent: days !== null && days <= 30 };
}
