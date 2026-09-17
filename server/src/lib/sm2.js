/* SM-2 间隔重复调度器（原样移植自纯前端版 js/sm2.js）
 *
 * rating：1=忘了 2=吃力 3=记得 4=很熟
 * quality 映射：1->1, 2->3, 3->4, 4->5
 *
 * 日期一律用本地 'YYYY-MM-DD' 字符串：学习节奏是按"用户所在时区的今天"算的，
 * 用 UTC 会让东八区用户在晚上 8 点后复习时看到日期跳变。
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

export function addDays(base, n) {
  const d = typeof base === 'string'
    ? (() => { const [y, m, dd] = base.split('-').map(Number); return new Date(y, m - 1, dd); })()
    : new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + n);
  return fmt(d);
}

export function newCard(knowledgeId, questionId, cardType) {
  const id = 'card_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
  return {
    id,
    type: cardType || 'knowledge',
    knowledgeId: knowledgeId || null,
    questionId: questionId || null,
    ef: 2.5,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: addDays(today(), 1),
    lastReview: null,
    createdAt: today(),
  };
}

/** 四档自评 → 新的卡片状态。纯函数。 */
export function grade(card, rating) {
  const quality = rating <= 1 ? 1 : rating === 2 ? 3 : rating === 3 ? 4 : 5;
  const c = {
    ef: card.ef != null ? card.ef : 2.5,
    interval: card.interval || 0,
    reps: card.reps || 0,
    lapses: card.lapses || 0,
  };
  if (quality >= 3) {
    c.interval = c.reps === 0 ? 1 : c.reps === 1 ? 6 : Math.max(1, Math.round(c.interval * c.ef));
    c.reps += 1;
  } else {
    c.reps = 0;
    c.interval = 1;
    c.lapses += 1;
  }
  c.ef = Math.max(1.3, c.ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  return {
    ef: c.ef,
    interval: c.interval,
    reps: c.reps,
    lapses: c.lapses,
    due: addDays(today(), c.interval),
    lastReview: today(),
  };
}
