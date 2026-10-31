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
      confirmColor: '#f87171',
      success: (r) => {
        if (!r.confirm) return;
        clearToken();
        wx.reLaunch({ url: '/pages/login/index' });
      },
    });
  },
});
