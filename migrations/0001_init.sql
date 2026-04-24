-- projectfeed 完整 schema（单用户，无认证）
-- 四种 card_type：main / knowledge / progress / summary

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  card_type TEXT NOT NULL DEFAULT 'main',   -- main | knowledge | progress | summary
  parent_id TEXT,                            -- knowledge 卡指向 main
  source TEXT,                               -- progress 卡来源：feedback | recap | capsule | manual
  source_ref TEXT,                           -- 源 .md 路径或时间胶囊名
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_feed      ON notes(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_time      ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_parent    ON notes(parent_id);
CREATE INDEX IF NOT EXISTS idx_notes_card_type ON notes(card_type);
CREATE INDEX IF NOT EXISTS idx_notes_source    ON notes(source);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT,
  priority TEXT,           -- P0 | P1 | P2 | continuous
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Chat 会话（问 AI 对话历史）
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  parent_note_id TEXT NOT NULL,
  messages TEXT NOT NULL,  -- JSON: [{role, content, ts}]
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_parent ON chats(parent_note_id);
