/* 卡片读写
 *
 * ── 为什么单独抽一个文件 ──────────────────────────────────────────
 * INSERT 的列清单原来在四处重复（新建卡、知识树建卡、导入恢复、手动建卡），
 * 加 FSRS 三列时要改四处。这种「加一列改 N 处」的结构迟早漏一处，
 * 而漏了不会报错 —— 只会静默丢数据，等用户发现时已经跑了几百次复习。
 *
 * 统一到这里之后，以后加列只改这一个文件。
 */

const INSERT_SQL = `INSERT INTO cards
  (id,user_id,type,knowledge_id,question_id,due,interval,state,stability,difficulty,reps,ef,lapses,last_review,created_at)
  VALUES (@id,@userId,@type,@knowledgeId,@questionId,@due,@interval,@state,@stability,@difficulty,@reps,@ef,@lapses,@lastReview,@createdAt)`;

/* ef 已经不再参与调度（SM-2 遗留），但保留在 UPDATE 里会让「导出的老包
 * 再导回来」时把这个字段丢掉。索性写死不动它 —— 更新时根本不该碰。 */
const UPDATE_SQL = `UPDATE cards SET
  due=@due, interval=@interval, state=@state, stability=@stability, difficulty=@difficulty,
  reps=@reps, lapses=@lapses, last_review=@lastReview
  WHERE id=@id AND user_id=@userId`;

/** 新卡入库。card 由 fsrs.js 的 newCard() 产生。 */
export function insertCard(db, userId, card) {
  db.prepare(INSERT_SQL).run({
    id: card.id,
    userId,
    type: card.type || 'knowledge',
    knowledgeId: card.knowledgeId ?? null,
    questionId: card.questionId ?? null,
    due: card.due,
    interval: card.interval ?? 0,
    state: card.state || 'new',
    stability: card.stability ?? null,
    difficulty: card.difficulty ?? null,
    reps: card.reps ?? 0,
    ef: card.ef ?? 2.5,
    lapses: card.lapses ?? 0,
    lastReview: card.lastReview ?? null,
    createdAt: card.createdAt,
  });
}

/** 复习后的调度更新。next 由 fsrs.js 的 grade() 产生。 */
export function updateCardSchedule(db, userId, cardId, next) {
  db.prepare(UPDATE_SQL).run({
    id: cardId,
    userId,
    due: next.due,
    interval: next.interval,
    state: next.state,
    stability: next.stability ?? null,
    difficulty: next.difficulty ?? null,
    reps: next.reps,
    lapses: next.lapses,
    lastReview: next.lastReview,
  });
}

/**
 * 把导出包里的卡（snake_case）转成 insertCard 认的形状。
 *
 * 老导出包没有 FSRS 三列 —— 按 reps/interval 反推一个初始状态，
 * 否则导回来会全变成「新卡」，用户几百次复习记录等于白存。
 */
export function cardFromExport(c) {
  const reps = c.reps || 0;
  return {
    id: c.id,
    type: c.type || 'knowledge',
    knowledgeId: c.knowledge_id ?? null,
    questionId: c.question_id ?? null,
    due: c.due,
    interval: c.interval ?? 0,
    state: c.state || (reps > 0 ? 'review' : 'new'),
    stability: c.stability ?? ((c.interval || 0) > 0 ? Number(c.interval) : null),
    difficulty: c.difficulty ?? ((c.interval || 0) > 0 ? 5 : null),
    reps,
    ef: c.ef ?? 2.5,
    lapses: c.lapses ?? 0,
    lastReview: c.last_review ?? null,
    createdAt: c.created_at,
  };
}
