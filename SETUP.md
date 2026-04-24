# teamfeed 部署指南

## 架构

```
GitHub 仓库 (shuyx/project-web)
      ↓ git push main
GitHub Actions (.github/workflows/deploy.yml)
      ↓ wrangler deploy
Cloudflare Workers (teamfeed.<你的子域>.workers.dev)
      ├── 静态前端（public/）
      └── API（src/worker.js）
            ↓
        Cloudflare D1 (teamfeed-db)
```

---

## 一次性配置（大约 10 分钟）

### 第 1 步：生成 Cloudflare API Token

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. 点击 **Create Token**
3. 选 **Edit Cloudflare Workers** 模板 → 点 **Use template**
4. Zone Resources 可以全部保持 "All zones"；Account Resources 选你的账号
5. 点 **Continue to summary** → **Create Token**
6. **复制 token**（只显示一次，丢了只能重新建）

### 第 2 步：获取 Cloudflare Account ID

1. 在 CF Dashboard 右侧边栏找 **Account ID**（32 位 hex）
2. 或者命令行：`npx wrangler whoami`（登录后会列出）

### 第 3 步：在 GitHub 仓库配 Secrets

1. 打开 https://github.com/shuyx/project-web/settings/secrets/actions
2. 点 **New repository secret** 添加两条：
   - `CLOUDFLARE_API_TOKEN` = 第 1 步的 token
   - `CLOUDFLARE_ACCOUNT_ID` = 第 2 步的 account id

### 第 4 步：首次创建远程 D1 数据库

**本地执行（只需做一次）**：

```bash
cd ~/teamfeed
npx wrangler login                      # 如没登录过
npx wrangler d1 create teamfeed-db
# 输出会给你一个 database_id，复制它
```

**更新 wrangler.toml**：把 `database_id = "REPLACE_AFTER_wrangler_d1_create"` 改成真实 id。

**首次种子数据**（只需做一次）：

```bash
npm run db:seed:remote
```

### 第 5 步：把改动 commit + push

```bash
cd ~/teamfeed
git add -A
git commit -m "chore: configure d1 database_id"
git push
```

GitHub Actions 会自动触发部署。部署完成后访问：

```
https://teamfeed.<你的子域>.workers.dev
```

---

## 日常开发流程

```bash
# 本地开发
cd ~/teamfeed
./node_modules/.bin/wrangler dev --port 8787

# 改完提交就自动部署
git add -A
git commit -m "fix: 修复卡片日期显示"
git push
# → GitHub Actions → CF Workers 自动更新
```

## 本地数据 vs 远程数据

- 本地 D1：`.wrangler/state/v3/d1/`（sqlite 文件）
- 远程 D1：CF 云端
- 两者**完全独立**：本地测试不影响远程

## Migration 流程（将来改表结构）

**Migration 走手动**，不在 CI 里自动跑（避免 Token 需要额外 D1:Edit 权限）。

1. 新建 `migrations/0003_xxx.sql`
2. 本地：`npm run db:migrate:local`（测试）
3. 确认无误：`npm run db:migrate:remote`（应用到生产）
4. 然后 `git push` → Actions 只部署 Worker 代码

如果你希望以后 CI 自动做 migration，只要去 CF 把 API Token 加上 `Account - D1 - Edit` 权限，然后把 workflow 里的 Deploy step 前加回一个 `d1 migrations apply teamfeed-db --remote` step 即可。

## 自定义域名（可选）

如果想用 `feed.yourdomain.com` 而不是 `*.workers.dev`：

1. CF Dashboard → Workers & Pages → teamfeed → Settings → Triggers
2. 添加 Custom Domain（域名必须在 CF 托管）

---

## 常见问题

**Q: Actions 跑失败说 "Authentication error"**
A: 检查 `CLOUDFLARE_API_TOKEN` 这个 secret 是否正确，token 权限是否包含 Workers Scripts:Edit + D1:Edit

**Q: 部署后访问 404**
A: 首次部署需要 1-2 分钟生效。检查 Workers Dashboard 确认 Worker 存在。

**Q: 数据丢了**
A: 本地和远程 D1 是独立的。本地测试数据不会上远程；反过来也不会。
