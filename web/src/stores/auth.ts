import { create } from 'zustand';
import { api, UNAUTHORIZED_EVENT, type User } from '@/lib/api';

interface AuthState {
  user: User | null;
  /** 首次会话探测是否完成 —— 没完成前不要渲染路由，否则会闪一下登录页 */
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,

  setUser: (u) => set({ user: u }),

  refresh: async () => {
    try {
      const { user } = await api.auth.me();
      set({ user, ready: true });
    } catch {
      set({ user: null, ready: true });
    }
  },

  login: async (email, password) => {
    const { user } = await api.auth.login(email, password);
    set({ user, ready: true });
  },

  register: async (email, username, password) => {
    const { user } = await api.auth.register(email, username, password);
    set({ user, ready: true });
  },

  logout: async () => {
    try { await api.auth.logout(); } finally { set({ user: null }); }
  },
}));

// 任何接口返回 401 都统一登出，避免每个页面各自处理
window.addEventListener(UNAUTHORIZED_EVENT, () => {
  if (useAuth.getState().user) useAuth.setState({ user: null });
});
