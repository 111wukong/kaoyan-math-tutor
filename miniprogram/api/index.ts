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
import { get, post, AI_TIMEOUT } from './request';

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

/* ★ 服务端返回的是 count 而不是 total（见 routes/cards.js 的
 *   `return { cards, today, count: rows.length }`）。
 *   这里曾经写成 total —— 类型和实现对不上，tsc 会报错；
 *   更糟的是它会让后来的人以为该读 .total，一改就静默变成 0。 */
export const fetchDue = () => get<{ cards: any[]; today: string; count: number }>('/api/cards/due');
export const fetchDaily = () => get<any>('/api/study/daily');
export const fetchStats = () => get<any>('/api/study/stats');
/** 错题本。返回的题带着答案、解析、评分点和「上次答的是什么」——
 *  所以这一页能就地展开讲清楚，不用再点进答题页。 */
export interface Mistake {
  qid: string;
  kid: string;
  kidTitle: string | null;
  chapterId: string | null;
  stem: string;
  type: string;
  typeLabel: string;
  selfGraded: boolean;
  options: { k: string; t: string }[] | null;
  answer: string;
  analysis: string;
  myAnswer: string | null;
  steps: { t: string; pts: number }[] | null;
  difficulty: number;
  sourceType: string;
  sourceYear: number | null;
  /** 这道题一共错了几次 / 一共做过几次 */
  wrongCount: number;
  attempts: number;
  lastAt: number;
}

export const fetchMistakes = (params: { kid?: string; limit?: number } = {}) => {
  const qs = Object.keys(params)
    .filter((k) => (params as any)[k] !== undefined && (params as any)[k] !== '')
    .map((k) => `${k}=${encodeURIComponent(String((params as any)[k]))}`)
    .join('&');
  return get<{ mistakes: Mistake[]; total: number; byKid: Record<string, number> }>(
    `/api/study/mistakes?${qs}`,
  );
};

/** 卡片队列概况。upcoming 是「未来每天有多少张到期」，用来画 7 天预测。 */
export const fetchCardSummary = () => get<{
  due: number;
  total: number;
  upcoming: { due: string; n: number }[];
  byType: { type: string; n: number }[];
  leeches: number;
  today: string;
}>('/api/cards/summary');
export const fetchTree = () => get<any>('/api/catalog/tree');
export const fetchQuestions = (params: Record<string, string | number> = {}) => {
  const qs = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined)
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
  return get<{ questions: any[]; total: number }>(`/api/catalog/questions?${qs}`);
};

/** 提交一次作答。这是唯一记账的入口 —— XP、掌握度、错题本都走它。
 *
 * ★ seconds 用来区分「记住了」和「现场推出来的」。同样答对，
 *   20 秒和 3 分钟说明的掌握程度完全不同。服务端会截断到 0~3600。 */
export const submitAnswer = (body: {
  qid: string;
  answer: string;
  /** 解答 / 证明题没有自动判分，由用户自评 */
  selfCorrect?: boolean;
  seconds?: number;
  context?: string;
}) => post<AnswerResult>('/api/study/answer', body);

export interface AnswerResult {
  /** 解答/证明题在「亮答案」那一步是 null —— 那是「还没判」，不是「答错了」 */
  correct: boolean | null;
  /** true = 这一次只是把参考答案亮出来，没有记任何账 */
  selfGrade: boolean;
  myAnswer: string;
  answer: string;
  analysis: string;
  steps: { t: string; pts: number }[] | null;
  options: { k: string; t: string }[] | null;
  stem: string;
  kid: string;
  xp: number | null;
  xpNote: string;
  combo: { combo: number; best_combo: number };
  mastery: { level: string; label: string; accuracy: number; attempts: number };
  achievements: { id: string; title: string; desc?: string }[];
}

export interface QuestionDetail {
  id: string;
  kid: string;
  type: string;
  typeLabel: string;
  selfGraded: boolean;
  difficulty: number;
  stem: string;
  options: { k: string; t: string }[] | null;
  answer?: string;
  analysis?: string;
  steps?: { t: string; pts: number }[] | null;
  source?: string;
}

export const fetchQuestion = (id: string) =>
  get<{ question: QuestionDetail; stat: { n: number; c: number; ok: number } }>(
    `/api/catalog/questions/${encodeURIComponent(id)}`,
  );

/** 复习卡片的四档评分（FSRS） */
export const gradeCard = (cardId: string | number, rating: 1 | 2 | 3 | 4) =>
  post<any>(`/api/cards/${cardId}/grade`, { rating });

/* ---------- AI ---------- */

/* AI 接口统一传 AI_TIMEOUT：服务端调模型最长 60 秒，
 * 客户端用默认的 20 秒会先断 —— 用户看到「网络失败」，
 * 而服务端其实还在算、算完也没人要了。 */
export const aiExplain = (qid: string) =>
  post<{ ok: boolean; text: string; model: string }>('/api/ai/explain', { qid }, AI_TIMEOUT);

/**
 * AI 批改（解答 / 证明题）。
 *
 * ★ 这个接口**不写库**，只返回分数和评语。真正的记账仍然走
 *   submitAnswer(..., selfCorrect) —— 用户可以不接受 AI 的判分。
 *   所以界面上必须有「接受 / 改判」两个按钮，不能自动提交。
 */
export const aiGrade = (qid: string, answer: string) =>
  post<any>('/api/ai/grade', { qid, answer }, AI_TIMEOUT);

/** 从文本中提取复习卡片。拍照识别后调用，把识别结果转成结构化卡片。 */
export const extractCards = (text: string, kid?: string) =>
  post<{ cards: { id: string; title: string; front: string; back: string; type: string }[]; raw?: string }>(
    '/api/ai/extract',
    { text, kid },
    AI_TIMEOUT,
  );

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
