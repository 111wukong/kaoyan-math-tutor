/* 假的 OpenAI 兼容模型服务 —— 给 AI 正常路径做测试用。
 *
 * 为什么需要它：
 *   原来的测试只覆盖了「没配模型 → 400 + NO_LLM」这一条降级路径。
 *   而 AI 课堂/答疑是这个项目的招牌功能，它的**正常路径一行都没测过** ——
 *   于是「229 项全绿」和「AI 根本跑不通」可以同时成立。
 *
 * 为什么不连真模型：
 *   1. CI 上没有模型，也拉不起 12G 的 GGUF；
 *   2. 真模型输出不确定，没法断言；
 *   3. 我们要验的是**我们自己的代码**（提示词拼装、SSE 中转、错误处理），
 *      不是模型聪不聪明。所以上游越假越好 —— 越假，失败越指向我们的 bug。
 *
 * 用法：
 *   const stub = await startLlmStub();
 *   stub.base            // 'http://127.0.0.1:PORT/v1'
 *   stub.captured.last   // 最近一次收到的请求体（用来断言系统提示词）
 *   stub.setMode('401')  // 让上游返回 401
 *   await stub.stop();
 */
import http from 'node:http';

/** 上游 401 时用的响应体 —— 尽量贴近 OpenAI 的真实格式，好验证错误解释逻辑 */
const UNAUTHORIZED = JSON.stringify({
  error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' },
});

/** 课堂要的 JSON。刻意让三个学生「各错各的」且互不重复 —— 产品提示词里写死了这条铁律 */
const CLASSROOM_JSON = JSON.stringify({
  board: ['先看 $\\lim_{x\\to 0}\\frac{\\sin x}{x}$ 在 $x=0$ 处无定义', '用夹逼：$\\cos x\\le\\frac{\\sin x}{x}\\le 1$'],
  turns: [
    { role: 'teacher', name: '老师', text: '先别急着套公式。这个式子在 $x=0$ 处代进去是 $0/0$，你觉得它能算出来吗？' },
    { role: 'xiaoming', name: '小明', text: '代进去是 0 除以 0，那就是 0 吧？' },
    { role: 'xiaohong', name: '小红', text: '我觉得是 1，但我说不清为什么，是不是用洛必达？' },
    { role: 'xiaogang', name: '小刚', text: '如果把 $\\sin x$ 换成 $x$，极限显然是 1；那这个定理去掉「$x\\to 0$」这个条件还成立吗？' },
  ],
  prompt: '你能用自己的话说说，为什么 $0/0$ 不能直接代值吗？',
});

/** 答疑要的普通文本。带 LaTeX，好顺带验证前端的公式渲染 */
const CHAT_TEXT = '先别急着套公式。你把 $x=0$ 代进去看看分子分母各是什么？';

/** 单题讲解要的文本。带标题和公式，好验前端的富文本管线 */
const EXPLAIN_TEXT = [
  '这题考的是**导数的定义**。',
  '',
  '关键那一步是把 $\\frac{f(a+h)-f(a)}{h}$ 凑成差商 —— 不凑的话没法用导数定义，',
  '只能硬算，而硬算在 $h\\to 0$ 时会卡在 $\\frac{0}{0}$。',
  '',
  '你上次的作答卡在第二步：求导之后没有化简，系数留成了 $2a\\cdot h$。',
  '',
  '看到「求极限且分子分母都趋于 0」，先想**能不能凑出导数定义**。',
  '',
  '试一下：求 $\\lim_{h\\to 0}\\frac{(2+h)^{3}-8}{h}$。',
  '',
  '答案：12',
].join('\n');

/**
 * 按提示词里的评分点条数，回一份「第一条满分、其余 0 分」的批改结果。
 *
 * ★ 为什么要数条数而不是写死 3 条：题库里的解答题有 3~5 条评分点，
 *   写死的话「总分对不对」这条断言就只在特定题目上成立。
 *   数出来之后，不管题目几条评分点，`sum(got)` 和 `full` 都能精确对上。
 *
 * ★ 不能用 /^\s+(\d+)\. （/m 去匹配：这里拿到的是 JSON.stringify 之后的文本，
 *   换行已经变成字面的 `\n`（反斜杠 + n），`^` 锚点根本对不上。
 *   只认「（N 分）」这个片段就够了 —— 提示词里只有评分点那一行是这个形状。
 */
function gradeFor(prompt) {
  const pts = [...String(prompt).matchAll(/（(\d+) 分）/g)].map((m) => Number(m[1]));
  if (!pts.length) return JSON.stringify({ score: 7, comment: '整体思路对，细节有漏。' });
  /* 第一条满分、第二条给一半、其余 0 分 —— 刻意造出**部分给分**的形状。
   * 全给满分或全给 0 都看不出「逐条给分」这个特性，
   * 而截图要说明的正是它。 */
  return JSON.stringify({
    steps: pts.map((p, k) => ({
      i: k + 1,
      got: k === 0 ? p : k === 1 ? Math.floor(p / 2) : 0,
      comment: k === 0 ? '这一步写对了。'
        : k === 1 ? '方向对，但化简时把系数算错了。'
          : '这一步没写到。',
    })),
    comment: '第一步完整，第二步的系数算错了，第三步没有给出结论。',
  });
}

export async function startLlmStub() {
  const captured = { last: null, count: 0 };
  let mode = 'ok';
  /* 设了 rawOverride 就直接把这段文本当成模型输出吐出去 ——
   * 用来喂「真实小模型会给出的那些不完美格式」：
   * 包在 ```json 里、带前后废话、中文角色名、turns 写成字符串数组、干脆不按格式来。
   * 提示词里写着「不要 markdown 代码块」，但 9B 级别的小模型基本不听这条。
   * ★ 变量名别叫 raw：请求处理函数里已经有一个 `let raw`（请求体），
   *   重名会被内层遮蔽，结果是「模型输出」变成请求体本身 ——
   *   接口那边解析失败，症状看着像产品坏了。这个坑我踩过一次。 */
  let rawOverride = null;

  const server = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(body);
    };

    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      return send(200, JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
    }

    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* 让它保持空对象 */ }
        captured.last = body;
        captured.count++;

        if (mode === '401') return send(401, UNAUTHORIZED);

        /* 靠提示词里的特征短语区分是哪一类请求。
         *
         * ★ 必须用裸字面量去匹配，不能写带引号的 JSON 键 ——
         *   提示词里的 JSON 模板经过 JSON.stringify 之后，
         *   内层引号全被转义成了 \" ，带引号的字面量永远匹配不上，
         *   结果 stub 会给课堂请求回一段纯文本，接口那边 parseJsonObject 失败，
         *   报出「课堂发言 0 条」这种看着像产品 bug 的假失败。
         * 这是 stub 自己的判断，不是接口约定。 */
        const flat = JSON.stringify(body.messages || []);
        const content = rawOverride !== null
          ? rawOverride
          : flat.includes('阅卷老师') ? gradeFor(flat)
            : flat.includes('考研数学辅导老师') ? EXPLAIN_TEXT
              : flat.includes('turns') ? CLASSROOM_JSON
                : CHAT_TEXT;

        if (!body.stream) {
          return send(200, JSON.stringify({
            id: 'stub-1', object: 'chat.completion', model: body.model || 'stub-model',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          }));
        }

        // 流式：拆成几个分片吐出去，模拟真实的增量
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const pieces = content.match(/.{1,6}/gs) || [content];
        for (const p of pieces) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return undefined;
    }

    return send(404, JSON.stringify({ error: { message: `stub 不认这个路径：${req.method} ${req.url}` } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    port,
    base: `http://127.0.0.1:${port}/v1`,
    captured,
    setMode: (m) => { mode = m; },
    /** 传一段文本 → 之后所有响应都用它当模型输出；传 null 恢复默认 */
    setRaw: (t) => { rawOverride = t; },
    stop: () => new Promise((r) => server.close(r)),
  };
}
