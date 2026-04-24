# projectfeed

个人 Portfolio 进展跟踪 App（PWA）· Cloudflare Workers + D1 + 静态前端。

## 特性

- 📱 PWA · iPhone 添加到主屏幕当 App 用
- 📋 12 个 Portfolio 项目 Tab（按 P0/P1/P2/持续 分组）
- 🗂️ 四种卡片：
  - **主卡**（main）— 自己手动录入
  - **知识卡**（knowledge）— 问 AI 对话提炼，挂在主卡下
  - **进度卡**（progress）— 从 Obsidian `/反馈` `/复盘` 胶囊同步来的精简镜像
  - **总结卡**（summary）— AI 一键整理产出
- 🤖 MiniMax 加持：AI 纠错 · 问 AI 多轮对话 · 一键整理（三种组合）
- 🔄 `/api/progress` 同步端点（X-Sync-Secret 鉴权），供 Obsidian skill 挂载
- 🔓 无登录、无密码（单用户）

## 本地开发

```bash
cd ~/projectfeed
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev   # http://localhost:8787
```

## 部署

```bash
# 首次：创建远程 D1
npx wrangler d1 create projectfeed-db
# 把输出的 database_id 填进 wrangler.toml

# 配 secrets
npx wrangler secret put MINIMAX_API_KEY   # 从 serects api.env 的 ## MiniMax API 粘贴
npx wrangler secret put SYNC_SECRET        # 给 Obsidian skill 用的共享密钥

# 远程建表 + seed
npm run db:migrate:remote
npm run db:seed:remote

# 部署 Worker
npm run deploy
# 访问 https://projectfeed.<subdomain>.workers.dev
```

## 一键整理的三种组合

弹窗里两个勾选框：

| 勾选 | 效果 |
|---|---|
| 无 | 只总结主卡（自己主动录入） |
| 进度 ☑ | 主卡 + 进度卡（Obsidian 同步镜像） |
| 进度 ☑ 知识 ☑ | 主卡 + 进度卡 + 知识卡（AI 问答沉淀也作材料） |

默认勾选"进度卡"，不勾"知识卡"。

## 架构

```
CF Pages (静态前端 PWA)
   ↓
CF Workers (src/worker.js, Hono)
   ↓
CF D1 (notes + projects + chats 三表)
```

全部在 Cloudflare 免费额度内，成本 $0。

## 文档

设计方案：`~/Obsidian/kevinob/brainstorm/2026-04-23-项目进展小组网页-teamfeed.md`（基于 teamfeed 演化）

方法论：`~/Obsidian/kevinob/🦾 Openclaw/skills/52-研究工作流方法论-四工具认知架构.md`
