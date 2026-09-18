/* 零依赖 WebGL 封装 —— 只为「全屏 fragment shader」这一件事服务。
 *
 * 为什么不用 three.js：
 *   这里要的只是「一个全屏四边形 + 一个片元着色器」。three.js 是 600KB，
 *   换来的是一整套场景图 / 相机 / 材质系统，而我们一样都不用。
 *   这个封装不到 120 行，还顺带能精确控制 DPR、可见性暂停、上下文丢失恢复。
 *
 * 三个技术选择：
 *   1. **不建顶点缓冲**。WebGL2 有 gl_VertexID，一个覆盖全屏的大三角形
 *      （(-1,-1) (3,-1) (-1,3)）直接 drawArrays(TRIANGLES, 0, 3) 就行。
 *      省掉 buffer / attribute / 绑定，代码短一半。
 *   2. **DPR 上限 1.5**。全屏着色器是逐像素成本，2x 屏上等于 4 倍像素量，
 *      而背景是柔和的渐变，1.5 与 2.0 肉眼几乎无差。这是最划算的一刀。
 *   3. **失败返回 null，不抛异常**。背景是装饰，不是功能 ——
 *      着色器编译失败不能让整页崩掉，交给上层降级到 CSS 背景。
 */

const VERT = `#version 300 es
precision highp float;
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(P[gl_VertexID], 0.0, 1.0);
}
`;

export type UniformValue = number | number[] | Float32Array;

export interface ShaderRenderer {
  /** 传值。number → uniform1f，长度 2/3/4 的数组 → uniform2fv/3fv/4fv */
  setUniform(name: string, value: UniformValue): void;
  /** 画一帧 */
  render(): void;
  /** 按 CSS 尺寸 + DPR 调整后备缓冲。返回是否真的变了。 */
  resize(cssW: number, cssH: number, dpr: number): boolean;
  /** 后备缓冲的物理像素尺寸 */
  readonly width: number;
  readonly height: number;
  dispose(): void;
}

/** DPR 上限。见文件头注释第 2 条。 */
export const MAX_DPR = 1.5;

export function createShaderRenderer(
  canvas: HTMLCanvasElement,
  fragSrc: string,
  uniformNames: readonly string[],
): ShaderRenderer | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', {
      /* 不透明：着色器自己会画满整个画布，不需要浏览器再做一次 alpha 合成 */
      alpha: false,
      /* 全屏 shader 的锯齿由自己的 smoothstep/fwidth 处理，MSAA 只是白烧性能 */
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
      /* 不需要读回像素，关掉可以省一次拷贝 */
      preserveDrawingBuffer: false,
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;

  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl!.createShader(type);
    if (!sh) throw new Error('createShader 返回 null');
    gl!.shaderSource(sh, src);
    gl!.compileShader(sh);
    if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
      const log = gl!.getShaderInfoLog(sh) || '(无日志)';
      gl!.deleteShader(sh);
      throw new Error(`${type === gl!.VERTEX_SHADER ? '顶点' : '片元'}着色器编译失败：${log}`);
    }
    return sh;
  };

  let vs: WebGLShader | null = null;
  let fs: WebGLShader | null = null;
  let prog: WebGLProgram | null = null;

  try {
    vs = compile(gl.VERTEX_SHADER, VERT);
    fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    prog = gl.createProgram();
    if (!prog) throw new Error('createProgram 返回 null');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`着色器链接失败：${gl.getProgramInfoLog(prog) || '(无日志)'}`);
    }
  } catch (e) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (prog) gl.deleteProgram(prog);
    /* ★ 不抛。背景挂掉不该让页面挂掉 —— 上层看到 null 就退回 CSS 背景。 */
    console.warn('[fx] WebGL 背景初始化失败，已降级为静态背景：', e);
    return null;
  }

  gl.useProgram(prog);

  const locs = new Map<string, WebGLUniformLocation | null>();
  for (const n of uniformNames) locs.set(n, gl.getUniformLocation(prog, n));

  /* 不建 buffer。WebGL2 允许在默认 VAO 上直接 drawArrays。 */
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  let w = 0;
  let h = 0;

  const api: ShaderRenderer = {
    get width() { return w; },
    get height() { return h; },

    setUniform(name, value) {
      const loc = locs.get(name);
      /* 查不到的 uniform 直接忽略：着色器里没用到它时，
         GLSL 编译器会把整个 uniform 优化掉，getUniformLocation 返回 null。
         这不算错误，报出来只会让控制台变吵。 */
      if (loc === undefined || loc === null) return;
      if (typeof value === 'number') { gl!.uniform1f(loc, value); return; }
      const a = value as ArrayLike<number>;
      switch (a.length) {
        case 2: gl!.uniform2f(loc, a[0], a[1]); break;
        case 3: gl!.uniform3f(loc, a[0], a[1], a[2]); break;
        case 4: gl!.uniform4f(loc, a[0], a[1], a[2], a[3]); break;
        default: break;
      }
    },

    resize(cssW, cssH, dpr) {
      const scale = Math.min(dpr || 1, MAX_DPR);
      const nw = Math.max(1, Math.round(cssW * scale));
      const nh = Math.max(1, Math.round(cssH * scale));
      if (nw === w && nh === h) return false;
      w = nw;
      h = nh;
      canvas.width = nw;
      canvas.height = nh;
      gl!.viewport(0, 0, nw, nh);
      return true;
    },

    render() {
      if (w === 0 || h === 0) return;
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    },

    dispose() {
      locs.clear();
      if (prog) gl!.deleteProgram(prog);
      if (vs) gl!.deleteShader(vs);
      if (fs) gl!.deleteShader(fs);
      /* 主动丢弃上下文，别等 GC —— 全屏画布的后备缓冲很占显存 */
      gl!.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };

  return api;
}

/* ============================================================
   颜色工具：把 CSS 里的 hex 转成着色器要的 0..1 线性三元组
   ============================================================ */
export function hexToRgb(hex: string): [number, number, number] {
  const s = hex.trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* cssVar 统一放在 lib/utils.ts —— 这里原来有一份独立实现，
 * 两处都读同一个令牌却各写各的兜底值，迟早会漂移。
 * 需要的话从这里 re-export，别再复制一份。 */
export { cssVar } from '@/lib/utils';
