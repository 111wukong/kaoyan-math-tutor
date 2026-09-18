/* 主题注册表
 *
 * ── 职责边界（这个文件只管"有哪些主题"，不管"长什么样"）──────────
 * 真正决定颜色的是 web/src/styles/index.css 里的
 * `html[data-theme="xxx"] { --color-…: … }` 那一段。这里只存三样东西：
 *   1. id / 名称 / 一句话描述 —— 给选择器渲染用；
 *   2. mode（dark | light）—— 决定要不要挂 WebGL 背景、color-scheme 怎么设；
 *   3. preview 色板 —— 选择器上那个小缩略图。**它是手抄的**，
 *      不跟 CSS 联动。改配色时两边都要改，这是刻意的取舍：
 *      要联动就得把颜色从 CSS 搬到 JS 再运行时写进 style，
 *      代价是首屏会闪一下（JS 跑之前没有变量）。宁可手抄。
 *
 * ── 为什么颜色不写在 JS 里 ──────────────────────────────────────
 * 首屏防闪。index.html 里那段内联脚本在 bundle 之前就把 data-theme 挂上，
 * CSS 一到位颜色就对了。如果颜色由 JS 注入，用户会先看到默认主题再跳变。
 *
 * ⚠️ id 清单必须和 server/src/lib/themes.js 的 THEME_IDS 一致。
 * 两边漂移的表现是：这里能选、保存时被服务端收敛回默认（不报错，但静默失效）。
 * smoke.mjs 里有一条断言专门比对这两个清单。
 */

export type ThemeMode = 'dark' | 'light';

export interface ThemeDef {
  id: string;
  /** 选择器上的名字 */
  name: string;
  /** 一句话说明这个主题适合什么场景 */
  desc: string;
  mode: ThemeMode;
  /** 要不要挂 WebGL 赛博网格 + 星尘。亮色主题一律不挂。 */
  fx: boolean;
  /** 缩略图色板：[底, 面, 主强调, 次强调, 文字] */
  preview: [string, string, string, string, string];
}

export const DEFAULT_THEME = 'deep-space';

export const THEMES: ThemeDef[] = [
  /* ---------------- 暗色 ---------------- */
  {
    id: 'deep-space',
    name: '深空',
    desc: '青紫光谱 + 赛博网格地平线。默认主题，也是唯一带 WebGL 背景的。',
    mode: 'dark',
    fx: true,
    preview: ['#03040a', '#10151f', '#22d3ee', '#a855f7', '#e9ebf4'],
  },
  {
    id: 'cyber-lime',
    name: '赛博绿',
    desc: '磷光绿终端。长时间盯屏幕眼睛最不容易累的一套暗色。',
    mode: 'dark',
    fx: true,
    preview: ['#040a06', '#102618', '#a3e635', '#2dd4bf', '#e6f5ea'],
  },
  {
    id: 'nord-frost',
    name: '北境',
    desc: 'Nord 极地蓝灰。冷、静、低饱和，适合白天光线强的时候。',
    mode: 'dark',
    fx: true,
    preview: ['#22272f', '#434c5e', '#88c0d0', '#b48ead', '#eceff4'],
  },
  {
    id: 'ember',
    name: '熔岩',
    desc: '暖橙暗底。夜里看书不刺眼，对比度仍然够。',
    mode: 'dark',
    fx: true,
    preview: ['#0a0504', '#2f1811', '#fb923c', '#f43f5e', '#f7ece6'],
  },
  {
    id: 'midnight-rose',
    name: '午夜玫瑰',
    desc: '深紫底 + 品红强调。视觉最重的一套，适合做长时间专注块。',
    mode: 'dark',
    fx: true,
    preview: ['#08040d', '#1f132e', '#e879f9', '#a855f7', '#f1e9f7'],
  },

  /* ---------------- 亮色 ---------------- */
  {
    id: 'paper',
    name: '宣纸',
    desc: '暖白纸面 + 靛蓝强调。要打印、要投屏、白天在窗边用，选它。',
    mode: 'light',
    fx: false,
    preview: ['#faf8f4', '#ffffff', '#4f46e5', '#0e7490', '#1c1917'],
  },
  {
    id: 'mint',
    name: '薄荷',
    desc: '冷白 + 青绿。比宣纸更清爽，适合夏天和强光环境。',
    mode: 'light',
    fx: false,
    preview: ['#f2f8f6', '#ffffff', '#0d9488', '#0891b2', '#10201d'],
  },
  {
    id: 'solarized',
    name: '护眼米',
    desc: 'Solarized Light 米黄底。公认最省眼的低对比配色。',
    mode: 'light',
    fx: false,
    preview: ['#fdf6e3', '#fffdf5', '#268bd2', '#2aa198', '#073642'],
  },
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** 取主题定义。未知 id 一律落回默认 —— 不抛错。 */
export function themeOf(id: string | null | undefined): ThemeDef {
  return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_THEME)!;
}

export function isThemeId(v: unknown): boolean {
  return typeof v === 'string' && BY_ID.has(v);
}

/** 本地缓存键。存在 localStorage 里，让首屏在接口回来之前就能用对的主题。 */
export const THEME_STORAGE_KEY = 'yanshu:theme';
