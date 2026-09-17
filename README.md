# 研数 · 考研数学 AI 自学系统

从零依赖纯前端（localStorage）重构成的前后端分离全栈版本。原来的 13 个页面、68 个知识点、204 道题**一个都没丢**，算法层（SM-2、XP、掌握度、成就）原样移植，UI 层用 React 重写，数据从浏览器搬进了 SQLite，并补上了账号体系。

---

## 快速开始

```bash
npm install
npm run start          # 后端会托管 web/dist，打开 http://127.0.0.1:5180
```

第一次跑之前要先构建前端（`npm run start` 找不到 `web/dist` 时只提供 API）：

```bash
npm run check          # 类型检查 + 构建
npm run start
```

macOS 上可以直接双击 `启动.command`，它会自动装依赖、构建、起服务、开浏览器。

**开发模式**（前后端热更新，前端 5173、后端 5180，`/api` 自动代理）：

```bash
npm run dev
```

---

## 目录结构

```
kaoyan-math-tutor/
├── server/                     Fastify 5 + better-sqlite3
│   ├── src/
│   │   ├── index.js            入口：鉴权闸门 / 静态托管 / SPA fallback
│   │   ├── db/
│   │   │   ├── schema.sql      25 张表
│   │   │   ├── index.js        连接、建表、rebuildStats()
│   │   │   └── seed.js         幂等种子导入
│   │   ├── lib/
│   │   │   ├── sm2.js          间隔重复算法
│   │   │   ├── game.js         XP / 等级 / 掌握度 / 25 项成就 / 连续打卡
│   │   │   ├── judge.js        判题器（归一化 + 数值容差）
│   │   │   ├── password.js     scrypt 哈希
│   │   │   └── session.js      会话（库里只存 token 的 sha256）
│   │   ├── routes/             auth / catalog / study / cards / game / misc / ai
│   │   └── data/               从原项目提取的 3 科 19 章 68 考点 204 题
│   └── scripts/
│       ├── extract-seed.mjs    用 node:vm 沙箱从原 window.KDATA/QDATA 提取
│       └── smoke.mjs           接口端到端测试（134 项）
├── web/                        Vite 8 + React 19 + TS + Tailwind 4
│   └── src/
│       ├── styles/index.css    设计系统（深空底 / 玻璃面 / 光谱强调色）
│       ├── components/
│       │   ├── fx/             Starfield（Canvas 星尘）、Motion（数字滚动/倾斜卡/进度环）
│       │   ├── ui/             Primitives、Math（渲染管线）、Modal、Toaster
│       │   └── layout/         AppShell、AuthLayout
│       ├── lib/                api / utils / hooks / sfx / achievements / deckExport
│       └── pages/              15 个页面
└── tests/
    ├── browser-smoke.mjs       真浏览器冒烟（95 项，CDP，零依赖）
    └── run-all.mjs             汇总入口
```

---

## 技术选型与理由

| 选择 | 理由 |
|---|---|
| **SQLite（better-sqlite3）** | 单人自用的学习工具，上 PostgreSQL 是给自己找运维。better-sqlite3 是同步 API，事务写起来干净，不用到处 `await`。 |
| **Fastify** | schema 校验内建，把「参数不对」挡在业务代码之前。 |
| **不用 JWT，用服务端会话** | JWT 没法即时登出。「注销账号 / 登出所有设备」是刚需，所以会话表 + httpOnly cookie。 |
| **scrypt 而非 bcrypt** | Node 内置，不引原生编译依赖。N=16384 / r=8 / p=1，每用户独立盐，比对走 `timingSafeEqual`。 |
| **React + Tailwind 4** | 原版是 4492 行的字符串拼接渲染，改一处要全文搜。 |
| **Vite 8（Rolldown）** | 注意：Rolldown 下 `manualChunks` 只接受函数形式，对象形式会直接构建失败。 |
| **不引粒子库** | 星尘粒子自研不到 100 行；tsparticles 是 60–200KB。 |

---

## 数据模型

**核心不变式：明细表是权威，聚合表只是加速层。**

原版因为 localStorage 只有 5MB，必须在裁剪明细之前把统计冻结下来 —— 一旦裁剪，统计就再也没法重算。搬到数据库后这个约束消失了：

- `attempts` **全量保留**，永不裁剪
- `stats_node` / `stats_question` / `stats_daily` 纯属加速，任何时候都能用 `rebuildStats(userId)` 从明细完整重建
- 代价是每次作答要写 4 张表 —— 所以整个作答流程包在**一个事务**里，避免「题算对了但 XP 没加上」这种偏账

25 张表：

```
账号      users / sessions / auth_log / user_settings / llm_settings
内容      categories / chapters / knowledge / questions
学习      attempts / stats_node / stats_question / stats_daily
复习      cards / card_deck / notes
计划      checkins / daily_plan / focus_sessions
游戏化    game_state / achievements / boss_records
AI        chats / classrooms
```

---

## 算法层（从原版逐函数移植）

### 判题 `judge.js`

全角转半角、剥 LaTeX 反斜杠、`π→pi`、`√→sqrt`、`²→^2`、分数求值比对（`1/2` 等价 `0.5`）、数值容差 `1e-6`。

选择题也要过同一套归一化 —— 中文输入法下用户很容易打出全角的 `Ａ Ｂ Ｃ Ｄ`，只 `trim + toUpperCase` 会直接判错，那不是学生答错，是输入法的问题。

### 间隔重复 `sm2.js`

四档自评（1 忘了 / 2 吃力 / 3 记得 / 4 很熟）映射到 quality（1/3/4/5），EF 下限 1.3，首轮间隔 1 天。**新建的卡排在明天**，这是 SM-2 的标准行为，不是 bug。

### 掌握度

`new`（未学）→ `learning`（学习中）→ `proficient`（熟练）→ `mastered`（精通）。

精通的门槛是三条**同时**成立：该节点下每道题都答对过 + 作答 ≥ 3 次 + 正确率 ≥ 90%。

### XP 防刷分

```
answerXp = max(1, round(10 × 掌握度倍率 × 当日重复倍率))
掌握度倍率  { new: 1, learning: 1, proficient: 0.5, mastered: 0.2 }
当日重复倍率 第 1 次 1.0 / 第 2–3 次 0.7 / 第 4 次起 0.3
```

下限 1 是故意的：答错也给参与分，但不给连击。

### 等级

升到第 n 级需要 `100 + (n-1)×60` XP，12 个称号：初识极限 → 数轴新兵 → 求导学徒 → 积分见习 → 级数行者 → 多元探索者 → 曲线猎手 → 矩阵行者 → 概率赌徒 → 极限猎人 → 定理克星 → 考场主宰。

### 连续打卡

打卡条件 = 当日任务全部完成 **或** 专注时长 ≥ 30 分钟。当前连续从今天（若今天没打则从昨天）往回数。

### 成就

25 项，铜 / 银 / 金三档，纯谓词判定。发奖用幂等键 `flags[xp:key]` 去重，重复触发不会重复发。

---

## 富文本渲染管线（最容易被改坏的地方）

输入有两个来源，格式**不一样**：

- **模型输出**：数学写在 `$...$` / `$$...$$` 里
- **库里的数据**：**裸 LaTeX，一个 `$` 都没有** —— 68 个知识点的正文与例题、204 道题的题干与解析，全是「中文句子里夹着 `\frac{...}`」

两者进同一个渲染器，所以顺序至关重要：

```
1. 行内代码 `...`        → 摘成占位符
2. Markdown 链接          → 摘成占位符（URL 里带 _ 和 &，晚了会被当公式）
3. 已带定界符的数学 $…$   → KaTeX
4. __加粗__               → 摘成占位符（晚了会被 autoLatex 当两个裸下标）
5. autoLatex              → 给裸 LaTeX 补 $
6. 刚补出来的 $…$         → KaTeX
7. 剩余纯文本             → HTML 转义 → Markdown 强调
8. 占位符回填
```

顺序反了会出两种 bug，都真实踩过：

- **先按 `$` 切分再套 `**`**：「`**当 $x\to 0$ 时**`」被从中间切开，两半各剩一个 `**`，屏幕上就是裸露的星号
- **autoLatex 在 `$` 之前跑**：把已有的 `$\frac{1}{2}$` 再包一层 `$`，原来的定界符反而变成普通字符打到屏幕上

占位符用 `\u0001N\u0002`，并且被 `FRAG_STOP` 当作硬边界 —— 这样 autoLatex 的片段回溯不会跨过已渲染的公式去吞文本。

**验证方式**：`tests/browser-smoke.mjs` 会抽 4 个知识点 + 每日一练，把所有已交给 KaTeX 的节点从 DOM 里删掉后，检查剩余文本里不再有 `\命令` 和 `**` / `$$` / 占位符。

---

## 安全

| 项 | 做法 |
|---|---|
| 密码 | scrypt（N=16384, r=8, p=1）+ 每用户 16 字节随机盐 + `timingSafeEqual` |
| 会话 token | 32 字节随机值，**库里只存 `sha256(token)`**，原文仅存在于 httpOnly cookie |
| Cookie | `httpOnly` + `sameSite=Lax`（生产环境自动加 `secure`），30 天 TTL |
| 账号探测 | 登录时即使用户不存在也走一次哈希计算，响应时间不泄露账号是否存在 |
| API Key | **服务端存库，永不回传原文**。`GET /api/settings/llm` 只返回 `hasKey` 布尔 + `keyPreview`（前 6 后 4 位）。`/api/export` 默认剥掉 Key |
| 限流 | 注册 / 登录 10–12 次每 10 分钟 |
| 鉴权闸门 | 全局 `onRequest` 钩子，白名单之外所有 `/api/*` 都必须带有效会话 —— 挂在每个路由上迟早漏一个 |

> 原版把 API Key 存在 localStorage，任何 XSS 都能拿走。这是搬服务端最主要的动机之一。

---

## 测试

```bash
npm test               # 跑全部：134 项接口 + 95 项浏览器
npm run test:api       # 只跑接口
npm run test:browser   # 只跑浏览器
```

**不需要先起服务。** `npm test` 会自己挑一个空闲端口、用一次性数据库起一个服务，跑完杀掉并删库 —— 它不会碰 `server/data/app.db`，也不会因为你本机开着 dev 服务而冲突。

想对着已经在跑的服务测：

```bash
BASE=http://127.0.0.1:5180 npm test
```

> 这个设计是踩坑换来的。两个套件以前都假设「5180 上已经有人把服务起好了」，于是测试结果不取决于代码，而取决于**当时那个服务是谁起的、连的哪个库、有没有被改过**。实际代价：本机残留的旧服务占着端口，新服务绑不上，满屏「等待超时」，报出 44 项失败 —— 而代码一行没错。反过来更阴：残留服务恰好是好的，测试全绿，但你验证的其实是几分钟前编译的旧产物。

- **接口套件**（`server/scripts/smoke.mjs`）：注册 → 会话 → 知识树 → 真实判题作答 → 学情 → 错题 → SM-2 复习 → 统计 → 成就 → 每日任务 → 课堂持久化 → 导出 → 登出重登 → **多账号数据隔离**。
- **浏览器套件**（`tests/browser-smoke.mjs`）：用系统里已有的 Chromium 内核 + Node 22 自带的 `WebSocket` 说 CDP，**零 npm 依赖**。真开页面走完 14 个路由，断言 canvas 真的画了东西（数非透明像素）、切模块后画布真的重画、拖滑块读数真的变、公式真的渲染且没漏源码。找不到浏览器会优雅跳过。

> 这两个套件是有价值的：`vite build` 通过 + `tsc` 零错误 + 134 项接口全绿的那一版，**整个应用是白屏的** —— `App.tsx` 里 `BootScreen` 调了 `useLocation()` 却渲染在 `<BrowserRouter>` 外面。只有真开一次浏览器才发现。
>
> 还有一条纪律：**别把「跳过」当「通过」。** 浏览器套件找不到 Chromium 时会打印说明并以 0 项退出，而 0 项和全绿在汇总里长得一样。所以 CI 里专门有一步先确认 runner 上真的有浏览器。

---

## 视觉

暗色深空 + 玻璃拟态，三层色彩体系：

```
--ink-*       深空底    背景，永远比内容暗，带一点冷色偏移
--glass-*     玻璃面    卡片与面板，半透明 + 模糊 + 一像素内发光边
--spectrum-*  光谱强调  青 → 蓝 → 紫，只用于「需要被看见的东西」
```

纪律写在 CSS 注释里：不用高饱和纯色大面积填充；强调色只出现在文字、描边、光晕和小面积填充上；**长时间盯着看的东西（正文、列表）一律用低饱和的 ink 系列**。

自研特效（不引库）：Canvas 星尘粒子（视差分层 + 近邻连线 + 每星独立闪烁相位 + 页面隐藏时暂停）、3D 倾斜卡片（最大 6° 的克制倾角）、鼠标跟随光晕、数字滚动、进度环、`@property --angle` 旋转渐变边、扫光按钮、WebAudio 程序化音效（零音频文件，答对音高随连击升调）。

打印用 `#print-portal` 与屏幕样式隔离；`prefers-reduced-motion` 下动画全部关闭。

---

## 部署

单进程，后端托管前端构建产物：

```bash
npm run check && npm run start
```

环境变量：`PORT`（默认 5180）、`HOST`（默认 127.0.0.1）、`LOG_LEVEL`。

数据落在 `server/data/app.db`，**已在 `.gitignore` 里** —— 那里有账号和全部作答记录，绝不能入库。备份就是复制这个文件（连同 `-wal` / `-shm`，或先 `sqlite3 app.db "PRAGMA wal_checkpoint(TRUNCATE);"`）。

想换台机器：`npm install && npm run check`，然后把 `app.db` 拷过去，或者用页面上的导出 / 导入。

---

## 已知边界

- **AI 功能需要自己配模型**。设置 → 模型接入，填 Base URL 与模型名（OpenAI 兼容接口即可）。Key 存在服务端，不进浏览器。不配也能用，只是对话 / 课堂 / 知识点提取会给出明确提示而不是静默失败。
- **专业课考点库是空的**，需要自行填充。
- 多智能体课堂的「三个学生各错各的」靠提示词约束，模型不听话时页面会提示「模型这次没按格式回」，可以直接重试。
- 本机无 PostgreSQL 也无 Docker，所以选了 SQLite；真要多人在线再换。

---

## 许可

沿用原项目的 LICENSE。
