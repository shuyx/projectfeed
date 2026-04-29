-- v1.29: 任务时长（分钟）存储，配合时间块安排 picker
ALTER TABLE notes ADD COLUMN duration_minutes INTEGER DEFAULT 0;
