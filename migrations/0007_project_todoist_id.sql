-- v1.17: 把硬编码的 TODOIST_PROJECT_MAP 迁移到 DB
-- 允许用户从 App 设置页新增项目，自动建 Todoist list 并存 id 到这一列

ALTER TABLE projects ADD COLUMN todoist_project_id TEXT;

-- 回填现有 12 个项目（从 worker.js 硬编码 MAP 复制，保证行为一致）
UPDATE projects SET todoist_project_id = '6gQ8gmjjC6Pfx4Wc' WHERE id = 'xiangcheng';
UPDATE projects SET todoist_project_id = '6gQ8gp2QR2PMChrv' WHERE id = 'dechuang-robot';
UPDATE projects SET todoist_project_id = '6gQ8gp358vrfprc6' WHERE id = 'bci';
UPDATE projects SET todoist_project_id = '6gQ8gp664f6cWFmx' WHERE id = 'dechuang-sched';
UPDATE projects SET todoist_project_id = '6gQ8gpH57Wvcr9vM' WHERE id = 'nantong';
UPDATE projects SET todoist_project_id = '6gQhVJWVxHFjF95C' WHERE id = 'kuangchuang';
UPDATE projects SET todoist_project_id = '6gQ8gpJwGv8gGfRQ' WHERE id = 'drone';
UPDATE projects SET todoist_project_id = '6gQ8gpQCMQ5Xxq9R' WHERE id = 'embodied-data';
UPDATE projects SET todoist_project_id = '6gQ8gpXgcgmWr3RX' WHERE id = 'fmea';
UPDATE projects SET todoist_project_id = '6gQ8gpf3gFrXfwvV' WHERE id = 'emba';
UPDATE projects SET todoist_project_id = '6gQ8gprw8Jrf2h7Q' WHERE id = 'ai-cap';
UPDATE projects SET todoist_project_id = '6gQ8gpxc7HwpFr3J' WHERE id = 'personal';
