/* 课堂阶段状态机
 *
 * ── 为什么从 routes/ai.js 拆出来 ──────────────────────────────────
 * 这段是**纯逻辑**：给定一句话和上一轮阶段，算出这一轮该处于哪个阶段、
 * 该拼什么提示词、模型越界时怎么拦。它不查库、不发请求、不碰 fastify。
 * 原来它和 13 个路由挤在同一个 1968 行的文件里，改一个关键词正则
 * 要在两百行之外的地方翻半天，而且看代码的人分不清「这是路由的规矩
 * 还是状态机的规矩」。
 *
 * 拆出来之后 tests/classroom.mjs 可以直接 import 这个文件，
 * 不再需要为了拿几个纯函数而连带加载整个 AI 路由（那会打开数据库）。
 */

/* ============================================================
   课堂阶段状态机
   ============================================================
   五个阶段，各有各的「谁能说话」和「结尾留什么」：

     lecture   首轮建地基。老师必须把理论**讲透**（定义 / 直观 / 条件 / 误区），
               允许长发言；学生错在「听完这段最容易产生的误解」上。
     explain   常规讲授与答疑。原来那套：老师讲一个点，学生插话，老师纠正。
     clarify   ★ 学生说了「不知道」。三个学生全部静默，老师换角度重讲，
               结尾只确认理解、**不出题**。
     practice  学生说「跟上了」。出一道小题验收。
     discuss   研讨课。老师只抛问题，学生先各试各的。

   为什么要做成显式状态，而不是每轮重新「看心情」：
     模型除了对话历史之外不持有任何状态。如果每轮都把全部规则平铺给它，
     它会在「学生说不知道」的下一轮，按「每轮要留一道题」的惯性继续出题 ——
     用户看到的就是「我都说不会了，你还让我算」。
     状态由服务端拿着，提示词只描述**当前这一个状态**该干什么，
     模型就没有机会把别的状态的规则串过来。
   ============================================================ */

/* 意图分类用的三个关键词族。
 *
 * 顺序有意义，而且不能反：**先判困惑，再判懂了**。
 * 因为「听不懂」「没听懂」里都带一个「懂」字 —— 先判「懂了」的话，
 * 「我还是没听懂」会被归成「听懂了」，然后下一轮直接甩一道题出来。
 * 那正是要修的毛病本身。
 *
 * 也不做「整句相等」的匹配：真实输入是「这个我真不知道…」「哎不懂啊」，
 * 用锚定写法（^…$）会全部漏掉。宁可宽一点 —— 宽了最多是多讲一遍，
 * 窄了会把「没懂」当成「懂了」。 */
const CONFUSED_RE = /不知道|不清楚|不明白|不理解|没懂|没听懂|听不懂|不懂|不会做|不会|跟不上|没跟上|太快|再说一遍|再讲一遍|重新讲|重讲|没思路|卡住|卡在|蒙|懵|晕|搞不清|\?\?\?|？？？/;
const UNDERSTOOD_RE = /懂了|明白了|理解了|会了|清楚了|跟上了|知道了|有感觉|原来如此|可以了|没问题了|继续吧|下一题/;
const QUESTION_RE = /[?？]|为什么|怎么|如何|是否|能否|是不是|能不能|什么是|什么意思|啥意思|凭什么/;

/**
 * 判断学生这句话属于哪一类。
 * @returns {'confused'|'understood'|'question'|'other'|'none'}
 */
export function classifyIntent(text) {
  const s = String(text ?? '').trim();
  if (!s) return 'none';
  if (CONFUSED_RE.test(s)) return 'confused';
  if (UNDERSTOOD_RE.test(s)) return 'understood';
  /* 提问排在「其他」之前，这一条在 clarify 阶段特别关键：
   * 「我还是想问一下为什么这里要加条件？」既不含困惑词、也不含「懂了」，
   * 归成 other 的话阶段机会认为他做出了实质回应，于是推去练习 ——
   * 又变成「人家还在问，你就让他算」。归成 question 就继续答疑。 */
  if (QUESTION_RE.test(s)) return 'question';
  return 'other';
}

/**
 * 推演本轮阶段。
 *
 * prevPhase 由前端带上来（它手里有完整的对话）。不依赖它也能跑 ——
 * 只是在「答疑阶段学生又问了一句」这种承接场景下会退化成常规讲授，
 * 学生就会重新开始提问。
 */
export function resolvePhase({ round = 0, mode = 'lesson', intent = 'none', prevPhase = '' }) {
  if (mode === 'discuss') return 'discuss';
  if (intent === 'confused') return 'clarify';
  if (intent === 'understood') return 'practice';
  if (intent === 'question') return prevPhase === 'clarify' ? 'clarify' : 'explain';
  /* 在答疑阶段里给出了**实质回应**（既不是提问、也不是「不知道」）——
   * 这时候才有资格进入练习。
   *
   * 注意这里必须是 `intent === 'other'`，不能写成「prevPhase 是 clarify 就推练习」：
   * 用户点了「继续」但一个字没打（intent = none）时，如果也推进到 practice，
   * 就变成「他还没说自己懂了，系统已经替他决定了」—— 于是又出一道题。
   * 没有明确信号就留在原地重讲，这一条是刻意选的保守方向。 */
  if (prevPhase === 'clarify') return intent === 'other' ? 'practice' : 'clarify';
  if (round === 0) return 'lecture';
  return 'explain';
}

/** 每个阶段结尾留的那一问属于哪种性质。前端靠它决定措辞 ——
 *  「老师留了个问题给你」和「老师想确认你听懂了没有」是两回事，
 *  用户得能一眼分清这次要不要动笔算。 */
export const PROMPT_KIND = {
  lecture: 'recall',
  explain: 'recall',
  clarify: 'check',
  practice: 'practice',
  discuss: 'explore',
};

/* 计算题长什么样。只用来在 clarify 阶段拦「说好的只讲不考，结果又甩一道题」。
 *
 * 刻意不写「求导」「求极限」这类光杆词 —— 理解确认问题里出现它们太正常了
 * （「求极限有哪些方法」），拦下来反而会把好问题换成通用兜底句。
 * 只认真正带计算动作的说法。 */
const PROBLEM_RE = /计算|证明|求解|解方程|化简|试求|下列|等于多少|的值是|求\s*[^，。？！]{0,40}的值/;

/**
 * 兜底的理解确认问题。
 * 用在 clarify 阶段模型还是出了算题、或者干脆没留问题的时候。
 * 措辞刻意留出「说不清也没关系」的出口 —— 否则学生会硬撑着说懂了，
 * 那整个答疑阶段就白跑了。
 */
export function fallbackCheckPrompt(node) {
  const t = node?.title || '这一步';
  return `先不做题。用自己的话说一遍：「${t}」里最关键的那个条件是什么？`
    + '说不清也没关系，说不清我就换个说法再讲一次。';
}

/**
 * 按阶段拼提示词。
 *
 * 导出是为了让 tests/classroom.mjs 能直接断言「提示词里到底写了什么」——
 * 阶段机的效果全靠提示词落地，不测提示词等于没测。
 */
export function buildClassroomPrompt({
  node, snap, mode = 'lesson', phase = 'explain', round = 0,
  userInput = '', history = [], lastPrompt = '', lastPromptRound = 0,
}) {
  const lines = [
    '你正在编排一堂考研数学小班课。角色固定为四个人：',
    '',
    '- 老师：主讲。一次只讲一个点，讲完必须抛一个问题给学生。',
    '- 小明：基础薄弱。他的错误必须是**概念性**的（比如把可导和连续混为一谈）。',
    '- 小红：中等水平。她的问题必须是**计算细节**上的（比如漏了定义域、符号写错）。',
    '- 小刚：学得快。他负责**追问本质**（比如「这个定理去掉某个条件还成立吗」）。',
    '',
    '铁律：三个人不许都说"我懂了"。必须各错各的，错法互不重复。',
    '',
  ];

  /* ---------- 各阶段的形态说明 ---------- */
  if (phase === 'lecture') {
    lines.push(
      '【课堂形式】讲授 + 问答（第 1 轮：把理论讲透）',
      '',
      '这一轮是**建地基**，不是热身。老师的第一段发言必须把本课知识点讲清楚，',
      '按下面的顺序讲（可以分成两三条发言，但内容必须齐）：',
      '  1. 严格表述：定义或定理的完整说法，**包含全部前提条件**；',
      '  2. 直观解释：它在几何上或生活里对应什么，为什么这个结论成立；',
      '  3. 适用范围：什么情况下能用、什么情况下**不能用**（这是最容易丢分的地方）；',
      '  4. 一个最小例子：把定义代进去走一遍，让人看见它确实是这么回事；',
      '  5. 一句小结：这个考点在考卷上通常以什么形式出现。',
      '',
      '★ 第 1 轮老师的总发言可以到 400 字 —— 不受「一次只讲一个点、不超过 120 字」的限制。',
      '  但必须分条、可读，不许写成一大坨。讲不透的代价是后面每一轮都在补债。',
      '板书 3-5 条，是**推导骨架**（含 LaTeX），不是标题。',
      '三个学生仍然各错各的，但错在「听完这段之后最容易产生的误解」上。',
      '结尾留的问题是**回忆式**的：要求他用自己的话复述定义或条件，不要出计算题。',
    );
  } else if (phase === 'clarify') {
    lines.push(
      '【课堂形式】一对一答疑 —— 学生说了「不知道」，这一轮只讲给他一个人听',
      '',
      '★ 硬性要求（违反即作废）：',
      '1. **三个学生全部静默**：turns 里只允许出现老师一条发言。',
      '   他们此刻不许提问、不许插话、不许「我也有同样的问题」—— 学生现在需要的是安静。',
      '2. **不许出题**。prompt 必须是一个**理解确认**问题，不是算题。',
      '   要的：「这一步的推理跟得上吗？是卡在定义，还是卡在符号？」',
      '        「你能用自己的话说说，连续和可导差在哪吗？」',
      '   禁止的：「求 $\\lim_{x\\to 0}\\frac{\\sin x}{x}$ 的值」「计算下列极限」',
      '3. **换一个角度重讲**：上一轮用过的那套说法不要原样重复。',
      '   可以退回更基础的一步、换成几何直观、换一个更小的例子、把符号逐个念清楚。',
      '4. 开头用一句话承认卡住是正常的（一句就够，不要煽情），然后立刻开始讲。',
      '5. 老师的发言可以到 250 字，同样要分条。',
      '板书 2-3 条，只写这一轮真正要用的那几步 —— 别把整章都搬上来。',
    );
  } else if (phase === 'practice') {
    lines.push(
      '【课堂形式】练习验收 —— 学生表示跟上了，出一道小题验收',
      '',
      '1. 老师先用一句话确认上一轮讲的那个点，然后出一道**小题**（一两步就能算完）。',
      '2. 题目必须针对刚才卡住的那个点，不要换到别的考点去。',
      '3. 三个学生先各自试，各错各的。',
      '4. prompt 就是这道题本身，要求学生本人作答。',
    );
  } else if (phase === 'discuss') {
    lines.push('【课堂形式】研讨课 —— 老师只抛问题、不先给结论；先让三个学生各自尝试，把分歧暴露出来，最后由老师收口。');
  } else {
    lines.push('【课堂形式】讲授 + 问答 —— 老师先讲一个点，学生随后提问或犯错，老师再纠正。');
  }

  lines.push('');

  if (node) {
    lines.push(`【本课知识点】${node.title}`);
    const body = String(node.content || '').replace(/\\n\\n/g, '\n').slice(0, phase === 'lecture' ? 1800 : 900);
    if (body) lines.push(body);
    /* 例题只在讲透那一轮喂进去 —— 后面几轮再喂，模型会倾向于直接讲题，
     * 而 clarify 阶段要的恰恰是「退回去讲概念」。 */
    if (phase === 'lecture' && node.example) {
      lines.push('--- 例题（只作为讲解素材，不要原样抄进发言）---', String(node.example).slice(0, 600));
    }
    lines.push('');
  }

  lines.push(`【学生学情】已学 ${snap.learned}/${snap.total} 个考点，错题 ${snap.wrong} 道，连续打卡 ${snap.streak} 天。`);
  lines.push(round > 0
    ? `【当前轮次】第 ${round + 1} 轮 —— 承接上一轮，不要重复已讲过的内容。`
    : '【当前轮次】第 1 轮 —— 先建立直觉。');

  /* ---------- 留痕：让老师知道自己在回答哪一问 ---------- */
  if (lastPrompt) {
    lines.push(
      '',
      `【学生正在回答的问题（第 ${lastPromptRound + 1} 轮老师留的）】「${String(lastPrompt).slice(0, 300)}」`,
      '老师的第一条发言必须**先点明在回应哪一问**（例如「你问的是……，我分两步答」），再展开。',
      '不许绕开这个问题去讲别的。',
    );
  }

  if (userInput) {
    lines.push(
      '',
      `【学生本人插话】${userInput}`,
      phase === 'clarify'
        ? '他说的就是「没听懂」。不要重复上一轮的说法，也不要反问他「哪里不懂」就把球踢回去 —— 直接换一种讲法。'
        : '老师必须回应这句话。',
    );
  }

  if (history.length) {
    lines.push('', `【已有对话】\n${history.slice(-8).map((t) => `${t.name}：${t.text}`).join('\n')}`);
  }

  lines.push(
    '',
    '输出严格的 JSON（不要 markdown 代码块，不要任何解释文字）：',
    '{"board":["板书步骤1","板书步骤2"],"turns":[{"role":"teacher|xiaoming|xiaohong|xiaogang","name":"老师|小明|小红|小刚","text":"发言内容"}],"prompt":"留给学生本人的问题"}',
    '',
    '要求：turns 3-5 条（clarify 阶段除外，那一轮只许老师一条）；',
    'board 2-5 条且是**数学步骤**（可含 LaTeX，用 $...$ 包裹），不是标题；prompt 是一个具体的问题。',
  );

  return lines.filter(Boolean).join('\n');
}

/**
 * 阶段约束的硬过滤。
 *
 * 提示词是请求，这里是保证。三件事：
 *   1. clarify 阶段把学生发言全部摘掉（他们该静默）；
 *   2. clarify 阶段如果 prompt 还是一道算题，换成理解确认句；
 *   3. clarify 阶段没有 prompt 也换成理解确认句 —— 留着空 prompt，
 *      前端那块「老师留了个问题」的卡片就不会出现，学生就不知道该说什么。
 *
 * 为什么不直接报错让前端重试：一次重试就是一次上游调用，花的是用户的钱；
 * 而这里的每一种越界都有**语义上等价**的兜底，没必要重来。
 */
export function guardClassroomResult({ turns = [], board = [], prompt = '' }, phase, node) {
  let outTurns = turns;
  let silenced = 0;

  if (phase === 'clarify') {
    const teacherOnly = turns.filter((t) => t.role === 'teacher');
    silenced = turns.length - teacherOnly.length;
    outTurns = teacherOnly;
  }

  let outPrompt = String(prompt || '').slice(0, 300);
  let adjusted = false;

  if (phase === 'clarify' && (!outPrompt.trim() || PROBLEM_RE.test(outPrompt))) {
    outPrompt = fallbackCheckPrompt(node);
    adjusted = true;
  }

  return { turns: outTurns, board, prompt: outPrompt, adjusted, silenced };
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

export function normalizeTurns(list) {
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
