/* 给重构后的界面截图，供人眼审查
 *
 * 为什么要单独做这件事：
 * 229 项测试证明了「页面渲染出来了、canvas 有像素、公式没漏源码」，
 * 但「好不好看」是断言测不了的。这个脚本只干一件事 —— 把页面拍下来。
 *
 * 关键：**先灌数据再截图**。空状态下所有页面都是「还没有卡片」「题库为空」，
 * 截 8 张空态图根本看不出配色、密度、层级对不对 ——
 * 而设计问题恰恰只在有内容时才暴露。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from './lib/server.mjs';
import { startLlmStub } from './lib/llm-stub.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const OUT = process.env.OUT || '/tmp/yanshu-shots';

/* 视口可以覆盖。默认是桌面 1440×900。
 *
 * 为什么要有这个开关：全屏 WebGL 背景 + HUD 装饰层 + 3D 星系，
 * 这三样都是「按桌面比例调出来的」。窄屏上会不会挤成一团、
 * 星系会不会把卡片顶出去、着色器在低端机上会不会拖垮滚动 ——
 * 这些在 1440 宽的截图里一个都看不出来。
 *
 *   W=390 H=844 MOBILE=1 OUT=/tmp/shots-m npm run shots
 *
 * MOBILE=1 会打开 Chrome 的移动端模拟（触摸 + viewport meta 生效），
 * 只改宽度不改这个的话，量出来的是「窄桌面」而不是「手机」。 */
const W = Number(process.env.W || 1440);
const H = Number(process.env.H || 900);
const MOBILE = process.env.MOBILE === '1';

/* 主题可以覆盖。默认主题（深空）不出现在文件名里，保持原有产物路径不变；
 * 指定了别的主题就加后缀，两种主题的截图可以并排放在一起看。
 *
 *   THEME=paper npm run shots        # 亮色下把所有页面过一遍
 *   THEME=cyber-lime OUT=/tmp/x npm run shots
 *
 * ★ 为什么要能换主题截图：断言只能证明「渲染出来了、颜色值对了」，
 * 证明不了「这套配色读得下去」。暗色下调好的东西搬到亮色下会不会瞎，
 * 只有人眼横着比才看得出来 —— 这个项目已经因此漏过两次
 * （白叠白导致卡片边界消失、WebGL 背景不跟主题）。 */
const THEME = process.env.THEME || 'deep-space';
const DEFAULT_THEME = 'deep-space';

/* 输出格式。默认 PNG —— 逐页截图是给人**细看**的，PNG 无损。
 *
 *   FORMAT=jpeg npm run shots     # 给文档用，体积只有 PNG 的 1/6 左右
 *
 * 为什么要有这个开关：仓库里那些 README 用的截图必须是 JPEG
 * （一张 1440×900 @DPR2 的 PNG 约 1.7MB，8 张就 14MB，进不了仓库）。
 * 靠外部工具转的话，别人想重新生成文档图就得先装个 sharp ——
 * 而这个项目是零图片编码依赖的。CDP 自己就能出 JPEG，白拿。 */
const FORMAT = process.env.FORMAT === 'jpeg' ? 'jpeg' : 'png';
const QUALITY = Number(process.env.QUALITY || 74);

/* ---------------- 1. 找浏览器 ---------------- */
function findBrowser() {
  const cands = [
    ...(fs.existsSync(path.join(os.homedir(), 'Library/Caches/ms-playwright'))
      ? fs.readdirSync(path.join(os.homedir(), 'Library/Caches/ms-playwright'))
          .filter((d) => d.startsWith('chromium_headless_shell-'))
          .map((d) => path.join(os.homedir(), 'Library/Caches/ms-playwright', d,
            'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
      : []),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

/* ---------------- 2. 极简 cookie jar + API ---------------- */
const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * @param into 用哪个 cookie jar。默认是主 jar（截图专用账号）。
 *   ★ 必须能换 jar：finally 里那句 DELETE /api/auth/account 删的是
 *   「jar 里当前是谁」。管理台那一段如果直接用主 jar 登录成管理员，
 *   收尾时就会**把管理员账号删掉**（连带外键级联清掉它全部数据）。
 *   所以管理台走独立的 jar。
 */
async function api(method, p, body, into = jar) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(into.size ? { Cookie: [...into].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) into.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const text = await res.text();
  try { return { status: res.status, data: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, data: null }; }
}

/* ---------------- 3. 造数据 ---------------- */
const EMAIL = `shot_${Date.now()}@test.local`;
/* 收尾要靠它注销账号（DELETE /api/auth/account 需要校验密码），
 * 所以抽成常量 —— 别在注册那行内联字面量，改一处漏一处。 */
const PASSWORD = 'Kaoyan2027!';

console.log('① 注册截图专用账号');
const reg = await api('POST', '/api/auth/register', {
  email: EMAIL, username: '王国华', password: PASSWORD,
});
if (![200, 201].includes(reg.status)) {
  console.error('注册失败', reg.status, JSON.stringify(reg.data));
  process.exit(1);
}
const TOKEN = jar.get('yanshu_session');
console.log(`   账号 ${EMAIL}`);

/* 服务端也存一份。前端启动后 loadFromServer() 会用服务端的值覆盖本地缓存 ——
 * 只设 localStorage 的话，页面加载完那一下会被改回默认主题，
 * 截出来的就是"闪变之后"的默认配色。 */
if (THEME !== DEFAULT_THEME) {
  const r = await api('PUT', '/api/settings', { theme: THEME });
  if (r.status !== 200) {
    console.error(`设置主题失败 ${r.status}`, JSON.stringify(r.data));
    process.exit(1);
  }
}
console.log(`   主题 ${THEME}`);

/* 接一个假模型。AI 批改 / 讲解那两张截图必须有模型才拍得出来，
 * 而 CI 上拉不起真模型、真模型的输出也不确定（同一份作答两次给的分不一样，
 * 截图就不可复现了）。
 *
 * 这和「灌一份有分布的学习数据」是同一件事：**界面是真的，数据是造的**。
 * 假模型也保证了截图里的分数是可控的 —— 拍出来能说明「逐条给分」这个形态，
 * 而不是撞运气撞到一个好看的输出。 */
const llmStub = await startLlmStub();
const llmCfg = await api('PUT', '/api/settings/llm', {
  kind: 'local', localBase: llmStub.base, localModel: 'stub-model',
});
if (llmCfg.status !== 200) {
  console.error('配置假模型失败', llmCfg.status, JSON.stringify(llmCfg.data));
  process.exit(1);
}
console.log(`   假模型 ${llmStub.base}`);

console.log('② 灌学习数据（要有分布，不能全满也不能全空）');
const tree = (await api('GET', '/api/catalog/tree')).data;
const allKids = tree.categories.flatMap((c) => c.chapters.flatMap((ch) => ch.nodes));

const qs = (await api('GET', '/api/catalog/questions?limit=200')).data.questions;
const byKid = new Map();
for (const q of qs) {
  if (!byKid.has(q.kid)) byKid.set(q.kid, []);
  byKid.get(q.kid).push(q);
}

/* 三档分布，让掌握度、热力图、错题本、复习队列都有东西可看：
 *   前 9 个知识点 → 每题答对 3 遍（推到 proficient / mastered）
 *   接下来 6 个   → 先错一遍再答对（留在 learning，且进错题本）
 *   剩下的一律不碰（保持 new，让知识树有对比） */
let answered = 0, wrong = 0;
const kids = [...byKid.keys()];

async function answer(qid, forceWrong) {
  const detail = await api('GET', `/api/catalog/questions/${qid}`);
  const q = detail.data?.question;
  const truth = q?.answer;
  /* ★ 解答题和证明题**不自动判分**，判分结果由 selfCorrect 带上来。
   *   不带 selfCorrect 的那次请求是「亮答案」这一步 —— 它**一个字节都不写库**。
   *   所以灌数据时必须显式给 selfCorrect，否则这个知识点一条记录都不会产生，
   *   而日志里「作答 N 次」看着一切正常。
   *   （这个坑踩过一次：拍 AI 批改那张图时发现错题本里根本没有解答题。） */
  const selfGraded = q?.type === 'solve' || q?.type === 'proof';
  const a = forceWrong ? (q?.type === 'choice' ? 'ZZZ' : '绝对不对') : truth;
  const body = { qid, answer: a, context: 'quiz' };
  if (selfGraded) body.selfCorrect = !forceWrong;
  const r = await api('POST', '/api/study/answer', body);
  if (r.data?.correct === false) wrong++;
  answered++;
}

for (const kid of kids.slice(0, 9)) {
  for (const q of byKid.get(kid).slice(0, 2)) {
    for (let i = 0; i < 3; i++) await answer(q.id, false);
  }
}
for (const kid of kids.slice(9, 15)) {
  for (const q of byKid.get(kid).slice(0, 2)) {
    /* ★ 只答错，**不要**再补一遍对的。
     *
     * 错题本的口径是「每题只看最后一次作答」—— stats_question.ok 被本次结果
     * **直接覆盖**，所以错完再答对，那道题立刻从错题本移出，等于没灌。
     * 这里原来写的就是「错一遍再答对」，于是 08-错题本 那张截图**一直是空的**，
     * 而日志里那句「灌了有分布的数据」看起来一切正常。
     *
     * 只答错还有个好处：这几个考点的正确率是 0%，薄弱点 / 根因诊断
     * 那几页才有真东西可算。 */
    await answer(q.id, true);
  }
}
console.log(`   作答 ${answered} 次（其中判错 ${wrong} 次）`);

/* 再故意答错一道**解答题**，并且放在最后答 —— 错题本是按最近作答排序的，
 * 这样它会排在第一位，下面「AI 批改」那张截图才走得进重练流程。
 * 主观题的判分面板（AI 批改 / 自评）只在解答题和证明题上出现。 */
const solveList = (await api('GET', '/api/catalog/questions?type=solve&limit=1')).data?.questions || [];
if (solveList[0]) {
  await answer(solveList[0].id, true);
  console.log(`   另外答错一道解答题（${solveList[0].id}），用于 AI 批改截图`);
}

/* 复习卡：给几张卡打分，让「复习」页和 SM-2 有内容。
 * 注意要用 /api/cards（全量）而不是 /api/cards/due ——
 * SM-2 把新建的卡排在明天，所以「今日到期」此刻是 0 张。 */
const allCards = (await api('GET', '/api/cards?limit=50')).data?.cards || [];
let graded = 0;
for (const c of allCards.slice(0, 10)) {
  const r = await api('POST', `/api/cards/${c.id}/grade`, { rating: 3 });
  if (r.status === 200) graded++;
}
console.log(`   复习卡共 ${allCards.length} 张，已评 ${graded} 张`);

/* 课堂存档：让课堂页不是空态。
 *
 * ★ 灌的字段必须跟着**界面真正会读的**字段走。
 *   2026-09-20 加了阶段机与留痕（phase / promptKind / asked / replyTo）之后，
 *   这段存档如果还只灌 turns + board + round，截出来的课堂页就是**旧界面** ——
 *   没有阶段标、没有「本课问答留痕」、我的发言里也没有引用。
 *   而且它不会报错：那些字段读不到时都有默认值，页面看着"正常"，只是少了几块。
 *   所以每次给课堂加状态字段，这里都要同步 —— 它和真实存档是同一条协议。 */
const CLASS_KID = kids[0];
const CLASS_PROMPT = '你能用自己的话说说，为什么 $\\frac{0}{0}$ 不能直接把 $x=0$ 代进去？';

await api('PUT', `/api/classroom/${CLASS_KID}`, {
  payload: {
    turns: [
      {
        role: 'teacher', name: '老师', round: 0,
        text: '先把定义摆清楚：$\\lim_{x\\to x_0}f(x)=A$ 说的是「$x$ 无限接近 $x_0$ 但不等于 $x_0$ 时，$f(x)$ 无限接近 $A$」。'
          + '注意 $x_0$ 这一点**有没有定义、取什么值，都不影响极限**。',
      },
      { role: 'xiaoming', name: '小明', round: 0, text: '那 $\\frac{0}{0}$ 是不是就等于 0？' },
      { role: 'xiaohong', name: '小红', round: 0, text: '我觉得是 1，但说不清为什么，是不是用洛必达？' },
      { role: 'xiaogang', name: '小刚', round: 0, text: '如果把 $\\sin x$ 换成 $x$，极限显然是 1；那这个结论去掉「$x\\to 0$」还成立吗？' },
      {
        role: 'teacher', name: '我', round: 1,
        text: '我不知道',
        replyTo: { text: CLASS_PROMPT, round: 0 },
      },
      {
        role: 'teacher', name: '老师', round: 1,
        text: '卡住是正常的，这个点九成的人都绕过。换个角度看：$\\frac{0}{0}$ 不是「一个数」，'
          + '它是**「两个都在往 0 跑的量」的比值**。分母缩小的同时分子也在缩小，谁快谁慢才决定结果 ——'
          + '所以它叫未定式，不能代值，只能比较两者的快慢。',
      },
    ],
    board: [
      '$\\lim_{x\\to x_0}f(x)=A$ 与 $f(x_0)$ 无关',
      '$\\frac{0}{0}$ 是未定式，不是数',
      '$\\sin x \\sim x\\ (x\\to 0)$',
    ],
    round: 1,
    mode: 'lesson',
    /* 答疑阶段：三个同学静默，结尾只确认理解 —— 截图要能看出这个状态 */
    phase: 'clarify',
    promptKind: 'check',
    prompt: '这样讲跟得上吗？卡在「为什么不能代值」，还是卡在「谁快谁慢怎么比」？',
    asked: [
      { round: 0, text: CLASS_PROMPT, kind: 'recall' },
      { round: 1, text: '这样讲跟得上吗？卡在「为什么不能代值」，还是卡在「谁快谁慢怎么比」？', kind: 'check' },
    ],
  },
});

/* ---------------- 4. 起浏览器 ---------------- */
const BROWSER = findBrowser();
if (!BROWSER) {
  console.error('找不到 Chromium 内核，跳过截图');
  process.exit(0);
}
console.log(`③ 浏览器 ${BROWSER}`);
console.log(`   视口 ${W}×${H}${MOBILE ? '（移动端模拟）' : ''}  →  ${OUT}`);

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yanshu-shot-'));
const args = [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  /* ★ 软件 WebGL2。没有这三个参数，headless 下 getContext('webgl2') 直接返回 null，
   * 于是截出来的全是 CSS 降级背景 —— 而"降级态长得对"不代表"WebGL 态长得对"。
   * 这是踩过的坑：第一次跑完看着截图以为背景没生效，其实是被降级了。
   * SwiftShader 是纯 CPU 实现，慢，但确定性好（CI 上也一样）。 */
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--window-size=${W},${H}`,
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  'about:blank',
];
if (/Google Chrome$|Microsoft Edge$/.test(BROWSER)) args.unshift('--headless=new');

const proc = spawn(BROWSER, args, { stdio: ['ignore', 'ignore', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ★ stderr 必须**一直读**，不能接成管道就不管。
 *
 * 踩过的坑：原来是 stdio: ['ignore','ignore','pipe'] 然后没人读这个流。
 * headless 下浏览器的日志、GPU 警告、页面里每一条 console.* 都往 stderr 走，
 * 管道缓冲（macOS 上 64KB）一满，**浏览器进程就阻塞在 write 上**，
 * 于是所有 CDP 命令永久挂起 —— 报出来的是 "Page.captureScreenshot 超时"，
 * 跟真正的原因（一个没人读的管道）差了十万八千里。
 *
 * 只留最后 40 行：正常时它安静，出问题时它就是唯一的线索。 */
const stderrTail = [];
proc.stderr.on('data', (d) => {
  for (const line of String(d).split('\n')) {
    if (!line.trim()) continue;
    stderrTail.push(line);
    if (stderrTail.length > 40) stderrTail.shift();
  }
});

let dbgPort = null;
for (let i = 0; i < 100; i++) {
  const f = path.join(profile, 'DevToolsActivePort');
  if (fs.existsSync(f)) { dbgPort = fs.readFileSync(f, 'utf8').trim().split('\n')[0]; break; }
  await sleep(200);
}
if (!dbgPort) { console.error('拿不到调试端口'); proc.kill('SIGKILL'); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
const page = list.find((t) => t.type === 'page');

/* 极简 CDP 客户端 */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) listeners.forEach((fn) => fn(m));
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('CDP 连不上')));
  });
  return {
    ready,
    send(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => {
          if (waiting.has(id)) { waiting.delete(id); reject(new Error(method + ' 超时')); }
        }, 25000);
      });
    },
    on(fn) { listeners.push(fn); },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
}

let client = null;
try {
  client = cdp(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Network.enable');
  /* ★ 主题要写进 localStorage，而且必须在**每一次导航之前**就位。
   *
   * Page.addScriptToEvaluateOnNewDocument 会在每个新文档的任何页面脚本
   * 之前执行，所以 index.html 里那段首屏防闪脚本读到的就是我们设的值 ——
   * 和真实用户「选了主题再刷新」走的是同一条路径。
   *
   * 不能用 Runtime.evaluate 设：那是当前文档的 localStorage，
   * 下一次导航就没了，而且那时候防闪脚本早就跑完了。 */
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('yanshu:theme', ${JSON.stringify(THEME)}); } catch (e) {}`,
  });
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: MOBILE,
  });

  const ev = async (expr) => {
    const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return { value: r.result?.value };
  };

  /**
   * @param {string} name    文件名（不含扩展名）
   * @param {string} route   路径
   * @param {object} [opts]
   * @param {string} [opts.waitFor] 就绪判据（默认 readyState）
   * @param {number} [opts.settle]  就绪后再等几毫秒（让动画/canvas/图表跑几帧）
   * @param {string} [opts.after]   拍照**之前**再执行的一段 JS。
   *   用途：页面里最该看的东西在首屏下面时（比如课堂页的「问答留痕」和
   *   理解确认按钮），需要先滚过去再拍。不给这个钩子的话，只能拍个首屏，
   *   而"要展示的那块没拍到"这件事在日志里完全看不出来。
   */
  async function shoot(name, route, { waitFor, settle = 1400, after } = {}) {
    await client.send('Page.navigate', { url: `${BASE}${route}${route.includes('?') ? '&' : '?'}cb=${Date.now()}` });
    // 轮询等就绪条件，别赌固定 sleep
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const r = await ev(waitFor || 'document.readyState === "complete"');
      if (r.value === true) break;
      await sleep(180);
    }
    await sleep(settle);   // 让动画 / canvas / 图表跑几帧

    if (after) {
      const r = await ev(after);
      if (r.error) console.log(`\x1b[33m   · ${name} 的 after 钩子报错：${r.error}\x1b[0m`);
      /* ★ 钩子的返回值也要检查。约定：跑到预期位置就 return 'ok'。
       *
       * 为什么必须查：钩子里「找不到按钮 → 提前 return」**不会抛异常**，
       * 表现是「截图拍到了，但拍的是没展开的样子」—— 那看起来像
       * 「功能没做」，而不像「钩子没生效」。实测就是这么浪费过一轮：
       * 12c 那张拍出来是空的错题本，一度以为错题本页面坏了。
       * 顺带一提，`textContent` 常常带前导空格（图标和文字之间有空格），
       * 所以选择器别用 `/^文字/` 去锚定。 */
      else if (r.value !== 'ok') {
        console.log(`\x1b[33m   · ${name} 的 after 钩子没走到位：${JSON.stringify(r.value)}\x1b[0m`);
      }
      await sleep(900);    // 平滑滚动要时间，别在滚到一半时按快门
    }

    /* 每一张都报一次"背景到底走的是哪条路"。
     * 不报的话，WebGL 悄悄降级了也看不出来 —— 截图依旧是"有背景"的样子，
     * 只是那背景是 CSS 备胎，而备胎长得像不代表主胎装上了。
     *
     * ⚠️ 选择器必须点名 cybergrid，不能用 'canvas[aria-hidden="true"]'。
     * 后者抓的是**DOM 里第一个** canvas —— 知识树页上那是星系自己的连线画布
     * （1224×765），于是那一张会报出一个跟别张对不上的尺寸，
     * 看起来像"背景尺寸错了"，其实是探针抓错了对象。 */
    const fx = await ev(`(() => {
      const gl = document.documentElement.classList.contains('fx-webgl');
      const c = document.querySelector('canvas[data-fx=cybergrid]');
      const mode = document.documentElement.dataset.mode || '?';
      return gl + '|' + (c ? c.width + 'x' + c.height : 'none') + '|' + mode;
    })()`);
    const [fxAlive, fxSize, fxMode] = String(fx.value || '?|?|?').split('|');

    /* ★ captureScreenshot 会偶发挂住，重试。
     *
     * 复现过：加了逐像素抖动之后，同一台机器上 4 次里有 2 次卡在
     * "Page.captureScreenshot 超时"，把超时从 25 秒放宽到 60 秒**照样挂**，
     * 所以不是"太慢"，是真的不返回。特征是截出来的 PNG 变大（4.1MB 量级）
     * 之后才出现，把抖动换成压缩率更好的 4×4 Bayer（3.6MB）就 8/8 全过。
     *
     * 根因在 Chromium 的 headless + 软件 GL 截图路径上，不在这个项目里，
     * 修不了。但它是**偶发**的：换一帧重来就好。所以这里重试，而不是把
     * 已经调好的画面参数往回调 —— 为了迁就工具去牺牲画面，方向反了。 */
    let shot = null;
    for (let attempt = 1; attempt <= 3 && !shot; attempt++) {
      try {
        shot = await client.send('Page.captureScreenshot',
          FORMAT === 'jpeg' ? { format: 'jpeg', quality: QUALITY } : { format: 'png' });
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(`\x1b[90m   · ${name} 截图超时，重试 ${attempt + 1}/3\x1b[0m`);
        await sleep(900);
      }
    }
    const ext = FORMAT === 'jpeg' ? 'jpg' : 'png';
    const file = path.join(OUT, `${name}${THEME === DEFAULT_THEME ? '' : '-' + THEME}.${ext}`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    const title = (await ev('document.title')).value || '';
    /* 亮色主题**故意**不挂 WebGL 背景，所以那里报「CSS降级」是误导 ——
     * 日志会让人以为出了故障。按 mode 分开说。 */
    const flag = fxAlive === 'true'
      ? '\x1b[36mWebGL\x1b[0m'
      : fxMode === 'light' ? '\x1b[90m亮色·静态底\x1b[0m' : '\x1b[33mCSS降级\x1b[0m';
    console.log(`   ✓ ${name.padEnd(16)} ${route.padEnd(16)} ${kb.padStart(4)} KB  ${flag} ${fxSize.padEnd(11)} 「${title}」`);
  }

  /* 未登录状态：登录 / 注册页 —— 第一印象 */
  console.log('④ 未登录页面');
  await shoot('01-登录', '/login', { waitFor: '!!document.querySelector("input[name=email]")' });
  await shoot('02-注册', '/register', { waitFor: 'document.querySelectorAll("form input").length >= 4' });

  /* 注入会话 cookie，进入已登录状态 */
  await client.send('Network.setCookie', {
    name: 'yanshu_session', value: TOKEN, url: BASE, path: '/',
    httpOnly: true, sameSite: 'Lax',
  });

  console.log('⑤ 已登录页面');
  const SHELL = '!!document.querySelector("nav[aria-label=\\"主导航\\"]")';
  await shoot('03-仪表盘', '/', { waitFor: SHELL, settle: 2000 });
  await shoot('04-知识树', '/learn', { waitFor: SHELL, settle: 1600 });
  await shoot('05-知识点详情', `/learn/${kids[0]}`, { waitFor: SHELL, settle: 2200 });
  await shoot('06-每日一练', '/quiz', { waitFor: SHELL, settle: 2000 });
  await shoot('07-复习', '/review', { waitFor: SHELL, settle: 1600 });
  await shoot('08-错题本', '/mistakes', { waitFor: SHELL, settle: 1600 });
  await shoot('09-统计', '/stats', { waitFor: SHELL, settle: 2400 });
  await shoot('10-公式实验室', '/lab', { waitFor: SHELL, settle: 2400 });
  /* 公式手册那张：切到手册 tab，再点开第一条公式的「动手」。
   * 这张图要展示的是「查到了就能立刻动手看」—— 只拍手册列表看不出这一点，
   * 只拍演示台又看不出「手册里每条都能展开」。 */
  await shoot('10b-公式手册-就地演示', '/lab', {
    waitFor: SHELL,
    settle: 2200,
    after: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const tab = Array.from(document.querySelectorAll('button'))
        .find((x) => x.textContent.trim() === '公式手册');
      if (tab) tab.click();
      await wait(1600);
      const b = document.querySelector('button[data-demo-toggle]');
      if (b) b.click();
      await wait(1800);
      window.scrollTo(0, 320);
      await wait(200);
      return 'ok';
    })()`,
  });
  await shoot('11-闪电战', '/blitz', { waitFor: SHELL, settle: 1800 });
  await shoot('12-卡片库', '/deck', { waitFor: SHELL, settle: 1600 });
  /* 我的题库 + 录题表单里的「解答题」。这张要展示的是六种题型 ——
   * 打开录题面板、把题型切到「解答」，评分点编辑器就出来了。 */
  await shoot('12b-我的题库-解答题', '/questions', {
    waitFor: SHELL,
    settle: 1800,
    after: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const open = Array.from(document.querySelectorAll('button'))
        .find((x) => x.textContent.indexOf('录一道题') >= 0);
      if (open) open.click();
      await wait(900);
      const solve = Array.from(document.querySelectorAll('button'))
        .find((x) => x.textContent.trim() === '解答');
      if (solve) solve.click();
      await wait(900);
      window.scrollTo(0, 260);
      await wait(200);
      return 'ok';
    })()`,
  });
  /* AI 批量补题面板。
   * 只拍**面板展开**的状态，不点「开始生成」—— 截图环境没有配模型，
   * 点了只会拿到一个错误 toast，反而看不到面板本体长什么样。
   * 面板里那些「0 题 / 2 题」的角标正是它的卖点：直接告诉用户哪里缺题。 */
  await shoot('12d-AI批量补题', '/questions', {
    waitFor: SHELL,
    settle: 1800,
    after: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = Array.from(document.querySelectorAll('button'))
        .find((x) => (x.textContent || '').indexOf('AI 批量补题') >= 0);
      if (!btn) return 'NO_BATCH_BTN';
      btn.click();
      await wait(1100);
      /* 滚到面板标题附近，但**不要**用 scrollTo(0, 0) —— 那样会把工具栏滚走，
       * 看不到「AI 批量补题」按钮自己。小幅度滚动 80px 就够露出标题 + 按钮。 */
      window.scrollTo(0, 100);
      await wait(250);
      return 'ok';
    })()`,
  });

  /* AI 批改解答题。这一张要拍的是「逐条给分 + 指出卡在哪一步」，
   * 所以得走完整链路：错题本 → 重练 → 写答案 → 提交对答案 → 让 AI 批改。
   *
   * ★ 受控组件必须用 native setter 再补一发 input 事件，
   *   直接 `ta.value = '...'` 不会触发 React 的 onChange，
   *   结果是「提交」按钮一直是 disabled，截图拍到一个空面板。 */
  await shoot('12c-AI批改-解答题', '/mistakes', {
    waitFor: SHELL,
    settle: 1800,
    after: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      /* ★ 不能用 /^重练/ 锚定：按钮里图标和文字之间有空格，
       *   textContent 是「 重练（最多 10 题）」，锚点匹配不上。 */
      const btn = (re) => Array.from(document.querySelectorAll('button'))
        .find((b) => re.test(b.textContent || ''));
      const go = btn(/重练（最多/);
      if (!go) return 'NO_RETRAIN_BTN';
      go.click();
      await wait(1000);
      const ta = document.querySelector('textarea');
      if (!ta) return 'NO_TEXTAREA';
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, '第一步：由导数定义写出差商 \\\\frac{f(a+h)-f(a)}{h}。\\n第二步：展开并化简，得 2a + h。\\n第三步：令 h 趋于 0。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(400);
      const submit = btn(/提交并对答案/);
      if (!submit) return 'NO_SUBMIT_BTN';
      submit.click();
      await wait(1600);
      const ai = btn(/让 AI 批改/);
      if (!ai) return 'NO_AI_BTN';
      ai.click();
      await wait(2600);
      /* 把「接受判分」滚到视野中间 —— 总分和总评就在它上面。
       * 直接 scrollTo 一个固定值拍不到那块，因为评分点有几条是变的。 */
      const accept = btn(/接受判分/);
      if (!accept) return 'NO_ACCEPT_BTN';
      accept.scrollIntoView({ block: 'center' });
      await wait(250);
      return 'ok';
    })()`,
  });

  /* AI 讲透一道题。错题卡展开后点一下「让 AI 讲透这道题」——
   * 服务端会带上这次作答和错因，所以讲的是「你卡在哪一步」。 */
  await shoot('12d-AI讲透一道题', '/mistakes', {
    waitFor: SHELL,
    settle: 1600,
    after: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const card = document.querySelector('button[data-mistake-toggle]');
      if (!card) return 'NO_CARD';
      card.click();
      await wait(900);
      const ai = Array.from(document.querySelectorAll('button'))
        .find((b) => /让 AI 讲透这道题/.test(b.textContent || ''));
      if (!ai) return 'NO_AI_BTN';
      ai.click();
      await wait(2600);
      ai.scrollIntoView({ block: 'center' });
      await wait(250);
      return 'ok';
    })()`,
  });

  /* ★ 课堂必须带上 ?kid=。不带的话页面停在「先选一个知识点」的空态 ——
   *   而上面刚灌好的那份存档（在 CLASS_KID 上）一个字都看不到。
   *   这张图以前就是这么拍空的：看着不报错，只是拍了个空页面。 */
  await shoot('13-课堂', `/classroom?kid=${CLASS_KID}`, { waitFor: SHELL, settle: 2200 });
  /* 再拍一张滚到底的。这一页最该看的两样东西（「我的发言引用了哪一问」和
   * 「还是没懂 / 懂了，继续」）都在首屏下面 —— 只拍首屏等于没展示。 */
  await shoot('13b-课堂-留痕', `/classroom?kid=${CLASS_KID}`, {
    waitFor: SHELL,
    settle: 2200,
    after: `(function () { window.scrollTo(0, document.documentElement.scrollHeight); return 'ok'; })()`,
  });
  await shoot('14-成就', '/achievements', { waitFor: SHELL, settle: 1800 });
  await shoot('15-设置', '/settings', { waitFor: SHELL, settle: 1600 });

  /* ---- 管理台 ----
   * 它不在上面那张列表里：那一串是普通用户能看到的页面，/admin 需要管理员会话。
   * 少了这一张的话，「新建的管理台在亮色主题下长什么样」就永远没人看过 ——
   * 而这个项目已经因为「只验证了默认主题」漏过好几次。
   *
   * 凭据取 ADMIN_EMAIL / ADMIN_PASSWORD，默认值见 tests/lib/server.mjs
   * （服务端不再有内置默认密码了，所以这里也不能写死一组）。
   * 登录失败**不算错**（你可能已经改过管理员密码了），跳过并出声即可。 */
  console.log('⑥ 管理台');
  const adminJar = new Map();
  const adminEmail = (process.env.ADMIN_EMAIL || TEST_ADMIN_EMAIL).trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || TEST_ADMIN_PASSWORD;
  const adminLogin = await api('POST', '/api/auth/login', { email: adminEmail, password: adminPassword }, adminJar);

  if (adminLogin.status !== 200) {
    console.log(`\x1b[33m   · 跳过管理台截图：管理员登录失败（HTTP ${adminLogin.status}）\x1b[0m`);
    console.log('\x1b[90m     改过管理员密码的话，用 ADMIN_EMAIL / ADMIN_PASSWORD 传进来\x1b[0m');
  } else {
    /* ★ 管理员账号的主题也要单独设一遍。
     *
     * 外观是**跟着账号走**的（存在各自的 user_settings.theme），
     * 上面那次 PUT 设的是截图专用账号的。不设管理员这一份的话，
     * 换成管理员会话后 loadFromServer() 会读回 deep-space ——
     * 于是 THEME=paper 跑出来的管理台截图其实是暗色的。
     *
     * 实测踩过：日志里那张写着「WebGL 1800x1125」而不是「亮色·静态底」，
     * 一眼看过去还以为管理台在亮色下也挂了 WebGL 背景。 */
    if (THEME !== DEFAULT_THEME) {
      const r = await api('PUT', '/api/settings', { theme: THEME }, adminJar);
      if (r.status !== 200) console.log(`\x1b[33m   · 管理员主题没设上（HTTP ${r.status}）\x1b[0m`);
    }
    await client.send('Network.setCookie', {
      name: 'yanshu_session', value: adminJar.get('yanshu_session'), url: BASE, path: '/', httpOnly: true, sameSite: 'Lax',
    });
    await shoot('16-管理台', '/admin', {
      waitFor: '!!document.querySelector("#main-scroll table")', settle: 2200,
    });
  }

  console.log(`\n截图输出：${OUT}`);
} catch (e) {
  /* 失败时把浏览器 stderr 的尾巴打出来。没有这段的话，
   * "CDP 命令超时" 之外什么线索都没有，只能靠猜。 */
  console.error(`\n\x1b[31m✗ 截图中断：${e.message}\x1b[0m`);
  if (stderrTail.length) {
    console.error('\x1b[90m── 浏览器 stderr 最后 40 行 ──');
    for (const l of stderrTail) console.error('\x1b[90m' + l + '\x1b[0m');
  } else {
    console.error('\x1b[90m（浏览器 stderr 是空的）\x1b[0m');
  }
  throw e;
} finally {
  /* ★ 把自己造的账号删掉。
   * 这个脚本默认连的是「你正在用的那个服务」（BASE 默认 127.0.0.1:5180），
   * 写的是真实数据库 —— 这是必要的，因为截图要看的就是真实分布。
   * 但它每跑一次就注册一个 shot_*@test.local 并灌 88 条作答，
   * 以前不清，跑十几次库里就攒十几个假账号。
   * 现在用 DELETE /api/auth/account 收尾，外键级联把学习数据一并带走。 */
  if (TOKEN) {
    try {
      const r = await api('DELETE', '/api/auth/account', { password: PASSWORD });
      if (r.status === 200) console.log(`\x1b[90m已清理临时账号 ${EMAIL}\x1b[0m`);
      else console.warn(`\x1b[33m⚠ 临时账号没能删掉（HTTP ${r.status}）—— 手动清一下 ${EMAIL}\x1b[0m`);
    } catch (e) {
      console.warn(`\x1b[33m⚠ 清理临时账号失败：${e.message}\n  手动清一下 ${EMAIL}\x1b[0m`);
    }
  }
  if (client) client.close();
  /* 假模型也要收掉。不收的话进程会挂在监听上，脚本跑完不退出 ——
   * 表现是「截图全拍完了但命令不返回」，很容易被当成卡死。 */
  try { await llmStub?.stop(); } catch { /* 已经关了 */ }
  try { proc?.stderr?.destroy(); } catch { /* 已关 */ }
  try { proc?.kill('SIGKILL'); } catch { /* 已退 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
}
