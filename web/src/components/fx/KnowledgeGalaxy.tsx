import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { cn, cssVar, withAlpha } from '@/lib/utils';
import { hexToRgb } from './webgl';
import { useFxAccents } from './theme-colors';

/* ============================================================
   知识星系 —— 可旋转的 3D 考点球
   ============================================================
   为什么不用 CSS 3D transform 摆球面：
   纯 CSS 的话，节点转到球体侧面时会**变成一条线**（平面被侧看压扁），
   转到背面时还会因为 z 顺序问题互相穿透。要修就得给每个节点
   反向旋转做 billboard，那也是每帧算一遍 —— 既然都要算，不如直接算投影。

   这里的做法是经典的「3D 标签云」：
     · 用 Fibonacci 球面分布把考点均匀铺在球面上（黄金角，不结块）
     · 按纬度排序后切给各科目 —— 于是每个科目自然形成一条"纬带"，
       颜色成片，不是随机撒点
     · 每帧在 JS 里做一次旋转 + 透视除法，把 3D 坐标投影成 2D 平移 + 缩放
     · 节点本身始终是平的、正对屏幕（天然 billboard），按深度调透明度和大小
     · 连线的坐标本来就算出来了，顺手画在一张 canvas 上 ——
       用 SVG 的话 68 条线就是 68 个 DOM 节点每帧改属性，不值

   可访问性：节点是真的 <Link>，能 Tab 到、能被读屏读到；
   搜索和逐条浏览仍然由原来的列表视图承担（顶部可切换）。
   星系是"看"的入口，列表是"用"的入口 —— 两者都不能少。

   prefers-reduced-motion：不自动旋转，只响应拖动。
   ============================================================ */

type Node3D = {
  id: string;
  title: string;
  mastery: string;
  difficulty: number;
  /** 单位球面坐标，预计算一次 */
  x: number; y: number; z: number;
  /** 所属科目颜色，用于连线和点色 */
  color: string;
  /** 同章节序号，用来决定谁跟谁连线 */
  chapter: string;
};

/* 掌握度 → 颜色。
 *
 * 原来是一组写死的 RGB 三元组（52,211,153 之类），直接拼进 `rgb(...)`。
 * 那是深空配色：亮色主题下这几个浅色压在浅底上会糊成一片 ——
 * 而节点圆点很小，糊了之后「哪个考点掌握了」这个信息就没了。
 *
 * 改成从主题令牌读。注意这里**不能**用 lib/utils 的 withAlpha（color-mix），
 * 因为下面要把它转成 rgb 三元组喂给 canvas，而 color-mix 在 canvas 的
 * strokeStyle 上支持得晚、失败还静默。 */
function masteryColor(level: string): string {
  switch (level) {
    case 'mastered': return cssVar('--color-emerald', '#34d399');
    case 'proficient': return cssVar('--color-cyan', '#22d3ee');
    case 'learning': return cssVar('--color-amber', '#fbbf24');
    default: return cssVar('--color-fg-faint', '#94a3b8');
  }
}

/* Fibonacci 球面：黄金角螺旋，是球面上最均匀的铺法。
 * 用随机撒点会结块，用经纬网格会在两极堆积 —— 都不行。 */
function fibonacciSphere(n: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;   // 1 → -1，天然按纬度降序
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return pts;
}

export function KnowledgeGalaxy({
  categories,
  className,
}: {
  categories: any[];
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sphereRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodeRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);

  /* 连线的颜色。渲染时同步写进 ref —— 不用 useEffect，那会慢一帧，
   * 换主题时能看见连线"过一拍才变色"。
   * 取值时转成 rgb 三元组：canvas 只吃具体颜色，而 color-mix() 在
   * canvas 的 strokeStyle 上支持得晚、失败还是静默的。 */
  const accents = useFxAccents();
  const linkRgbRef = useRef<[number, number, number]>(hexToRgb(accents.cyan));
  linkRgbRef.current = hexToRgb(accents.cyan);

  /* ---- 布点：一次算好，别每帧重算 ---- */
  const nodes = useMemo<Node3D[]>(() => {
    const flat: { id: string; title: string; mastery: string; difficulty: number; color: string; chapter: string }[] = [];
    for (const cat of categories) {
      for (const ch of cat.chapters || []) {
        for (const n of ch.nodes || []) {
          flat.push({
            id: n.id, title: n.title, mastery: n.mastery, difficulty: n.difficulty,
            color: cat.color || '#22d3ee', chapter: ch.id,
          });
        }
      }
    }
    if (!flat.length) return [];
    /* 按纬度排序后切给各科目 → 每科占一条纬带。
     * 不排序直接切的话，一个科目会同时出现在球的两极和赤道，糊成一团。 */
    const pts = fibonacciSphere(flat.length);
    return flat.map((n, i) => ({ ...n, x: pts[i][0], y: pts[i][1], z: pts[i][2] }));
  }, [categories]);

  /* ---- 章节分组：只有同章的节点才连线，不然是一团毛线 ---- */
  const links = useMemo(() => {
    const byCh = new Map<string, number[]>();
    nodes.forEach((n, i) => {
      const a = byCh.get(n.chapter) || [];
      a.push(i);
      byCh.set(n.chapter, a);
    });
    const out: [number, number][] = [];
    for (const idx of byCh.values()) {
      for (let i = 0; i + 1 < idx.length; i++) out.push([idx[i], idx[i + 1]]);
    }
    return out;
  }, [nodes]);

  /* ---- 视角状态放 ref：每帧都读写的量绝不能进 React state ---- */
  const view = useRef({ yaw: 0.6, pitch: -0.25, yawVel: 0, pitchVel: 0, zoom: 1 });
  const drag = useRef({ active: false, moved: 0, lastX: 0, lastY: 0 });
  const reduced = useRef(false);

  const reset = useCallback(() => {
    view.current.yaw = 0.6;
    view.current.pitch = -0.25;
    view.current.yawVel = 0;
    view.current.pitchVel = 0;
    view.current.zoom = 1;
  }, []);

  /* ---- 可见性：滚出屏幕就停，别在看不见的地方烧 CPU ---- */
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* ---- 主循环 ---- */
  useEffect(() => {
    const host = hostRef.current;
    const sphere = sphereRef.current;
    const canvas = canvasRef.current;
    if (!host || !sphere || !canvas || !nodes.length) return;

    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let running = true;
    let W = 0, H = 0, R = 0;

    const fit = () => {
      const r = host.getBoundingClientRect();
      W = r.width;
      H = r.height;
      /* 球半径。取 min(宽×0.36, 高×0.50) 而不是简单取短边的一半 ——
       * 内容区是"宽而扁"的（1140×640），按短边算球会小得可怜，
       * 68 个标签全叠在中间。横向还有很大余量，可以多要一点。
       *
       * ★ 但前两项都**没算最外圈标签会甩到哪**，窄屏上就露馅了。
       *
       * 先别急着拿"最近点的放大倍数"（1.724）去算 —— 那是错的。
       * 球面约束下 sqrt(x²+y²) = sqrt(1 − z²)，所以投影半径其实是
       *     f(z) = sqrt(1 − z²) / (1 + 0.42z)        （z ≤ 0 是前半颗球）
       * z = −1（最近点）时 f = 0：它在球心正上方，投影半径是 0；
       * z = 0（赤道）时 f = 1；
       * f 在 z ≈ −0.42 处取到最大值 ≈ 1.102。
       * 所以最外圈那批标签的半径是 1.102R，不是 1.724R。
       * （第一版按 1.724 算，桌面球从 320 被白砍到 285。）
       *
       * 约束就是「1.102R + 标签半宽 ≤ 半宽」。
       *
       * 标签半宽按最坏情况算，别拍脑袋：
       *   药丸 = 圆点 6 + 间距 6 + 文字 ≤130（max-w-[130px] 会截断）
       *        + 左右 padding 12 + 边框 2 = 156
       *   它在 z ≈ −0.42 处被放大 1.214 倍 → 半宽 = 156 × 1.214 / 2 ≈ 95
       * 再留 5 余量取 100。
       * （取 86 的时候，「多元复合函数求导（链式法则）」这条最长的标签
       *   刚好越界 —— 断言抓到了，就差一两个像素。）
       *
       * 手机宽 390 时这一项给出 77（原来是 140）—— 正是被切掉的那批。 */
      const MAX_R_FACTOR = 1.102;
      const LABEL_HALF = 100;
      R = Math.min(
        W * 0.36,
        H * 0.50,
        Math.max(56, W / 2 / MAX_R_FACTOR - LABEL_HALF),
      );
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const sx: number[] = new Array(nodes.length);
    const sy: number[] = new Array(nodes.length);
    const sz: number[] = new Array(nodes.length);
    const ss: number[] = new Array(nodes.length);
    const frame = () => {
      if (!running) return;
      const v = view.current;
      /* 每帧取一次当前主题的连线色（ref 在渲染时已同步好）。
       * 取的是 ref 不是 cssVar()：后者每帧都会触发一次样式重算。 */
      const linkRgb = linkRgbRef.current;

      /* 惯性 → 静止后接管为自转。
       * 拖完手一松如果立刻跳回自转速度会很跳，所以让惯性先衰减，
       * 衰减到几乎为零再叠自转。 */
      if (!drag.current.active) {
        v.yaw += v.yawVel;
        v.pitch += v.pitchVel;
        v.yawVel *= 0.94;
        v.pitchVel *= 0.94;
        if (!reduced.current && Math.abs(v.yawVel) < 0.0006) v.yaw += 0.0018;
      }
      /* 俯仰夹住：不夹的话球会翻过去，纬度带倒过来，颜色全乱 */
      v.pitch = Math.max(-1.25, Math.min(1.25, v.pitch));

      const cy = Math.cos(v.yaw), syw = Math.sin(v.yaw);
      const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);

      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        /* 绕 Y 轴转（偏航） */
        const x1 = n.x * cy + n.z * syw;
        const z1 = -n.x * syw + n.z * cy;
        /* 再绕 X 轴转（俯仰） */
        const y2 = n.y * cp - z1 * sp;
        const z2 = n.y * sp + z1 * cp;

        /* 透视除法。z2 ∈ [-1,1]，z2 < 0 是正面（近），z2 > 0 是背面（远）。
         * 系数 0.42 是调出来的：0.55 时远近尺寸差 3.4 倍，近处的标签
         * 会大到把旁边的全盖住；0.42 的 2.35 倍既有纵深又不喧宾夺主。
         *
         * ★ 背面额外再压一档（back）。
         * 不加这一档时，背半球的标签半径只比正面小 30% ——
         * 于是 68 个标签里有一半挤在球心那一片，糊成一团。
         * 只压背面、不放大正面：放大正面只会让近处的标签互相盖住。 */
        const back = z2 > 0 ? z2 * 0.32 : 0;
        const persp = 1 / (1 + z2 * 0.42 + back);
        const px = x1 * R * persp * v.zoom;
        const py = -y2 * R * persp * v.zoom;

        sx[i] = W / 2 + px;
        sy[i] = H / 2 + py;
        sz[i] = z2;
        ss[i] = persp * v.zoom;
      }

      /* ---- 连线先画，压在节点下面 ----
       *
       * 颜色从主题强调色来（原来是写死的 34,211,238）。
       * canvas 的 strokeStyle 只吃具体颜色字符串，所以这里用 hexToRgb
       * 手动拼 rgba()，**不用** lib/utils 的 withAlpha —— 那个产出的是
       * color-mix()，在 canvas 上支持得晚，而且不支持时是**静默失效**
       * （连线直接消失，控制台一声不响）。
       * 每帧只在循环外算一次，不是每个连线一次。 */
      ctx.lineWidth = 1;
      const [lr, lg, lb] = linkRgb;
      for (const [a, b] of links) {
        /* 两端都在背面就连线也淡掉，否则球会看起来是"实心"的 */
        const depth = (sz[a] + sz[b]) / 2;
        const alpha = (1 - (depth + 1) / 2) * 0.30;
        if (alpha <= 0.012) continue;
        ctx.strokeStyle = `rgba(${Math.round(lr * 255)}, ${Math.round(lg * 255)}, ${Math.round(lb * 255)}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(sx[a], sy[a]);
        ctx.lineTo(sx[b], sy[b]);
        ctx.stroke();
      }

      /* ---- 节点 ---- */
      for (let i = 0; i < nodes.length; i++) {
        const el = nodeRefs.current[i];
        if (!el) continue;
        const depth01 = (sz[i] + 1) / 2;                 // 0 近 → 1 远
        const scale = ss[i];
        /* 透明度的曲线是"雾"，不是"线性"。
         *
         * 线性（原来的 0.16 + (1-d)*0.84）的问题是：球心那片是背半球标签
         * 的投影区，深度 0.4~0.7 的标签拿到 0.4~0.6 的不透明度 ——
         * 每个都还看得清字，几十个叠在一起就是一团糊。
         * 改成 2.2 次幂 + 0.07 地板之后：
         *   d=0.25 → 0.61   d=0.5 → 0.32   d=0.75 → 0.14   d=1 → 0.07
         * 也就是"前面几个字清清楚楚，后面半颗球只剩一层星尘"。
         *
         * 地板留 0.07 而不是 0：全透明仍占着 Tab 焦点，键盘用户会 Tab 到
         * 看不见的东西上；留一点微光既保住了"球是完整的"这个感觉，
         * 也让焦点落上去时能靠 hover 高亮找回来。 */
        const opacity = 0.07 + Math.pow(1 - depth01, 2.2) * 0.93;
        /* ⚠️ 这里必须用**相对容器中心**的偏移量，不能用 sx/sy。
         * 节点本身已经是 left:50% top:50%，也就是已经站在中心了；
         * sx/sy 里还含着 W/2、H/2，再写进去就是偏移两次 ——
         * 症状是所有节点整体挤到右下角，而 canvas 上的连线还在正确位置，
         * 两边对不上。（第一次就是这么错的。） */
        el.style.transform = `translate3d(${(sx[i] - W / 2).toFixed(1)}px, ${(sy[i] - H / 2).toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        el.style.opacity = opacity.toFixed(3);
        el.style.zIndex = String(Math.round((1 - depth01) * 100));
      }

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
        raf = requestAnimationFrame(frame);
      }
    };

    fit();
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [nodes, links, visible]);

  /* ---- 拖动 ----
   *
   * ★ 这里**不能**用 setPointerCapture。曾经用了，代价是节点完全点不动。
   *
   * 机制：指针捕获会把 pointerup 重定向到捕获元素（也就是这个容器）。
   * 而 click 的落点按规范是「pointerdown 目标与 pointerup 目标的**最近公共祖先**」——
   * pointerdown 落在节点的 <span> 上、pointerup 被挪到了容器上，
   * 最近公共祖先就成了容器本身。于是 click 永远打不到节点上的 <Link>，
   * 症状是「球能转、但点不进任何考点」，而且**控制台一声不响、测试也不会红**。
   *
   * 实测的事件流（CDP 真鼠标点在「反常积分」上）：
   *   pointerdown → SPAN(节点内)
   *   pointerup   → DIV[data-galaxy=host]     ← 被捕获重定向
   *   click       → DIV[data-galaxy=host]     ← 链接收不到，不跳转
   * 同一个节点用 el.click()（JS 直接点）却能正常跳 —— 说明链接本身没问题，
   * 坏的只有「真鼠标」这条路。用户就是这么点的。
   *
   * 改成拖拽期间把 move / up 挂到 window 上：
   *   · 效果一样（更好：拖出容器也不丢），拖完照样有惯性；
   *   · pointerup 落在哪就是哪，节点上的 click 恢复原生行为 ——
   *     Cmd/Ctrl+点击新标签页、中键这些也不用自己模拟。
   */
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d.active) return;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);

    const v = view.current;
    v.yaw += dx * 0.0062;
    v.pitch += dy * 0.0052;
    /* 存速度而不是位移：松手后惯性延续的就是这个 */
    v.yawVel = dx * 0.0062 * 0.55;
    v.pitchVel = dy * 0.0052 * 0.55;
  }, []);

  const endDrag = useCallback(() => {
    drag.current.active = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }, [onPointerMove]);

  const onPointerDown = (e: React.PointerEvent) => {
    /* 只认主键；右键/中键留给浏览器（中键是"新标签页打开"） */
    if (e.button !== 0) return;
    /* moved 每次按下都归零。不归零的话，上一次「拖完松在容器外」留下的
     * 大位移会把下一次真正的点击也吞掉 —— onClickCapture 只看这个数。 */
    drag.current = { active: true, moved: 0, lastX: e.clientX, lastY: e.clientY };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  };

  /* 卸载时兜底摘监听 —— 拖到一半切走页面（或路由保活把它藏起来），
   * 监听会留在 window 上，下一次在别的页面动鼠标还在转这颗球。 */
  useEffect(() => endDrag, [endDrag]);

  /* 拖完手指一松，浏览器还会补一个 click。
   * 不拦的话"拖着转一圈"会顺手点进某个考点 —— 阈值 6px 是手感调出来的。 */
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current.moved > 6) {
      e.preventDefault();
      e.stopPropagation();
      drag.current.moved = 0;
    }
  };

  if (!nodes.length) return null;

  return (
    <div
      ref={hostRef}
      data-galaxy="host"
      className={cn('relative h-[520px] select-none overflow-hidden sm:h-[640px]', className)}
      style={{ cursor: 'grab', touchAction: 'none' }}
      /* 只有 down 挂在这儿：move / up 在拖拽期间挂到 window 上（见上面的注释）。
       * 挂在容器上的话，指针一拖出容器就丢事件，而且会引回 setPointerCapture 那套。 */
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
    >
      {/* 连线的画布：不参与命中测试，事件全部落到节点或容器上 */}
      <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0" />

      {/* 星核：给球一个视觉中心，不然节点会像浮在空中 */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan/8 blur-[70px]"
      />

      <div ref={sphereRef} className="absolute inset-0">
        {nodes.map((n, i) => (
          <Link
            key={n.id}
            to={`/learn/${n.id}`}
            ref={(el) => { nodeRefs.current[i] = el; }}
            data-galaxy="node"
            onPointerEnter={() => setHovered(n.id)}
            onPointerLeave={() => setHovered((h) => (h === n.id ? null : h))}
            /* 不用 title 属性做提示（延迟太长、样式不可控），
               而是自己在悬停时把标签放大点亮 */
            className="group absolute left-1/2 top-1/2 flex items-center gap-1.5 whitespace-nowrap rounded-full border px-1.5 py-[2px] text-[10.5px] leading-none transition-colors duration-150"
            /* 药丸的底/边/字全部走主题令牌。
             * 原来写死的是「近黑底 + 浅字」（rgba(8,11,20,.62) + #e9ebf4）——
             * 那是按深空调的。亮色主题下会变成一颗颗深灰色药丸压在暖白纸上，
             * 既重又脏，而且和卡片是两种质感。 */
            style={{
              borderColor: hovered === n.id
                ? withAlpha(cssVar('--color-cyan', '#22d3ee'), 0.55)
                : cssVar('--color-hairline', 'rgba(255,255,255,0.10)'),
              background: cssVar(hovered === n.id ? '--glass-sheet-strong' : '--glass-sheet', 'rgba(8,11,20,0.62)'),
              color: hovered === n.id ? cssVar('--color-fg', '#e9ebf4') : cssVar('--color-fg-soft', 'rgba(168,176,198,0.92)'),
              backdropFilter: 'blur(6px)',
              willChange: 'transform, opacity',
            }}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                background: masteryColor(n.mastery),
                boxShadow: `0 0 8px -1px ${masteryColor(n.mastery)}`,
              }}
            />
            <span className="max-w-[130px] truncate">{n.title}</span>
          </Link>
        ))}
      </div>

      {/* 操作提示。压在底部一条渐隐上，否则球的边缘会跟文字叠在一起。 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-ink-950/80 to-transparent px-1 pb-1 pt-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-faint">
          拖动旋转 · 点击进入 · {nodes.length} 个考点
        </span>
        <button
          onClick={reset}
          className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-hairline bg-veil/5 px-2.5 py-1 text-[11px] text-fg-mute transition-colors hover:border-cyan/30 hover:text-fg-soft"
        >
          <RotateCcw size={11} /> 复位
        </button>
      </div>
    </div>
  );
}
