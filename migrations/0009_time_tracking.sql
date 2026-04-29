-- v1.26: 待办任务用时追踪
-- total_seconds: 所有已完成 session 的累计用时（秒）
-- session_start_at: 当前正在计时的 session 开始时间（NULL = 未计时）

ALTER TABLE notes ADD COLUMN total_seconds INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN session_start_at TEXT;

-- 加速"用时统计"视图查询（只有有计时记录的 todo 卡才参与）
CREATE INDEX IF NOT EXISTS idx_notes_time_tracked ON notes(total_seconds, session_start_at)
  WHERE card_type = 'main' AND tag = 'todo';
