import { useCallback, useEffect, useRef, useState } from 'react';

/** 简单的数据拉取 hook：统一 loading / error / reload 三态 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fnRef.current();
      if (alive.current) setData(r);
      return r;
    } catch (e: any) {
      if (alive.current) setError(e?.message || '加载失败');
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload, setData };
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
