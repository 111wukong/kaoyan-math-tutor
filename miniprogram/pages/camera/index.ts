/* 拍照识别页
 *
 * 两个入口：
 *   · 「我的」→ 拍照录题（mode=question）
 *   · 「我的」→ 拍照整理笔记（mode=note）
 *
 * 流程：拍照 → 预览 → 上传识别 → 显示结果 → 生成卡片/复制/完成。
 *
 * ★ 为什么用 uploadFile 而不是 base64 POST：
 *   手机拍照 1~3MB，base64 后 1.3~4MB，JSON body 太大容易超时。
 *   uploadFile 走 multipart，更稳定。
 */
import { getToken } from '../../api/request';
import { BASE_URL } from '../../config';
import { extractCards } from '../../api/index';

const PROMPTS = {
  question:
    '识别这张图片中的考研数学题。请提取：1）题干（完整描述）；2）选项（如果有）；3）正确答案；4）解析（关键步骤）。用中文回答，格式清晰。',
  note:
    '整理这张手写笔记。提取关键概念、公式、结论，按知识点归类。用中文回答，条理清晰。',
};

const TITLES = {
  question: '拍照录题',
  note: '拍照整理笔记',
};

Page({
  data: {
    mode: 'question' as 'question' | 'note',
    title: '拍照识别',
    phase: 'idle' as 'idle' | 'preview' | 'recognizing' | 'result' | 'extracting',
    imagePath: '',
    result: '',
    error: '',
    cards: [] as any[],
  },

  onLoad(query: any) {
    const mode = (query && query.mode) || 'question';
    if (mode !== 'question' && mode !== 'note') {
      this.setData({ mode: 'question', title: TITLES.question });
      return;
    }
    this.setData({ mode, title: TITLES[mode] });
  },

  /* ---------- 拍照 ---------- */
  onTakePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: (res) => {
        const path = res.tempFiles[0]?.tempFilePath;
        if (!path) return;
        this.setData({ imagePath: path, phase: 'preview', error: '', result: '' });
      },
      fail: () => {
        wx.showToast({ title: '选择图片失败', icon: 'none' });
      },
    });
  },

  /* ---------- 识别 ---------- */
  async onRecognize() {
    const path = this.data.imagePath;
    if (!path) return;

    this.setData({ phase: 'recognizing', error: '' });

    const token = getToken();
    if (!token) {
      this.setData({ phase: 'preview', error: '请先登录' });
      return;
    }

    wx.uploadFile({
      url: `${BASE_URL}/api/ai/vision`,
      filePath: path,
      name: 'image',
      formData: { prompt: PROMPTS[this.data.mode] },
      header: { Authorization: `Bearer ${token}` },
      timeout: 60000,
      success: (res) => {
        try {
          const j = JSON.parse(res.data);
          if (j.error) {
            this.setData({ phase: 'preview', error: j.error });
            return;
          }
          this.setData({ phase: 'result', result: j.text || '' });
        } catch {
          this.setData({ phase: 'preview', error: '解析响应失败' });
        }
      },
      fail: (err) => {
        this.setData({
          phase: 'preview',
          error: err.errMsg?.includes('timeout') ? '识别超时，请重试' : '上传失败',
        });
      },
    });
  },

  /* ---------- 重新拍照 ---------- */
  onRetake() {
    this.setData({ phase: 'idle', imagePath: '', result: '', error: '', cards: [] });
  },

  /* ---------- 复制文字 ---------- */
  onCopy() {
    wx.setClipboardData({
      data: this.data.result,
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
      if (r.cards && r.cards.length) {
        wx.showToast({ title: `已生成 ${r.cards.length} 张卡片`, icon: 'none' });
      } else {
        wx.showToast({ title: '未提取到卡片，请手动编辑', icon: 'none' });
      }
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
