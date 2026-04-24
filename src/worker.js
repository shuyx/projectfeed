import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('/api/*', cors());

// ============================================================
// Helpers
// ============================================================

function getSyncSecret(env) {
  // Set via: wrangler secret put SYNC_SECRET
  return env.SYNC_SECRET || 'local-dev-sync-secret';
}

// projectfeed.id → Todoist project id（与 Obsidian _Portfolio/.todoist-config.json 一致）
const TODOIST_PROJECT_MAP = {
  'xiangcheng':      '6gQ8gmjjC6Pfx4Wc',
  'dechuang-robot':  '6gQ8gp2QR2PMChrv',
  'bci':             '6gQ8gp358vrfprc6',
  'dechuang-sched':  '6gQ8gp664f6cWFmx',
  'nantong':         '6gQ8gpH57Wvcr9vM',
  'kuangchuang':     '6gQhVJWVxHFjF95C',
  'drone':           '6gQ8gpJwGv8gGfRQ',
  'embodied-data':   '6gQ8gpQCMQ5Xxq9R',
  'fmea':            '6gQ8gpXgcgmWr3RX',
  'emba':            '6gQ8gpf3gFrXfwvV',
  'ai-cap':          '6gQ8gprw8Jrf2h7Q',
  'personal':        '6gQ8gpxc7HwpFr3J',
};

const VALID_TAGS = ['todo', 'progress', 'idea'];

async function createTodoistTask(env, { content, description, projectId }) {
  if (!env.TODOIST_API_TOKEN) return { ok: false, error: 'TODOIST_API_TOKEN not set' };
  try {
    const resp = await fetch('https://api.todoist.com/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content,
        description: description || '',
        project_id: projectId,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      return { ok: false, error: `${resp.status}: ${err.slice(0, 200)}` };
    }
    const data = await resp.json();
    return { ok: true, task_id: data.id, url: data.url };
  } catch (e) {
    return { ok: false, error: e.message || 'network error' };
  }
}

async function syncTodoForTodoistTag(c, { noteId, projectId, content }) {
  const todoistProjectId = TODOIST_PROJECT_MAP[projectId];
  if (!todoistProjectId) return { status: 'skipped', reason: 'no_mapping' };

  const firstLine = String(content).split('\n').find((l) => l.trim()) || content;
  const title = firstLine.slice(0, 80);
  const rest = content.slice(title.length).trim();
  const desc = (rest ? rest.slice(0, 800) + (rest.length > 800 ? '...' : '') + '\n\n' : '') +
    `📱 from projectfeed · ${new Date().toISOString().slice(0, 10)}`;

  const r = await createTodoistTask(c.env, { content: title, description: desc, projectId: todoistProjectId });
  if (r.ok) {
    await c.env.DB.prepare('UPDATE notes SET todoist_task_id = ? WHERE id = ?').bind(r.task_id, noteId).run();
    return { status: 'ok', task_id: r.task_id, url: r.url };
  }
  return { status: 'failed', error: r.error };
}

async function callMinimax(c, { messages, system, user, temperature = 0.3, max_tokens = 1200 }) {
  const apiKey = c.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('LLM 未配置：需要设置 MINIMAX_API_KEY');
  const baseUrl = c.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1/text/chatcompletion_v2';
  const model = c.env.MINIMAX_MODEL || 'MiniMax-M2.7-highspeed';
  let msgs = messages;
  if (!msgs) {
    msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push({ role: 'user', content: user });
  }
  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: msgs, temperature, max_tokens }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM API 失败: ${resp.status} ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ============================================================
// Config
// ============================================================

app.get('/api/config', async (c) => {
  const projects = await c.env.DB.prepare(
    'SELECT * FROM projects ORDER BY sort_order ASC'
  ).all();
  return c.json({ projects: projects.results || [] });
});

// ============================================================
// Notes (main + knowledge + summary + progress)
// ============================================================

app.get('/api/notes', async (c) => {
  const project = c.req.query('project');
  const before = c.req.query('before');
  const limit = Math.min(parseInt(c.req.query('limit') || '30'), 100);

  // Top-level only (main/summary/progress); knowledge attached as children
  let sql, binds;
  if (project && project !== 'all') {
    if (before) {
      sql = 'SELECT * FROM notes WHERE parent_id IS NULL AND project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?';
      binds = [project, before, limit];
    } else {
      sql = 'SELECT * FROM notes WHERE parent_id IS NULL AND project_id = ? ORDER BY created_at DESC LIMIT ?';
      binds = [project, limit];
    }
  } else {
    if (before) {
      sql = 'SELECT * FROM notes WHERE parent_id IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?';
      binds = [before, limit];
    } else {
      sql = 'SELECT * FROM notes WHERE parent_id IS NULL ORDER BY created_at DESC LIMIT ?';
      binds = [limit];
    }
  }
  const result = await c.env.DB.prepare(sql).bind(...binds).all();
  const notes = result.results || [];

  if (notes.length) {
    const ids = notes.map(n => n.id);
    const placeholders = ids.map(() => '?').join(',');
    const childRes = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE parent_id IN (${placeholders}) ORDER BY created_at ASC`
    ).bind(...ids).all();
    const byParent = {};
    for (const child of (childRes.results || [])) {
      (byParent[child.parent_id] = byParent[child.parent_id] || []).push(child);
    }
    for (const n of notes) n.children = byParent[n.id] || [];
  }

  return c.json({ notes, hasMore: notes.length === limit });
});

app.post('/api/notes', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { project_id: rawProjectId, content, parent_id, card_type: rawCardType, tag: rawTag } = body;
  if (!content || !content.trim()) return c.json({ error: 'content required' }, 400);

  let card_type = rawCardType || (parent_id ? 'knowledge' : 'main');
  if (!['main', 'knowledge', 'summary', 'suggestion', 'profile'].includes(card_type)) {
    return c.json({ error: 'invalid card_type' }, 400);
  }

  let project_id = rawProjectId;
  let parentIdFinal = null;
  if (card_type === 'knowledge') {
    if (!parent_id) return c.json({ error: 'knowledge card requires parent_id' }, 400);
    const parent = await c.env.DB.prepare('SELECT project_id, parent_id FROM notes WHERE id = ?')
      .bind(parent_id).first();
    if (!parent) return c.json({ error: 'parent note not found' }, 404);
    if (parent.parent_id) return c.json({ error: 'cannot nest knowledge cards' }, 400);
    project_id = parent.project_id;
    parentIdFinal = parent_id;
  } else {
    if (!project_id) return c.json({ error: 'project_id required' }, 400);
  }

  // tag：仅 main 卡有效
  let tag = null;
  if (card_type === 'main') {
    if (rawTag && !VALID_TAGS.includes(rawTag)) {
      return c.json({ error: `invalid tag (must be one of ${VALID_TAGS.join('/')})` }, 400);
    }
    tag = rawTag || 'progress';   // 未指定默认 progress（兼容旧客户端）
  }

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  await c.env.DB.prepare(
    'INSERT INTO notes (id, project_id, content, card_type, parent_id, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, project_id, content, card_type, parentIdFinal, tag, created_at).run();

  // tag === 'todo' 自动同步 Todoist
  let todoistSync = null;
  if (card_type === 'main' && tag === 'todo') {
    todoistSync = await syncTodoForTodoistTag(c, { noteId: id, projectId: project_id, content });
  }

  return c.json({
    id, project_id, content, card_type, parent_id: parentIdFinal, tag, created_at,
    ...(todoistSync ? { todoist_sync: todoistSync } : {}),
  });
});

// POST /api/profile/:project_id  — upsert 项目基础档案卡
// Auth: X-Sync-Secret（与 /api/progress 共用）
app.post('/api/profile/:project_id', async (c) => {
  const provided = c.req.header('X-Sync-Secret');
  if (!provided || provided !== getSyncSecret(c.env)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const project_id = c.req.param('project_id');
  const { content } = await c.req.json().catch(() => ({}));
  if (!content || !content.trim()) return c.json({ error: 'content required' }, 400);

  const proj = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(project_id).first();
  if (!proj) return c.json({ error: 'project_id not found' }, 404);

  const existing = await c.env.DB.prepare(
    "SELECT id FROM notes WHERE project_id = ? AND card_type = 'profile'"
  ).bind(project_id).first();

  const now = new Date().toISOString();
  if (existing) {
    await c.env.DB.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
      .bind(content, now, existing.id).run();
    return c.json({ id: existing.id, project_id, card_type: 'profile', content, updated_at: now, action: 'updated' });
  } else {
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO notes (id, project_id, content, card_type, created_at) VALUES (?, ?, ?, 'profile', ?)"
    ).bind(id, project_id, content, now).run();
    return c.json({ id, project_id, card_type: 'profile', content, created_at: now, action: 'created' });
  }
});

// 重试 Todoist 同步（卡片上的 ⚠️ 失败重试按钮调这个）
app.post('/api/notes/:id/retry-todoist', async (c) => {
  const id = c.req.param('id');
  const note = await c.env.DB.prepare(
    'SELECT id, project_id, content, tag, todoist_task_id FROM notes WHERE id = ?'
  ).bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  if (note.tag !== 'todo') return c.json({ error: 'not a todo card' }, 400);
  if (note.todoist_task_id) return c.json({ error: 'already synced', task_id: note.todoist_task_id }, 409);
  const r = await syncTodoForTodoistTag(c, { noteId: id, projectId: note.project_id, content: note.content });
  return c.json({ todoist_sync: r });
});

app.put('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  const { content } = await c.req.json().catch(() => ({}));
  if (!content || !content.trim()) return c.json({ error: 'content required' }, 400);

  const note = await c.env.DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);

  const updated_at = new Date().toISOString();
  await c.env.DB.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
    .bind(content, updated_at, id).run();

  return c.json({ id, content, updated_at });
});

app.delete('/api/notes/:id', async (c) => {
  const id = c.req.param('id');
  const note = await c.env.DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);

  // Cascade: deleting a top-level card also drops knowledge children + chats
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM notes WHERE id = ? OR parent_id = ?').bind(id, id),
    c.env.DB.prepare('DELETE FROM chats WHERE parent_note_id = ?').bind(id),
  ]);
  return c.json({ success: true });
});

// ============================================================
// Progress sync (from Obsidian /反馈 /复盘 /记录 hooks)
// Auth: X-Sync-Secret header (shared secret)
// ============================================================

app.post('/api/progress', async (c) => {
  const provided = c.req.header('X-Sync-Secret');
  const expected = getSyncSecret(c.env);
  if (!provided || provided !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const { project_id, content, source, source_ref } = body;
  if (!project_id || !content || !content.trim()) {
    return c.json({ error: 'project_id and content required' }, 400);
  }
  if (source && !['feedback', 'recap', 'capsule', 'manual'].includes(source)) {
    return c.json({ error: 'invalid source' }, 400);
  }

  // Verify project exists
  const proj = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(project_id).first();
  if (!proj) return c.json({ error: 'project_id not found' }, 404);

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  await c.env.DB.prepare(
    'INSERT INTO notes (id, project_id, content, card_type, source, source_ref, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, project_id, content, 'progress', source || 'manual', source_ref || null, 'progress', created_at).run();

  return c.json({ id, card_type: 'progress', tag: 'progress', project_id, source, source_ref, created_at });
});

// ============================================================
// Export (Markdown) — for backup + sharing
// ============================================================

app.get('/api/export', async (c) => {
  const project = c.req.query('project') || 'all';
  const tag = c.req.query('tag') || 'all';
  const format = c.req.query('format') || 'md';
  if (format !== 'md') return c.json({ error: 'only md supported' }, 400);

  const projects = await c.env.DB.prepare('SELECT id, name, emoji, priority FROM projects ORDER BY sort_order').all();
  const projMap = Object.fromEntries((projects.results || []).map(p => [p.id, p]));

  let sql, binds;
  const tagCondition = (tag && tag !== 'all') ? ' AND tag = ?' : '';
  if (project === 'all') {
    sql = `SELECT * FROM notes WHERE parent_id IS NULL${tagCondition} ORDER BY project_id, created_at DESC LIMIT 2000`;
    binds = tag !== 'all' ? [tag] : [];
  } else {
    sql = `SELECT * FROM notes WHERE parent_id IS NULL AND project_id = ?${tagCondition} ORDER BY created_at DESC LIMIT 2000`;
    binds = tag !== 'all' ? [project, tag] : [project];
  }
  const { results: notes } = await c.env.DB.prepare(sql).bind(...binds).all();

  // Attach knowledge children
  let children = [];
  if (notes && notes.length) {
    const ids = notes.map(n => n.id);
    const placeholders = ids.map(() => '?').join(',');
    const childRes = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE parent_id IN (${placeholders}) ORDER BY created_at ASC`
    ).bind(...ids).all();
    children = childRes.results || [];
  }
  const byParent = {};
  for (const k of children) (byParent[k.parent_id] = byParent[k.parent_id] || []).push(k);

  // Group by project
  const groups = {};
  for (const n of (notes || [])) {
    (groups[n.project_id] = groups[n.project_id] || []).push(n);
  }

  const now = new Date();
  const ts = now.toISOString().replace(/[:T]/g, '-').slice(0, 16);
  let md = `# projectfeed 导出\n\n> 导出时间：${now.toISOString().slice(0, 16).replace('T', ' ')}\n> 范围：${project === 'all' ? '全部项目' : projMap[project]?.name || project}`;
  if (tag !== 'all') md += ` · 仅 tag=${tag}`;
  md += `\n> 条目数：${notes?.length || 0}\n\n---\n`;

  const tagLabel = { todo: '🎯 待办', progress: '✅ 进展', idea: '💡 想法' };
  const typeLabel = { main: '主卡', progress: '📥 进度卡', summary: '🤖 整理', suggestion: '🔮 建议', knowledge: '🧠 知识' };

  for (const pid of Object.keys(groups)) {
    const p = projMap[pid];
    md += `\n\n## ${p?.emoji || ''} ${p?.name || pid}${p?.priority ? ` [${p.priority}]` : ''}\n`;
    for (const n of groups[pid]) {
      const date = (n.created_at || '').slice(0, 10);
      const time = (n.created_at || '').slice(11, 16);
      const tagBadge = n.tag ? tagLabel[n.tag] || n.tag : '';
      const typeBadge = typeLabel[n.card_type] || n.card_type || '';
      md += `\n### ${date} ${time} · ${typeBadge}${tagBadge ? ' · ' + tagBadge : ''}\n\n`;
      md += `${n.content}\n`;
      if (n.updated_at) md += `\n> _编辑于 ${(n.updated_at || '').slice(0, 16).replace('T', ' ')}_\n`;
      if (n.source) md += `\n> _来源：${n.source}${n.source_ref ? ' · ' + n.source_ref : ''}_\n`;
      if (n.todoist_task_id) md += `\n> _Todoist: ${n.todoist_task_id}_\n`;
      const kids = byParent[n.id] || [];
      for (const k of kids) {
        md += `\n<details>\n<summary>🧠 ${(k.content.split('\n')[0] || '').slice(0, 60)}</summary>\n\n${k.content}\n\n</details>\n`;
      }
    }
  }

  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="projectfeed-${project}-${ts}.md"`,
    },
  });
});

// ============================================================
// AI: proofread (minimal correction)
// ============================================================

app.post('/api/ai/correct', async (c) => {
  const { text } = await c.req.json().catch(() => ({}));
  if (!text || !text.trim()) return c.json({ error: 'text required' }, 400);
  if (text.length > 2000) return c.json({ error: '文本过长（>2000 字）' }, 400);

  const projects = await c.env.DB.prepare('SELECT name FROM projects').all();
  const projectNames = (projects.results || []).map(p => p.name);
  const projLine = projectNames.length ? `项目名参考：${projectNames.join('、')}` : '';

  const system = '你是中文文本纠错助手。只做拼写/错别字修正，不改写句子，不加解释。';
  const user = `请对下面这段项目进展记录做最小改动的拼写与错别字纠错：

${projLine}

规则：
1. 仅修正错别字、同音错字
2. 不改变句子结构、语气、标点风格
3. 不新增或删除内容
4. 数字、日期、金额、百分比、单位保持原样
5. 如原文无需修改，原样返回
6. 只输出修正后的文本，不要加前缀、后缀、解释、markdown、引号

原文：
${text}`;

  try {
    const raw = await callMinimax(c, { system, user, temperature: 0.1, max_tokens: 1500 });
    let corrected = String(raw || '').trim();
    corrected = corrected.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    corrected = corrected.replace(/^(修正后[:：]|纠正后[:：]|结果[:：])\s*/i, '');
    corrected = corrected.replace(/^["“'']|["”'']$/g, '');
    const changed = corrected && corrected !== text.trim();
    return c.json({ corrected: corrected || text, changed });
  } catch (e) {
    return c.json({ error: e.message || 'LLM 调用异常' }, 502);
  }
});

// ============================================================
// Chat — multi-turn anchored to a main note
// ============================================================

app.get('/api/chat/:parent_note_id', async (c) => {
  const pid = c.req.param('parent_note_id');
  const row = await c.env.DB.prepare(
    'SELECT id, messages, created_at FROM chats WHERE parent_note_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(pid).first();
  if (!row) return c.json({ messages: [], chat_id: null });
  try {
    const msgs = JSON.parse(row.messages);
    return c.json({ messages: Array.isArray(msgs) ? msgs : [], chat_id: row.id });
  } catch {
    return c.json({ messages: [], chat_id: row.id });
  }
});

app.post('/api/chat', async (c) => {
  const { parent_note_id, message, history = [] } = await c.req.json().catch(() => ({}));

  if (!parent_note_id || !message || !message.trim()) {
    return c.json({ error: 'parent_note_id and message required' }, 400);
  }
  if (message.length > 2000) return c.json({ error: '消息过长（>2000 字）' }, 400);
  if (!Array.isArray(history)) return c.json({ error: 'history must be array' }, 400);

  const parent = await c.env.DB.prepare(
    'SELECT id, content, project_id, created_at, card_type FROM notes WHERE id = ? AND parent_id IS NULL'
  ).bind(parent_note_id).first();
  if (!parent) return c.json({ error: 'parent note not found' }, 404);

  // children (existing knowledge cards)
  const childRes = await c.env.DB.prepare(
    'SELECT content FROM notes WHERE parent_id = ? ORDER BY created_at ASC'
  ).bind(parent_note_id).all();

  // recent same-project (main + progress) as context
  const recentRes = await c.env.DB.prepare(
    "SELECT content, created_at, card_type FROM notes WHERE project_id = ? AND parent_id IS NULL AND id != ? AND card_type IN ('main', 'progress') ORDER BY created_at DESC LIMIT 8"
  ).bind(parent.project_id, parent_note_id).all();

  const ctxLines = [
    `【当前主卡 · ${parent.created_at.slice(0, 10)}】${parent.content}`,
  ];
  for (const k of (childRes.results || [])) {
    ctxLines.push(`【已有知识卡】${k.content}`);
  }
  if (recentRes.results && recentRes.results.length) {
    ctxLines.push('\n【该项目近期进展（参考）】');
    for (const r of recentRes.results) {
      const tag = r.card_type === 'progress' ? '[进度]' : '';
      ctxLines.push(`- ${r.created_at.slice(0, 10)} ${tag}${r.content}`);
    }
  }

  const system = `你是个人项目助手，基于用户提供的进展记录回答问题。
规则：
1. 基于下面上下文，不编造具体姓名、数字、金额
2. 中文，简洁专业
3. 上下文不足时直说"基于当前信息无法判断"，然后给通用建议
4. 不要"好的我来"这类开场白

上下文：
${ctxLines.join('\n')}`;

  const prior = history.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));

  const llmMessages = [
    { role: 'system', content: system },
    ...prior,
    { role: 'user', content: message },
  ];

  try {
    const reply = await callMinimax(c, { messages: llmMessages, temperature: 0.5, max_tokens: 1500 });
    const now = Date.now();
    const fullHistory = [
      ...history,
      { role: 'user', content: message, ts: now },
      { role: 'assistant', content: reply, ts: now + 1 },
    ];

    const existing = await c.env.DB.prepare(
      'SELECT id FROM chats WHERE parent_note_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(parent_note_id).first();
    if (existing) {
      await c.env.DB.prepare('UPDATE chats SET messages = ? WHERE id = ?')
        .bind(JSON.stringify(fullHistory), existing.id).run();
    } else {
      await c.env.DB.prepare(
        'INSERT INTO chats (id, parent_note_id, messages, created_at) VALUES (?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), parent_note_id, JSON.stringify(fullHistory), new Date().toISOString()).run();
    }

    return c.json({ reply, messages: fullHistory });
  } catch (e) {
    return c.json({ error: e.message || 'LLM 异常' }, 502);
  }
});

// ============================================================
// Summarize — three combos: main only / +progress / +progress +knowledge
// ============================================================

app.post('/api/summarize', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    timeRange = '7d',
    project = 'all',
    include_progress = true,
    include_knowledge = false,
    tag_filter = 'all',           // 'all' | 'todo' | 'progress' | 'idea'
    generate_suggestion = true,
  } = body;
  const days = timeRange === '30d' ? 30 : timeRange === 'all' ? 3650 : 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // 永远排除 summary 和 suggestion（避免 AI 总结 AI 的产出）
  const allowed = ['main'];
  if (include_progress) allowed.push('progress');
  if (include_knowledge) allowed.push('knowledge');
  const placeholders = allowed.map(() => '?').join(',');

  const tagCondition = (tag_filter && tag_filter !== 'all') ? ' AND tag = ?' : '';

  let sql, binds;
  if (project === 'all') {
    sql = `SELECT * FROM notes WHERE created_at >= ? AND card_type IN (${placeholders})${tagCondition} ORDER BY created_at ASC LIMIT 500`;
    binds = tag_filter !== 'all' ? [cutoff, ...allowed, tag_filter] : [cutoff, ...allowed];
  } else {
    sql = `SELECT * FROM notes WHERE created_at >= ? AND project_id = ? AND card_type IN (${placeholders})${tagCondition} ORDER BY created_at ASC LIMIT 500`;
    binds = tag_filter !== 'all' ? [cutoff, project, ...allowed, tag_filter] : [cutoff, project, ...allowed];
  }
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();

  if (!results || !results.length) {
    return c.json({ error: '所选范围内没有数据（检查 tag / 项目 / 时间）' }, 400);
  }

  const tagLabel = { todo: '[待办]', progress: '[进展]', idea: '[想法]' };
  const typeLabel = { knowledge: '[知识]', progress: '[进度]', main: '' };
  const lines = results.map(n => {
    const ttag = n.tag ? (tagLabel[n.tag] || '') : '';
    const ttype = typeLabel[n.card_type] || '';
    return `[${n.created_at.slice(0, 10)}] ${ttype}${ttag}${n.content}`;
  }).join('\n');

  const parts = ['主卡'];
  if (include_progress) parts.push('进度卡');
  if (include_knowledge) parts.push('知识卡');
  const tagTagStr = tag_filter === 'all' ? '' : ` · 仅 ${tag_filter}`;

  // 加载 profile 卡作为 system context（按项目 or 全部）
  let profileContext = '';
  if (project === 'all') {
    const { results: profiles } = await c.env.DB.prepare(
      "SELECT project_id, content FROM notes WHERE card_type = 'profile'"
    ).all();
    if (profiles && profiles.length) {
      profileContext = profiles.map(p => `【${p.project_id}】\n${String(p.content).slice(0, 800)}`).join('\n\n---\n\n');
    }
  } else {
    const prof = await c.env.DB.prepare(
      "SELECT content FROM notes WHERE project_id = ? AND card_type = 'profile'"
    ).bind(project).first();
    if (prof) profileContext = String(prof.content).slice(0, 1500);
  }

  const systemPrompt = profileContext
    ? `你是个人项目进展整理助手。以下是该项目（或多个项目）的基础档案，请在整理时作为背景参考，帮助你识别关键人物、里程碑和约束。

${profileContext}

---`
    : '你是个人项目进展整理助手。';

  const summaryPrompt = `以下是「${project === 'all' ? '全部项目' : project}」近 ${days} 天的记录（来源：${parts.join(' + ')}${tagTagStr}）。请输出结构化摘要：

1. **关键进展**（3-5 条，含具体数字/人物）
2. **待办和风险**（从未完成事项识别）
3. **决策与洞察**（关键决策、认知更新）

要求：中文，直接输出 Markdown，不加"好的我来"开场白。保留原文数字和专有名词。${include_progress ? '标记 [进度] 的来自 Obsidian 同步。' : ''}${include_knowledge ? '标记 [知识] 的是 AI 问答沉淀。' : ''}

---
原始记录：
${lines}`;

  try {
    const summary = await callMinimax(c, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: summaryPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    });

    let suggestion = null;
    if (generate_suggestion) {
      const suggestionPrompt = `基于下面对项目的整理摘要，列出 **3-5 条下一步建议**。每条 1-2 句话，含具体动作（如可判断请点出负责人、时间节点或约束）。

规则：
- 只输出建议列表，无标题无前言
- 每条以 "- " 开头
- 中文
- 不要重复摘要里已有的内容；要提出"下一步该做什么"
- 区分"必须做"和"可以做"

---
整理摘要：
${summary}`;

      try {
        suggestion = await callMinimax(c, {
          messages: [{ role: 'user', content: suggestionPrompt }],
          temperature: 0.5,
          max_tokens: 800,
        });
      } catch (e2) {
        suggestion = null;   // 建议失败不阻塞
      }
    }

    return c.json({
      summary: summary || '(空返回)',
      suggestion: suggestion || null,
      meta: { days, project, noteCount: results.length, include_progress, include_knowledge, tag_filter },
    });
  } catch (e) {
    const msg = e.message || 'LLM 调用异常';
    const isConfig = msg.includes('LLM 未配置');
    return c.json({ error: msg }, isConfig ? 503 : 502);
  }
});

// ============================================================
// Static fallback
// ============================================================

app.all('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
