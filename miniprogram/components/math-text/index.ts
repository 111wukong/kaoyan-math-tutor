/* 公式混排组件
 *
 * ── 它解决的问题 ────────────────────────────────────────────────
 * 一道题是这样的：
 *   「设函数 $f(x)=x^{2}+\dfrac{1}{x}$ 在 $(0,+\infty)$ 上连续」
 * 里面既有中文，又有 LaTeX。小程序没有 DOM、加载不了 KaTeX 字体，
 * 所以公式只能是一张图。
 *
 * ── 为什么不是「整句渲染成一张图」────────────────────────────────
 * 那样最省事，但代价很大：文字不可选中、不可复制、不可搜索，
 * 读屏软件读到的是一张图片。切段之后文字仍是原生 <text>，
 * 公式才是 <image> —— 两边的优点都留住。
 *
 * ── 为什么用 inline 流而不是 flex ────────────────────────────────
 * 一开始用 flex + flex-wrap 排：结果每个文字段变成一个 flex item，
 * 段内的中文自己换行，但「段与段之间」不流动 —— 一段长文字后面
 * 跟一个公式，公式会被挤到下一行的行首，出现大片空白。
 * 改成默认块级流 + inline/inline-block 之后，文字和图片在同一行里
 * 自然接续，这才是排版想要的效果。
 *
 * ── 尺寸从哪来 ──────────────────────────────────────────────────
 * 服务端按 17px 字号渲染，并回传每张图的 w/h（px）。
 * 这里直接按 px 写死宽高，不做任何缩放 —— 缩放会让公式和周围
 * 文字的基线错开，看起来像「公式飘起来了」。
 * 所以 .mt 的 font-size 必须是 17px，和服务端的 FONT_PX 一致。
 */

Component({
  properties: {
    /** 服务端 /api/render/text 返回的 segments 数组 */
    segments: {
      type: Array,
      value: [],
    },
    /** 加载中：显示一个灰条，避免「先空白再跳出文字」的跳动 */
    loading: {
      type: Boolean,
      value: false,
    },
    /** 行间公式（$$...$$）单独占一行并居中 */
    blockDisplay: {
      type: Boolean,
      value: true,
    },
  },

  data: {
    /* 把 segments 拆成「行内段」和「行间段」两组，wxml 里少写判断。
     * 行间公式必须独占一行，和文字混排会把行高撑得很难看。 */
    flow: [] as any[],
  },

  observers: {
    segments(list: any[]) {
      const flow: any[] = [];
      for (const s of list || []) {
        if (s && s.type === 'math' && s.display) {
          flow.push({ ...s, kind: 'block' });
        } else {
          flow.push({ ...s, kind: 'inline' });
        }
      }
      this.setData({ flow });
    },
  },

  methods: {
    /** 图片加载失败：退化成显示 LaTeX 源码。
     *  比一张破图好 —— 至少用户能看到公式是什么。 */
    onImgError(e: any) {
      const idx = e.currentTarget.dataset.idx;
      const flow = this.data.flow.slice();
      if (flow[idx]) {
        flow[idx] = { ...flow[idx], url: '', fallback: flow[idx].tex };
        this.setData({ flow });
      }
    },
  },
});
