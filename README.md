# projectfeed

> 个人 Portfolio 进展追踪 App · PWA · Cloudflare Workers + D1 + 静态前端

**线上地址**：[feed.ai-robot.fans](https://feed.ai-robot.fans)

一个为高密度多项目工作者设计的 PWA。iPhone 添加到主屏幕当 App 用，记录每天在做什么、花了多少时间、任务推进到哪了。与 Todoist 双向同步，与 Obsidian 进展日志单向同步。

---

## 核心功能

### 卡片体系
| 类型 | 说明 |
|------|------|
| **主卡**（main） | 手动录入的进展、待办、想法、里程碑 |
| **进度卡**（progress） | 从 Obsidian `/反馈` `/复盘` 同步来的精简镜像 |
| **知识卡**（knowledge） | 向 AI 提问后提炼的结论，挂载在主卡下 |
| **总结卡**（summary） | AI 一键整理产出 |
| **建议卡**（suggestion） | AI 下一步行动建议 |

### 待办任务系统（v1.13–v1.29）
- **标签分类**：待办 / 进展 / 想法 / 里程碑
- **进行中状态**（v1.25）：▶️/⏸ 切换，进行中卡片显示渐变背景 + 置顶排序
- **中文时间解析**（v1.15）：输入"明天下午三点"自动识别截止时间
- **五级紧迫度色阶**（v1.15）：今天（红）→ 明天（橙）→ 三天内（金）→ 一周内（蓝）→ 更远（灰）
- **过期任务重设**（v1.26.1）：点击过期标签弹出 popup，选今天/明天/本周五/下周一
- **时间块安排 picker**（v1.29）：⏰ 按钮弹出 bottom sheet，棘轮感滚鼓选起始时间（5 分钟粒度，速度感应跳格），时长递进（15 分钟起步），同步到 Todoist 日历时间块
- **任务拆解**（v1.20）：AI 将模糊描述拆解为 3-6 条 GTD 物理行动，批量创建

### 用时追踪（v1.26–v1.28）
- 点 ▶️ 开始计时，点 ⏸ 暂停累加，点 ✅ 完成时自动关闭计时
- 卡片底部实时显示计时 badge（`▶ 23m`）
- **⏱ 用时统计**视图：按项目分组展示任务用时明细
- **图表视图**（v1.28）：Chart.js 堆叠条形图 + 环形图，5 个时间维度（今日/本周/本月/近三月/全年），可按项目筛选切换

### AI 能力
- **多轮问答**：基于某条进展向 AI 提问，历史对话保留
- **AI 纠错**：发送前自动校对内容
- **一键整理**：选定范围（主卡/含进度卡/含知识卡）生成项目总结
- **任务拆解**：GTD 教练角色，将模糊背景拆解为可执行的物理行动
- LLM 后端：DeepSeek V4 Flash（快速）/ V4 Pro（深度）

### 视图与导航（v1.27）
- 项目 Tab 横向导航，左右滑动切换（v1.16.8）
- **项目分组视图**（默认）：「全部」tab 下所有卡片按项目分组
- **时间流视图**：按创建时间倒序排列
- 过滤条：待办 / 进展 / 想法 / 里程碑 / 反馈 / 总结 / 已完成 / ⏱ 用时

### Todoist 双向同步
- 创建待办卡 → 自动在 Todoist 对应项目创建任务
- 完成归档 → 自动关闭 Todoist 任务
- 安排时间块 → 更新 Todoist `due_datetime` + `duration`（日历时间块）
- 支持从设置页直接新建项目，自动同步到 Todoist

### Obsidian 进展同步
- `/api/progress` 端点（X-Sync-Secret 鉴权）
- 配合 Obsidian Skill `/反馈` `/复盘` 自动推送进度卡

---

## 架构

```
用户 (iPhone PWA / 桌面浏览器)
        ↓
Cloudflare Assets (静态前端: index.html / app.js / styles.css / sw.js)
        ↓
Cloudflare Workers (src/worker.js · Hono 框架)
        ↓
Cloudflare D1 (SQLite)
   ├── notes (主卡/知识卡/进度卡/总结卡)
   ├── projects (12个 Portfolio 项目)
   ├── chats (AI 对话历史)
   └── time_sessions (用时 session 日志)
        ↓ (可选)
DeepSeek API + Todoist API
```

全部运行在 Cloudflare 免费额度内，**成本 $0**。

---

## 数据库结构

```sql
-- 主卡片表
notes (
  id, project_id, content, card_type, parent_id, tag,
  source, source_ref, created_at, updated_at,
  todoist_task_id, archived, archived_at,
  due_at, status, total_seconds, session_start_at, duration_minutes
)

-- 项目表
projects (
  id, name, emoji, priority, sort_order,
  created_at, todoist_project_id
)

-- AI 对话
chats (id, parent_note_id, messages, created_at)

-- 用时 session 日志（v1.28+）
time_sessions (
  id, note_id, project_id,
  started_at, ended_at, duration_seconds
)
```

---

## 本地开发

```bash
git clone https://github.com/shuyx/projectfeed.git
cd projectfeed
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev   # → http://localhost:8787
```

需要配置的环境变量（`wrangler secret put`）：
- `DEEPSEEK_API_KEY` — DeepSeek API 密钥
- `TODOIST_API_TOKEN` — Todoist API Token
- `SYNC_SECRET` — Obsidian skill 同步鉴权密钥

---

## 部署到 Cloudflare

```bash
# 1. 创建 D1 数据库
npx wrangler d1 create projectfeed-db
# → 将 database_id 填入 wrangler.toml

# 2. 建表
npm run db:migrate:remote

# 3. 配置密钥
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put TODOIST_API_TOKEN
npx wrangler secret put SYNC_SECRET

# 4. 部署
npm run deploy
```

---

## 版本历史

| 版本 | 日期 | 核心功能 |
|------|------|---------|
| v1.0 | 2026-04-24 | 项目诞生：PWA 框架 + D1 + 进度卡同步 |
| v1.3 | 2026-04-24 | 标签系统 + Todoist 集成 + 导出 |
| v1.5 | 2026-04-24 | 项目档案卡 + 历史数据迁移 |
| v1.10 | 2026-04-24 | 统一折叠组件 + 全局搜索 |
| v1.13 | 2026-04-24 | 待办归档 + 已完成视图 |
| v1.15 | 2026-04-24 | 中文时间解析 + 五级紧迫度 + Todoist 截止时间 |
| v1.16 | 2026-04-24 | 跨项目移动/复制 + 自定义域名 + 性能优化 |
| v1.17 | 2026-04-24 | 设置页新建项目 + Todoist 项目动态映射 |
| v1.18 | 2026-04-25 | 性能优化（首屏并行化，DeepSeek 接入） |
| v1.20 | 2026-04-25 | AI 任务拆解（GTD + Todoist 批量创建） |
| v1.22 | 2026-04-25 | 全卡归档 + iOS PWA 底部遮挡修复 |
| v1.23 | 2026-04-26 | iOS 键盘联动 Composer |
| v1.25 | 2026-04-28 | 待办进行中状态（▶️/⏸ + 渐变背景） |
| v1.26 | 2026-04-28 | 用时追踪 + ⏱ 统计视图 + 过期任务重设 |
| v1.27 | 2026-04-28 | 视图重设计（项目分组默认 + filter-bar 优化） |
| v1.28 | 2026-04-29 | Chart.js 图表（堆叠条 + 环形 + 5 维度 + 项目筛选） |
| v1.29 | 2026-04-29 | 时间块安排 Picker（棘轮感滚鼓 + Todoist 时长同步） |

---

## 设计理念

这个 App 从一个核心痛点出发：**多项目并行时，很容易在任务切换中失去焦点，也很难回头看清楚自己的时间真的花在哪了**。

与现有工具的区别：
- Todoist 管任务，不管"我在做什么"的过程记录
- Obsidian 管知识，不管时间统计和 Todoist 同步
- projectfeed 是两者的枢纽层：写进展 → AI 提炼 → 推 Todoist → 量化时间

单用户设计，无认证，无账单，$0 成本运行。
