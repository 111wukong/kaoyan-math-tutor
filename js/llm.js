/* 研数 · 模型通道层（零依赖）
 *
 * 统一走 OpenAI 兼容协议，覆盖两类后端：
 *   1) 本地服务：LM Studio / Ollama / vLLM / llama.cpp —— 免 Key、离线、数据不出本机
 *   2) 云端服务：DeepSeek / Kimi / 通义 等 —— 填 Base URL + Key 即可
 *
 * 对外能力：
 *   LLM.detectLocal()    自动探测本机在跑的推理服务
 *   LLM.listModels(base) 拉取模型列表
 *   LLM.chat(conf, msgs, opts)  对话；支持流式增量回调与工具调用
 *   LLM.testConnection(conf)    设置页"测试连接"
 *
 * 工具调用做了双通道：优先用 OpenAI 原生 tool_calls；若模型（常见于本地小模型）
 * 只在正文里吐 JSON，则用 ```tool 代码块协议兜底解析。
 */
window.LLM = (function () {
  'use strict';

  var LOCAL_CANDIDATES = [
    { name: 'LM Studio', base: 'http://127.0.0.1:1234/v1' },
    { name: 'Ollama', base: 'http://127.0.0.1:11434/v1' },
    { name: 'vLLM', base: 'http://127.0.0.1:8000/v1' },
    { name: 'llama.cpp', base: 'http://127.0.0.1:8081/v1' }
  ];

  function trimBase(b) { return String(b || '').trim().replace(/\/+$/, ''); }

  function isFileProtocol() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  /* 连接失败时给出可操作的提示，而不是干巴巴的 Failed to fetch */
  function connHint(base) {
    if (isFileProtocol()) {
      return '当前页面是 file:// 打开的，浏览器会拦截对 ' + base + ' 的请求（跨域限制）。' +
        '请在项目目录执行 `python3 -m http.server 8080`，然后用 http://localhost:8080 打开本页。';
    }
    return '请确认本地推理服务已启动，且允许来自本页面的跨域请求（LM Studio 需在 Server 设置里开启 CORS）。';
  }

  function withTimeout(ms) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return {
      signal: ctl ? ctl.signal : undefined,
      done: function () { clearTimeout(timer); }
    };
  }

  /* ---------------- 探测与模型列表 ---------------- */

  async function listModels(base, timeoutMs) {
    var tm = withTimeout(timeoutMs || 2500);
    try {
      var res = await fetch(trimBase(base) + '/models', { signal: tm.signal });
      if (!res.ok) return null;
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('json') < 0) return null;   // 防止把别的 HTTP 服务误判成推理后端
      var j = await res.json();
      var raw = j.data || j.models || [];
      var ids = raw.map(function (m) { return m.id || m.name; }).filter(Boolean);
      return ids.length ? ids : null;
    } catch (e) {
      return null;
    } finally {
      tm.done();
    }
  }

  async function detectLocal(onProgress) {
    for (var i = 0; i < LOCAL_CANDIDATES.length; i++) {
      var c = LOCAL_CANDIDATES[i];
      if (onProgress) onProgress('探测 ' + c.name + ' (' + c.base + ') …');
      var ids = await listModels(c.base, 2500);
      if (ids) {
        return { name: c.name, base: c.base, models: ids };
      }
    }
    return null;
  }

  /* ---------------- 工具调用文本兜底 ---------------- */

  var TOOL_BLOCK_RE = /```(?:tool|tool_call|json)\s*\n?([\s\S]*?)```/g;

  function parseTextToolCalls(text) {
    var out = [], m;
    if (!text) return out;
    TOOL_BLOCK_RE.lastIndex = 0;
    while ((m = TOOL_BLOCK_RE.exec(text)) !== null) {
      var body = m[1].trim();
      if (!body) continue;
      var j = null;
      try { j = JSON.parse(body); } catch (e) { continue; }
      // 允许 {name, arguments} 或 {tool, args} 或 {name, parameters}
      var name = j.name || j.tool || j.function || j.tool_name;
      if (!name || typeof name !== 'string') continue;
      out.push({
        id: 'text_' + out.length + '_' + Date.now().toString(36),
        name: name,
        args: j.arguments || j.args || j.parameters || j.input || {},
        fromText: true
      });
    }
    return out;
  }

  /* 把正文里的工具块剥掉，只留给人看的部分 */
  function stripToolBlocks(text) {
    if (!text) return '';
    return text.replace(TOOL_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function safeParseArgs(raw) {
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    var s = String(raw).trim();
    if (!s) return {};
    try { return JSON.parse(s); } catch (e) { return { __raw: s }; }
  }

  /* ---------------- 对话 ---------------- */

  async function chat(conf, messages, opts) {
    opts = opts || {};
    var base = trimBase(conf.base);
    if (!base) throw new Error('未配置模型地址');
    if (!conf.model) throw new Error('未选择模型');

    var useStream = opts.stream !== false;
    var body = {
      model: conf.model,
      messages: messages,
      stream: useStream,
      temperature: opts.temperature != null ? opts.temperature : 0.4
    };
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    var headers = { 'Content-Type': 'application/json' };
    if (conf.key) headers['Authorization'] = 'Bearer ' + conf.key;

    var res;
    try {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('请求已取消');
      throw new Error('无法连接模型服务 ' + base + '。' + connHint(base));
    }

    if (!res.ok) {
      var errText = '';
      try { errText = await res.text(); } catch (e2) { /* ignore */ }
      throw new Error('模型返回 ' + res.status + '：' + String(errText).slice(0, 200));
    }

    if (!useStream) {
      var j = await res.json();
      var msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      var tc = (msg.tool_calls || []).map(function (c, i) {
        return { id: c.id || ('call_' + i), name: c.function && c.function.name, args: safeParseArgs(c.function && c.function.arguments) };
      }).filter(function (c) { return c.name; });
      var text = msg.content || '';
      if (!tc.length) tc = parseTextToolCalls(text).map(function (c) { return { id: c.id, name: c.name, args: safeParseArgs(c.args), fromText: true }; });
      if (tc.length) text = stripToolBlocks(text);
      if (opts.onDelta && text) opts.onDelta(text, text);
      return { content: text, toolCalls: tc, raw: j };
    }

    if (!res.body) throw new Error('当前浏览器不支持流式响应');

    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', content = '', calls = [], finished = false;

    while (!finished) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });

      var nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') { finished = true; break; }

        var evt;
        try { evt = JSON.parse(payload); } catch (e) { continue; }
        var choice = (evt.choices && evt.choices[0]) || {};
        var delta = choice.delta || {};

        if (delta.content) {
          content += delta.content;
          if (opts.onDelta) opts.onDelta(delta.content, content);
        }
        if (delta.tool_calls) {
          delta.tool_calls.forEach(function (part) {
            var i = part.index != null ? part.index : calls.length;
            if (!calls[i]) calls[i] = { id: '', name: '', rawArgs: '' };
            if (part.id) calls[i].id = part.id;
            if (part.function) {
              if (part.function.name) calls[i].name = part.function.name;
              if (part.function.arguments) calls[i].rawArgs += part.function.arguments;
            }
          });
        }
      }
    }
    try { reader.cancel(); } catch (e) { /* ignore */ }

    var toolCalls = calls.filter(function (c) { return c && c.name; }).map(function (c) {
      return { id: c.id || ('call_' + c.name), name: c.name, args: safeParseArgs(c.rawArgs) };
    });

    // 原生没给工具调用 → 尝试从正文里捞
    if (!toolCalls.length) {
      var textCalls = parseTextToolCalls(content);
      if (textCalls.length) {
        toolCalls = textCalls.map(function (c) { return { id: c.id, name: c.name, args: safeParseArgs(c.args), fromText: true }; });
        content = stripToolBlocks(content);
        if (opts.onDelta) opts.onDelta('', content);
      }
    }

    return { content: content, toolCalls: toolCalls };
  }

  async function testConnection(conf) {
    var ids = await listModels(conf.base, 4000);
    if (!ids) {
      throw new Error('连不上 ' + conf.base + '。' + connHint(conf.base));
    }
    return ids;
  }

  return {
    LOCAL_CANDIDATES: LOCAL_CANDIDATES,
    detectLocal: detectLocal,
    listModels: listModels,
    chat: chat,
    testConnection: testConnection,
    parseTextToolCalls: parseTextToolCalls,
    stripToolBlocks: stripToolBlocks,
    isFileProtocol: isFileProtocol,
    connHint: connHint
  };
})();
