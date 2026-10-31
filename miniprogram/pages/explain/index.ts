/* AI 讲解
 *
 * 走 POST /api/ai/explain，返回一段带 LaTeX 的纯文本，再用 renderTexts
 * 切段渲染 —— 和题干、解析同一条链路，不另起一套公式处理。
 *
 * ── 三类失败要分开处理 ──────────────────────────────────────────
 * 1. 配额用尽（QUOTA_EXCEEDED）—— 不是错误，是正常状态。
 *    要给「明天再来」的说明，而不是红色报错。
 * 2. 模型没配（NO_LLM）—— 是管理员的问题，不是用户的。
 *    要告诉用户「这个功能暂时不可用」，别让他以为是自己弄坏了。
 * 3. 网络/上游错误 —— 给重试按钮。
 *
 * 三种混成一句「加载失败」，用户只能反复点重试，然后放弃。
 */

import { aiExplain, renderTexts, type Segment } from '../../api/index';

Page({
  data: {
    qid: '',
    loading: true,
    segs: [] as Segment[],
    /** '' | 'quota' | 'nollm' | 'other' */
    errKind: '',
    error: '',
    quota: null as any,
  },

  onLoad(query: any) {
    const qid = (query && query.qid) || '';
    if (!qid) {
      this.setData({ loading: false, errKind: 'other', error: '没有指定题目' });
      return;
    }
    this.setData({ qid });
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '', errKind: '', segs: [] });
    try {
      const r = await aiExplain(this.data.qid);
      const text = r.text || '';

      try {
        const [segs] = await renderTexts([text]);
        this.setData({ loading: false, segs: segs || [{ type: 'text', v: text } as any] });
      } catch {
        /* 公式渲不出来就退成纯文本 —— 讲解本身比排版重要。 */
        this.setData({ loading: false, segs: [{ type: 'text', v: text } as any] });
      }
    } catch (e: any) {
      const code = e && e.code;
      if (code === 'QUOTA_EXCEEDED') {
        this.setData({ loading: false, errKind: 'quota', quota: e.quota || null, error: e.message });
      } else if (code === 'NO_LLM') {
        this.setData({ loading: false, errKind: 'nollm', error: e.message });
      } else {
        this.setData({ loading: false, errKind: 'other', error: (e && e.message) || '加载失败' });
      }
    }
  },

  onRetry() {
    this.load();
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  },
});
