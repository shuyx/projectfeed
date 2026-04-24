-- 0003_tags.sql: 标签系统 + Todoist 同步字段

ALTER TABLE notes ADD COLUMN tag TEXT;                -- 'todo' | 'progress' | 'idea'
ALTER TABLE notes ADD COLUMN todoist_task_id TEXT;    -- 待办卡同步 Todoist 后存任务 id

-- 回填：历史主卡全部打 'progress'（方案 B），历史 progress 卡也打 'progress'
UPDATE notes SET tag = 'progress' WHERE card_type IN ('main', 'progress') AND tag IS NULL;

CREATE INDEX IF NOT EXISTS idx_notes_tag ON notes(tag);
