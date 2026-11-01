/* 生成小程序页面的静态 HTML，喂给 impeccable detect
 *
 * 跑法（在仓库根目录）：
 *   node miniprogram/scripts/audit.mjs
 *   npx impeccable detect /tmp/audit/mini.html --viewport 375x812
 *
 * ★ 改 wxml 结构时必须同步改这里的 HTML —— 它和页面是同构手写的，
 *   不同步的话审计的是旧布局，结论没有意义。这次就踩过：把「我的」页
 *   的三个图标改成列表后忘了改这里，截图出来是错乱的。
 *
 * 为什么要这一步：detect 对 .wxml/.wxss 只做 regex，元素级规则
 * （对比度、字号、嵌套卡片、间距）全都跑不了。只有真 HTML 才能跑全。
 *
 * 做法：读真实 wxss（rpx÷2 → px），手写与 wxml 同构的结构和示例数据。
 * 页面内容用真实文案，不用 lorem —— 文案长度直接影响排版判断。
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 'miniprogram';   // 从仓库根执行
const conv = (css) => css
  .replace(/(-?\d*\.?\d+)rpx/g, (_, n) => `${parseFloat(n) * 0.5}px`)
  .replace(/\bpage \{/g, 'body {');

const read = (f) => conv(fs.readFileSync(path.join(MP, f), 'utf8'));

const base = read('app.wxss');
const pages = {
  today: read('pages/today/index.wxss'),
  review: read('pages/review/index.wxss'),
  mine: read('pages/mine/index.wxss'),
  quiz: read('pages/quiz/index.wxss'),
  camera: read('pages/camera/index.wxss'),
};

const frame = (body, title) => `
<div class="frame">
  <div class="nav">${title}</div>
  <div class="page">${body}</div>
  <div class="tabbar">
    <div class="tab on"><span>今日</span></div>
    <div class="tab"><span>复习</span></div>
    <div class="tab"><span>题库</span></div>
    <div class="tab"><span>错题</span></div>
    <div class="tab"><span>我的</span></div>
  </div>
</div>`;

const TODAY = frame(`
<div class="page-head"><div class="head-row">
  <div><div class="page-title">晚上好</div><div class="page-sub">11 月 1 日 · 周日</div></div>
  <div class="streak"><div class="streak-flame"></div><span class="streak-num">12</span></div>
</div></div>
<div class="banner banner-info"><div class="notice-dot"></div>
  <div class="notice-body"><span class="notice-title">冲刺阶段</span>
  <span class="notice-text">每天 20 张卡，坚持到考前</span></div></div>
<div class="card card-hero card-lit rise-1 rise">
  <div class="card-row hero-top">
    <div class="hero-label"><span class="t-label">待复习</span>
      <span class="t-label hero-sep">·</span><span class="t-label">渐入佳境</span></div>
    <div class="pill pill-accent">1240 XP</div>
  </div>
  <div class="hero-num-row">
    <div class="hero-num-main"><span class="t-display hero-num">18</span>
      <span class="hero-unit">张卡片到期</span></div>
    <div class="ring" style="background: conic-gradient(#c9973f 0 31%, rgba(255,255,255,0.08) 31% 100%)">
      <div class="ring-hole"><span class="ring-pct">31<span class="ring-unit">%</span></span>
        <span class="ring-cap">8/26</span></div>
    </div>
  </div>
  <button class="btn hero-btn">开始复习</button>
</div>
<div class="card">
  <div class="card-row"><div class="card-title">本周</div><div class="t-label">今天已做 12 题</div></div>
  <div class="heat">
    <div class="heat-col"><div class="heat-bar-wrap"><div class="heat-bar heat-on" style="height:40%"></div></div><span class="heat-label">一</span></div>
    <div class="heat-col"><div class="heat-bar-wrap"><div class="heat-bar heat-on" style="height:60%"></div></div><span class="heat-label">二</span></div>
    <div class="heat-col"><div class="heat-bar-wrap"><div class="heat-bar" style="height:6%"></div></div><span class="heat-label">三</span></div>
    <div class="heat-col"><div class="heat-bar-wrap"><div class="heat-bar heat-on" style="height:30%"></div></div><span class="heat-label">四</span></div>
    <div class="heat-col"><div class="heat-bar-wrap"><div class="heat-bar heat-on" style="height:100%"></div></div><span class="heat-label">五</span></div>
    <div class="heat-col"><div class="heat-bar-wrap"><div class="heat-bar heat-on" style="height:25%"></div></div><span class="heat-label">六</span></div>
    <div class="heat-col"><div class="heat-bar-wrap"><div class="heat-bar heat-on heat-today" style="height:70%"></div></div><span class="heat-label">日</span></div>
  </div>
</div>
<div class="card">
  <div class="card-title">三科掌握</div>
  <div class="cats">
    <div class="cat-row"><span class="cat-name">高等数学</span>
      <div class="cat-track"><div class="cat-fill cat-calculus" style="width:72%"></div></div>
      <span class="cat-pct">72%</span></div>
    <div class="cat-row"><span class="cat-name">线性代数</span>
      <div class="cat-track"><div class="cat-fill cat-linear" style="width:41%"></div></div>
      <span class="cat-pct">41%</span></div>
    <div class="cat-row"><span class="cat-name">概率论</span>
      <div class="cat-track"><div class="cat-fill cat-prob" style="width:18%"></div></div>
      <span class="cat-pct">18%</span></div>
  </div>
</div>
<div class="card rise-2 rise">
  <div class="card-row"><div class="card-title">今日一练</div><div class="pill pill-violet">单选</div></div>
  <div class="quiz-stem"><div class="mt"><span class="mt-text">设函数 f(x)=x² 在区间 [0,1] 上连续，则定积分的值为</span></div></div>
  <div class="quiz-foot"><div class="dots">
    <div class="dot dot-on"></div><div class="dot dot-on"></div><div class="dot"></div>
    <div class="dot"></div><div class="dot"></div><span class="t-label dots-label">难度</span></div>
    <button class="btn btn-ghost btn-sm">去做题</button></div>
</div>`, '研数');

const REVIEW = frame(`
<div class="prog">
  <div class="prog-meta"><span class="prog-count">3<span class="prog-of"> / 18</span></span>
    <span class="t-label">本轮已完成 3 张</span></div>
  <div class="bar"><div class="bar-fill" style="width:17%"></div></div>
</div>
<div class="card card-hero card-lit">
  <div class="card-row"><div class="pill pill-accent">不定积分基本公式</div>
    <div class="pill recall">印象 72%</div></div>
  <div class="face"><div class="mt"><span class="mt-text">若 f'(x)=x²，求原函数。回忆基本积分表第三类公式。</span></div></div>
  <div class="back">
    <div class="back-divider"><div class="back-divider-line"></div>
      <span class="back-divider-text">答案</span><div class="back-divider-line"></div></div>
    <div class="mt"><span class="mt-text">由换元法直接得到 x³/3 + C。</span></div>
  </div>
</div>
<div class="actions">
  <div class="rate-hint">刚才想起来多少？</div>
  <div class="rate">
    <div class="rate-btn r1"><span class="rate-label">忘了</span><span class="rate-sub">没印象</span></div>
    <div class="rate-btn r2"><span class="rate-label">模糊</span><span class="rate-sub">想起一点</span></div>
    <div class="rate-btn r3"><span class="rate-label">记得</span><span class="rate-sub">正常回忆</span></div>
    <div class="rate-btn r4"><span class="rate-label">很熟</span><span class="rate-sub">一眼就会</span></div>
  </div>
</div>`, '复习');

const MINE = frame(`
<div class="card card-hero card-lit profile">
  <div class="profile-row">
    <div class="avatar"><span class="avatar-initial">研</span></div>
    <div class="who"><div class="who-name">测试同学</div><div class="who-mail">wx_6dabda3f@wx.local</div></div>
    <div class="lv"><span class="lv-num">Lv.4</span></div>
  </div>
  <div class="lv-title">渐入佳境</div>
  <div class="stats">
    <div class="stat"><div class="stat-value">12</div><div class="stat-label">连续天数</div></div>
    <div class="stat"><div class="stat-value">1240</div><div class="stat-label">总 XP</div></div>
    <div class="stat"><div class="stat-value">7</div><div class="stat-label">今日 AI</div></div>
  </div>
</div>
<div class="card">
  <div class="card-row"><div class="card-title">近两周</div>
    <div class="t-label">186 题 · 正确率 68%</div></div>
  <div class="trend"><div class="trend-col"><div class="trend-bar trend-on" style="height:30%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:50%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:20%"></div></div><div class="trend-col"><div class="trend-bar" style="height:4%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:60%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:80%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:40%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:35%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:70%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:90%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:45%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:25%"></div></div><div class="trend-col"><div class="trend-bar trend-on" style="height:55%"></div></div><div class="trend-col"><div class="trend-bar trend-on trend-today" style="height:75%"></div></div></div>
</div>
<div class="card">
  <div class="card-row"><div class="card-title">AI 用量</div><div class="t-label">今日 7 / 30 次</div></div>
  <div class="bar" style="margin-top:11px"><div class="bar-fill" style="width:23%"></div></div>
  <div class="card-desc">每天 0 点重置。管理员可以在后台单独调整你的额度。</div>
</div>
<div class="card">
  <div class="card-title">拍照工具</div>
  <div class="card-desc">遇到纸质题、不会的题或手写笔记，拍下来让 AI 帮你处理。</div>
  <div class="tool-list">
    <div class="tool-row">
      <div class="tool-icon"><div class="tool-check"></div></div>
      <div class="tool-body"><div class="tool-name">拍照解题</div>
        <div class="tool-desc">拍一道不会的题，AI 给出完整解答</div></div>
      <div class="chevron"></div>
    </div>
    <div class="tool-row">
      <div class="tool-icon"><div class="tool-cross-h"></div><div class="tool-cross-v"></div></div>
      <div class="tool-body"><div class="tool-name">拍照录题</div>
        <div class="tool-desc">识别纸质题，存成复习卡片</div></div>
      <div class="chevron"></div>
    </div>
    <div class="tool-row">
      <div class="tool-icon"><div class="tool-note-line"></div>
        <div class="tool-note-line" style="width:20rpx"></div>
        <div class="tool-note-line" style="width:28rpx"></div></div>
      <div class="tool-body"><div class="tool-name">整理笔记</div>
        <div class="tool-desc">把手写笔记整理成知识点</div></div>
      <div class="chevron"></div>
    </div>
  </div>
</div>`, '我的');


const QUIZ = frame(`
<div class="page-head"><div class="page-title">题库</div><div class="page-sub">291 道题，按题型筛</div></div>
<div class="filter" style="overflow-x:auto;display:flex;gap:8px">
  <div class="filter-item filter-on">全部</div>
  <div class="filter-item">单选</div>
  <div class="filter-item">填空</div>
  <div class="filter-item">解答</div>
  <div class="filter-item">证明</div>
</div>
<div class="diff">
  <span class="diff-label">难度</span>
  <div class="diff-bars">
    <div class="diff-col"><div class="diff-bar" style="height:45%"></div><span class="diff-v">1</span></div>
    <div class="diff-col"><div class="diff-bar" style="height:100%"></div><span class="diff-v">2</span></div>
    <div class="diff-col"><div class="diff-bar" style="height:80%"></div><span class="diff-v">3</span></div>
    <div class="diff-col"><div class="diff-bar" style="height:38%"></div><span class="diff-v">4</span></div>
    <div class="diff-col"><div class="diff-bar" style="height:12%"></div><span class="diff-v">5</span></div>
  </div>
</div>
<div class="card q-card q-open">
  <div class="q-head">
    <div class="q-idx">1</div>
    <div class="pill pill-violet q-type">单选</div>
    <div class="dots"><div class="dot dot-on"></div><div class="dot dot-on"></div>
      <div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    <div class="q-toggle q-toggle-up"></div>
  </div>
  <div class="q-kid">重要极限</div>
  <div class="q-stem"><div class="mt"><span class="mt-text">求极限 lim(x→0) sin3x/x 的值</span></div></div>
  <div class="opts">
    <div class="opt"><div class="opt-key">A</div><div class="opt-body"><div class="mt"><span class="mt-text">1</span></div></div></div>
    <div class="opt opt-on"><div class="opt-key">B</div><div class="opt-body"><div class="mt"><span class="mt-text">3</span></div></div></div>
    <div class="opt"><div class="opt-key">C</div><div class="opt-body"><div class="mt"><span class="mt-text">1/3</span></div></div></div>
    <div class="opt"><div class="opt-key">D</div><div class="opt-body"><div class="mt"><span class="mt-text">不存在</span></div></div></div>
  </div>
  <div class="ans"><div class="ans-label">答案与解析</div>
    <div class="mt"><span class="mt-text">拆成 3·sin3x/(3x)，由重要极限得 3。</span></div></div>
  <button class="btn btn-sm go-answer">去做这道题</button>
</div>`, '题库');

const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=375">
<title>小程序页面审计</title>
<style>
${base}
${pages.today}${pages.review}${pages.mine}${pages.quiz}${pages.camera}
body { margin:0; background:#0a0b0d; display:flex; gap:20px; padding:20px; align-items:flex-start; flex-wrap:wrap; }
.frame { position:relative; width:375px; min-height:812px; border-radius:28px; overflow:hidden;
  background: #131417;
  border:1px solid rgba(255,255,255,0.07); flex-shrink:0; padding-bottom:70px; }
.nav { height:44px; display:flex; align-items:center; justify-content:center; font-size:16px; font-weight:500; color:#e9e6df; }
.page { padding:12px 16px 0; }
.tabbar { position:absolute; left:0; right:0; bottom:0; height:52px; display:flex;
  background:#0d0e10; border-top:1px solid rgba(255,255,255,0.07); }
.tab { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:11px; color:#8a857b; }
.tab.on { color:#c9973f; }
.mt { font-size:17px; line-height:1.75; color:#e9e6df; }
.mt-text { display:inline; }
.actions { position:absolute; left:0; right:0; bottom:0; padding:10px 16px 16px;
  background:linear-gradient(180deg, rgba(19,20,23,0) 0%, rgba(19,20,23,0.96) 34%); }
</style></head><body>
${TODAY}${REVIEW}${MINE}${QUIZ}
</body></html>`;

fs.mkdirSync('/tmp/audit', { recursive: true });
fs.writeFileSync('/tmp/audit/mini.html', HTML);
console.log('written /tmp/audit/mini.html', HTML.length, 'chars');
