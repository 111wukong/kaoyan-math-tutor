/* 音效层：WebAudio 程序化合成，零音频文件、零依赖。
 *
 * 借鉴 mathlearn / helix-trainer 的做法 —— 答对答错有声音，反馈才"有手感"。
 * 它们都是用 WebAudio 现场合成而不是加载 mp3，本文件沿用：
 * 没有外部资源，也就不存在加载失败、也就不需要网络。
 *
 * 三条约束：
 * 1. 浏览器要求 AudioContext 必须在用户手势之后才能出声，所以延迟创建。
 * 2. 用户开了系统级"减少动态效果"，默认静音 —— 声音和动画一样属于可选刺激。
 * 3. 音效永远不能成为功能的一部分：任何调用失败都静默吞掉。
 */
window.SFX = (function () {
  'use strict';

  var KEY = 'kaoyan_math_tutor_sfx';
  var ctx = null;
  var enabled = null;      // null = 还没读过配置

  function reducedMotion() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }

  function isEnabled() {
    if (enabled === null) {
      var v = null;
      try { v = localStorage.getItem(KEY); } catch (e) { }
      enabled = v === null ? !reducedMotion() : v === '1';
    }
    return enabled;
  }
  function setEnabled(b) {
    enabled = !!b;
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (e) { }
    if (enabled) tick();
  }
  function toggle() { setEnabled(!isEnabled()); return enabled; }

  /* AudioContext 延迟到第一次真要出声时再建 ——
     页面一加载就 new AudioContext() 在多数浏览器会被挂起并刷一条警告。 */
  function ac() {
    if (ctx) return ctx;
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    } catch (e) { ctx = null; }
    return ctx;
  }

  /* 一个音符：osc → gain → 输出。
   * 包络用指数衰减而不是线性 —— 线性听起来像被掐断。 */
  function note(freq, dur, opts) {
    if (!isEnabled()) return;
    var c = ac();
    if (!c) return;
    opts = opts || {};
    try {
      if (c.state === 'suspended' && c.resume) c.resume();
      var t0 = c.currentTime + (opts.at || 0);
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = opts.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + dur);
      var peak = opts.gain == null ? 0.13 : opts.gain;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (e) { /* 音效失败不能影响主流程 */ }
  }

  /* ---------- 具体音色 ---------- */
  /* 答对：两个上行音。连击越高，音越高 —— 连击本身就是正反馈。 */
  function correct(combo) {
    var n = Math.max(0, combo || 0);
    var base = 523.25 * Math.pow(1.0595, Math.min(12, n * 2));   // 每 2 连升一个半音，最多升 12 个
    note(base, 0.09, { type: 'triangle', gain: 0.11 });
    note(base * 1.5, 0.13, { type: 'triangle', gain: 0.09, at: 0.055 });
  }
  /* 答错：一个下行短音，不刺耳 —— 惩罚感太强会让人不敢做题 */
  function wrong() {
    note(220, 0.16, { type: 'sine', gain: 0.1, slideTo: 155 });
  }
  /* 连击里程碑：三连上行 */
  function combo(level) {
    var b = 659.25 * (1 + Math.min(3, (level || 5) / 25));
    [0, 1, 2].forEach(function (i) {
      note(b * Math.pow(1.1225, i), 0.1, { type: 'triangle', gain: 0.1, at: i * 0.07 });
    });
  }
  /* 升级 / 打卡：四音上行琶音 */
  function levelUp() {
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      note(f, 0.16, { type: 'triangle', gain: 0.1, at: i * 0.085 });
    });
  }
  function checkin() {
    [587.33, 880].forEach(function (f, i) {
      note(f, 0.18, { type: 'sine', gain: 0.1, at: i * 0.11 });
    });
  }
  /* 倒计时最后几秒 */
  function tick() { note(880, 0.05, { type: 'square', gain: 0.05 }); }
  /* 时间到 */
  function timeUp() {
    note(392, 0.5, { type: 'sawtooth', gain: 0.08, slideTo: 130 });
  }

  return {
    isEnabled: isEnabled, setEnabled: setEnabled, toggle: toggle,
    correct: correct, wrong: wrong, combo: combo,
    levelUp: levelUp, checkin: checkin, tick: tick, timeUp: timeUp
  };
})();
