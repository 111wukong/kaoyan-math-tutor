/* 请求层
 *
 * ── 为什么不用 cookie ─────────────────────────────────────────────
 * wx.request 有一个隐式的 cookie 容器，Set-Cookie 会被存下来并自动带上。
 * 但它不可读、不可控、清缓存就丢，401 的时候你完全看不到请求带了什么。
 * 所以小程序走显式的 Authorization: Bearer —— 服务端两条路都认
 * （见 server/src/index.js 的 readToken）。
 *
 * ── 401 的处理 ────────────────────────────────────────────────────
 * 会话 30 天有效，正常不会 401。真 401 只有三种原因：换了账号、
 * 被管理员强制下线、服务端清过 sessions 表。
 * 三种都应该「静默重登一次」而不是弹错误 —— 用户没做错任何事。
 *
 * 重登用 wx.login 拿新 code，换新 token，然后**重放原请求**。
 * 只重试一次：如果重登之后还是 401，那就是服务端配置有问题
 * （比如 WX_APPID 不对），再重试只会死循环。
 */

import { BASE_URL } from '../config';

const TOKEN_KEY = 'yanshu_token';
const USER_KEY = 'yanshu_user';

export interface ApiError extends Error {
  status: number;
  code?: string;
  /** 配额用尽时服务端会带回余量，前端据此把 AI 入口置灰 */
  quota?: { used: number; limit: number; remaining: number | null };
}

function makeError(message: string, status: number, code?: string, quota?: ApiError['quota']): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  e.code = code;
  if (quota) e.quota = quota;
  return e;
}

export function getToken(): string {
  try { return wx.getStorageSync(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setToken(token: string) {
  try { wx.setStorageSync(TOKEN_KEY, token); } catch { /* 存储满了也继续 */ }
}

export function clearToken() {
  try {
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(USER_KEY);
  } catch { /* 忽略 */ }
}

/** 微信登录，拿服务端会话 token。 */
export function wxLogin(): Promise<{ token: string; user: any; created: boolean }> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => {
        if (!r.code) return reject(makeError('微信登录失败：没有拿到 code', 0));
        wx.request({
          url: `${BASE_URL}/api/app/wx-login`,
          method: 'POST',
          data: { code: r.code },
          header: { 'Content-Type': 'application/json' },
          success: (res: any) => {
            const body = res.data || {};
            if (res.statusCode >= 200 && res.statusCode < 300 && body.token) {
              setToken(body.token);
              try { wx.setStorageSync(USER_KEY, body.user); } catch { /* 忽略 */ }
              resolve(body);
            } else {
              reject(makeError(body.error || `登录失败（${res.statusCode}）`, res.statusCode, body.code));
            }
          },
          fail: (e) => reject(makeError(`连不上服务器：${e.errMsg || ''}`, 0)),
        });
      },
      fail: () => reject(makeError('调用 wx.login 失败', 0)),
    });
  });
}

interface RequestOptions {
  /* ★ 没有 PATCH —— 小程序的 wx.request 不支持它。
   *   微信文档里 method 的合法值只有 OPTIONS / GET / HEAD / POST /
   *   PUT / DELETE / TRACE / CONNECT。写成 PATCH 的话类型能过（如果
   *   自己声明了），但运行时会被当成 GET 或直接失败 ——
   *   而那种失败在开发者工具里不一定看得出来。
   *   服务端的更新接口一律用 PUT，所以这里也不需要 PATCH。 */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: any;
  /**
   * 超时毫秒。默认 20 秒。
   *
   * ★ AI 接口必须传更长的值。服务端调模型的超时是 60 秒
   *   （见 routes/ai.js 的 LLM_TIMEOUT_MS），而客户端只有 20 秒 ——
   *   于是「AI 讲解」在模型稍慢一点时会先被客户端掐断，报「网络连接失败」，
   *   而服务端其实还在算、算完也没人要了。
   *   用户看到的是「AI 坏了」，实际只是两边的等待时间没对齐。
   */
  timeout?: number;
  /** 内部用：已经重登过就不再重登，避免死循环 */
  _retried?: boolean;
}

/**
 * 发一个请求。自动带 token，401 自动重登一次。
 *
 * 为什么返回 Promise 而不是回调：小程序原生的 success/fail 双回调
 * 会让每个调用点都写一层嵌套，async/await 写起来和 Web 端一致，
 * 两端的业务代码可以互相抄。
 */
export function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', data, timeout = 20000, _retried } = opts;
  const token = getToken();

  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}${path}`,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout,
      success: async (res: any) => {
        const body = res.data;

        if (res.statusCode === 401 && !_retried) {
          /* 静默重登一次再重放。clearToken 先清掉，否则 wxLogin 里
           * 的新 token 会被旧值覆盖的错觉 —— 实际上 setToken 会覆盖，
           * 但先清是为了「重登失败时不会留着一个已失效的 token」。 */
          clearToken();
          try {
            await wxLogin();
            resolve(await request<T>(path, { ...opts, _retried: true }));
          } catch (e) {
            reject(e);
          }
          return;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body as T);
          return;
        }

        reject(makeError(
          (body && body.error) || `请求失败（${res.statusCode}）`,
          res.statusCode,
          body && body.code,
          body && body.quota,
        ));
      },
      fail: (e) => {
        reject(makeError(`网络连接失败：${e.errMsg || ''}`, 0));
      },
    });
  });
}

export const get = <T = any>(path: string) => request<T>(path);
export const post = <T = any>(path: string, data?: any, timeout?: number) =>
  request<T>(path, { method: 'POST', data, ...(timeout ? { timeout } : {}) });
export const put = <T = any>(path: string, data?: any) => request<T>(path, { method: 'PUT', data });

/**
 * 调 AI 的请求超时。
 *
 * 必须和服务端的 LLM_TIMEOUT_MS（60 秒）对齐或更长 —— 短了的话，
 * 模型还在算、客户端已经放弃，用户看到「网络连接失败」而服务端
 * 那边其实会正常算完（额度也扣了）。
 */
export const AI_TIMEOUT = 70_000;
