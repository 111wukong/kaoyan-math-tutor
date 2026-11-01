/* 拍照识别 / 解题页
 *
 * 三个模式：
 *   question  拍照录题   —— 转录题目，生成复习卡片
 *   note      整理笔记   —— 提取知识点
 *   solve     拍照解题   —— 转录 + 完整解答（结构化）
 *
 * 流程：拍照 → 预览 → 上传 → 显示结果。
 *
 * ★ 为什么用 uploadFile 而不是 base64 POST：
 *   手机拍照 1~3MB，base64 后 1.3~4MB，JSON body 太大容易超时。
 *   uploadFile 走 multipart，更稳定。
 *
 * ★ 解题模式为什么先收起步骤：
 *   产品里所有「看答案」的地方都遵守同一条规则 —— 先想，再看。
 *   复习页答案默认收起、答题页提交后才出解析。拍照解题如果一上来
 *   就把六步推导摊开，用户的眼睛会直接跳到答案，那道题就白拍了。
 *   所以只先给「这题考什么 + 关键那一步」，步骤要点一下才展开。
 */
import { getToken } from '../../api/request';
import { BASE_URL } from '../../config';
import { extractCards, renderTexts, type Segment } from '../../api/index';

type Mode = 'question' | 'note' | 'solve';

const PROMPTS: Record<Mode, string> = {
  question:
    '识别这张图片中的考研数学题。请提取：1）题干（完整描述）；2）选项（如果有）；3）正确答案；4）解析（关键步骤）。用中文回答，格式清晰。',
  note:
    '整理这张手写笔记。提取关键概念、公式、结论，按知识点归类。用中文回答，条理清晰。',
  solve: '', // 解题走 /api/ai/solve，prompt 在服务端
};

const TITLES: Record<Mode, string> = {
  question: '拍照录题',
  note: '拍照整理笔记',
  solve: '拍照解题',
};

const SUBS: Record<Mode, string> = {
  question: '拍一道题，AI 帮你识别并录入题库',
  note: '拍笔记，AI 帮你整理成知识点',
  solve: '拍一道不会的题，AI 给你讲透',
};

interface Solved {
  question: string;
  answer: string;
  approach: string;
  steps: { t: string; f: string }[];
  points: string[];
  pitfall: string;
  signal: string;
  degraded: boolean;

  /* 渲染后的公式切段。和上面的原文一一对应 ——
   * 原文留着是为了复制，切段是为了显示。 */
  questionSegs: Segment[];
  approachSegs: Segment[];
  answerSegs: Segment[];
  pitfallSegs: Segment[];
  signalSegs: Segment[];
  stepsView: { tSegs: Segment[]; fSegs: Segment[] }[];
}

/** 纯文本兜底：渲染服务挂了也要能看，不能白屏。 */
const asText = (t: string): Segment[] => (t ? [{ type: 'text', v: t } as Segment] : []);

const EMPTY_SOLVED: Solved = {
  question: '', answer: '', approach: '', steps: [],
  points: [], pitfall: '', signal: '', degraded: false,
  questionSegs: [], approachSegs: [], answerSegs: [],
  pitfallSegs: [], signalSegs: [], stepsView: [],
};

Page({
  data: {
    mode: 'question' as Mode,
    title: TITLES.question,
    sub: SUBS.question,

    phase: 'idle' as 'idle' | 'preview' | 'recognizing' | 'result' | 'extracting',
    imagePath: '',
    result: '',
    /** 识别结果的公式切段（录题 / 笔记模式用） */
    resultSegs: [] as Segment[],
    error: '',
    cards: [] as any[],

    /* 解题模式专用 */
    solved: EMPTY_SOLVED,
    /** 完整解答是否展开。默认收起 —— 先看思路，再决定要不要看步骤 */
    revealed: false,
  },

  onLoad(query: any) {
    const mode = (query && query.mode) as Mode;
    const m: Mode = mode === 'note' || mode === 'solve' ? mode : 'question';
    this.setData({ mode: m, title: TITLES[m], sub: SUBS[m] });
  },

  /* ---------- 拍照 ---------- */
  onTakePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      /* 解题/录题默认调相机 —— 用户点「拍照解题」时手上就是一道题，
       * 先弹相册会多一步。相册仍然可选，纸质的旧题在相册里。 */
      sourceType: this.data.mode === 'note' ? ['album', 'camera'] : ['camera', 'album'],
      success: (res) => {
        const path = res.tempFiles[0]?.tempFilePath;
        if (!path) return;
        this.setData({
          imagePath: path,
          phase: 'preview',
          error: '',
          result: '',
          solved: EMPTY_SOLVED,
          revealed: false,
        });
      },
      fail: () => {
        wx.showToast({ title: '选择图片失败', icon: 'none' });
      },
    });
  },

  /* ---------- 上传 ---------- */
  /**
   * 统一的上传封装。solve 和 vision 都是 multipart + Bearer，
   * 差异只在 url 和 formData —— 复制两份的话，改超时时间必然漏一处。
   */
  uploadImage(url: string, formData: Record<string, string>): Promise<any> {
    const token = getToken();
    if (!token) return Promise.reject(new Error('请先登录'));

    return new Promise((resolve, reject) => {
      wx.uploadFile({
        url: `${BASE_URL}${url}`,
        filePath: this.data.imagePath,
        name: 'image',
        formData,
        header: { Authorization: `Bearer ${token}` },
        /* 解题比识别慢：要转录 + 推导 6 步。60 秒不够，
         * 实测复杂题能跑到 40 秒以上，留一倍余量。 */
        timeout: 120000,
        success: (res) => {
          try {
            const j = JSON.parse(res.data);
            if (j.error) return reject(new Error(j.error));
            resolve(j);
          } catch {
            reject(new Error('解析响应失败'));
          }
        },
        fail: (err) => {
          reject(new Error(err.errMsg?.includes('timeout') ? '超时了，网络或题目太复杂' : '上传失败'));
        },
      });
    });
  },

  /* ---------- 识别 / 解题 ---------- */
  async onRecognize() {
    const path = this.data.imagePath;
    if (!path) return;

    const isSolve = this.data.mode === 'solve';
    this.setData({ phase: 'recognizing', error: '' });

    try {
      if (isSolve) {
        const j = await this.uploadImage('/api/ai/solve', {});
        const raw: Solved = {
          question: j.question || '',
          answer: j.answer || '',
          approach: j.approach || '',
          steps: Array.isArray(j.steps) ? j.steps : [],
          points: Array.isArray(j.points) ? j.points : [],
          pitfall: j.pitfall || '',
          signal: j.signal || '',
          degraded: !!j.degraded,
          questionSegs: [], approachSegs: [], answerSegs: [],
          pitfallSegs: [], signalSegs: [], stepsView: [],
        };
        const solved = await this.renderSolved(raw);
        this.setData({
          phase: 'result',
          solved,
          /* 没解析出结构 = 没有步骤可展开，直接摊开原文 */
          revealed: !!j.degraded,
        });
        return;
      }

      const j = await this.uploadImage('/api/ai/vision', { prompt: PROMPTS[this.data.mode] });
      const text = j.text || '';
      /* 识别结果里也常有 $...$ —— 题库和错题本都渲染了，
       * 这一页不渲染的话，用户会在这里看到一堆 \frac。 */
      let resultSegs: Segment[] = asText(text);
      try {
        const [segs] = await renderTexts([text]);
        if (segs && segs.length) resultSegs = segs;
      } catch { /* 渲染失败就用纯文本，不影响主流程 */ }

      this.setData({ phase: 'result', result: text, resultSegs });
    } catch (e: any) {
      this.setData({ phase: 'preview', error: (e && e.message) || '失败' });
    }
  },

  /**
   * 批量渲染解题结果里的公式。
   *
   * 一次请求把全部文本渲完，而不是每段一个请求 ——
   * 一道题的解答有题干 + 思路 + 6 步 × 2 + 答案 + 易错点 + 信号，
   * 十几段文本逐条请求在弱网下要等好几秒，观感是一条条跳出来。
   *
   * 任何一步失败都退化成纯文本：解题结果本身比公式好看重要得多。
   */
  async renderSolved(s: Solved): Promise<Solved> {
    if (s.degraded) {
      return { ...s, questionSegs: asText(s.question) };
    }

    /* 按固定顺序摊平，渲染完再按下标取回。
     * 顺序必须和下面取回的代码严格一致 —— 错一位整页就串了。 */
    const flat: string[] = [
      s.question, s.approach, s.answer, s.pitfall, s.signal,
      ...s.steps.map((x) => x.t),
      ...s.steps.map((x) => x.f),
    ];
    const n = s.steps.length;

    let segs: Segment[][];
    try {
      segs = await renderTexts(flat.map((t) => t || ' '));
    } catch {
      return {
        ...s,
        questionSegs: asText(s.question),
        approachSegs: asText(s.approach),
        answerSegs: asText(s.answer),
        pitfallSegs: asText(s.pitfall),
        signalSegs: asText(s.signal),
        stepsView: s.steps.map((x) => ({ tSegs: asText(x.t), fSegs: asText(x.f) })),
      };
    }

    const at = (i: number) => segs[i] || [];
    return {
      ...s,
      questionSegs: at(0),
      approachSegs: at(1),
      answerSegs: at(2),
      pitfallSegs: at(3),
      signalSegs: at(4),
      stepsView: s.steps.map((_, i) => ({
        tSegs: at(5 + i),
        fSegs: at(5 + n + i),
      })),
    };
  },

  /* ---------- 展开/收起完整解答 ---------- */
  onToggleReveal() {
    this.setData({ revealed: !this.data.revealed });
  },

  /* ---------- 重新拍照 ---------- */
  onRetake() {
    this.setData({
      phase: 'idle',
      imagePath: '',
      result: '',
      resultSegs: [],
      error: '',
      cards: [],
      solved: EMPTY_SOLVED,
      revealed: false,
    });
  },

  /* ---------- 复制文字 ---------- */
  onCopy() {
    /* 解题模式复制的是完整解答，而不是题目 ——
     * 用户复制出去多半是想发给同学或贴进笔记。 */
    const s = this.data.solved;
    const text = this.data.mode === 'solve'
      ? [
        s.question && `题目：${s.question}`,
        s.approach && `思路：${s.approach}`,
        s.steps.length
          ? '解答：\n' + s.steps.map((x, i) => `${i + 1}. ${x.t}${x.f ? `\n   ${x.f}` : ''}`).join('\n')
          : '',
        s.answer && `答案：${s.answer}`,
      ].filter(Boolean).join('\n\n')
      : this.data.result;

    if (!text.trim()) return;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },

  /* ---------- 生成卡片（录题模式） ---------- */
  async onExtract() {
    if (!this.data.result.trim()) return;
    this.setData({ phase: 'extracting' });
    try {
      const r = await extractCards(this.data.result);
      this.setData({ phase: 'result', cards: r.cards || [] });
      wx.showToast({
        title: r.cards && r.cards.length ? `已生成 ${r.cards.length} 张卡片` : '未提取到卡片',
        icon: 'none',
      });
    } catch (e: any) {
      this.setData({ phase: 'result' });
      wx.showToast({ title: (e && e.message) || '生成失败', icon: 'none' });
    }
  },

  /* ---------- 完成 ---------- */
  onDone() {
    wx.navigateBack({ delta: 1 });
  },
});
