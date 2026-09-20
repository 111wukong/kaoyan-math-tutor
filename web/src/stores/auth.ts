import { create } from 'zustand';
import { api, UNAUTHORIZED_EVENT, type User } from '@/lib/api';
import { clearAsyncCache } from '@/lib/hooks';
import { useTheme } from '@/stores/theme';

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

/* 外观是跟着账号走的（存在服务端 user_settings.theme）。
 * 所以「登录成功」和「拿到会话」之后都要拉一次 —— 换设备登录时
 * 外观会跟着过来，而不是停在本地缓存的那套。
 *
 * 拉取失败不阻塞登录：外观拉不到最多是配色不对，不该让用户登不进来。
 * loadFromServer 内部已经吞掉了异常。 */
function syncTheme() {
  void useTheme.getState().loadFromServer();
}

/* 数据缓存（lib/hooks.ts）是**模块级**的，跟账号无关。
 * 所以换账号时不清它，B 登入后会直接看到 A 的错题本和统计 ——
 * 那是跨账号的数据泄漏，不是"缓存没刷新"。
 * 登录、注册、登出、以及任何一次 401，四个口子都要清。 */
function dropCache() {
  clearAsyncCache();
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,

  setUser: (u) => set({ user: u }),

  refresh: async () => {
    try {
      const { user } = await api.auth.me();
      set({ user, ready: true });
      syncTheme();
    } catch {
      set({ user: null, ready: true });
      dropCache();
    }
  },

  login: async (email, password) => {
    dropCache();
    const { user } = await api.auth.login(email, password);
    set({ user, ready: true });
    syncTheme();
  },

  register: async (email, username, password) => {
    dropCache();
    const { user } = await api.auth.register(email, username, password);
    set({ user, ready: true });
    syncTheme();
  },

  logout: async () => {
    try { await api.auth.logout(); } finally {
      set({ user: null });
      dropCache();
      /* 退回默认主题。
       * 不这么做的话，A 用户选了宣纸 → 登出 → B 用户登入前的这段空白里，
       * 页面上还是 A 的配色；如果 B 的主题接口又恰好失败，B 就会一直用着
       * A 的外观。外观是个人偏好，不该跨账号泄漏。 */
      useTheme.getState().reset();
    }
  },
}));

// 任何接口返回 401 都统一登出，避免每个页面各自处理
window.addEventListener(UNAUTHORIZED_EVENT, () => {
  if (useAuth.getState().user) {
    useAuth.setState({ user: null });
    dropCache();
  }
});
