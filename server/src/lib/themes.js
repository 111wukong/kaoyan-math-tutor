/* 主题 id 白名单（服务端）
 *
 * ── 为什么服务端也要有一份 ────────────────────────────────────────
 * 前端当然有完整的外观定义（颜色、明暗、要不要挂 WebGL 背景），
 * 但那是**渲染**需要的信息。服务端需要的是**校验**：
 * 如果 PUT /api/settings 收下任意字符串，库里就会攒下
 * `theme = "<script>"` 这类脏值，而且前端每次都得自己兜底。
 * 与其在两端各写一遍兜底，不如在入口就把非法值挡掉。
 *
 * ⚠️ 这份清单和 web/src/lib/themes.ts 里的注册表**必须保持一致**。
 * 两边漂移的表现是：前端能选、保存时报 400。所以两边都写了这条注释，
 * 改的时候一起改。测试里有一条断言专门盯这个（见 smoke.mjs 的「主题」节）。
 */
export const THEME_IDS = [
  /* 暗色 */
  'deep-space',
  'cyber-lime',
  'nord-frost',
  'ember',
  'midnight-rose',
  /* 亮色 */
  'paper',
  'mint',
  'solarized',
];

export const DEFAULT_THEME = 'deep-space';

/** 把任意输入收敛成合法主题 id。非法值一律落回默认，不报错。 */
export function normalizeTheme(v) {
  const s = String(v || '').trim();
  return THEME_IDS.includes(s) ? s : DEFAULT_THEME;
}

/** 亮色主题的集合 —— 前端用它决定要不要挂 WebGL 背景。 */
export const LIGHT_THEMES = new Set(['paper', 'mint', 'solarized']);
