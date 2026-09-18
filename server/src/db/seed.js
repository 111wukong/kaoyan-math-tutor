/* 种子导入：知识树 + 题库 + 知识图谱
 *
 * 数据来自原纯前端版（data-knowledge.js / data-questions.js），
 * 由 scripts/extract-seed.mjs 提取为 JSON —— 内容一字未改，只是换了个存放介质。
 * 图谱边（edges.json）是后加的，见下方说明。
 * 幂等：重复跑只会更新内容，不会产生重复行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from './index.js';
import { findCyclesIn } from '../lib/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '../data');

const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

/**
 * 图谱边。缺文件不算错 —— 老仓库里没有这个文件，
 * 此时知识树和题库照常导入，只是图谱功能为空。
 *
 * 但**有文件却含环**必须硬失败：环会让拓扑排序死循环，
 * 而且语义上不成立（A 是 B 的前置、B 又是 A 的前置）。
 * 与其让它悄悄进库，不如在这里就拦下来。
 */
function readEdges() {
  const p = path.join(DATA, 'edges.json');
  if (!fs.existsSync(p)) return { edges: [], skipped: true };
  const edges = JSON.parse(fs.readFileSync(p, 'utf8')).edges || [];

  const cycles = findCyclesIn(edges.map((e) => ({ from: e.from, to: e.to, type: e.type || 'prereq' })));
  if (cycles.length) {
    throw new Error(
      `edges.json 里有环，拒绝导入：\n  ${cycles.map((c) => c.join(' → ')).join('\n  ')}\n` +
      '跑 node server/scripts/gen-edges.mjs --stats 看详情。',
    );
  }
  return { edges, skipped: false };
}

export function seed({ quiet = false } = {}) {
  initSchema();
  const categories = read('categories.json');
  const chapters = read('chapters.json');
  const knowledge = read('knowledge.json');
  const questions = read('questions.json');
  const { edges, skipped: noEdges } = readEdges();

  const run = db.transaction(() => {
    const cat = db.prepare(`INSERT INTO categories (id,name,color,sort_order) VALUES (@id,@name,@color,@sortOrder)
      ON CONFLICT(id) DO UPDATE SET name=@name, color=@color, sort_order=@sortOrder`);
    categories.forEach((c) => cat.run(c));

    const ch = db.prepare(`INSERT INTO chapters (id,category_id,name,sort_order) VALUES (@id,@categoryId,@name,@sortOrder)
      ON CONFLICT(id) DO UPDATE SET category_id=@categoryId, name=@name, sort_order=@sortOrder`);
    chapters.forEach((c) => ch.run(c));

    const kn = db.prepare(`INSERT INTO knowledge (id,category_id,chapter_id,title,content,example,difficulty,exam,related,sort_order)
      VALUES (@id,@categoryId,@chapterId,@title,@content,@example,@difficulty,@exam,@related,@sortOrder)
      ON CONFLICT(id) DO UPDATE SET title=@title, content=@content, example=@example,
        difficulty=@difficulty, exam=@exam, related=@related, chapter_id=@chapterId, sort_order=@sortOrder`);
    knowledge.forEach((n) => kn.run(n));

    // 内置题 owner_id 为 NULL；用户自建题不会被这里覆盖（id 前缀不同）
    const q = db.prepare(`INSERT INTO questions (id,kid,type,difficulty,stem,options,answer,analysis,source_type,source_year,source,owner_id)
      VALUES (@id,@kid,@type,@difficulty,@stem,@options,@answer,@analysis,@sourceType,@sourceYear,@source,NULL)
      ON CONFLICT(id) DO UPDATE SET kid=@kid, type=@type, difficulty=@difficulty, stem=@stem,
        options=@options, answer=@answer, analysis=@analysis,
        source_type=@sourceType, source_year=@sourceYear, source=@source`);
    questions.forEach((x) => q.run(x));

    /* 图谱边：整表重建而不是 upsert。
     * 为什么不用 ON CONFLICT 更新：edges.json 是**唯一真相源**，
     * 删掉一条边也应该同步消失。upsert 只会增不会减，
     * 于是「改了数据但库里还留着旧边」这种脏状态会一直累积。 */
    db.exec('DELETE FROM knowledge_edges');
    const eg = db.prepare(`INSERT INTO knowledge_edges (from_kid,to_kid,type,strength,reason,source)
      VALUES (@from,@to,@type,@strength,@reason,@source)`);
    edges.forEach((e) => eg.run({
      from: e.from,
      to: e.to,
      type: e.type || 'prereq',
      strength: e.strength || 'hard',
      reason: e.reason || '',
      source: e.source || 'manual',
    }));
  });

  run();

  const stats = {
    categories: categories.length,
    chapters: chapters.length,
    knowledge: knowledge.length,
    questions: questions.length,
    edges: edges.length,
  };
  if (!quiet) {
    console.log('[seed] 完成:', JSON.stringify(stats) + (noEdges ? '  （没有 edges.json，图谱为空）' : ''));
  }
  return stats;
}

// 直接执行：node src/db/seed.js
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed();
}
