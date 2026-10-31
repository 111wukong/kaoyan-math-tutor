/* 题库
 *
 * 列表 + 就地展开，不做「列表 → 详情页」。
 *
 * ★ 为什么不进详情页：
 *   手机上多一次跳转就多一次返回，看一道题的解析要「点进去 → 看 →
 *   返回」，连续看五道就是十五次操作。就地展开把这条路径压成一次点击。
 *   真正需要独立页面的只有「作答」（要计时、要判分、要记 XP），
 *   而那是下一步的事。
 *
 * ★ 公式分两批渲：
 *   列表只渲题干（20 条一次请求），展开时才渲选项 + 答案。
 *   一次把 20 道题的选项全渲了是 100+ 条，既慢又白渲 ——
 *   用户一次只看一道。
 */

import { fetchQuestions, renderTexts, type Segment } from '../../api/index';

interface Q {
  id: string;
  kid: string;
  type: string;
  typeLabel: string;
  difficulty: number;
  stem: string;
  options: { k: string; t: string }[] | null;
  answer?: string;
  analysis?: string;
  selfGraded?: boolean;
}

interface Row extends Q {
  segs: Segment[];
  dots: boolean[];
  open: boolean;
  optSegs: Segment[];
  ansSegs: Segment[];
  rendering: boolean;
}

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'choice', label: '单选' },
  { key: 'blank', label: '填空' },
  { key: 'solve', label: '解答' },
  { key: 'proof', label: '证明' },
];

const PAGE_SIZE = 20;

/* 难度点。返回对象而不是布尔数组 —— wxml 的 wx:key 需要唯一值，
 * 布尔数组里 [true, true, false...] 有重复，会触发「key 重复」告警。
 * 加一个 i 字段当 key，顺便让「第几颗」在模板里可读。 */
function dots(n: number): { i: number; on: boolean }[] {
  const d = Math.max(0, Math.min(5, Number(n) || 0));
  return [1, 2, 3, 4, 5].map((i) => ({ i, on: i <= d }));
}

Page({
  data: {
    loading: true,
    needLogin: false,
    error: '',

    filters: FILTERS,
    filter: 'all',
    rows: [] as Row[],
    total: 0,
  },

  /** 原始题目缓存。切换筛选时不必重新请求 —— 数据就那么多，
   *  在本地过滤比往返一次快得多，而且切换是高频动作。 */
  all: [] as Q[],

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
      const r = await fetchQuestions({ limit: 60 });
      const list = ((r as any).questions || []) as Q[];
      this.all = list;
      this.setData({ loading: false, total: list.length });
      await this.applyFilter('all');
    } catch (e: any) {
      this.setData({ loading: false, error: (e && e.message) || '加载失败' });
    }
  },

  async applyFilter(key: string) {
    const picked = key === 'all' ? this.all : this.all.filter((q) => q.type === key);
    const slice = picked.slice(0, PAGE_SIZE);

    this.setData({
      filter: key,
      rows: slice.map((q) => ({
        ...q,
        segs: [],
        dots: dots(q.difficulty),
        open: false,
        optSegs: [],
        ansSegs: [],
        rendering: true,
      })),
    });

    /* 一次请求渲完这一屏的题干 */
    try {
      const segs = await renderTexts(slice.map((q) => q.stem));
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
    const key = e.currentTarget.dataset.key;
    if (key === this.data.filter) return;
    this.applyFilter(key);
  },

  /** 展开/收起。展开时才去渲选项和答案。 */
  async onToggle(e: any) {
    const idx = Number(e.currentTarget.dataset.idx);
    const row = this.data.rows[idx];
    if (!row) return;

    const rows = this.data.rows.slice();
    rows[idx] = { ...row, open: !row.open };
    this.setData({ rows });

    if (!row.open && !row.ansSegs.length) {
      const texts: string[] = [];
      const optCount = row.options ? row.options.length : 0;
      if (row.options) row.options.forEach((o) => texts.push(o.t));
      texts.push([row.answer, row.analysis].filter(Boolean).join('\n\n') || '（这道题没有存答案）');

      try {
        const segs = await renderTexts(texts);
        const rows2 = this.data.rows.slice();
        rows2[idx] = {
          ...rows2[idx],
          optSegs: segs.slice(0, optCount),
          ansSegs: segs[optCount] || [],
        };
        this.setData({ rows: rows2 });
      } catch {
        const rows2 = this.data.rows.slice();
        rows2[idx] = {
          ...rows2[idx],
          ansSegs: [{ type: 'text', v: row.answer || '' } as any],
        };
        this.setData({ rows: rows2 });
      }
    }
  },

  goLogin() {
    wx.reLaunch({ url: '/pages/login/index' });
  },

  onPullDownRefresh() {
    this.all = [];
    this.load().then(() => wx.stopPullDownRefresh());
  },
});
