/* 答题页
 *
 * 一个页面 + 六个题型分支，不是六个页面。
 * 题干、选项、解析、判分反馈完全共用，差异只在「作答区」和「提交逻辑」——
 * 拆成六个页面的话，改一处要改六遍，而且必然有两三个漏掉。
 *
 * ── 两种判分流程 ────────────────────────────────────────────────
 * 客观题（选择/多选/判断/填空）：提交 → 服务端判分 → 出结果。
 * 解答/证明题：**两步**。
 *   第一步提交只把参考答案亮出来，服务端不记账（返回 selfGrade=true）；
 *   用户对照评分点自评「做对了 / 做错了」，第二步才真正记账。
 *   为什么必须两步：解答题没法自动判分，而让 AI 判分要花配额、
 *   还可能判错。用户自己对照评分点是最准的，也是 Web 端的做法。
 *
 * ── 计时 ────────────────────────────────────────────────────────
 * 从进入页面开始算，提交时上报秒数。服务端会截断到 0~3600。
 * 切后台不暂停 —— 现实里「做一半去接水」的时间也算在想题里，
 * 而且监听前后台切换会多出一堆状态。截断已经兜住了离谱值。
 *
 * ── 为什么选中态要预计算 ────────────────────────────────────────
 * WXML 的表达式只支持运算符，**不支持方法调用** ——
 * 写 `picked.indexOf(item.k) >= 0` 不会报错，但会静默求值成 false，
 * 表现是「点了选项没有任何反应」。所以选中标记存在每个选项对象上，
 * 点一下改一次。
 */

import {
  fetchQuestion, submitAnswer, renderTexts,
  type QuestionDetail, type AnswerResult, type Segment,
} from '../../api/index';

const JUDGE_OPTIONS = [
  { key: '对', label: '正确' },
  { key: '错', label: '错误' },
];

interface Opt {
  k: string;
  seg: Segment[];
  on: boolean;
}

function timerText(s: number): string {
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分`;
}

Page({
  /* 计时器句柄。挂在实例上而不是 data 里 —— data 会被 setData 序列化，
   * 每次 tick 都把它往视图层送一遍，纯属浪费。 */
  timer: null as any,

  data: {
    loading: true,
    error: '',

    q: null as QuestionDetail | null,
    type: '',
    typeLabel: '',
    selfGraded: false,

    stemSegs: [] as Segment[],
    opts: [] as Opt[],
    answerSegs: [] as Segment[],
    analysisSegs: [] as Segment[],
    stepSegs: [] as Segment[][],
    stepPts: [] as number[],

    picked: [] as string[],
    text: '',
    judgeOptions: JUDGE_OPTIONS,

    /** answer = 作答中；reveal = 解答题已亮答案待自评；done = 已出结果 */
    phase: 'answer',
    submitting: false,
    result: null as AnswerResult | null,

    seconds: 0,
    timerText: '0 秒',

    /* 连续练习：从题库/错题本进来时带一串剩余题目 id。
     * 用 URL 传而不是存全局变量 —— 退出再进来还能续上，
     * 也不用担心页面栈里的旧状态没清干净。 */
    pos: 0,
    total: 0,
    rest: [] as string[],
    /** 进度百分比，喂给顶部细进度条 */
    pct: 0,
  },

  onLoad(query: any) {
    const qid = (query && query.qid) || '';
    if (!qid) {
      this.setData({ loading: false, error: '没有指定题目' });
      return;
    }

    const pos = Number(query.pos) || 0;
    const total = Number(query.total) || 0;
    const rest = query.rest ? String(query.rest).split(',').filter(Boolean) : [];

    this.setData({
      pos,
      total,
      rest,
      pct: pos && total ? Math.round(((pos - 1) / total) * 100) : 0,
    });

    this.load(qid);
    this.startTimer();
  },

  onUnload() {
    this.stopTimer();
  },

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      const s = this.data.seconds + 1;
      this.setData({ seconds: s, timerText: timerText(s) });
    }, 1000);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  async load(qid: string) {
    this.setData({ loading: true, error: '' });
    try {
      const r = await fetchQuestion(qid);
      const q = r.question;

      this.setData({
        loading: false,
        q,
        type: q.type,
        typeLabel: q.typeLabel,
        selfGraded: Boolean(q.selfGraded),
        picked: [],
        text: '',
        phase: 'answer',
        result: null,
        answerSegs: [],
        analysisSegs: [],
        stepSegs: [],
        stepPts: [],
        opts: (q.options || []).map((o) => ({ k: o.k, seg: [{ type: 'text', v: o.t } as Segment], on: false })),
      });

      /* 题干和选项一次渲完 —— 选项也是公式，分两次请求纯属浪费。 */
      const texts = [q.stem, ...(q.options || []).map((o) => o.t)];
      try {
        const segs = await renderTexts(texts);
        const base = (q.options || []).map((o, i) => ({
          k: o.k,
          seg: segs[i + 1] || [{ type: 'text', v: o.t } as Segment],
          on: false,
        }));
        this.setData({
          stemSegs: segs[0] || [{ type: 'text', v: q.stem } as any],
          opts: base,
        });
      } catch {
        /* 渲染失败退化成纯文本：公式看不到，但题还能做。 */
        this.setData({ stemSegs: [{ type: 'text', v: q.stem } as any] });
      }
    } catch (e: any) {
      this.setData({ loading: false, error: (e && e.message) || '加载失败' });
    }
  },

  /* ---------- 作答交互 ---------- */

  onPickOption(e: any) {
    if (this.data.phase !== 'answer') return;
    const k = e.currentTarget.dataset.k;
    const multi = this.data.type === 'multi';

    let picked: string[];
    if (multi) {
      picked = this.data.picked.slice();
      const i = picked.indexOf(k);
      if (i >= 0) picked.splice(i, 1);
      else picked.push(k);
    } else {
      picked = [k];
    }

    /* 同步选中标记。单选直接把其他项关掉，多选按 picked 重新算。 */
    const opts = this.data.opts.map((o) => ({ ...o, on: picked.indexOf(o.k) >= 0 }));
    this.setData({ picked, opts });
  },

  onJudge(e: any) {
    if (this.data.phase !== 'answer') return;
    const k = e.currentTarget.dataset.k;
    this.setData({ picked: [k] });
  },

  onInput(e: any) {
    this.setData({ text: e.detail.value });
  },

  /** 当前该提交的答案字符串。多选排序后拼起来 —— 服务端会再归一化，
   *  这里排序只是让本地和服务端的口径一致。 */
  currentAnswer(): string {
    const t = this.data.type;
    if (t === 'choice' || t === 'multi') return this.data.picked.slice().sort().join('');
    if (t === 'judge') return this.data.picked[0] || '';
    return this.data.text;
  },

  /* ---------- 提交 ---------- */

  async onSubmit() {
    if (this.data.submitting) return;
    const q = this.data.q;
    if (!q) return;

    const answer = this.currentAnswer();
    if (!String(answer).trim()) {
      wx.showToast({ title: this.data.selfGraded ? '先写下你的解答' : '还没作答', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      /* 解答/证明题的第一步：只亮答案，不记账。
       * 不传 selfCorrect 就是「还没判」，服务端据此返回 selfGrade=true。
       * 第二步（自评）走 onSelf —— 两条路分开写，免得一个函数里塞
       * 三套分支，读起来要靠猜。 */
      const isFirstStep = this.data.selfGraded && this.data.phase === 'answer';

      const r = await submitAnswer({
        qid: q.id,
        answer,
        seconds: this.data.seconds,
        context: 'quiz',
      });

      if (isFirstStep) {
        this.setData({ submitting: false, phase: 'reveal', result: r });
        await this.renderBack(r);
        return;
      }

      this.stopTimer();
      this.setData({ submitting: false, phase: 'done', result: r });
      await this.renderBack(r);

      if (r.achievements && r.achievements.length) {
        wx.showToast({ title: `解锁：${r.achievements[0].title}`, icon: 'none' });
      }
    } catch (e: any) {
      this.setData({ submitting: false });
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' });
    }
  },

  /** 解答/证明题的自评：对照评分点说自己做对没做对。 */
  async onSelf(e: any) {
    if (this.data.submitting) return;
    const ok = e.currentTarget.dataset.ok === '1';

    const q = this.data.q;
    if (!q) return;

    this.setData({ submitting: true });
    try {
      const r = await submitAnswer({
        qid: q.id,
        answer: this.data.text,
        seconds: this.data.seconds,
        context: 'quiz',
        selfCorrect: ok,
      });
      this.stopTimer();
      this.setData({ submitting: false, phase: 'done', result: r });
      await this.renderBack(r);
    } catch (err: any) {
      this.setData({ submitting: false });
      wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
    }
  },

  /** 渲染答案 / 解析 / 评分点。 */
  async renderBack(r: AnswerResult) {
    const answer = r.answer || '';
    const analysis = r.analysis || '';
    const steps = r.steps || [];

    const texts = [answer, analysis, ...steps.map((s) => s.t)];
    try {
      const segs = await renderTexts(texts);
      this.setData({
        answerSegs: segs[0] || [{ type: 'text', v: answer } as any],
        analysisSegs: segs[1] || (analysis ? [{ type: 'text', v: analysis } as any] : []),
        stepSegs: segs.slice(2),
        stepPts: steps.map((s) => s.pts),
      });
    } catch {
      this.setData({
        answerSegs: [{ type: 'text', v: answer } as any],
        analysisSegs: analysis ? [{ type: 'text', v: analysis } as any] : [],
        stepSegs: steps.map((s) => [{ type: 'text', v: s.t } as any]),
        stepPts: steps.map((s) => s.pts),
      });
    }
  },

  /** 下一题。用 redirectTo 而不是 navigateTo —— 连做二十道题时
   *  navigateTo 会把二十个页面压在栈里，返回键要按二十次。 */
  onNext() {
    const rest = this.data.rest.slice();
    const next = rest.shift();
    if (!next) return;

    const q = [
      `qid=${encodeURIComponent(next)}`,
      `pos=${this.data.pos + 1}`,
      `total=${this.data.total}`,
      rest.length ? `rest=${encodeURIComponent(rest.join(','))}` : '',
    ].filter(Boolean).join('&');

    wx.redirectTo({ url: `/pages/answer/index?${q}` });
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  },

  /** 看 AI 讲解。放在「答完」之后 —— 讲的是「你这一步」，
   *  得先有作答记录，讲解才有针对性。 */
  onExplain(e: any) {
    const qid = e.currentTarget.dataset.qid;
    if (!qid) return;
    wx.navigateTo({ url: `/pages/explain/index?qid=${encodeURIComponent(qid)}` });
  },
});
