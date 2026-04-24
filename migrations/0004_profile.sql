-- 0004_profile.sql: profile 卡（项目基础档案 · 每项目最多一张）
-- card_type 列本身是 TEXT，不需 ALTER。只加 UNIQUE 部分索引确保每项目唯一。
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_profile_unique
  ON notes(project_id)
  WHERE card_type = 'profile';
