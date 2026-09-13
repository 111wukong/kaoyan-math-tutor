/* 研数 · 讨论模式（零依赖）
 *
 * 一个老师 + 三个水平不同的学生，围绕你做错过的题掰扯一轮，最后老师点名点评。
 *
 * 生成策略（混合）：
 *   · 老师抛题 + 老师总结 —— 真调用，吃你的真实学情
 *   · 三个学生的发言 —— 一次生成（结构化 JSON），省延迟
 *
 * 角色不靠"形容词"区分，靠三样东西：
 *   1) 信息可见性递减：甲看完整正文+例题+关联，乙看正文+例题，丙只给一句定义
 *   2) 错误来源真实：丙犯的错从题库干扰项和你的错题记录里挖，不是随机编
 *   3) 发言顺序强制回应：第 2 轮起必须回应前面人的话
 */
window.Discuss = (function () {
  'use strict';

  var ROLES = {
    teacher: { key: 'teacher', name: '老师', avatar: '师', tag: '' },
    smart: { key: 'smart', name: '学生甲', avatar: '甲', tag: '思路快' },
    average: { key: 'average', name: '学生乙', avatar: '乙', tag: '中等' },
    weak: { key: 'weak', name: '学生丙', avatar: '丙', tag: '基础薄弱' },
    me: { key: 'me', name: '我', avatar: '我', tag: '' }
  };

  var TURN_ORDER = ['smart', 'average', 'weak', 'smart'];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function findQuestion(ctx, kid, qid) {
    var qs = ctx.questionsOf(kid) || [];
    for (var i = 0; i < qs.length; i++) { if (qs[i].id === qid) return qs[i]; }
    return null;
  }

  /* ---------------- 选题：本地算，不花模型调用 ---------------- */
  function pickTopic(ctx, kid) {
    // 1) 优先挑你错过次数最多的题
    var mistakes = ctx.mistakeCards();
    if (kid) {
      var own = mistakes.filter(function (m) { return m.kid === kid; });
      if (own.length) mistakes = own;
    }
    mistakes.sort(function (a, b) { return (b.lapses || 0) - (a.lapses || 0); });

    for (var i = 0; i < mistakes.length; i++) {
      var q = findQuestion(ctx, mistakes[i].kid, mistakes[i].qid);
      if (q) {
        return {
          kid: mistakes[i].kid,
          title: mistakes[i].title,
          question: q,
          reason: '这道题你错过 ' + (mistakes[i].lapses || 1) + ' 次',
          source: 'mistake'
        };
      }
    }

    // 2) 次选：正确率最低的考点里抽一题
    var weak = ctx.weakNodes(6);
    for (var j = 0; j < weak.length; j++) {
      var qs = ctx.questionsOf(weak[j].kid);
      if (qs.length) {
        return {
          kid: weak[j].kid,
          title: weak[j].title,
          question: qs[Math.floor(Math.random() * qs.length)],
          reason: '这个考点你的正确率只有 ' + weak[j].accuracy + '%',
          source: 'weak'
        };
      }
    }

    // 3) 兜底：当前考点随便来一道
    var pool = ctx.questionsOf(kid);
    if (pool.length) {
      return {
        kid: kid,
        title: (ctx.node(kid) || {}).title || kid,
        question: pool[Math.floor(Math.random() * pool.length)],
        reason: '这个考点值得掰扯一下',
        source: 'current'
      };
    }
    return null;
  }

  /* ---------------- 从干扰项里挖"真实的错误思路" ---------------- */
  function misconceptions(ctx, topic) {
    var out = [];
    var q = topic.question;
    if (!q) return out;

    if (q.type === 'choice' && q.options && q.options.length) {
      var wrong = q.options.filter(function (o) { return o.k !== q.answer; });
      if (wrong.length) {
        out.push('这道题的干扰项（代表真实的错误思路）：' +
          wrong.map(function (o) { return o.k + '. $' + o.t + '$'; }).join('、') +
          '。正确答案是 ' + q.answer + '。');
      }
    }
    if (q.analysis) out.push('标准解析里点出的关键：' + q.analysis);

    // 该生在本考点真实做错过的题
    var ms = ctx.mistakeCards().filter(function (m) { return m.kid === topic.kid; });
    if (ms.length > 1) {
      out.push('该生在这个考点上累计错了 ' + ms.length + ' 道题，说明不是偶然。');
    }
    return out;
  }

  /* ---------------- prompt：生成讨论 ---------------- */
  function buildDiscussPrompt(topic, ctx) {
    var n = ctx.node(topic.kid) || {};
    var q = topic.question || {};
    var misc = misconceptions(ctx, topic);

    var qText = String(q.stem || '');
    if (q.type === 'choice' && q.options) {
      qText += '\n' + q.options.map(function (o) { return o.k + '. $' + o.t + '$'; }).join('\n');
    }

    return [
      '你正在编排一场考研数学学习小组的讨论。三个学生水平不同，你必须让他们的发言**真实分化、互相碰撞**。',
      '',
      '【讨论的题目】',
      qText,
      '',
      '【三个学生 —— 注意他们掌握的信息量是递减的】',
      '- **学生甲**（思路快）：掌握这个考点的完整定义、例题，还知道它和哪些考点关联。发言干脆，爱把规律总结成一句话。',
      '- **学生乙**（中等）：学过定义和例题，能做常规题，但说不清"为什么"。爱追问原理。',
      '- **学生丙**（基础薄弱）：**只记得这个考点的第一句定义**，其余全模糊。口语化，会用错术语，容易想当然。',
      '',
      misc.length ? '【学生丙的错误必须来自这里，不要另编】\n' + misc.map(function (m) { return '- ' + m; }).join('\n') : '',
      '',
      '【本考点的正文（供你判断谁说得对）】',
      String(n.content || ''),
      n.example ? '\n例题：' + n.example : '',
      '',
      '【硬性要求】',
      '1. 共 4 轮发言，顺序固定：学生甲 → 学生乙 → 学生丙 → 学生甲',
      '2. 每人 80-150 字，**口语化**，像微信群里真人聊天，不要书面语',
      '3. 第 2 轮起必须回应前面人的话（"你刚才说……"），禁止各说各的',
      '4. 学生丙要真的犯上面列出的错，而且要错得"有道理"——体现出他的推理过程',
      '5. 学生甲最后一轮要纠正学生丙，明确指出他错在哪一步',
      '6. 禁止客套话（"说得好""有道理"），禁止出现"作为 AI"这类表述',
      '7. 数学公式用 LaTeX：行内 $...$',
      '8. **只输出 JSON，不要任何解释文字、不要 markdown 代码块之外的内容**',
      '',
      '【输出格式】',
      '{"topic":"老师抛给小组的问题，一句话，要具体到这道题","turns":[{"role":"smart","text":"..."},{"role":"average","text":"..."},{"role":"weak","text":"..."},{"role":"smart","text":"..."}]}'
    ].filter(Boolean).join('\n');
  }

  function parseDiscussion(text) {
    var s = String(text || '').trim();
    var m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) s = m[1].trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);

    var j;
    try { j = JSON.parse(s); } catch (e) {
      throw new Error('讨论生成失败：模型没有返回合法 JSON');
    }
    var turns = (j.turns || []).filter(function (t) {
      return t && ROLES[t.role] && t.role !== 'teacher' && String(t.text || '').trim();
    }).map(function (t) {
      return { role: t.role, text: String(t.text).trim() };
    });
    if (!turns.length) throw new Error('讨论生成失败：没有有效的学生发言');
    return { topic: String(j.topic || '').trim(), turns: turns };
  }

  /* ---------------- 调用 1：老师抛题 + 学生讨论 ---------------- */
  async function generate(topic, ctx) {
    var conf = ctx.llmConf();
    if (!conf) throw new Error('未配置模型，讨论模式需要真实 AI');

    var messages = [
      { role: 'system', content: buildDiscussPrompt(topic, ctx) },
      { role: 'user', content: '开始这场讨论，只输出 JSON。' }
    ];
    var res = await LLM.chat(conf, messages, {
      stream: false,
      temperature: 0.85,
      maxTokens: 1600
    });
    var parsed = parseDiscussion(res.content);
    if (!parsed.topic) parsed.topic = topic.title + '：这道题该怎么做？';
    return parsed;
  }

  /* ---------------- 调用 2：老师点评总结 ---------------- */
  async function summarize(session, ctx, onDelta) {
    var conf = ctx.llmConf();
    if (!conf) throw new Error('未配置模型');

    var n = ctx.node(session.kid) || {};
    var record = session.turns.map(function (t) {
      return ROLES[t.role].name + '：' + t.text;
    }).join('\n\n');

    var userPart = '';
    if (session.userTurns && session.userTurns.length) {
      userPart = '\n\n【这名学生本人在讨论中说过的话】\n' +
        session.userTurns.map(function (u) { return '学生本人：' + u.text; }).join('\n');
    }

    var sys = [
      '你是一位考研数学老师，刚旁观了三个学生的讨论，现在要给出课后点评。',
      '',
      '【讨论的题目】',
      String((session.question && session.question.stem) || ''),
      '',
      '【讨论记录】',
      record + userPart,
      '',
      '【这名学生的学情】',
      Agent.learningProfile(ctx, session.kid),
      '',
      '【本考点正文（你的判断依据）】',
      String(n.content || ''),
      '',
      '【任务】写一段课后点评，必须包含三部分：',
      '1. **点名点评** —— 三个学生谁说得对、谁错在哪一步。直接点名（"学生丙把……搞混了"），不要笼统说"大家"。如果学生本人参与了讨论，也要点评他。',
      '2. **补漏** —— 讨论里没讲透的关键点，你补上。',
      '3. **必记结论** —— 把这个考点收敛成 2-3 条考场上能直接用的结论。',
      '',
      '【格式】Markdown，250-400 字。数学公式用 LaTeX。语气像老师下课后随口点评，别写成论文。不要重复学生已经说清楚的内容。'
    ].join('\n');

    var res = await LLM.chat(conf, [
      { role: 'system', content: sys },
      { role: 'user', content: '给出你的点评。' }
    ], {
      stream: true,
      temperature: 0.5,
      onDelta: function (d, full) { if (onDelta) onDelta(full); }
    });
    return res.content;
  }

  /* ---------------- 用户插话：老师以主持人身份回应 ---------------- */
  async function replyToUser(session, userText, ctx, onDelta) {
    var conf = ctx.llmConf();
    if (!conf) throw new Error('未配置模型');

    var record = session.turns.map(function (t) {
      return ROLES[t.role].name + '：' + t.text;
    }).join('\n\n');

    var sys = [
      '你是一位考研数学老师，正在主持一场三个学生的学习讨论。学生本人刚刚插话了。',
      '',
      '【讨论记录】',
      record,
      '',
      '【学生本人说】',
      userText,
      '',
      '【任务】',
      '1. 先直接回应他的话 —— 对就肯定（并补一句为什么对），错就指出错在哪一步。',
      '2. 如果需要，把话题拉回这道题上。',
      '3. 150-250 字，Markdown，公式用 LaTeX。口语化，别打官腔。',
      '4. 不要重复三个学生已经说过的话。'
    ].join('\n');

    var res = await LLM.chat(conf, [
      { role: 'system', content: sys },
      { role: 'user', content: userText }
    ], {
      stream: true,
      temperature: 0.5,
      onDelta: function (d, full) { if (onDelta) onDelta(full); }
    });
    return res.content;
  }

  return {
    ROLES: ROLES,
    TURN_ORDER: TURN_ORDER,
    pickTopic: pickTopic,
    generate: generate,
    summarize: summarize,
    replyToUser: replyToUser,
    parseDiscussion: parseDiscussion,
    buildDiscussPrompt: buildDiscussPrompt,
    sleep: sleep
  };
})();
