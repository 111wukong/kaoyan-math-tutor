/* 公式实验室：把微积分里最抽象的四个概念变成能拖的东西。
 *
 * 借鉴 mathlearn（joeseesun/mathlearn）的 Explorable Explanations 做法：
 * 每个模块 = 一句生活场景钩子 + KaTeX 公式 + 可拖滑块 + Canvas 实时反馈 + 大白话讲解。
 * 关键不是"画得好看"，是**让参数可动、结果即时可见** ——
 * 公式记不住，多半是没见过它长什么样。
 *
 * 结构上分两层：
 *   1) 纯数学（secantSlope / riemannSum / taylorSin / seqLimit …）—— 不碰 DOM，可直接单测
 *   2) mount(root, id) —— 建 DOM + Canvas + 绑事件
 * 所有 DOM/Canvas 访问都在函数内部，模块加载时不做任何浏览器假设。
 */
window.Lab = (function () {
  'use strict';

  /* ================= 纯数学层 ================= */

  /* 割线斜率：(f(x+h) − f(x)) / h —— 导数的定义式本身 */
  function secantSlope(f, x, h) {
    if (h === 0) return deriv(f, x);
    return (f(x + h) - f(x)) / h;
  }
  /* 中心差分求导，给切线用 */
  function deriv(f, x) {
    var e = 1e-6;
    return (f(x + e) - f(x - e)) / (2 * e);
  }

  var FUNCS = [
    { id: 'sq', name: 'f(x) = x²/2', tex: 'f(x)=\\tfrac{x^{2}}{2}', f: function (x) { return x * x / 2; }, df: function (x) { return x; } },
    { id: 'cube', name: 'f(x) = x³/3 − x', tex: 'f(x)=\\tfrac{x^{3}}{3}-x', f: function (x) { return x * x * x / 3 - x; }, df: function (x) { return x * x - 1; } },
    { id: 'sin', name: 'f(x) = sin x', tex: 'f(x)=\\sin x', f: Math.sin, df: Math.cos }
  ];
  function funcById(id) {
    for (var i = 0; i < FUNCS.length; i++) if (FUNCS[i].id === id) return FUNCS[i];
    return FUNCS[0];
  }

  /* 黎曼和：左端点 / 右端点 / 中点 */
  function riemannSum(f, a, b, n, mode) {
    if (!(n > 0)) return 0;
    var dx = (b - a) / n, s = 0;
    for (var i = 0; i < n; i++) {
      var x = mode === 'left' ? a + i * dx
        : mode === 'right' ? a + (i + 1) * dx
          : a + (i + 0.5) * dx;
      s += f(x) * dx;
    }
    return s;
  }
  /* 数值积分（辛普森），给"真值"用 —— 不写死答案，换函数也不用改代码 */
  function integrate(f, a, b, n) {
    n = n || 2000;
    if (n % 2) n++;
    var h = (b - a) / n, s = f(a) + f(b);
    for (var i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
    return s * h / 3;
  }

  /* sin x 的麦克劳林多项式，terms = 保留几项（第 k 项是 (−1)^k x^(2k+1)/(2k+1)!） */
  function taylorSin(x, terms) {
    terms = Math.max(1, Math.min(10, terms || 1));
    var s = 0, sign = 1, fact = 1;
    for (var k = 0; k < terms; k++) {
      var p = 2 * k + 1;
      fact = 1;
      for (var j = 2; j <= p; j++) fact *= j;
      s += sign * Math.pow(x, p) / fact;
      sign = -sign;
    }
    return s;
  }

  /* 几个考研里反复出现的数列，都收敛到好认的极限 */
  var SEQS = [
    { id: 'e', name: 'aₙ = (1 + 1/n)ⁿ', tex: 'a_{n}=\\left(1+\\tfrac{1}{n}\\right)^{n}\\to e', term: function (n) { return Math.pow(1 + 1 / n, n); }, limit: Math.E, limitLabel: 'e' },
    { id: 'ratio', name: 'aₙ = n / (n+1)', tex: 'a_{n}=\\tfrac{n}{n+1}\\to 1', term: function (n) { return n / (n + 1); }, limit: 1, limitLabel: '1' },
    { id: 'geom', name: 'aₙ = 1 + 1/2ⁿ', tex: 'a_{n}=1+\\tfrac{1}{2^{n}}\\to 1', term: function (n) { return 1 + Math.pow(2, -n); }, limit: 1, limitLabel: '1' },
    { id: 'alt', name: 'aₙ = (−1)ⁿ / n', tex: 'a_{n}=\\tfrac{(-1)^{n}}{n}\\to 0', term: function (n) { return Math.pow(-1, n) / n; }, limit: 0, limitLabel: '0' }
  ];
  function seqById(id) {
    for (var i = 0; i < SEQS.length; i++) if (SEQS[i].id === id) return SEQS[i];
    return SEQS[0];
  }
  /* 从第几项开始，之后所有项都落在 L ± eps 里。找不到返回 null。 */
  function minN(seq, eps, cap) {
    cap = cap || 400;
    var bad = 0;
    for (var n = 1; n <= cap; n++) {
      if (Math.abs(seq.term(n) - seq.limit) >= eps) bad = n;
    }
    return bad === 0 ? 1 : (bad >= cap ? null : bad + 1);
  }

  /* ================= 模块元数据 ================= */
  var MODULES = [
    {
      id: 'derivative',
      nav: '割线 → 切线',
      title: '导数：让割线自己滑成切线',
      hook: '测速摄像头只拍两个瞬间：起点和终点。两点连一条线，算出来的是"平均速度"。可你想知道的是**某一瞬间**有多快 —— 那就把两点无限靠近。',
      tex: "f'(x_0)=\\lim_{h\\to 0}\\frac{f(x_0+h)-f(x_0)}{h}",
      note: '拖动 h，看割线（实线）怎么贴上切线（虚线）。h 越小，两条线越重合 —— 极限不是"逼近到差不多"，是"本来就该是它"。'
    },
    {
      id: 'riemann',
      nav: '黎曼和 → 定积分',
      title: '定积分：把曲线下的面积切碎',
      hook: '一块形状古怪的地，量不出面积。但如果切成很多很多细长条，每条都近似矩形 —— 加起来就差不多了。切得越细，越准。',
      tex: '\\int_a^b f(x)\\,\\mathrm{d}x=\\lim_{n\\to\\infty}\\sum_{i=1}^{n}f(\\xi_i)\\Delta x',
      note: '拖动 n，看矩形和怎么逼近曲线下的真实面积。也可以切换取左端点 / 右端点 / 中点 —— 取法不同，收敛速度也不同。'
    },
    {
      id: 'taylor',
      nav: '泰勒展开',
      title: '泰勒展开：用多项式假装一条曲线',
      hook: 'sin x 不是多项式，算不了。但把它的各阶导数信息一点点拼进去，就能在原点附近"假装"成 sin x —— 阶数越高，装得越像，也装得越远。',
      tex: '\\sin x=\\sum_{k=0}^{\\infty}\\frac{(-1)^{k}x^{2k+1}}{(2k+1)!}',
      note: '拖动阶数，看多项式在原点附近怎么贴合 sin x。注意远处：多项式再高也只在原点附近好使 —— 这就是"局部逼近"的含义。'
    },
    {
      id: 'sequence',
      nav: '数列极限 ε-N',
      title: '数列极限：ε 是你要多准，N 是它答应从哪开始',
      hook: '题目里那句"对任意 ε > 0，存在 N…"读起来像绕口令。它的意思其实很朴素：**你指定一个精度，我就告诉你从第几项起能一直保持这么准。**',
      tex: '\\forall\\varepsilon>0,\\ \\exists N,\\ n>N\\Rightarrow|a_n-L|<\\varepsilon',
      note: '拖动 ε 把"允许误差带"收窄，看需要的 N 怎么往后跑。ε 越小 N 越大 —— 这就是 ε-N 语言的全部内容。'
    }
  ];
  function moduleById(id) {
    for (var i = 0; i < MODULES.length; i++) if (MODULES[i].id === id) return MODULES[i];
    return MODULES[0];
  }

  /* ================= 绘图工具 ================= */
  /* 极简绘图上下文：世界坐标 → 画布坐标。零依赖，不用任何图表库。 */
  function plotter(canvas, xr, yr) {
    var dpr = Math.min(2, (window.devicePixelRatio || 1));
    var w = canvas.clientWidth || 560, h = canvas.clientHeight || 320;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var pad = { l: 44, r: 16, t: 16, b: 30 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    function X(x) { return pad.l + (x - xr[0]) / (xr[1] - xr[0]) * iw; }
    function Y(y) { return pad.t + ih - (y - yr[0]) / (yr[1] - yr[0]) * ih; }
    function invX(px) { return xr[0] + (px - pad.l) / iw * (xr[1] - xr[0]); }

    /* 统一取色：跟设计系统同一套语义色，不另起炉灶 */
    var C = {
      grid: '#e4e4dd', axis: '#d4d4cb', ink: '#1a1a17', dim: '#8b8b81',
      brand: '#1b4d8f', green: '#2f6b4f', amber: '#8a5f17', red: '#a33a2e'
    };

    function grid(stepX, stepY) {
      g.save();
      g.strokeStyle = C.grid; g.lineWidth = 1;
      for (var x = Math.ceil(xr[0] / stepX) * stepX; x <= xr[1]; x += stepX) {
        g.beginPath(); g.moveTo(Math.round(X(x)) + .5, pad.t); g.lineTo(Math.round(X(x)) + .5, pad.t + ih); g.stroke();
      }
      for (var y = Math.ceil(yr[0] / stepY) * stepY; y <= yr[1]; y += stepY) {
        g.beginPath(); g.moveTo(pad.l, Math.round(Y(y)) + .5); g.lineTo(pad.l + iw, Math.round(Y(y)) + .5); g.stroke();
      }
      g.restore();
    }
    function axes() {
      g.save();
      g.strokeStyle = C.axis; g.lineWidth = 1;
      if (yr[0] < 0 && yr[1] > 0) { g.beginPath(); g.moveTo(pad.l, Math.round(Y(0)) + .5); g.lineTo(pad.l + iw, Math.round(Y(0)) + .5); g.stroke(); }
      if (xr[0] < 0 && xr[1] > 0) { g.beginPath(); g.moveTo(Math.round(X(0)) + .5, pad.t); g.lineTo(Math.round(X(0)) + .5, pad.t + ih); g.stroke(); }
      g.restore();
    }
    /* 按屏幕像素步进采样，保证曲线在陡峭处也不断 */
    function curve(f, color, width, dash) {
      g.save();
      g.strokeStyle = color; g.lineWidth = width || 1.75;
      g.lineJoin = 'round';
      if (dash) g.setLineDash(dash);
      g.beginPath();
      var started = false, prevY = null;
      for (var px = pad.l; px <= pad.l + iw; px += 1) {
        var x = invX(px), y = f(x);
        if (!isFinite(y)) { started = false; continue; }
        var cy = Y(y);
        /* 超出视野太多就断开，避免画出一条假的竖线 */
        if (prevY !== null && Math.abs(cy - prevY) > ih * 1.5) started = false;
        if (!started) { g.moveTo(px, cy); started = true; } else g.lineTo(px, cy);
        prevY = cy;
      }
      g.stroke();
      g.restore();
    }
    function line(x1, y1, x2, y2, color, width, dash) {
      g.save();
      g.strokeStyle = color; g.lineWidth = width || 1.5;
      if (dash) g.setLineDash(dash);
      g.beginPath(); g.moveTo(X(x1), Y(y1)); g.lineTo(X(x2), Y(y2)); g.stroke();
      g.restore();
    }
    function dot(x, y, color, r, label) {
      g.save();
      g.fillStyle = color;
      g.beginPath(); g.arc(X(x), Y(y), r || 4, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
      if (label) {
        g.fillStyle = C.ink; g.font = '11px -apple-system, "PingFang SC", sans-serif';
        g.fillText(label, X(x) + 7, Y(y) - 7);
      }
      g.restore();
    }
    /* 矩形（黎曼和用） */
    function rect(x1, x2, y1, y2, fill, stroke) {
      var X1 = X(x1), X2 = X(x2), Y1 = Y(y1), Y2 = Y(y2);
      g.save();
      if (fill) { g.fillStyle = fill; g.fillRect(X1, Math.min(Y1, Y2), X2 - X1, Math.abs(Y2 - Y1)); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.strokeRect(Math.round(X1) + .5, Math.round(Math.min(Y1, Y2)) + .5, Math.max(1, Math.round(X2 - X1 - 1)), Math.max(1, Math.round(Math.abs(Y2 - Y1)))); }
      g.restore();
    }
    function band(y1, y2, fill) {
      g.save(); g.fillStyle = fill;
      g.fillRect(pad.l, Math.min(Y(y1), Y(y2)), iw, Math.abs(Y(y2) - Y(y1)));
      g.restore();
    }
    function text(str, x, y, color, align, font) {
      g.save();
      g.fillStyle = color || C.ink;
      g.font = font || '11px -apple-system, "PingFang SC", sans-serif';
      g.textAlign = align || 'left';
      g.fillText(str, x, y);
      g.restore();
    }
    return {
      w: w, h: h, pad: pad, iw: iw, ih: ih, C: C, X: X, Y: Y, invX: invX,
      grid: grid, axes: axes, curve: curve, line: line, dot: dot,
      rect: rect, band: band, text: text
    };
  }

  /* ================= 各模块的绘制 ================= */
  var DRAW = {};

  /* ---- 1. 割线 → 切线 ---- */
  DRAW.derivative = function (p, s) {
    var F = funcById(s.func), x0 = s.x0, h = s.h;
    p.grid(0.5, 0.5); p.axes();
    p.curve(F.f, p.C.brand, 2);
    var y0 = F.f(x0), y1 = F.f(x0 + h);
    var k = secantSlope(F.f, x0, h), kt = F.df(x0);
    /* 割线：过 (x0,y0) 与 (x0+h,y1)，在视野内延伸 */
    var xa = x0 - 1.2, xb = x0 + h + 1.2;
    p.line(xa, y0 + k * (xa - x0), xb, y0 + k * (xb - x0), p.C.amber, 1.75);
    /* 切线 */
    var ta = x0 - 1.6, tb = x0 + 1.6;
    p.line(ta, y0 + kt * (ta - x0), tb, y0 + kt * (tb - x0), p.C.green, 1.5, [5, 4]);
    p.dot(x0, y0, p.C.ink, 4, 'x₀');
    p.dot(x0 + h, y1, p.C.amber, 4, 'x₀+h');
    p.text('割线  k = ' + k.toFixed(3), p.pad.l + 8, p.pad.t + 14, p.C.amber);
    p.text('切线  f′(x₀) = ' + kt.toFixed(3), p.pad.l + 8, p.pad.t + 30, p.C.green);
    return {
      rows: [
        ['h', h.toFixed(3)],
        ['割线斜率', k.toFixed(4)],
        ['切线斜率 f′(x₀)', kt.toFixed(4)],
        ['误差 |割线 − 切线|', Math.abs(k - kt).toFixed(4)]
      ],
      verdict: Math.abs(k - kt) < 0.02
        ? 'h 已经很小，割线基本就是切线 —— 极限到位了。'
        : 'h 还偏大，割线只是"平均变化率"。把 h 继续往左拖。'
    };
  };

  /* ---- 2. 黎曼和 → 定积分 ---- */
  DRAW.riemann = function (p, s) {
    var F = funcById(s.func === 'sin' ? 'sin' : s.func);
    var a = 0, b = 1;
    var f = function (x) { return x * x; };           // 用 x² 更直观（面积单调上升）
    var ftex = 'f(x)=x^{2}';
    var n = s.n, mode = s.mode;
    var exact = integrate(f, a, b);
    var sum = riemannSum(f, a, b, n, mode);

    var ymax = Math.max(f(b), 1.05) * 1.15;
    p.grid(0.1, 0.1); p.axes();
    /* 矩形 */
    var dx = (b - a) / n;
    for (var i = 0; i < n; i++) {
      var xl = a + i * dx;
      var xs = mode === 'left' ? xl : mode === 'right' ? xl + dx : xl + dx / 2;
      var hgt = f(xs);
      p.rect(xl, xl + dx, 0, hgt, 'rgba(27,77,143,.16)', n <= 40 ? 'rgba(27,77,143,.45)' : null);
    }
    p.curve(f, p.C.brand, 2);
    p.text(ftex, p.pad.l + 8, p.pad.t + 14, p.C.brand, 'left', 'italic 12px Georgia, serif');
    p.text(mode === 'left' ? '取左端点' : mode === 'right' ? '取右端点' : '取中点', p.pad.l + 8, p.pad.t + 30, p.C.dim);
    return {
      rows: [
        ['分割数 n', String(n)],
        ['黎曼和 Sₙ', sum.toFixed(6)],
        ['积分真值 ∫₀¹x²dx', exact.toFixed(6)],
        ['误差', Math.abs(sum - exact).toFixed(6)]
      ],
      verdict: Math.abs(sum - exact) < 1e-3
        ? 'n 已经够大，矩形和基本等于积分值。'
        : 'n 越大越准 —— 继续往右拖，看误差怎么掉下去。'
    };
  };

  /* ---- 3. 泰勒展开 ---- */
  DRAW.taylor = function (p, s) {
    var terms = s.terms;
    var xr = [-2 * Math.PI, 2 * Math.PI], yr = [-2.2, 2.2];
    p.grid(Math.PI / 2, 1); p.axes();
    p.curve(Math.sin, p.C.dim, 1.5);
    p.curve(function (x) { return taylorSin(x, terms); }, p.C.brand, 2);
    var order = 2 * terms - 1;
    p.text('sin x（目标）', p.pad.l + 8, p.pad.t + 14, p.C.dim);
    p.text('P' + order + '(x)（逼近）', p.pad.l + 8, p.pad.t + 30, p.C.brand);
    var at = Math.PI;
    var err = Math.abs(taylorSin(at, terms) - Math.sin(at));
    var err1 = Math.abs(taylorSin(1, terms) - Math.sin(1));
    return {
      rows: [
        ['阶数', 'P' + order + '(x)'],
        ['x = 1 处误差', err1.toExponential(2)],
        ['x = π 处误差', err.toExponential(2)],
        ['x = 2π 处误差', Math.abs(taylorSin(2 * Math.PI, terms) - Math.sin(2 * Math.PI)).toExponential(2)]
      ],
      verdict: err < 1e-2
        ? '阶数够高，连 x = π 都贴上了。'
        : '原点附近已经贴合，但远处（x = π、2π）还差得远 —— 泰勒展开是局部逼近。'
    };
  };

  /* ---- 4. 数列极限 ε-N ---- */
  DRAW.sequence = function (p, s) {
    var seq = seqById(s.seq), eps = s.eps, NMAX = 40;
    var L = seq.limit;
    var vals = [];
    for (var n = 1; n <= NMAX; n++) vals.push(seq.term(n));
    var lo = Math.min(L, Math.min.apply(null, vals)) - eps * 1.6;
    var hi = Math.max(L, Math.max.apply(null, vals)) + eps * 1.6;
    var xr = [0, NMAX + 1], yr = [lo, hi];

    p.grid(5, niceStep((hi - lo) / 5)); p.axes();
    /* ε 带 */
    p.band(L - eps, L + eps, 'rgba(47,107,79,.10)');
    p.line(xr[0], L, xr[1], L, p.C.green, 1.5, [5, 4]);
    p.line(xr[0], L + eps, xr[1], L + eps, p.C.green, 1, [2, 3]);
    p.line(xr[0], L - eps, xr[1], L - eps, p.C.green, 1, [2, 3]);
    p.text('L ± ε', p.pad.l + 8, p.pad.t + 14, p.C.green);

    var N = minN(seq, eps, 400);
    if (N !== null && N <= NMAX) p.line(N + 0.5, yr[0], N + 0.5, yr[1], p.C.amber, 1.5, [4, 3]);
    for (var i = 0; i < vals.length; i++) {
      var nn = i + 1;
      var inside = Math.abs(vals[i] - L) < eps;
      p.dot(nn, vals[i], inside ? p.C.green : p.C.red, 3);
    }
    if (N !== null && N <= NMAX) p.text('N = ' + N, p.X(N) + 6, p.pad.t + p.ih - 6, p.C.amber);

    return {
      rows: [
        ['ε（允许误差）', eps.toFixed(4)],
        ['极限 L', seq.limitLabel],
        ['需要的 N', N === null ? '> 400' : String(N)],
        ['a₄₀', seq.term(NMAX).toPrecision(6)]
      ],
      verdict: N === null
        ? 'ε 太小了，400 项之内都还没稳住 —— 把 ε 放大一点。'
        : 'ε 收窄到 ' + eps.toFixed(4) + '，从第 ' + N + ' 项起就一直落在误差带里。'
    };
  };

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var n = raw / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  /* ================= 每个模块的默认参数与控制项 ================= */
  var CONTROLS = {
    derivative: [
      { k: 'func', type: 'select', label: '函数', options: FUNCS.map(function (f) { return [f.id, f.name]; }) },
      { k: 'x0', type: 'range', label: 'x₀', min: -1.8, max: 1.8, step: 0.05, def: 0.8 },
      { k: 'h', type: 'range', label: 'h（两点的间距）', min: 0.01, max: 2, step: 0.01, def: 1.2 }
    ],
    riemann: [
      { k: 'n', type: 'range', label: '分割数 n', min: 1, max: 100, step: 1, def: 4 },
      { k: 'mode', type: 'select', label: '取点方式', options: [['left', '左端点'], ['right', '右端点'], ['mid', '中点']] }
    ],
    taylor: [
      { k: 'terms', type: 'range', label: '保留项数', min: 1, max: 10, step: 1, def: 2 }
    ],
    sequence: [
      { k: 'seq', type: 'select', label: '数列', options: SEQS.map(function (s) { return [s.id, s.name]; }) },
      { k: 'eps', type: 'range', label: 'ε（允许误差）', min: 0.005, max: 0.6, step: 0.005, def: 0.2 }
    ]
  };
  function defaultsFor(id) {
    var out = {};
    (CONTROLS[id] || []).forEach(function (c) {
      out[c.k] = c.type === 'range' ? c.def : c.options[0][0];
    });
    return out;
  }
  var VIEW = { derivative: [-2.6, 2.6, -2.2, 2.2], riemann: [0, 1, 0, 1], taylor: [-7, 7, -2.2, 2.2], sequence: [0, 41, -1, 3] };
  function rangeFor(id) {
    var v = VIEW[id] || [-3, 3, -3, 3];
    return [[v[0], v[1]], [v[2], v[3]]];
  }

  return {
    /* 纯数学 */
    secantSlope: secantSlope, deriv: deriv,
    riemannSum: riemannSum, integrate: integrate,
    taylorSin: taylorSin,
    minN: minN,
    /* 数据 */
    FUNCS: FUNCS, funcById: funcById,
    SEQS: SEQS, seqById: seqById,
    MODULES: MODULES, moduleById: moduleById,
    CONTROLS: CONTROLS, defaultsFor: defaultsFor,
    rangeFor: rangeFor,
    /* 绘图 */
    plotter: plotter, DRAW: DRAW
  };
})();
