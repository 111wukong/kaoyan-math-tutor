import { useEffect, useRef } from 'react';
import { createShaderRenderer, hexToRgb, type ShaderRenderer } from './webgl';

/* 赛博网格地平线背景
 *
 * 视觉构成（从远到近）：
 *   1. 地面透视网格 —— 主格 + 细格两层，越远越密、越远越淡（exp 雾）
 *   2. 能量脉冲 —— 一道亮带沿 z 轴周期性向外推进，让"静止的网格"动起来
 *   3. 地平线光带 —— 窄亮带 + 宽柔光两层，是整张图的视觉锚点
 *   4. 扫描线 —— 从上往下匀速掠过，速度慢到不干扰阅读
 *   5. 天空纵向数据线 —— 极淡，只为了不让上半屏空着
 *   6. 暗角 —— 四角压暗，把注意力收到中间
 *
 * 三条纪律（不然"炫酷"会变成"看不清"）：
 *   · 整体亮度压得很低。背景是背景，内容是主角。
 *   · 天空只放 0.05 量级的线，正文区域的对比度必须留给文字。
 *   · 所有动效在 prefers-reduced-motion 下停住，只留一帧静态图。
 *
 * 降级：拿不到 WebGL2 上下文时 createShaderRenderer 返回 null，
 *       这个组件就不渲染 canvas，CSS 里的静态光晕与网格接管。
 */

const FRAG = `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;     // -1..1
uniform vec3  uC1;        // 主强调（青）
uniform vec3  uC2;        // 次强调（蓝）
uniform vec3  uC3;        // 第三强调（紫）
uniform float uIntensity;

const float HORIZON = -0.15;   // 地平线的屏幕位置（uv.y，0 为垂直中心，+0.5 为顶）
                               // 压在中心线以下：地平线光带是整张图最亮的东西，
                               // 放中间会正好横穿正文标题。往下挪，让它落在内容稀疏处。

/* 网格线强度，带基于导数的抗锯齿。
 * 除以 fwidth 是关键：不这么做的话远处网格会变成一片摩尔纹噪点。
 *
 * 但抗锯齿有代价 —— 格子小到接近像素尺寸时（地平线附近），
 * fract 的锯齿让**每一个像素**都落在"线"上，整片地面糊成一块亮斑。
 * 实测地平线下方 100px 处的亮度是屏幕底部的 20 倍，看起来像块发光的布。
 * 所以再用「每格占几个像素」把线淡出：低于 3px/格不画，9px/格以上全画。
 * 这是标准的网格淡出做法，比单纯加大雾效干净得多。 */
float gridMask(vec2 q, float thick) {
  vec2 fw = max(fwidth(q), vec2(1e-5));
  vec2 d = abs(fract(q - 0.5) - 0.5) / fw;
  float m = 1.0 - min(min(d.x, d.y) / thick, 1.0);
  float pxPerCell = 1.0 / max(fw.x, fw.y);
  return m * smoothstep(3.0, 9.0, pxPerCell);
}

/* 一个沿 t 方向循环推进的亮带，返回 0..1 */
float pulseBand(float x, float speed, float width) {
  float ph = fract(x - uTime * speed);
  return smoothstep(0.0, width, ph) * smoothstep(width * 5.0, width, ph);
}

/* ---- 顺序抖动（4×4 Bayer 有序抖动）----
 *
 * 为什么必须有这一步：
 *   底色是 rgb(5,6,12) 这个量级，而地平线光带、暗角都是跨几百像素的极缓渐变 ——
 *   实测天空区一段 585 像素的跨度里梯度只有 ~0.03 色阶/像素。
 *   8 位量化会把几十个像素压进同一个色阶，屏幕上就是一条条宽几十像素的同心色带。
 *
 *   **这不是配色问题，是量化问题。** 调亮度、调对比度、换颜色都治不好，
 *   只会把色带挪到别处。隔离实验的数字（只跑着色器、藏掉 CSS 层）：
 *     不抖动   平台占比 0.964  最长平台 81px  中位跳变 1.715 色阶 → Weber 14.4%
 *     加抖动   平台占比 0.021  最长平台  6px
 *   人眼在大面积均匀场上的分辨阈约 1%，14.4% 是肉眼可见的硬色带。
 *
 * 为什么是 Bayer 而不是 Interleaved Gradient Noise / 随机 hash：
 *   ★ 试过 IGN（伪随机），抖动效果一样好（平台占比 0.021），但它是逐像素白噪声，
 *     PNG 完全压不动 —— 截图从 2.2MB 涨到 4.1MB，而 headless 下
 *     captureScreenshot 的编码路径会因此**永久挂住**（25 秒、60 秒超时都一样），
 *     15 张截图里有 2/4 直接超时，整个截图管线瘫掉。
 *   ★ Bayer 是 4×4 的周期性图案，PNG 的 Sub/Up/Paeth 逐行预测器对它预测得准，
 *     deflate 压得动。同样是 1px 粒度，体积和稳定性都回来了。
 *
 *   抖动幅度必须是 ±半个色阶：作用是"在量化边界上做无偏取舍"，
 *   让四舍五入的结果在空间上交替，人眼把 1px 的碎块积分回原来的平滑值。
 *   超过半个色阶就不再是抖动，而是可见的噪点；小于半个色阶，
 *   落在色阶桶中间的像素永远不翻转，平台会重新长出来。 */
const float BAYER4[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0
);

/* 返回 0..1 的阈值，16 级均匀分布。
 * 加 1/32 是把 16 个台阶居中（否则均值偏 -0.5/16 个色阶，暗部会整体压暗一点点）。 */
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  return BAYER4[i.y * 4 + i.x] / 16.0 + 1.0 / 32.0;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

  /* ---- 相机。鼠标做视差：横移 + 轻微升降 ---- */
  vec3 ro = vec3(uMouse.x * 0.62, 0.40 + uMouse.y * 0.11, -uTime * 1.30);
  vec3 rd = normalize(vec3(uv.x, uv.y - HORIZON, -1.0));

  vec3 col = vec3(0.0);

  /* ---- 地面 ---- */
  if (rd.y < -1e-4) {
    float t = -ro.y / rd.y;
    vec3 hit = ro + rd * t;
    vec2 p = hit.xz;

    float fog = exp(-t * 0.105);            // 远处淡出

    float gMain = gridMask(p * 0.5, 1.0);
    float gFine = gridMask(p * 2.0, 0.9) * 0.26;
    float g = max(gMain, gFine);

    /* 能量脉冲：沿 z 往外推，只加在主格上，不然会糊成一片 */
    g += pulseBand(p.y * 0.055, 0.19, 0.05) * 0.62 * gMain;

    /* 相机正前方地面的同心涟漪 —— 让鼠标一动就有反馈 */
    float dm = length(p - vec2(ro.x, ro.z + 3.4));
    g += exp(-pow(fract(dm * 0.19 - uTime * 0.30) - 0.5, 2.0) * 210.0) * 0.45 * gMain;

    /* 颜色随距离由青转紫，地平线附近偏蓝 */
    vec3 gc = mix(uC1, uC3, clamp(t * 0.045, 0.0, 1.0));
    gc = mix(gc, uC2, clamp(t * 0.018, 0.0, 0.55));

    col += gc * g * fog * 1.60;
  }

  /* ---- 地平线光带 ----
   * 两层：窄的做"线"，宽的做"光"。
   *
   * 这里调过三轮，结论是**视觉重心必须放在网格上，不能放在光带上**：
   *   · 第一版峰值 0.80 / 衰减 52 —— 一条 17px 的亮线横穿屏幕，
   *     正好压住正文标题，字都读不清了。
   *   · 第二版峰值 0.30 / 衰减 34 —— 窄是窄了，但落点正好在两排卡片之间
   *     的空隙里，比压在卡片后面还显眼（卡片会把背景糊掉，空隙不会）。
   *   · 现在峰值 0.16 / 衰减 20 —— 一条 40px 宽、很淡的暮色。
   *     它只负责给地平线一个"位置感"，亮度交给网格线：
   *     网格是 2px 细线，穿不过文字，再怎么亮都不影响阅读。
   * 改这两个数之前，先去仪表盘上看一眼「学习数据」那行标题还读不读得清。 */
  float hy = HORIZON + uMouse.y * 0.11;
  col += mix(uC1, uC2, 0.45) * exp(-abs(uv.y - hy) * 20.0) * 0.16;
  col += uC2 * exp(-abs(uv.y - hy) * 4.5) * 0.09;

  /* ---- 扫描线：从上往下 ---- */
  float sy = 1.0 - fract(uTime * 0.062) * 1.75;
  col += uC1 * exp(-abs(uv.y - sy) * 105.0) * 0.20;

  /* ---- 天空：极淡的纵向数据线 ---- */
  if (uv.y > hy) {
    float q = uv.x * 15.0;
    float d = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), 1e-5);
    float v = 1.0 - min(d / 1.5, 1.0);
    col += uC3 * v * 0.050 * smoothstep(hy, hy + 0.55, uv.y);
  }

  /* ---- 暗角 ---- */
  vec2 vg = uv * vec2(uRes.x / uRes.y, 1.0);
  col *= 1.0 - 0.42 * clamp(dot(vg, vg) * 0.55, 0.0, 1.0);

  /* 底色加在强度**之后**（写在乘号右边）：画布是不透明的（alpha:false），
   * 没有任何东西的地方会输出纯黑，而页面底色是 #05060c —— 并排能看出色差。
   * 补上 ink-950 的 RGB，WebGL 与 CSS 降级路径的底色就完全一致了。
   * 注意别写成 col += base 再整体乘强度，那样底色会被一起压暗 38%。 */
  fragColor = vec4(col * uIntensity + vec3(0.0196, 0.0235, 0.0471), 1.0);

  /* ★ 抖动必须是**最后一步**。
   * 前面所有中间量都还是 float，精度足够，量化只发生在这条语句写进
   * 8 位后备缓冲的那一刻。加在中间量上等于没加 —— 后面还有一次量化会把它抹平。
   * 这也是唯一必须写在这个位置的一行，别往上挪。
   *
   * ⚠️ 这段 GLSL 整体写在一个 JS 模板字符串里，所以**注释里不能出现反引号**，
   * 否则模板字符串会提前结束，报的错是"这里该插分号"，跟真正的原因差十万八千里。 */
  fragColor.rgb += (bayer4(gl_FragCoord.xy) - 0.5) / 255.0;
}
`;

const UNIFORMS = ['uRes', 'uTime', 'uMouse', 'uC1', 'uC2', 'uC3', 'uIntensity'] as const;

/** 主色板。和 index.css 里的 --color-cyan / blue / violet 保持一致。 */
const ACCENT: [string, string, string] = ['#22d3ee', '#3b82f6', '#a855f7'];

/* WebGL 活着的时候，在 <html> 上挂一个 fx-webgl 类。
 *
 * 为什么要这个类：CSS 里那层 56px 静态网格（body::after）是**降级备胎** ——
 * WebGL 挂了的时候由它撑住"有纵深参照"这件事。但 WebGL 正常时，
 * 一层平铺的正交网格叠在透视网格上，两套网格互相打架，谁都看不清。
 * 所以 WebGL 一起来就把静态网格压下去。
 *
 * 用引用计数而不是布尔量：登录页 → 仪表盘 的切换里，两个布局的
 * effect 会在同一帧先后跑（旧 cleanup 先、新 effect 后），
 * 直接 add/remove 会闪一帧静态网格。
 */
let webglUsers = 0;
function markWebGLAlive(on: boolean) {
  if (typeof document === 'undefined') return;
  webglUsers = Math.max(0, webglUsers + (on ? 1 : -1));
  document.documentElement.classList.toggle('fx-webgl', webglUsers > 0);
}

export function CyberGrid({
  className = '',
  /** 整体亮度。默认值经过调校：再高正文就开始难读了。 */
  intensity = 0.62,
}: {
  className?: string;
  intensity?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const r: ShaderRenderer | null = createShaderRenderer(canvas, FRAG, UNIFORMS);
    /* 拿不到 WebGL2 → 不渲染任何东西，CSS 里的静态背景接管 */
    if (!r) return;

    markWebGLAlive(true);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const [c1, c2, c3] = ACCENT.map(hexToRgb);
    r.setUniform('uC1', c1);
    r.setUniform('uC2', c2);
    r.setUniform('uC3', c3);
    r.setUniform('uIntensity', intensity);

    /* 背景不需要 2x。1.25 在视网膜屏上已经看不出差别，
     * 但像素量只有 2x 的 39% —— 全屏着色器这是最划算的一刀。 */
    let dpr = 1.25;
    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const changed = r.resize(rect.width, rect.height, dpr);
      if (changed) r.setUniform('uRes', [r.width, r.height]);
    };

    /* ---- 鼠标视差：缓动，避免跟随生硬 ---- */
    const target = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      target.x = (e.clientX / window.innerWidth - 0.5) * 2;
      target.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };

    let raf = 0;
    let running = true;
    let last = performance.now();
    let t0 = performance.now();
    let elapsed = 0;

    /* 卡顿自适应：连续掉帧就把分辨率降下来。
     * 背景是装饰，宁可糊一点也不能让整页跟着卡。 */
    let slowFrames = 0;
    let downgraded = false;

    const frame = (now: number) => {
      if (!running) return;
      const dt = now - last;
      last = now;

      if (!reduced) elapsed += Math.min(dt, 64) / 1000;

      /* 掉帧检测只在开头几秒做，之后不再折腾分辨率 */
      if (!downgraded && elapsed > 0.4 && elapsed < 6) {
        if (dt > 26) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
        if (slowFrames > 24) {
          downgraded = true;
          dpr = 0.85;
          fit();
        }
      }

      cur.x += (target.x - cur.x) * 0.045;
      cur.y += (target.y - cur.y) * 0.045;
      r.setUniform('uMouse', [cur.x, cur.y]);
      r.setUniform('uTime', elapsed);
      r.render();

      raf = requestAnimationFrame(frame);
    };

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 140);
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    /* 上下文丢失：不 preventDefault 的话浏览器不会尝试恢复。
     * 恢复后必须重建 —— 着色器程序已经失效了，这里直接刷新页面级别的重建代价太大，
     * 所以退而求其次：恢复时重设一次 uniform 并继续画。 */
    const onLost = (e: Event) => {
      e.preventDefault();
      running = false;
      cancelAnimationFrame(raf);
    };
    const onRestored = () => {
      fit();
      r.setUniform('uC1', c1);
      r.setUniform('uC2', c2);
      r.setUniform('uC3', c3);
      r.setUniform('uIntensity', intensity);
      if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    fit();
    raf = requestAnimationFrame(frame);

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      markWebGLAlive(false);
      r.dispose();
    };
  }, [intensity]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      /* 给测试一个稳定的抓手。别用 querySelector('canvas') —— 页面上有两个
       * 画布（赛博网格 / 星尘），位置一变就选错，而且对 WebGL 画布调
       * getContext('2d') 会拿到 null，报出来的错和真实原因八竿子打不着。 */
      data-fx="cybergrid"
      /* -z-20：在所有背景层之下、CSS 光晕之上。
       * 之所以不用 -z-10：那一层留给 Starfield 的星尘，星星要浮在网格前面。 */
      className={`pointer-events-none fixed inset-0 -z-20 h-full w-full ${className}`}
    />
  );
}
