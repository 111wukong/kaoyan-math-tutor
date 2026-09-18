import { useEffect, useRef } from 'react';
import { useFxAccents, hexToHue } from './theme-colors';

/* 星尘背景
 *
 * 为什么不用现成库（tsparticles / vanta）：
 *   这些库本体 60-200KB，而这里需要的只是「一堆缓慢漂移的点 + 近邻连线 + 鼠标视差」，
 *   不到 100 行就能写完，还能精确控制性能（粒子数按屏幕面积算）与可访问性
 *   （prefers-reduced-motion 时直接不跑动画）。
 *
 * 三个细节决定了它「像星空」而不是「像雪花」：
 *   1. 每颗星有自己的闪烁相位与速度，不是统一节奏；
 *   2. 视差分层：近处的星随鼠标移动更多，产生纵深；
 *   3. 只有足够近的两颗星才连线，且透明度随距离衰减。
 */
export function Starfield({
  className = '',
  /** 每平方像素的粒子数。默认值在 1440×900 上约 130 颗 */
  density = 0.0001,
  maxParticles = 160,
  parallax = 16,
  connect = true,
}: {
  className?: string;
  density?: number;
  maxParticles?: number;
  parallax?: number;
  connect?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  /* 订阅主题强调色。它进了 effect 依赖，换主题会重建整片星尘 ——
   * 星点位置会重排，但那是一次性的（换主题本来就该看得出变化），
   * 比「换了主题星星还是老颜色」好得多。 */
  const accents = useFxAccents();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let running = true;

    type Star = {
      x: number; y: number; r: number; z: number;
      vx: number; vy: number; phase: number; speed: number; hue: number;
    };
    let stars: Star[] = [];
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

    /* 星点色相从当前主题的强调色推出来（原来是写死的青/蓝/紫/品红）。
     * 不跟着主题走的话，「赛博绿」下满屏还是青蓝色的星 ——
     * 而星尘是铺满整屏的，颜色不对比网格还显眼。 */
    const PALETTE = [accents.cyan, accents.blue, accents.violet, accents.magenta].map((h, i) =>
      hexToHue(h, [190, 210, 265, 285][i]));

    function build() {
      const rect = canvas!.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.max(28, Math.min(maxParticles, Math.round(w * h * density)));
      stars = Array.from({ length: count }, () => {
        const z = Math.random();               // 0 远 → 1 近
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.35 + z * 1.35,
          z,
          vx: (Math.random() - 0.5) * 0.075 * (0.4 + z),
          vy: (Math.random() - 0.5) * 0.075 * (0.4 + z),
          phase: Math.random() * Math.PI * 2,
          speed: 0.4 + Math.random() * 0.9,
          hue: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        };
      });
    }

    let t = 0;

    function draw() {
      if (!running) return;
      t += 0.016;
      ctx!.clearRect(0, 0, w, h);

      // 鼠标缓动，避免跟随生硬
      mouse.x += (mouse.tx - mouse.x) * 0.055;
      mouse.y += (mouse.ty - mouse.y) * 0.055;

      const pts: { x: number; y: number; z: number }[] = [];

      for (const s of stars) {
        if (!reduced) {
          s.x += s.vx;
          s.y += s.vy;
        }
        // 环绕，避免粒子在边缘堆积
        if (s.x < -12) s.x = w + 12;
        if (s.x > w + 12) s.x = -12;
        if (s.y < -12) s.y = h + 12;
        if (s.y > h + 12) s.y = -12;

        const px = s.x + mouse.x * parallax * s.z;
        const py = s.y + mouse.y * parallax * s.z;
        pts.push({ x: px, y: py, z: s.z });

        const twinkle = reduced ? 0.75 : 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
        const alpha = (0.22 + s.z * 0.5) * twinkle;

        // 光晕：近处的星带一圈很淡的雾
        if (s.z > 0.66) {
          const g = ctx!.createRadialGradient(px, py, 0, px, py, s.r * 7);
          g.addColorStop(0, `hsla(${s.hue}, 92%, 72%, ${alpha * 0.34})`);
          g.addColorStop(1, 'hsla(0, 0%, 100%, 0)');
          ctx!.fillStyle = g;
          ctx!.beginPath();
          ctx!.arc(px, py, s.r * 7, 0, Math.PI * 2);
          ctx!.fill();
        }

        ctx!.fillStyle = `hsla(${s.hue}, 88%, 82%, ${alpha})`;
        ctx!.beginPath();
        ctx!.arc(px, py, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }

      // 近邻连线
      if (connect) {
        const LIMIT = 118;
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const dx = pts[i].x - pts[j].x;
            const dy = pts[i].y - pts[j].y;
            const d2 = dx * dx + dy * dy;
            if (d2 > LIMIT * LIMIT) continue;
            const d = Math.sqrt(d2);
            const a = (1 - d / LIMIT) * 0.13 * (0.4 + ((pts[i].z + pts[j].z) / 2) * 0.6);
            ctx!.strokeStyle = `hsla(200, 90%, 78%, ${a})`;
            ctx!.lineWidth = 0.55;
            ctx!.beginPath();
            ctx!.moveTo(pts[i].x, pts[i].y);
            ctx!.lineTo(pts[j].x, pts[j].y);
            ctx!.stroke();
          }
        }
      }

      raf = requestAnimationFrame(draw);
    }

    function onMove(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      mouse.tx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      mouse.ty = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    }

    let resizeTimer: ReturnType<typeof setTimeout>;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { build(); }, 160);
    }

    function onVisibility() {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; raf = requestAnimationFrame(draw); }
    }

    build();
    raf = requestAnimationFrame(draw);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [density, maxParticles, parallax, connect, accents]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      /* 稳定的测试抓手，理由见 CyberGrid.tsx 里同名属性的注释 */
      data-fx="starfield"
      className={`pointer-events-none fixed inset-0 -z-10 h-full w-full ${className}`}
    />
  );
}
