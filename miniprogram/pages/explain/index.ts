/* AI 讲解（待实现）
 *
 * 走 POST /api/ai/explain，返回纯文本（含 LaTeX）。
 * 拿到文本后走 renderTexts 切段，再用 math-text 渲染 ——
 * 和题干同一条链路，不另起一套。
 *
 * ★ 这个接口会扣每日 AI 配额（服务端统一 Key 模式下）。
 *   配额用尽时服务端返回 code=QUOTA_EXCEEDED 并带回余量，
 *   前端据此把入口置灰，而不是让用户点一次被拒一次。
 */
Page({
  data: {
    text: '',
    segs: [] as any[],
    error: '',
  },
});
