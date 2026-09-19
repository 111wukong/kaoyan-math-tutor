/* 日期工具
 *
 * 日期一律用本地 'YYYY-MM-DD' 字符串：学习节奏是按「用户所在时区的今天」算的，
 * 用 UTC 会让东八区用户在晚上 8 点后复习时看到日期跳变。
 * （这个口径踩过坑，tests/day-boundary.mjs 专门盯着它。）
 *
 * 历史上这个文件叫 sm2.js，因为里面装着 SM-2 调度器。
 * 调度算法已经换成 FSRS（见 fsrs.js），SM-2 的代码删掉了 ——
 * 但文件里只剩日期函数却还叫 sm2 会误导人，所以改名。
 */

export function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function today() {
  return fmt(new Date());
}

/** 从某个日期字符串（或 Date）往后推 n 天，返回本地日期字符串。 */
export function addDays(base, n) {
  const d = typeof base === 'string'
    ? (() => { const [y, m, dd] = base.split('-').map(Number); return new Date(y, m - 1, dd); })()
    : new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + n);
  return fmt(d);
}
