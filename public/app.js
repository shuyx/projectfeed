// ============================================================
// projectfeed app.js — v1.7 · tab sort by 7-day activity (hot projects first)
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
};

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const resp = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }
  return resp.json();
}

async function loadConfig() {
  const data = await api('/api/config');
  state.projects = data.projects || [];
  state.people = [];    // not used in single-user mode
  // 并发拉 7 天活跃度，用于 Tab 排序（最近热门项目前置）
  try {
    const s = await api('/api/project-stats?days=7');
    state.projectStats = s.stats || {};
  } catch {
    state.projectStats = {};
  }
}

async function loadFeed(append = false) {
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams();
    if (state.currentTab !== 'all') params.set('project', state.currentTab);
    params.set('limit', '30');
    if (append && state.notes.length > 0) {
      params.set('before', state.notes[state.notes.length - 1].created_at);
    }
    const data = await api('/api/notes?' + params.toString());
    state.notes = append ? [...state.notes, ...(data.notes || [])] : (data.notes || []);
    state.hasMore = !!data.hasMore;
  } finally {
    state.loading = false;
  }
}

async function postNote(project_id, content, tag) {
  return api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ project_id, content, tag }),
  });
}

async function retryTodoistSync(noteId) {
  return api(`/api/notes/${noteId}/retry-todoist`, { method: 'POST' });
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
  });
}

async function summarize(timeRange, project, include_progress, include_knowledge) {
  return api('/api/summarize', {
    method: 'POST',
    body: JSON.stringify({ timeRange, project, include_progress, include_knowledge }),
  });
}

async function fetchChatHistory(parentNoteId) {
  return api(`/api/chat/${encodeURIComponent(parentNoteId)}`);
}

async function sendChat(parentNoteId, message, history) {
  return api('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ parent_note_id: parentNoteId, message, history }),
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

function extractTitle(content, max = 40) {
  const first = String(content || '').split('\n').find(l => l.trim()) || '知识卡';
  const plain = first.replace(/\*\*/g, '').trim();
  return plain.length > max ? plain.slice(0, max) + '…' : plain;
}

function renderProfileCard(n) {
  return `
    <article class="note is-profile" data-id="${escapeHtml(n.id)}">
      <div class="note-head">
        <span class="profile-badge">📌 项目基础档案</span>
        <button class="edit-btn" aria-label="编辑基础档案" title="编辑">✏️</button>
      </div>
      <div class="note-body">${applyInlineHighlights(renderMarkdown(n.content))}</div>
      <div class="note-foot">
        <span class="note-time muted tiny">${n.updated_at ? '更新于 ' + formatCardDateTime(n.updated_at) : formatCardDateTime(n.created_at)}</span>
        <span class="muted tiny">ℹ️ 整理时作为 AI 背景资料</span>
      </div>
    </article>
  `;
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

function renderFeed() {
  const el = $('feed');
  if (!el) return;

  if (!state.notes.length) {
    el.innerHTML = renderEmpty();
    return;
  }

  // 分离 profile 卡：pin 在选中项目的 feed 顶部，不参与时间分组
  // "全部" tab 下不显示 profile（太多会堆满，且"项目基础信息"属于单项目视图）
  const profileNotes = state.notes.filter(n => n.card_type === 'profile');
  const regularNotes = state.notes.filter(n => n.card_type !== 'profile');

  let profileHtml = '';
  if (state.currentTab !== 'all') {
    const profile = profileNotes.find(p => p.project_id === state.currentTab);
    if (profile) {
      profileHtml = `<div class="profile-wrap">${renderProfileCard(profile)}</div>`;
    }
  }

  if (!regularNotes.length && !profileHtml) {
    el.innerHTML = renderEmpty();
    return;
  }

  const groups = groupNotesByDate(regularNotes);
  const projectMap = Object.fromEntries(state.projects.map(p => [p.id, p]));
  const showProjectBadge = state.currentTab === 'all';

  const groupsHtml = groups.map(g => `
    <div class="date-group">
      <div class="date-divider">${escapeHtml(g.label)}</div>
      ${g.notes.map(n => {
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

        // Tag badge（主卡手动打的，以及 progress 卡自动的）
        const tagMap = { todo: { icon: '🎯', label: '待办' }, progress: { icon: '✅', label: '进展' }, idea: { icon: '💡', label: '想法' } };
        const tagInfo = n.tag ? tagMap[n.tag] : null;
        const tagBadge = tagInfo ? `<span class="tag-badge tag-${n.tag}">${tagInfo.icon} ${tagInfo.label}</span>` : '';

        let kindBadge = '';
        if (isSummary) kindBadge = '<span class="summary-badge">🤖 AI 整理</span>';
        else if (isSuggestion) kindBadge = '<span class="suggestion-badge">🔮 下一步建议</span>';
        else if (isProgress) {
          const srcLabel = n.source === 'feedback' ? '反馈'
                          : n.source === 'recap' ? '复盘'
                          : n.source === 'capsule' ? '时间胶囊'
                          : '同步';
          kindBadge = `<span class="progress-badge">📥 ${srcLabel}</span>`;
        }

        // Todoist 状态按钮（仅 tag=todo 的主卡）
        let todoistBtn = '';
        if (isMain && n.tag === 'todo') {
          if (n.todoist_task_id) {
            todoistBtn = `<button class="todoist-btn synced" data-synced="1" title="已同步 Todoist" aria-label="Todoist">🔗</button>`;
          } else {
            todoistBtn = `<button class="todoist-btn failed" title="同步 Todoist 失败，点击重试" aria-label="重试 Todoist">⚠️</button>`;
          }
        }

        const classes = ['note'];
        if (isSummary) classes.push('is-summary');
        if (isSuggestion) classes.push('is-suggestion');
        if (isProgress) classes.push('is-progress');
        if (isMain && n.tag) classes.push(`tag-bg-${n.tag}`);

        return `
          <article class="${classes.join(' ')}" data-id="${escapeHtml(n.id)}">
            <div class="note-head">
              ${tagBadge}
              ${kindBadge}
              ${todoistBtn}
              ${isMain ? '<button class="chat-btn" aria-label="问 AI" title="基于这条进展问 AI">🤖</button>' : ''}
              ${!isSuggestion ? '<button class="edit-btn" aria-label="编辑" title="编辑">✏️</button>' : ''}
              <button class="delete-btn" aria-label="删除">✕</button>
            </div>
            <div class="note-body">${applyInlineHighlights(renderMarkdown(n.content))}</div>
            <div class="note-foot">
              <span class="note-time">${formatCardDateTime(n.created_at)}${n.updated_at ? ' · 已编辑' : ''}</span>
              ${showProjectBadge ? `<span class="note-project">${projLabel}</span>` : '<span></span>'}
            </div>
          </article>
          ${knowledgeHtml}
        `;
      }).join('')}
    </div>
  `).join('');

  const sentinel = state.hasMore ? '<div id="feed-sentinel" class="feed-sentinel"><span class="spinner"></span> 加载更多…</div>' : '';

  el.innerHTML = profileHtml + groupsHtml + sentinel;

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

// ---------- Composer ----------
function updateComposerSpacer() {
  const c = document.querySelector('.composer');
  if (!c) return;
  const h = c.offsetHeight;
  if (h > 0) document.documentElement.style.setProperty('--composer-h', h + 'px');
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
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateComposerSpacer);
  }
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(updateComposerSpacer);
    ro.observe(document.querySelector('.composer'));
  }

  correctBtn?.addEventListener('click', async () => {
    const current = input.value.trim();
    if (!current) { toast('先输入内容', true); return; }
    correctBtn.disabled = true;
    correctBtn.textContent = '…';
    try {
      const { corrected, changed } = await correctText(current);
      if (!changed || corrected === current) {
        toast('AI 认为无需修改');
      } else {
        const ok = await showCorrectDiff(current, corrected);
        if (ok) {
          input.value = corrected;
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        }
      }
    } catch (err) {
      toast('校对失败：' + err.message, true);
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
    } else {
      $('sum-suggestion-section').hidden = true;
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
    // 读 localStorage 的默认 tab 偏好
    const defaultTab = localStorage.getItem(DEFAULT_TAB_KEY);
    if (defaultTab && defaultTab !== 'all') state.currentTab = defaultTab;

    await loadConfig();

    // 验证 default tab 仍然合法（项目可能被删）
    if (state.currentTab !== 'all' && !state.projects.some(p => p.id === state.currentTab)) {
      state.currentTab = 'all';
    }

    renderTabs();
    renderSumProjects();
    await loadFeed();
    renderFeed();
  } catch (e) {
    console.error('[init]', e);
    toast('初始化失败：' + (e.stack || e.message), true);
  }
}

// ---------- Bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  try {
    setupComposer();
    setupSummarize();
    setupSettings();
    setupChat();
    $('btn-refresh')?.addEventListener('click', refresh);
  } catch (e) {
    console.error('[setup]', e);
    toast('页面设置失败：' + e.message, true);
  }
  initApp();
});
