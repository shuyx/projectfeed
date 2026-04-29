// ============================================================
// projectfeed app.js — v1.9 · progress cards (Obsidian-sourced) also collapsible
// ============================================================

// ---------- Emoji pool & hashing ----------
const EMOJI_POOL = [
  '🦊', '🐯', '🦁', '🐻', '🐼', '🐨', '🐶', '🐱', '🦖', '🦄',
  '🐸', '🐵', '🦉', '🐧', '🐢', '🦋', '🌸', '🌈', '⭐', '🍀',
  '🔥', '💎', '🍊', '🍇', '🌊', '🌙', '☘️', '🌼', '🎯', '🎨'
];

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

function emojiForName(name, offset = 0) {
  const h = hashName(String(name || 'x'));
  return EMOJI_POOL[(h + offset) % EMOJI_POOL.length];
}

// ---------- State ----------
const state = {
  projects: [],
  projectStats: {},  // { project_id: count } · 近 7 天活跃卡数 · 用于 Tab 排序
  people: [],        // kept as empty array for highlight compat
  currentTab: 'all',
  notes: [],
  hasMore: false,
  loading: false,
  searchQuery: '',   // v1.11 · 搜索关键词，非空时 loadFeed 走 q 查询
  activeFilter: '',  // v1.12 · '' | 'todo' | 'progress' | 'idea' | 'milestone' | 'feedback' | 'summary' | 'time'
  viewMode: (typeof localStorage !== 'undefined' && localStorage.getItem('pf-view-mode') === 'timeline') ? 'timeline' : 'project',  // v1.27 · 默认项目分组，仅在「全部」tab 生效
  timePeriod: 'all',       // v1.26 · 用时统计周期
  timeView: 'list',        // v1.28 · 'list' | 'chart'
  timeChartPeriod: 'week', // v1.28 · 图表周期
  expandedStacks: new Set(), // v1.30 · 已展开的项目堆叠（project_id 集合）
};

// ---------- Feed Cache ----------
// v1.18: tab+filter+search 维度的短时缓存，切 tab 秒出
const _feedCache = new Map();
const FEED_CACHE_TTL = 20_000;
function _feedCacheKey() { return `${state.currentTab}|${state.activeFilter}|${state.searchQuery}|${state.viewMode}`; }
function invalidateFeedCache() { _feedCache.clear(); }

// v1.12/v1.13 · filter chip 定义（UI 7 维，Option 2 映射到后端 WHERE）
const FILTER_CHIPS = [
  { key: 'todo',       icon: '🎯', label: '待办' },
  { key: 'progress',   icon: '✅', label: '进展' },
  { key: 'idea',       icon: '💡', label: '想法' },
  { key: 'milestone',  icon: '🏁', label: '里程碑' },
  { key: 'feedback',   icon: '📥', label: '反馈' },
  { key: 'summary',    icon: '🤖', label: '总结' },
  { key: 'archived',   icon: '📦', label: '已完成' },
  { key: 'time',       icon: '⏱', label: '用时' },   // v1.26 · 用时统计
];

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, isError = false, action = null) {
  // v1.13: 支持带 Undo 按钮的 toast。action = { label, onClick, timeoutMs }
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.innerHTML = '';
  el.appendChild(document.createTextNode(msg));
  if (action && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = action.label || '撤销';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      el.className = 'toast';
      action.onClick();
    });
    el.appendChild(btn);
  }
  el.className = 'toast show' + (isError ? ' error' : '');
  const dur = action?.timeoutMs || 3000;
  toastTimer = setTimeout(() => { el.className = 'toast'; }, dur);
}

// ---------- API ----------
// v1.16.4/v1.16.7: 端点级超时 · CRUD 默认 8s，LLM 调用（summarize/chat/correct）60s
const API_TIMEOUT_MS = 8000;
const LLM_TIMEOUT_MS = 60000;
async function api(path, opts = {}) {
  const { timeoutMs = API_TIMEOUT_MS, ...fetchOpts } = opts;
  const headers = { 'Content-Type': 'application/json' };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(path, {
      ...fetchOpts,
      headers: { ...headers, ...(fetchOpts.headers || {}) },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || resp.statusText);
    }
    return resp.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      const secs = Math.round(timeoutMs / 1000);
      throw new Error(`网络超时（${secs}s），请检查连接或切换到 WiFi`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadConfig() {
  // v1.18: config 和 project-stats 真正并行（原来是串行，尽管注释写"并发"）
  const [data, statsResult] = await Promise.all([
    api('/api/config'),
    api('/api/project-stats?days=7').catch(() => null),
  ]);
  state.projects = data.projects || [];
  state.people = [];
  state.projectStats = (statsResult && statsResult.stats) || {};
  // v1.26.1: 自动更新设置页版本号
  if (data.version) {
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${data.version}`;
  }
}

async function loadFeed(append = false) {
  if (state.loading) return;
  // v1.18: 短时缓存（20s TTL），切 tab 秒出；写操作调 invalidateFeedCache() 失效
  if (!append) {
    const hit = _feedCache.get(_feedCacheKey());
    if (hit && Date.now() - hit.ts < FEED_CACHE_TTL) {
      state.notes = hit.notes;
      state.hasMore = hit.hasMore;
      return;
    }
  }
  state.loading = true;
  try {
    const params = new URLSearchParams();
    if (state.currentTab !== 'all') params.set('project', state.currentTab);
    const searching = !!state.searchQuery;
    const filtering = !!state.activeFilter;
    // v1.27: 项目分组视图（全部 tab）拉更多数据，其余逻辑不变
    const projectViewActive = state.currentTab === 'all' && state.viewMode === 'project' && !searching;
    const narrowing = searching || filtering;
    params.set('limit', projectViewActive ? '200' : (narrowing ? '100' : '30'));
    if (searching) params.set('q', state.searchQuery);
    if (filtering) params.set('filter', state.activeFilter);
    if (append && state.notes.length > 0) {
      params.set('before', state.notes[state.notes.length - 1].created_at);
    }
    const data = await api('/api/notes?' + params.toString());
    const fresh = data.notes || [];
    const hasMore = narrowing ? false : !!data.hasMore;
    state.notes = append ? [...state.notes, ...fresh] : fresh;
    state.hasMore = hasMore;
    if (!append) {
      _feedCache.set(_feedCacheKey(), { notes: fresh, hasMore, ts: Date.now() });
    }
  } finally {
    state.loading = false;
  }
}

async function postNote(project_id, content, tag, due_at = null) {
  const payload = { project_id, content, tag };
  if (due_at) payload.due_at = due_at;
  return api('/api/notes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function retryTodoistSync(noteId) {
  return api(`/api/notes/${noteId}/retry-todoist`, { method: 'POST' });
}

// v1.13
async function archiveNote(noteId) {
  return api(`/api/notes/${noteId}/archive`, { method: 'POST' });
}
async function unarchiveNote(noteId) {
  return api(`/api/notes/${noteId}/unarchive`, { method: 'POST' });
}

// v1.25
async function toggleNoteStatus(noteId) {
  return api(`/api/notes/${noteId}/toggle-status`, { method: 'POST' });
}

// v1.29
async function scheduleNote(noteId, dueAt, durationMinutes) {
  return api(`/api/notes/${noteId}/schedule`, {
    method: 'POST',
    body: JSON.stringify({ due_at: dueAt, duration_minutes: durationMinutes }),
  });
}

// v1.16
async function moveNote(noteId, targetProjectId) {
  return api(`/api/notes/${noteId}/move`, {
    method: 'POST',
    body: JSON.stringify({ target_project_id: targetProjectId }),
  });
}
async function copyNote(noteId, targetProjectId) {
  return api(`/api/notes/${noteId}/copy`, {
    method: 'POST',
    body: JSON.stringify({ target_project_id: targetProjectId }),
  });
}

async function deleteNote(id) {
  return api(`/api/notes/${id}`, { method: 'DELETE' });
}

async function updateNote(id, content) {
  return api(`/api/notes/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

async function correctText(text) {
  return api('/api/ai/correct', {
    method: 'POST',
    body: JSON.stringify({ text }),
    timeoutMs: LLM_TIMEOUT_MS,
  });
}

async function splitTasks(text, projectName = '') {
  return api('/api/ai/split-tasks', {
    method: 'POST',
    body: JSON.stringify({ text, project_name: projectName }),
    timeoutMs: LLM_TIMEOUT_MS,
  });
}

// 计算任务截止时间（本地时间 UTC+8）
function calcTaskDueDate(option) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00+08:00`;

  if (option === 'today') {
    const d10 = new Date(now.getTime() + 10 * 60 * 1000); // 当前时间 +10 分钟，避免立即过期
    return toISO(d10);
  }

  // 以下选项统一用 09:00
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);

  if (option === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    return toISO(d);
  }
  if (option === 'thisweek') {
    const dow = d.getDay(); // 0=Sun,1=Mon,...,6=Sat
    if (dow === 1 || dow === 2) {
      d.setDate(d.getDate() + (3 - dow)); // 周一/周二 → 本周三
    } else {
      const daysToFri = dow <= 5 ? (5 - dow) : (5 + 7 - dow); // 周三以后 → 本周五
      d.setDate(d.getDate() + daysToFri);
    }
    return toISO(d);
  }
  if (option === 'nextweek') {
    const dow = d.getDay();
    d.setDate(d.getDate() + (dow === 0 ? 1 : 8 - dow)); // → 下周一
    return toISO(d);
  }
  return toISO(now);
}

async function summarize(timeRange, project, include_progress, include_knowledge) {
  return api('/api/summarize', {
    method: 'POST',
    body: JSON.stringify({ timeRange, project, include_progress, include_knowledge }),
    timeoutMs: LLM_TIMEOUT_MS,  // v1.16.7: 一键整理涉及两轮 LLM（summary + suggestion），可能 20-45s
  });
}

async function fetchChatHistory(parentNoteId) {
  return api(`/api/chat/${encodeURIComponent(parentNoteId)}`);
}

async function sendChat(parentNoteId, message, history) {
  return api('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ parent_note_id: parentNoteId, message, history }),
    timeoutMs: LLM_TIMEOUT_MS,  // v1.16.7: 问 AI 流式回答，10-30s
  });
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function $(id) { return document.getElementById(id); }

// ---------- Tabs (sorted by P0/P1/P2/持续 · priority shown as dot prefix) ----------
const PRIORITY_ORDER = { P0: 1, P1: 2, P2: 3, continuous: 4 };

function renderTabs() {
  const el = $('project-tabs');
  if (!el) return;
  // v1.7 排序：近 7 天活跃度降序 → tie-break 优先级 → tie-break sort_order
  const stats = state.projectStats || {};
  const sorted = [...state.projects].sort((a, b) => {
    const ca = stats[a.id] || 0;
    const cb = stats[b.id] || 0;
    if (ca !== cb) return cb - ca;  // 活跃度高的在前
    const pa = PRIORITY_ORDER[a.priority || 'P2'] || 5;
    const pb = PRIORITY_ORDER[b.priority || 'P2'] || 5;
    if (pa !== pb) return pa - pb;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
  let html = `<button class="tab${state.currentTab === 'all' ? ' active' : ''}" role="tab" data-id="all">全部</button>`;
  for (const p of sorted) {
    const active = p.id === state.currentTab ? ' active' : '';
    const prio = p.priority || 'P2';
    const dot = `<span class="tab-prio-dot prio-${prio}" title="${prio === 'continuous' ? '持续' : prio}"></span>`;
    const cnt = stats[p.id] || 0;
    const badge = cnt > 0 ? `<span class="tab-count-badge" title="近 7 天 ${cnt} 条">${cnt}</span>` : '';
    const label = (p.emoji ? p.emoji + ' ' : '') + escapeHtml(p.name);
    html += `<button class="tab${active}" role="tab" data-id="${escapeHtml(p.id)}">${dot}${label}${badge}</button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.currentTab = btn.dataset.id;
      renderTabs();
      if (state.searchQuery) updateSearchScope();
      // v1.16.10: 立即显示 loading 消除"点击无反应"体感（原本要等 loadFeed 完 renderFeed 才刷屏）
      const feed = $('feed');
      if (feed) {
        feed.innerHTML = '<div class="empty-state" style="min-height:200px"><div class="spinner"></div><p class="muted small" style="margin-top:10px">加载中…</p></div>';
      }
      await refresh();
    });
  });
}

// ---------- Feed ----------
function formatDateLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const ymd = (x) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
  const td = ymd(now);
  const yd = ymd(new Date(Date.now() - 86400000));
  const dmd = ymd(d);
  if (dmd === td) return '今天';
  if (dmd === yd) return '昨天';
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatCardDateTime(iso) {
  const d = new Date(iso);
  const time = formatTime(iso);
  const now = new Date();
  const ymd = (x) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
  const td = ymd(now);
  const yd = ymd(new Date(Date.now() - 86400000));
  const dmd = ymd(d);
  if (dmd === td) return `今天 · ${time}`;
  if (dmd === yd) return `昨天 · ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return `${datePart} · ${time}`;
}

function groupNotesByDate(notes) {
  const groups = [];
  let cur = null;
  for (const n of notes) {
    const label = formatDateLabel(n.created_at);
    if (!cur || cur.label !== label) {
      cur = { label, notes: [] };
      groups.push(cur);
    }
    cur.notes.push(n);
  }
  return groups;
}

// v1.15: 计算 todo 卡紧急度等级（基于 due_at 与当前时间差）
function computeUrgency(dueAt) {
  if (!dueAt) return 'none';
  const due = new Date(dueAt);
  if (isNaN(due.getTime())) return 'none';
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = diffMs / 86400000;
  // 已过期：归到 today（最紧迫视觉）
  if (diffDays < 0) return 'today';
  // 今天内：到今日 23:59 为止
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  if (due <= endOfToday) return 'today';
  const endOfTomorrow = new Date(endOfToday.getTime() + 86400000);
  if (due <= endOfTomorrow) return 'tomorrow';
  if (diffDays <= 3) return '3d';
  if (diffDays <= 7) return '1w';
  return 'later';
}

// v1.15: 友好显示 due_at（卡片 foot 用）
function formatDueAt(dueAt) {
  if (!dueAt) return '';
  const due = new Date(dueAt);
  if (isNaN(due.getTime())) return '';
  const now = new Date();
  const ymd = (x) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
  const time = `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
  const todayStr = ymd(now);
  const tomorrowStr = ymd(new Date(now.getTime() + 86400000));
  const dueStr = ymd(due);
  const urgency = computeUrgency(dueAt);
  const icon = urgency === 'today' ? '⏰' : urgency === 'tomorrow' ? '🔥' : urgency === '3d' ? '⚡' : urgency === '1w' ? '📅' : '🗓';
  let datePart;
  if (dueStr === todayStr) datePart = '今天';
  else if (dueStr === tomorrowStr) datePart = '明天';
  else {
    const sameYear = due.getFullYear() === now.getFullYear();
    datePart = sameYear ? `${due.getMonth() + 1}月${due.getDate()}日` : `${due.getFullYear()}年${due.getMonth() + 1}月${due.getDate()}日`;
  }
  // 已过期：只显示日期，不显示时间
  if (due < now) return `${icon} 已过期 ${datePart}`;
  return `${icon} ${datePart} ${time}`;
}

// v1.26.1 · 过期任务重设截止时间
async function rescheduleNote(noteId, dueAt) {
  return api(`/api/notes/${noteId}/reschedule`, {
    method: 'POST',
    body: JSON.stringify({ due_at: dueAt }),
  });
}

function _toCSTIso(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00+08:00`;
}

function _getRescheduleOptions() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun 1=Mon...6=Sat
  const at = (base, h, m) => { const d = new Date(base); d.setHours(h, m, 0, 0); return d; };
  const addDays = n => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
  const toFri = (5 - day + 7) % 7; // 0 if today is Friday
  const toMon = (1 - day + 7) % 7 || 7; // days to next Monday (≥1)
  return [
    { key: 'today',    label: '今天',   d: at(now, 18, 0) },
    { key: 'tomorrow', label: '明天',   d: at(addDays(1), 18, 0) },
    { key: 'thisweek', label: '本周内', d: at(addDays(toFri), 18, 0) },
    { key: 'nextweek', label: '下周',   d: at(addDays(toMon), 9, 0) },
  ];
}

function _fmtRspDate(d) {
  const day = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
  const p = n => String(n).padStart(2, '0');
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let _rspPopup = null;
function dismissReschedulePopup() {
  if (_rspPopup) { _rspPopup.remove(); _rspPopup = null; }
}

function showReschedulePopup(noteId, anchorEl) {
  dismissReschedulePopup();
  const opts = _getRescheduleOptions();

  const popup = document.createElement('div');
  popup.className = 'reschedule-popup';
  popup.innerHTML = `
    <div class="rsp-title">重设截止时间</div>
    ${opts.map(o => `
      <button class="rsp-btn" data-key="${o.key}">
        <span class="rsp-label">${o.label}</span>
        <span class="rsp-date">${_fmtRspDate(o.d)}</span>
      </button>`).join('')}
  `;
  document.body.appendChild(popup);
  _rspPopup = popup;

  // 定位：锚点正下方，避免超出屏幕
  const rect = anchorEl.getBoundingClientRect();
  const pw = 172;
  let left = rect.left;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${rect.bottom + 6}px`;

  popup.querySelectorAll('.rsp-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const opt = opts.find(o => o.key === btn.dataset.key);
      if (!opt) return;
      dismissReschedulePopup();
      try {
        const isoStr = _toCSTIso(opt.d);
        await rescheduleNote(noteId, isoStr);
        const note = state.notes.find(x => x.id === noteId);
        if (note) { note.due_at = isoStr; note.updated_at = new Date().toISOString(); }
        invalidateFeedCache();
        renderFeed();
        toast(`已重设为 ${opt.label}`);
      } catch (err) {
        toast('更新失败：' + err.message, true);
      }
    });
  });

  setTimeout(() => document.addEventListener('click', dismissReschedulePopup, { once: true }), 0);
}

// v1.28 · Chart.js 懒加载，多 CDN 顺序回退
let _chartJsReady = false;
async function loadChartJs() {
  if (_chartJsReady || window.Chart) { _chartJsReady = true; return; }
  const CDNS = [
    'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
    'https://unpkg.com/chart.js@4.4.4/dist/chart.umd.min.js',
  ];
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    const t = setTimeout(() => { s.remove(); rej(new Error('timeout')); }, 8000);
    s.onload = () => { clearTimeout(t); _chartJsReady = true; res(); };
    s.onerror = (e) => { clearTimeout(t); s.remove(); rej(e); };
    document.head.appendChild(s);
  });
  for (const cdn of CDNS) {
    try { await loadScript(cdn); return; } catch (_) {}
  }
  throw new Error('Chart.js 加载失败，请检查网络连接');
}

// 项目调色板（与 project sort_order 对应）
const CHART_PALETTE = [
  '#3b82f6','#22c55e','#f59e0b','#ef4444','#8b5cf6',
  '#06b6d4','#f97316','#ec4899','#84cc16','#64748b',
  '#0ea5e9','#a855f7','#14b8a6','#fb923c','#e879f9',
];
function _projectColor(pid, projectsMap) {
  const ids = Object.keys(projectsMap).sort();
  const idx = ids.indexOf(pid);
  return CHART_PALETTE[Math.max(0, idx) % CHART_PALETTE.length];
}

// v1.28 · 图表视图渲染
let _activeCharts = [];
function _destroyCharts() {
  _activeCharts.forEach(c => { try { c.destroy(); } catch (_) {} });
  _activeCharts = [];
}

// 周期配置
const CHART_PERIODS = [
  { key: 'today',   label: '今日' },
  { key: 'week',    label: '本周' },
  { key: 'month',   label: '本月' },
  { key: '3month',  label: '近三月' },
  { key: 'year',    label: '全年' },
];

async function renderTimeChartView(el, filterBarHtml) {
  const period  = state.timeChartPeriod  || 'week';
  const project = state.timeChartProject || 'all';

  const periodBtns = CHART_PERIODS.map(p =>
    `<button class="period-btn${period===p.key?' active':''}" data-chart-period="${p.key}">${p.label}</button>`
  ).join('');

  el.innerHTML = filterBarHtml + `
    <div class="time-header">
      <div class="time-title-row">
        <span class="time-title">⏱ 用时统计</span>
        <div style="display:flex;gap:5px;align-items:center;flex-wrap:nowrap">
          <div class="time-period-row" style="flex-wrap:nowrap">${periodBtns}</div>
          <button class="chart-view-toggle is-active" data-view="list" title="切换到列表">📋</button>
        </div>
      </div>
    </div>
    <div id="proj-selector-row" class="proj-selector-row"></div>
    <div id="chart-loading" class="time-loading">加载图表中…</div>
  `;
  bindFilterBar(el);

  el.querySelectorAll('[data-chart-period]').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.timeChartPeriod = btn.dataset.chartPeriod;
      _destroyCharts();
      await renderTimeChartView(el, renderFilterBarHtml());
    });
  });
  el.querySelector('[data-view="list"]')?.addEventListener('click', async () => {
    state.timeView = 'list';
    _destroyCharts();
    await renderTimeStats(el, renderFilterBarHtml());
  });

  try {
    await loadChartJs();
    const url = `/api/stats/time-chart?period=${period}&project=${encodeURIComponent(project)}`;
    const data = await api(url);
    _buildProjSelector(el, data, period);
    _renderCharts(el, data, period, project);
  } catch (e) {
    const ld = document.getElementById('chart-loading');
    if (ld) ld.textContent = '图表加载失败：' + e.message;
    toast('图表加载失败：' + e.message, true);
  }
}

function _buildProjSelector(el, data, period) {
  const row = document.getElementById('proj-selector-row');
  if (!row) return;
  const { allProjects = [], projectTotals = {} } = data;
  const proj = state.timeChartProject || 'all';
  const btns = [{ id: 'all', name: '全部', emoji: '🗂' }, ...allProjects]
    .map(p => {
      const active = proj === p.id;
      const secs = p.id === 'all'
        ? Object.values(projectTotals).reduce((s, v) => s + v, 0)
        : (projectTotals[p.id] || 0);
      const timeStr = secs > 0 ? ` · ${formatSeconds(secs)}` : '';
      return `<button class="proj-sel-btn${active ? ' active' : ''}" data-proj="${escapeHtml(p.id)}">
        ${p.emoji || '📁'} ${escapeHtml(p.name)}${timeStr}
      </button>`;
    }).join('');
  row.innerHTML = btns;
  row.querySelectorAll('.proj-sel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.timeChartProject = btn.dataset.proj;
      _destroyCharts();
      await renderTimeChartView(el.closest('#feed') || el, renderFilterBarHtml());
    });
  });
}

function _renderCharts(el, data, period, project) {
  const { labels = [], groupedByDay = {}, projectTotals = {}, projects = {}, tasks = [] } = data;
  const ld = document.getElementById('chart-loading');
  if (ld) ld.remove();

  const pids = Object.keys(projectTotals).filter(pid => projectTotals[pid] > 0)
    .sort((a, b) => projectTotals[b] - projectTotals[a]);
  const totalAll = pids.reduce((s, pid) => s + projectTotals[pid], 0);

  // x 轴标签格式化
  const dayNames = ['日','一','二','三','四','五','六'];
  const xLabels = labels.map(d => {
    if (/^\d{4}-\d{2}$/.test(d)) return d.slice(5) + '月'; // year period: YYYY-MM
    if (/^\d{2}\/\d{2}$/.test(d)) return d; // 3month: MM/DD
    try {
      const dt = new Date(d + 'T12:00:00+08:00');
      if (period === 'today') return `${d.slice(5)}`;
      return `${d.slice(5)} 周${dayNames[dt.getDay()]}`;
    } catch { return d; }
  });

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  el.appendChild(wrap);

  if (!pids.length) {
    wrap.innerHTML = '<div class="time-empty">暂无用时数据<br><small class="muted">在待办任务上点击 ▶️ 开始计时后数据将显示在此</small></div>';
    return;
  }

  const projName = project !== 'all' ? `${projects[project]?.emoji || ''} ${projects[project]?.name || project}` : '全部项目';

  wrap.innerHTML = `<div class="chart-summary">${projName} · 累计 <strong>${formatSeconds(totalAll)}</strong></div>`;

  if (project === 'all') {
    // 全部项目：堆叠条形图 + 环形图
    wrap.insertAdjacentHTML('beforeend', `
      <div class="chart-section">
        <div class="chart-label">时间分布 · 按项目堆叠</div>
        <div class="chart-canvas-box"><canvas id="chart-stacked"></canvas></div>
      </div>
      <div class="chart-section">
        <div class="chart-label">项目用时占比</div>
        <div class="chart-canvas-box chart-donut-box"><canvas id="chart-donut"></canvas></div>
      </div>
    `);

    const stackedCtx = document.getElementById('chart-stacked')?.getContext('2d');
    if (stackedCtx) {
      const datasets = pids.map(pid => ({
        label: `${projects[pid]?.emoji || '📁'} ${projects[pid]?.name || pid}`,
        data: labels.map(l => Math.round((groupedByDay[l]?.[pid] || 0) / 60)),
        backgroundColor: _projectColor(pid, projects),
        borderRadius: 3, borderSkipped: false,
      }));
      _activeCharts.push(new Chart(stackedCtx, {
        type: 'bar',
        data: { labels: xLabels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatSeconds(ctx.raw * 60)}` } }
          },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
            y: { stacked: true, beginAtZero: true,
              ticks: { callback: v => v + 'm', font: { size: 11 } },
              grid: { color: 'rgba(0,0,0,0.06)' }
            },
          },
        },
      }));
    }

    const donutCtx = document.getElementById('chart-donut')?.getContext('2d');
    if (donutCtx) {
      _activeCharts.push(new Chart(donutCtx, {
        type: 'doughnut',
        data: {
          labels: pids.map(pid => `${projects[pid]?.emoji || ''} ${projects[pid]?.name || pid}`),
          datasets: [{ data: pids.map(pid => Math.round(projectTotals[pid] / 60)),
            backgroundColor: pids.map(pid => _projectColor(pid, projects)),
            borderWidth: 2, borderColor: '#fff' }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${formatSeconds(ctx.raw * 60)} (${Math.round(ctx.raw / Math.max(1, totalAll / 60) * 100)}%)` } }
          },
        },
      }));
    }

  } else {
    // 单个项目：时间轴单色条形图 + 任务水平条
    const color = _projectColor(project, projects);
    wrap.insertAdjacentHTML('beforeend', `
      <div class="chart-section">
        <div class="chart-label">时间轴分布</div>
        <div class="chart-canvas-box"><canvas id="chart-proj-bar"></canvas></div>
      </div>
      <div class="chart-section">
        <div class="chart-label">任务用时 · 从长到短</div>
        <div class="chart-canvas-box chart-task-box"><canvas id="chart-tasks"></canvas></div>
      </div>
    `);

    const barCtx = document.getElementById('chart-proj-bar')?.getContext('2d');
    if (barCtx) {
      _activeCharts.push(new Chart(barCtx, {
        type: 'bar',
        data: {
          labels: xLabels,
          datasets: [{
            label: projName,
            data: labels.map(l => Math.round((groupedByDay[l]?.[project] || 0) / 60)),
            backgroundColor: color + 'cc',
            borderColor: color,
            borderWidth: 1.5, borderRadius: 4, borderSkipped: false,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ` ${formatSeconds(ctx.raw * 60)}` } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
            y: { beginAtZero: true,
              ticks: { callback: v => v + 'm', font: { size: 11 } },
              grid: { color: 'rgba(0,0,0,0.06)' }
            },
          },
        },
      }));
    }

    // 任务水平条
    const taskCtx = document.getElementById('chart-tasks')?.getContext('2d');
    if (taskCtx && tasks.length) {
      const topTasks = tasks.slice(0, 10);
      const taskLabels = topTasks.map(t => extractTitle(t.content, 22));
      const taskData = topTasks.map(t => Math.round(t.seconds / 60));
      const taskH = Math.max(180, topTasks.length * 36);
      document.querySelector('.chart-task-box').style.height = taskH + 'px';
      _activeCharts.push(new Chart(taskCtx, {
        type: 'bar',
        data: {
          labels: taskLabels,
          datasets: [{ data: taskData,
            backgroundColor: color + 'bb', borderColor: color,
            borderWidth: 1, borderRadius: 4,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ` ${formatSeconds(ctx.raw * 60)}` } }
          },
          scales: {
            x: { beginAtZero: true, ticks: { callback: v => v + 'm', font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
            y: { grid: { display: false }, ticks: { font: { size: 12 } } },
          },
        },
      }));
    } else if (taskCtx) {
      wrap.querySelector('.chart-task-box').innerHTML = '<div class="time-empty" style="height:100%;display:flex;align-items:center;justify-content:center">暂无任务数据</div>';
    }
  }
}

// v1.26 · 秒数 → 人类可读时间（"23m" / "1h 5m"）
function formatSeconds(s) {
  if (!s || s <= 0) return '0m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

// v1.26 · 实时计时器（每秒更新所有 .timer-badge 元素）
let _timerInterval = null;
function startLiveTimers() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  if (!document.querySelector('.timer-badge[data-start-at]')) return;
  _timerInterval = setInterval(() => {
    document.querySelectorAll('.timer-badge[data-start-at]').forEach(el => {
      const base = parseInt(el.dataset.baseSecs || '0', 10);
      const startAt = el.dataset.startAt;
      const elapsed = startAt ? Math.floor((Date.now() - new Date(startAt).getTime()) / 1000) : 0;
      el.textContent = '▶ ' + formatSeconds(base + Math.max(0, elapsed));
    });
  }, 1000);
}

// Core: escape + apply money/unit/percent/date/time/person highlights to raw text
function highlightPlainText(raw) {
  let html = escapeHtml(raw);
  html = html.replace(/¥[\d,]+(?:\.\d+)?/g, m => `<span class="hl-money">${m}</span>`);
  html = html.replace(/\d+(?:\.\d+)?(?:kg|千克|克|吨|mm|cm|m|km|元|万|亿|个|条|份)/gi, m => `<span class="hl-unit">${m}</span>`);
  html = html.replace(/\d+(?:\.\d+)?%/g, m => `<span class="hl-percent">${m}</span>`);
  html = html.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, m => `<span class="hl-date">${m}</span>`);
  html = html.replace(/\b\d{1,2}[-/]\d{1,2}\b/g, m => `<span class="hl-date">${m}</span>`);
  html = html.replace(/\d{1,2}月\d{1,2}日/g, m => `<span class="hl-date">${m}</span>`);
  html = html.replace(/\b\d{1,2}:\d{2}\b/g, m => `<span class="hl-time">${m}</span>`);

  for (const p of state.people) {
    let names = [p.name];
    try {
      if (p.aliases) {
        const arr = JSON.parse(p.aliases);
        if (Array.isArray(arr)) names = names.concat(arr);
      }
    } catch { /* ignore */ }
    for (const n of names) {
      if (!n) continue;
      const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${esc})(?![^<]*>)`, 'g');
      html = html.replace(re, `<span class="hl-person" style="color:${escapeHtml(p.color)}">$1</span>`);
    }
  }
  return html;
}

function highlightContent(raw) {
  // Short/handwritten content: escape + bold + highlights
  let html = highlightPlainText(raw);
  // Apply **bold** last — highlight spans don't contain '**' so regex is safe
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return html;
}

// Apply highlights to text nodes inside already-rendered HTML (markdown / chat replies)
// Skips code/pre and already-highlighted spans to avoid double-wrapping.
const HIGHLIGHT_SKIP = 'code, pre, .hl-money, .hl-unit, .hl-percent, .hl-date, .hl-time, .hl-person';

function applyInlineHighlights(html) {
  if (!html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let cur;
  while ((cur = walker.nextNode())) {
    if (!cur.nodeValue || !cur.nodeValue.trim()) continue;
    if (cur.parentElement && cur.parentElement.closest(HIGHLIGHT_SKIP)) continue;
    nodes.push(cur);
  }
  for (const n of nodes) {
    const original = n.nodeValue;
    const highlighted = highlightPlainText(original);
    // highlightPlainText returns escaped text; if no changes were made, the
    // escaped version equals the trivially-escaped original → skip.
    if (highlighted === escapeHtml(original)) continue;
    const holder = document.createElement('span');
    holder.innerHTML = highlighted;
    n.replaceWith(...holder.childNodes);
  }
  return container.innerHTML;
}

function renderEmpty() {
  return `
    <div class="empty-state">
      <div class="big">📝</div>
      <p><strong>还没有内容</strong></p>
      <p class="muted small">在下方写点什么开始吧</p>
    </div>
  `;
}

// v1.27 · filter bar（视图切换按钮置于最前，仅「全部」tab 显示）
function renderFilterBarHtml() {
  const chips = FILTER_CHIPS.map(c => {
    const active = state.activeFilter === c.key;
    const cls = active ? `filter-chip active-${c.key}` : 'filter-chip';
    return `<button class="${cls}" data-filter="${escapeHtml(c.key)}" type="button" aria-pressed="${active ? 'true' : 'false'}">${c.icon} ${escapeHtml(c.label)}</button>`;
  }).join('');
  let viewBtn = '';
  if (state.currentTab === 'all') {
    const isProject = state.viewMode === 'project';
    // 图标显示"点击后切换到的视图"，直观告知当前能做什么
    const icon = isProject ? '📅' : '🗂';
    const title = isProject ? '切换到时间视图' : '切换到项目分组视图';
    viewBtn = `<button class="view-mode-btn${isProject ? '' : ' is-active'}" data-action="toggle-view" type="button" title="${title}">${icon}</button><span class="view-mode-sep"></span>`;
  }
  return `<div class="filter-bar" role="toolbar" aria-label="按标签筛选">${viewBtn}${chips}</div>`;
}

function bindFilterBar(root) {
  root.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.filter;
      // 单选：点已激活 → 取消；点未激活 → 切换
      state.activeFilter = state.activeFilter === key ? '' : key;
      try {
        await loadFeed();
        renderFeed();
      } catch (e) {
        toast('筛选失败：' + e.message, true);
      }
    });
  });
  // v1.27: 视图切换（项目分组 ⇄ 时间视图）
  root.querySelector('.view-mode-btn')?.addEventListener('click', async () => {
    state.viewMode = state.viewMode === 'project' ? 'timeline' : 'project';
    try { localStorage.setItem('pf-view-mode', state.viewMode); } catch {}
    invalidateFeedCache();
    try {
      await loadFeed();
      renderFeed();
    } catch (e) {
      toast('切换视图失败：' + e.message, true);
    }
  });
}

function extractTitle(content, max = 40) {
  const first = String(content || '').split('\n').find(l => l.trim()) || '';
  let plain = first.trim();
  // 剥离常见 markdown 前缀，留下可读的标题文本
  plain = plain.replace(/^#{1,6}\s+/, '');            // ### 一级标题
  plain = plain.replace(/^[-*+]\s+\[[xX ]\]\s+/, ''); // - [x] checkbox
  plain = plain.replace(/^[-*+]\s+/, '');             // - 列表
  plain = plain.replace(/^\d+\.\s+/, '');             // 1. 有序列表
  plain = plain.replace(/^>\s+/, '');                 // > blockquote
  plain = plain.replace(/\*\*([^*]+)\*\*/g, '$1');    // **粗体**
  plain = plain.replace(/`([^`]+)`/g, '$1');          // `code`
  plain = plain.trim();
  if (!plain) plain = '(空白)';
  return plain.length > max ? plain.slice(0, max) + '…' : plain;
}

// ============================================================
// v1.10 · CollapsibleCard — 统一折叠卡骨架
// profile / progress / summary / suggestion 四种卡共用
// ============================================================
function renderCollapsibleCard(opts) {
  const collapsed = !!opts.initialCollapsed;
  const classes = ['note', 'cc', `cc-${opts.variant}`];
  if (opts.extraClasses) classes.push(opts.extraClasses);
  if (collapsed) classes.push('cc-collapsed');
  const titleHtml = opts.title ? `<span class="cc-title">${escapeHtml(opts.title)}</span>` : '';
  const dateHtml = opts.date ? `<span class="cc-date">${escapeHtml(opts.date)}</span>` : '';
  return `
    <article class="${classes.join(' ')}" data-id="${escapeHtml(opts.id)}">
      <button class="cc-head" type="button" aria-expanded="${collapsed ? 'false' : 'true'}">
        <span class="cc-badge">${opts.badgeIcon} ${escapeHtml(opts.badgeLabel)}</span>
        ${titleHtml}
        ${dateHtml}
        <span class="cc-caret" aria-hidden="true">▸</span>
      </button>
      <div class="cc-body" ${collapsed ? 'hidden' : ''}>${opts.bodyHtml}</div>
    </article>
  `;
}

// v1.11: 同时只允许一张 AI 卡（summary/suggestion）展开，用于 click-outside 自动折回
let activeAiCard = null;

function collapseAiCard(article) {
  if (!article) return;
  const body = article.querySelector(':scope > .cc-body');
  const head = article.querySelector(':scope > .cc-head');
  if (body) body.setAttribute('hidden', '');
  article.classList.add('cc-collapsed');
  head?.setAttribute('aria-expanded', 'false');
}

// 统一的 toggle 事件绑定（替代 v1.8/v1.9 里 profile-head / progress-head 两段独立监听）
function bindCollapsibleToggles(root) {
  root.querySelectorAll('.cc > .cc-head').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // 点到 cc-body 内任意按钮（edit / delete / chat / todoist 等）时不折叠
      if (e.target.closest('.cc-body')) return;
      const article = btn.closest('.cc');
      const body = article?.querySelector(':scope > .cc-body');
      if (!article || !body) return;
      const willOpen = body.hasAttribute('hidden');
      const isAi = article.classList.contains('cc-summary') || article.classList.contains('cc-suggestion');
      if (willOpen) {
        // v1.11: 展开 AI 卡前先折回已展开的另一张 AI 卡（全局互斥）
        if (isAi && activeAiCard && activeAiCard !== article) {
          collapseAiCard(activeAiCard);
        }
        body.removeAttribute('hidden');
        article.classList.remove('cc-collapsed');
        btn.setAttribute('aria-expanded', 'true');
        if (isAi) activeAiCard = article;
      } else {
        body.setAttribute('hidden', '');
        article.classList.add('cc-collapsed');
        btn.setAttribute('aria-expanded', 'false');
        if (activeAiCard === article) activeAiCard = null;
      }
    });
  });
}

// v1.16.8 · feed 内左右滑动切换项目 tab（iOS 常见手势）
function setupSwipeTabs() {
  const feed = $('feed');
  if (!feed) return;
  let startX = 0, startY = 0, startT = 0;
  let tracking = false;
  feed.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    // filter-bar 内的滑动只做横向滚动，不触发 tab 切换
    if (e.target.closest('.filter-bar')) { tracking = false; return; }
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startT = Date.now();
    tracking = true;
  }, { passive: true });
  feed.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startT;
    if (Math.abs(dx) < 60) return;                        // 距离不够
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;        // 主要是纵向 → 滚动
    if (dt > 700) return;                                 // 太慢（拖动而非 swipe）
    const tabs = Array.from(document.querySelectorAll('#project-tabs .tab'));
    if (!tabs.length) return;
    const currentIdx = tabs.findIndex(b => b.classList.contains('active'));
    if (currentIdx < 0) return;
    const nextIdx = dx < 0 ? currentIdx + 1 : currentIdx - 1;  // 左滑下一个，右滑上一个
    if (nextIdx < 0 || nextIdx >= tabs.length) return;
    tabs[nextIdx].click();  // 模拟点击走原切 tab 逻辑（state.currentTab 更新 + refresh）
    // 滚动到顶部（新 tab 从头看）
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, { passive: true });
}

// v1.11: document 级 click-outside — 点展开 AI 卡外部任意区域 → 折回
function setupAiClickOutside() {
  document.addEventListener('click', (e) => {
    if (!activeAiCard) return;
    // stale DOM（renderFeed 重建后的孤儿）直接清掉
    if (!document.contains(activeAiCard)) {
      activeAiCard = null;
      return;
    }
    if (!activeAiCard.contains(e.target)) {
      collapseAiCard(activeAiCard);
      activeAiCard = null;
    }
  });
}

// 条件折叠：summary / suggestion 卡的 body 高度超过半屏时自动折叠
// 必须在 innerHTML 注入后、paint 前同步调用（scrollHeight 会触发强制 layout）
function collapseLongAiCards(root) {
  const halfScreen = Math.max(260, (window.innerHeight || 700) * 0.5);
  root.querySelectorAll('.cc-summary, .cc-suggestion').forEach(article => {
    if (article.classList.contains('cc-collapsed')) return;
    const body = article.querySelector(':scope > .cc-body');
    if (!body) return;
    if (body.scrollHeight > halfScreen) {
      body.setAttribute('hidden', '');
      article.classList.add('cc-collapsed');
      article.querySelector(':scope > .cc-head')?.setAttribute('aria-expanded', 'false');
    }
  });
}

function renderProgressCard(n, projectMap, showProjectBadge) {
  // 从 Obsidian 同步来的卡默认折叠
  const proj = projectMap[n.project_id];
  const projLabel = proj
    ? `${proj.emoji ? proj.emoji + ' ' : ''}${escapeHtml(proj.name)}`
    : escapeHtml(n.project_id);
  const srcLabel = n.source === 'feedback' ? '反馈'
                  : n.source === 'recap' ? '复盘'
                  : n.source === 'capsule' ? '时间胶囊'
                  : '同步';
  const bodyHtml = `
    <div class="note-body">${applyInlineHighlights(renderMarkdown(n.content))}</div>
    <div class="note-foot">
      <span class="note-time">${formatCardDateTime(n.created_at)}${n.updated_at ? ' · 已编辑' : ''}</span>
      ${showProjectBadge ? `<span class="note-project">${projLabel}</span>` : '<span></span>'}
      <button class="edit-btn" aria-label="编辑" title="编辑">✏️</button>
      <button class="delete-btn" aria-label="删除">✕</button>
    </div>
  `;
  return renderCollapsibleCard({
    id: n.id,
    variant: 'progress',
    badgeIcon: '📥',
    badgeLabel: srcLabel,
    title: extractTitle(n.content, 60),
    date: (n.created_at || '').slice(5, 10),
    initialCollapsed: true,
    bodyHtml,
    extraClasses: 'is-progress',
  });
}

function renderProfileCard(n) {
  const proj = state.projects.find(p => p.id === n.project_id);
  const projTitle = proj
    ? `${proj.emoji ? proj.emoji + ' ' : ''}${proj.name}`
    : n.project_id;
  const bodyHtml = `
    <div class="note-body">${applyInlineHighlights(renderMarkdown(n.content))}</div>
    <div class="note-foot">
      <span class="note-time muted tiny">${n.updated_at ? '更新于 ' + formatCardDateTime(n.updated_at) : formatCardDateTime(n.created_at)}</span>
      <span class="muted tiny">ℹ️ 整理时作为 AI 背景资料</span>
      <button class="edit-btn" aria-label="编辑基础档案" title="编辑">✏️</button>
    </div>
  `;
  return renderCollapsibleCard({
    id: n.id,
    variant: 'profile',
    badgeIcon: '📌',
    badgeLabel: '项目基础档案',
    title: projTitle,
    initialCollapsed: true,
    bodyHtml,
    extraClasses: 'is-profile',
  });
}

function renderKnowledgeCard(k) {
  return `
    <div class="knowledge-card" data-id="${escapeHtml(k.id)}">
      <button class="knowledge-card-head" type="button">
        <span class="knowledge-icon">🧠</span>
        <span class="knowledge-title">${escapeHtml(extractTitle(k.content))}</span>
        <span class="knowledge-caret">▸</span>
      </button>
      <div class="knowledge-card-body" hidden>
        <div>${applyInlineHighlights(renderMarkdown(k.content))}</div>
        <div class="knowledge-card-foot">
          <span>🤖 AI · ${formatCardDateTime(k.created_at)}</span>
          <button class="knowledge-delete" aria-label="删除知识卡">✕</button>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// v1.29 · 时间块安排 Popup（棘轮感滚鼓 + 三步流程）
// ============================================================

const _SCHED_SLOT_H   = 44;       // px per 5-min slot
const _SCHED_MIN_START = 6 * 60;  // 06:00
const _SCHED_MIN_END   = 23 * 60 + 55; // 23:55
const _SCHED_DUR_STEPS = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180]; // minutes，15min 起步
const _SCHED_DAYS = [
  { key: 'today-am',  label: '今天上午', defH: 8,  defM: 0 },
  { key: 'today-pm',  label: '今天下午', defH: 14, defM: 0 },
  { key: 'today-eve', label: '今天晚上', defH: 19, defM: 0 },
  { key: 'tomorrow',  label: '明天',     defH: 9,  defM: 0 },
  { key: 'thisweek',  label: '本周五',   defH: 9,  defM: 0 },
  { key: 'nextweek',  label: '下周一',   defH: 9,  defM: 0 },
];

let _schedPopupEl = null;

function _minToStr(m) {
  return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
}
function _durLabel(min) {
  const h = Math.floor(min/60), m = min%60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
function _schedDate(dayKey, h, m) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (dayKey === 'tomorrow') {
    d.setDate(d.getDate() + 1);
  } else if (dayKey === 'thisweek') {
    const toFri = (5 - now.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + toFri);
  } else if (dayKey === 'nextweek') {
    const toMon = (1 - now.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + toMon);
  }
  return d;
}

function dismissSchedulerPopup() {
  if (!_schedPopupEl) return;
  const sheet = _schedPopupEl.querySelector('.sched-sheet');
  if (sheet) sheet.style.transform = 'translateY(100%)';
  _schedPopupEl.style.opacity = '0';
  setTimeout(() => { _schedPopupEl?.remove(); _schedPopupEl = null; }, 280);
}

function showSchedulerPopup(noteId, note) {
  dismissSchedulerPopup();

  let selMins  = 9 * 60;  // default 09:00
  let durIdx   = 1;       // default 45m
  let selDay   = 'today-am';
  let drumScroll = null;
  let snapTimer  = null;
  let lastCenterIdx = -1;

  // ── Build DOM ──────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'sched-overlay';
  overlay.innerHTML = `
    <div class="sched-sheet">
      <div class="sched-handle"></div>
      <div class="sched-title">⏰ 安排时间块</div>
      <div class="sched-day-row">
        ${_SCHED_DAYS.map(d =>
          `<button class="sched-day-btn${d.key === selDay ? ' active' : ''}" data-day="${d.key}">${d.label}</button>`
        ).join('')}
      </div>
      <div class="sched-body">
        <!-- 左：信息展示 -->
        <div class="sched-left">
          <div class="sched-info-block">
            <span class="sched-lbl">开始时间</span>
            <span class="sched-time-big" id="sched-start">09:00</span>
          </div>
          <div class="sched-sep"></div>
          <div class="sched-info-block">
            <span class="sched-lbl">时长</span>
            <div class="sched-dur-row">
              <button class="sched-dur-btn" id="sched-dur-minus">−</button>
              <span class="sched-dur-val" id="sched-dur-val">45m</span>
              <button class="sched-dur-btn" id="sched-dur-plus">+</button>
            </div>
          </div>
          <div class="sched-sep"></div>
          <div class="sched-info-block">
            <span class="sched-lbl">结束时间</span>
            <span class="sched-time-end" id="sched-end">09:45</span>
          </div>
        </div>
        <!-- 右：棘轮鼓 + 确认 -->
        <div class="sched-right">
          <div class="sched-drum" id="sched-drum">
            <div class="drum-scroll" id="drum-scroll">
              <div class="drum-inner" id="drum-inner"></div>
            </div>
          </div>
          <button class="sched-confirm-btn" id="sched-confirm">✓ 确认安排</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  _schedPopupEl = overlay;

  // ── Animate in（双 tick 确保初始状态已渲染）──────────────
  setTimeout(() => {
    overlay.classList.add('visible');
    overlay.querySelector('.sched-sheet').style.transform = 'translateY(0)';
  }, 16);

  // ── Populate drum slots ──────────────────────────────────
  const drumInner = overlay.querySelector('#drum-inner');
  for (let m = _SCHED_MIN_START; m <= _SCHED_MIN_END; m += 5) {
    const div = document.createElement('div');
    div.className = 'drum-slot';
    div.dataset.mins = m;
    div.textContent = _minToStr(m);
    drumInner.appendChild(div);
  }
  drumScroll = overlay.querySelector('#drum-scroll');

  // ── Helpers ──────────────────────────────────────────────
  const slotCount = (selMins - _SCHED_MIN_START) / 5;

  const updateDisplay = () => {
    const dur = _SCHED_DUR_STEPS[durIdx];
    const endMins = Math.min(23 * 60 + 59, selMins + dur);
    overlay.querySelector('#sched-start').textContent = _minToStr(selMins);
    overlay.querySelector('#sched-end').textContent   = _minToStr(endMins);
    overlay.querySelector('#sched-dur-val').textContent = _durLabel(dur);
  };

  const scrollDrumTo = (mins, animate) => {
    const idx = Math.round((mins - _SCHED_MIN_START) / 5);
    drumScroll.scrollTo({ top: idx * _SCHED_SLOT_H, behavior: animate ? 'smooth' : 'instant' });
  };

  const updateSlotClasses = () => {
    const idx = Math.round(drumScroll.scrollTop / _SCHED_SLOT_H);
    if (idx === lastCenterIdx) return;
    const slots = drumInner.children;
    if (lastCenterIdx >= 0) {
      for (let d = -2; d <= 2; d++) {
        const el = slots[lastCenterIdx + d];
        if (el) el.className = 'drum-slot';
      }
    }
    for (let d = -2; d <= 2; d++) {
      const el = slots[idx + d];
      if (!el) continue;
      if (d === 0) el.className = 'drum-slot is-center';
      else if (Math.abs(d) === 1) el.className = 'drum-slot is-near-1';
      else el.className = 'drum-slot is-near-2';
    }
    lastCenterIdx = idx;
    selMins = Math.min(_SCHED_MIN_END, Math.max(_SCHED_MIN_START, _SCHED_MIN_START + idx * 5));
    updateDisplay();
  };

  // ── Scroll events ─────────────────────────────────────────
  drumScroll.addEventListener('scroll', () => {
    updateSlotClasses();
    // Snap timer: after scroll settles, align to nearest slot
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      const idx = Math.round(drumScroll.scrollTop / _SCHED_SLOT_H);
      const target = _SCHED_MIN_START + idx * 5;
      if (target !== selMins) scrollDrumTo(target, true);
    }, 120);
  }, { passive: true });

  // Velocity-based jump (touch)
  let _ts = 0, _ty = 0, _lastTy = 0, _lastTs = 0;
  drumScroll.addEventListener('touchstart', e => {
    _ts = Date.now(); _ty = e.touches[0].clientY;
    _lastTy = _ty; _lastTs = _ts;
    clearTimeout(snapTimer);
  }, { passive: true });
  drumScroll.addEventListener('touchmove', e => {
    _lastTy = e.touches[0].clientY; _lastTs = Date.now();
  }, { passive: true });
  drumScroll.addEventListener('touchend', () => {
    const dt = Math.max(1, Date.now() - _lastTs);
    const vel = Math.abs((_ty - _lastTy) / dt) * 1000; // px/s
    if (vel < 80) return; // let CSS snap handle it
    const cur = Math.round(drumScroll.scrollTop / _SCHED_SLOT_H);
    const curMins = _SCHED_MIN_START + cur * 5;
    let snap = vel > 300 ? 30 : 15;
    const dir = _ty > _lastTy ? -1 : 1; // scroll direction
    const extra = Math.ceil(vel / 400) * snap;
    const targetMins = Math.round((curMins + dir * extra) / snap) * snap;
    const clamped = Math.min(_SCHED_MIN_END, Math.max(_SCHED_MIN_START, targetMins));
    setTimeout(() => {
      scrollDrumTo(clamped, true);
      if (navigator.vibrate) navigator.vibrate(6);
    }, 30);
  }, { passive: true });

  // ── Day chip events ───────────────────────────────────────
  overlay.querySelectorAll('.sched-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.sched-day-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selDay = btn.dataset.day;
      const preset = _SCHED_DAYS.find(d => d.key === selDay);
      if (preset) {
        selMins = preset.defH * 60 + preset.defM;
        scrollDrumTo(selMins, true);
        if (navigator.vibrate) navigator.vibrate(4);
      }
    });
  });

  // ── Duration controls ─────────────────────────────────────
  overlay.querySelector('#sched-dur-minus').addEventListener('click', () => {
    durIdx = Math.max(0, durIdx - 1);
    updateDisplay();
    if (navigator.vibrate) navigator.vibrate(4);
  });
  overlay.querySelector('#sched-dur-plus').addEventListener('click', () => {
    durIdx = Math.min(_SCHED_DUR_STEPS.length - 1, durIdx + 1);
    updateDisplay();
    if (navigator.vibrate) navigator.vibrate(4);
  });

  // ── Swipe-down to dismiss ─────────────────────────────────
  let sheetDragStartY = 0;
  const sheet = overlay.querySelector('.sched-sheet');
  overlay.querySelector('.sched-handle').addEventListener('touchstart', e => {
    sheetDragStartY = e.touches[0].clientY;
  }, { passive: true });
  overlay.querySelector('.sched-handle').addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - sheetDragStartY;
    if (dy > 60) dismissSchedulerPopup();
  }, { passive: true });

  // ── Dismiss on overlay click ──────────────────────────────
  overlay.addEventListener('click', e => { if (e.target === overlay) dismissSchedulerPopup(); });
  document.addEventListener('keydown', function _esc(e) {
    if (e.key === 'Escape') { dismissSchedulerPopup(); document.removeEventListener('keydown', _esc); }
  });

  // ── Confirm ───────────────────────────────────────────────
  overlay.querySelector('#sched-confirm').addEventListener('click', async () => {
    const preset = _SCHED_DAYS.find(d => d.key === selDay);
    const baseDate = _schedDate(selDay, Math.floor(selMins / 60), selMins % 60);
    const isoStr = _toCSTIso(baseDate);
    const dur = _SCHED_DUR_STEPS[durIdx];
    dismissSchedulerPopup();
    try {
      await scheduleNote(noteId, isoStr, dur);
      const n = state.notes.find(x => x.id === noteId);
      if (n) { n.due_at = isoStr; n.duration_minutes = dur; n.status = 'todo'; n.updated_at = new Date().toISOString(); }
      invalidateFeedCache();
      renderFeed();
      toast(`已安排：${preset?.label || ''} ${_minToStr(selMins)} · ${_durLabel(dur)}`);
    } catch (err) {
      toast('安排失败：' + err.message, true);
    }
  });

  // ── Initial position ──────────────────────────────────────
  // Set default based on note's existing due_at or current time
  if (note.due_at) {
    try {
      const d = new Date(note.due_at);
      selMins = d.getHours() * 60 + d.getMinutes();
      selMins = Math.round(selMins / 5) * 5;
      selMins = Math.min(_SCHED_MIN_END, Math.max(_SCHED_MIN_START, selMins));
      // Auto-select day
      const today = new Date();
      if (d.toDateString() === today.toDateString()) {
        const h = d.getHours();
        selDay = h < 12 ? 'today-am' : h < 18 ? 'today-pm' : 'today-eve';
      }
      overlay.querySelectorAll('.sched-day-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.day === selDay);
      });
    } catch (_) {}
  }
  updateDisplay();
  // Defer drum scroll to after layout
  requestAnimationFrame(() => { scrollDrumTo(selMins, false); updateSlotClasses(); });
}

// v1.26/v1.28 · 用时统计视图（列表 + 图表双模式）
async function renderTimeStats(el, filterBarHtml) {
  // v1.28: 图表模式
  if (state.timeView === 'chart') {
    _destroyCharts();
    await renderTimeChartView(el, filterBarHtml);
    return;
  }

  el.innerHTML = filterBarHtml + '<div class="time-loading">⏳ 加载用时数据…</div>';
  bindFilterBar(el);
  try {
    const data = await api(`/api/stats/time?period=${encodeURIComponent(state.timePeriod || 'all')}`);
    const { projects = [], period } = data;
    const totalSecs = projects.reduce((s, p) => s + p.total_seconds, 0);
    const totalTasks = projects.reduce((s, p) => s + p.tasks.length, 0);

    const periodBtns = [['week','本周'],['month','本月'],['all','全部']].map(([k, lbl]) =>
      `<button class="period-btn${period === k ? ' active' : ''}" data-period="${k}">${lbl}</button>`
    ).join('');

    const header = `
      <div class="time-header">
        <div class="time-title-row">
          <span class="time-title">⏱ 用时统计</span>
          <div style="display:flex;gap:6px;align-items:center">
            <div class="time-period-row">${periodBtns}</div>
            <button class="chart-view-toggle" data-view="chart" title="切换到图表">📊</button>
          </div>
        </div>
        <div class="time-summary">${totalTasks} 个任务 · ${projects.length} 个项目 · 累计 <strong>${formatSeconds(totalSecs)}</strong></div>
      </div>`;

    const projectsHtml = projects.length ? projects.map(p => {
      const projTotal = formatSeconds(p.total_seconds);
      const tasksHtml = p.tasks.map(t => {
        const isRunning = !t.archived && t.status === 'in_progress' && t.session_start_at;
        const timeEl = isRunning
          ? `<span class="timer-badge task-timer" data-start-at="${escapeHtml(t.session_start_at)}" data-base-secs="${t.total_seconds}">▶ ${formatSeconds(t.total_seconds)}</span>`
          : `<span class="task-time-static">${formatSeconds(t.total_seconds)}</span>`;
        const badge = t.archived
          ? '<span class="task-status-badge done">✅ 已完成</span>'
          : t.status === 'in_progress'
            ? '<span class="task-status-badge running">▶ 进行中</span>'
            : '<span class="task-status-badge pending">🎯 待办</span>';
        return `<div class="time-task-row">
          <span class="time-task-title">${escapeHtml(extractTitle(t.content, 48))}</span>
          <span class="time-task-right">${timeEl}${badge}</span>
        </div>`;
      }).join('');
      return `<div class="time-project-group">
        <div class="time-project-header">
          <span class="time-proj-emoji">${escapeHtml(p.project_emoji)}</span>
          <span class="time-proj-name">${escapeHtml(p.project_name)}</span>
          <span class="time-proj-total">${projTotal}</span>
          <span class="time-proj-count">${p.tasks.length} 个任务</span>
        </div>
        <div class="time-task-list">${tasksHtml}</div>
      </div>`;
    }).join('')
    : '<div class="time-empty">暂无用时记录<br><small class="muted">在待办任务上点击 ▶️ 开始计时</small></div>';

    el.innerHTML = filterBarHtml + header + projectsHtml;
    bindFilterBar(el);
    el.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.timePeriod = btn.dataset.period;
        await renderTimeStats(el, renderFilterBarHtml());
      });
    });
    // 📊 切换到图表
    el.querySelector('[data-view="chart"]')?.addEventListener('click', async () => {
      state.timeView = 'chart';
      await renderTimeStats(el, renderFilterBarHtml());
    });
    startLiveTimers();
  } catch (e) {
    toast('加载用时统计失败：' + e.message, true);
  }
}

function renderFeed() {
  const el = $('feed');
  if (!el) return;
  // v1.11: 重建 DOM 前清掉 stale 引用（AI 卡重新从折叠态起步）
  activeAiCard = null;

  const filterBarHtml = renderFilterBarHtml();  // v1.12

  // v1.26: 用时统计视图独立渲染，不走 feed 逻辑
  if (state.activeFilter === 'time') {
    renderTimeStats(el, filterBarHtml);
    return;
  }

  const emptyHtml = () => {
    if (state.searchQuery) {
      return `<div class="search-empty"><div class="big">🔍</div><p>没有找到 "${escapeHtml(state.searchQuery)}"</p></div>`;
    }
    if (state.activeFilter) {
      return `<div class="search-empty"><div class="big">🗂️</div><p>该筛选下暂无内容</p></div>`;
    }
    return renderEmpty();
  };

  if (!state.notes.length) {
    el.innerHTML = filterBarHtml + emptyHtml();
    bindFilterBar(el);
    return;
  }

  // 分离 profile 卡：pin 在选中项目的 feed 顶部，不参与时间分组
  // "全部" tab 下不显示 profile（太多会堆满，且"项目基础信息"属于单项目视图）
  // v1.11: 搜索激活时也不显示 profile（用户在找特定内容，profile 易命中干扰）
  // v1.12: filter 激活时也不显示 profile（筛选语义下 profile 不参与筛选，显示会误导）
  const profileNotes = state.notes.filter(n => n.card_type === 'profile');
  const regularNotes = state.notes.filter(n => n.card_type !== 'profile');

  let profileHtml = '';
  if (state.currentTab !== 'all' && !state.searchQuery && !state.activeFilter) {
    const profile = profileNotes.find(p => p.project_id === state.currentTab);
    if (profile) {
      profileHtml = `<div class="profile-wrap">${renderProfileCard(profile)}</div>`;
    }
  }

  if (!regularNotes.length && !profileHtml) {
    el.innerHTML = filterBarHtml + emptyHtml();
    bindFilterBar(el);
    return;
  }

  // v1.15: filter=todo 时扁平排序（按 due_at 由近及远），不做日期分组
  const projectMap = Object.fromEntries(state.projects.map(p => [p.id, p]));
  const showProjectBadge = state.currentTab === 'all';

  // v1.27: 项目分组视图（全部 tab + 非搜索），适用于所有卡片类型
  const projectViewActive = state.currentTab === 'all' && state.viewMode === 'project' && !state.searchQuery;
  let groups;
  if (projectViewActive) {
    const byProject = {};
    for (const n of regularNotes) (byProject[n.project_id] ||= []).push(n);
    const projectGroups = Object.entries(byProject).map(([pid, ns]) => {
      ns.sort((a, b) => {
        // todo 卡：按 due_at 紧迫度排序；其他卡：按创建时间倒序
        if (state.activeFilter === 'todo' || (!state.activeFilter && a.tag === 'todo')) {
          const aD = a.due_at ? new Date(a.due_at) : new Date('9999');
          const bD = b.due_at ? new Date(b.due_at) : new Date('9999');
          return aD - bD;
        }
        return new Date(b.created_at) - new Date(a.created_at);
      });
      return { proj: projectMap[pid], notes: ns };
    }).sort((a, b) => (a.proj?.sort_order ?? 999) - (b.proj?.sort_order ?? 999));

    // v1.30.2: 任意 filter 激活时启用堆叠（仅「全部」tab）
    const stackMode = !!state.activeFilter;
    // 进展 filter 时把 milestone 拆出独立堆叠
    const splitMilestone = state.activeFilter === 'progress';

    groups = [];
    for (const pg of projectGroups) {
      const pid = pg.proj?.id || 'unknown';
      const projHeaderBase = `<span class="proj-emoji">${pg.proj?.emoji || '📁'}</span>
        <span class="proj-name">${escapeHtml(pg.proj?.name || '未知项目')}</span>`;

      // 拆分 notes 成多组（默认一组；progress filter 拆 progress / milestone）
      let subgroups;
      if (splitMilestone) {
        const progressOnly = pg.notes.filter(n => n.tag === 'progress');
        const milestoneOnly = pg.notes.filter(n => n.tag === 'milestone');
        subgroups = [];
        if (progressOnly.length) subgroups.push({ key: 'progress', label: '✅ 进展', notes: progressOnly });
        if (milestoneOnly.length) subgroups.push({ key: 'milestone', label: '🏁 里程碑', notes: milestoneOnly });
      } else {
        subgroups = [{ key: '_', label: '', notes: pg.notes }];
      }

      // 第一个 subgroup 用项目 header，后续 subgroup 用紧凑的 sub-header
      subgroups.forEach((sg, sgIdx) => {
        const stackKey = `${pid}::${sg.key}`;
        const isStack    = stackMode && sg.notes.length > 1;
        const isExpanded = state.expandedStacks.has(stackKey);
        const visibleNotes = (isStack && !isExpanded) ? [sg.notes[0]] : sg.notes;
        const hiddenCount  = (isStack && !isExpanded) ? sg.notes.length - 1 : 0;

        let headerHtml;
        const expandBtnHtml = isStack && !isExpanded
          ? `<button class="stack-header-btn expand" data-stack-key="${escapeHtml(stackKey)}">▼ ${hiddenCount} 项隐藏</button>`
          : '';
        const collapseBtnHtml = isStack && isExpanded
          ? `<button class="stack-header-btn collapse" data-stack-key="${escapeHtml(stackKey)}">▲ 收起</button>`
          : '';

        if (sgIdx === 0) {
          headerHtml = `<header class="project-section-head">
            ${projHeaderBase}
            ${sg.label ? `<span class="proj-sub-label">${sg.label}</span>` : ''}
            <span class="proj-count">${sg.notes.length}</span>
            ${expandBtnHtml}${collapseBtnHtml}
          </header>`;
        } else {
          headerHtml = `<header class="project-section-head sub-section-head">
            <span class="proj-sub-label">${sg.label}</span>
            <span class="proj-count">${sg.notes.length}</span>
            ${expandBtnHtml}${collapseBtnHtml}
          </header>`;
        }

        groups.push({
          cls: 'project-section',
          projId: stackKey,
          isStack, isExpanded, hiddenCount,
          headerHtml,
          notes: visibleNotes,
        });
      });
    }
  } else {
    groups = state.activeFilter === 'todo'
      ? [{ label: '⏰ 按截止时间排序', notes: regularNotes }]
      : groupNotesByDate(regularNotes);
  }

  const groupsHtml = groups.map(g => {
    const isStackCollapsed = g.isStack && !g.isExpanded;
    // v1.30.2: peek 仅渲染纯视觉层叠效果，触发改用 header 按钮
    const peekHtml = g.hiddenCount > 0 ? `
      <div class="card-stack-peek card-stack-peek-1"></div>
      ${g.hiddenCount > 1 ? '<div class="card-stack-peek card-stack-peek-2"></div>' : ''}` : '';

    return `
    <div class="${g.cls || 'date-group'}">
      ${g.headerHtml || `<div class="date-divider">${escapeHtml(g.label)}</div>`}
      <div class="${isStackCollapsed ? 'card-stack-wrap' : ''}">
      ${g.notes.map((n, _ni) => {
        const proj = projectMap[n.project_id];
        const projLabel = proj ? `${proj.emoji ? proj.emoji + ' ' : ''}${escapeHtml(proj.name)}` : escapeHtml(n.project_id);
        const isSummary = n.card_type === 'summary';
        const isSuggestion = n.card_type === 'suggestion';
        const isProgress = n.card_type === 'progress';
        const isMain = n.card_type === 'main' || !n.card_type;
        const children = Array.isArray(n.children) ? n.children : [];
        const knowledgeHtml = children.length
          ? `<div class="knowledge-cards" data-parent="${escapeHtml(n.id)}">${children.map(renderKnowledgeCard).join('')}</div>`
          : '';

        // progress 卡（Obsidian 同步来的）走折叠结构，与主卡/总结卡/建议卡视觉区分
        if (isProgress) {
          return renderProgressCard(n, projectMap, showProjectBadge) + knowledgeHtml;
        }

        // Tag badge（主卡手动打的）
        const tagMap = { todo: { icon: '🎯', label: '待办' }, progress: { icon: '✅', label: '进展' }, idea: { icon: '💡', label: '想法' }, milestone: { icon: '🏁', label: '里程碑' } };
        const tagInfo = n.tag ? tagMap[n.tag] : null;
        const tagBadge = tagInfo ? `<span class="tag-badge tag-${n.tag}">${tagInfo.icon} ${tagInfo.label}</span>` : '';

        // Todoist 状态按钮（仅 tag=todo 的主卡）
        let todoistBtn = '';
        if (isMain && n.tag === 'todo') {
          if (n.todoist_task_id) {
            todoistBtn = `<button class="todoist-btn synced" data-synced="1" title="已同步 Todoist" aria-label="Todoist">🔗</button>`;
          } else {
            todoistBtn = `<button class="todoist-btn failed" title="同步 Todoist 失败，点击重试" aria-label="重试 Todoist">⚠️</button>`;
          }
        }

        // summary / suggestion 走 CollapsibleCard，超半屏时 collapseLongAiCards() 追加折叠类
        if (isSummary || isSuggestion) {
          const innerHtml = `
            <div class="note-head">
              ${tagBadge}
              ${todoistBtn}
              ${!isSuggestion ? '<button class="edit-btn" aria-label="编辑" title="编辑">✏️</button>' : ''}
              <button class="delete-btn" aria-label="删除">✕</button>
            </div>
            <div class="note-body">${applyInlineHighlights(renderMarkdown(n.content))}</div>
            <div class="note-foot">
              <span class="note-time">${formatCardDateTime(n.created_at)}${n.updated_at ? ' · 已编辑' : ''}</span>
              ${showProjectBadge ? `<span class="note-project">${projLabel}</span>` : '<span></span>'}
            </div>
          `;
          return renderCollapsibleCard({
            id: n.id,
            variant: isSummary ? 'summary' : 'suggestion',
            badgeIcon: isSummary ? '🤖' : '🔮',
            badgeLabel: isSummary ? 'AI 整理' : '下一步建议',
            title: extractTitle(n.content, 60),
            date: (n.created_at || '').slice(5, 10),
            initialCollapsed: false,  // 展开初渲染，随后 collapseLongAiCards 测量超半屏再折叠
            bodyHtml: innerHtml,
            extraClasses: isSummary ? 'is-summary' : 'is-suggestion',
          }) + knowledgeHtml;
        }

        // main 卡保持原有 article 结构（无折叠）
        const classes = ['note'];
        if (isMain && n.tag) classes.push(`tag-bg-${n.tag}`);
        if (n.archived) classes.push('is-archived');  // v1.13
        // v1.15: todo 卡加紧急度 class（未归档才有）
        let urgencyLabel = '';
        if (isMain && n.tag === 'todo' && !n.archived) {
          const u = computeUrgency(n.due_at);
          classes.push(`due-${u}`);
          urgencyLabel = formatDueAt(n.due_at);
        }
        // v1.25: 进行中 todo 卡加渐变背景
        const isInProgress = isMain && n.tag === 'todo' && !n.archived && n.status === 'in_progress';
        if (isInProgress) classes.push('is-in-progress');

        // v1.13: todo 未归档 → ✅；v1.22: 其他 main 卡未归档 → 📦；归档后 → ↶ 还原
        let archiveBtn = '';
        if (isMain) {
          if (n.archived) {
            archiveBtn = '<button class="unarchive-btn" aria-label="还原" title="还原">↶</button>';
          } else if (n.tag === 'todo') {
            archiveBtn = '<button class="archive-btn" aria-label="标记完成" title="打勾完成">✅</button>';
          } else {
            archiveBtn = '<button class="archive-btn archive-silent-btn" aria-label="归档" title="归档（不删除，可在「已完成」视图找回）">📦</button>';
          }
        }

        // v1.29: 时间块安排按钮（仅 tag=todo 主卡未归档）
        const scheduleBtn = (isMain && n.tag === 'todo' && !n.archived)
          ? `<button class="schedule-btn" aria-label="安排时间块" title="安排时间块">⏰</button>`
          : '';

        // v1.25: 进行中状态切换按钮（仅 tag=todo 主卡未归档）
        let progressToggleBtn = '';
        if (isMain && n.tag === 'todo' && !n.archived) {
          const icon = isInProgress ? '⏸' : '▶️';
          const label = isInProgress ? '暂停（回到待办）' : '标记进行中';
          progressToggleBtn = `<button class="progress-toggle-btn${isInProgress ? ' is-active' : ''}" aria-label="${label}" title="${label}">${icon}</button>`;
        }

        return `
          <article class="${classes.join(' ')}" data-id="${escapeHtml(n.id)}">
            <div class="note-head">
              ${tagBadge}
              ${todoistBtn}
              <span class="note-head-spacer"></span>
              ${isMain && !n.archived ? '<button class="chat-btn" aria-label="问 AI" title="基于这条进展问 AI">🤖</button>' : ''}
              ${isMain && !n.archived ? '<button class="more-btn" aria-label="更多操作" title="更多">⋯</button>' : ''}
              <button class="edit-btn" aria-label="编辑" title="编辑">✏️</button>
              ${scheduleBtn}
              ${progressToggleBtn}
              ${archiveBtn}
              <button class="delete-btn" aria-label="删除">✕</button>
            </div>
            <div class="note-body">${applyInlineHighlights(renderMarkdown(n.content))}</div>
            <div class="note-foot">
              <span class="note-time">${formatCardDateTime(n.created_at)}${n.updated_at ? ' · 已编辑' : ''}${n.archived_at ? ' · 完成于 ' + formatCardDateTime(n.archived_at) : ''}</span>
              ${isInProgress && n.session_start_at
                ? `<span class="timer-badge" data-start-at="${escapeHtml(n.session_start_at)}" data-base-secs="${n.total_seconds || 0}">▶ ${formatSeconds(n.total_seconds || 0)}</span>`
                : (n.total_seconds > 0 ? `<span class="time-spent-badge">⏱ ${formatSeconds(n.total_seconds)}</span>` : '')}
              ${urgencyLabel ? `<span class="note-due${n.due_at && new Date(n.due_at) < new Date() ? ' is-overdue' : ''}">${escapeHtml(urgencyLabel)}</span>` : ''}
              ${showProjectBadge ? `<span class="note-project">${projLabel}</span>` : '<span></span>'}
            </div>
          </article>
          ${knowledgeHtml}
        `;
      }).join('')}
      ${peekHtml}
      </div>
    </div>
  `;}).join('');

  const sentinel = state.hasMore ? '<div id="feed-sentinel" class="feed-sentinel"><span class="spinner"></span> 加载更多…</div>' : '';

  el.innerHTML = profileHtml + filterBarHtml + groupsHtml + sentinel;

  // v1.10: summary / suggestion 超半屏则折叠（同步测 scrollHeight，paint 前落定）
  collapseLongAiCards(el);

  // v1.12: 绑定 filter-bar 点击
  bindFilterBar(el);

  // v1.26: 启动实时计时器（有进行中卡片时）
  startLiveTimers();

  // v1.30.2: 堆叠展开 / 收起（统一 stack-header-btn 触发）
  el.querySelectorAll('.stack-header-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.stackKey;
      if (btn.classList.contains('expand')) state.expandedStacks.add(key);
      else state.expandedStacks.delete(key);
      renderFeed();
    });
  });

  // Delete main card
  el.querySelectorAll('.note .delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (!noteEl) return;
      const id = noteEl.dataset.id;
      if (!(await showConfirm('删除主卡', '确认删除这条？挂载的知识卡也会一并删除。', { okText: '删除', danger: true }))) return;
      try {
        await deleteNote(id);
        state.notes = state.notes.filter(n => n.id !== id);
        renderFeed();
        toast('已删除');
      } catch (err) {
        toast('删除失败：' + err.message, true);
      }
    });
  });

  // Edit main card
  el.querySelectorAll('.note .edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (noteEl) enterEditMode(noteEl);
    });
  });

  // Open chat on main card
  el.querySelectorAll('.note .chat-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (noteEl) openChat(noteEl.dataset.id);
    });
  });

  // Todoist retry / open
  el.querySelectorAll('.note .todoist-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (!noteEl) return;
      const id = noteEl.dataset.id;
      if (btn.dataset.synced) {
        // 已同步 → 打开 Todoist（手机上会跳 App）
        const n = state.notes.find(x => x.id === id);
        if (n?.todoist_task_id) {
          window.open(`https://todoist.com/showTask?id=${n.todoist_task_id}`, '_blank');
        }
        return;
      }
      // 失败 → 重试
      btn.textContent = '…';
      btn.disabled = true;
      try {
        const res = await retryTodoistSync(id);
        if (res?.todoist_sync?.status === 'ok') {
          toast('已重试 · Todoist 同步成功');
          const idx = state.notes.findIndex(x => x.id === id);
          if (idx >= 0) state.notes[idx].todoist_task_id = res.todoist_sync.task_id;
          renderFeed();
        } else {
          toast('重试失败：' + (res?.todoist_sync?.error || '未知错误'), true);
          btn.textContent = '⚠️';
          btn.disabled = false;
        }
      } catch (err) {
        toast('重试失败：' + err.message, true);
        btn.textContent = '⚠️';
        btn.disabled = false;
      }
    });
  });

  // v1.29: ⏰ 安排时间块
  el.querySelectorAll('.schedule-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const noteEl = btn.closest('.note');
      if (!noteEl) return;
      const note = state.notes.find(x => x.id === noteEl.dataset.id);
      if (note) showSchedulerPopup(note.id, note);
    });
  });

  // v1.26.1: 点击已过期标签 → 重设截止时间 popup
  el.querySelectorAll('.note-due.is-overdue').forEach(badge => {
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', e => {
      e.stopPropagation();
      const noteEl = badge.closest('.note');
      if (noteEl) showReschedulePopup(noteEl.dataset.id, badge);
    });
  });

  // v1.25: ▶️/⏸ 待办 ⇄ 进行中 切换（乐观更新 + 失败回滚）
  el.querySelectorAll('.progress-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (!noteEl) return;
      const id = noteEl.dataset.id;
      const note = state.notes.find(x => x.id === id);
      if (!note) return;
      const prevStatus = note.status || 'todo';
      note.status = prevStatus === 'in_progress' ? 'todo' : 'in_progress';
      renderFeed();
      try {
        const res = await toggleNoteStatus(id);
        const fresh = state.notes.find(x => x.id === id);
        if (fresh) {
          fresh.status = res.status;
          fresh.total_seconds = res.total_seconds ?? fresh.total_seconds;
          fresh.session_start_at = res.session_start_at ?? null;
        }
        renderFeed();
      } catch (err) {
        const back = state.notes.find(x => x.id === id);
        if (back) back.status = prevStatus;
        renderFeed();
        toast('切换失败：' + err.message, true);
      }
    });
  });

  // v1.13/v1.14: ✅ todo 归档派生 progress 卡；v1.22: 所有 main 卡支持 📦 归档
  el.querySelectorAll('.archive-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (!noteEl) return;
      const id = noteEl.dataset.id;
      const note = state.notes.find(x => x.id === id);
      const isTodo = note?.tag === 'todo';
      noteEl.classList.add('archiving');
      try {
        const [, result] = await Promise.all([
          new Promise(r => setTimeout(r, 300)),
          archiveNote(id),
        ]);
        const derivedId = result?.derived_note_id || null;
        invalidateFeedCache();
        await loadFeed();
        renderFeed();
        const todoistFail = result?.todoist_close && result.todoist_close.ok === false;
        const msg = isTodo
          ? (todoistFail ? '✓ 已完成（Todoist 同步失败）' : '✓ 已完成')
          : '📦 已归档（可在「已完成」视图找回）';
        toast(msg, todoistFail, {
          label: '撤销',
          timeoutMs: 5000,
          onClick: async () => {
            try {
              await Promise.all([
                unarchiveNote(id),
                derivedId ? deleteNote(derivedId).catch(() => null) : Promise.resolve(),
              ]);
              invalidateFeedCache();
              await loadFeed();
              renderFeed();
              toast('已还原');
            } catch (err2) {
              toast('还原失败：' + err2.message, true);
            }
          },
        });
      } catch (err) {
        noteEl.classList.remove('archiving');
        toast('归档失败：' + err.message, true);
      }
    });
  });

  // v1.16: ⋯ 更多菜单（跨项目移动/复制）
  el.querySelectorAll('.more-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (!noteEl) return;
      const id = noteEl.dataset.id;
      const note = state.notes.find(x => x.id === id);
      if (!note) return;
      const action = await openCardActionSheet();
      if (!action || action === 'cancel') return;
      const targetProjectId = await pickTargetProject(note.project_id);
      if (!targetProjectId) return;
      const targetProj = state.projects.find(p => p.id === targetProjectId);
      const projLabel = targetProj ? `${targetProj.emoji ? targetProj.emoji + ' ' : ''}${targetProj.name}` : targetProjectId;
      try {
        if (action === 'move') {
          await moveNote(id, targetProjectId);
          invalidateFeedCache();
          await loadFeed();
          renderFeed();
          toast(`已移动到 ${projLabel}`);
        } else if (action === 'copy') {
          await copyNote(id, targetProjectId);
          invalidateFeedCache();
          await loadFeed();
          renderFeed();
          toast(`已复制到 ${projLabel}`);
        }
      } catch (err) {
        toast((action === 'move' ? '移动' : '复制') + '失败：' + err.message, true);
      }
    });
  });

  el.querySelectorAll('.unarchive-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteEl = e.target.closest('.note');
      if (!noteEl) return;
      const id = noteEl.dataset.id;
      try {
        await unarchiveNote(id);
        invalidateFeedCache();
        await loadFeed();
        renderFeed();
        toast('已还原');
      } catch (err) {
        toast('还原失败：' + err.message, true);
      }
    });
  });

  // v1.10: 统一 CollapsibleCard toggle（profile / progress / summary / suggestion 共用）
  bindCollapsibleToggles(el);

  // Knowledge card toggle
  el.querySelectorAll('.knowledge-card-head').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.knowledge-card');
      const body = card?.querySelector('.knowledge-card-body');
      if (!card || !body) return;
      const nowOpen = body.hasAttribute('hidden');
      if (nowOpen) { body.removeAttribute('hidden'); card.classList.add('open'); }
      else { body.setAttribute('hidden', ''); card.classList.remove('open'); }
    });
  });

  // Knowledge card delete
  el.querySelectorAll('.knowledge-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = e.target.closest('.knowledge-card');
      const parentWrap = e.target.closest('.knowledge-cards');
      const id = card?.dataset.id;
      const parentId = parentWrap?.dataset.parent;
      if (!id || !parentId) return;
      if (!(await showConfirm('删除知识卡', '确认删除这张知识卡？', { okText: '删除', danger: true }))) return;
      try {
        await deleteNote(id);
        const parent = state.notes.find(n => n.id === parentId);
        if (parent) parent.children = (parent.children || []).filter(k => k.id !== id);
        renderFeed();
        toast('已删除');
      } catch (err) {
        toast('删除失败：' + err.message, true);
      }
    });
  });

  // Setup infinite scroll sentinel
  setupInfiniteScroll();
}

// ---------- Chat (🤖 问 AI) ----------
const chat = {
  parentNoteId: null,
  messages: [],     // [{role, content, ts, savedNoteId?}]
  sending: false,
};

function setupChat() {
  $('chat-close')?.addEventListener('click', closeChat);
  $('chat-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeChat();
  });

  const input = $('chat-input');
  const send = $('chat-send');
  if (input && send) {
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatFromInput();
      }
    });
    send.addEventListener('click', sendChatFromInput);
  }
}

async function openChat(parentNoteId) {
  const modal = $('chat-modal');
  if (!modal) return;
  const note = state.notes.find(n => n.id === parentNoteId);
  if (!note) { toast('找不到主卡', true); return; }

  chat.parentNoteId = parentNoteId;
  chat.messages = [];
  chat.sending = false;

  // Context snippet at top
  const snippet = $('chat-context-snippet');
  if (snippet) {
    const proj = state.projects.find(p => p.id === note.project_id);
    const projLabel = proj ? `${proj.emoji ? proj.emoji + ' ' : ''}${proj.name}` : note.project_id;
    snippet.innerHTML = `<span class="muted tiny">${escapeHtml(projLabel)} · ${escapeHtml(note.author_name)}</span><br>${highlightContent(note.content)}`;
  }

  modal.hidden = false;
  const input = $('chat-input');
  if (input) { input.value = ''; input.style.height = 'auto'; }

  // Show loading, fetch existing history if any
  renderChatMessages({ loading: true });
  try {
    const data = await fetchChatHistory(parentNoteId);
    chat.messages = (data.messages || []).map(m => ({
      role: m.role, content: m.content, ts: m.ts || 0,
    }));
  } catch (e) {
    console.warn('[chat] load history failed', e);
    chat.messages = [];
  }
  renderChatMessages();
  setTimeout(() => input?.focus(), 150);
}

function closeChat() {
  const modal = $('chat-modal');
  if (modal) modal.hidden = true;
  chat.parentNoteId = null;
  chat.messages = [];
  chat.sending = false;
}

function renderChatMessages({ loading = false, typing = false } = {}) {
  const el = $('chat-messages');
  if (!el) return;

  if (loading) {
    el.innerHTML = '<div class="chat-empty"><span class="spinner"></span></div>';
    return;
  }

  if (!chat.messages.length && !typing) {
    el.innerHTML = `
      <div class="chat-empty">
        <div class="big">🤖</div>
        <div>基于这条进展问 AI</div>
        <div class="muted tiny" style="margin-top:6px">AI 会读这条主卡 + 已挂载的知识卡 + 项目近期进展作为上下文</div>
      </div>
    `;
    return;
  }

  const bubbles = chat.messages.map((m, idx) => {
    if (m.role === 'user') {
      return `
        <div class="chat-msg user">
          <div class="chat-bubble">${escapeHtml(m.content)}</div>
        </div>
      `;
    }
    const saved = !!m.savedNoteId;
    return `
      <div class="chat-msg assistant" data-idx="${idx}">
        <div class="chat-bubble">${applyInlineHighlights(renderMarkdown(m.content || ''))}</div>
        <div class="chat-msg-actions">
          <button class="chat-save-btn ${saved ? 'saved' : ''}" data-idx="${idx}" ${saved ? 'disabled' : ''}>
            ${saved ? '✓ 已保存为知识卡' : '💾 存为知识卡'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  const typingHtml = typing
    ? '<div class="chat-typing"><span class="spinner"></span> AI 思考中…</div>'
    : '';

  el.innerHTML = bubbles + typingHtml;

  // Wire save buttons
  el.querySelectorAll('.chat-save-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      if (!isNaN(idx)) saveChatAsKnowledge(idx);
    });
  });

  // Scroll to bottom
  el.scrollTop = el.scrollHeight;
}

async function sendChatFromInput() {
  if (chat.sending) return;
  const input = $('chat-input');
  const text = (input?.value || '').trim();
  if (!text || !chat.parentNoteId) return;

  // Optimistic user message
  chat.messages.push({ role: 'user', content: text, ts: Date.now() });
  if (input) { input.value = ''; input.style.height = 'auto'; }
  chat.sending = true;
  renderChatMessages({ typing: true });

  const send = $('chat-send');
  if (send) send.disabled = true;

  try {
    // Send previous history (without the just-appended user msg) to server
    const historyForServer = chat.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    const data = await sendChat(chat.parentNoteId, text, historyForServer);
    // Server returns full updated history; merge savedNoteId flags from client
    const savedMap = {};
    for (const m of chat.messages) {
      if (m.savedNoteId) savedMap[`${m.role}|${m.ts}|${m.content.slice(0,40)}`] = m.savedNoteId;
    }
    chat.messages = (data.messages || []).map(m => {
      const key = `${m.role}|${m.ts}|${String(m.content || '').slice(0, 40)}`;
      return savedMap[key] ? { ...m, savedNoteId: savedMap[key] } : m;
    });
  } catch (err) {
    // Roll back optimistic add? Keep it but show error toast
    toast('发送失败：' + err.message, true);
  } finally {
    chat.sending = false;
    if (send) send.disabled = false;
    renderChatMessages();
    setTimeout(() => input?.focus(), 50);
  }
}

async function saveChatAsKnowledge(idx) {
  const m = chat.messages[idx];
  if (!m || m.role !== 'assistant' || m.savedNoteId) return;
  const parentId = chat.parentNoteId;
  if (!parentId) return;

  // Pair with the preceding user message (if any) for context
  const prev = idx > 0 ? chat.messages[idx - 1] : null;
  const content = prev && prev.role === 'user'
    ? `❓ ${prev.content}\n\n💡 ${m.content}`
    : m.content;

  try {
    const note = await api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ parent_id: parentId, content, author_emoji: '🧠' }),
    });
    m.savedNoteId = note.id;
    // Attach to parent's children in state + re-render feed
    const parent = state.notes.find(n => n.id === parentId);
    if (parent) {
      parent.children = parent.children || [];
      parent.children.push(note);
    }
    renderChatMessages();
    renderFeed();
    toast('已保存为知识卡');
  } catch (e) {
    toast('保存失败：' + e.message, true);
  }
}

// ---------- Task split modal (v1.20) ----------
function showTaskSplitModal(tasks) {
  return new Promise((resolve) => {
    const modal = $('task-split-modal');
    const list = $('task-split-list');
    const confirmBtn = $('task-split-confirm');
    const cancelBtn = $('task-split-cancel');
    const dismissBtn = $('task-split-dismiss');
    if (!modal || !list) { resolve(null); return; }

    const selections = tasks.map(() => null);

    function checkConfirmBtn() {
      confirmBtn.disabled = selections.some(s => s === null);
    }

    list.innerHTML = tasks.map((title, i) => `
      <div class="task-split-item" data-i="${i}">
        <p class="task-split-title">${escapeHtml(title)}</p>
        <div class="task-split-times">
          <button class="time-chip" data-i="${i}" data-opt="today" type="button">今天</button>
          <button class="time-chip" data-i="${i}" data-opt="tomorrow" type="button">明天</button>
          <button class="time-chip" data-i="${i}" data-opt="thisweek" type="button">本周内</button>
          <button class="time-chip" data-i="${i}" data-opt="nextweek" type="button">下周</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.time-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        list.querySelectorAll(`.time-chip[data-i="${i}"]`).forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        list.querySelector(`.task-split-item[data-i="${i}"]`).classList.add('has-time');
        selections[i] = { content: tasks[i], due: calcTaskDueDate(btn.dataset.opt) };
        checkConfirmBtn();
      });
    });

    modal.hidden = false;
    checkConfirmBtn();

    const done = (result) => {
      modal.hidden = true;
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      dismissBtn.onclick = null;
      resolve(result);
    };

    confirmBtn.onclick = () => done(selections);
    cancelBtn.onclick = () => done(null);
    dismissBtn.onclick = () => done(null);
  });
}

// ---------- AI correction diff modal ----------
function renderCorrectDiff(before, after) {
  // Character-level LCS to highlight changed spans in the "after" text.
  // Small inputs (<=2000 chars enforced server-side), so O(n*m) is fine.
  const a = before, b = after;
  const n = a.length, m = b.length;
  if (!n || !m) return { beforeHtml: escapeHtml(before), afterHtml: escapeHtml(after) };
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const beforeMark = new Array(n).fill(false);
  const afterMark = new Array(m).fill(false);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { beforeMark[i - 1] = true; i--; }
    else { afterMark[j - 1] = true; j--; }
  }
  while (i > 0) { beforeMark[i - 1] = true; i--; }
  while (j > 0) { afterMark[j - 1] = true; j--; }

  function wrap(text, marks) {
    let html = '', inMark = false;
    for (let k = 0; k < text.length; k++) {
      if (marks[k] && !inMark) { html += '<span class="correct-diff-word">'; inMark = true; }
      else if (!marks[k] && inMark) { html += '</span>'; inMark = false; }
      html += escapeHtml(text[k]);
    }
    if (inMark) html += '</span>';
    return html;
  }
  return {
    beforeHtml: wrap(before, beforeMark),
    afterHtml: wrap(after, afterMark),
  };
}

function showCorrectDiff(before, after) {
  return new Promise((resolve) => {
    const modal = $('correct-modal');
    if (!modal) { resolve(false); return; }
    const { beforeHtml, afterHtml } = renderCorrectDiff(before, after);
    $('correct-before').innerHTML = beforeHtml;
    $('correct-after').innerHTML = afterHtml;
    modal.hidden = false;
    const accept = $('correct-accept');
    const reject = $('correct-reject');
    const cancel = $('correct-cancel');
    const done = (ok) => {
      modal.hidden = true;
      accept.onclick = null;
      reject.onclick = null;
      cancel.onclick = null;
      resolve(ok);
    };
    accept.onclick = () => done(true);
    reject.onclick = () => done(false);
    cancel.onclick = () => done(false);
  });
}

// ---------- Edit mode ----------
function enterEditMode(noteEl) {
  if (!noteEl || noteEl.querySelector('.note-edit-box')) return; // already editing
  const id = noteEl.dataset.id;
  const note = state.notes.find(n => n.id === id)
    || state.notes.flatMap(n => n.children || []).find(k => k?.id === id);
  if (!note) { toast('找不到这条记录', true); return; }

  const bodyEl = noteEl.querySelector('.note-body');
  if (!bodyEl) return;
  const headEl = noteEl.querySelector('.note-head');
  if (headEl) headEl.querySelectorAll('.edit-btn, .delete-btn').forEach(b => b.hidden = true);

  const original = note.content || '';
  const box = document.createElement('div');
  box.className = 'note-edit-box';
  box.innerHTML = `
    <textarea class="note-edit-textarea" rows="4">${escapeHtml(original)}</textarea>
    <div class="note-edit-actions">
      <button class="correct-btn left" type="button" title="让 AI 校对">🔍 AI 纠正</button>
      <button class="cancel-btn" type="button">取消</button>
      <button class="save-btn" type="button">保存</button>
    </div>
  `;
  bodyEl.style.display = 'none';
  bodyEl.after(box);

  const textarea = box.querySelector('.note-edit-textarea');
  const saveBtn = box.querySelector('.save-btn');
  const cancelBtn = box.querySelector('.cancel-btn');
  const correctBtn = box.querySelector('.correct-btn');

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  function exit(restoreContent) {
    if (restoreContent != null) {
      note.content = restoreContent;
      renderFeed();
    } else {
      box.remove();
      bodyEl.style.display = '';
      if (headEl) headEl.querySelectorAll('.edit-btn, .delete-btn').forEach(b => b.hidden = false);
    }
  }

  cancelBtn.addEventListener('click', () => exit(null));

  saveBtn.addEventListener('click', async () => {
    const next = textarea.value.trim();
    if (!next) { toast('内容不能为空', true); return; }
    if (next === original) { exit(null); return; }
    saveBtn.disabled = true;
    try {
      const res = await updateNote(id, next);
      note.content = res.content;
      note.updated_at = res.updated_at;
      renderFeed();
      toast('已更新');
    } catch (err) {
      saveBtn.disabled = false;
      toast('保存失败：' + err.message, true);
    }
  });

  correctBtn.addEventListener('click', async () => {
    const current = textarea.value.trim();
    if (!current) { toast('先输入内容', true); return; }
    correctBtn.disabled = true;
    correctBtn.textContent = '🔍 校对中…';
    try {
      const { corrected, changed } = await correctText(current);
      if (!changed || corrected === current) {
        toast('AI 认为无需修改');
      } else {
        const ok = await showCorrectDiff(current, corrected);
        if (ok) textarea.value = corrected;
      }
    } catch (err) {
      toast('校对失败：' + err.message, true);
    } finally {
      correctBtn.disabled = false;
      correctBtn.textContent = '🔍 AI 纠正';
    }
  });
}

// ---------- Infinite scroll ----------
let scrollObserver = null;
function setupInfiniteScroll() {
  const sentinel = $('feed-sentinel');
  if (!sentinel) return;
  if (scrollObserver) scrollObserver.disconnect();
  scrollObserver = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !state.loading && state.hasMore) {
        try {
          await loadFeed(true);
          renderFeed();
        } catch (e) {
          toast('加载更多失败：' + e.message, true);
        }
      }
    }
  }, { rootMargin: '200px' });
  scrollObserver.observe(sentinel);
}

// ---------- v1.11 · Search ----------
let searchDebounceTimer = null;

function updateSearchScope() {
  const el = $('search-scope');
  const input = $('search-input');
  if (!el) return;
  if (state.currentTab === 'all') {
    el.textContent = '全局';
    if (input && !input.value) input.placeholder = '搜索全部项目…';
  } else {
    const p = state.projects.find(x => x.id === state.currentTab);
    const name = p ? `${p.emoji ? p.emoji + ' ' : ''}${p.name}` : state.currentTab;
    el.textContent = '仅 ' + name;
    if (input && !input.value) input.placeholder = `搜索 ${name}…`;
  }
}

function openSearch() {
  const bar = $('search-bar');
  if (!bar) return;
  bar.hidden = false;
  updateSearchScope();
  setTimeout(() => $('search-input')?.focus(), 20);
}

async function closeSearch() {
  const bar = $('search-bar');
  const input = $('search-input');
  if (input) input.value = '';
  if (bar) bar.hidden = true;
  clearTimeout(searchDebounceTimer);
  if (state.searchQuery) {
    state.searchQuery = '';
    await refresh();
  }
}

async function triggerSearch(q) {
  state.searchQuery = q.trim();
  try {
    await loadFeed();
    renderFeed();
  } catch (e) {
    toast('搜索失败：' + e.message, true);
  }
}

function setupSearch() {
  $('btn-search')?.addEventListener('click', openSearch);
  $('search-close')?.addEventListener('click', closeSearch);
  const input = $('search-input');
  if (input) {
    input.addEventListener('input', (e) => {
      clearTimeout(searchDebounceTimer);
      const q = e.target.value;
      searchDebounceTimer = setTimeout(() => triggerSearch(q), 300);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSearch();
    });
  }
}

// ---------- Composer ----------
function updateComposerSpacer() {
  const c = document.querySelector('.composer');
  if (!c) return;
  const h = c.offsetHeight;
  if (h > 0) document.documentElement.style.setProperty('--composer-h', h + 'px');
}

// v1.23 · iOS 键盘弹起时让 composer 跟随上浮
// 用 visualViewport API 算键盘高度：layout viewport 底部 - visualViewport 底部
// 桌面/Android 上 visualViewport 不变 → kb=0 → transform 不动
function updateComposerPosition() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  // 阈值 50px：避开 iOS 顶部地址栏隐藏/显示的小幅 viewport 抖动
  const offset = kb > 50 ? kb : 0;
  document.documentElement.style.setProperty('--keyboard-offset', offset + 'px');
}

function setupComposer() {
  const input = $('composer-input');
  const btn = $('composer-submit');
  const correctBtn = $('composer-correct');
  if (!input || !btn) return;

  function updateSendBtn() {
    btn.disabled = !input.value.trim();
    if (correctBtn) correctBtn.disabled = !input.value.trim();
  }
  updateSendBtn();

  // Initial spacer + react to size-changing events
  setTimeout(updateComposerSpacer, 0);
  window.addEventListener('resize', updateComposerSpacer);
  window.addEventListener('pageshow', updateComposerSpacer);
  window.addEventListener('orientationchange', () => setTimeout(updateComposerSpacer, 250));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateComposerSpacer);
    // v1.23 · 键盘弹起/收起、地址栏伸缩都会触发 visualViewport 变化
    window.visualViewport.addEventListener('resize', updateComposerPosition);
    window.visualViewport.addEventListener('scroll', updateComposerPosition);
  }
  // v1.23 · iOS 偶尔 visualViewport.resize 不及时触发，focus/blur 兜底测一次
  input.addEventListener('focus', () => {
    setTimeout(updateComposerPosition, 300);
    setTimeout(updateComposerPosition, 600);
  });
  input.addEventListener('blur', () => {
    setTimeout(updateComposerPosition, 100);
  });
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(updateComposerSpacer);
    ro.observe(document.querySelector('.composer'));
  }

  correctBtn?.addEventListener('click', async () => {
    const current = input.value.trim();
    if (!current) { toast('先输入内容', true); return; }

    let projectId = state.currentTab;
    if (projectId === 'all') {
      projectId = await pickProject();
      if (!projectId) return;
    }

    const proj = state.projects.find(p => p.id === projectId);
    const projectName = proj ? proj.name : '';

    correctBtn.disabled = true;
    correctBtn.textContent = '…';
    try {
      const { tasks } = await splitTasks(current, projectName);
      if (!tasks || !tasks.length) { toast('AI 未能拆解出任务', true); return; }
      const selections = await showTaskSplitModal(tasks);
      if (!selections) return;

      let created = 0;
      for (const { content, due } of [...selections].reverse()) {
        const note = await postNote(projectId, content, 'todo', due);
        state.notes.unshift(note);
        created++;
      }
      invalidateFeedCache();
      input.value = '';
      input.style.height = 'auto';
      renderFeed();
      updateSendBtn();
      input.focus();
      toast(`已创建 ${created} 张待办卡 ✅`);
    } catch (err) {
      toast('拆解失败：' + err.message, true);
    } finally {
      correctBtn.textContent = '🔍';
      updateSendBtn();
    }
  });

  // Track IME composition state (Chinese / Japanese / Korean input methods)
  // Enter pressed while composing = selecting candidate, NOT submit
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    // Trigger auto-grow after composition commits
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    updateSendBtn();
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    updateSendBtn();
  });

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    // Skip if IME is composing. Triple-check: flag + isComposing + keyCode 229
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  async function submit() {
    const content = input.value.trim();
    if (!content) return;

    let projectId = state.currentTab;
    if (projectId === 'all') {
      projectId = await pickProject();
      if (!projectId) return;
    }

    // 新增：先选 tag
    const tag = await pickTag();
    if (!tag) return;

    btn.disabled = true;
    try {
      const note = await postNote(projectId, content, tag);
      invalidateFeedCache();
      state.notes.unshift(note);
      input.value = '';
      input.style.height = 'auto';
      renderFeed();
      updateSendBtn();
      input.focus();

      // Todoist 同步结果反馈
      if (note.todoist_sync) {
        const s = note.todoist_sync;
        if (s.status === 'ok') toast('已发送 · 同步 Todoist ✅');
        else if (s.status === 'failed') toast('已发送 · Todoist 同步失败，可点 ⚠️ 重试', true);
        else if (s.status === 'skipped') toast('已发送 · Todoist 映射缺失，跳过');
      } else {
        toast('已发送');
      }
    } catch (err) {
      toast('发布失败：' + err.message, true);
    } finally {
      updateSendBtn();
    }
  }
}

// v1.16 · 卡片操作 action sheet（底部弹出，选"移动/复制/取消"）
function openCardActionSheet() {
  return new Promise((resolve) => {
    const modal = $('card-action-sheet');
    if (!modal) { resolve(null); return; }
    modal.hidden = false;

    const done = (action) => {
      modal.hidden = true;
      modal.querySelectorAll('.action-item').forEach(b => b.onclick = null);
      modal.onclick = null;
      resolve(action);
    };
    modal.querySelectorAll('.action-item').forEach(btn => {
      btn.onclick = () => done(btn.dataset.action);
    });
    // 点蒙层空白也当取消
    modal.onclick = (e) => { if (e.target === modal) done('cancel'); };
  });
}

// v1.16 · 目标项目选择器
// excludeId: 当前所在项目，从列表排除（避免自移自复）
function pickTargetProject(excludeId) {
  return new Promise((resolve) => {
    const modal = $('project-picker-modal');
    const list = $('project-picker-list');
    if (!modal || !list) { resolve(null); return; }

    const candidates = state.projects.filter(p => p.id !== excludeId);
    const PRIO_DOT_COLOR = { P0: '#dc2626', P1: '#ea580c', P2: '#2563eb', continuous: '#6b7280' };
    list.innerHTML = candidates.map(p => {
      const prio = p.priority || 'P2';
      const color = PRIO_DOT_COLOR[prio] || '#6b7280';
      const emoji = p.emoji ? `${p.emoji} ` : '';
      return `<button class="project-picker-item" data-id="${escapeHtml(p.id)}" type="button">
        <span class="project-picker-dot" style="background:${color}"></span>
        <span class="project-picker-label">${emoji}${escapeHtml(p.name)}</span>
        <span class="project-picker-prio">${prio === 'continuous' ? '持续' : prio}</span>
      </button>`;
    }).join('');

    modal.hidden = false;

    const done = (projectId) => {
      modal.hidden = true;
      list.innerHTML = '';
      $('project-picker-cancel').onclick = null;
      modal.onclick = null;
      resolve(projectId);
    };
    list.querySelectorAll('.project-picker-item').forEach(btn => {
      btn.onclick = () => done(btn.dataset.id);
    });
    $('project-picker-cancel').onclick = () => done(null);
    modal.onclick = (e) => { if (e.target === modal) done(null); };
  });
}

// ---------- Tag picker ----------
function pickTag() {
  return new Promise((resolve) => {
    const modal = $('tag-modal');
    if (!modal) { resolve('progress'); return; }
    modal.hidden = false;

    const done = (tag) => {
      modal.hidden = true;
      document.removeEventListener('keydown', keyHandler);
      resolve(tag);
    };
    const keyHandler = (e) => {
      if (e.key === '1') done('todo');
      else if (e.key === '2') done('progress');
      else if (e.key === '3') done('idea');
      else if (e.key === '4') done('milestone');
      else if (e.key === 'Escape') done(null);
    };
    document.addEventListener('keydown', keyHandler);

    modal.querySelectorAll('.tag-btn').forEach((btn) => {
      btn.onclick = () => done(btn.dataset.tag);
    });
    $('tag-modal-cancel').onclick = () => done(null);
  });
}

// ---------- Generic confirm modal (replaces window.confirm) ----------
function showConfirm(title, body, { okText = '确认', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $('confirm-modal');
    if (!modal) { resolve(window.confirm(`${title}\n\n${body}`)); return; }
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body || '';
    const okBtn = $('confirm-ok');
    const cancelBtn = $('confirm-cancel');
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    okBtn.className = danger ? 'primary-btn danger' : 'primary-btn';
    modal.hidden = false;

    const cleanup = (result) => {
      modal.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', keyHandler);
      resolve(result);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    };
    document.addEventListener('keydown', keyHandler);

    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    modal.onclick = (e) => { if (e.target === modal) cleanup(false); };
  });
}

function pickProject() {
  return new Promise((resolve) => {
    const modal = $('project-picker-modal');
    const list = $('project-picker-list');
    if (!modal || !list) { resolve(null); return; }
    list.innerHTML = state.projects.map(p => `
      <button data-id="${escapeHtml(p.id)}">${p.emoji ? p.emoji + ' ' : ''}${escapeHtml(p.name)}</button>
    `).join('');
    modal.hidden = false;
    const done = (res) => { modal.hidden = true; resolve(res); };
    list.querySelectorAll('[data-id]').forEach(b => {
      b.addEventListener('click', () => done(b.dataset.id));
    });
    $('project-picker-cancel').onclick = () => done(null);
  });
}

// ---------- Summarize ----------
function setupSummarize() {
  $('btn-summary')?.addEventListener('click', openSummarize);
  $('sum-close')?.addEventListener('click', closeSummarize);
  $('sum-run')?.addEventListener('click', runSummarize);
  $('sum-save')?.addEventListener('click', saveSummaryAsCard);
  $('sum-close-result')?.addEventListener('click', closeSummarize);
  // v1.18: "按需生成建议" 按钮，调单独的 /api/suggest 避免重跑 summary
  $('sum-gen-suggestion')?.addEventListener('click', async () => {
    const btn = $('sum-gen-suggestion');
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const data = await api('/api/suggest', {
        method: 'POST',
        body: JSON.stringify({ summary: lastSummary?.summary || '' }),
        timeoutMs: LLM_TIMEOUT_MS,
      });
      if (data.suggestion) {
        if (lastSummary) lastSummary.suggestion = data.suggestion;
        $('sum-suggestion-section').hidden = false;
        $('sum-suggestion').innerHTML = applyInlineHighlights(renderMarkdown(data.suggestion));
        $('sum-gen-suggestion-wrap').hidden = true;
      }
    } catch (e) {
      toast('建议生成失败：' + e.message, true);
      btn.disabled = false;
      btn.textContent = '🔮 生成下一步建议';
    }
  });
}

function openSummarize() {
  const modal = $('summarize-modal');
  if (modal) modal.hidden = false;
  $('sum-config').hidden = false;
  $('sum-result').hidden = true;
  $('sum-loading').hidden = true;
}

function closeSummarize() {
  const modal = $('summarize-modal');
  if (modal) modal.hidden = true;
}

let lastSummary = null;

async function runSummarize() {
  const timeRange = document.querySelector('input[name="sum-time"]:checked')?.value || '7d';
  const project = document.querySelector('input[name="sum-proj"]:checked')?.value || state.currentTab;
  const tag_filter = document.querySelector('input[name="sum-tag"]:checked')?.value || 'all';
  const include_progress = !!$('sum-include-progress')?.checked;
  const include_knowledge = !!$('sum-include-knowledge')?.checked;
  const generate_suggestion = !!$('sum-generate-suggestion')?.checked;
  $('sum-config').hidden = true;
  $('sum-loading').hidden = false;
  try {
    const data = await api('/api/summarize', {
      method: 'POST',
      body: JSON.stringify({ timeRange, project, tag_filter, include_progress, include_knowledge, generate_suggestion }),
      timeoutMs: LLM_TIMEOUT_MS,  // v1.16.9 · 一键整理必须走 60s 超时
    });
    lastSummary = { ...data, timeRange, project };
    $('sum-loading').hidden = true;
    $('sum-result').hidden = false;
    const meta = data.meta || {};
    const tags = [];
    if (meta.tag_filter && meta.tag_filter !== 'all') tags.push(`tag=${meta.tag_filter}`);
    if (meta.include_progress) tags.push('含进度卡');
    if (meta.include_knowledge) tags.push('含知识卡');
    const tagStr = tags.length ? ' · ' + tags.join(' · ') : '';
    $('sum-meta').textContent = `近 ${meta.days} 天 · ${meta.project === 'all' ? '全部项目' : meta.project} · ${meta.noteCount} 条${tagStr}`;
    $('sum-body').innerHTML = applyInlineHighlights(renderMarkdown(data.summary || ''));
    if (data.suggestion) {
      $('sum-suggestion-section').hidden = false;
      $('sum-suggestion').innerHTML = applyInlineHighlights(renderMarkdown(data.suggestion));
      $('sum-gen-suggestion-wrap').hidden = true;
    } else {
      $('sum-suggestion-section').hidden = true;
      // v1.18: 未勾选"同时生成建议"时显示按需按钮
      const wrap = $('sum-gen-suggestion-wrap');
      if (wrap) { wrap.hidden = false; const btn = $('sum-gen-suggestion'); if (btn) { btn.disabled = false; btn.textContent = '🔮 生成下一步建议'; } }
    }
  } catch (e) {
    $('sum-loading').hidden = true;
    $('sum-config').hidden = false;
    toast(e.message, true);
  }
}

async function saveSummaryAsCard() {
  if (!lastSummary) return;
  const meta = lastSummary.meta || {};
  const projectId = (meta.project === 'all') ? (state.projects[0]?.id || 'ai-cap') : meta.project;
  const header = `📊 近 ${meta.days} 天整理（${meta.project === 'all' ? '全部项目' : meta.project}） · 共 ${meta.noteCount} 条\n\n`;
  const summaryContent = header + (lastSummary.summary || '');

  const saveBtn = $('sum-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const summaryNote = await api('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, content: summaryContent, card_type: 'summary' }),
    });
    state.notes.unshift(summaryNote);

    // 如果有建议卡，一并保存
    if (lastSummary.suggestion) {
      const suggestionContent = `🔮 下一步建议（基于上方 ${meta.noteCount} 条记录的 AI 整理）\n\n${lastSummary.suggestion}`;
      try {
        const sNote = await api('/api/notes', {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, content: suggestionContent, card_type: 'suggestion' }),
        });
        state.notes.unshift(sNote);
      } catch (e2) {
        // 建议卡保存失败不影响 summary 卡
        toast('整理已保存，建议卡保存失败：' + e2.message, true);
      }
    }

    renderFeed();
    closeSummarize();
    toast(lastSummary.suggestion ? '已保存 2 张卡片（整理+建议）' : '已保存为卡片');
  } catch (e) {
    toast('保存失败：' + e.message, true);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ---------- Export (MD via navigator.share or download) ----------
async function runExport() {
  const project = $('settings-export-project')?.value || 'all';
  const tag = $('settings-export-tag')?.value || 'all';
  const btn = $('settings-export-run');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    const resp = await fetch(`/api/export?project=${encodeURIComponent(project)}&tag=${encodeURIComponent(tag)}&format=md`);
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
    const md = await resp.text();
    const now = new Date().toISOString().slice(0, 10);
    const filename = `projectfeed-${project}-${now}.md`;

    // iOS Safari 原生分享优先（支持邮件 / 存文件 / 复制）
    if (navigator.share && navigator.canShare) {
      const file = new File([md], filename, { type: 'text/markdown' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'projectfeed 导出', text: filename });
        toast('已打开分享菜单');
        return;
      }
    }
    // fallback: 浏览器下载
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('已下载：' + filename);
  } catch (e) {
    toast('导出失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '生成并分享'; }
  }
}

// Block-aware markdown renderer: headings, ol/ul lists, hr, tables, bold/italic/code, paragraphs
function renderMarkdownTables(text) {
  // Match: |header|header|\n|---|---|\n|body|body|  (+ trailing rows)
  return text.replace(
    /(^|\n)(\|[^\n]+\|)[ \t]*\n(\|[\s:|\-]+\|)[ \t]*\n((?:\|[^\n]+\|[ \t]*\n?)+)/g,
    (m, lead, header, sep, body) => {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const headers = cells(header);
      const rows = body.trim().split('\n').map(cells);
      const th = headers.map(c => `<th>${c}</th>`).join('');
      const trs = rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('');
      return `${lead}<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>\n`;
    }
  );
}

function renderMarkdown(md) {
  let raw = escapeHtml(md || '').trim();
  if (!raw) return '';

  // Handle tables first (block-level pre-pass on escaped text)
  raw = renderMarkdownTables(raw);

  const lines = raw.split('\n');
  const out = [];
  let listType = null;   // 'ul' | 'ol'
  let listBuf = [];

  function flushList() {
    if (listType && listBuf.length) {
      out.push(`<${listType}>${listBuf.join('')}</${listType}>`);
    }
    listType = null;
    listBuf = [];
  }

  for (const ln of lines) {
    const ulMatch = ln.match(/^\s*[-*]\s+(.+)$/);
    const olMatch = ln.match(/^\s*\d+\.\s+(.+)$/);
    const hrMatch = ln.match(/^\s*[-*_]{3,}\s*$/);
    const h3 = ln.match(/^###\s+(.+)$/);
    const h2 = ln.match(/^##\s+(.+)$/);
    const h1 = ln.match(/^#\s+(.+)$/);

    if (ulMatch) {
      if (listType !== 'ul') flushList();
      listType = 'ul';
      listBuf.push(`<li>${ulMatch[1]}</li>`);
      continue;
    }
    if (olMatch) {
      if (listType !== 'ol') flushList();
      listType = 'ol';
      listBuf.push(`<li>${olMatch[1]}</li>`);
      continue;
    }

    flushList();

    if (hrMatch) { out.push('<hr/>'); continue; }
    if (h3) { out.push(`<h3>${h3[1]}</h3>`); continue; }
    if (h2) { out.push(`<h2>${h2[1]}</h2>`); continue; }
    if (h1) { out.push(`<h1>${h1[1]}</h1>`); continue; }
    out.push(ln);
  }
  flushList();

  // Split by blank-line boundaries into blocks; wrap non-block text in <p> with <br/> for inner newlines
  let html = out.join('\n');
  const blocks = html.split(/\n\s*\n+/);
  html = blocks.map(b => {
    const t = b.trim();
    if (!t) return '';
    if (/^<(h\d|ul|ol|hr|table|blockquote|pre)/.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br/>')}</p>`;
  }).join('\n');

  // Inline formatting — run after block so we don't fight with <li> content
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  return html;
}

// ---------- v1.17 · Add project ----------
// 注意：和文件顶部 EMOJI_POOL（TeamFeed 留下的动物 emoji）不同，这里是项目类 emoji
const PROJECT_EMOJI_POOL = [
  '🔌','🦾','🧠','🚀','🛠','📊','🔬','💡','🧪','🏭',
  '📐','🔧','🧬','📡','🌐','⚛️','🎯','🎨','🛩','🚢',
  '🔋','💼','🧭','🏢','📚','📮','🎭','🛰','🗂','📦',
  '🎬','🎙','🧰','🔭','🪄','💎','🌟','🧩','🏗','⚙️',
];
function randomProjectEmoji() {
  return PROJECT_EMOJI_POOL[Math.floor(Math.random() * PROJECT_EMOJI_POOL.length)];
}

function setupAddProject() {
  $('settings-add-project')?.addEventListener('click', openAddProject);
  $('ap-cancel')?.addEventListener('click', closeAddProject);
  $('ap-emoji-dice')?.addEventListener('click', () => {
    $('ap-emoji').value = randomProjectEmoji();
  });
  $('ap-submit')?.addEventListener('click', submitAddProject);
  $('add-project-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAddProject();
  });
}

function openAddProject() {
  $('ap-name').value = '';
  $('ap-emoji').value = randomProjectEmoji();
  $('ap-description').value = '';
  const p2Radio = document.querySelector('input[name="ap-priority"][value="P2"]');
  if (p2Radio) p2Radio.checked = true;
  $('add-project-modal').hidden = false;
  setTimeout(() => $('ap-name')?.focus(), 50);
}

function closeAddProject() {
  $('add-project-modal').hidden = true;
}

async function submitAddProject() {
  const name = $('ap-name').value.trim();
  const emoji = $('ap-emoji').value.trim() || '📁';
  const priority = document.querySelector('input[name="ap-priority"]:checked')?.value || 'P2';
  const description = $('ap-description').value.trim();
  if (!name) {
    toast('项目名称必填', true);
    $('ap-name').focus();
    return;
  }
  const btn = $('ap-submit');
  if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
  try {
    const proj = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, emoji, priority, description }),
      timeoutMs: 15000,  // Todoist API 偶尔慢，15s 留余量
    });
    // 本地 state 加新项目（免再拉 /api/config）
    state.projects.push(proj);
    state.currentTab = proj.id;
    // 关闭 modal + 刷新 UI
    closeAddProject();
    closeSettings();
    renderTabs();
    renderSumProjects();
    await refresh();
    toast(`已创建 ${emoji} ${name}`);
  } catch (e) {
    toast('创建失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '创建'; }
  }
}

// ---------- Settings modal ----------
const DEFAULT_TAB_KEY = 'projectfeed.default-tab';

function setupSettings() {
  $('btn-settings')?.addEventListener('click', openSettings);
  $('settings-close')?.addEventListener('click', closeSettings);
  $('settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  $('settings-default-tab')?.addEventListener('change', (e) => {
    localStorage.setItem(DEFAULT_TAB_KEY, e.target.value);
    const label = e.target.selectedOptions[0]?.textContent || e.target.value;
    toast(`默认 Tab → ${label}`);
  });
  $('settings-export-run')?.addEventListener('click', runExport);
  $('settings-hard-refresh')?.addEventListener('click', async () => {
    if (!(await showConfirm('强制刷新', '将清除本地 Service Worker 缓存并重新加载。继续？'))) return;
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } finally {
      location.reload();
    }
  });
}

function openSettings() {
  renderSettingsSelects();
  renderAboutProjects();
  $('settings-modal').hidden = false;
}
function closeSettings() {
  $('settings-modal').hidden = true;
}

function renderSettingsSelects() {
  const defaultTabEl = $('settings-default-tab');
  const exportProjEl = $('settings-export-project');
  if (defaultTabEl) {
    const cur = localStorage.getItem(DEFAULT_TAB_KEY) || 'all';
    let opts = `<option value="all"${cur === 'all' ? ' selected' : ''}>全部</option>`;
    for (const p of state.projects) {
      const label = `${p.emoji || ''} ${p.name}`.trim();
      opts += `<option value="${escapeHtml(p.id)}"${cur === p.id ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }
    defaultTabEl.innerHTML = opts;
  }
  if (exportProjEl) {
    let opts = `<option value="all">全部项目</option>`;
    for (const p of state.projects) {
      const label = `${p.emoji || ''} ${p.name}`.trim();
      opts += `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    }
    exportProjEl.innerHTML = opts;
  }
}
function renderAboutProjects() {
  const el = $('about-projects');
  const cnt = $('about-project-count');
  if (!el) return;
  if (cnt) cnt.textContent = state.projects.length;
  const byPrio = {};
  for (const p of state.projects) {
    const k = p.priority || 'P2';
    (byPrio[k] = byPrio[k] || []).push(p);
  }
  const order = ['P0', 'P1', 'P2', 'continuous'];
  const labelMap = { P0: 'P0', P1: 'P1', P2: 'P2', continuous: '持续' };
  let html = '';
  for (const k of order) {
    const arr = byPrio[k];
    if (!arr || !arr.length) continue;
    html += `<li class="about-prio-head"><span class="muted small">${labelMap[k]}</span></li>`;
    for (const p of arr) {
      html += `<li><span>${p.emoji ? p.emoji + ' ' : ''}${escapeHtml(p.name)} <span class="muted tiny">(${escapeHtml(p.id)})</span></span></li>`;
    }
  }
  el.innerHTML = html;
}

// ---------- Header / Summary projects ----------
function renderSumProjects() {
  const el = $('sum-projects-list');
  if (!el) return;
  const items = [{ id: 'all', name: '全部项目', emoji: '' }, ...state.projects];
  el.innerHTML = items.map((p, i) => `
    <label class="radio-row">
      <input type="radio" name="sum-proj" value="${escapeHtml(p.id)}" ${i === 0 ? 'checked' : ''}>
      <span>${p.emoji ? p.emoji + ' ' : ''}${escapeHtml(p.name)}</span>
    </label>
  `).join('');
}

// ---------- Refresh ----------
async function refresh() {
  try {
    await loadFeed();
    renderFeed();
  } catch (e) {
    console.error('[refresh]', e);
    toast('加载失败：' + e.message, true);
  }
}

// ---------- Init ----------
async function initApp() {
  $('app').hidden = false;
  $('btn-summary').hidden = false;
  try {
    const defaultTab = localStorage.getItem(DEFAULT_TAB_KEY);
    if (defaultTab && defaultTab !== 'all') state.currentTab = defaultTab;

    // v1.18: config 和 feed 并行，省 1 个 RTT（config 完成后再验证 tab 合法性）
    await Promise.all([loadConfig(), loadFeed()]);

    if (state.currentTab !== 'all' && !state.projects.some(p => p.id === state.currentTab)) {
      state.currentTab = 'all';
    }
    renderTabs();
    renderSumProjects();
    renderFeed();
  } catch (e) {
    console.error('[init]', e);
    toast('初始化失败：' + (e.stack || e.message), true);
  }
}

// ---------- Composer scroll-hide (v1.22.5) ----------
// 逻辑：接近底部或向上翻旧内容 → 隐藏；向下回到新内容或在顶部 → 显示
function setupComposerScrollHide() {
  const composer = document.querySelector('.composer');
  if (!composer) return;

  let lastY = window.scrollY;
  let ticking = false;

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      const delta = y - lastY;
      const atTop = y <= 20;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const nearBottom = y + viewportHeight >= document.documentElement.scrollHeight - 120;

      if (atTop) {
        // 在顶部（新内容区域）：始终显示
        composer.classList.remove('composer-hidden');
      } else if (nearBottom || delta > 6) {
        // 接近底部 或 向上翻内容（看旧内容）：隐藏，让最后一张卡片完整露出
        composer.classList.add('composer-hidden');
      } else if (delta < -6) {
        // 向下滚回（往新内容方向）：显示
        composer.classList.remove('composer-hidden');
      }

      lastY = y;
      ticking = false;
    });
  }, { passive: true });

  // 点击输入框时确保显示
  composer.addEventListener('focusin', () => {
    composer.classList.remove('composer-hidden');
  });
}

// ---------- Bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  try {
    setupComposer();
    setupSummarize();
    setupSettings();
    setupChat();
    setupSearch();
    setupAiClickOutside();
    setupSwipeTabs();   // v1.16.8
    setupAddProject(); // v1.17
    setupComposerScrollHide(); // v1.22.4
    $('btn-refresh')?.addEventListener('click', async () => { invalidateFeedCache(); await refresh(); });
  } catch (e) {
    console.error('[setup]', e);
    toast('页面设置失败：' + e.message, true);
  }
  initApp();
});
