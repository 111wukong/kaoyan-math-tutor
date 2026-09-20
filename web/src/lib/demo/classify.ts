/* 公式演示引擎 · 分类器
 *
 * 把 257 条公式映射到「演示哪一个 kind 的哪一个 variant」。
 *
 * ── 为什么是「分组规则表」而不是「逐条公式写死」 ────────────────────
 * 公式库是**按表组织**的（67 个分组，比如「基本导数公式表」15 条、
 * 「基本积分表」19 条）。同一张表里的条目交互形态完全一样 ——
 * 15 条导数公式都是「画 f 和 f'，拖 x 看切线斜率」。所以规则写在**组**上，
 * 组内再用一条正则区分具体演示哪个函数。
 *
 * ── 覆盖度是硬要求 ────────────────────────────────────────────────
 * 需求是「每一条公式都有交互演示」。所以认不出来的分组**返回 null**，
 * 由 tests/formula-demos.mjs 断言「257 条一条都不能是 null」。
 * 不写兜底（比如「认不出就随便给个演示」）——那会让漏掉的公式
 * 看起来有演示，实际上是错的，比没有更糟。
 *
 * ── 名字要先归一化再匹配 ──────────────────────────────────────────
 * 公式名里的减号是 U+2212（−）而不是 ASCII 的 -，空格也不固定。
 * 所以匹配前统一压成「无空格 + ASCII 减号」，正则才能写得短而稳。
 */
import { DEMOS } from './index';

export interface FormulaLike {
  id: string;
  chapterId: string;
  group: string;
  name: string;
  tex: string;
}

export interface DemoSpec {
  kind: string;
  variant: string;
}

/** 组内规则：`[正则, kind, variant]`。正则写 null 表示兜底。 */
type Row = [RegExp | null, string, string];

/** 归一化：去掉所有空白，把各种减号统一成 ASCII 的 - */
const key = (s: string) => String(s || '').replace(/[−–—－]/g, '-').replace(/\s+/g, '');

const RULES: Record<string, Row[]> = {
  /* ================= 第一章 函数、极限与连续 ================= */
  '常用等价无穷小（x → 0）': [
    [/^x-sinx/, 'asymp', 'xsin'],
    [/^tanx-x/, 'asymp', 'tanx'],
    [/^x-ln\(1\+x\)/, 'asymp', 'xln1p'],
    [/^arcsinx-x/, 'asymp', 'arcsinx'],
    [/^1-cosx/, 'asymp', 'cos1'],
    [/^ln\(1\+x\)/, 'asymp', 'ln1p'],
    [/^e\^x-1/, 'asymp', 'exp1'],
    [/^a\^x-1/, 'asymp', 'aexp1'],
    [/^\(1\+x\)\^α-1/, 'asymp', 'pow1p'],
    [/^sinx/, 'asymp', 'sin'],
    [/^tanx/, 'asymp', 'tan'],
    [/^arcsinx/, 'asymp', 'arcsin'],
    [/^arctanx/, 'asymp', 'arctan'],
    [null, 'asymp', 'sin'],
  ],
  '两个重要极限': [
    [/数列型/, 'limit', 'seq'],
    [/函数型/, 'limit', 'e'],
    [/1\^∞/, 'limit', 'powinf'],
    [null, 'limit', 'sinx_x'],
  ],
  '连续与间断': [
    [/间断/, 'continuity', 'break'],
    [null, 'continuity', 'def'],
  ],
  '闭区间连续的性质': [
    [/介值/, 'continuity', 'ivt'],
    [null, 'continuity', 'bounded'],
  ],

  /* ================= 第二章 一元函数微分学 ================= */
  '导数的定义': [
    [/可导/, 'continuity', 'def'],
    [null, 'secant', ''],
  ],
  '基本导数公式表': [
    [/^\(x\^α\)/, 'derivtable', 'power'],
    [/^\(a\^x\)/, 'derivtable', 'aexp'],
    [/^\(e\^x\)/, 'derivtable', 'exp'],
    [/^\(log_ax\)/, 'derivtable', 'logbase'],
    [/^\(lnx\)/, 'derivtable', 'ln'],
    [/^\(sinx\)/, 'derivtable', 'sin'],
    [/^\(cosx\)/, 'derivtable', 'cos'],
    [/^\(tanx\)/, 'derivtable', 'tan'],
    [/^\(cotx\)/, 'derivtable', 'cot'],
    [/^\(secx\)/, 'derivtable', 'sec'],
    [/^\(cscx\)/, 'derivtable', 'csc'],
    [/^\(arcsinx\)/, 'derivtable', 'asin'],
    [/^\(arccosx\)/, 'derivtable', 'acos'],
    [/^\(arctanx\)/, 'derivtable', 'atan'],
    [/^\(arccotx\)/, 'derivtable', 'acot'],
    [null, 'derivtable', 'sin'],
  ],
  '求导法则': [
    [/乘积/, 'derivrule', 'product'],
    [/商法则/, 'derivrule', 'quotient'],
    [/链式/, 'derivrule', 'chain'],
    [/反函数/, 'derivrule', 'inverse'],
    [/参数方程/, 'derivrule', 'param'],
    [/隐函数/, 'derivrule', 'implicit'],
    [null, 'derivrule', 'product'],
  ],
  '高阶导数常用结论': [
    [/\(e\^x\)/, 'derivtable', 'higher:exp'],
    [/\(sinx\)/, 'derivtable', 'higher:sin'],
    [/\(cosx\)/, 'derivtable', 'higher:cos'],
    [/\(lnx\)/, 'derivtable', 'higher:ln'],
    [/莱布尼茨/, 'derivtable', 'higher:leibniz'],
    [null, 'derivtable', 'higher:sin'],
  ],
  '中值定理': [
    [/罗尔/, 'mvt', 'rolle'],
    [/拉格朗日/, 'mvt', 'lagrange'],
    [/柯西/, 'mvt', 'cauchy'],
    [null, 'mvt', 'lagrange'],
  ],
  '泰勒公式': [[null, 'taylor', 'general']],
  '常用麦克劳林展开': [
    [/^e\^x/, 'taylor', 'exp'],
    [/^sinx/, 'taylor', 'sin'],
    [/^cosx/, 'taylor', 'cos'],
    [/^ln\(1\+x\)/, 'taylor', 'ln1p'],
    [/^\(1\+x\)\^α/, 'taylor', 'pow1p'],
    [/^1\/\(1-x\)/, 'taylor', 'geom'],
    [/^1\/\(1\+x\)/, 'taylor', 'geom2'],
    [/^arctanx/, 'taylor', 'arctan'],
    [/^tanx/, 'taylor', 'tan'],
    [null, 'taylor', 'sin'],
  ],
  '洛必达法则': [
    [/未定式/, 'limit', 'powinf'],
    [null, 'limit', 'lhopital'],
  ],
  '单调性与极值': [
    [/第一充分/, 'monotone', 'first'],
    [/第二充分/, 'monotone', 'second'],
    [/凹凸/, 'monotone', 'concavity'],
    [/曲率/, 'derivtable', 'curvature'],
    [null, 'monotone', 'first'],
  ],

  /* ================= 第三章 一元函数积分学 ================= */
  '基本积分表': [
    [/^∫x\^α/, 'antideriv', 'power'],
    [/^∫dx\/x$/, 'antideriv', 'inv'],
    [/^∫e\^x/, 'antideriv', 'exp'],
    [/^∫a\^x/, 'antideriv', 'aexp'],
    [/^∫sinx/, 'antideriv', 'sin'],
    [/^∫cosx/, 'antideriv', 'cos'],
    [/^∫sec²x/, 'antideriv', 'sec2'],
    [/^∫csc²x/, 'antideriv', 'csc2'],
    [/^∫secxtanx/, 'antideriv', 'sectan'],
    [/^∫cscxcotx/, 'antideriv', 'csccot'],
    [/^∫dx\/\(1\+x²\)/, 'antideriv', 'atan'],
    [/^∫dx\/√\(1-x²\)/, 'antideriv', 'asin'],
    [/^∫tanx/, 'antideriv', 'tan'],
    [/^∫cotx/, 'antideriv', 'cot'],
    [/^∫secx/, 'antideriv', 'sec'],
    [/^∫cscx/, 'antideriv', 'csc'],
    [/^∫dx\/\(a²\+x²\)/, 'antideriv', 'a2x2'],
    [/^∫dx\/√\(a²-x²\)/, 'antideriv', 'a2mx2'],
    [/^∫dx\/\(x²-a²\)/, 'antideriv', 'x2ma2'],
    [null, 'antideriv', 'power'],
  ],
  '换元积分法': [[null, 'integral', 'sub']],
  '分部积分法': [
    [/e\^ax/, 'integral', 'expsin'],
    [null, 'integral', 'byparts'],
  ],
  '定积分': [
    [/牛顿/, 'integral', 'nlb'],
    [/换元/, 'integral', 'sub'],
    [/奇偶/, 'integral', 'odd'],
    [/华里士/, 'integral', 'wallis'],
    [null, 'integral', 'riemann'],
  ],
  '变限积分': [
    [/求导/, 'varlimit', 'chain'],
    [null, 'varlimit', 'prim'],
  ],
  '反常积分': [[null, 'integral', 'improper']],
  '定积分的应用': [
    [/平面图形面积/, 'solid', 'area'],
    [/绕x轴/, 'solid', 'revolveX'],
    [/柱壳/, 'solid', 'shell'],
    [/弧长/, 'solid', 'arclen'],
    [/侧面积/, 'solid', 'surface'],
    [/形心/, 'solid', 'centroid'],
    [null, 'solid', 'area'],
  ],

  /* ================= 第四章 多元函数微分学 ================= */
  '偏导数与全微分': [
    [/全微分/, 'multivar', 'totaldiff'],
    [null, 'multivar', 'neccond'],
  ],
  '复合函数求导': [[null, 'multivar', 'chain2']],
  '极值与最值': [
    [/必要条件/, 'multivar', 'need'],
    [/充分条件/, 'multivar', 'sufficient'],
    [/拉格朗日/, 'multivar', 'lagrange'],
    [null, 'multivar', 'sufficient'],
  ],
  '方向导数与梯度': [
    [/方向导数/, 'multivar', 'dirderiv'],
    [null, 'multivar', 'grad'],
  ],

  /* ================= 第五章 重积分 ================= */
  '二重积分': [
    [/直角坐标/, 'doubleint', 'xtype'],
    [/极坐标/, 'doubleint', 'polar'],
    [/交换/, 'doubleint', 'swap'],
    [null, 'doubleint', 'xtype'],
  ],
  '三重积分': [
    [/柱面/, 'doubleint', 'cyl'],
    [/球面/, 'doubleint', 'sph'],
    [null, 'doubleint', 'cyl'],
  ],
  '曲线曲面积分': [
    [/格林/, 'vectorcalc', 'green'],
    [/高斯/, 'vectorcalc', 'gauss'],
    [null, 'vectorcalc', 'green'],
  ],

  /* ================= 第六章 无穷级数 ================= */
  '敛散性判据': [
    [/p级数/, 'series', 'p'],
    [/几何级数/, 'series', 'geom'],
    [/比值/, 'series', 'ratio'],
    [/根值/, 'series', 'root'],
    [/莱布尼茨/, 'series', 'leibniz'],
    [/条件收敛/, 'series', 'abscond'],
    [null, 'series', 'p'],
  ],
  '幂级数': [
    [/收敛半径/, 'series', 'radius'],
    [/逐项求导/, 'series', 'deriv'],
    [/逐项积分/, 'series', 'integ'],
    [null, 'series', 'radius'],
  ],
  '傅里叶级数': [
    [/系数/, 'series', 'fouriercoef'],
    [null, 'series', 'dirichlet'],
  ],

  /* ================= 第七章 微分方程 ================= */
  '一阶微分方程': [
    [/可分离/, 'ode', 'separable'],
    [/齐次/, 'ode', 'homogeneous'],
    [/线性/, 'ode', 'linear'],
    [null, 'ode', 'separable'],
  ],
  '二阶常系数线性': [
    [/不等实根/, 'ode', 'real'],
    [/重根/, 'ode', 'repeat'],
    [/复根/, 'ode', 'complex'],
    [/非齐次/, 'ode', 'particular'],
    [null, 'ode', 'real'],
  ],
  '其它类型': [
    [/全微分/, 'ode', 'exact'],
    [/欧拉/, 'ode', 'euler'],
    [null, 'ode', 'exact'],
  ],

  /* ================= 第八章 行列式 ================= */
  '行列式的性质': [
    [/转置/, 'matrix', 'det:transpose'],
    [/互换/, 'matrix', 'det:swap'],
    [/数乘/, 'matrix', 'det:scale'],
    [/行和相等/, 'matrix', 'det:rowsum'],
    [null, 'matrix', 'det:transpose'],
  ],
  '展开与特殊行列式': [
    [/按行展开/, 'matrix', 'det:expand'],
    [/范德蒙德/, 'matrix', 'det:vander'],
    [/三角/, 'matrix', 'det:triangular'],
    [/分块/, 'matrix', 'det:block'],
    [/克拉默/, 'matrix', 'cramer'],
    [/伴随/, 'matrix', 'det:adj'],
    [null, 'matrix', 'det:expand'],
  ],

  /* ================= 第九章 矩阵 ================= */
  '矩阵运算': [
    [/转置的性质/, 'matrix', 'ops:transpose'],
    [/无交换律/, 'matrix', 'ops:commute'],
    [/乘法的行列式/, 'matrix', 'ops:det'],
    [/逆的转置/, 'matrix', 'ops:invtranspose'],
    [/幂的运算/, 'matrix', 'ops:power'],
    [null, 'matrix', 'ops:commute'],
  ],
  '逆矩阵': [
    [/充要条件/, 'matrix', 'inv:invertible'],
    [/伴随矩阵求逆/, 'matrix', 'inv:adjformula'],
    [/伴随矩阵基本式/, 'matrix', 'inv:adjbasic'],
    [/乘积的逆/, 'matrix', 'inv:product'],
    [/转置与逆与伴随/, 'matrix', 'inv:adjinv'],
    [null, 'matrix', 'inv:invertible'],
  ],
  '矩阵的秩': [
    [/秩的定义/, 'matrix', 'rank:def'],
    [/乘积/, 'matrix', 'rank:product'],
    [/可逆乘/, 'matrix', 'rank:inv'],
    [/加法/, 'matrix', 'rank:sum'],
    [/伴随/, 'matrix', 'rank:adj'],
    [null, 'matrix', 'rank:def'],
  ],

  /* ================= 第十章 向量组 ================= */
  '线性相关与表示': [
    [/判据/, 'vectors', 'dep'],
    [/个数大于维数/, 'vectors', 'morethan'],
    [/零向量/, 'vectors', 'zero'],
    [/部分相关/, 'vectors', 'part'],
    [null, 'vectors', 'dep'],
  ],
  '极大无关组与秩': [
    [/个数/, 'vectors', 'maxindep'],
    [/表示/, 'vectors', 'express'],
    [null, 'vectors', 'maxindep'],
  ],
  '向量空间与基变换': [
    [/过渡矩阵/, 'vectors', 'trans'],
    [/坐标变换/, 'vectors', 'coord'],
    [null, 'vectors', 'trans'],
  ],

  /* ================= 第十一章 线性方程组 ================= */
  '齐次线性方程组': [
    [/非零解/, 'linsolve', 'hom'],
    [/基础解系/, 'linsolve', 'homdim'],
    [/通解结构/, 'linsolve', 'homgen'],
    [null, 'linsolve', 'hom'],
  ],
  '非齐次线性方程组': [
    [/有解的充要条件/, 'linsolve', 'nonhom'],
    [/三种情形/, 'linsolve', 'cases'],
    [/特解/, 'linsolve', 'nonhomgen'],
    [null, 'linsolve', 'cases'],
  ],

  /* ================= 第十二章 特征值与相似 ================= */
  '特征值与特征向量': [
    [/特征方程/, 'eigen', 'eq'],
    [/之和等于迹/, 'eigen', 'trace'],
    [/之积等于行列式/, 'eigen', 'det'],
    [/运算/, 'eigen', 'ops'],
    [/线性无关/, 'eigen', 'indep'],
    [null, 'eigen', 'eq'],
  ],
  '相似与对角化': [
    [/必要条件/, 'eigen', 'similar'],
    [/充要条件/, 'eigen', 'criterion'],
    [/对角化公式/, 'eigen', 'formula'],
    [/矩阵幂/, 'eigen', 'power'],
    [null, 'eigen', 'similar'],
  ],
  '实对称矩阵': [
    [/性质/, 'eigen', 'sym'],
    [/正交/, 'eigen', 'orth'],
    [null, 'eigen', 'sym'],
  ],

  /* ================= 第十三章 二次型 ================= */
  '二次型与合同': [
    [/矩阵表示/, 'quadform', 'matrix'],
    [/合同关系/, 'quadform', 'congruent'],
    [/惯性/, 'quadform', 'inertia'],
    [/配方法/, 'quadform', 'standard'],
    [null, 'quadform', 'matrix'],
  ],
  '正定二次型': [
    [/充要条件/, 'quadform', 'posdef'],
    [/顺序主子式/, 'quadform', 'principal'],
    [/合同于/, 'quadform', 'congruentE'],
    [null, 'quadform', 'posdef'],
  ],

  /* ================= 第十四章 随机事件与概率 ================= */
  '概率基本公式': [
    [/加法/, 'venn', 'add'],
    [/减法/, 'venn', 'sub'],
    [/对立/, 'venn', 'complement'],
    [/独立/, 'venn', 'indep'],
    [null, 'venn', 'add'],
  ],
  '条件概率': [
    [/定义/, 'venn', 'cond'],
    [/乘法/, 'venn', 'mul'],
    [null, 'venn', 'cond'],
  ],
  '全概率与贝叶斯': [
    [/全概率/, 'bayes', 'total'],
    [/贝叶斯/, 'bayes', 'bayes'],
    [null, 'bayes', 'bayes'],
  ],
  '古典与几何概型': [
    [/古典/, 'classic', 'classical'],
    [/几何/, 'classic', 'geometric'],
    [/伯努利/, 'classic', 'bernoulli'],
    [null, 'classic', 'geometric'],
  ],

  /* ================= 第十五章 随机变量及其分布 ================= */
  '常用离散型分布': [
    [/0-1/, 'dist', 'bern'],
    [/二项/, 'dist', 'binom'],
    [/泊松/, 'dist', 'poisson'],
    [/几何/, 'dist', 'geom'],
    [/超几何/, 'dist', 'hyper'],
    [null, 'dist', 'binom'],
  ],
  '常用连续型分布': [
    [/标准正态/, 'dist', 'stdnormal'],
    [/正态标准化/, 'dist', 'standardize'],
    [/正态/, 'dist', 'normal'],
    [/均匀/, 'dist', 'uniform'],
    [/指数/, 'dist', 'exp'],
    [null, 'dist', 'normal'],
  ],
  '分布函数与密度': [
    [/定义/, 'dist', 'cdf:def'],
    [/密度与分布函数/, 'dist', 'cdf:dens'],
    [/归一/, 'dist', 'cdf:normalize'],
    [null, 'dist', 'cdf:def'],
  ],
  '随机变量函数的分布': [[null, 'dist', 'transform']],

  /* ================= 第十六章 多维随机变量 ================= */
  '联合与边缘分布': [[null, 'joint', 'joint']],
  '独立性': [[null, 'joint', 'indep']],
  '协方差与相关系数': [
    [/协方差定义/, 'moments', 'covdef'],
    [/相关系数/, 'moments', 'corr'],
    [/协方差的运算/, 'moments', 'covops'],
    [/和的方差/, 'moments', 'sumvar'],
    [/二维正态/, 'moments', 'bivarnormal'],
    [null, 'moments', 'corr'],
  ],

  /* ================= 第十七章 数字特征 ================= */
  '期望': [
    [/离散型/, 'moments', 'disc'],
    [/连续型/, 'moments', 'cont'],
    [/函数的期望/, 'moments', 'func'],
    [/线性性/, 'moments', 'linear'],
    [/乘积/, 'moments', 'product'],
    [null, 'moments', 'disc'],
  ],
  '方差': [
    [/定义/, 'moments', 'vardef'],
    [/计算公式/, 'moments', 'varformula'],
    [/性质/, 'moments', 'varops'],
    [/切比雪夫/, 'moments', 'chebyshev'],
    [null, 'moments', 'vardef'],
  ],

  /* ================= 第十八章 大数定律与中心极限定理 ================= */
  '大数定律': [
    [/切比雪夫/, 'limittheorem', 'chebyshev'],
    [/伯努利/, 'limittheorem', 'bernoulli'],
    [null, 'limittheorem', 'chebyshev'],
  ],
  '中心极限定理': [
    [/独立同分布/, 'limittheorem', 'iid'],
    [/棣莫弗/, 'limittheorem', 'demoivre'],
    [null, 'limittheorem', 'iid'],
  ],

  /* ================= 第十九章 数理统计 ================= */
  '统计量与抽样分布': [
    [/样本均值与样本方差/, 'inference', 'meanvar'],
    [/样本均值的分布/, 'inference', 'mean'],
    [/χ²/, 'inference', 'chi2'],
    [/t分布/, 'inference', 't'],
    [null, 'inference', 'mean'],
  ],
  '参数估计': [
    [/矩估计/, 'inference', 'moment'],
    [/似然函数/, 'inference', 'likelihood'],
    [/极大似然/, 'inference', 'mle'],
    [/无偏/, 'inference', 'unbiased'],
    [null, 'inference', 'mle'],
  ],
  '区间估计与假设检验': [
    [/σ已知/, 'inference', 'ci_known'],
    [/σ未知/, 'inference', 'ci_unknown'],
    [/两类错误/, 'inference', 'errors'],
    [null, 'inference', 'ci_known'],
  ],
};

/**
 * 公式 → 演示。
 *
 * 返回 null 表示「这条公式还没有对应的交互演示」—— 前端会显示一句明确的说明，
 * 而 tests/formula-demos.mjs 会断言这种情况在 257 条里**一条都不出现**。
 */
export function demoFor(f: FormulaLike): DemoSpec | null {
  const rows = RULES[f.group];
  if (!rows) return null;
  const k = key(f.name);
  for (const [re, kind, variant] of rows) {
    if (re === null || re.test(k)) {
      /* 双重保险：规则表里写了不存在的 kind 也要暴露出来，别等到运行时白屏 */
      if (!DEMOS[kind]) return null;
      return { kind, variant };
    }
  }
  return null;
}

/** 分组表本身（给测试用：验证 67 个分组一个都没漏） */
export const GROUP_RULES = RULES;
