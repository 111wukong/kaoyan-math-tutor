/* 从原项目（零依赖纯前端版）提取种子数据 → JSON
 * 原文件是 window.KDATA = {...} / window.QDATA = [...]，用 vm 在沙箱里跑一遍取出。
 * 这是硬资产：71 个知识点 + 204 道题，全部带 LaTeX 正文与解析，重写等于烧掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REF = process.argv[2] || '/Users/wukong/WorkBuddy AI/2026-09-17-19-18-00/ref/kaoyan-math-tutor';
const OUT = process.argv[3] || path.resolve('./src/data');

function extract(file, globalName) {
  const code = fs.readFileSync(path.join(REF, 'js', file), 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  const val = sandbox.window[globalName];
  if (!val) throw new Error(`${file} 里没有 window.${globalName}`);
  return val;
}

const KDATA = extract('data-knowledge.js', 'KDATA');
const QDATA = extract('data-questions.js', 'QDATA');

// ---- 校验：宁可现在炸，不要带着坏数据上线 ----
const nodes = [];
const chapterIndex = new Map();
KDATA.categories.forEach((cat, ci) => {
  cat.chapters.forEach((ch, hi) => {
    const chId = `${cat.id}-c${hi + 1}`;
    chapterIndex.set(chId, { id: chId, categoryId: cat.id, name: ch.name, sortOrder: hi });
    ch.nodes.forEach((n, ni) => {
      nodes.push({
        id: n.id,
        title: n.title,
        content: n.content || '',
        example: n.example || '',
        difficulty: n.difficulty || 2,
        exam: Array.isArray(n.exam) ? n.exam.join(',') : (n.exam || 'all'),
        related: JSON.stringify(n.related || []),
        categoryId: cat.id,
        chapterId: chId,
        sortOrder: ni,
      });
    });
  });
});

const nodeIds = new Set(nodes.map((n) => n.id));
const orphanQ = QDATA.filter((q) => !nodeIds.has(q.kid));
if (orphanQ.length) throw new Error(`有 ${orphanQ.length} 道题的 kid 找不到对应知识点: ${orphanQ.slice(0, 5).map((q) => q.id + '/' + q.kid).join(', ')}`);

const questions = QDATA.map((q) => ({
  id: q.id,
  kid: q.kid,
  type: q.type,
  difficulty: q.difficulty || 2,
  stem: q.stem,
  options: q.options ? JSON.stringify(q.options) : null,
  answer: String(q.answer),
  analysis: q.analysis || '',
  sourceType: q.sourceType || '',
  sourceYear: q.sourceYear || null,
  source: q.source || '',
}));

const categories = KDATA.categories.map((c, i) => ({ id: c.id, name: c.name, color: c.color, sortOrder: i }));
const chapters = [...chapterIndex.values()];

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'categories.json'), JSON.stringify(categories, null, 2));
fs.writeFileSync(path.join(OUT, 'chapters.json'), JSON.stringify(chapters, null, 2));
fs.writeFileSync(path.join(OUT, 'knowledge.json'), JSON.stringify(nodes, null, 2));
fs.writeFileSync(path.join(OUT, 'questions.json'), JSON.stringify(questions, null, 2));

const stats = {
  categories: categories.length,
  chapters: chapters.length,
  knowledge: nodes.length,
  questions: questions.length,
  byType: questions.reduce((a, q) => ((a[q.type] = (a[q.type] || 0) + 1), a), {}),
  bySource: questions.reduce((a, q) => ((a[q.sourceType || '未标注'] = (a[q.sourceType || '未标注'] || 0) + 1), a), {}),
  nodesWithoutQuestion: [...nodeIds].filter((id) => !QDATA.some((q) => q.kid === id)),
};
console.log(JSON.stringify(stats, null, 2));
console.log(`\n已写出到 ${OUT}`);
