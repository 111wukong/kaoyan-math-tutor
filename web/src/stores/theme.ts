/* 主题 store
 *
 * ── 三处状态，优先级从高到低 ─────────────────────────────────────
 *   1. <html data-theme> —— 真正的生效点。CSS 认它。
 *   2. localStorage     —— 首屏缓存。让「刷新页面」不会先闪一下默认主题。
 *   3. 服务端 user_settings.theme —— 权威值。换设备、换浏览器都跟着走。
 *
 * 顺序：启动时先用 localStorage 立刻应用（同步，渲染之前），
 * 登录后拉到服务端的值再覆盖一次。两条来源不一致时以服务端为准 ——
 * 因为「我在 A 电脑选了宣纸」应该跟到 B 电脑上。
 *
 * ── 为什么应用主题要写成独立的纯函数 ─────────────────────────────
 * 因为 index.html 里那段防闪脚本需要同样的逻辑，但它跑在 bundle 之前，
 * 引不到这个模块。两边必须做同样的事（设 data-theme / data-mode /
 * color-scheme），改一处要记得改另一处。
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import { DEFAULT_THEME, THEME_STORAGE_KEY, themeOf, type ThemeDef } from '@/lib/themes';

export interface ThemeState {
  id: string;
  theme: ThemeDef;
  /** 是否已经从服务端拿到过权威值。没拿到之前不要往服务端回写。 */
  synced: boolean;
  setTheme: (id: string, opts?: { persist?: boolean }) => void;
  /** 从服务端拉一次并应用。登录后调用。 */
  loadFromServer: () => Promise<void>;
  /** 退出登录时回到默认主题（下一个用户不该继承上一个人的外观）。 */
  reset: () => void;
}

/** 把主题落到 DOM 上。纯函数，幂等，可在 React 之外调用。 */
export function applyTheme(id: string): ThemeDef {
  const t = themeOf(id);
  if (typeof document === 'undefined') return t;
  const el = document.documentElement;
  el.dataset.theme = t.id;
  el.dataset.mode = t.mode;
  /* color-scheme 决定浏览器自带的控件（滚动条、date picker、表单自动填充）
   * 走深色还是浅色。不设的话亮色主题下日期选择器会是黑的。 */
  el.style.colorScheme = t.mode;
  /* ★ 清掉首屏防闪那段内联脚本留下的**行内 background**。
   *
   * index.html 里那段脚本为了让"CSS 还没加载"的那一帧不闪白，
   * 会给 <html> 写一个行内 background。但行内样式的优先级**高于样式表**，
   * 不清掉的话 `html { background: var(--color-ink-950) }` 永远被压住 ——
   * 页面底色会被钉死在启动那一刻的值上，切主题时其它颜色都变了、
   * 唯独底色不变（实测踩过：切成宣纸后 data-theme 对了、令牌对了、
   * 正文变深了，就是背景还是近黑）。
   *
   * 清掉是安全的：模块在 main.tsx 第一行被 import，那时 <link> 样式表
   * 已经应用（CSS 是渲染阻塞的），所以不会有"中间空一帧"的窗口。
   * #boot 那层用 --boot-bg（下面那行设的），不受影响。 */
  el.style.removeProperty('background');
  /* 移动端浏览器地址栏配色 */
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.preview[0]);
  return t;
}

/** 读本地缓存。首屏用。 */
export function readCachedTheme(): string {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v && themeOf(v).id === v ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function cacheTheme(id: string) {
  try { localStorage.setItem(THEME_STORAGE_KEY, id); } catch { /* 隐私模式下写不进去，无所谓 */ }
}

/* ★ 初始状态必须从**本地缓存**推出来，不能写死默认主题。
 *
 * 写死 DEFAULT_THEME 的话，冷启动会分成两段：
 *   1. DOM 上是缓存的主题（applyTheme 已经挂好了）—— 颜色是对的；
 *   2. 但 store 里的 id/theme 还是默认主题，于是 `theme.fx` 是 true，
 *      **亮色主题下会先把赛博网格和星尘挂上**，等 loadFromServer 回来才卸掉。
 *
 * 表现是「冷启动时亮色页面闪一下霓虹背景」。实测就是这么发现的：
 * 给 8 套主题截图，亮色那三张的 canvas 数量是 2，而正确值应该是 0 ——
 * 因为截图脚本没等够时间，正好落在那个窗口里。
 *
 * 顺带一提，这个 bug 在浏览器回归测试里**测不出来**：那里的主题是点出来的，
 * store 已经被 setTheme 更新过了，不存在不同步的窗口。所以它是靠截图
 * （另一条完全不同的路径）才暴露的 —— 多一条验证路径的价值就在这。 */
const INITIAL_THEME = readCachedTheme();

export const useTheme = create<ThemeState>((set, get) => ({
  id: INITIAL_THEME,
  theme: themeOf(INITIAL_THEME),
  synced: false,

  setTheme: (id, opts = {}) => {
    const t = applyTheme(id);
    cacheTheme(t.id);
    set({ id: t.id, theme: t });
    if (opts.persist !== false) {
      /* 回写服务端。失败不打扰用户 —— 本地已经生效了，
       * 下次刷新还是对的（localStorage 记着），只是换设备同步不过去。
       * 为一个外观设置弹错误提示，代价大于收益。 */
      api.settings.update({ theme: t.id }).catch(() => { /* 静默 */ });
    }
  },

  loadFromServer: async () => {
    try {
      const { settings } = await api.settings.get();
      const id = themeOf(settings?.theme).id;
      applyTheme(id);
      cacheTheme(id);
      set({ id, theme: themeOf(id), synced: true });
    } catch {
      // 拉不到就用本地缓存的那套，不要在这里改主题
      set({ synced: true });
    }
  },

  reset: () => {
    const t = applyTheme(DEFAULT_THEME);
    set({ id: t.id, theme: t, synced: false });
  },
}));

/* 启动即应用本地缓存。
 * 放在模块顶层而不是 React effect 里：模块在 main.tsx 的第一行被 import，
 * 这行执行时 React 还没渲染 —— 也就是说页面第一次绘制就是对的颜色，
 * 不会出现「先深色再跳成浅色」。 */
applyTheme(readCachedTheme());

/** 当前模式（暗/亮）。给需要按模式分支的组件用。 */
export function currentMode(): 'dark' | 'light' {
  return useTheme.getState().theme.mode;
}
