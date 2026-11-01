/* AI 对话代理
 *
 * 为什么必须放服务端：
 *   1. API Key 不该出现在浏览器里（前端版把它存在 localStorage，任何 XSS 都能拿走）；
 *   2. 系统提示词要注入实时学情 —— 那需要查库，浏览器没有这个能力；
 *   3. 流式响应需要一个不受 CORS 限制的中转。
 *
 * 教学法（沿用前端版的铁律）：AI 一开口就给答案，学生的大脑就不会去检索，记忆不会形成。
 * 所以系统提示词里写死了「不许直接给答案」。
 */
import { db } from '../db/index.js';
import { checkLlmBase, llmFetch } from '../lib/llmUrl.js';
import { getConfig } from '../lib/appConfig.js';
import { resolveLlmFor, resolveVisionLlm, consumeQuota, refundQuota } from '../lib/llm.js';
import { buildSnapshot, nodeMastery, getTree } from '../lib/game.js';
import { ancestors } from '../lib/graph.js';
import { answerIssue, normalizeAnswer, parseSteps, SELF_GRADED_TYPES, QUESTION_TYPES, TYPE_LABEL } from '../lib/judge.js';
import { buildGradePrompt, buildExplainPrompt, parseGrade } from '../lib/grade.js';
import { buildSolvePrompt, sanitizeSolve } from '../lib/solve.js';
/* 课堂状态机与 JSON 宽容解析已拆到 lib/ —— 见那两个文件开头的说明。
 * 这里只留路由和「怎么调模型」的基础设施。
 * 只 import 真正用到的：fallbackCheckPrompt 是 classroom.js 内部用的
 * （guardClassroomResult 里调），路由层用不上。 */
import {
  classifyIntent, resolvePhase, PROMPT_KIND,
  buildClassroomPrompt, guardClassroomResult, normalizeTurns,
} from '../lib/classroom.js';
import { parseJsonArray, parseJsonObject } from '../lib/json.js';

/* ---------- AI 接口的限流档位 ----------
 *
 * 这六个接口每次调用都要打上游 —— 花的是用户的额度，或者占本地模型的算力。
 * 它们比只读接口贵几个数量级，所以不跟全局那档（默认 600/分钟）共用，
 * 单独收紧到 30/分钟。
 *
 * 30 够用吗：一次提问在界面上是「一个流式请求」，只在开始时建连一次，
 * 不是每个字一个请求。连续追问 30 次/分钟已经远超正常复习节奏。
 * 真的被卡住，429 的文案是中文的（走 index.js 的统一错误处理器），
 * 用户知道自己在被限流，而不是「点不动了」。
 *
 * error-stats 和 personas 不加：它们只读本地库，不打上游。 */
const AI_LIMIT = { max: 30, timeWindow: '1 minute' };

/* ---------- 错因分类 ----------
 *
 * 「答错」是一个二值事实，「为什么错」才决定下一步该干什么：
 *   概念混淆 → 回去补前置（触发图谱回溯）
 *   计算失误 → 只需要练熟练度
 *   条件遗漏 → 补的是审题清单，不是知识
 *   方法不会 → 得先看例题，不是继续刷题
 *   审题偏差 → 跟知识无关，跟习惯有关
 * 五种处置方式完全不同，而 attempts 里只存了 correct = 0，分不出来。
 *
 * 顺序有意义：concept 排第一是因为它最常被误判成「粗心」——
 * 学生以为自己是算错了，其实是根本没理解，于是继续刷题，越刷越错。
 */
export const ERROR_TYPES = {
  concept: '概念混淆',
  calc: '计算失误',
  condition: '条件遗漏',
  method: '方法不会',
  misread: '审题偏差',
  blank: '未作答',
};

/* 小模型基本不听枚举约束 —— 实测会给出「概念不清」「理解错误」「运算错误」
 * 这类同义变体。按关键词兜一层，宁可按最接近的归类，也别整条丢掉。 */
const ERROR_ALIAS = [
  [/概念|定义|理解|定理|混淆|不清/, 'concept'],
  [/计算|运算|算错|粗心|笔误|符号/, 'calc'],
  [/条件|前提|定义域|边界|遗漏|漏掉|范围/, 'condition'],
  [/方法|思路|不会|无从|没有方向|公式不记得/, 'method'],
  [/审题|看错|读错|题意|误解/, 'misread'],
  [/未作答|没做|放弃|空白|来不及/, 'blank'],
];

export function normalizeErrorType(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const key = s.toLowerCase();
  if (ERROR_TYPES[key]) return key;
  for (const [re, t] of ERROR_ALIAS) if (re.test(s)) return t;
  return null;
}

const PERSONAS = {
  strict: {
    name: '严师',
    desc: '直接、严格、不留情面。答错会明确指出错在哪一步，但不羞辱。',
  },
  warm: {
    name: '暖师',
    desc: '耐心、鼓励为主。先肯定做对的部分，再指出问题。',
  },
  socratic: {
    name: '苏格拉底',
    desc: '几乎不直接给结论，全靠追问把你逼到答案面前。',
  },
  exam: {
    name: '命题人',
    desc: '一切从「考研怎么考」出发。讲任何知识点都会点明它的考法、分值和陷阱。',
  },
};

function buildSystemPrompt(userId, { kid, stage = 'explain', persona = 'strict' }) {
  const tree = getTree();
  const node = kid ? tree.nodeById.get(kid) : null;
  const snap = buildSnapshot(userId);
  const p = PERSONAS[persona] || PERSONAS.strict;

  const weak = db.prepare(`
    SELECT sq.kid, COUNT(*) n, k.title
    FROM stats_question sq LEFT JOIN knowledge k ON k.id = sq.kid
    WHERE sq.user_id = ? AND sq.ok = 0 GROUP BY sq.kid ORDER BY n DESC LIMIT 5
  `).all(userId);

  const lines = [
    '你是一位考研数学名师，正在一对一辅导一名备战考研数学的学生。',
    '',
    `【你的人格】${p.name}：${p.desc}`,
    '',
    '【教学铁律 —— 违反即为失职】',
    '1. 不许直接给答案。学生答错时先问「你当时是怎么想的」，找到断掉的那一步，引导他自己补上。',
    '   只有学生明确说「我放弃，请直接讲」时才完整讲解。',
    '2. 每次回复不超过 300 字，讲一个点就停下来等反馈。禁止一次性长篇灌输。',
    '3. 先直觉后严格：先用几何直观或生活例子建立感觉，再给严格定义。',
    '4. 数学公式一律用 LaTeX：行内 $...$，独立公式 $$...$$。',
    '5. 不知道就承认不知道，禁止编造定理和公式。',
    '',
    '【学情快照 —— 据此决定讲多深】',
    `- 考纲内知识点 ${snap.total} 个，已学过 ${snap.learned} 个`,
    `- 累计作答 ${snap.attempts} 次，答对 ${snap.correct} 次，正确率 ${snap.attempts ? Math.round((snap.correct / snap.attempts) * 100) : 0}%`,
    `- 连续打卡 ${snap.streak} 天，当前等级 ${snap.level} 级（${snap.title}）`,
    `- 待攻克错题 ${snap.wrong} 道`,
  ];

  if (weak.length) {
    lines.push('- 最薄弱的考点：' + weak.map((w) => `${w.title || w.kid}（错 ${w.n} 次）`).join('、'));
  }

  if (node) {
    const m = nodeMastery(userId, node.id);
    lines.push(
      '',
      '【当前教学知识点】',
      `${node.title}（难度 ${node.difficulty}/4，掌握状态：${m.label}，正确率 ${Math.round(m.accuracy * 100)}%）`,
      '--- 正文 ---',
      String(node.content || '').replace(/\\n\\n/g, '\n'),
    );
    if (node.example) lines.push('--- 例题 ---', node.example);
  }

  const stageText = stage === 'quiz'
    ? 'quiz（出题验收中：一次只出一题，答完点评再出下一题，不直接给完整答案）'
    : stage === 'summary'
      ? 'summary（总结阶段：把本次学到的整理成 3 条以内的要点）'
      : 'explain（讲解中：先直觉后严格，一次只讲一个点）';
  lines.push('', `【当前阶段】${stageText}`);

  return lines.join('\n');
}

/* ---------- 模型配置闸门 ----------
 *
 * 为什么必须在这里拦住：没配密钥时如果放行，请求会带着**空的 Authorization**
 * 打到上游，拿回一句「401 Authentication Fails」—— 用户看到这句话完全不知道
 * 是自己没填密钥，只会以为服务坏了。
 *
 * 这个检查以前只有 /api/ai/chat 有，另外五个接口（extract / classroom /
 * error-type / error-types / generate）全漏了 —— 同一个故障，在对话页是
 * 「还没配置模型」，在错题本里却变成一句看不懂的 401。
 * 抽成一个函数，加新接口时不会再漏。
 *
 * @returns {{cfg: object}|{error: object}} 有 error 就直接 reply.code(400).send(error)
 */
async function llmOrError(req) {
  const cfg = resolveLlmFor(req.userId);
  const mode = getConfig().ai.mode;

  /* 是不是「云端」决定了要不要检查 Key 和做 SSRF 校验。
   *
   * ★ 注意 mode === 'server' 时 resolveLlmFor() **根本不读用户的
   *   llm_settings** —— base/model/key 全部来自服务端配置和环境变量。
   *   这不是省事，是安全前提：如果统一 Key 模式下还沿用用户填的
   *   base，用户就能把自己的地址填进来，让服务端带着**你的 Key**
   *   请求过去。lib/llm.js 开头有完整说明。 */
  const isCloud = mode === 'server' || cfg?.source === 'byok-cloud';

  if (!cfg || !cfg.base || !cfg.model) {
    return {
      error: {
        error: mode === 'server'
          ? '服务端的模型配置不完整（管理员在「小程序控制台 → AI」里检查 Base 和模型名）。'
          : '还没配置模型。去「设置 → 模型接入」填 Base URL 和模型名。',
        code: 'NO_LLM',
      },
    };
  }

  if (isCloud && !cfg.key) {
    return {
      error: {
        error: mode === 'server'
          ? '服务端没有配置 SERVER_LLM_KEY，AI 功能暂时不可用。'
          : '云端模型还没填 API Key。去「设置 → 模型接入」补上，或者切到本地模型。',
        code: 'NO_LLM',
      },
    };
  }

  /* ★ 上游地址再校验一次（见 lib/llmUrl.js）。
   *
   * 写入口（PUT /api/settings/llm）已经拦过内网地址，但库里可能存着
   * **那次改动之前**就填好的地址 —— 只在写入口拦，存量数据照样能打出去。
   * 这是所有 AI 接口共用的唯一闸门，所以拦在这里一处就够。
   *
   * server 模式下 base 是管理员配的，但同样校验 —— 一个填错的
   * 地址（比如内网 IP）会让所有 AI 调用静默超时，那种故障很难查。 */
  const baseErr = await checkLlmBase(cfg.base, { forCloud: isCloud });
  if (baseErr) {
    return { error: { error: baseErr, code: 'BAD_LLM_BASE' } };
  }

  /* ---------- 配额 ----------
   *
   * 在**调用上游之前**扣。理由见 lib/llm.js 里 consumeQuota 的注释：
   * 先调后扣会让「上游超时 / 401」这类失败永远不被计数，而那恰恰是
   * 最容易被拿来刷的路径。
   *
   * 失败时的退还在本文件底部的 onSend 钩子里统一处理 —— 不在 9 个
   * 接口里各写一遍，那必然会漏一个。 */
  const quota = consumeQuota(req.userId);
  if (!quota.ok) {
    return {
      error: {
        error: quota.error,
        code: quota.code,
        /* 把余量一起带回去，前端据此把 AI 入口置灰，而不是等用户
         * 点一次、被拒一次。 */
        quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
      },
    };
  }

  req.quotaConsumed = true;
  return { cfg, quota };
}

/** vision 专用的配置检查。和 llmOrError 一样，但用 resolveVisionLlm。 */
async function visionLlmOrError(req) {
  const cfg = resolveVisionLlm(req.userId);
  const mode = getConfig().ai.mode;
  const isCloud = mode === 'server' || cfg?.source === 'byok-cloud';

  if (!cfg || !cfg.base || !cfg.model) {
    return {
      error: {
        error: mode === 'server'
          ? '服务端的模型配置不完整（管理员在「小程序控制台 → AI」里检查 Base、模型名和 Vision 模型名）。'
          : '还没配置模型。去「设置 → 模型接入」填 Base URL 和模型名。',
        code: 'NO_LLM',
      },
    };
  }
  if (isCloud && !cfg.key) {
    return {
      error: {
        error: mode === 'server'
          ? '服务端没有配置 SERVER_LLM_KEY，AI 功能暂时不可用。'
          : '云端模型还没填 API Key。',
        code: 'NO_LLM',
      },
    };
  }
  const baseErr = await checkLlmBase(cfg.base, { forCloud: isCloud });
  if (baseErr) return { error: { error: baseErr, code: 'BAD_LLM_BASE' } };

  const quota = consumeQuota(req.userId);
  if (!quota.ok) {
    return {
      error: {
        error: quota.error,
        code: quota.code,
        quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
      },
    };
  }
  req.quotaConsumed = true;
  return { cfg, quota };
}

/**
 * 从 multipart 请求里读一张图。
 *
 * 返回 { buffer, mime, fields } 或 { error }。
 * 抽出来是因为「读图 → 转 base64」在 vision 和 solve 两处一模一样，
 * 复制两份的话，改一个上限（比如 5MB 调到 8MB）必然漏一处。
 */
async function readImage(req) {
  let data;
  try {
    data = await req.file();
  } catch {
    return { error: '没有收到图片文件，或文件超过 5MB。' };
  }
  if (!data) return { error: '请上传一张图片。' };

  const chunks = [];
  for await (const chunk of data.file) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) return { error: '图片文件为空。' };

  return {
    buffer,
    mime: data.mimetype || 'image/jpeg',
    fields: data.fields || {},
  };
}

/** 组装一条「文本 + 图片」的多模态消息。 */
function imageMessage(prompt, mime, buffer) {
  return {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
    ],
  };
}

export default async function aiRoutes(fastify) {
  /* ---------- 配额退还 ----------
   *
   * 配额在 llmOrError() 里「先扣后调」。扣了但请求根本没成功的那部分
   * 要还回去，否则上游抖一次，用户就白掉一次额度。
   *
   * 为什么用 onSend 钩子而不是在每个接口的 catch 里各写一遍：
   * 这里有 9 个 AI 接口，而它们的失败路径长得都不一样 —— 有的是
   * `return reply.code(502)`，有的是上游 4xx 透传，有的在流式过程中
   * 断掉。逐处写必然漏，而漏掉的表现是「用户说额度少了一次，但查不出
   * 哪里扣的」。钩子只写一次，覆盖全部。
   *
   * ★ 只退 5xx（502 连不上、500 内部错误、504 超时）。
   *   4xx 不退：那些请求**确实打到了上游**，也确实消耗了上游的时间和
   *   配额，而且「用一个坏 Key 疯狂重试」正是最需要被计数挡住的行为。
   *   如果 4xx 也退，配额就形同虚设。
   *
   * ★ 流式接口（/api/ai/chat）在写出响应头之后状态码就固定是 200，
   *   中途断流不会再触发这个钩子。那种情况算「已经用掉了」——
   *   上游确实生成了 token，账单已经产生。 */
  fastify.addHook('onSend', async (req, reply, payload) => {
    if (req.quotaConsumed && reply.statusCode >= 500) {
      refundQuota(req.userId);
      req.quotaConsumed = false;
    }
    return payload;
  });

  /* ---------- 流式对话 ---------- */
  fastify.post('/api/ai/chat', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['messages'],
        properties: {
          kid: { type: 'string' },
          stage: { type: 'string' },
          persona: { type: 'string' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: { role: { type: 'string' }, content: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const { kid, stage = 'explain', persona = 'strict', messages } = req.body;
    const system = buildSystemPrompt(req.userId, { kid, stage, persona });
    const payload = {
      model: cfg.model,
      messages: [{ role: 'system', content: system }, ...messages.slice(-30)],
      stream: true,
      temperature: 0.4,
    };

    let upstream;
    try {
      upstream = await llmFetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return reply.code(502).send({ error: `连不上模型服务：${e.message}` });
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return reply.code(upstream.status).send({ error: `模型返回 ${upstream.status}：${text.slice(0, 300)}` });
    }

    // 转为 SSE 回传
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') {
            reply.raw.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
            reply.raw.end();
            return reply;
          }
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content || '';
            if (delta) {
              full += delta;
              reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
            }
          } catch { /* 忽略无法解析的分片 */ }
        }
      }
      reply.raw.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
      reply.raw.end();
    } catch (e) {
      try {
        reply.raw.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        reply.raw.end();
      } catch { /* 连接已断 */ }
    }
    return reply;
  });

  /* ---------- 从对话里提取知识点 ---------- */
  fastify.post('/api/ai/extract', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' }, kid: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const { text, kid } = req.body;
    const prompt = [
      '下面是一段考研数学的师生对话。请从中提取值得做成复习卡的考点。',
      '只输出 JSON 数组，不要任何解释文字。格式：',
      '[{"title":"简短标题","front":"正面问题（提问式，用于主动回忆）","back":"背面答案要点","type":"point|pitfall|formula|problem"}]',
      '规则：最多 5 条；front 必须是问题而不是陈述；type 只能是 point(结论)/pitfall(易错点)/formula(公式)/problem(题型)。',
      '',
      '对话内容：',
      text.slice(0, 6000),
    ].join('\n');

    try {
      const content = await callModel(cfg, prompt, { temperature: 0.2 });
      const cards = parseJsonArray(content);

      const saved = [];
      if (kid && cards.length) {
        const ins = db.prepare('INSERT INTO card_deck (id,user_id,kid,type,title,front,back,src,ts) VALUES (?,?,?,?,?,?,?,?,?)');
        cards.slice(0, 5).forEach((c) => {
          if (!c.title || !c.front) return;
          const id = 'd_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
          ins.run(id, req.userId, kid, c.type || 'point', String(c.title).slice(0, 120),
            String(c.front).slice(0, 800), String(c.back || '').slice(0, 1500), 'ai', Date.now());
          saved.push({ id, ...c });
        });
      }
      return { cards: saved, raw: saved.length ? undefined : content.slice(0, 500) };
    } catch (e) {
      /* 上游回了非 2xx 就把状态码透传出去（原来就是这样），
       * 只有真正连不上才回 502 —— 两者对用户的含义完全不同：
       * 401 是「Key 不对」，502 是「网络/服务挂了」。 */
      return reply.code(e.upstreamStatus || 502).send({ error: e.message });
    }
  });

  /* ---------- 拍照识别（vision） ----------
   *
   * 小程序拍照/选图 → uploadFile 上传到这里 → 服务端把图片发给
   * 多模态模型 → 返回识别的文本。
   *
   * 为什么不用 base64 直接 POST：手机拍照 1~3MB，base64 后 1.3~4MB，
   * JSON body 太大容易超时。uploadFile 走 multipart，更稳定。
   *
   * ★ 模型必须支持 vision（deepseek-chat、gpt-4o、claude-3 等）。
   *   如果配置的 model 不支持，控制台可以单独配 visionModel。
   *   服务端只会尝试调用，不会事先校验「这个模型支不支持 vision」——
   *   校验列表会过期，而且第三方兼容接口可能用的自定义模型名。 */
  fastify.post('/api/ai/vision', {
    config: { rateLimit: AI_LIMIT },
  }, async (req, reply) => {
    const img = await readImage(req);
    if (img.error) return reply.code(400).send({ error: img.error });

    const { cfg, error } = await visionLlmOrError(req);
    if (error) return reply.code(400).send(error);

    /* prompt 由客户端给（录题 / 整理笔记用不同的），没给就用通用兜底。 */
    const prompt = (img.fields?.prompt?.value || '').trim()
      || '识别这张图片中的内容。如果是数学题，提取题干、选项（如果有）、答案和解析；如果是笔记，整理成结构化的知识点。用中文回答。';

    try {
      const text = await callModel(cfg, [imageMessage(prompt, img.mime, img.buffer)], {
        temperature: 0.2,
        maxTokens: 2048,
      });
      return { text: text.trim() };
    } catch (e) {
      /* 上游回了非 2xx 就把状态码透传出去（原来就是这样），
       * 只有真正连不上才回 502 —— 两者对用户的含义完全不同：
       * 401 是「Key 不对」，502 是「网络/服务挂了」。 */
      return reply.code(e.upstreamStatus || 502).send({ error: e.message });
    }
  });

  /* ---------- 拍照解题 ----------
   *
   * 和 /api/ai/vision 的区别：vision 只「看清并转录」，solve 要「解出来」。
   *
   * ★ 为什么单独一个接口而不是让客户端拼个 prompt 走 vision：
   *   解题结果是**结构化**的（题目 / 思路 / 分步 / 考点 / 易错点），
   *   前端要分块渲染、步骤要能逐步展开。让客户端解析模型吐的 JSON，
   *   等于把容错逻辑放在小程序里 —— 那里既不好测，改一次还要发版。
   *
   * ★ 为什么 max_tokens 给到 3000：解题比识别长得多，6 步推导 + 考点
   *   很容易超 2048。截断的 JSON 解析不出来，用户拿到的是「识别失败」，
   *   而真实原因是预算不够 —— 这种故障最难查。
   */
  fastify.post('/api/ai/solve', {
    config: { rateLimit: AI_LIMIT },
  }, async (req, reply) => {
    const img = await readImage(req);
    if (img.error) return reply.code(400).send({ error: img.error });

    const { cfg, error } = await visionLlmOrError(req);
    if (error) return reply.code(400).send(error);

    try {
      /* 解题要稳，不要发挥。0.1 比识别用的 0.2 更低 ——
       * 这里最怕的不是答案平淡，是它自己补一个题目条件。 */
      const raw = await callModel(cfg, [imageMessage(buildSolvePrompt(), img.mime, img.buffer)], {
        temperature: 0.1,
        /* 6 步推导 + 考点很容易超 2048。截断的 JSON 解析不出来，
         * 用户看到「识别失败」，而真实原因是预算不够。 */
        maxTokens: 3000,
      });
      const solved = sanitizeSolve(raw);
      /* degraded 不是错误：JSON 没解析出来时，把原文塞进 question
       * 让用户至少能看到内容，前端标一句「格式异常」。 */
      return { ...solved, model: cfg.model };
    } catch (e) {
      /* 上游回了非 2xx 就把状态码透传出去（原来就是这样），
       * 只有真正连不上才回 502 —— 两者对用户的含义完全不同：
       * 401 是「Key 不对」，502 是「网络/服务挂了」。 */
      return reply.code(e.upstreamStatus || 502).send({ error: e.message });
    }
  });

  /* ---------- 多智能体课堂 ----------
   * 老师 + 三个学生各错各的。这里不用流式：一轮要返回结构化的
   * { board, turns, prompt }，半截 JSON 在前端没法用。
   *
   * ★ 2026-09-20 起，这个接口不只是「拼一段提示词」，它跑一个**阶段状态机**。
   *   起因是三条用户报的实感问题，三条都是同一类毛病：
   *     1. 说了「不知道」，三个同学还接着提问 —— 学生没有「该安静」的状态；
   *     2. 说了「不知道」，下一句就甩一道算题 —— 把「没懂」当成了「练过」；
   *     3. 回复完不知道自己在回哪一问 —— 没有把「上一轮留的问题」当成上下文传下去。
   *   所以阶段（phase）由**服务端**决定，不由模型决定：模型只负责在给定阶段里说话，
   *   越界的话有硬过滤（见 guardClassroomResult）。
   */
  fastify.post('/api/ai/classroom', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        properties: {
          kid: { type: 'string' },
          mode: { type: 'string' },
          question: { type: 'string' },
          userInput: { type: 'string' },
          history: { type: 'array' },
          round: { type: 'integer' },
          /** 上一轮老师留给学生的问题 —— 有它，老师才知道自己在回答哪一问 */
          lastPrompt: { type: 'string' },
          /** 上一轮老师留问题时的轮次（0 基） */
          lastPromptRound: { type: 'integer' },
          /** 前端此刻认为处于哪个阶段。用它做承接，避免每轮重新猜 */
          prevPhase: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const {
      kid, mode = 'lesson', userInput = '', history = [], round = 0,
      lastPrompt = '', lastPromptRound = 0, prevPhase = '',
    } = req.body;

    const tree = getTree();
    const node = kid ? tree.nodeById.get(kid) : null;
    const snap = buildSnapshot(req.userId);

    /* 阶段与意图都在服务端算 —— 前端只管照着渲染。
     * 放前端算的话，两边各写一份正则，迟早会出现「界面说在答疑、
     * 提示词却按练习在拼」这种自相矛盾。 */
    const intent = classifyIntent(userInput);
    const phase = resolvePhase({ round, mode, intent, prevPhase });

    const prompt = buildClassroomPrompt({
      node, snap, mode, phase, round, userInput, history, lastPrompt, lastPromptRound,
    });

    /* 网络失败要单独 catch：fetch 连不上时 e.message 就是一句
     * "fetch failed"（undici 的原始措辞），直接回给前端等于没说。
     * 以前这里和答疑接口不一致 —— 那边有「连不上模型服务：」前缀，这边没有，
     * 同一个故障用户看到两种说法。现在统一。
     * 也不能把整段 try 的 catch 都加上这个前缀：那会把「上游返回了坏 JSON」
     * 这类错误也说成「连不上」，反而误导。
     *
     * ★ 改成 callModel 之后靠 e.upstreamStatus 区分：有它 = 上游回了
     *   非 2xx（带着状态码和响应体），没它 = 根本没连上。 */
    let content;
    try {
      content = await callModel(cfg, prompt, { temperature: 0.75 });
    } catch (e) {
      if (e.upstreamStatus) {
        return reply.code(e.upstreamStatus).send({ error: e.message });
      }
      return reply.code(502).send({ error: `连不上模型服务：${e.message}` });
    }

    try {
      const parsed = parseJsonObject(content);

      if (!parsed || !Array.isArray(parsed.turns)) {
        return { turns: [], board: [], prompt: '', raw: content.slice(0, 800), parseFailed: true };
      }

      const turns = normalizeTurns(parsed.turns);

      /* 模型给了 turns，但一条都没能救回来 —— 说明格式完全不对。
       * 以前这里照样返回 parseFailed=false，前端拿到「有板书、有问题、没有讨论」
       * 的半个课堂，看不出哪里坏了。宁可明确报出来。 */
      if (!turns.length) {
        return { turns: [], board: [], prompt: '', raw: content.slice(0, 800), parseFailed: true };
      }

      /* ★ 阶段约束的硬过滤。写在提示词里的规矩模型不一定听 ——
       * 实测小模型在「学生安静」这一条上十次有三次会照样让小明插话。
       * 提示词是请求，这里是保证。 */
      const guarded = guardClassroomResult(
        { turns, board: (parsed.board || []).slice(0, 5).map((b) => String(b).slice(0, 400)), prompt: String(parsed.prompt || '') },
        phase,
        node,
      );

      /* clarify 阶段把学生全滤掉之后老师也没说话 —— 这一轮等于空的，如实报失败 */
      if (!guarded.turns.length) {
        return { turns: [], board: [], prompt: '', raw: content.slice(0, 800), parseFailed: true };
      }

      return {
        turns: guarded.turns,
        board: guarded.board,
        prompt: guarded.prompt,
        round,
        phase,
        promptKind: PROMPT_KIND[phase] || 'recall',
        intent,
        /** prompt 被兜底换过 —— 前端要能说明「这题不是我出的，是系统拦下来的」 */
        promptAdjusted: guarded.adjusted,
        /** 被静默掉的学生发言条数。前端拿来显示「同学先安静」 */
        silenced: guarded.silenced,
      };
    } catch (e) {
      /* 上游回了非 2xx 就把状态码透传出去（原来就是这样），
       * 只有真正连不上才回 502 —— 两者对用户的含义完全不同：
       * 401 是「Key 不对」，502 是「网络/服务挂了」。 */
      return reply.code(e.upstreamStatus || 502).send({ error: e.message });
    }
  });

  /* ---------- 错因归类：单题 ----------
   *
   * 为什么不做成「答错就自动判」：
   * 每答错一题就多一次模型调用，一晚上刷 50 道就是 50 次请求，
   * 而错因归类是**回看时**才有价值的东西，不是即时反馈。
   * 所以做成按需触发（错题本里点「分析错因」），以及批量版本。
   */
  fastify.post('/api/ai/error-type', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['qid'],
        properties: {
          qid: { type: 'string' },
          myAnswer: { type: 'string' },
          save: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const { qid, save = true } = req.body;
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(qid);
    if (!q) return reply.code(404).send({ error: '题目不存在' });

    const last = db.prepare('SELECT * FROM attempts WHERE user_id = ? AND qid = ? ORDER BY ts DESC LIMIT 1')
      .get(req.userId, qid);
    const myAnswer = req.body.myAnswer ?? last?.answer ?? '';

    const prompt = buildErrorPrompt(q, myAnswer);
    let content = '';
    try {
      content = await callLlm(cfg, prompt, { temperature: 0.2 });
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }

    const parsed = parseJsonObject(content);
    const type = normalizeErrorType(parsed?.errorType) || normalizeErrorType(content);
    if (!type) {
      return { errorType: null, raw: content.slice(0, 300), parseFailed: true };
    }

    const reason = String(parsed?.reason || '').slice(0, 200);

    /* 只回写**最近一次答错**的那条。答对的那条不该被贴上错因标签，
     * 否则将来统计错因分布时会把做对的题也算进去。 */
    let saved = false;
    if (save && last && !last.correct) {
      db.prepare('UPDATE attempts SET error_type = ? WHERE id = ?').run(type, last.id);
      saved = true;
    }

    return {
      qid,
      errorType: type,
      label: ERROR_TYPES[type],
      reason,
      saved,
      rootHint: type === 'concept' ? conceptRootHint(req.userId, q.kid) : null,
    };
  });

  /* ---------- 错因归类：批量（错题本一次判一批）----------
   *
   * 一次 prompt 判多题，而不是 N 次单题调用 —— 错题本动辄几十道，
   * 逐题调用既慢又贵，而且模型看不到「这批错题的共同点」。
   * 上限 8 题：再多的话题干会把上下文撑爆，判得反而更糊。
   */
  fastify.post('/api/ai/error-types', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        properties: { limit: { type: 'integer' }, kid: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const limit = Math.min(8, Math.max(1, Number(req.body?.limit) || 5));
    const kid = req.body?.kid;

    /* 只挑**还没判过**的：已经有人工或模型结论的题不重复消耗。
     * 判过的标志是该题存在一条 error_type 非空的作答记录。 */
    const rows = db.prepare(`
      SELECT sq.qid, sq.kid, q.stem, q.answer, q.analysis,
             (SELECT answer FROM attempts a WHERE a.user_id = sq.user_id AND a.qid = sq.qid
               ORDER BY a.ts DESC LIMIT 1) AS myAnswer
      FROM stats_question sq
      JOIN questions q ON q.id = sq.qid
      WHERE sq.user_id = @uid AND sq.ok = 0
        ${kid ? 'AND sq.kid = @kid' : ''}
        AND NOT EXISTS (
          SELECT 1 FROM attempts a2
          WHERE a2.user_id = sq.user_id AND a2.qid = sq.qid AND a2.error_type <> ''
        )
      ORDER BY sq.ts DESC LIMIT @limit
    `).all({ uid: req.userId, kid, limit });

    if (!rows.length) {
      return { items: [], remaining: 0, message: '没有需要判定的错题了。' };
    }

    const prompt = [
      '下面是若干道考研数学错题。请为每道题判断**错因类别**。',
      '',
      '类别（只能选这五个之一）：',
      '  concept   概念混淆 —— 对定义、定理或条件的理解本身有误',
      '  calc      计算失误 —— 思路正确但算错了',
      '  condition 条件遗漏 —— 漏掉定义域、边界、前提条件',
      '  method    方法不会 —— 完全不知道从哪下手',
      '  misread   审题偏差 —— 看错或误解了题意',
      '',
      '判断原则：如果学生的答案显示出**方向性的理解错误**（比如把可导当成连续、',
      '用错了定理的适用条件），一律归为 concept，不要归成 calc。',
      '学生以为自己「粗心」，实际是没理解 —— 这种情况在考研数学里非常普遍，',
      '判成 calc 会让他继续刷题而不是回去补基础。',
      '',
      '只输出 JSON 数组，不要任何解释文字：',
      '[{"qid":"题目 id","errorType":"类别英文名","reason":"不超过 30 字的中文理由"}]',
      '',
      '错题列表：',
      ...rows.map((r, i) => [
        `--- 第 ${i + 1} 题（qid: ${r.qid}）---`,
        `题干：${String(r.stem || '').slice(0, 400)}`,
        `正确答案：${String(r.answer || '').slice(0, 100)}`,
        `学生答案：${String(r.myAnswer ?? '').slice(0, 100)}`,
        r.analysis ? `解析：${String(r.analysis).slice(0, 300)}` : '',
      ].filter(Boolean).join('\n')),
    ].join('\n');

    let content = '';
    try {
      content = await callLlm(cfg, prompt, { temperature: 0.2 });
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }

    const arr = parseJsonArray(content);
    const byQid = new Map(rows.map((r) => [r.qid, r]));
    const upd = db.prepare(`
      UPDATE attempts SET error_type = @type
      WHERE id = (SELECT id FROM attempts WHERE user_id = @uid AND qid = @qid AND correct = 0
                  ORDER BY ts DESC LIMIT 1)
    `);

    const items = [];
    const run = db.transaction(() => {
      for (const c of arr) {
        const qid = String(c?.qid || '');
        if (!byQid.has(qid)) continue;          // 模型编出来的 qid，丢掉
        const type = normalizeErrorType(c?.errorType);
        if (!type) continue;
        upd.run({ type, uid: req.userId, qid });
        items.push({
          qid,
          kid: byQid.get(qid).kid,
          errorType: type,
          label: ERROR_TYPES[type],
          reason: String(c?.reason || '').slice(0, 200),
        });
      }
    });
    run();

    const remaining = db.prepare(`
      SELECT COUNT(*) n FROM stats_question sq
      WHERE sq.user_id = ? AND sq.ok = 0
        AND NOT EXISTS (SELECT 1 FROM attempts a2
          WHERE a2.user_id = sq.user_id AND a2.qid = sq.qid AND a2.error_type <> '')
    `).get(req.userId).n;

    return {
      items,
      remaining,
      parseFailed: items.length === 0,
      raw: items.length ? undefined : content.slice(0, 400),
    };
  });

  /* ---------- 错因分布：给统计页用 ---------- */
  fastify.get('/api/ai/error-stats', async (req) => {
    const rows = db.prepare(`
      SELECT error_type, COUNT(*) n FROM attempts
      WHERE user_id = ? AND correct = 0 AND error_type <> ''
      GROUP BY error_type ORDER BY n DESC
    `).all(req.userId);

    const judged = rows.reduce((a, r) => a + r.n, 0);
    const totalWrong = db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id = ? AND correct = 0')
      .get(req.userId).n;

    return {
      items: rows.map((r) => ({ type: r.error_type, label: ERROR_TYPES[r.error_type] || r.error_type, count: r.n })),
      judged,
      totalWrong,
      unjudged: Math.max(0, totalWrong - judged),
      /* 一句人话的结论。纯数字用户不会自己解读 —— 但「概念类占一半」
       * 和「计算类占一半」该做的事完全不同，值得直接说出来。 */
      advice: buildErrorAdvice(rows, judged),
    };
  });

  /* ---------- 变式题生成（举一反三）----------
   *
   * 为什么需要：内置题库只有 204 道，刷完就断了；而且错题重做三遍，
   * 记住的是「这道题的答案」而不是「这类题的方法」。变式题给的是后者 ——
   * 同考点、同方法，换数字换问法。
   *
   * 两种入口：
   *   · 只给 kid            → 按考点出一组练习（题库刷完时用）
   *   · 给 kid + fromQid    → 按那道错题（含错因）出针对性变式
   *
   * ── 落库与判题 ────────────────────────────────────────────────
   * 生成的题写进 questions 表，owner_id = 当前用户，id 前缀 `g_`。
   * 内置题的 id 是 `q01` 这种，前缀不同，所以 seed 重跑不会覆盖它们。
   * 题型必须是 choice / blank —— 判题器只认这两种（见 sanitizeGenerated）。
   */
  fastify.post('/api/ai/generate', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['kid'],
        properties: {
          kid: { type: 'string' },
          count: { type: 'integer' },
          fromQid: { type: 'string' },
          save: { type: 'boolean' },
          /* objective / subjective / mixed —— 见 buildGeneratePrompt。
           * 不在白名单里的一律按 objective 处理（老客户端不传这个字段）。 */
          mode: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const { kid, fromQid, save = true } = req.body;
    const count = Math.min(5, Math.max(1, Number(req.body?.count) || 3));
    const mode = ['objective', 'subjective', 'mixed'].includes(req.body?.mode) ? req.body.mode : 'objective';

    const tree = getTree();
    const node = tree.nodeById.get(kid);
    if (!node) return reply.code(404).send({ error: '知识点不存在' });

    /* 参考例题取两道**内置题**，用真实题目的风格约束模型 ——
     * 比在提示词里空写一句「出考研难度的题」有效得多。
     * 只取内置题：用户自建题可能是上一次生成的，拿它当范例会越滚越偏。 */
    const examples = db.prepare('SELECT stem, answer FROM questions WHERE kid = ? AND owner_id IS NULL LIMIT 2').all(kid);

    let fromQ = null;
    let userAnswer = '';
    let errorType = '';
    if (fromQid) {
      fromQ = db.prepare('SELECT * FROM questions WHERE id = ?').get(fromQid);
      const att = db.prepare('SELECT answer, error_type FROM attempts WHERE user_id = ? AND qid = ? ORDER BY ts DESC LIMIT 1')
        .get(req.userId, fromQid);
      userAnswer = att?.answer ?? '';
      errorType = att?.error_type ?? '';
    }

    const prompt = buildGeneratePrompt({ node, examples, fromQ, userAnswer, errorType, count, mode });

    let content = '';
    try {
      content = await callLlm(cfg, prompt, { temperature: 0.8 });
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }

    const arr = parseJsonArray(content);
    const dupInDb = db.prepare('SELECT 1 FROM questions WHERE kid = ? AND stem = ? LIMIT 1');
    const ins = db.prepare(`INSERT INTO questions (id,kid,type,difficulty,stem,options,answer,analysis,steps,source_type,source_year,source,owner_id)
      VALUES (@id,@kid,@type,@difficulty,@stem,@options,@answer,@analysis,@steps,@sourceType,NULL,@source,@ownerId)`);

    const created = [];
    const seenStem = new Set();
    let skippedDuplicate = 0;
    let skippedUnjudgeable = 0;

    const run = db.transaction(() => {
      /* 多解析两道（count + 2）当缓冲：模型总会出一两道不可判的，
       * 少要两道的话用户点了「生成 3 道」结果只拿到 1 道。 */
      for (const raw of arr.slice(0, count + 2)) {
        const q = sanitizeGenerated(raw, kid);
        if (!q) { skippedUnjudgeable += 1; continue; }
        /* 同一批里也要查重 —— 模型很容易把同一道题换个数字出两遍 */
        if (seenStem.has(q.stem) || dupInDb.get(kid, q.stem)) { skippedDuplicate += 1; continue; }
        seenStem.add(q.stem);

        const id = 'g_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
        const row = {
          id,
          kid,
          type: q.type,
          difficulty: q.difficulty,
          stem: q.stem,
          options: q.options ? JSON.stringify(q.options) : null,
          answer: q.answer,
          analysis: q.analysis,
          steps: JSON.stringify(q.steps || []),
          sourceType: 'AI 变式',
          source: 'AI 生成',
          ownerId: req.userId,
        };
        if (save) ins.run(row);
        created.push({
          id, kid, type: q.type, difficulty: q.difficulty, stem: q.stem,
          options: q.options, answer: q.answer, analysis: q.analysis,
          steps: q.steps, sourceType: 'AI 变式', saved: save,
          /* ★ 题型的中文名和「要不要自评」跟着一起给。
           *   生成的题会被直接塞进作答卡，而作答卡靠这两个字段决定渲染形态 ——
           *   少给的话主观题会渲染成没有题型标签、也不知道要判分的怪样子。
           *   定义在 judge.js 里，和 publicQuestion 用的是同一份。 */
          typeLabel: TYPE_LABEL[q.type] || q.type,
          selfGraded: SELF_GRADED_TYPES.has(q.type),
        });
        if (created.length >= count) break;
      }
    });
    run();

    return {
      created,
      count: created.length,
      skippedDuplicate,
      skippedUnjudgeable,
      /* 一道都没出来才算失败。出了一部分也返回，前端能显示已有的 ——
       * 全丢的话用户点了按钮什么都没有，不知道是坏了还是模型不行。 */
      parseFailed: created.length === 0,
      raw: created.length ? undefined : content.slice(0, 400),
    };
  });

  /* ---------- 批量生成：一次给多个考点补题 ----------
   *
   * 单考点生成（/api/ai/generate）解决的是「这道错了，给我几道同类型的」，
   * 属于**点补**；这个接口解决的是「这一章一道解答题都没有」，属于**面补**。
   *
   * ── 为什么不是前端循环调 N 次单考点接口 ──────────────────────
   *   · 去重：批量要把**跨考点**的重复题干也滤掉，前端各自为战做不到；
   *   · 失败域：一个考点失败不该让整批白跑，前端循环同样要自己处理；
   *   · 往返：N 次 HTTP 往返意味着 N 次鉴权、N 次限流计数。
   *
   * ── 规模上限 ────────────────────────────────────────────────
   * 这个接口是**同步**的，串行跑十几个考点，每个等一次模型。
   * 所以上限卡在 12 个考点 × 5 道。再大就该换成「任务 + 轮询」，
   * 那是另一套东西了 —— 现在这个规模下同步够用，也更好调试。
   *
   * ── 事务粒度 ────────────────────────────────────────────────
   * ★ 每个考点**单独一个事务**。整批一个大事务的话，第 10 个考点
   * 抛个异常就把前 9 个的成果一起回滚了 —— 而前 9 个本身是好的，
   * 用户白等两分钟什么都没得到。
   */
  fastify.post('/api/ai/generate-batch', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['kids'],
        properties: {
          kids: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          perKid: { type: 'integer' },
          mode: { type: 'string' },
          save: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const rawKids = Array.isArray(req.body?.kids) ? req.body.kids : [];
    const perKid = Math.min(5, Math.max(1, Number(req.body?.perKid) || 3));
    const mode = ['objective', 'subjective', 'mixed'].includes(req.body?.mode) ? req.body.mode : 'objective';
    const save = req.body?.save !== false;

    const tree = getTree();
    const targets = [];
    const unknownKids = [];
    for (const kid of rawKids.slice(0, 12)) {
      const node = tree.nodeById.get(String(kid));
      if (node) targets.push(node);
      else unknownKids.push(String(kid));
    }
    if (!targets.length) {
      return reply.code(404).send({ error: '没有一个是有效考点', unknownKids });
    }

    const dupInDb = db.prepare('SELECT 1 FROM questions WHERE kid = ? AND stem = ? LIMIT 1');
    const ins = db.prepare(`INSERT INTO questions (id,kid,type,difficulty,stem,options,answer,analysis,steps,source_type,source_year,source,owner_id)
      VALUES (@id,@kid,@type,@difficulty,@stem,@options,@answer,@analysis,@steps,@sourceType,NULL,@source,@ownerId)`);

    const created = [];
    const perKidCount = Object.create(null);
    const failed = [];
    /* ★ 跨批次共享：模型很容易在相邻考点出同一道题换个数字 */
    const seenStem = new Set();
    let skippedDuplicate = 0;
    let skippedUnjudgeable = 0;

    for (const node of targets) {
      const kid = node.id;
      perKidCount[kid] = 0;

      const examples = db.prepare('SELECT stem, answer FROM questions WHERE kid = ? AND owner_id IS NULL LIMIT 2').all(kid);
      const prompt = buildGeneratePrompt({
        node, examples, fromQ: null, userAnswer: '', errorType: '',
        count: perKid + 2,    // 多要两道当缓冲，理由同单考点接口
        mode,
      });

      let content = '';
      try {
        content = await callLlm(cfg, prompt, { temperature: 0.8 });
      } catch (e) {
        /* ★ 单个考点失败只记一笔，继续跑下一个。
         * 中断整批的话，前面考点已经生成的题也拿不到（因为前端只收到一个错误）。 */
        failed.push({ kid, title: node.title, reason: String(e?.message || e).slice(0, 200) });
        continue;
      }

      const arr = parseJsonArray(content);

      /* 每个考点一个独立事务 */
      const runOne = db.transaction(() => {
        for (const rawQ of arr.slice(0, perKid + 2)) {
          if (perKidCount[kid] >= perKid) break;
          const q = sanitizeGenerated(rawQ, kid);
          if (!q) { skippedUnjudgeable += 1; continue; }
          if (seenStem.has(q.stem) || dupInDb.get(kid, q.stem)) { skippedDuplicate += 1; continue; }
          seenStem.add(q.stem);

          const id = 'g_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
          const row = {
            id, kid, type: q.type, difficulty: q.difficulty, stem: q.stem,
            options: q.options ? JSON.stringify(q.options) : null,
            answer: q.answer, analysis: q.analysis,
            steps: JSON.stringify(q.steps || []),
            sourceType: 'AI 变式', source: 'AI 批量', ownerId: req.userId,
          };
          if (save) ins.run(row);
          perKidCount[kid] += 1;
          created.push({
            id, kid, type: q.type, difficulty: q.difficulty, stem: q.stem,
            options: q.options, answer: q.answer, analysis: q.analysis,
            steps: q.steps, sourceType: 'AI 变式', saved: save,
            typeLabel: TYPE_LABEL[q.type] || q.type,
            selfGraded: SELF_GRADED_TYPES.has(q.type),
          });
        }
      });

      /* 事务本身也可能因为约束冲突抛异常 —— 同样不能让它掀翻整批 */
      try {
        runOne();
      } catch (e) {
        failed.push({ kid, title: node.title, reason: `落库失败：${String(e?.message || e).slice(0, 160)}` });
      }
    }

    return {
      created,
      total: created.length,
      perKid: perKidCount,
      requested: targets.length,
      /* 一个考点都没出来才算失败；出了一部分也返回，前端把已有的显示出来。
       * 全丢的话用户等了两分钟只看到「生成失败」，不知道是模型不行还是网络断了。 */
      ok: created.length > 0,
      failed,
      unknownKids,
      skippedDuplicate,
      skippedUnjudgeable,
    };
  });

  /* ---------- AI 批改（解答题 / 证明题）----------
   *
   * ── 为什么需要它 ────────────────────────────────────────────────
   * 这两种题的答案是一段过程，判题器判不了，所以上一版只能让用户自评。
   * 自评能用，但有个真实的毛病：先看完整参考答案再给自己打分，
   * 人会不自觉地往宽里给 —— 「我思路是对的，只是算错了个符号」，
   * 然后那道题就永远进不了错题本。
   *
   * AI 批改不是**替代**自评，是先给一个外部判断，用户再决定接不接受。
   * 所以这个接口**不写库**：它只返回分数和评语，真正的记账仍然走
   * /api/study/answer（带 selfCorrect）那条唯一的路 ——
   * XP、连击、掌握度、错题本全都只有一处实现。
   */
  fastify.post('/api/ai/grade', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['qid', 'answer'],
        properties: {
          qid: { type: 'string' },
          /* 上限 8000：一道解答题的过程撑死几千字，再多就是误贴了整页笔记 */
          answer: { type: 'string', maxLength: 8000 },
        },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.body.qid);
    if (!q) return reply.code(404).send({ error: '题目不存在' });

    /* ★ 只对解答 / 证明题开放。客观题有确定的答案，
     *   让模型去「批改」它们等于用不确定的东西替换确定的东西。 */
    if (!SELF_GRADED_TYPES.has(q.type)) {
      return reply.code(400).send({ error: '只有解答题和证明题需要 AI 批改，客观题直接判分' });
    }

    const answer = String(req.body.answer ?? '').trim();
    if (!answer) return reply.code(400).send({ error: '先写下你的解答，再让 AI 批改' });

    const steps = parseSteps(q) || [];
    let content = '';
    try {
      /* temperature 压到 0.1：批改要的是稳定 ——
       * 同一份作答连点两次不该给出差很多的分。 */
      content = await callLlm(cfg, buildGradePrompt(q, steps, answer), { temperature: 0.1 });
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }

    const grade = parseGrade(content, steps);
    if (!grade) {
      /* 解析失败**不是错误**，是「这次没批成」。前端据此回退到自评，
       * 所以返回 200 + ok:false，而不是 5xx —— 5xx 会走全局错误提示，
       * 用户看到「出错了」，而实际上功能是可用的（自评那条路还在）。 */
      return { ok: false, parseFailed: true, raw: String(content).slice(0, 400), model: cfg.model };
    }

    return { ok: true, ...grade, model: cfg.model };
  });

  /* ---------- 单题讲解 ----------
   *
   * 和「AI 对话 / 课堂」的区别：这两个是**开放式**的，用户得自己组织问题。
   * 而错题复盘时的问题是固定的：「这题为什么这么做、我卡在哪」。
   * 把这个问法写死进提示词，用户就只需要点一下。
   */
  fastify.post('/api/ai/explain', {
    config: { rateLimit: AI_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['qid'],
        properties: { qid: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = await llmOrError(req);
    if (error) return reply.code(400).send(error);

    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.body.qid);
    if (!q) return reply.code(404).send({ error: '题目不存在' });

    /* 带上学生最近一次的作答和错因 —— 「针对你这一步」比「这道题怎么做」
     * 有用得多，而那需要知道学生写了什么。 */
    const att = db.prepare('SELECT answer, error_type FROM attempts WHERE user_id = ? AND qid = ? ORDER BY ts DESC LIMIT 1')
      .get(req.userId, q.id);
    const errorType = att?.error_type ? (ERROR_TYPES[att.error_type] || att.error_type) : '';

    let text = '';
    try {
      text = await callLlm(cfg, buildExplainPrompt(q, att?.answer ?? '', errorType), { temperature: 0.4 });
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
    return { ok: true, text, model: cfg.model };
  });

  /* ---------- 人格列表 ---------- */
  fastify.get('/api/ai/personas', async () => ({
    personas: Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, desc: p.desc })),
  }));
}


/* ---------- 错因归类用到的三个辅助 ---------- */

/* 单次模型调用的超时。
 *
 * 单考点生成时超时只是「这次没出成题」，重试就行；但批量生成会**串行**跑
 * 十几个考点，一个考点卡死就整批卡死 —— 而 HTTP 客户端那边早就超时断开了，
 * 服务端还在傻等，白占一个连接。所以这个超时是批量接口的**前置条件**，
 * 不是锦上添花。
 *
 * ★ 这个值必须和客户端的请求超时对得上（小程序端见 api/request.ts 的
 *   AI_TIMEOUT = 70 秒，比这里长 10 秒 —— 让服务端先放弃并给出结构化
 *   错误，比客户端先断线、用户只看到「网络失败」要好）。 */
const LLM_TIMEOUT_MS = 60_000;

/**
 * 非流式调用一次模型，返回文本。
 *
 * ── 为什么要统一到这里 ────────────────────────────────────────────
 * 原来有 4 个接口（extract / vision / solve / classroom）各自手写
 * llmFetch：拼 URL、拼 headers、拼 body、判断 res.ok、取 choices[0]。
 * 五段代码几乎一样，但**只有 callLlm 那条路设了超时** —— 另外四处
 * 一旦模型不响应，请求会一直挂着，直到 Node 的 socket 默认超时（几分钟），
 * 期间白占一个连接，而客户端早就断了。
 *
 * 更麻烦的是「加一个参数要改五处」：比如给 solve 加 max_tokens 时，
 * 只有那一处有；下次想给 vision 也加，很容易漏。
 *
 * ── 参数 ────────────────────────────────────────────────────────
 * @param messages 字符串（自动包成单条 user 消息）或多模态消息数组
 * @param maxTokens 不传则用上游默认值
 */
async function callModel(cfg, messages, {
  temperature = 0.2, maxTokens, timeoutMs = LLM_TIMEOUT_MS,
} = {}) {
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;

  const res = await llmFetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      messages: msgs,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    /* 把上游状态码挂到 error 上：调用方偶尔需要区分「模型拒了」
     * 和「网络断了」，但绝大多数地方只是 catch 后回 502。 */
    const e = new Error(`模型返回 ${res.status}${t ? '：' + t.slice(0, 200) : ''}`);
    e.upstreamStatus = res.status;
    throw e;
  }

  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

/** 纯文本的便捷版。绝大多数调用点用它。 */
function callLlm(cfg, prompt, opts = {}) {
  return callModel(cfg, prompt, opts);
}

function buildErrorPrompt(q, myAnswer) {
  return [
    '下面是一道考研数学错题。请判断**错因类别**。',
    '',
    '类别（只能选一个）：',
    '  concept   概念混淆 —— 对定义、定理或条件的理解本身有误',
    '  calc      计算失误 —— 思路正确但算错了',
    '  condition 条件遗漏 —— 漏掉定义域、边界、前提条件',
    '  method    方法不会 —— 完全不知道从哪下手',
    '  misread   审题偏差 —— 看错或误解了题意',
    '  blank     未作答',
    '',
    '判断原则：如果学生的答案显示出**方向性的理解错误**（把可导当成连续、',
    '用错了定理的适用条件、把两个定理记混），一律归为 concept。',
    '宁可判成 concept 也不要轻易判成 calc —— 学生以为自己粗心、',
    '实际是没理解，这种情况在考研数学里极常见，误判成 calc 会让他',
    '继续刷题而不是回去补基础。',
    '',
    '只输出 JSON，不要任何解释文字：',
    '{"errorType":"类别英文名","reason":"不超过 30 字的中文理由"}',
    '',
    `题干：${String(q.stem || '').slice(0, 800)}`,
    `正确答案：${String(q.answer || '').slice(0, 200)}`,
    `学生答案：${String(myAnswer ?? '').slice(0, 200)}`,
    q.analysis ? `解析：${String(q.analysis).slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 概念类错因的图谱联动：往回找 2 层前置，挑出没掌握的那几个。
 *
 * 这是「错因归类」和「知识图谱」真正接上的地方 ——
 * 判成 concept 只是知道了性质，还得知道该补哪一块，否则用户依然无从下手。
 */
function conceptRootHint(userId, kid) {
  const tree = getTree();
  const anc = ancestors(kid, { depth: 2, types: ['prereq'] });

  const candidates = [];
  for (const id of anc.keys()) {
    const node = tree.nodeById.get(id);
    if (!node) continue;
    const m = nodeMastery(userId, id);
    if (m.level === 'proficient' || m.level === 'mastered') continue;
    candidates.push({
      nodeId: id,
      title: node.title,
      level: m.level,
      label: m.label,
      accuracy: Number((m.accuracy || 0).toFixed(3)),
    });
  }
  if (!candidates.length) return null;

  /* 先推「没学过」的，再推「学过但正确率低」的。
   * 顺序反了的话，会把一个 0.3 正确率但已经练过 10 次的节点，
   * 排在完全没学过的基础之前 —— 而后者才是真正卡住他的。 */
  candidates.sort((a, b) => {
    const an = a.level === 'new' ? 0 : 1;
    const bn = b.level === 'new' ? 0 : 1;
    return an - bn || a.accuracy - b.accuracy;
  });

  return {
    message: `这题错在概念上，未必是这道题的问题 —— 建议先回看「${candidates[0].title}」。`,
    candidates: candidates.slice(0, 3),
  };
}

function buildErrorAdvice(rows, judged) {
  if (!judged) {
    return '还没判定过错因。去错题本点一次「分析错因」，才能看出你是真不会还是只是算错。';
  }
  const top = rows[0];
  const pct = Math.round((top.n / judged) * 100);
  const advice = {
    concept: '继续刷题收益很低，该回去补前置知识点了。',
    calc: '知识点是懂的，缺的是熟练度和检查习惯 —— 限时训练最有效。',
    condition: '建议做题时先把定义域和前提条件圈出来再动笔。',
    method: '说明题型见得不够，该看例题总结套路，而不是硬刷。',
    misread: '跟知识无关，把题干读两遍再动笔就能改善大半。',
    blank: '先解决「会不会」的问题，再谈快不快。',
  }[top.type] || '';
  return `${ERROR_TYPES[top.type] || top.type}占 ${pct}%。${advice}`;
}

/* ---------- 变式题生成用到的两个辅助 ---------- */

/**
 * 把模型吐出来的题清洗成「判题器判得了、或者 AI 判得了」的形状。
 *
 * 返回 null 表示这道题作废 —— 宁可少出一道，也不要出一道
 * 用户答对了系统说错的题。
 *
 * 两类题型的底线不一样：
 *   · choice / blank —— 判题器（judge.js）只能比对确定的值，答案形态必须卡死
 *   · solve / proof  —— 判题器不参与，靠 AI 批改或用户自评，
 *     所以**卡的是评分点**：没有评分点的解答题，AI 批改和自评都没有依据
 */
export function sanitizeGenerated(raw, kid) {
  const stem = String(raw?.stem ?? '').trim().slice(0, 800);
  if (stem.length < 5) return null;

  const difficulty = Math.min(4, Math.max(1, Number(raw?.difficulty) || 2));
  const analysis = String(raw?.analysis ?? '').trim().slice(0, 1500);
  const type = QUESTION_TYPES.includes(raw?.type) ? raw.type : 'choice';

  /* ---------- 解答题 / 证明题 ---------- */
  if (SELF_GRADED_TYPES.has(type)) {
    const answer = String(raw?.answer ?? '').trim().slice(0, 2000);
    /* 和手工录题共用同一套判据（answerIssue）—— 两处各写一份迟早改歪一边 */
    if (answerIssue(type, answer)) return null;

    const steps = (Array.isArray(raw?.steps) ? raw.steps : [])
      .map((s) => ({
        t: String(s?.t ?? '').trim().slice(0, 500),
        pts: Math.max(0, Math.min(20, Math.round(Number(s?.pts) || 0))),
      }))
      .filter((s) => s.t);
    /* 少于两条评分点的解答题没有价值：一条评分点的「分步给分」等于不分步，
     * 而 AI 批改也没法指出「卡在哪一步」。 */
    if (steps.length < 2) return null;
    /* 每步都要有分值，否则满分是 0，批改出来的 ratio 没有意义 */
    if (steps.every((s) => s.pts === 0)) return null;

    return { kid, type, difficulty, stem, options: null, answer, analysis, steps };
  }

  /* ---------- 客观题 ---------- */
  const normType = type === 'blank' ? 'blank' : 'choice';

  if (normType === 'choice') {
    const opts = Array.isArray(raw?.options) ? raw.options : [];
    const clean = opts
      .map((o, i) => ({
        k: String(o?.k ?? 'ABCD'[i] ?? '').trim().toUpperCase().slice(0, 1),
        t: String(o?.t ?? '').trim().slice(0, 300),
      }))
      .filter((o) => o.k && o.t);
    /* 必须正好四个选项且键是 ABCD —— 三个选项或 E 选项都会让前端渲染错位 */
    if (clean.length !== 4 || clean.map((o) => o.k).join('') !== 'ABCD') return null;
    const answer = String(raw?.answer ?? '').trim().toUpperCase().slice(0, 1);
    if (!'ABCD'.includes(answer)) return null;
    return { kid, type: 'choice', difficulty, stem, options: clean, answer, analysis, steps: null };
  }

  /* 填空题：先做能救的规范化（\frac{1}{2}→1/2、x=2→2），再过共用的判据。
   * 判据本体在 judge.js 的 answerIssue —— 手工录题走的是同一个函数，
   * 两处各写一份正则迟早会改歪一边。 */
  const answer = normalizeAnswer(String(raw?.answer ?? '').slice(0, 200));
  if (answerIssue('blank', answer)) return null;

  return { kid, type: 'blank', difficulty, stem, options: null, answer, analysis, steps: null };
}

/**
 * 出题提示词。
 *
 * mode 决定出哪一类题，两类的「硬性要求」完全不同：
 *   objective  客观题 —— 必须能被判题器自动判分（确定的值）
 *   subjective 主观题 —— 判题器不参与，靠 AI 批改/自评，
 *              所以硬性要求变成「必须给参考解答 + 可逐条判断的评分点」
 *   mixed      各出一半
 *
 * ★ 主观题以前是被**明确禁止**的（老版本这里写着「禁止证明题」），
 *   因为判题器判不了。有了 AI 批改之后这条禁令可以放开 ——
 *   但放开的是「能不能判」，不是「好不好判」：答案不唯一、需要画图的题
 *   仍然禁止，AI 也给不出稳定的分。
 */
function buildGeneratePrompt({ node, examples, fromQ, userAnswer, errorType, count, mode = 'objective' }) {
  const wantSubjective = mode === 'subjective' || mode === 'mixed';
  const wantObjective = mode === 'objective' || mode === 'mixed';

  const requirement = (() => {
    const lines = [];
    if (mode === 'mixed') {
      lines.push(`1. 出 ${Math.ceil(count / 2)} 道客观题（choice / blank），其余出主观题（solve / proof）。`);
    }
    if (wantObjective) {
      lines.push(
        '【客观题】必须能被程序自动判分：',
        '  - choice：四选一，选项键固定为 A / B / C / D，answer 写选项字母',
        '  - blank：填空题，answer 必须是**一个确定的数值**',
        '  - 填空题的 answer 只写值本身：写 1/2，不要写 \\frac{1}{2}；写 2，不要写 x=2',
        '  - 填空题的 answer 只能是整数、分数或小数；含根号、π 或字母时改用 choice 出',
      );
    }
    if (wantSubjective) {
      lines.push(
        '【主观题】必须能被逐条给分，所以**必须**给参考解答和评分点：',
        '  - solve：解答题（求值、求极限、解方程、算积分这类）',
        '  - proof：证明题（证明不等式、存在性、单调性这类）',
        '  - answer 写**参考解答**（结论 + 关键中间结果），不要只写一个数字',
        '  - steps 写 3~5 条评分点，每条是一句能独立判断对错的话，pts 是该条的分数',
        '  - 评分点要按**解题步骤**切，不要按「思路分 / 计算分」这种笼统维度切',
        '  - 仍然禁止：答案不唯一的题、需要画图的题、要查表的题',
      );
    }
    return lines;
  })().map((l, i) => `${i + 1}. ${l.replace(/^\d+\. /, '')}`).join('\n');

  const shapes = [];
  if (wantObjective) {
    shapes.push('{"type":"choice","difficulty":3,"stem":"题干","options":[{"k":"A","t":"选项"},{"k":"B","t":"选项"},{"k":"C","t":"选项"},{"k":"D","t":"选项"}],"answer":"A","analysis":"解析"}');
    shapes.push('{"type":"blank","difficulty":3,"stem":"题干","answer":"1/2","analysis":"解析"}');
  }
  if (wantSubjective) {
    shapes.push('{"type":"solve","difficulty":3,"stem":"题干","answer":"参考解答：……","analysis":"思路要点","steps":[{"t":"写出导数定义式","pts":4},{"t":"正确求导并化简","pts":4},{"t":"代值得到结论","pts":2}]}');
  }

  return [
    '你在为一名备战考研数学的学生出**变式练习题**。',
    '',
    `【考点】${node.title}`,
    node.content ? `【考点内容】\n${String(node.content).slice(0, 1200)}` : '',
    examples.length
      ? `【参考例题 —— 模仿它的风格和难度，但必须换数字或换问法，不能照抄】\n${
        examples.map((e) => `题干：${e.stem}\n答案：${e.answer}`).join('\n\n')}`
      : '',
    fromQ
      ? [
        '【学生刚做错的题】',
        `题干：${String(fromQ.stem).slice(0, 500)}`,
        `正确答案：${String(fromQ.answer).slice(0, 200)}`,
        `学生答案：${String(userAnswer ?? '（未作答）').slice(0, 200)}`,
        errorType ? `错因：${ERROR_TYPES[errorType] || errorType}` : '',
        '',
        '请针对这个错误点出变式题 —— 换一组数字或换一种问法，但考同一个方法。',
        '如果错因是「概念混淆」，就出能暴露这个概念边界的题。',
      ].filter(Boolean).join('\n')
      : '',
    '',
    `【数量】${count} 道，难度递进。`,
    '',
    '【硬性要求 —— 违反则整题作废】',
    requirement,
    '数学公式用 LaTeX，行内 $...$。',
    '',
    '只输出 JSON 数组，不要任何解释文字、不要 markdown 代码块：',
    `[${shapes.join(',')}]`,
  ].filter(Boolean).join('\n');
}
