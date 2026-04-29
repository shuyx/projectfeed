import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { version as APP_VERSION } from '../package.json';

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
// v1.17: TODOIST_PROJECT_MAP 从硬编码迁到 D1 projects.todoist_project_id 列
// 通过 getTodoistProjectId(env, projectId) 查，支持用户动态新增项目
async function getTodoistProjectId(env, projectId) {
  const row = await env.DB.prepare('SELECT todoist_project_id FROM projects WHERE id = ?')
    .bind(projectId).first();
  return row?.todoist_project_id || null;
}

// v1.17: 优先级 → Todoist 项目颜色映射
const TODOIST_COLOR_BY_PRIORITY = {
  P0: 'red',
  P1: 'orange',
  P2: 'blue',
  continuous: 'grey',
};

// v1.17: 在 Todoist 创建 project，返回 { ok, project_id, error }
async function createTodoistProject(env, { name, color }) {
  if (!env.TODOIST_API_TOKEN) return { ok: false, error: 'TODOIST_API_TOKEN not set' };
  try {
    const resp = await fetch('https://api.todoist.com/api/v1/projects', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, color: color || 'charcoal' }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      return { ok: false, error: `${resp.status}: ${err.slice(0, 200)}` };
    }
    const data = await resp.json();
    return { ok: true, project_id: data.id };
  } catch (e) {
    return { ok: false, error: e.message || 'network error' };
  }
}

const VALID_TAGS = ['todo', 'progress', 'idea', 'milestone'];

// ============================================================
// v1.15 · 中文时间解析（for tag=todo cards）
// 覆盖：今天/明天/后天/大后天 · 周X/下周X · M月D日 · 上午/下午/晚上/凌晨/中午 · N点/半/分
// 不覆盖：3小时后、周末、月底、大约等模糊表达
// 返回 ISO 8601 带东八区时区的字符串，如 '2026-04-25T19:00:00+08:00'；不识别则返回 null
// ============================================================
function parseChineseDatetime(text) {
  if (!text) return null;
  const s = String(text);

  // —— 1. 日期部分（优先级：绝对日期 > 今明后 > 下周X > 周X）——
  // 以东八区为"今天"基准（projectfeed 是单人 App，用户在中国）
  const nowUtc = new Date();
  const now = new Date(nowUtc.getTime() + 8 * 3600 * 1000);  // 转成北京时间概念
  let y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  let dateMatched = false;

  // 绝对日期：M月D日 / M月D号 / M/D / M-D
  let mm = s.match(/(\d{1,2})\s*[月\/\-]\s*(\d{1,2})\s*[日号]?/);
  if (mm) {
    const mon = parseInt(mm[1]) - 1, day = parseInt(mm[2]);
    if (mon >= 0 && mon < 12 && day >= 1 && day <= 31) {
      m = mon; d = day; dateMatched = true;
      // 如果该日期已过，推到下一年
      const candidate = new Date(Date.UTC(y, m, d));
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      if (candidate < today) y += 1;
    }
  }

  // 相对天（含复合词 "今晚/明早/明晚" 等）
  if (!dateMatched) {
    const relMap = {
      '大后天': 3,
      '今天': 0, '今日': 0, '今早': 0, '今晨': 0, '今晚': 0, '今夜': 0,
      '明天': 1, '明日': 1, '明早': 1, '明晨': 1, '明晚': 1, '明夜': 1,
      '后天': 2,
    };
    // 按 key 长度降序尝试（大后天 > 后天，今晚 > 今）
    const keys = Object.keys(relMap).sort((a, b) => b.length - a.length);
    for (const kw of keys) {
      if (s.includes(kw)) {
        const offset = relMap[kw];
        const target = new Date(Date.UTC(y, m, d + offset));
        y = target.getUTCFullYear(); m = target.getUTCMonth(); d = target.getUTCDate();
        dateMatched = true;
        break;
      }
    }
  }

  // 下周 X / 周 X（统一按"最近未来的该星期"处理；下周 X 用户预期的次周语义在移动端可通过"N 月 D 日"精确表达）
  if (!dateMatched) {
    const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    let wm = s.match(/(?:下(?:个)?(?:周|星期|礼拜)|本周|这周|这个?星期|周|星期|礼拜)([一二三四五六日天])/);
    if (wm && weekMap[wm[1]] !== undefined) {
      const targetDow = weekMap[wm[1]];
      const currentDow = now.getUTCDay();
      const daysUntilTarget = (targetDow - currentDow + 7) % 7;  // 0 = 今天就是该 dow
      const target = new Date(Date.UTC(y, m, d + daysUntilTarget));
      y = target.getUTCFullYear(); m = target.getUTCMonth(); d = target.getUTCDate();
      dateMatched = true;
    }
  }

  // —— 2. 时间部分 ——
  let h = null, min = null;

  // 优先匹配 "N 点半"（避免被 "N 点" 先吃掉）
  let hm = s.match(/(\d{1,2})\s*点半/);
  if (hm) {
    h = parseInt(hm[1]);
    min = 30;
  } else {
    // "N 点 M 分" / "N 时 M 分" / "N:M"
    let tm = s.match(/(\d{1,2})\s*[点时:]\s*(\d{1,2})?\s*分?/);
    if (tm) {
      h = parseInt(tm[1]);
      if (tm[2] !== undefined) min = parseInt(tm[2]);
    }
  }

  // 上下午前缀调整（有具体 N 点时）
  // 匹配范围放宽：晚上/晚/夜/今晚/明晚/傍晚/下午 都视为"下午/晚上"信号
  if (h !== null) {
    if (/凌晨/.test(s) && h === 12) h = 0;                                       // 凌晨 12 点 = 00:00
    else if (/(晚上|今晚|明晚|今夜|明夜|夜里|夜晚|傍晚|下午)/.test(s) && h >= 1 && h <= 11) h += 12;
    // 中午/凌晨 N 点（其他小时范围）直接采用 N
  }

  // 前缀默认值：只说"下午/晚上/中午/凌晨/上午/早上"没说具体小时
  if (h === null) {
    if (/(晚上|今晚|明晚|今夜|明夜|夜里|夜晚)/.test(s)) h = 19;
    else if (/傍晚/.test(s)) h = 18;
    else if (/下午/.test(s)) h = 14;
    else if (/中午/.test(s)) h = 12;
    else if (/凌晨/.test(s)) h = 2;
    else if (/(早上|上午|今早|明早|今晨|明晨)/.test(s)) h = 9;
  }

  // —— 3. 组装 ——
  if (!dateMatched && h === null) return null;

  // 只有时间没有日期：默认今天（若时间已过则明天）
  if (!dateMatched && h !== null) {
    const nowH = now.getUTCHours(), nowM = now.getUTCMinutes();
    if (h < nowH || (h === nowH && (min ?? 0) <= nowM)) {
      const tmr = new Date(Date.UTC(y, m, d + 1));
      y = tmr.getUTCFullYear(); m = tmr.getUTCMonth(); d = tmr.getUTCDate();
    }
  }

  // 只有日期没有时间：默认早 9 点
  if (dateMatched && h === null) { h = 9; min = 0; }
  if (min === null) min = 0;

  // 组装 ISO 带 +08:00 时区
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m + 1)}-${pad(d)}T${pad(h)}:${pad(min)}:00+08:00`;
}

// v1.12/v1.13 · 过滤器映射（Option 2：UI 7 维）
// 前端传 filter=<key>，后端解析为附加 WHERE
function filterToWhere(filter) {
  switch (filter) {
    case 'todo':       return { sql: "tag = 'todo' AND card_type = 'main'", binds: [] };
    case 'progress':   return { sql: "tag IN ('progress','milestone') AND card_type = 'main'", binds: [] };  // 进展包含里程碑
    case 'idea':       return { sql: "tag = 'idea' AND card_type = 'main'", binds: [] };
    case 'milestone':  return { sql: "tag = 'milestone' AND card_type = 'main'", binds: [] };
    case 'feedback':   return { sql: "card_type = 'progress'", binds: [] };  // Obsidian 同步卡
    case 'summary':    return { sql: "card_type IN ('summary','suggestion')", binds: [] };
    case 'archived':   return { sql: 'archived = 1', binds: [] };  // v1.13 · 已完成视图
    case 'due-board':  return { sql: "tag IN ('todo','milestone') AND due_at IS NOT NULL AND card_type = 'main'", binds: [] };  // v1.24 · 项目分组视图（仅有截止时间的 todo/milestone）
    default: return null;
  }
}

async function createTodoistTask(env, { content, description, projectId, dueAt }) {
  if (!env.TODOIST_API_TOKEN) return { ok: false, error: 'TODOIST_API_TOKEN not set' };
  try {
    const body = {
      content,
      description: description || '',
      project_id: projectId,
    };
    // v1.15: 若本地解析到截止时间，带 due_datetime（ISO 8601 带时区）
    if (dueAt) body.due_datetime = dueAt;
    const resp = await fetch('https://api.todoist.com/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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

async function syncTodoForTodoistTag(c, { noteId, projectId, content, dueAt }) {
  // v1.17: 从 D1 查 todoist_project_id（替代硬编码 MAP）
  const todoistProjectId = await getTodoistProjectId(c.env, projectId);
  if (!todoistProjectId) return { status: 'skipped', reason: 'no_mapping' };

  const firstLine = String(content).split('\n').find((l) => l.trim()) || content;
  const title = firstLine.slice(0, 80);
  const rest = content.slice(title.length).trim();
  const desc = (rest ? rest.slice(0, 800) + (rest.length > 800 ? '...' : '') + '\n\n' : '') +
    `📱 from projectfeed · ${new Date().toISOString().slice(0, 10)}`;

  const r = await createTodoistTask(c.env, { content: title, description: desc, projectId: todoistProjectId, dueAt });
  if (r.ok) {
    await c.env.DB.prepare('UPDATE notes SET todoist_task_id = ? WHERE id = ?').bind(r.task_id, noteId).run();
    return { status: 'ok', task_id: r.task_id, url: r.url };
  }
  return { status: 'failed', error: r.error };
}

async function callLLM(c, { messages, system, user, temperature = 0.3, max_tokens = 1200 }) {
  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('LLM 未配置：需要设置 DEEPSEEK_API_KEY');
  const baseUrl = c.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions';
  const model = c.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
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
  return c.json({ projects: projects.results || [], version: APP_VERSION });
});

// v1.17 · 新增项目（原子化：先调 Todoist 建 project 成功，再 INSERT 本地）
// body: { name, emoji, priority, description? }
app.post('/api/projects', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const emoji = String(body.emoji || '').trim() || '📁';
  const priority = body.priority || 'P2';
  const description = String(body.description || '').trim();
  if (!name) return c.json({ error: '项目名称必填' }, 400);
  if (!['P0', 'P1', 'P2', 'continuous'].includes(priority)) {
    return c.json({ error: 'priority must be P0 | P1 | P2 | continuous' }, 400);
  }

  // 生成内部 project_id（用户不可见的稳定标识）
  const projectId = 'proj-' + crypto.randomUUID().slice(0, 8);

  // 排序序号：放到最后（max + 1）
  const maxRow = await c.env.DB.prepare('SELECT MAX(sort_order) as m FROM projects').first();
  const sortOrder = (maxRow?.m ?? 0) + 1;

  // 先建 Todoist project（失败直接返回，本地不写）
  const prioLabel = priority === 'continuous' ? '持续' : priority;
  const todoistName = `[${prioLabel}] ${emoji} ${name}`;
  const color = TODOIST_COLOR_BY_PRIORITY[priority] || 'charcoal';
  const r = await createTodoistProject(c.env, { name: todoistName, color });
  if (!r.ok) {
    return c.json({ error: 'Todoist 建项目失败：' + r.error }, 502);
  }

  // Todoist 成功 → 本地 INSERT
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    'INSERT INTO projects (id, name, emoji, priority, sort_order, created_at, todoist_project_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(projectId, name, emoji, priority, sortOrder, now, r.project_id).run();

  // 可选：如果带了 description，生成一张 profile 卡
  if (description) {
    const profileId = crypto.randomUUID();
    const profileContent = `📋 项目概述：${description}\n\n- 优先级：${prioLabel}\n- 创建于：${now.slice(0, 10)}`;
    await c.env.DB.prepare(
      "INSERT INTO notes (id, project_id, content, card_type, created_at) VALUES (?, ?, ?, 'profile', ?)"
    ).bind(profileId, projectId, profileContent, now).run();
  }

  return c.json({
    id: projectId,
    name,
    emoji,
    priority,
    sort_order: sortOrder,
    created_at: now,
    todoist_project_id: r.project_id,
  });
});

// 最近 N 天各项目的活跃度（main + progress 卡数）
// 前端用此排序 Tab（热门在前）
app.get('/api/project-stats', async (c) => {
  const days = Math.max(1, Math.min(90, parseInt(c.req.query('days') || '7')));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const { results } = await c.env.DB.prepare(
    "SELECT project_id, COUNT(*) as cnt FROM notes " +
    "WHERE card_type IN ('main', 'progress') AND created_at >= ? " +
    "GROUP BY project_id"
  ).bind(cutoff).all();

  const stats = {};
  for (const r of (results || [])) stats[r.project_id] = r.cnt;
  return c.json({ days, stats });
});

// ============================================================
// Notes (main + knowledge + summary + progress)
// ============================================================

app.get('/api/notes', async (c) => {
  const project = c.req.query('project');
  const before = c.req.query('before');
  const q = (c.req.query('q') || '').trim();
  const filter = (c.req.query('filter') || '').trim();  // v1.12
  const limit = Math.min(parseInt(c.req.query('limit') || '30'), 100);

  // v1.11+v1.12+v1.13: 动态 WHERE，q + project + before + filter + archived 过滤
  const where = ['parent_id IS NULL'];
  const binds = [];
  // v1.13: 默认排除已归档（filter=archived 时由 filterToWhere 显式加 archived=1，不过滤默认）
  if (filter !== 'archived') where.push('(archived IS NULL OR archived = 0)');
  if (project && project !== 'all') { where.push('project_id = ?'); binds.push(project); }
  if (q) {
    // LIKE 特殊字符转义：\ → \\，% → \%，_ → \_
    const kw = q.replace(/\\/g, '\\\\').replace(/[%_]/g, m => '\\' + m);
    where.push("content LIKE ? ESCAPE '\\'");
    binds.push('%' + kw + '%');
  }
  if (filter) {
    const f = filterToWhere(filter);
    if (f) {
      where.push('(' + f.sql + ')');
      binds.push(...f.binds);
    }
  }
  if (before) { where.push('created_at < ?'); binds.push(before); }
  // v1.15: filter=todo 时按截止时间排序（紧迫在前，无时间的排最后）
  // v1.25: 进行中（status='in_progress'）置顶
  const orderBy = filter === 'todo'
    ? "ORDER BY CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END ASC, (due_at IS NULL) ASC, due_at ASC, created_at DESC"
    : 'ORDER BY created_at DESC';
  const sql = `SELECT * FROM notes WHERE ${where.join(' AND ')} ${orderBy} LIMIT ?`;
  binds.push(limit);
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

  // v1.15: todo 卡自动抽取 due_at；v1.20: 接受前端显式传入 due_at（任务拆解流程）
  let due_at = null;
  if (card_type === 'main' && tag === 'todo') {
    due_at = body.due_at || parseChineseDatetime(content);
  }

  await c.env.DB.prepare(
    'INSERT INTO notes (id, project_id, content, card_type, parent_id, tag, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, project_id, content, card_type, parentIdFinal, tag, created_at, due_at).run();

  // tag === 'todo' 自动同步 Todoist（v1.15: 带 due_datetime）
  let todoistSync = null;
  if (card_type === 'main' && tag === 'todo') {
    todoistSync = await syncTodoForTodoistTag(c, { noteId: id, projectId: project_id, content, dueAt: due_at });
  }

  return c.json({
    id, project_id, content, card_type, parent_id: parentIdFinal, tag, created_at, due_at,
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

// v1.16 · 跨项目移动：把卡片的 project_id 改为目标
app.post('/api/notes/:id/move', async (c) => {
  const id = c.req.param('id');
  const { target_project_id } = await c.req.json().catch(() => ({}));
  if (!target_project_id) return c.json({ error: 'target_project_id required' }, 400);

  const note = await c.env.DB.prepare('SELECT id, project_id FROM notes WHERE id = ?').bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  if (note.project_id === target_project_id) return c.json({ error: 'already in target project' }, 400);

  const proj = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(target_project_id).first();
  if (!proj) return c.json({ error: 'target project not found' }, 404);

  await c.env.DB.prepare('UPDATE notes SET project_id = ? WHERE id = ? OR parent_id = ?')
    .bind(target_project_id, id, id).run();  // 级联：挂载的 knowledge 子卡也跟着移动

  return c.json({ id, project_id: target_project_id, moved: true });
});

// v1.16 · 跨项目复制：创建新卡，保留内容/tag/due_at，清空 todoist_task_id
// 子 knowledge 卡不跟随复制（简化语义；用户需要的话可以单独复制）
app.post('/api/notes/:id/copy', async (c) => {
  const id = c.req.param('id');
  const { target_project_id } = await c.req.json().catch(() => ({}));
  if (!target_project_id) return c.json({ error: 'target_project_id required' }, 400);

  const src = await c.env.DB.prepare(
    'SELECT content, card_type, tag, due_at, parent_id FROM notes WHERE id = ?'
  ).bind(id).first();
  if (!src) return c.json({ error: 'not found' }, 404);

  const proj = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(target_project_id).first();
  if (!proj) return c.json({ error: 'target project not found' }, 404);

  const newId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await c.env.DB.prepare(
    'INSERT INTO notes (id, project_id, content, card_type, parent_id, tag, due_at, created_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
  ).bind(newId, target_project_id, src.content, src.card_type, src.parent_id, src.tag, src.due_at, createdAt).run();

  return c.json({ id: newId, project_id: target_project_id, content: src.content, card_type: src.card_type, tag: src.tag, due_at: src.due_at, created_at: createdAt, copied_from: id });
});

// v1.13/v1.14 · 归档待办卡（打勾完成）
// - 本地 archived=1 + archived_at 必须成功
// - v1.14: 若原卡是 tag=todo + card_type=main，INSERT 派生 progress 卡（完成时间作为时间戳）
// - Todoist close 失败不回滚本地归档（镜像关系）
app.post('/api/notes/:id/archive', async (c) => {
  const id = c.req.param('id');
  const note = await c.env.DB.prepare(
    "SELECT id, project_id, content, card_type, tag, todoist_task_id, archived, total_seconds, session_start_at FROM notes WHERE id = ?"
  ).bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  if (note.archived) return c.json({ error: 'already archived' }, 409);

  const archivedAt = new Date().toISOString();
  // v1.26: 完成时关闭正在计时的 session，汇总最终用时
  let finalSeconds = note.total_seconds || 0;
  if (note.session_start_at) {
    const elapsed = Math.floor((new Date(archivedAt) - new Date(note.session_start_at)) / 1000);
    const safe = Math.max(0, elapsed);
    finalSeconds += safe;
    // v1.28: 写入 session 日志
    if (safe > 0) {
      await c.env.DB.prepare(
        'INSERT INTO time_sessions (id, note_id, project_id, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), id, note.project_id, note.session_start_at, archivedAt, safe).run();
    }
  }
  await c.env.DB.prepare(
    'UPDATE notes SET archived = 1, archived_at = ?, total_seconds = ?, session_start_at = NULL WHERE id = ?'
  ).bind(archivedAt, finalSeconds, id).run();

  // v1.14: 打勾完成的 todo 卡派生一条 progress 卡，体现"进度推进"语义
  // 原卡保留在归档视图（可还原），派生卡进入时间流作为已完成进展
  let derivedNoteId = null;
  if (note.tag === 'todo' && note.card_type === 'main') {
    derivedNoteId = crypto.randomUUID();
    const derivedContent = '✓ ' + String(note.content || '');
    await c.env.DB.prepare(
      'INSERT INTO notes (id, project_id, content, card_type, parent_id, tag, created_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
    ).bind(derivedNoteId, note.project_id, derivedContent, 'main', null, 'progress', archivedAt).run();
  }

  // Todoist close（仅对已同步的 todo 卡）· 失败仅返回错误 meta，本地归档照常成功
  let todoistClose = null;
  if (note.tag === 'todo' && note.todoist_task_id && c.env.TODOIST_API_TOKEN) {
    try {
      const resp = await fetch(`https://api.todoist.com/api/v1/tasks/${note.todoist_task_id}/close`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.TODOIST_API_TOKEN}` },
      });
      todoistClose = resp.ok
        ? { ok: true }
        : { ok: false, error: `${resp.status}: ${(await resp.text()).slice(0, 160)}` };
    } catch (e) {
      todoistClose = { ok: false, error: e.message || 'network error' };
    }
  }
  return c.json({ id, archived: true, archived_at: archivedAt, derived_note_id: derivedNoteId, todoist_close: todoistClose });
});

// v1.13 · 取消归档（从"已完成"视图点 ↶ 还原）
// 只还原本地状态；不会在 Todoist 端 reopen（如需可手动去 Todoist 重开）
app.post('/api/notes/:id/unarchive', async (c) => {
  const id = c.req.param('id');
  const note = await c.env.DB.prepare('SELECT id, archived FROM notes WHERE id = ?').bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  if (!note.archived) return c.json({ error: 'not archived' }, 409);
  await c.env.DB.prepare('UPDATE notes SET archived = 0, archived_at = NULL WHERE id = ?').bind(id).run();
  return c.json({ id, archived: false });
});

// v1.25 · 待办卡 ⇄ 进行中 状态切换
// v1.26: 同步计时 — 开始时记 session_start_at，暂停时累加 total_seconds
app.post('/api/notes/:id/toggle-status', async (c) => {
  const id = c.req.param('id');
  const note = await c.env.DB.prepare(
    'SELECT id, project_id, tag, card_type, archived, status, total_seconds, session_start_at FROM notes WHERE id = ?'
  ).bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  if (note.tag !== 'todo' || note.card_type !== 'main') {
    return c.json({ error: 'only todo main cards support status toggle' }, 400);
  }
  if (note.archived) return c.json({ error: 'cannot toggle archived card' }, 409);

  const now = new Date().toISOString();
  const current = note.status || 'todo';
  const next = current === 'in_progress' ? 'todo' : 'in_progress';

  let newTotalSeconds = note.total_seconds || 0;
  let newSessionStart = null;
  if (next === 'in_progress') {
    newSessionStart = now;
  } else if (note.session_start_at) {
    const elapsed = Math.floor((new Date(now) - new Date(note.session_start_at)) / 1000);
    const safe = Math.max(0, elapsed);
    newTotalSeconds += safe;
    // v1.28: 写入 session 日志供图表聚合
    if (safe > 0) {
      await c.env.DB.prepare(
        'INSERT INTO time_sessions (id, note_id, project_id, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), id, note.project_id, note.session_start_at, now, safe).run();
    }
  }

  await c.env.DB.prepare(
    'UPDATE notes SET status = ?, updated_at = ?, total_seconds = ?, session_start_at = ? WHERE id = ?'
  ).bind(next, now, newTotalSeconds, newSessionStart, id).run();
  return c.json({ id, status: next, updated_at: now, total_seconds: newTotalSeconds, session_start_at: newSessionStart });
});

// v1.26.1 · 过期任务重设截止时间
app.post('/api/notes/:id/reschedule', async (c) => {
  const id = c.req.param('id');
  const { due_at } = await c.req.json().catch(() => ({}));
  if (!due_at) return c.json({ error: 'due_at required' }, 400);
  const note = await c.env.DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  const updated_at = new Date().toISOString();
  await c.env.DB.prepare('UPDATE notes SET due_at = ?, updated_at = ?, status = ? WHERE id = ?')
    .bind(due_at, updated_at, 'todo', id).run();
  return c.json({ id, due_at, updated_at });
});

// v1.28 · 图表用时数据（按日期 × 项目聚合，UTC+8）
app.get('/api/stats/time-chart', async (c) => {
  const period  = c.req.query('period')  || 'week'; // today|week|month|3month|year
  const project = c.req.query('project') || 'all';  // all|<project_id>
  const nowTs   = Date.now();
  const cstDay  = (ts) => new Date(ts + 8 * 3600000).toISOString().slice(0, 10);
  const todayCST = cstDay(nowTs);

  // 周期 → 天数 / 分组粒度
  const PERIOD_DAYS = { today: 1, week: 7, month: 30, '3month': 90, year: 365 };
  const days = PERIOD_DAYS[period] || 7;
  const cutoffTs = nowTs - days * 86400000;
  const cutoff = new Date(cutoffTs).toISOString();

  // 项目过滤 WHERE 片段
  const projFilter = project !== 'all' ? `AND project_id = '${project.replace(/'/g, "''")}'` : '';

  // ① time_sessions（精确：v1.28+ 记录的）
  let sessRows = [];
  try {
    sessRows = (await c.env.DB.prepare(`
      SELECT date(datetime(ended_at, '+8 hours')) AS day,
             project_id, note_id, SUM(duration_seconds) AS seconds
      FROM time_sessions
      WHERE ended_at >= ? ${projFilter}
      GROUP BY day, project_id, note_id
    `).bind(cutoff).all()).results || [];
  } catch (_) {}

  // ② 遗留数据：notes.total_seconds（不依赖 time_sessions 表是否存在）
  // 当 time_sessions 积累足够后可能轻微重复计算，但量级可忽略
  let legacyRows = [];
  try {
    legacyRows = (await c.env.DB.prepare(`
      SELECT
        COALESCE(date(datetime(archived_at, '+8 hours')),
                 date(datetime(updated_at,  '+8 hours')), ?) AS day,
        project_id, id AS note_id, total_seconds AS seconds
      FROM notes
      WHERE card_type = 'main' AND tag = 'todo'
        AND total_seconds > 0 AND session_start_at IS NULL
        ${projFilter}
    `).bind(todayCST).all()).results || [];
  } catch (_) {}

  // ③ 当前正在计时（实时 elapsed）
  const activeRows = (await c.env.DB.prepare(
    `SELECT project_id, id AS note_id, session_start_at FROM notes
     WHERE session_start_at IS NOT NULL AND card_type='main' AND tag='todo' ${projFilter}`
  ).all()).results || [];

  // 合并：byDay[day][project_id] = seconds
  const byDay = {};
  const noteSeconds = {}; // note_id → seconds（用于任务明细）
  const addRow = (day, pid, nid, secs) => {
    if (!day || secs <= 0) return;
    (byDay[day] ||= {})[pid] = ((byDay[day][pid] || 0)) + secs;
    if (nid) noteSeconds[nid] = (noteSeconds[nid] || 0) + secs;
  };
  for (const r of sessRows)   addRow(r.day, r.project_id, r.note_id, r.seconds);
  for (const r of legacyRows) addRow(r.day, r.project_id, r.note_id, r.seconds);
  for (const a of activeRows) {
    const elapsed = Math.floor((nowTs - new Date(a.session_start_at).getTime()) / 1000);
    addRow(todayCST, a.project_id, a.note_id, elapsed);
  }

  // 生成日期标签（连续）
  const dateLabels = [];
  for (let i = days - 1; i >= 0; i--)
    dateLabels.push(cstDay(nowTs - i * 86400000));

  // 分组聚合（year→月, 3month→周, 其余→日）
  let labels, groupedByDay;
  if (period === 'year') {
    // 按月聚合
    const byMonth = {};
    for (const [d, pmap] of Object.entries(byDay)) {
      const m = d.slice(0, 7);
      for (const [pid, s] of Object.entries(pmap))
        ((byMonth[m] ||= {})[pid] = (byMonth[m][pid] || 0) + s);
    }
    const months = [...new Set(dateLabels.map(d => d.slice(0, 7)))];
    labels = months.map(m => m.slice(5) + '月');
    groupedByDay = Object.fromEntries(months.map((m, i) => [labels[i], byMonth[m] || {}]));
  } else if (period === '3month') {
    // 按周聚合（ISO 周一起）
    const byWeek = {};
    for (const [d, pmap] of Object.entries(byDay)) {
      const dt = new Date(d + 'T12:00:00+08:00');
      const mon = new Date(dt); mon.setDate(dt.getDate() - (dt.getDay() || 7) + 1);
      const wk = mon.toISOString().slice(0, 10);
      for (const [pid, s] of Object.entries(pmap))
        ((byWeek[wk] ||= {})[pid] = (byWeek[wk][pid] || 0) + s);
    }
    const weeks = [...new Set(dateLabels.map(d => {
      const dt = new Date(d + 'T12:00:00+08:00');
      const mon = new Date(dt); mon.setDate(dt.getDate() - (dt.getDay() || 7) + 1);
      return mon.toISOString().slice(0, 10);
    }))];
    labels = weeks.map(w => w.slice(5).replace('-', '/'));
    groupedByDay = Object.fromEntries(weeks.map((w, i) => [labels[i], byWeek[w] || {}]));
  } else {
    labels = dateLabels;
    groupedByDay = byDay;
  }

  // 项目信息
  const allProjects = (await c.env.DB.prepare('SELECT id, name, emoji, sort_order FROM projects ORDER BY sort_order').all()).results || [];
  const projMap = Object.fromEntries(allProjects.map(p => [p.id, { name: p.name, emoji: p.emoji || '📁' }]));

  // 涉及的项目 & 总用时
  const usedPids = [...new Set([
    ...sessRows.map(r => r.project_id),
    ...legacyRows.map(r => r.project_id),
    ...activeRows.map(r => r.project_id),
  ])];
  const projectTotals = {};
  for (const pid of usedPids) {
    projectTotals[pid] = Object.values(byDay).reduce((s, pmap) => s + (pmap[pid] || 0), 0);
  }

  // 任务明细（单项目模式）
  let tasks = [];
  if (project !== 'all' && Object.keys(noteSeconds).length) {
    const nids = Object.keys(noteSeconds).slice(0, 30);
    const ph = nids.map(() => '?').join(',');
    const notesInfo = (await c.env.DB.prepare(
      `SELECT id, content FROM notes WHERE id IN (${ph})`
    ).bind(...nids).all()).results || [];
    tasks = notesInfo
      .map(n => ({ id: n.id, content: n.content, seconds: noteSeconds[n.id] || 0 }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  return c.json({ period, labels, groupedByDay, projectTotals, projects: projMap, allProjects, tasks });
});

// v1.26 · 用时统计（按项目分组，仅 tag=todo 有计时记录的卡）
app.get('/api/stats/time', async (c) => {
  const period = c.req.query('period') || 'all';
  let extra = '';
  const binds = [];
  if (period === 'week') {
    extra = " AND (n.archived_at >= ? OR n.archived = 0)";
    binds.push(new Date(Date.now() - 7 * 86400000).toISOString());
  } else if (period === 'month') {
    extra = " AND (n.archived_at >= ? OR n.archived = 0)";
    binds.push(new Date(Date.now() - 30 * 86400000).toISOString());
  }
  const sql = `
    SELECT n.id, n.project_id, n.content, n.total_seconds, n.session_start_at,
           n.status, n.archived, n.archived_at, n.created_at,
           p.name as project_name, p.emoji as project_emoji, p.sort_order
    FROM notes n
    LEFT JOIN projects p ON n.project_id = p.id
    WHERE n.card_type = 'main' AND n.tag = 'todo'
      AND (n.total_seconds > 0 OR n.session_start_at IS NOT NULL)
      ${extra}
    ORDER BY p.sort_order ASC, n.total_seconds DESC, n.created_at DESC
  `;
  const rows = (await c.env.DB.prepare(sql).bind(...binds).all()).results || [];
  const map = {};
  for (const r of rows) {
    if (!map[r.project_id]) {
      map[r.project_id] = {
        project_id: r.project_id,
        project_name: r.project_name || r.project_id,
        project_emoji: r.project_emoji || '📁',
        sort_order: r.sort_order ?? 999,
        total_seconds: 0,
        tasks: [],
      };
    }
    map[r.project_id].total_seconds += r.total_seconds || 0;
    map[r.project_id].tasks.push({
      id: r.id,
      content: r.content,
      total_seconds: r.total_seconds || 0,
      session_start_at: r.session_start_at || null,
      status: r.status || 'todo',
      archived: r.archived,
      archived_at: r.archived_at,
    });
  }
  const projects = Object.values(map).sort((a, b) => b.total_seconds - a.total_seconds);
  return c.json({ projects, period });
});

// 重试 Todoist 同步（卡片上的 ⚠️ 失败重试按钮调这个）
app.post('/api/notes/:id/retry-todoist', async (c) => {
  const id = c.req.param('id');
  const note = await c.env.DB.prepare(
    'SELECT id, project_id, content, tag, todoist_task_id, due_at FROM notes WHERE id = ?'
  ).bind(id).first();
  if (!note) return c.json({ error: 'not found' }, 404);
  if (note.tag !== 'todo') return c.json({ error: 'not a todo card' }, 400);
  if (note.todoist_task_id) return c.json({ error: 'already synced', task_id: note.todoist_task_id }, 409);
  const r = await syncTodoForTodoistTag(c, { noteId: id, projectId: note.project_id, content: note.content, dueAt: note.due_at });
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
  const { project_id, content, source, source_ref, override_created_at } = body;
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
  // override_created_at 用于迁移历史数据（保留原日期）。格式 ISO8601 或 YYYY-MM-DD
  let created_at = new Date().toISOString();
  if (override_created_at && /^\d{4}-\d{2}-\d{2}/.test(override_created_at)) {
    const iso = override_created_at.length === 10
      ? `${override_created_at}T12:00:00.000Z`   // 只给日期时默认中午 UTC
      : override_created_at;
    if (!Number.isNaN(new Date(iso).getTime())) created_at = iso;
  }

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
    const raw = await callLLM(c, { system, user, temperature: 0.1, max_tokens: 1500 });
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
// AI: split tasks (v1.21 — GTD coach persona + physical-action constraints)
// ============================================================

app.post('/api/ai/split-tasks', async (c) => {
  const { text, project_name } = await c.req.json().catch(() => ({}));
  if (!text?.trim()) return c.json({ error: 'text required' }, 400);
  if (text.length > 3000) return c.json({ error: '文本过长（>3000 字）' }, 400);

  const system = `你是一位有10年经验的GTD执行教练，专门帮助项目经理把混乱输入转为可立即行动的任务清单。
你的拆解原则：
1. 每条任务必须以具体动词开头，代表一个「下一步物理行动」——做完它，事情就向前推进
2. 3-6条为宜；一件简单的事不要为拆解而拆解
3. 禁止使用以下模糊动词作为开头：了解、研究、考虑、评估、跟进、关注、确认思路（若无法避免，必须在动词后补充具体的行动对象和完成标准）
4. 任务之间保持独立，不要有隐含的依赖序列
5. 只输出JSON数组，不加任何解释`;

  const projectLine = project_name ? `项目背景：${project_name}\n\n` : '';
  const user = `${projectLine}待拆解的内容：
${text}

请输出格式：["任务1", "任务2", "任务3"]`;

  try {
    const raw = await callLLM(c, { system, user, temperature: 0.3, max_tokens: 800 });
    const match = String(raw).match(/\[[\s\S]*?\]/);
    if (!match) return c.json({ error: 'LLM 返回格式错误' }, 500);
    let tasks;
    try { tasks = JSON.parse(match[0]); }
    catch { return c.json({ error: '解析失败' }, 500); }
    if (!Array.isArray(tasks)) return c.json({ error: '非数组' }, 500);
    return c.json({ tasks: tasks.filter(t => typeof t === 'string' && t.trim()) });
  } catch (e) {
    return c.json({ error: e.message || '拆解失败' }, 502);
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
    const reply = await callLLM(c, { messages: llmMessages, temperature: 0.5, max_tokens: 1500 });
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
    tag_filter = 'all',           // 'all' | 'todo' | 'progress' | 'idea' | 'milestone'
    generate_suggestion = true,
  } = body;
  const days = timeRange === '30d' ? 30 : timeRange === 'all' ? 3650 : 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // 永远排除 summary 和 suggestion（避免 AI 总结 AI 的产出）
  const allowed = ['main'];
  if (include_progress) allowed.push('progress');
  if (include_knowledge) allowed.push('knowledge');
  const placeholders = allowed.map(() => '?').join(',');

  // 进展 tag 包含里程碑（里程碑是进展的关键子集）
  const tagFilterTags = tag_filter === 'progress' ? ['progress', 'milestone'] : (tag_filter && tag_filter !== 'all' ? [tag_filter] : []);
  const tagCondition = tagFilterTags.length > 0
    ? ` AND tag IN (${tagFilterTags.map(() => '?').join(',')})`
    : '';

  // v1.13: summarize 默认排除已归档（已完成的待办不需要再进 AI 总结）
  const archivedFilter = ' AND (archived IS NULL OR archived = 0)';

  let sql, binds;
  if (project === 'all') {
    sql = `SELECT * FROM notes WHERE created_at >= ? AND card_type IN (${placeholders})${tagCondition}${archivedFilter} ORDER BY created_at ASC LIMIT 500`;
    binds = tagFilterTags.length > 0 ? [cutoff, ...allowed, ...tagFilterTags] : [cutoff, ...allowed];
  } else {
    sql = `SELECT * FROM notes WHERE created_at >= ? AND project_id = ? AND card_type IN (${placeholders})${tagCondition}${archivedFilter} ORDER BY created_at ASC LIMIT 500`;
    binds = tagFilterTags.length > 0 ? [cutoff, project, ...allowed, ...tagFilterTags] : [cutoff, project, ...allowed];
  }
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();

  if (!results || !results.length) {
    return c.json({ error: '所选范围内没有数据（检查 tag / 项目 / 时间）' }, 400);
  }

  const tagLabel = { todo: '[待办]', progress: '[进展]', idea: '[想法]', milestone: '[🏁里程碑]' };
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

  // v1.16.11 · 精简但保留信息量 + 禁用表格（移动端卡片宽度有限，表格会横向溢出）
  const systemPrompt = `你是项目进展整理助手。输出中文 Markdown，保留原文数字/人名/日期/专业词等具体细节。

格式规则：
- 用 ## 二级标题分节
- 节内用无序列表 -（有明确顺序时用有序列表 1./2.）
- 列表项可嵌套子列表补充细节（"发生了什么" → 子级列"涉及的人/数字/影响"）
- **禁止使用 Markdown 表格**（| 列 | 列 | 格式会在移动端溢出卡片宽度）${profileContext ? '\n\n' + profileContext : ''}

[里程碑规则] 记录含 [🏁里程碑] 时：以最新里程碑为叙事主线；之前进展 demote 为"通向里程碑的过程"；保留未被覆盖的瓶颈/风险/遗留决策；多里程碑按时间线 M1→M2→M3。无里程碑按时间线整理。`;

  const summaryPrompt = `「${project === 'all' ? '全部项目' : project}」近 ${days} 天（${parts.join('+')}${tagTagStr}）：

## 关键进展
3-6 条要点。每条包含：**具体做了什么** · 涉及的数字/人物/日期 · 1-2 句背景或影响。重要事项用嵌套子列表展开。

## 待办和风险
从未完成事项识别。按紧迫度排，标注"必须尽快 / 潜在风险 / 已阻塞"等。

## 决策与洞察
关键决策（谁决定 / 为什么 / 影响范围） · 认知更新（原以为 X，现在发现 Y） · 值得记住的观察。

---

${lines}`;

  try {
    const summary = await callLLM(c, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: summaryPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1200,
    });

    let suggestion = null;
    if (generate_suggestion) {
      const suggestionPrompt = `基于下方摘要列 3-5 条**下一步建议**。每条包含：具体动作（做什么）+ 可判断时的负责人/时间节点/约束。用"- " 开头，不重复摘要内容，按紧迫度区分"必须做"与"可以做"。不要用表格。

${summary}`;

      try {
        suggestion = await callLLM(c, {
          messages: [{ role: 'user', content: suggestionPrompt }],
          temperature: 0.5,
          max_tokens: 600,
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
// Suggest — v1.18: 按需生成建议，基于已有 summary 文本，单次 LLM 调用
// ============================================================

app.post('/api/suggest', async (c) => {
  const { summary } = await c.req.json().catch(() => ({}));
  if (!summary || typeof summary !== 'string' || !summary.trim()) {
    return c.json({ error: '缺少 summary 文本' }, 400);
  }
  const prompt = `基于下方摘要列 3-5 条**下一步建议**。每条包含：具体动作（做什么）+ 可判断时的负责人/时间节点/约束。用"- " 开头，不重复摘要内容，按紧迫度区分"必须做"与"可以做"。不要用表格。\n\n${summary.slice(0, 4000)}`;
  try {
    const suggestion = await callLLM(c, {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 600,
    });
    return c.json({ suggestion });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});

// ============================================================
// Static fallback
// ============================================================

// v1.16.1: 对 HTML/JS/CSS/sw.js 强制 private + no-store，阻止运营商透明代理缓存
// （5G 下用户报告看到旧版，CF 默认的 public+must-revalidate 允许了中间代理保留副本）
// 图片/manifest 保持默认（可缓存，节省流量）
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const p = new URL(c.req.url).pathname;
  const needNoStore = p === '/' || p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css');
  if (!needNoStore) return res;
  const h = new Headers(res.headers);
  h.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  h.set('Pragma', 'no-cache');
  h.set('Expires', '0');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
});

export default app;
