-- v1.28: 用时 session 日志（支持日/周维度图表聚合）
-- 每次 ▶️→⏸ 或 ▶️→✅ 时写入一条记录
-- started_at / ended_at 均为 UTC ISO 8601

CREATE TABLE IF NOT EXISTS time_sessions (
  id            TEXT    PRIMARY KEY,
  note_id       TEXT    NOT NULL,
  project_id    TEXT    NOT NULL,
  started_at    TEXT    NOT NULL,
  ended_at      TEXT    NOT NULL,
  duration_seconds INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_ended   ON time_sessions(ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON time_sessions(project_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_note    ON time_sessions(note_id, ended_at DESC);
