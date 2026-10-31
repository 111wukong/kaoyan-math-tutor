/* 复习队列
 *
 * 这是整个小程序**最重要的一屏**。FSRS 的到期队列，一次一张卡。
 *
 * ── 三条交互决定 ────────────────────────────────────────────────
 * 1. **一屏一张卡**，不做「列表 + 点进去」。复习是肌肉记忆式的动作，
 *    多一次点击就多一次放弃的机会。
 *
 * 2. **答案默认收起**。这是 FSRS 的前提：先自己回忆，再对答案。
 *    一进来就看到答案，等于没复习 —— 大脑不会去检索，记忆不会形成。
 *
 * 3. **四档评分放在屏幕底部**，按钮够大。那是拇指区，单手可及。
 *
 * ── 为什么评分后不弹 toast ─────────────────────────────────────
 * 一次复习 30 秒，一晚上几十次。每次弹一个「已记录」就是几十次打断。
 * 进度条自己会动，那就是最好的反馈。
 */

import { fetchDue, gradeCard, renderTexts, type Segment } from '../../api/index';

interface Card {
  id: number;
  type: string;
  knowledgeId: string;
  kidTitle: string | null;
  content: string | null;
  stem: string | null;
  answer: string | null;
  analysis: string | null;
  due: string;
  interval: number;
  reps: number;
  retrievability: number | null;
}

/** 四档评分。文案不直译 again/hard/good/easy ——
 *  「重来/困难/良好/简单」中文用户看不出区别，
 *  所以每一档都补了一句它到底意味着什么。 */
const RATINGS = [
  { rating: 1, label: '忘了', hint: '没印象', cls: 'r1' },
  { rating: 2, label: '模糊', hint: '想起一点', cls: 'r2' },
  { rating: 3, label: '记得', hint: '正常回忆', cls: 'r3' },
  { rating: 4, label: '很熟', hint: '一眼就会', cls: 'r4' },
];

Page({
  data: {
    loading: true,
    needLogin: false,
    error: '',

    cards: [] as Card[],
    idx: 0,
    total: 0,
    revealed: false,
    done: 0,

    frontSegs: [] as Segment[],
    backSegs: [] as Segment[],
    rendering: false,
    grading: false,

    ratings: RATINGS,
    recallPct: 0,
    hasRecall: false,
    /** 当前卡片的考点名 */
    kidTitle: '',
    /** 进度百分比，喂给顶部进度条 */
    pct: 0,
  },

  async onShow() {
    const app = getApp<any>();
    const ok = await app.ensureLogin();
    if (!ok) {
      this.setData({ loading: false, needLogin: true });
      return;
    }
    /* 已有队列时不要重拉 —— 切到别的 tab 再切回来，
     * 队列应该还在原处，而不是从头开始。 */
    if (this.data.cards.length && this.data.idx < this.data.cards.length) return;

    await this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const r = await fetchDue();
      const cards = (r.cards || []) as Card[];
      this.setData({
        loading: false,
        cards,
        total: cards.length,
        idx: 0,
        done: 0,
        revealed: false,
        pct: 0,
      });
      await this.renderCurrent();
    } catch (e: any) {
      this.setData({ loading: false, error: (e && e.message) || '加载失败' });
    }
  },

  /** 渲染当前卡的正反面。一次请求把两段都渲了 —— 展开时就不用再等。 */
  async renderCurrent() {
    const card = this.data.cards[this.data.idx];
    if (!card) return;

    const front = card.content || card.stem || '';
    const back = [card.answer, card.analysis].filter(Boolean).join('\n\n');
    const r = card.retrievability;

    this.setData({
      rendering: true,
      frontSegs: [],
      backSegs: [],
      kidTitle: card.kidTitle || '',
      hasRecall: typeof r === 'number' && r >= 0,
      recallPct: typeof r === 'number' ? Math.round(Math.max(0, Math.min(1, r)) * 100) : 0,
      pct: this.data.total ? Math.round((this.data.idx / this.data.total) * 100) : 0,
    });

    try {
      const [f, b] = await renderTexts([front, back]);
      this.setData({
        rendering: false,
        frontSegs: f || [{ type: 'text', v: front }],
        backSegs: b || [],
      });
    } catch {
      /* 渲染失败退化成纯文本。公式看不到，但复习还能继续 ——
       * 不能因为一张图挂了就卡住整个队列。 */
      this.setData({
        rendering: false,
        frontSegs: [{ type: 'text', v: front } as any],
        backSegs: back ? [{ type: 'text', v: back } as any] : [],
      });
    }
  },

  onReveal() {
    if (this.data.revealed) return;
    this.setData({ revealed: true });
  },

  async onGrade(e: any) {
    if (this.data.grading || !this.data.revealed) return;

    const rating = Number(e.currentTarget.dataset.rating);
    const card = this.data.cards[this.data.idx];
    if (!card) return;

    this.setData({ grading: true });
    try {
      await gradeCard(card.id, rating as 1 | 2 | 3 | 4);

      const next = this.data.idx + 1;
      const finished = next >= this.data.cards.length;

      this.setData({
        grading: false,
        idx: next,
        done: this.data.done + 1,
        revealed: false,
        frontSegs: [],
        backSegs: [],
        pct: this.data.total ? Math.round((next / this.data.total) * 100) : 100,
        /* 队列跑完就清空，下次进来自动重拉 */
        cards: finished ? [] : this.data.cards,
      });

      if (!finished) await this.renderCurrent();
    } catch (err: any) {
      this.setData({ grading: false });
      wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
    }
  },

  onRestart() {
    this.setData({ cards: [], idx: 0, done: 0, total: 0 });
    this.load();
  },

  goLogin() {
    wx.reLaunch({ url: '/pages/login/index' });
  },

  onPullDownRefresh() {
    this.setData({ cards: [] });
    this.load().then(() => wx.stopPullDownRefresh());
  },
});
