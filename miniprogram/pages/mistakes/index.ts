/* 错题本
 *
 * ── 为什么它值得单独一个 tab ────────────────────────────────────
 * 刷题类 App 里错题本几乎是标配，原因很实在：**错的题才是要花时间的地方**。
 * 做对的题只是验证，做错的题暴露的是知识缺口。
 *
 * 我们这个 App 有两套「回头看」的机制，别搞混：
 *   · 复习队列（复习 tab）—— 按**考点**排的 FSRS 卡片，问的是
 *     「这个知识点你还记得吗」；
 *   · 错题本（这一页）—— 按**题目**排，问的是「这道题你还会错吗」。
 *   前者是记忆，后者是解题。两个都需要。
 *
 * ── 为什么就地展开，不做详情页 ──────────────────────────────────
 * 看错题是扫读行为：快速翻十道，看看自己都在哪些地方栽跟头。
 * 每道都点进详情再返回，十道就是二十次跳转 —— 没人会这么用。
 * 展开后直接给「我的答案 vs 正确答案」的对照，一眼看出差在哪。
 */

import { fetchMistakes, renderTexts, type Mistake, type Segment } from '../../api/index';

interface Row extends Mistake {
  segs: Segment[];
  optSegs: Segment[][];
  ansSegs: Segment[];
  anaSegs: Segment[];
  stepSegs: Segment[][];
  stepPts: number[];
  open: boolean;
  rendering: boolean;
}

const PAGE_LIMIT = 40;

Page({
  data: {
    loading: true,
    needLogin: false,
    error: '',

    rows: [] as Row[],
    total: 0,

    /** 考点筛选。all = 不筛 */
    filter: 'all',
    chips: [] as { kid: string; title: string; n: number }[],
  },

  /** 原始数据缓存。切换考点筛选时不必重新请求。 */
  all: [] as Mistake[],

  async onShow() {
    const app = getApp<any>();
    const ok = await app.ensureLogin();
    if (!ok) {
      this.setData({ loading: false, needLogin: true });
      return;
    }
    if (this.all.length) return;
    await this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const r = await fetchMistakes({ limit: PAGE_LIMIT });
      this.all = r.mistakes || [];

      /* byKid 是「考点 → 错题数」。要按数量倒序 —— 错得最多的考点
       * 排最前面，那才是用户最该点开的。 */
      const chips = Object.entries(r.byKid || {})
        .map(([kid, n]) => {
          const hit = this.all.find((m) => m.kid === kid);
          return { kid, title: (hit && hit.kidTitle) || kid, n: Number(n) };
        })
        .sort((a, b) => b.n - a.n);

      this.setData({ loading: false, total: r.total || 0, chips, filter: 'all' });
      await this.applyFilter('all');
    } catch (e: any) {
      this.setData({ loading: false, error: (e && e.message) || '加载失败' });
    }
  },

  async applyFilter(kid: string) {
    const picked = kid === 'all' ? this.all : this.all.filter((m) => m.kid === kid);

    this.setData({
      filter: kid,
      rows: picked.map((m) => ({
        ...m,
        segs: [],
        optSegs: [],
        ansSegs: [],
        anaSegs: [],
        stepSegs: [],
        stepPts: [],
        open: false,
        rendering: true,
      })),
    });

    /* 一次请求渲完这一屏的题干。错题本的题干几乎都带公式，
     * 逐条请求在弱网下会一条条跳出来，观感很差。 */
    try {
      const segs = await renderTexts(picked.map((m) => m.stem));
      const rows = this.data.rows.map((row, i) => ({
        ...row,
        segs: segs[i] || [{ type: 'text', v: row.stem } as any],
        rendering: false,
      }));
      this.setData({ rows });
    } catch {
      const rows = this.data.rows.map((row) => ({
        ...row,
        segs: [{ type: 'text', v: row.stem } as any],
        rendering: false,
      }));
      this.setData({ rows });
    }
  },

  onFilter(e: any) {
    const kid = e.currentTarget.dataset.kid;
    if (kid === this.data.filter) return;
    this.applyFilter(kid);
  },

  /** 展开/收起。展开时才渲选项、答案、解析 —— 一次全渲是白渲。 */
  async onToggle(e: any) {
    const idx = Number(e.currentTarget.dataset.idx);
    const row = this.data.rows[idx];
    if (!row) return;

    const rows = this.data.rows.slice();
    rows[idx] = { ...row, open: !row.open };
    this.setData({ rows });

    if (row.open || row.ansSegs.length) return;

    const texts: string[] = [];
    const optCount = row.options ? row.options.length : 0;
    if (row.options) row.options.forEach((o) => texts.push(o.t));
    texts.push(row.answer || '');
    texts.push(row.analysis || '');
    const steps = row.steps || [];
    steps.forEach((s) => texts.push(s.t));

    try {
      const segs = await renderTexts(texts);
      const rows2 = this.data.rows.slice();
      rows2[idx] = {
        ...rows2[idx],
        optSegs: segs.slice(0, optCount),
        ansSegs: segs[optCount] || [],
        anaSegs: segs[optCount + 1] || [],
        stepSegs: segs.slice(optCount + 2),
        stepPts: steps.map((s) => s.pts),
      };
      this.setData({ rows: rows2 });
    } catch {
      const rows2 = this.data.rows.slice();
      rows2[idx] = {
        ...rows2[idx],
        ansSegs: [{ type: 'text', v: row.answer || '' } as any],
        anaSegs: row.analysis ? [{ type: 'text', v: row.analysis } as any] : [],
      };
      this.setData({ rows: rows2 });
    }
  },

  /** 重做这道题。把下一道错题一起带过去 —— 答完可以直接「下一题」，
   *  不用回列表再点一次。 */
  onRedo(e: any) {
    const idx = Number(e.currentTarget.dataset.idx);
    const row = this.data.rows[idx];
    if (!row) return;
    /* 把后面所有错题的 id 一起带过去，答题页就能一路「下一题」做下去。
     * 题目 id 都很短（q01 / q133），二十个也就一百多个字符，URL 扛得住。 */
    const rest = this.data.rows.slice(idx + 1).map((r) => r.qid);
    const q = [
      `qid=${encodeURIComponent(row.qid)}`,
      `pos=${idx + 1}`,
      `total=${this.data.rows.length}`,
      rest.length ? `rest=${encodeURIComponent(rest.join(','))}` : '',
    ].filter(Boolean).join('&');
    wx.navigateTo({ url: `/pages/answer/index?${q}` });
  },

  goQuiz() {
    wx.switchTab({ url: '/pages/quiz/index' });
  },

  goLogin() {
    wx.reLaunch({ url: '/pages/login/index' });
  },

  onPullDownRefresh() {
    this.all = [];
    this.load().then(() => wx.stopPullDownRefresh());
  },
});
