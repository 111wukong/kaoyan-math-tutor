/* 登录页
 *
 * 只有一个按钮。没有邮箱密码表单，没有验证码 ——
 * 微信小程序里让用户打字登录是最没必要的摩擦，而且他们本来
 * 就有一个微信账号。
 *
 * ★ 这里不做「账号绑定」。用邮箱注册过的老用户，第一次进小程序
 *   会拿到一个全新的微信账号，两边的学习数据不互通。
 *   解决方式是在「我的 → 账号绑定」里输入邮箱密码，把两个账号
 *   关联起来（服务端还没实现，属于下一期）。
 *   现在先把这一点在页面上说清楚，别让人以为数据丢了。
 */

import { wxLogin } from '../../api/request';

Page({
  data: {
    busy: false,
    error: '',
    from: '',
  },

  onLoad(query: any) {
    /* 登录成功后回哪一页。tabBar 页面不能用 navigateBack，
     * 所以记下来源，登录后 reLaunch 到它。 */
    this.setData({ from: (query && query.from) || '' });
  },

  async onLogin() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });

    try {
      await wxLogin();
      const app = getApp<any>();
      await app.ensureLogin();

      const from = this.data.from;
      const target = from && from.indexOf('pages/') === 0 ? from : 'pages/today/index';

      /* reLaunch 而不是 redirectTo：登录页不该留在页面栈里，
       * 否则用户在首页按返回会回到登录页 —— 而他明明已经登录了。 */
      wx.reLaunch({ url: `/${target}` });
    } catch (e: any) {
      this.setData({ busy: false, error: (e && e.message) || '登录失败' });
    }
  },
});
