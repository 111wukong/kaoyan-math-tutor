/* 种子导入：知识树 + 题库
 *
 * 数据来自原纯前端版（data-knowledge.js / data-questions.js），
 * 由 scripts/extract-seed.mjs 提取为 JSON —— 内容一字未改，只是换了个存放介质。
 * 幂等：重复跑只会更新内容，不会产生重复行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '../data');

const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

export function seed({ quiet = false } = {}) {
  initSchema();
  const categories = read('categories.json');
  const chapters = read('chapters.json');
  const knowledge = read('knowledge.json');
  const questions = read('questions.json');

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
  });

  run();

  const stats = {
    categories: categories.length,
    chapters: chapters.length,
    knowledge: knowledge.length,
    questions: questions.length,
  };
  if (!quiet) console.log('[seed] 完成:', JSON.stringify(stats));
  return stats;
}

// 直接执行：node src/db/seed.js
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed();
}
