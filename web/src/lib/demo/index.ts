/* 公式演示引擎 · 注册表
 *
 * 把三个科目的演示工厂合并成一张表。**这张表是纯 TS、不引 React** ——
 * 因为它要能被 tests/formula-demos.mjs 在 Node 里直接 import，
 * 逐个求值验证「每个演示都不是空壳、也不会算出 NaN」。
 * 一旦这里混进 JSX，那条检查就只能靠真浏览器，成本高一个数量级。
 */
import { CALCULUS_DEMOS } from './kinds/calculus';
import { LINEAR_DEMOS } from './kinds/linear';
import { PROB_DEMOS } from './kinds/prob';
import type { DemoDef, DemoRegistry } from './types';

export const DEMOS: DemoRegistry = {
  ...CALCULUS_DEMOS,
  ...LINEAR_DEMOS,
  ...PROB_DEMOS,
};

export const DEMO_KINDS = Object.keys(DEMOS);

/**
 * 取一个演示定义。
 *
 * variant 允许带子参数（`higher:sin`、`det:transpose`）——
 * 这样同一个交互形态能覆盖一整组公式，而不用给每条公式写一个工厂。
 * 工厂内部自己 split(':').
 *
 * 认不出来的 kind 返回 null，由调用方决定怎么降级（前端会显示一句说明，
 * 而不是白屏）—— 但 tests/formula-demos.mjs 会先把这种情况全部拦下来，
 * 所以线上不该出现 null。
 */
export function demoOf(kind: string, variant = ''): DemoDef | null {
  const f = DEMOS[kind];
  if (!f) return null;
  return f(variant);
}

export type { DemoDef, DemoRegistry } from './types';
export * from './plot';
