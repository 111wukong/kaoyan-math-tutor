/* 公式演示引擎 · 演示定义的类型
 *
 * 一个「演示」由四部分组成：
 *   controls —— 可以拖的参数
 *   scene    —— 参数 → 画面（纯数据，不碰 canvas）
 *   readout  —— 参数 → 右侧那几行实时数值
 *   what     —— 一句话说清这个演示在演示什么
 *
 * ★ scene / readout 必须是**纯函数**，不许碰 DOM、不许有副作用。
 *   原因不是洁癖：tests/formula-demos.mjs 会在 Node 里把每个演示的
 *   参数空间扫一遍（每个滑块取 min / init / max），验证它不抛异常、
 *   也不会算出 NaN 或 Infinity 显示到读数里。
 *   一旦某个演示偷偷读了 window 或 canvas 尺寸，这条检查就失效了 ——
 *   而它失效的方式是静默的（测试照样绿）。
 */
import type { Params, Palette, Scene, View } from './plot';

export interface ControlSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  init: number;
  fmt?: (v: number) => string;
}

export interface Readout {
  label: string;
  value: string;
  /** 次要说明，显示在数值后面 */
  hint?: string;
  /** 需要强调时用（比如「两者相等」这种结论性读数） */
  tone?: 'default' | 'good' | 'warn';
}

export interface DemoDef {
  /** 这个演示在演示什么 */
  what: string;
  controls: ControlSpec[];
  /** 视野。给函数是为了视野能跟着参数走（比如 ε 变化时要缩放） */
  view: View | ((p: Params) => View);
  /** 笛卡尔演示走 scene。pal 由调用方按当前主题构造后传入 ——
   *  canvas 只吃具体颜色字符串，颜色不能在演示定义里写死（亮色主题会白压白）。 */
  scene?: (p: Params, pal: Palette) => Scene;
  /** 非笛卡尔演示（矩阵、集合图、树图）直接画 */
  custom?: (ctx: CanvasRenderingContext2D, W: number, H: number, p: Params, pal: Palette) => void;
  readout: (p: Params) => Readout[];
  /** 一句话结论，显示在演示下方 */
  note?: string;
}

/** 演示工厂：同一个「交互形态」下用 variant 区分具体演示哪条公式 */
export type DemoFactory = (variant: string) => DemoDef;

export type DemoRegistry = Record<string, DemoFactory>;

/* ---------- 常用滑块的快捷构造 ---------- */

export const ctrl = (
  key: string, label: string, min: number, max: number, step: number, init: number,
  fmt?: (v: number) => string,
): ControlSpec => ({ key, label, min, max, step, init, fmt });

/** 整数滑块（分割数、项数、自由度这类） */
export const int = (key: string, label: string, min: number, max: number, init: number, unit = '') =>
  ctrl(key, label, min, max, 1, init, (v) => `${v}${unit}`);

/** 矩阵元素滑块 —— 线性代数那一片到处要用 */
export const mat = (key: string, label: string, init = 1, min = -3, max = 3) =>
  ctrl(key, label, min, max, 0.1, init, (v) => v.toFixed(1));
