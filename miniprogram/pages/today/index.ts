/* 今日
 *
 * 这一屏只回答一个问题：**现在该做什么**。
 *
 * 所以视觉层次是固定的三层，不随数据变化：
 *   1. 一句招呼 + 日期          —— 定位「今天」
 *   2. 待复习张数（最大字号）    —— 唯一的行动号召
 *   3. 今日一练                  —— 备选动作
 *
 * ★ 为什么待复习数字用 76rpx 而等级/XP 只用 22rpx：
 *   手机上同一屏能突出一个重点。如果等级、XP、连击、待复习都是大字号，
 *   用户扫一眼什么都记不住 —— 而复习队列才是他真正要做的事。
 *
 * ★ 公式渲染是异步的，但**不阻塞上面的数字**。
 *   先出数字再出题干，比等两个都好了再一起出要快得多 ——
 *   服务端首次渲染一个公式要几十毫秒，弱网下更久。
 */

import { fetchDue, fetchDaily, fetchStats, renderTexts, type Segment } from '../../api/index';

interface QuizItem {
  id: string;
  typeLabel: string;
  difficulty: number;
  stem: string;
}

/** 难度点：5 颗，按 difficulty 点亮。比写「难度 3」直观。 */
/* 难度点。返回对象而不是布尔数组 —— wxml 的 wx:key 需要唯一值，
 * 布尔数组里 [true, true, false...] 有重复，会触发「key 重复」告警。
 * 加一个 i 字段当 key，顺便让「第几颗」在模板里可读。 */
function dots(n: number): { i: number; on: boolean }[] {
  const d = Math.max(0, Math.min(5, Number(n) || 0));
  return [1, 2, 3, 4, 5].map((i) => ({ i, on: i <= d }));
}

/* ---------- 一周热力图 ----------
 *
 * ★ 为什么要自己补齐 7 天，而不是直接 slice(-7)：
 *   stats.heatmap 是「有记录的那些天」，不是连续日期。一个人隔了三天没学，
 *   那个数组里就没有那三天 —— 直接取末 7 条会把两周前的一天画进「本周」。
 *   所以按日历生成 7 个格子，再从 map 里查当天有没有数据。
 */
interface HeatDay {
  key: string;
  label: string;
  n: number;
  /** 柱高百分比（0-100）。按本周最大值归一，最少 6% 保证空的那天也有个底 */
  h: number;
  today: boolean;
}

function last7Days(heatmap: { date: string; n: number }[]): HeatDay[] {
  const map = new Map((heatmap || []).map((d) => [d.date, d.n]));
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const raw: { key: string; label: string; n: number; today: boolean }[] = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
    raw.push({ key, label: WEEK[d.getDay()], n: map.get(key) || 0, today: i === 0 });
  }

  /* ★ 柱高按「本周最大值」归一，而不是按固定上限（比如 50 题）。
   *   固定上限的问题是：一个每天做 8 题的人，七根柱子都是 16% 高，
   *   看上去像七根一样的小棍 —— 他这周的努力在图上完全看不见。
   *   按周内最大值归一，8 题和 12 题的差别才显出来。
   *   全周都是 0 时用 1 兜底，避免除零。 */
  const max = Math.max(1, ...raw.map((d) => d.n));
  return raw.map((d) => ({
    ...d,
    /* 最少 6% —— 那天没学也要留一个底座，否则整根消失，
     * 看起来像「这格坏了」而不是「这天没学」。 */
    h: d.n === 0 ? 6 : Math.max(12, Math.round((d.n / max) * 100)),
  }));
}

/** 三科掌握度。color 由服务端给，但那是给 Web 端深色用的暗色，
 *  在这里太暗（2.01:1），所以按 id 映射到提亮版 —— 见 wxss 的 .cat-*。 */
interface CatRow {
  id: string;
  name: string;
  pct: number;
}

function catRows(radar: any[]): CatRow[] {
  return (radar || []).map((r) => ({
    id: r.id,
    name: String(r.name || '').replace('与数理统计', ''),
    pct: Math.max(0, Math.min(100, Number(r.accuracy) || 0)),
  }));
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function todayText(): string {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${week}`;
}

Page({
  data: {
    loading: true,
    needLogin: false,

    greeting: '',
    dateText: '',

    notice: null as any,
    maintenance: null as any,

    /* 学习状态 */
    streak: 0,
    xp: 0,
    levelTitle: '',
    levelPct: 0,
    levelInto: 0,
    levelNeed: 100,
    due: 0,
    /** 今天已经做了多少题（来自热力图的最后一格） */
    todayDone: 0,
    /** 今日复习进度：已完成 / 应完成（已完成 + 还到期） */
    reviewDone: 0,
    reviewTotal: 0,
    /** 环形进度百分比 */
    reviewPct: 0,

    /* 一周热力图 */
    heat: [] as HeatDay[],

    /* 三科掌握度 */
    cats: [] as CatRow[],

    /* 今日一练 */
    quiz: null as QuizItem | null,
    quizSegs: [] as Segment[],
    quizDots: [] as { i: number; on: boolean }[],

    features: {} as Record<string, boolean>,
  },

  async onShow() {
    const app = getApp<any>();
    const cfg = app.globalData.config || {};

    this.setData({ greeting: greeting(), dateText: todayText() });

    const ok = await app.ensureLogin();
    if (!ok) {
      this.setData({ loading: false, needLogin: true });
      return;
    }

    this.setData({
      notice: cfg.notice && cfg.notice.on ? cfg.notice : null,
      maintenance: cfg.maintenance && cfg.maintenance.on ? cfg.maintenance : null,
      features: cfg.features || {},
      needLogin: false,
    });

    await this.load();
  },

  async load() {
    this.setData({ loading: true });

    /* 三个请求并发 —— 它们之间没有依赖，串行发在弱网下能到两三秒。 */
    const [stats, due, daily] = await Promise.all([
      fetchStats().catch(() => null),
      fetchDue().catch(() => null),
      fetchDaily().catch(() => null),
    ]);

    const snap = (stats && (stats.snapshot || stats)) || {};
    const lv = snap.levelInfo || {};
    const quiz = (daily && daily.quiz && daily.quiz[0]) || null;

    /* 这两个模块的数据服务端一直在返回，但页面以前只用了 snapshot 里那几个数。
     * 结果就是一屏只有一个大数字 —— 数据都在，画面上什么都没有。 */
    const heat = last7Days((stats && stats.heatmap) || []);
    const cats = catRows((stats && stats.radar) || []);

    /* 今日复习进度 = 已完成 / (已完成 + 还到期)。
     * ★ 分母不是「固定目标 20 张」：那样 due 只有 3 张的人永远停在 15%，
     *   而 due 有 60 张的人从 0 开始掉——两种人都看不到「今天快做完了」。
     *   用「已完成 + 还到期」当分母，进度永远从 0 走到 100。 */
    const reviewDone = (daily && daily.review && Array.isArray(daily.review.done))
      ? daily.review.done.length : 0;
    const reviewTotal = reviewDone + ((due && due.count) || 0);
    const reviewPct = reviewTotal > 0 ? Math.round((reviewDone / reviewTotal) * 100) : 0;

    this.setData({
      loading: false,
      streak: snap.streak || 0,
      xp: snap.xp || 0,
      levelTitle: snap.title || lv.title || '',
      levelPct: Math.max(0, Math.min(100, Number(lv.pct) || 0)),
      levelInto: Number(lv.into) || 0,
      levelNeed: Number(lv.need) || 100,
      due: (due && due.count) || 0,
      todayDone: heat.length ? heat[heat.length - 1].n : 0,
      reviewDone,
      reviewTotal,
      reviewPct,
      heat,
      cats,
      quiz: quiz
        ? { id: quiz.id, typeLabel: quiz.typeLabel, difficulty: quiz.difficulty, stem: quiz.stem }
        : null,
      quizDots: quiz ? dots(quiz.difficulty) : [],
      quizSegs: [],
    });

    /* 题干单独渲，不阻塞上面已经出来的数字。 */
    if (quiz && quiz.stem) {
      try {
        const [segs] = await renderTexts([quiz.stem]);
        this.setData({ quizSegs: segs || [] });
      } catch {
        /* 渲染失败退化成纯文本：公式看不到，但题还在 ——
         * 比整张卡片空着好。 */
        this.setData({ quizSegs: [{ type: 'text', v: quiz.stem } as any] });
      }
    }
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  goReview() {
    wx.switchTab({ url: '/pages/review/index' });
  },

  goLogin() {
    wx.reLaunch({ url: '/pages/login/index' });
  },

  /**
   * 做今日一练。
   *
   * ★ 直接进答题页，不经过题库列表。原来这里是 switchTab 到题库 ——
   *   用户点「去做题」的意图非常明确，再让他在列表里找一遍那道题，
   *   等于把一次点击变成两次，而且他还得认出哪道是今日一练。
   */
  startQuiz() {
    const q = this.data.quiz;
    if (!q) return;
    wx.navigateTo({ url: `/pages/answer/index?qid=${encodeURIComponent(q.id)}` });
  },

  /** 去题库。零卡态没有今日一练时的兜底入口。 */
  goQuiz() {
    wx.switchTab({ url: '/pages/quiz/index' });
  },
});
