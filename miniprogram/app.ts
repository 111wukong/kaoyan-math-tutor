/* 小程序入口
 *
 * 启动顺序是刻意安排的：
 *   1. 拉配置（公开接口，不需要登录）—— 决定公告、维护模式、功能开关
 *   2. 有 token 就拉 /api/app/me —— 拿用户和配额
 *   3. 都没有就跳登录页
 *
 * ★ 为什么先拉配置再判断登录：
 *   维护模式、强制更新这些事和「有没有登录」无关。如果先等登录，
 *   一个正在维护的站点会先让用户走完登录流程，再告诉他「在维护」。
 *
 * ★ 为什么不在 app 里做「未登录就 reLaunch 到登录页」：
 *   小程序的 onLaunch 早于页面 onLoad，在这里 reLaunch 会和首页的
 *   首次渲染抢时序，表现是白屏闪一下。改成由各页面的 onShow 调
 *   ensureLogin() —— 谁需要登录谁负责，也更符合「只有部分页面需要登录」。
 */

import { fetchConfig, fetchMe, type AppConfig } from './api/index';
import { getToken, clearToken } from './api/request';

interface GlobalData {
  config: AppConfig | null;
  me: { user: any; quota: any } | null;
  /** 配置是否已经拉过。页面 onShow 里据此决定要不要等 */
  ready: boolean;
}

App<{ globalData: GlobalData; ensureLogin: () => Promise<boolean>; loadConfig: () => Promise<void> }>({
  globalData: {
    config: null,
    me: null,
    ready: false,
  },

  onLaunch() {
    this.loadConfig();
  },

  /** 拉一次启动配置。失败不抛 —— 离线或服务端挂了时，页面应该还能
   *  显示上次缓存的配置，而不是白屏。 */
  async loadConfig() {
    try {
      const cfg = await fetchConfig();
      this.globalData.config = cfg;

      /* 配置缓存到本地：下次冷启动先用手上这份渲染，网络回来再更新。
       * 这是「打开就能看到内容」而不是「先转圈」的关键。 */
      try { wx.setStorageSync('yanshu_config', cfg); } catch { /* 忽略 */ }
    } catch {
      try {
        const cached = wx.getStorageSync('yanshu_config');
        if (cached) this.globalData.config = cached;
      } catch { /* 忽略 */ }
    } finally {
      this.globalData.ready = true;
    }
  },

  /**
   * 确保已登录。已登录返回 true；需要登录时跳登录页并返回 false。
   *
   * 只清 token 不弹错误：token 失效是正常的（30 天到期、管理员强制下线），
   * 对用户来说就是「重新进一下」，不该看到红色报错。
   */
  async ensureLogin(): Promise<boolean> {
    if (!getToken()) return false;

    try {
      const me = await fetchMe();
      this.globalData.me = { user: me.user, quota: me.quota };
      /* 顺带用最新配置覆盖一次：登录接口也会返回 config，
       * 这样「改完配置马上生效」在已登录用户身上是立即的。 */
      if (me.config) this.globalData.config = me.config;
      return true;
    } catch (e: any) {
      if (e && e.status === 401) clearToken();
      return false;
    }
  },
});
