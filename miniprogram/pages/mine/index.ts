/* 我的
 *
 * 三件事：
 *   1. 账号与学习状态（等级、连续天数、总 XP）
 *   2. AI 用量与订阅消息授权
 *   3. 退出登录
 *
 * ★ 配额只在「服务端统一 Key」模式下有意义。byok 模式下服务端返回
 *   limit=0（表示不限），这里要显示成「不限」而不是「0 次」——
 *   否则用户会以为自己的额度用完了。
 */

import { requestSubscribe, fetchMe, fetchStats } from '../../api/index';
import { clearToken } from '../../api/request';

Page({
  data: {
    user: null as any,
    quota: null as any,
    config: null as any,

    quotaText: '',
    quotaPct: 0,
    unlimited: false,
    pushOn: false,

    levelTitle: '',
    level: 1,
    xp: 0,
    streak: 0,
    due: 0,
    /** 头像首字 */
    initial: '',

    /* 近两周趋势 */
    trend: [] as { date: string; h: number; total: number }[],
    trendTotal: 0,
    trendPct: 0,
  },

  async onShow() {
    const app = getApp<any>();
    const ok = await app.ensureLogin();
    if (!ok) {
      wx.reLaunch({ url: '/pages/login/index' });
      return;
    }

    try {
      /* 两个请求并发：me 拿配额与配置，stats 拿学习状态。 */
      const [me, stats] = await Promise.all([
        fetchMe(),
        fetchStats().catch(() => null),
      ]);

      app.globalData.me = { user: me.user, quota: me.quota };
      app.globalData.config = me.config;

      const q = me.quota;
      const unlimited = q.limit === 0;
      const snap = (stats && ((stats as any).snapshot || stats)) || {};

      /* 近两周趋势。柱高按区间最大值归一（和今日页的「本周」同一套逻辑）：
       * 固定上限会让每天做 5 题的人整条都贴着底，看不出他在坚持。 */
      const raw = (stats && (stats as any).trend) || [];
      const tmax = Math.max(1, ...raw.map((d: any) => Number(d.total) || 0));
      const trend = raw.map((d: any) => ({
        date: d.date,
        total: Number(d.total) || 0,
        /* 没做题的那天留 4% 的底座，否则整根消失，像「这格坏了」 */
        h: Number(d.total) ? Math.max(10, Math.round((Number(d.total) / tmax) * 100)) : 4,
      }));
      const trendTotal = raw.reduce((a: number, d: any) => a + (Number(d.total) || 0), 0);
      const trendCorrect = raw.reduce((a: number, d: any) => a + (Number(d.correct) || 0), 0);

      this.setData({
        user: me.user,
        quota: q,
        config: me.config,
        pushOn: Boolean(me.config.push && me.config.push.on),
        unlimited,
        quotaText: unlimited
          ? `今日 ${q.used} 次 · 不限`
          : `今日 ${q.used} / ${q.limit} 次`,
        quotaPct: unlimited ? 0 : Math.min(100, Math.round((q.used / Math.max(1, q.limit)) * 100)),
        levelTitle: snap.title || '',
        level: snap.level || 1,
        xp: snap.xp || 0,
        streak: snap.streak || 0,
        initial: (me.user.username || '研')[0],
        trend,
        trendTotal,
        trendPct: trendTotal ? Math.round((trendCorrect / trendTotal) * 100) : 0,
      });
    } catch (e: any) {
      if (e && e.status === 401) {
        clearToken();
        wx.reLaunch({ url: '/pages/login/index' });
      }
    }
  },

  async onSubscribe() {
    const cfg = this.data.config;
    const tmpl = cfg && cfg.push && cfg.push.templateId;
    if (!tmpl) {
      wx.showToast({ title: '管理员还没配置推送模板', icon: 'none' });
      return;
    }
    const r = await requestSubscribe(tmpl);
    wx.showToast({
      title: r.granted ? '已开启一次提醒' : '没有授权',
      icon: r.granted ? 'success' : 'none',
    });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新用微信登录。学习数据不会丢。',
      confirmColor: '#d4685e',
      success: (r) => {
        if (!r.confirm) return;
        clearToken();
        wx.reLaunch({ url: '/pages/login/index' });
      },
    });
  },

  /** 进拍照识别页。 */
  onCamera(e: any) {
    const mode = e.currentTarget.dataset.mode;
    wx.navigateTo({ url: `/pages/camera/index?mode=${mode}` });
  },
});
