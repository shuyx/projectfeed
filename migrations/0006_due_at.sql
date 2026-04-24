-- v1.15: todo 卡的截止时间（ISO 8601 带时区，如 2026-04-25T19:00:00+08:00）
-- NULL 表示无时间（用户没写可识别的时间表达）

ALTER TABLE notes ADD COLUMN due_at TEXT;

-- 加速 filter=todo 视图的"按 due_at 排序"查询
-- 只为 tag=todo + 未归档的索引，极窄
CREATE INDEX IF NOT EXISTS idx_notes_todo_due ON notes(project_id, due_at, created_at)
  WHERE tag = 'todo' AND (archived IS NULL OR archived = 0);
