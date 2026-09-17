import { create } from 'zustand';
import { api, type Snapshot } from '@/lib/api';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error' | 'xp' | 'achievement';
  title: string;
  desc?: string;
  /** 成就/升级这类需要多停一会儿 */
  ttl?: number;
}

interface AppState {
  /** 全局学情快照。侧栏等级条、顶栏连续天数都读它，避免每个组件各自拉一遍。 */
  snapshot: Snapshot | null;
  snapshotLoading: boolean;
  refreshSnapshot: (track?: string) => Promise<void>;

  toasts: Toast[];
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;

  /** 音效开关（本地偏好，不进服务端） */
  sfx: boolean;
  toggleSfx: () => void;

  /** 侧栏（移动端抽屉） */
  navOpen: boolean;
  setNavOpen: (v: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  snapshot: null,
  snapshotLoading: false,

  refreshSnapshot: async (track = 'math1') => {
    set({ snapshotLoading: true });
    try {
      const { snapshot } = await api.study.snapshot(track);
      set({ snapshot, snapshotLoading: false });
    } catch {
      set({ snapshotLoading: false });
    }
  },

  toasts: [],
  pushToast: (t) => {
    const id = Math.random().toString(36).slice(2);
    const ttl = t.ttl ?? (t.kind === 'achievement' || t.kind === 'xp' ? 4200 : 2800);
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-5) }));
    setTimeout(() => get().dismissToast(id), ttl);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  sfx: localStorage.getItem('yanshu:sfx') !== '0',
  toggleSfx: () => {
    const next = !get().sfx;
    localStorage.setItem('yanshu:sfx', next ? '1' : '0');
    set({ sfx: next });
  },

  navOpen: false,
  setNavOpen: (v) => set({ navOpen: v }),
}));
