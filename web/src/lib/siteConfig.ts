import { useEffect, useState } from 'react';

/* ============================================================
   站点配置（公开）
   ============================================================
   注册开关是**服务端**决定的（`REGISTRATION_ENABLED`），前端要据此决定
   是显示注册表单，还是显示「本站已关闭注册」。

   为什么要专门拉一次：让人填完一整张表、点了提交才被 403 顶回来，
   是很糟的体验 —— 而且那种失败看起来像「系统坏了」，不像「不允许」。

   缓存住是因为登录页和注册页都要用，而它在一个会话里不会变。
   ============================================================ */

let cached: Promise<boolean> | null = null;

function fetchRegistrationOpen(): Promise<boolean> {
  if (!cached) {
    cached = fetch('/api/auth/config', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.registrationEnabled !== false)
      /* 拿不到就按「开着」处理。
       * 两个方向都有代价，但这个方向的代价更小：按「关着」处理会让
       * 本来能注册的人看不到入口，而且他没有任何办法绕过去；
       * 按「开着」处理最坏是显示一个提交后被拒的链接 —— 用户至少
       * 能从服务端的 403 文案里知道原因。 */
      .catch(() => true);
  }
  return cached;
}

/** 注册是否开放。首帧乐观地返回 true，拿到真实值后再切换。 */
export function useRegistrationOpen(): boolean {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    void fetchRegistrationOpen().then((v) => { if (alive) setOpen(v); });
    return () => { alive = false; };
  }, []);

  return open;
}
