type ClassValue = string | number | null | undefined | false | ClassValue[] | Record<string, boolean>;

/** 合并 className。自己实现，不为一个字符串拼接函数拉一个包。 */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue) => {
    if (!v) return;
    if (typeof v === 'string' || typeof v === 'number') { out.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      for (const [k, on] of Object.entries(v)) if (on) out.push(k);
    }
  };
  inputs.forEach(walk);
  return out.join(' ');
}

export function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(s: string, n: number) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return todayStr(dt);
}

export function daysBetween(a: string, b: string) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()) / 864e5);
}

/** 相对时间：刚刚 / 3 分钟前 / 昨天 / 3 天前 / 具体日期 */
export function relTime(iso: string | number | null | undefined) {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 172800e3) return '昨天';
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 百分比，保留 0 位小数 */
export function pct(v: number, total: number) {
  if (!total) return 0;
  return Math.round((v / total) * 100);
}

/** 难度 → 文案与颜色 */
export const DIFFICULTY = [
  null,
  { label: '基础', cls: 'text-emerald-300/90 border-emerald-400/25 bg-emerald-400/8' },
  { label: '常规', cls: 'text-cyan-300/90 border-cyan-400/25 bg-cyan-400/8' },
  { label: '较难', cls: 'text-amber-300/90 border-amber-400/25 bg-amber-400/8' },
  { label: '压轴', cls: 'text-rose-300/90 border-rose-400/25 bg-rose-400/8' },
] as const;

/** 掌握度 → 文案与颜色 */
export const MASTERY_STYLE = {
  new: { label: '未学', cls: 'text-fg-mute border-veil/10 bg-veil/4', dot: 'bg-veil/25' },
  learning: { label: '学习中', cls: 'text-amber-200/90 border-amber-400/25 bg-amber-400/8', dot: 'bg-amber-400' },
  proficient: { label: '熟练', cls: 'text-cyan-200/90 border-cyan-400/28 bg-cyan-400/10', dot: 'bg-cyan-400' },
  mastered: { label: '精通', cls: 'text-emerald-200/90 border-emerald-400/28 bg-emerald-400/10', dot: 'bg-emerald-400' },
} as const;

/** 成就等级配色 */
export const TIER_STYLE = {
  bronze: { ring: 'ring-amber-700/40', grad: 'from-amber-800/40 to-amber-600/10', text: 'text-amber-200' },
  silver: { ring: 'ring-slate-300/30', grad: 'from-slate-400/30 to-slate-200/5', text: 'text-slate-100' },
  gold: { ring: 'ring-yellow-400/40', grad: 'from-yellow-500/35 to-amber-300/8', text: 'text-yellow-100' },
} as const;

/** 从知识点标题生成稳定的色相，用于头像/标签配色 */
export function hueOf(str: string) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

/** 简易防抖 */
export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * 读一个 CSS 自定义属性的当前值。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 绝大部分样式走 Tailwind 工具类就够了（工具类编译成 `var(--color-x)`，
 * 换主题自动跟着变）。但有三类地方**只吃具体颜色字符串**，塞不进类名：
 *   · Recharts 的 stroke / fill / contentStyle；
 *   · canvas 2D 的 strokeStyle / fillStyle；
 *   · SVG 的 <stop stopColor>。
 * 这些地方以前写死了 rgba(255,255,255,…) —— 在深色主题下是对的，
 * 换成亮色主题就整片隐形（白线压白底）。
 *
 * ⚠️ 必须在**渲染时**调用，不能在模块顶层算成常量。
 * 模块顶层的值在 import 那一刻就固化了，之后切主题不会更新 ——
 * 表现是「切了主题，图表网格还是老颜色」。
 * 需要跟着主题重算的组件，把 useTheme(s => s.id) 放进 deps 里。
 */
export function cssVar(name: string, fallback = ''): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 复制到剪贴板（带降级） */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}
