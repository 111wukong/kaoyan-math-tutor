/* 小程序端接口封装
 *
 * 和 Web 端的 web/src/lib/api.ts 是同一批接口的两种写法。
 * 这里只封装小程序**真的会用到**的那些 —— 不做全量镜像，
 * 因为用不到的接口封装了也不会被调用，只会变成需要维护的死代码。
 *
 * 公式渲染相关的两个接口是这里独有的：Web 端用 KaTeX 在浏览器里
 * 直接渲染，小程序没有 DOM，只能让服务端出图。
 */

import { BASE_URL, INK } from '../config';
import { get, post } from './request';

/* ---------- 启动配置 ---------- */

export interface AppNotice { on: boolean; title: string; body: string; level: 'info' | 'warn' }

export interface AppConfig {
  version: { latest: string; min: string; note: string };
  notice: AppNotice;
  maintenance: { on: boolean; message: string };
  features: Record<string, boolean>;
  bank: { version: number; baseUrl: string; renderedAt: string };
  push: { on: boolean; templateId: string; hour: number; page: string };
  study: { dailyNew: number; reviewCap: number };
  ai: { available: boolean; mode: 'server' | 'byok' };
  serverTime: string;
  pushHour: number;
}

export const fetchConfig = () => get<AppConfig>('/api/app/config');

export interface MeResponse {
  user: { id: number; email: string; username: string; avatarHue: number; role: string };
  quota: { day: string; limit: number; used: number; remaining: number | null };
  config: AppConfig;
}

export const fetchMe = () => get<MeResponse>('/api/app/me');

/* ---------- 公式渲染 ----------
 *
 * 服务端返回的是相对路径（/math/abc.png），这里补成绝对地址。
 * 补全放在这一层而不是让每个页面自己拼：漏拼一个就是一张空白图，
 * 而空白图不会报错，只会「看起来这道题没有公式」。
 */

export interface MathSegment {
  type: 'math';
  tex: string;
  display: boolean;
  key: string;
  /** 绝对地址。渲染失败时为空串 */
  url: string;
  w: number;
  h: number;
  error?: string;
  /** 渲染失败时的原文，前端当普通文字显示 */
  fallback?: string;
}

export interface TextSegment { type: 'text'; v: string }

export type Segment = MathSegment | TextSegment;

function absolutize(seg: Segment): Segment {
  if (seg.type !== 'math') return seg;
  if (!seg.url) return seg;
  return { ...seg, url: seg.url.startsWith('http') ? seg.url : `${BASE_URL}${seg.url}` };
}

/**
 * 把一批含 $...$ 的文本切成「文字段 + 公式图」。
 *
 * ★ 一次请求渲一批，而不是一句一个请求。
 *   一道题有题干 + 4 个选项 + 解析，就是 6 条文本、十几处公式。
 *   逐条发请求在 3G 下能等好几秒，而且每一条都要过一次网络往返。
 *
 * ★ color 要传当前主题的前景色。服务端按它光栅化，并在缓存键里
 *   带着它 —— 深色主题传深墨色会渲染出一张「透明底黑字」的图，
 *   在深色卡片上等于看不见。见 config.ts 的 INK 注释。
 */
export async function renderTexts(texts: string[], color = INK): Promise<Segment[][]> {
  if (!texts.length) return [];
  const r = await post<{ results: { segments: Segment[]; hasMath: boolean }[] }>(
    '/api/render/text',
    { texts: texts.map((text) => ({ text })), color, format: 'png' },
  );
  return r.results.map((x) => x.segments.map(absolutize));
}

/** 单条文本的便捷版本（复习卡片上大量使用）。 */
export async function renderText(text: string, color = INK): Promise<Segment[]> {
  const [segs] = await renderTexts([text], color);
  return segs || [{ type: 'text', v: text }];
}

/* ---------- 学习数据 ----------
 * 这些都是 Web 端已有的接口，返回结构完全一致 —— 两端的 TS 类型
 * 可以直接对照着抄，不需要另写一套。 */

export const fetchDue = () => get<{ cards: any[]; total: number }>('/api/cards/due');
export const fetchDaily = () => get<any>('/api/study/daily');
export const fetchStats = () => get<any>('/api/study/stats');
export const fetchMistakes = (limit = 20) => get<any>(`/api/study/mistakes?limit=${limit}`);
export const fetchTree = () => get<any>('/api/catalog/tree');
export const fetchQuestions = (params: Record<string, string | number> = {}) => {
  const qs = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined)
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
  return get<{ questions: any[]; total: number }>(`/api/catalog/questions?${qs}`);
};

/** 提交一次作答。这是唯一记账的入口 —— XP、掌握度、错题本都走它。 */
export const submitAnswer = (body: {
  qid: string;
  answer: string;
  /** 解答 / 证明题没有自动判分，由用户自评 */
  selfCorrect?: boolean;
  seconds?: number;
}) => post<any>('/api/study/answer', body);

/** 复习卡片的四档评分（FSRS） */
export const gradeCard = (cardId: string | number, rating: 1 | 2 | 3 | 4) =>
  post<any>(`/api/cards/${cardId}/grade`, { rating });

/* ---------- AI ---------- */

export const aiExplain = (qid: string) => post<{ ok: boolean; text: string; model: string }>('/api/ai/explain', { qid });

/**
 * AI 批改（解答 / 证明题）。
 *
 * ★ 这个接口**不写库**，只返回分数和评语。真正的记账仍然走
 *   submitAnswer(..., selfCorrect) —— 用户可以不接受 AI 的判分。
 *   所以界面上必须有「接受 / 改判」两个按钮，不能自动提交。
 */
export const aiGrade = (qid: string, answer: string) => post<any>('/api/ai/grade', { qid, answer });

/* ---------- 订阅消息 ---------- */

/** 调起订阅授权，然后把结果回报给服务端记额度。 */
export function requestSubscribe(templateId: string): Promise<{ ok: boolean; granted: boolean }> {
  return new Promise((resolve) => {
    if (!templateId) return resolve({ ok: false, granted: false });
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (r: any) => {
        const accepted = r[templateId] === 'accept';
        post('/api/app/subscribe', { templateId, accepted })
          .then(() => resolve({ ok: true, granted: accepted }))
          .catch(() => resolve({ ok: false, granted: accepted }));
      },
      /* 用户点「取消」也会走 fail —— 这不是错误，只是没授权。
       * 当成错误弹 toast 会让用户莫名其妙。 */
      fail: () => resolve({ ok: false, granted: false }),
    });
  });
}
