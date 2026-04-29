-- v1.25: 待办卡的"进行中"状态
-- 仅对 tag='todo' AND card_type='main' 有意义
-- 取值：'todo'（默认，未开始）| 'in_progress'（进行中）

ALTER TABLE notes ADD COLUMN status TEXT DEFAULT 'todo';

-- 加速 filter=todo 视图的"进行中置顶"排序
CREATE INDEX IF NOT EXISTS idx_notes_todo_status ON notes(status)
  WHERE tag = 'todo' AND card_type = 'main' AND (archived IS NULL OR archived = 0);
