-- v1.13: Todo 卡打勾归档
-- archived=1 的卡从 feed 默认过滤掉；可通过 filter=archived 查看
-- archived_at 记录完成时间，方便后续"已完成"视图的时间排序

ALTER TABLE notes ADD COLUMN archived INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN archived_at TEXT;

-- 用于常见查询"默认过滤 archived"加速
CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(archived);
