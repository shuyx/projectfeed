-- 12 个 Portfolio 项目 seed（与 Todoist Portfolio 面板一致）

-- P0（3）
INSERT OR IGNORE INTO projects (id, name, emoji, priority, sort_order, created_at) VALUES
  ('xiangcheng',      '祥承电子',       '🔌', 'P0', 1,  '2026-04-24T00:00:00.000Z'),
  ('dechuang-robot',  '德创具身智能',    '🦾', 'P0', 2,  '2026-04-24T00:00:00.000Z'),
  ('bci',             '脑机接口',        '🧠', 'P0', 3,  '2026-04-24T00:00:00.000Z');

-- P1（3）
INSERT OR IGNORE INTO projects (id, name, emoji, priority, sort_order, created_at) VALUES
  ('dechuang-sched',  '德创调度',        '📋', 'P1', 4,  '2026-04-24T00:00:00.000Z'),
  ('nantong',         '南通船舶',        '🚢', 'P1', 5,  '2026-04-24T00:00:00.000Z'),
  ('kuangchuang',     '宽创文化具身',    '🎨', 'P1', 6,  '2026-04-24T00:00:00.000Z');

-- P2（4）
INSERT OR IGNORE INTO projects (id, name, emoji, priority, sort_order, created_at) VALUES
  ('drone',           '无人机',          '🛩', 'P2', 7,  '2026-04-24T00:00:00.000Z'),
  ('embodied-data',   '具身数据',        '📦', 'P2', 8,  '2026-04-24T00:00:00.000Z'),
  ('fmea',            '西门子 FMEA',     '🔧', 'P2', 9,  '2026-04-24T00:00:00.000Z'),
  ('emba',            'EMBA 论文',       '📚', 'P2', 10, '2026-04-24T00:00:00.000Z');

-- 持续（2）
INSERT OR IGNORE INTO projects (id, name, emoji, priority, sort_order, created_at) VALUES
  ('ai-cap',          'AI 能力建设',     '⚛️', 'continuous', 11, '2026-04-24T00:00:00.000Z'),
  ('personal',        '个人与家庭',      '📮', 'continuous', 12, '2026-04-24T00:00:00.000Z');
