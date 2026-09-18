/* API 客户端
 *
 * 约定：
 *   - 一律带 cookie（credentials: 'include'），会话靠 httpOnly cookie 维持
 *   - 失败统一抛 ApiError，带 status 与后端给的 code，方便 UI 区分「未登录」和「真出错」
 *   - 401 时广播一个事件，由 AuthStore 统一跳登录页 —— 不在每个调用点重复处理
 */

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const UNAUTHORIZED_EVENT = 'yanshu:unauthorized';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'include',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      ...init,
    });
  } catch (e) {
    throw new ApiError('网络连接失败，检查后端是否在运行', 0);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }

  if (!res.ok) {
    const err = new ApiError(body?.error || `请求失败（${res.status}）`, res.status, body?.code);
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw err;
  }
  return body as T;
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) });
const del = <T>(p: string) => request<T>(p, { method: 'DELETE' });

/* ============ 类型 ============ */
export interface User {
  id: number; email: string; username: string; avatarHue: number; createdAt: string;
  /** 'user' | 'admin'。只用于渲染（侧栏入口、路由放行），鉴权在服务端。 */
  role: 'user' | 'admin';
}

/* ---- 管理台 ---- */
export interface AdminUserStats {
  attempts: number; correct: number; wrong: number; accuracy: number;
  xp: number; level: number; levelTitle: string; bestCombo: number;
  cards: number; deckCards: number; minutes: number; activeDays: number; achievements: number;
}

export interface AdminUser {
  id: number; email: string; username: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  note: string;
  avatarHue: number;
  createdAt: string; updatedAt: string; lastLoginAt: string | null;
  stats: AdminUserStats;
  sessions?: number;
  lastSeenAt?: string | null;
}

export interface AdminOverview {
  totals: { users: number; admins: number; disabled: number; activeToday: number; neverLoggedIn: number };
  activity: {
    attempts: number; correct: number; accuracy: number; sessions: number;
    cards: number; deckCards: number; adminActions: number; dbMb: number;
  };
  recentUsers: AdminUser[];
}

export interface AdminLogEntry {
  id: number; actorId: number; actorEmail: string;
  targetId: number | null; targetEmail: string | null;
  action: string; detail: Record<string, unknown>; ip: string; at: string;
}

export interface AdminUserDetail {
  user: AdminUser;
  recentAttempts: { qid: string; kid: string; correct: number; date: string; ts: number; stem: string | null }[];
  sessions: { created_at: string; last_seen_at: string; expires_at: string; user_agent: string | null; ip: string | null }[];
  settings: { examTrack: string; dailyNew: number; examDate: string; persona: string; sfx: boolean; theme: string } | null;
  llm: { enabled: boolean; kind: string; hasKey: boolean; model: string } | null;
  daily: { date: string; n: number; c: number }[];
  logs: { id: number; actor_email: string; action: string; detail: Record<string, unknown>; at: string }[];
}

export interface Mastery {
  nodeId: string; level: 'new' | 'learning' | 'proficient' | 'mastered';
  label: string; attempts: number; correct: number; accuracy: number;
  questions: number; questionsSeen: number; allRight: boolean;
  /** 内置题数量（「精通」只看这些） */
  builtinQuestions?: number;
  /** 自建题数量，含 AI 生成的变式题（参与正确率，但不参与「精通」判定） */
  ownQuestions?: number;
}

export interface TreeNode {
  id: string; title: string; difficulty: number; exam: string | string[];
  mastery: Mastery['level']; masteryLabel: string; accuracy: number;
  attempts: number; questions: number; hasCard: boolean;
}

export interface Chapter {
  id: string; name: string; nodes: TreeNode[]; total: number; mastered: number; lit: boolean;
}

export interface Category {
  id: string; name: string; color: string; chapters: Chapter[];
}

export interface Question {
  id: string; kid: string; type: 'choice' | 'blank'; difficulty: number;
  stem: string; options: { k: string; t: string }[] | null;
  sourceType: string; sourceYear: number | null; source: string;
}

/** 录题 / 改题时提交的字段。答案必须能被判题器判分，否则服务端会拒。 */
export interface QuestionDraft {
  kid: string;
  type: 'choice' | 'blank';
  stem: string;
  options?: { k: string; t: string }[];
  answer: string;
  analysis?: string;
  difficulty?: number;
  sourceType?: string;
  sourceYear?: number;
  source?: string;
}

export interface AnswerResult {
  correct: boolean; myAnswer: string; answer: string; analysis: string;
  options: { k: string; t: string }[] | null; stem: string; kid: string;
  xp: { gained: number; levelUp: boolean; from?: number; to?: number; title?: string };
  xpNote: string;
  combo: { combo: number; best_combo: number };
  mastery: { level: string; label: string; accuracy: number; attempts: number };
  achievements: string[];
}

export interface Snapshot {
  today: string; xp: number; level: number; title: string;
  levelInfo: { xp: number; level: number; title: string; into: number; need: number; pct: number; total: number };
  streak: number; bestStreak: number;
  learned: number; total: number;
  attempts: number; correct: number; wrong: number; mistakes: number;
  maxMinutes: number; chaptersDone: number; chaptersTotal: number;
  chStat: Record<string, { total: number; mastered: number }>;
  bossPassed: number; deckCards: number;
  bestCombo: number; combo: number; flags: Record<string, unknown>;
  dueCount?: number;
}

export interface Card {
  id: string; type: string; knowledgeId: string | null; questionId: string | null;
  due: string; interval: number; reps: number; ef: number; lapses: number;
  lastReview: string | null; createdAt: string;
  kidTitle?: string | null; content?: string | null; example?: string | null;
  stem?: string | null; options?: { k: string; t: string }[] | null;
  answer?: string | null; analysis?: string | null;
}

export interface Mistake {
  qid: string; kid: string; kidTitle: string; chapterId: string;
  stem: string; type: string; options: { k: string; t: string }[] | null;
  answer: string; analysis: string; myAnswer: string;
  difficulty: number; sourceType: string; sourceYear: number | null;
  wrongCount: number; attempts: number; lastAt: number;
}

export interface Achievement {
  id: string; name: string; desc: string; icon: string;
  tier: 'bronze' | 'silver' | 'gold';
  unlockedAt: string | null;
  progress: { have: number; need: number; pct: number } | null;
}

/* ---- 知识图谱 ---- */

export interface GraphNeighbor {
  id: string; title: string;
  strength: 'hard' | 'soft';
  reason: string;
  source: string;
}

export interface NodeGraphContext {
  prerequisites: GraphNeighbor[];
  unlocks: GraphNeighbor[];
  confusable: GraphNeighbor[];
  impact: number;
}

/**
 * 根因。kind 决定用户该做什么，两者动作完全不同：
 *   gap  —— 从没学过，得去**学**
 *   weak —— 学过但没打牢，得去**补**
 */
export interface RootCause {
  nodeId: string; title: string; chapterId: string; difficulty: number;
  kind: 'gap' | 'weak';
  level: Mastery['level']; label: string;
  accuracy: number; attempts: number;
  coverage: number; depth: number;
  strength: 'hard' | 'soft'; score: number;
  coveredSymptoms: { nodeId: string; title: string; wrong: number; accuracy: number }[];
  why: string;
}

export interface RootDiagnosis {
  roots: RootCause[];
  symptomCount: number;
  scanned: number;
  message: string;
}

export interface PathItem {
  nodeId: string; title: string; chapterId: string; difficulty: number;
  level: Mastery['level']; label: string;
  accuracy: number; attempts: number; wrong: number;
  isRoot: boolean; rank: number;
  prereqCount: number; prereqRatio: number; order: number; score: number;
  why: string;
}

export interface LearningPath {
  items: PathItem[];
  ready: number;
  blocked: number;
  blockedSample: {
    nodeId: string; title: string; wrong: number;
    blockers: { nodeId: string; title: string; level: Mastery['level']; accuracy: number }[];
  }[];
  total: number;
  message: string;
}

export interface GraphNode {
  id: string; title: string;
  chapterId: string; chapterName: string; categoryId: string;
  difficulty: number;
  level: Mastery['level']; label: string;
  accuracy: number; attempts: number;
  /** 影响面：这个节点卡住多少个下游。用来决定图上节点的大小。 */
  impact: number;
  prereqCount: number; hardPrereqCount: number;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: { from: string; to: string; type: string; strength: string; reason: string }[];
  counts: { total: number; prereq: number; confusable: number; related: number };
  dist: Record<string, number>;
  pct: Record<string, number>;
  health: { nodes: number; edges: number; isolated: string[]; dangling: string[]; byType: Record<string, number> };
}

/* ---- 错因归类 ---- */

export type ErrorType = 'concept' | 'calc' | 'condition' | 'method' | 'misread' | 'blank';

export interface ErrorStat {
  items: { type: ErrorType; label: string; count: number }[];
  judged: number; totalWrong: number; unjudged: number; advice: string;
}

/* ---- 多智能体课堂 ---- */
export type ClassRole = 'teacher' | 'xiaoming' | 'xiaohong' | 'xiaogang';

export interface ClassroomTurn {
  role: ClassRole;
  name: string;
  text: string;
  /** 本地标注：第几轮产生的（后端不返回，前端补） */
  round?: number;
}

export interface ClassroomRound {
  turns: ClassroomTurn[];
  board: string[];
  prompt: string;
  round: number;
  raw?: string;
  parseFailed?: boolean;
}

export interface ClassroomRoundBody {
  kid?: string;
  mode?: 'lesson' | 'discuss';
  userInput?: string;
  history?: { role?: string; name: string; text: string }[];
  round?: number;
}

/* ============ 接口 ============ */
export const api = {
  health: () => get<{ ok: boolean; db: { tables: number; users: number; attempts: number } }>('/api/health'),

  auth: {
    me: () => get<{ user: User }>('/api/auth/me'),
    login: (email: string, password: string) => post<{ user: User }>('/api/auth/login', { email, password }),
    register: (email: string, username: string, password: string) => post<{ user: User }>('/api/auth/register', { email, username, password }),
    logout: () => post<{ ok: boolean }>('/api/auth/logout'),
    changePassword: (current: string, next: string) => post<{ ok: boolean }>('/api/auth/password', { current, next }),
    sessions: () => get<{ sessions: any[]; count: number }>('/api/auth/sessions'),
    logoutAll: () => post<{ ok: boolean }>('/api/auth/logout-all'),
    deleteAccount: (password: string) => request<{ ok: boolean }>('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }),
  },

  catalog: {
    tree: (track = 'math1') => get<{ track: string; categories: Category[]; mastery: { dist: Record<string, number>; pct: Record<string, number>; total: number; learned: number; label: Record<string, string> } }>(`/api/catalog/tree?track=${track}`),
    knowledge: (id: string) => get<any>(`/api/catalog/knowledge/${id}`),
    questions: (params: Record<string, string | number> = {}) => {
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
      return get<{ questions: (Question & { mine: boolean })[]; count: number }>(`/api/catalog/questions?${qs}`);
    },
    facets: () => get<{ sources: any[]; years: any[]; difficulties: any[]; types: any[]; total: number }>('/api/catalog/facets'),
    question: (id: string) => get<{ question: Question & { answer: string; analysis: string }; stat: { n: number; c: number; ok: number } }>(`/api/catalog/questions/${id}`),
  },

  /* 自建题（录题）。内置题改不了也删不了，服务端一律回 404。 */
  questions: {
    create: (body: QuestionDraft) =>
      post<{ ok: boolean; question: Question & { answer: string; analysis: string } }>('/api/questions', body),
    /** 部分更新：没传的字段沿用原值 */
    update: (id: string, body: Partial<QuestionDraft>) =>
      put<{ ok: boolean; question: Question & { answer: string; analysis: string } }>(`/api/questions/${id}`, body),
    remove: (id: string) => del<{ ok: boolean }>(`/api/questions/${id}`),
  },

  study: {
    answer: (qid: string, answer: string, context = 'quiz') => post<AnswerResult>('/api/study/answer', { qid, answer, context }),
    mistakes: (kid?: string) => get<{ mistakes: Mistake[]; total: number; byKid: Record<string, number> }>(`/api/study/mistakes${kid ? `?kid=${kid}` : ''}`),
    weak: (limit = 8) => get<{ weak: any[] }>(`/api/study/weak?limit=${limit}`),
    /** 根因诊断：从错题回溯到真正没打牢的前置。与 weak 的分工见后端注释。 */
    roots: (limit = 5) => get<RootDiagnosis>(`/api/study/roots?limit=${limit}`),
    snapshot: (track = 'math1') => get<{ snapshot: Snapshot; settings: any }>(`/api/study/snapshot?track=${track}`),
    stats: (track = 'math1') => get<any>(`/api/study/stats?track=${track}`),
    daily: () => get<any>('/api/study/daily'),
    refreshDaily: () => post<any>('/api/study/daily/refresh'),
    checkin: (minutes: number, tasksDone: boolean) => post<any>('/api/study/checkin', { minutes, tasksDone }),
    focus: (minutes: number, startedAt?: string) => post<any>('/api/study/focus', { minutes, startedAt }),
    notes: () => get<{ notes: any[] }>('/api/study/notes'),
    addNote: (kid: string, text: string) => post<{ ok: boolean; id: string }>('/api/study/notes', { kid, text }),
    deleteNote: (id: string) => del<{ ok: boolean }>(`/api/study/notes/${id}`),
    reset: () => post<{ ok: boolean }>('/api/study/reset', { confirm: 'RESET' }),
  },

  cards: {
    due: () => get<{ cards: Card[]; today: string; count: number }>('/api/cards/due'),
    all: (params: Record<string, string> = {}) => {
      const qs = new URLSearchParams(params).toString();
      return get<{ cards: Card[]; count: number }>(`/api/cards?${qs}`);
    },
    summary: () => get<any>('/api/cards/summary'),
    grade: (id: string, rating: number) => post<{ card: any; xp: any; achievements: string[]; remaining: number }>(`/api/cards/${id}/grade`, { rating }),
    create: (body: { knowledgeId?: string; questionId?: string; type?: string }) => post<{ ok: boolean; card: Card }>('/api/cards', body),
    remove: (id: string) => del<{ ok: boolean }>(`/api/cards/${id}`),
  },

  game: {
    state: (track = 'math1') => get<any>(`/api/game/state?track=${track}`),
    achievements: (track = 'math1') => get<{ items: Achievement[]; unlocked: number; total: number; tiers: Record<string, number> }>(`/api/game/achievements?track=${track}`),
    blitz: (body: { score: number; correct: number; wrong?: number; bestCombo?: number; seconds?: number }) => post<any>('/api/game/blitz', body),
    boss: (chapterId: string, score: number, total: number) => post<any>('/api/game/boss', { chapterId, score, total }),
    projection: () => get<any>('/api/game/projection'),
    next: () => get<{
      items: { kind: string; priority: number; title: string; why: string; route: string; nodes?: { nodeId: string; title: string }[] }[];
      snapshot: Snapshot; dueCount: number;
      path: LearningPath; roots: RootDiagnosis;
    }>('/api/game/next'),
  },

  graph: {
    all: (track = 'math1') => get<GraphPayload>(`/api/graph?track=${track}`),
    node: (id: string) => get<{ id: string; title: string } & NodeGraphContext>(`/api/graph/node/${id}`),
  },

  deck: {
    list: (kid?: string) => get<{ cards: any[]; count: number }>(`/api/deck${kid ? `?kid=${kid}` : ''}`),
    add: (body: { kid: string; title: string; front: string; back?: string; type?: string; src?: string }) => post<any>('/api/deck', body),
    remove: (id: string) => del<{ ok: boolean }>(`/api/deck/${id}`),
    toCard: (id: string) => post<{ ok: boolean; cardId: string }>(`/api/deck/${id}/to-card`),
  },

  classroom: {
    get: (kid: string) => get<{ classroom: any }>(`/api/classroom/${kid}`),
    save: (kid: string, payload: unknown) => put<{ ok: boolean }>(`/api/classroom/${kid}`, { payload }),
    clear: (kid: string) => del<{ ok: boolean }>(`/api/classroom/${kid}`),
  },

  chat: {
    get: (kid: string) => get<{ chat: { stage: string; history: any[]; updatedAt: string } | null }>(`/api/chat/${kid}`),
    save: (kid: string, stage: string, history: unknown[]) => put<{ ok: boolean }>(`/api/chat/${kid}`, { stage, history }),
  },

  settings: {
    get: () => get<{ settings: any }>('/api/settings'),
    update: (body: Record<string, unknown>) => put<{ settings: any }>('/api/settings', body),
    llm: () => get<{ llm: any }>('/api/settings/llm'),
    updateLlm: (body: Record<string, unknown>) => put<{ ok: boolean }>('/api/settings/llm', body),
    testLlm: () => post<{ ok: boolean; status?: number; ms?: number; model?: string; reply?: string; error?: string }>('/api/settings/llm/test'),
  },

  data: {
    export: (withKey = false) => get<any>(`/api/export${withKey ? '?withKey=1' : ''}`),
    import: (bundle: unknown, mode: 'merge' | 'replace') => post<{ ok: boolean; mode: string; summary: any }>('/api/import', { bundle, mode }),
    storage: () => get<{ attempts: number; cards: number; notes: number; deck: number; dbBytes: number; dbMb: number }>('/api/storage'),
  },

  ai: {
    personas: () => get<{ personas: { id: string; name: string; desc: string }[] }>('/api/ai/personas'),
    extract: (text: string, kid?: string) => post<{ cards: any[]; raw?: string }>('/api/ai/extract', { text, kid }),
    classroom: (body: ClassroomRoundBody) => post<ClassroomRound>('/api/ai/classroom', body),
    /** 单题错因归类。判成 concept 时会附带图谱回溯出来的前置建议。 */
    errorType: (qid: string) => post<{
      qid: string; errorType: ErrorType | null; label?: string; reason?: string;
      saved: boolean; parseFailed?: boolean; raw?: string;
      rootHint?: { message: string; candidates: { nodeId: string; title: string; level: string; label: string; accuracy: number }[] } | null;
    }>('/api/ai/error-type', { qid }),
    /** 批量归类。只处理还没判过的错题，一次最多 8 道。 */
    errorTypes: (limit = 5, kid?: string) => post<{
      items: { qid: string; kid: string; errorType: ErrorType; label: string; reason: string }[];
      remaining: number; parseFailed?: boolean; raw?: string; message?: string;
    }>('/api/ai/error-types', { limit, kid }),
    errorStats: () => get<ErrorStat>('/api/ai/error-stats'),
    /**
     * 变式题生成（举一反三）。落库后是当前用户的自建题（id 前缀 `g_`），
     * 会出现在题库里，也参与掌握度计算。
     */
    generate: (kid: string, opts: { count?: number; fromQid?: string; save?: boolean } = {}) => post<{
      created: {
        id: string; kid: string; type: 'choice' | 'blank'; difficulty: number;
        stem: string; options: { k: string; t: string }[] | null;
        answer: string; analysis: string; sourceType: string; saved: boolean;
      }[];
      count: number;
      /** 因为和已有题目重复而跳过的道数 */
      skippedDuplicate: number;
      /** 因为判题器判不了（开放题 / 根号答案 / 多解）而丢掉的道数 */
      skippedUnjudgeable: number;
      parseFailed?: boolean;
      raw?: string;
    }>('/api/ai/generate', { kid, ...opts }),
  },

  /* 管理台。全部接口服务端都有 requireAdmin，非管理员一律 403。 */
  admin: {
    overview: () => get<AdminOverview>('/api/admin/overview'),
    users: (params: Record<string, string | number> = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== '' && v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      return get<{ users: AdminUser[]; total: number; limit: number; offset: number }>(`/api/admin/users?${qs}`);
    },
    user: (id: number) => get<AdminUserDetail>(`/api/admin/users/${id}`),
    create: (body: { email: string; username: string; password: string; role?: string; note?: string }) =>
      post<{ ok: boolean; user: AdminUser }>('/api/admin/users', body),
    update: (id: number, body: Partial<{ email: string; username: string; role: string; status: string; note: string }>) =>
      request<{ ok: boolean; changed: Record<string, [string, string]>; user: AdminUser }>(
        `/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) },
      ),
    resetPassword: (id: number, password: string) =>
      post<{ ok: boolean; sessionsKilled: number }>(`/api/admin/users/${id}/password`, { password }),
    forceLogout: (id: number) => post<{ ok: boolean; sessionsKilled: number }>(`/api/admin/users/${id}/logout`),
    remove: (id: number) => del<{ ok: boolean; wiped: Record<string, number> }>(`/api/admin/users/${id}`),
    logs: (limit = 60) => get<{ logs: AdminLogEntry[] }>(`/api/admin/logs?limit=${limit}`),
  },
};

/* ============ SSE 流式对话 ============ */
export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string }

export function streamChat(
  body: { kid?: string; stage?: string; persona?: string; messages: ChatMessage[] },
  handlers: { onDelta: (s: string) => void; onDone: (full: string) => void; onError: (msg: string) => void },
): () => void {
  const ctrl = new AbortController();

  (async () => {
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        let msg = `请求失败（${res.status}）`;
        try { msg = JSON.parse(t).error || msg; } catch { /* 保留默认 */ }
        handlers.onError(msg);
        return;
      }
      if (!res.body) { handlers.onError('浏览器不支持流式响应'); return; }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let full = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          try {
            const j = JSON.parse(data);
            if (j.delta) { full += j.delta; handlers.onDelta(j.delta); }
            if (j.error) { handlers.onError(j.error); return; }
            if (j.done) { handlers.onDone(j.full || full); return; }
          } catch { /* 忽略坏分片 */ }
        }
      }
      handlers.onDone(full);
    } catch (e: any) {
      if (e?.name !== 'AbortError') handlers.onError(e?.message || '连接中断');
    }
  })();

  return () => ctrl.abort();
}
