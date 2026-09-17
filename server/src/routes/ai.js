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
    const l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(req.userId);
    const cfg = l ? resolveLlm(l) : null;

    if (!cfg || !cfg.base || !cfg.model || (l.kind === 'cloud' && !cfg.key)) {
      return reply.code(400).send({
        error: '还没配置模型。去「设置 → 模型接入」填 Base URL 和模型名。',
        code: 'NO_LLM',
      });
    }

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
    const l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(req.userId);
    const cfg = l ? resolveLlm(l) : null;
    if (!cfg || !cfg.base || !cfg.model) {
      return reply.code(400).send({ error: '还没配置模型', code: 'NO_LLM' });
    }

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
    const l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(req.userId);
    const cfg = l ? resolveLlm(l) : null;
    if (!cfg || !cfg.base || !cfg.model) {
      return reply.code(400).send({ error: '还没配置模型', code: 'NO_LLM' });
    }

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
