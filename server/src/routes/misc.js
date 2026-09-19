/* 设置 / 卡片库 / 课堂 / 聊天 / 导出导入 */
import { db } from '../db/index.js';
import { checkAchievements, buildSnapshot, invalidateTree } from '../lib/game.js';
import { THEME_IDS, DEFAULT_THEME, normalizeTheme } from '../lib/themes.js';
import { insertCard, updateCardSchedule, cardFromExport } from '../lib/cardStore.js';

export default async function miscRoutes(fastify) {
  /* ============ 设置 ============ */
  fastify.get('/api/settings', async (req) => {
    let s = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.userId);
    if (!s) {
      db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(req.userId);
      s = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.userId);
    }
    return {
      settings: {
        examTrack: s.exam_track,
        dailyNew: s.daily_new,
        examDate: s.exam_date,
        persona: s.persona,
        sfx: s.sfx === 1,
        theme: normalizeTheme(s.theme),
        // 前端的外观选择器要按这个清单渲染，清单由服务端给出，
        // 免得两端各维护一份「哪些主题合法」
        themes: THEME_IDS,
        defaultTheme: DEFAULT_THEME,
        updatedAt: s.updated_at,
      },
    };
  });

  fastify.put('/api/settings', {
    schema: {
      body: {
        type: 'object',
        properties: {
          examTrack: { type: 'string' },
          dailyNew: { type: 'integer', minimum: 1, maximum: 20 },
          examDate: { type: 'string' },
          persona: { type: 'string' },
          sfx: { type: 'boolean' },
          theme: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const b = req.body || {};
    const map = {
      examTrack: 'exam_track', dailyNew: 'daily_new', examDate: 'exam_date',
      persona: 'persona',
    };
    const sets = [];
    const params = [];
    Object.keys(map).forEach((k) => {
      if (b[k] === undefined) return;
      sets.push(`${map[k]} = ?`);
      params.push(b[k]);
    });
    /* 主题走白名单收敛，不直接落库。
     * 非法值不报错、落回默认 —— 前端选了个已下线的主题时，
     * 报 400 会让整个设置页保存失败，代价远大于静默回落。 */
    if (b.theme !== undefined) { sets.push('theme = ?'); params.push(normalizeTheme(b.theme)); }
    if (b.sfx !== undefined) { sets.push('sfx = ?'); params.push(b.sfx ? 1 : 0); }
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      db.prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = ?`).run(...params, req.userId);
    }
    const s = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.userId);
    return {
      settings: {
        examTrack: s.exam_track, dailyNew: s.daily_new, examDate: s.exam_date,
        persona: s.persona, sfx: s.sfx === 1, theme: normalizeTheme(s.theme),
        themes: THEME_IDS, defaultTheme: DEFAULT_THEME,
      },
    };
  });

  /* ============ LLM 配置 ============ */
  fastify.get('/api/settings/llm', async (req) => {
    let l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(req.userId);
    if (!l) {
      db.prepare('INSERT INTO llm_settings (user_id) VALUES (?)').run(req.userId);
      l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(req.userId);
    }
    return {
      llm: {
        enabled: l.enabled === 1,
        kind: l.kind,
        localBase: l.local_base,
        localModel: l.local_model,
        cloudBase: l.cloud_base,
        cloudModel: l.cloud_model,
        // 密钥永不回传原文，只告诉前端「配了没有」
        hasKey: !!l.cloud_key,
        keyPreview: l.cloud_key ? l.cloud_key.slice(0, 6) + '…' + l.cloud_key.slice(-4) : '',
        rememberKey: l.remember_key === 1,
      },
    };
  });

  fastify.put('/api/settings/llm', {
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          kind: { type: 'string' },
          localBase: { type: 'string' },
          localModel: { type: 'string' },
          cloudBase: { type: 'string' },
          cloudModel: { type: 'string' },
          cloudKey: { type: 'string' },
          rememberKey: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const b = req.body || {};
    const map = {
      kind: 'kind', localBase: 'local_base', localModel: 'local_model',
      cloudBase: 'cloud_base', cloudModel: 'cloud_model',
    };
    const sets = [];
    const params = [];
    Object.keys(map).forEach((k) => {
      if (b[k] === undefined) return;
      sets.push(`${map[k]} = ?`);
      params.push(String(b[k]));
    });
    if (b.enabled !== undefined) { sets.push('enabled = ?'); params.push(b.enabled ? 1 : 0); }
    if (b.rememberKey !== undefined) { sets.push('remember_key = ?'); params.push(b.rememberKey ? 1 : 0); }
    // 传空字符串 = 清除密钥；不传 = 保持原值
    if (b.cloudKey !== undefined && b.cloudKey !== '') { sets.push('cloud_key = ?'); params.push(String(b.cloudKey)); }
    else if (b.cloudKey === '') { sets.push("cloud_key = ''"); }

    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      db.prepare(`UPDATE llm_settings SET ${sets.join(', ')} WHERE user_id = ?`).run(...params, req.userId);
    }
    return { ok: true };
  });

  /* 测试连接：真的发一次最小请求，不要假装 */
  fastify.post('/api/settings/llm/test', async (req, reply) => {
    const l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(req.userId);
    if (!l) return reply.code(400).send({ error: '未配置模型' });

    const cfg = resolveLlm(l);
    if (!cfg.base) return reply.code(400).send({ error: '还没填 Base URL' });
    if (!cfg.model) return reply.code(400).send({ error: '还没填模型名' });

    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: '只回复两个字：可用' }],
          max_tokens: 16,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      const ms = Date.now() - started;

      if (!res.ok) {
        return reply.code(200).send({
          ok: false, status: res.status, ms,
          error: explainHttp(res.status, text),
        });
      }
      let content = '';
      try { content = JSON.parse(text).choices?.[0]?.message?.content || ''; } catch { content = text.slice(0, 120); }
      return { ok: true, status: res.status, ms, model: cfg.model, reply: content.slice(0, 60) };
    } catch (e) {
      const ms = Date.now() - started;
      const msg = e.name === 'AbortError' ? '请求超时（20 秒）——地址可能不通，或模型没在跑' : (e.message || String(e));
      return reply.code(200).send({ ok: false, ms, error: msg });
    }
  });

  /* ============ 卡片库 ============ */
  fastify.get('/api/deck', async (req) => {
    const { kid } = req.query;
    const rows = kid
      ? db.prepare('SELECT * FROM card_deck WHERE user_id = ? AND kid = ? ORDER BY ts DESC').all(req.userId, kid)
      : db.prepare('SELECT * FROM card_deck WHERE user_id = ? ORDER BY ts DESC').all(req.userId);
    return { cards: rows.map(shapeDeck), count: rows.length };
  });

  fastify.post('/api/deck', {
    schema: {
      body: {
        type: 'object',
        required: ['kid', 'title', 'front'],
        properties: {
          kid: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' },
          front: { type: 'string' }, back: { type: 'string' }, src: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    const id = 'd_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    db.prepare('INSERT INTO card_deck (id,user_id,kid,type,title,front,back,src,ts) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, req.userId, b.kid, b.type || 'point', b.title, b.front, b.back || '', b.src || 'ai', Date.now());
    const snap = buildSnapshot(req.userId);
    const fresh = checkAchievements(req.userId);
    return { ok: true, id, deckCards: snap.deckCards, achievements: fresh };
  });

  fastify.delete('/api/deck/:id', async (req) => {
    db.prepare('DELETE FROM card_deck WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    return { ok: true };
  });

  /* 卡片一键加入复习队列 */
  fastify.post('/api/deck/:id/to-card', async (req, reply) => {
    const d = db.prepare('SELECT * FROM card_deck WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!d) return reply.code(404).send({ error: '卡片不存在' });
    const { newCard } = await import('../lib/fsrs.js');
    const { insertCard } = await import('../lib/cardStore.js');
    const c = newCard(d.kid, null, 'knowledge');
    insertCard(db, req.userId, c);
    return { ok: true, cardId: c.id };
  });

  /* ============ 课堂（多智能体对话记录）============ */
  fastify.get('/api/classroom/:kid', async (req) => {
    const row = db.prepare('SELECT * FROM classrooms WHERE user_id = ? AND kid = ?').get(req.userId, req.params.kid);
    return { classroom: row ? safeJson(row.payload, null) : null };
  });

  fastify.put('/api/classroom/:kid', async (req) => {
    const payload = JSON.stringify(req.body?.payload ?? {});
    db.prepare(`INSERT INTO classrooms (user_id,kid,payload,ts) VALUES (?,?,?,?)
      ON CONFLICT(user_id,kid) DO UPDATE SET payload = excluded.payload, ts = excluded.ts`)
      .run(req.userId, req.params.kid, payload, Date.now());
    return { ok: true };
  });

  fastify.delete('/api/classroom/:kid', async (req) => {
    db.prepare('DELETE FROM classrooms WHERE user_id = ? AND kid = ?').run(req.userId, req.params.kid);
    return { ok: true };
  });

  /* ============ 聊天记录 ============ */
  fastify.get('/api/chat/:kid', async (req) => {
    const row = db.prepare('SELECT * FROM chats WHERE user_id = ? AND kid = ?').get(req.userId, req.params.kid);
    return { chat: row ? { stage: row.stage, history: safeJson(row.history, []), updatedAt: row.updated_at } : null };
  });

  fastify.put('/api/chat/:kid', async (req) => {
    const stage = req.body?.stage || 'explain';
    const history = JSON.stringify((req.body?.history || []).slice(-200));
    db.prepare(`INSERT INTO chats (user_id,kid,stage,history,updated_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(user_id,kid) DO UPDATE SET stage = excluded.stage, history = excluded.history, updated_at = datetime('now')`)
      .run(req.userId, req.params.kid, stage, history);
    return { ok: true };
  });

  /* ============ 导出 ============ */
  fastify.get('/api/export', async (req) => {
    const uid = req.userId;
    const withKey = req.query.withKey === '1';
    const user = db.prepare('SELECT email, username, avatar_hue, created_at FROM users WHERE id = ?').get(uid);

    const data = {
      settings: db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(uid) || null,
      llm: (() => {
        const l = db.prepare('SELECT * FROM llm_settings WHERE user_id = ?').get(uid);
        if (!l) return null;
        return { ...l, cloud_key: withKey ? l.cloud_key : '' };
      })(),
      attempts: db.prepare('SELECT * FROM attempts WHERE user_id = ? ORDER BY ts').all(uid),
      cards: db.prepare('SELECT * FROM cards WHERE user_id = ?').all(uid),
      notes: db.prepare('SELECT * FROM notes WHERE user_id = ?').all(uid),
      deck: db.prepare('SELECT * FROM card_deck WHERE user_id = ?').all(uid),
      checkins: db.prepare('SELECT * FROM checkins WHERE user_id = ?').all(uid),
      dailyPlan: db.prepare('SELECT * FROM daily_plan WHERE user_id = ?').all(uid),
      game: db.prepare('SELECT * FROM game_state WHERE user_id = ?').get(uid) || null,
      achievements: db.prepare('SELECT * FROM achievements WHERE user_id = ?').all(uid),
      boss: db.prepare('SELECT * FROM boss_records WHERE user_id = ?').all(uid),
      chats: db.prepare('SELECT * FROM chats WHERE user_id = ?').all(uid),
      classrooms: db.prepare('SELECT * FROM classrooms WHERE user_id = ?').all(uid),
      focus: db.prepare('SELECT * FROM focus_sessions WHERE user_id = ?').all(uid),
      customQuestions: db.prepare('SELECT * FROM questions WHERE owner_id = ?').all(uid),
    };

    return {
      app: 'kaoyan-math-tutor',
      schema: 3,
      exportedAt: new Date().toISOString(),
      keyStripped: !withKey,
      user,
      data,
    };
  });

  /* ============ 导入（合并 / 覆盖）============ */
  fastify.post('/api/import', {
    schema: {
      body: {
        type: 'object',
        required: ['bundle', 'mode'],
        properties: {
          bundle: { type: 'object' },
          mode: { type: 'string', enum: ['merge', 'replace'] },
        },
      },
    },
  }, async (req, reply) => {
    const { bundle, mode } = req.body;
    if (bundle.app !== 'kaoyan-math-tutor') return reply.code(400).send({ error: '这不是研数的备份文件' });
    const d = bundle.data || {};
    const uid = req.userId;

    const summary = { attempts: 0, cards: 0, notes: 0, deck: 0, checkins: 0, achievements: 0 };

    db.transaction(() => {
      if (mode === 'replace') {
        ['attempts', 'stats_node', 'stats_question', 'stats_daily', 'cards', 'notes',
          'card_deck', 'checkins', 'daily_plan', 'achievements', 'boss_records',
          'chats', 'classrooms', 'focus_sessions'].forEach((t) => {
          db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);
        });
      }

      // 作答：按 id 去重取并集 —— 合并永远不该让任何一份数据变少
      (d.attempts || []).forEach((a) => {
        const r = db.prepare(`INSERT OR IGNORE INTO attempts (id,user_id,qid,kid,answer,correct,context,date,ts)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(a.id, uid, a.qid, a.kid, a.answer ?? '', a.correct ? 1 : 0, a.context || 'import', a.date, a.ts);
        summary.attempts += r.changes;
      });

      // 卡片：同 id 取复习进度更靠后的那次
      (d.cards || []).forEach((c) => {
        const cur = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(c.id, uid);
        if (!cur) {
          insertCard(db, uid, cardFromExport(c));
          summary.cards += 1;
        } else if ((c.reps || 0) > (cur.reps || 0)) {
          /* 导入包里的进度更新。老导出包没有 FSRS 三列，cardFromExport 会用
           * interval 兜底；万一还是空，就保留库里已有的值 ——
           * 直接写 null 会把稳定度抹掉，下次复习又当成新卡。 */
          const inc = cardFromExport(c);
          updateCardSchedule(db, uid, c.id, {
            due: inc.due,
            interval: inc.interval,
            state: inc.state,
            stability: inc.stability ?? cur.stability,
            difficulty: inc.difficulty ?? cur.difficulty,
            reps: inc.reps,
            lapses: inc.lapses,
            lastReview: inc.lastReview,
          });
          summary.cards += 1;
        }
      });

      (d.notes || []).forEach((n) => {
        const r = db.prepare('INSERT OR IGNORE INTO notes (id,user_id,kid,text,date,created_at) VALUES (?,?,?,?,?,?)')
          .run(n.id, uid, n.kid, n.text, n.date, n.created_at);
        summary.notes += r.changes;
      });

      (d.deck || []).forEach((c) => {
        const r = db.prepare('INSERT OR IGNORE INTO card_deck (id,user_id,kid,type,title,front,back,src,ts) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(c.id, uid, c.kid, c.type, c.title, c.front, c.back, c.src, c.ts);
        summary.deck += r.changes;
      });

      (d.checkins || []).forEach((c) => {
        const cur = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?').get(uid, c.date);
        if (!cur || c.minutes > cur.minutes) {
          db.prepare(`INSERT INTO checkins (user_id,date,minutes,tasks_done) VALUES (?,?,?,?)
            ON CONFLICT(user_id,date) DO UPDATE SET minutes=excluded.minutes, tasks_done=excluded.tasks_done`)
            .run(uid, c.date, c.minutes, c.tasks_done);
          summary.checkins += 1;
        }
      });

      (d.achievements || []).forEach((a) => {
        const r = db.prepare('INSERT OR IGNORE INTO achievements (user_id,achievement_id,date) VALUES (?,?,?)')
          .run(uid, a.achievement_id, a.date);
        summary.achievements += r.changes;
      });

      if (d.game && (d.game.xp || 0) > 0) {
        const cur = db.prepare('SELECT xp FROM game_state WHERE user_id = ?').get(uid) || { xp: 0 };
        const xp = Math.max(cur.xp || 0, d.game.xp || 0);
        const blitz = (() => {
          const curB = safeJson(db.prepare('SELECT blitz FROM game_state WHERE user_id = ?').get(uid)?.blitz, null);
          const newB = safeJson(d.game.blitz, null);
          if (!curB) return newB;
          if (!newB) return curB;
          return (newB.score || 0) > (curB.score || 0) ? newB : curB;
        })();
        db.prepare(`INSERT INTO game_state (user_id, xp, best_combo, blitz) VALUES (?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET xp = excluded.xp, best_combo = MAX(best_combo, excluded.best_combo), blitz = excluded.blitz`)
          .run(uid, xp, d.game.best_combo || 0, JSON.stringify(blitz));
      }

      // 自定义题
      (d.customQuestions || []).forEach((q) => {
        db.prepare(`INSERT OR IGNORE INTO questions (id,kid,type,difficulty,stem,options,answer,analysis,source_type,source_year,source,owner_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(q.id, q.kid, q.type, q.difficulty, q.stem, q.options, q.answer, q.analysis, q.source_type, q.source_year, q.source, uid);
      });
    })();

    // 导入后必须重建聚合（合并的统计口径以明细并集为准）
    const { rebuildStats } = await import('../db/index.js');
    rebuildStats(uid);
    invalidateTree();
    checkAchievements(uid);

    return { ok: true, mode, summary };
  });

  /* ============ 存储用量 ============ */
  fastify.get('/api/storage', async (req) => {
    const uid = req.userId;
    const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`).get(uid).n;
    const size = db.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get();
    return {
      attempts: count('attempts'),
      cards: count('cards'),
      notes: count('notes'),
      deck: count('card_deck'),
      dbBytes: size.bytes,
      dbMb: Number((size.bytes / 1024 / 1024).toFixed(2)),
    };
  });
}

/* 按 kind 解析出当前生效的模型配置 */
export function resolveLlm(l) {
  if (l.kind === 'local') {
    return { base: l.local_base, model: l.local_model, key: '' };
  }
  return { base: l.cloud_base, model: l.cloud_model, key: l.cloud_key };
}

function explainHttp(status, text) {
  const snippet = String(text || '').slice(0, 300);
  if (status === 401) return '密钥无效或已过期（401）';
  if (status === 402) return '账户余额不足（402）';
  if (status === 403) return '没有访问该模型的权限（403）';
  if (status === 404) return `接口地址不对或模型名不存在（404）：${snippet}`;
  if (status === 429) return '请求太频繁或超出配额（429），等一下再试';
  if (status >= 500) return `模型服务端出错（${status}）：${snippet}`;
  return `HTTP ${status}：${snippet}`;
}

function shapeDeck(r) {
  return { id: r.id, kid: r.kid, type: r.type, title: r.title, front: r.front, back: r.back, src: r.src, ts: r.ts };
}

function safeJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
