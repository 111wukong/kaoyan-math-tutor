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

export async function startLlmStub() {
  const captured = { last: null, count: 0 };
  let mode = 'ok';

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

        /* 课堂请求 vs 答疑请求，靠提示词里有没有要求 JSON 来区分。
         * ★ 必须用裸 `turns` 去匹配，不能写 `"turns"` ——
         *   课堂提示词里的 JSON 模板经过 JSON.stringify 之后，
         *   内层引号全被转义成了 \" ，带引号的字面量永远匹配不上，
         *   结果 stub 会给课堂请求回一段纯文本，接口那边 parseJsonObject 失败，
         *   报出「课堂发言 0 条」这种看着像产品 bug 的假失败。
         * 这是 stub 自己的判断，不是接口约定。 */
        const isClassroom = JSON.stringify(body.messages || []).includes('turns');
        const content = isClassroom ? CLASSROOM_JSON : CHAT_TEXT;

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
    stop: () => new Promise((r) => server.close(r)),
  };
}
