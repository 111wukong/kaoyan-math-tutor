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
import { resolveLlm } from './misc.js';
import { buildSnapshot, nodeMastery, getTree } from '../lib/game.js';
import { ancestors } from '../lib/graph.js';
import { answerIssue, normalizeAnswer } from '../lib/judge.js';

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
function llmOrError(req) {
  const l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(req.userId);
  const cfg = l ? resolveLlm(l) : null;
  /* 云端必须带密钥；本地（LM Studio / Ollama）不需要。 */
  const missingKey = l?.kind === 'cloud' && !cfg?.key;

  if (!cfg || !cfg.base || !cfg.model || missingKey) {
    return {
      error: {
        error: missingKey
          ? '云端模型还没填 API Key。去「设置 → 模型接入」补上，或者切到本地模型。'
          : '还没配置模型。去「设置 → 模型接入」填 Base URL 和模型名。',
        code: 'NO_LLM',
      },
    };
  }
  return { cfg };
}

export default async function aiRoutes(fastify) {
  /* ---------- 流式对话 ---------- */
  fastify.post('/api/ai/chat', {
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
    const { cfg, error } = llmOrError(req);
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
      upstream = await fetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
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
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' }, kid: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = llmOrError(req);
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
      const res = await fetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          stream: false,
        }),
      });
      if (!res.ok) return reply.code(res.status).send({ error: `模型返回 ${res.status}` });
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content || '';
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
      return reply.code(502).send({ error: e.message });
    }
  });

  /* ---------- 多智能体课堂 ----------
   * 老师 + 三个学生各错各的。这里不用流式：一轮要返回结构化的
   * { board, turns, prompt }，半截 JSON 在前端没法用。
   */
  fastify.post('/api/ai/classroom', {
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
        },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = llmOrError(req);
    if (error) return reply.code(400).send(error);

    const { kid, mode = 'lesson', userInput = '', history = [], round = 0 } = req.body;
    const tree = getTree();
    const node = kid ? tree.nodeById.get(kid) : null;
    const snap = buildSnapshot(req.userId);

    const prompt = [
      '你正在编排一堂考研数学小班课。角色固定为四个人：',
      '',
      '- 老师：主讲。一次只讲一个点，绝不超过 120 字，讲完必须抛一个问题给学生。',
      '- 小明：基础薄弱。他的错误必须是**概念性**的（比如把可导和连续混为一谈）。',
      '- 小红：中等水平。她的问题必须是**计算细节**上的（比如漏了定义域、符号写错）。',
      '- 小刚：学得快。他负责**追问本质**（比如「这个定理去掉某个条件还成立吗」）。',
      '',
      '铁律：三个人不许都说"我懂了"。必须各错各的，错法互不重复。',
      '',
      mode === 'discuss'
        ? '【课堂形式】研讨课 —— 老师只抛问题、不先给结论；先让三个学生各自尝试，把分歧暴露出来，最后由老师收口。'
        : '【课堂形式】讲授 + 问答 —— 老师先讲一个点，学生随后提问或犯错，老师再纠正。',
      '',
      node ? `【本课知识点】${node.title}\n${String(node.content || '').replace(/\\n\\n/g, '\n').slice(0, 900)}` : '',
      '',
      `【学生学情】已学 ${snap.learned}/${snap.total} 个考点，错题 ${snap.wrong} 道，连续打卡 ${snap.streak} 天。`,
      round > 0 ? `【当前轮次】第 ${round + 1} 轮 —— 承接上一轮，不要重复已讲过的内容。` : '【当前轮次】第 1 轮 —— 先建立直觉。',
      userInput ? `【学生本人插话】${userInput}\n老师必须回应这句话。` : '',
      history.length ? `【已有对话】\n${history.slice(-8).map((t) => `${t.name}：${t.text}`).join('\n')}` : '',
      '',
      '输出严格的 JSON（不要 markdown 代码块，不要任何解释文字）：',
      '{"board":["板书步骤1","板书步骤2"],"turns":[{"role":"teacher|xiaoming|xiaohong|xiaogang","name":"老师|小明|小红|小刚","text":"发言内容"}],"prompt":"留给学生本人的问题"}',
      '',
      '要求：turns 3-5 条；board 2-4 条且是**数学步骤**（可含 LaTeX，用 $...$ 包裹），不是标题；prompt 是一个具体的问题。',
    ].filter(Boolean).join('\n');

    /* 网络失败要单独 catch：fetch 连不上时 e.message 就是一句
     * "fetch failed"（undici 的原始措辞），直接回给前端等于没说。
     * 以前这里和答疑接口不一致 —— 那边有「连不上模型服务：」前缀，这边没有，
     * 同一个故障用户看到两种说法。现在统一。
     * 也不能把整段 try 的 catch 都加上这个前缀：那会把「上游返回了坏 JSON」
     * 这类错误也说成「连不上」，反而误导。 */
    let res;
    try {
      res = await fetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.75,
          stream: false,
        }),
      });
    } catch (e) {
      return reply.code(502).send({ error: `连不上模型服务：${e.message}` });
    }

    try {
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return reply.code(res.status).send({ error: `模型返回 ${res.status}：${t.slice(0, 200)}` });
      }
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content || '';
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

      return {
        turns,
        board: (parsed.board || []).slice(0, 5).map((b) => String(b).slice(0, 400)),
        prompt: String(parsed.prompt || '').slice(0, 300),
        round,
      };
    } catch (e) {
      return reply.code(502).send({ error: e.message });
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
    const { cfg, error } = llmOrError(req);
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
    schema: {
      body: {
        type: 'object',
        properties: { limit: { type: 'integer' }, kid: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = llmOrError(req);
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
    schema: {
      body: {
        type: 'object',
        required: ['kid'],
        properties: {
          kid: { type: 'string' },
          count: { type: 'integer' },
          fromQid: { type: 'string' },
          save: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { cfg, error } = llmOrError(req);
    if (error) return reply.code(400).send(error);

    const { kid, fromQid, save = true } = req.body;
    const count = Math.min(5, Math.max(1, Number(req.body?.count) || 3));

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

    const prompt = buildGeneratePrompt({ node, examples, fromQ, userAnswer, errorType, count });

    let content = '';
    try {
      content = await callLlm(cfg, prompt, { temperature: 0.8 });
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }

    const arr = parseJsonArray(content);
    const dupInDb = db.prepare('SELECT 1 FROM questions WHERE kid = ? AND stem = ? LIMIT 1');
    const ins = db.prepare(`INSERT INTO questions (id,kid,type,difficulty,stem,options,answer,analysis,source_type,source_year,source,owner_id)
      VALUES (@id,@kid,@type,@difficulty,@stem,@options,@answer,@analysis,@sourceType,NULL,@source,@ownerId)`);

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
          sourceType: 'AI 变式',
          source: 'AI 生成',
          ownerId: req.userId,
        };
        if (save) ins.run(row);
        created.push({ id, kid, type: q.type, difficulty: q.difficulty, stem: q.stem, options: q.options, answer: q.answer, analysis: q.analysis, sourceType: 'AI 变式', saved: save });
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

  /* ---------- 人格列表 ---------- */
  fastify.get('/api/ai/personas', async () => ({
    personas: Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, desc: p.desc })),
  }));
}

/* ---------- 课堂发言的归一化 ----------
 * 提示词里把 role 写成了枚举 "teacher|xiaoming|xiaohong|xiaogang"，
 * 但 9B 级别的小模型基本不听这一条，实测会给出：
 *   · role 写成中文（"老师" / "小明"）
 *   · 干脆不给 role，只给 name
 *   · turns 直接写成字符串数组（"小明：是 0 吧"）
 * 以前这三种都兜成 teacher，而前端是 `ROLES[turn.role] || ROLES.teacher` 取样式的 ——
 * 于是四个人全长成老师的样子，「三个学生各错各的」这个核心卖点直接看不出来。
 * 这里做宽容归一化：宁可按名字猜，也别把四个角色压成一个。
 */
const ROLE_BY_KEY = {
  teacher: 'teacher', 老师: 'teacher', 教师: 'teacher', 讲师: 'teacher',
  xiaoming: 'xiaoming', 小明: 'xiaoming',
  xiaohong: 'xiaohong', 小红: 'xiaohong',
  xiaogang: 'xiaogang', 小刚: 'xiaogang',
};
const NAME_BY_ROLE = { teacher: '老师', xiaoming: '小明', xiaohong: '小红', xiaogang: '小刚' };

function normRole(t) {
  const key = String(t.role ?? '').trim().toLowerCase();
  if (ROLE_BY_KEY[key]) return ROLE_BY_KEY[key];
  const byName = ROLE_BY_KEY[String(t.name ?? '').trim()];
  if (byName) return byName;
  return 'teacher';
}

function normalizeTurns(list) {
  return list.slice(0, 6).map((t) => {
    // 字符串形式："小明：是 0 吧" —— 按第一个全角/半角冒号切开，前缀当名字
    if (typeof t === 'string') {
      const s = t.trim();
      const m = s.match(/^([^：:]{1,8})[：:]\s*(.+)$/);
      const role = m ? (ROLE_BY_KEY[m[1].trim()] || 'teacher') : 'teacher';
      return { role, name: NAME_BY_ROLE[role], text: (m ? m[2] : s).slice(0, 1200) };
    }
    const role = normRole(t || {});
    return {
      role,
      name: NAME_BY_ROLE[role] || String(t?.name || '老师').slice(0, 20),
      text: String(t?.text || '').slice(0, 1200),
    };
  }).filter((t) => t.text);
}

/* 模型经常把 JSON 包在 ```json 里，或者前后加一句话 —— 这里宽容地把它抠出来 */
function parseJsonArray(content) {
  const s = String(content || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 同样的宽容策略，针对对象 */
function parseJsonObject(content) {
  const s = String(content || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // 模型偶尔会在 JSON 里留尾逗号，兜一次
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/* ---------- 错因归类用到的三个辅助 ---------- */

/** 非流式调用一次模型，只取文本。三处（extract / 课堂 / 错因）共用。 */
async function callLlm(cfg, prompt, { temperature = 0.2 } = {}) {
  const res = await fetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      stream: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型返回 ${res.status}：${t.slice(0, 200)}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
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
 * 把模型吐出来的题清洗成「判题器判得了」的形状。
 *
 * 返回 null 表示这道题作废 —— 宁可少出一道，也不要出一道
 * 用户答对了系统说错的题。判题器（judge.js）只能比对确定的值：
 * 选择题比字母，填空题归一化后比数值/表达式。
 */
export function sanitizeGenerated(raw, kid) {
  const stem = String(raw?.stem ?? '').trim().slice(0, 800);
  if (stem.length < 5) return null;

  const difficulty = Math.min(4, Math.max(1, Number(raw?.difficulty) || 2));
  const analysis = String(raw?.analysis ?? '').trim().slice(0, 1500);
  const type = raw?.type === 'blank' ? 'blank' : 'choice';

  if (type === 'choice') {
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
    return { kid, type, difficulty, stem, options: clean, answer, analysis };
  }

  /* 填空题：先做能救的规范化（\frac{1}{2}→1/2、x=2→2），再过共用的判据。
   * 判据本体在 judge.js 的 answerIssue —— 手工录题走的是同一个函数，
   * 两处各写一份正则迟早会改歪一边。 */
  const answer = normalizeAnswer(String(raw?.answer ?? '').slice(0, 200));
  if (answerIssue('blank', answer)) return null;

  return { kid, type, difficulty, stem, options: null, answer, analysis };
}

function buildGeneratePrompt({ node, examples, fromQ, userAnswer, errorType, count }) {
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
    '1. 必须能被程序自动判分。只出两种题型：',
    '   - choice：四选一，选项键固定为 A / B / C / D，answer 写选项字母',
    '   - blank：填空题，answer 必须是**一个确定的数值或简单表达式**',
    '2. 禁止证明题、讨论题、答案不唯一的题、需要画图的题。',
    '3. 填空题的 answer 只写值本身：写 1/2，不要写 \\frac{1}{2}；写 2，不要写 x=2。',
    '4. 填空题的 answer 只能是**整数、分数或小数**（如 2、-1/2、0.5）。',
    '   答案里含根号、π 或字母时，请改用选择题出 —— 填空题判不了这些，会误判。',
    '5. 数学公式用 LaTeX，行内 $...$。',
    '',
    '只输出 JSON 数组，不要任何解释文字、不要 markdown 代码块：',
    '[{"type":"choice","difficulty":3,"stem":"题干","options":[{"k":"A","t":"选项"},{"k":"B","t":"选项"},{"k":"C","t":"选项"},{"k":"D","t":"选项"}],"answer":"A","analysis":"解析"},'
      + '{"type":"blank","difficulty":3,"stem":"题干","answer":"1/2","analysis":"解析"}]',
  ].filter(Boolean).join('\n');
}
