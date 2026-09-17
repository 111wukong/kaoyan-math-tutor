/* 游戏化：等级 / 成就 / 闪电战 / BOSS / 备考投影 / 下一步建议 */
import { db } from '../db/index.js';
import {
  buildSnapshot, levelInfo, achievementBoard, checkAchievements,
  awardXp, projection, nextSuggestion, ACHIEVEMENTS, LEVELS, needFor,
} from '../lib/game.js';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default async function gameRoutes(fastify) {
  /* ---------- 总览 ---------- */
  fastify.get('/api/game/state', async (req) => {
    const track = req.query.track || 'math1';
    const snap = buildSnapshot(req.userId, { track });
    const g = db.prepare('SELECT * FROM game_state WHERE user_id = ?').get(req.userId) || {};
    const fresh = checkAchievements(req.userId, { track });
    const board = achievementBoard(req.userId, { track });
    const unlocked = board.filter((a) => a.unlockedAt).length;

    return {
      snapshot: snap,
      level: levelInfo(snap.xp),
      blitz: safeJson(g.blitz, null),
      achievements: {
        items: board,
        unlocked,
        total: ACHIEVEMENTS.length,
        newlyUnlocked: fresh,
      },
    };
  });

  /* ---------- 成就墙 ---------- */
  fastify.get('/api/game/achievements', async (req) => {
    const board = achievementBoard(req.userId, { track: req.query.track || 'math1' });
    return {
      items: board,
      unlocked: board.filter((a) => a.unlockedAt).length,
      total: board.length,
      tiers: {
        bronze: board.filter((a) => a.tier === 'bronze').length,
        silver: board.filter((a) => a.tier === 'silver').length,
        gold: board.filter((a) => a.tier === 'gold').length,
      },
    };
  });

  /* ---------- 闪电战成绩提交 ---------- */
  fastify.post('/api/game/blitz', {
    schema: {
      body: {
        type: 'object',
        required: ['score', 'correct'],
        properties: {
          score: { type: 'integer' },
          correct: { type: 'integer' },
          wrong: { type: 'integer' },
          bestCombo: { type: 'integer' },
          seconds: { type: 'integer' },
        },
      },
    },
  }, async (req) => {
    const { score, correct, wrong = 0, bestCombo = 0, seconds = 60 } = req.body;
    const g = db.prepare('SELECT blitz FROM game_state WHERE user_id = ?').get(req.userId) || {};
    const prev = safeJson(g.blitz, null);
    const today = todayStr();

    const record = { score, correct, wrong, bestCombo, seconds, date: today };
    const isBest = !prev || score > (prev.score || 0);
    const next = isBest ? record : prev;

    db.prepare(`INSERT INTO game_state (user_id, blitz) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET blitz = excluded.blitz`).run(req.userId, JSON.stringify(next));

    const fresh = checkAchievements(req.userId);
    return { best: next, isBest, achievements: fresh };
  });

  /* ---------- 章节 BOSS 提交 ---------- */
  fastify.post('/api/game/boss', {
    schema: {
      body: {
        type: 'object',
        required: ['chapterId', 'score', 'total'],
        properties: {
          chapterId: { type: 'string' },
          score: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
    },
  }, async (req) => {
    const { chapterId, score, total } = req.body;
    const pct = total > 0 ? Math.round((score / total) * 100) : 0;
    const today = todayStr();

    const prev = db.prepare('SELECT * FROM boss_records WHERE user_id = ? AND chapter_id = ?').get(req.userId, chapterId);
    if (!prev || pct > prev.pct) {
      db.prepare(`INSERT INTO boss_records (user_id,chapter_id,score,total,pct,date) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id,chapter_id) DO UPDATE SET score=excluded.score, total=excluded.total, pct=excluded.pct, date=excluded.date`)
        .run(req.userId, chapterId, score, total, pct, today);
    }

    const xp = pct >= 60 ? awardXp(req.userId, 'boss', { key: `boss:${chapterId}:${today}` }) : null;
    const fresh = checkAchievements(req.userId);
    return { pct, passed: pct >= 60, xp, achievements: fresh };
  });

  /* ---------- 备考投影 ---------- */
  fastify.get('/api/game/projection', async (req) => {
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.userId) || {};
    return projection(req.userId, {
      track: settings.exam_track || 'math1',
      examDate: settings.exam_date || undefined,
      dailyNew: settings.daily_new ?? 2,
    });
  });

  /* ---------- 下一步建议 ---------- */
  fastify.get('/api/game/next', async (req) => {
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.userId) || {};
    return nextSuggestion(req.userId, { track: settings.exam_track || 'math1' });
  });

  /* ---------- 等级表（给前端画进度用）---------- */
  fastify.get('/api/game/levels', async (req) => {
    /* 每一级都要带自己的称号和"进入该级所需的累计 XP"。
     * 之前这里写的是 levelInfo(0).title —— 12 级全返回「初识极限」，纯 bug。 */
    const out = [];
    let cum = 0;
    for (let lv = 1; lv <= LEVELS.length; lv++) {
      out.push({
        level: lv,
        title: LEVELS[lv - 1],
        need: needFor(lv),   // 本级内需要的 XP
        at: cum,             // 进入本级时的累计 XP
      });
      cum += needFor(lv);
    }
    const snap = buildSnapshot(req.userId);
    return { levels: out, current: levelInfo(snap.xp) };
  });
}

function safeJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
