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

    /* 今日一练 */
    quiz: null as QuizItem | null,
    quizSegs: [] as Segment[],
    quizDots: [] as boolean[],

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

    this.setData({
      loading: false,
      streak: snap.streak || 0,
      xp: snap.xp || 0,
      levelTitle: snap.title || lv.title || '',
      levelPct: Math.max(0, Math.min(100, Number(lv.pct) || 0)),
      levelInto: Number(lv.into) || 0,
      levelNeed: Number(lv.need) || 100,
      due: (due && due.count) || 0,
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

  startQuiz() {
    if (!this.data.quiz) return;
    wx.switchTab({ url: '/pages/quiz/index' });
  },
});
