import { useMemo } from 'react';
import { cssVar } from '@/lib/utils';
import { useTheme } from '@/stores/theme';
import { hexToRgb } from './webgl';

/* 背景特效层的主题色
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────
 * CyberGrid 的着色器强调色和 Starfield 的星点色相原来都是**写死的**：
 *
 *   const ACCENT: [string, string, string] = ['#22d3ee', '#3b82f6', '#a855f7'];
 *   const PALETTE = [190, 210, 265, 285];   // 青 / 蓝 / 紫 / 品红
 *
 * 只有一套主题的时候这没问题。加了主题之后就露馅了 ——
 * 切到「赛博绿」，CSS 那半边的按钮、徽章、进度条全绿了，
 * 但整页背景（赛博网格地平线）还是青蓝色。视觉上是割裂的。
 *
 * 实测就是这么发现的：给 8 套主题截图，赛博绿和深空两张几乎一模一样。
 *
 * ── 取色方式 ──────────────────────────────────────────────────────
 * 直接读 CSS 令牌，而不是在 JS 里再维护一份色板 —— 那样迟早两边漂移。
 * 主题注册表里的 preview 色板是给选择器画缩略图的，跟这里无关。
 *
 * ⚠️ 必须订阅 theme.id。着色器只在挂载时注入一次 uniform，
 * 不订阅的话「深空 → 赛博绿」这种**同为暗色**的切换不会重取颜色
 * （`theme.fx` 没变，组件不会重新挂载）。
 */

/** 兜底色板，和 index.css 里 @theme 的默认值保持一致。 */
const FALLBACK = {
  cyan: '#22d3ee',
  blue: '#3b82f6',
  violet: '#a855f7',
  magenta: '#ec4899',
};

export interface FxAccents {
  cyan: string;
  blue: string;
  violet: string;
  magenta: string;
}

/** 当前主题的四个强调色。返回的对象按主题 id 记忆化，可直接进 effect 依赖。 */
export function useFxAccents(): FxAccents {
  const themeId = useTheme((s) => s.id);
  return useMemo(() => ({
    cyan: cssVar('--color-cyan', FALLBACK.cyan),
    blue: cssVar('--color-blue', FALLBACK.blue),
    violet: cssVar('--color-violet', FALLBACK.violet),
    magenta: cssVar('--color-magenta', FALLBACK.magenta),
  }), [themeId]);
}

/**
 * canvas 专用的「主题令牌色 + 透明度」。
 *
 * ── 为什么不直接用 lib/utils 的 withAlpha ────────────────────────
 * `withAlpha` 产出的是 `color-mix(in srgb, …)`。那个东西在**内联 style、
 * SVG、Recharts** 上都没问题，但 canvas 的 `strokeStyle` / `fillStyle`
 * 对它支持得晚（Chrome 111+），而且不支持时是**静默失效** ——
 * 整条线直接消失，控制台一声不响。实测在旧内核上就是连线/曲线全没了。
 *
 * 所以这里手动把令牌值转成 rgb 三元组再拼 rgba()。代价是只认 hex 形式的
 * 令牌（`hexToRgb` 解析不了就返回白色）—— 目前 index.css 里所有强调色
 * 都是 hex，这条约束写在那边。
 *
 * ⚠️ 必须在**绘制时**调用，不能在模块顶层算成常量。
 */
export function canvasColor(name: string, alpha = 1, fallback = '#22d3ee'): string {
  const [r, g, b] = hexToRgb(cssVar(name, fallback));
  const to255 = (v: number) => Math.round(v * 255);
  return alpha >= 1
    ? `rgb(${to255(r)}, ${to255(g)}, ${to255(b)})`
    : `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${alpha})`;
}

/**
 * 十六进制 → 色相角（0–360）。Starfield 的星点是用 hsla() 上色的，
 * 只需要色相，饱和度与亮度在组件里固定。
 *
 * 非 hex 输入（比如将来有人把令牌写成 rgb()）返回 fallback，不抛错 ——
 * 背景装饰不值得为配色格式问题把整页搞崩。
 */
export function hexToHue(hex: string, fallback = 200): number {
  const s = String(hex).trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback;
  const n = Number.parseInt(full, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return fallback;           // 灰阶没有色相
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
