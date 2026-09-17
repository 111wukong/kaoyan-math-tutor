/* 音效层：WebAudio 程序化合成
 *
 * 不加载任何音频文件 —— 一个 wav 动辄几十 KB，而这里需要的只是几个正弦音。
 * 用振荡器现场合成，体积为零，还能让音高随连击数变化（这是加载固定音频做不到的）。
 * 默认尊重系统「减少动态效果」设置，用户也可手动关。
 */

let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

let enabled = true;
export function setSfxEnabled(v: boolean) { enabled = v; }
export function isSfxEnabled() { return enabled; }

function tone(freq: number, start: number, dur: number, gain = 0.06, type: OscillatorType = 'sine') {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + start;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** 答对：音高随连击升高，最高到第 8 连击就不再升（再高会刺耳） */
export function sfxCorrect(combo = 1) {
  if (!enabled) return;
  const step = Math.min(combo, 8);
  const base = 523.25 * Math.pow(2, (step - 1) / 12);
  tone(base, 0, 0.14, 0.055);
  tone(base * 1.5, 0.045, 0.16, 0.035);
}

/** 答错：短促下行两音，不刺耳但明确 */
export function sfxWrong() {
  if (!enabled) return;
  tone(311.13, 0, 0.13, 0.05, 'triangle');
  tone(233.08, 0.085, 0.2, 0.045, 'triangle');
}

/** 升级：四音琶音 */
export function sfxLevelUp() {
  if (!enabled) return;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.085, 0.32, 0.05));
}

/** 成就解锁：更亮的三音 + 尾音 */
export function sfxAchievement() {
  if (!enabled) return;
  [659.25, 880, 1318.5].forEach((f, i) => tone(f, i * 0.095, 0.42, 0.05));
  tone(1760, 0.3, 0.6, 0.03);
}

/** 复习自评：四档不同音色，让手感有区别 */
export function sfxRating(rating: number) {
  if (!enabled) return;
  const map: Record<number, number> = { 1: 233.08, 2: 349.23, 3: 523.25, 4: 698.46 };
  tone(map[rating] || 440, 0, 0.16, 0.05);
}

/** 卡片翻转 / 页面切换的轻点 */
export function sfxTick() {
  if (!enabled) return;
  tone(880, 0, 0.05, 0.022, 'square');
}

/** 闪电战倒计时最后 3 秒 */
export function sfxUrgent() {
  if (!enabled) return;
  tone(880, 0, 0.09, 0.05, 'square');
}
