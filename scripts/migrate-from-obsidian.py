#!/usr/bin/env python3
"""
migrate-from-obsidian.py — 一次性把 Obsidian Portfolio 进展 + 基础档案搬到 projectfeed D1

Usage:
    ./migrate-from-obsidian.py --dry-run            # 仅打印清单，不写入
    ./migrate-from-obsidian.py --execute            # 实际执行
    ./migrate-from-obsidian.py --execute --progress-only
    ./migrate-from-obsidian.py --execute --profile-only

说明：
- Progress 卡：每个项目的 进展日志.md 按 `## YYYY-MM-DD` 解析，每组一张 progress 卡
- Profile 卡：Todoist description + 状态.md 拼接，每项目 UPSERT 一张
- Progress 用 override_created_at 保留原日期（避免全部显示"今天"）
"""

import argparse
import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

API_BASE = "https://projectfeed.kevinyuanxin.workers.dev"
VAULT = Path.home() / "Obsidian" / "kevinob"
SECRETS = Path.home() / ".claude" / "serects api.env"

# projectfeed.id → Obsidian 相对目录
PROJECT_DIRS = {
    "xiangcheng":      "🔌 祥承电子",
    "dechuang-robot":  "💵 德创项目/【2】具身智能",
    "bci":             "💰 商业孵化/【1】脑机接口",
    "dechuang-sched":  "💵 德创项目/【3】调度项目",
    "nantong":         "💰 商业孵化/【10】南通船舶事业",
    "kuangchuang":     "💰 商业孵化/【11】宽创文化具身智能",
    "drone":           "💰 商业孵化/【2】无人机",
    "embodied-data":   "💰 商业孵化/【3】具身数据",
    "fmea":            "💰 商业孵化/【9】西门子 FEMA 失效分析",
    "emba":            "🪲 论文写作/【2】复旦 Emba 项目",
    "ai-cap":          "⚛️ AI 使用",
    "personal":        "📮 个人与家庭",
}

# Todoist 项目名模糊匹配关键词（projectfeed.id → 关键词）
TODOIST_KEYWORD = {
    "xiangcheng":      "祥承电子",
    "dechuang-robot":  "德创具身",
    "bci":             "脑机接口",
    "dechuang-sched":  "德创调度",
    "nantong":         "南通船舶",
    "kuangchuang":     "宽创文化具身",
    "drone":           "无人机巡检",
    "embodied-data":   "具身数据",
    "fmea":            "FMEA",
    "emba":            "EMBA",
    "ai-cap":          "AI 能力",
    "personal":        "个人与家庭",
}


def get_secret_section(section_name):
    """从 secrets api.env 精确定位 section，返回该段文本。"""
    text = SECRETS.read_text(encoding="utf-8")
    marker = f"## {section_name}"
    if marker not in text:
        raise SystemExit(f"❌ secrets 里找不到段 '{marker}'")
    return text.split(marker, 1)[1].split("\n## ", 1)[0]


def get_sync_secret():
    for line in get_secret_section("ProjectFeed Sync").splitlines():
        s = line.strip()
        if s.startswith("secret"):
            for sep in ("：", ":"):
                if sep in s:
                    return s.split(sep, 1)[1].strip()
    raise SystemExit("❌ ProjectFeed Sync secret 行找不到")


def get_todoist_token():
    for line in get_secret_section("Todoist API").splitlines():
        s = line.strip()
        if s.startswith("token"):
            for sep in ("：", ":"):
                if sep in s:
                    return s.split(sep, 1)[1].strip()
    raise SystemExit("❌ Todoist token 行找不到")


def fetch_todoist_projects(token):
    req = urllib.request.Request(
        "https://api.todoist.com/api/v1/projects?limit=100",
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "projectfeed-migrate/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode())
    return data.get("results", data) if isinstance(data, dict) else data


def parse_progress_log(path):
    """返回 [(date, content), ...] 按日期升序。"""
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    # 用 lookahead 分割保留分隔符
    sections = re.split(r"(?m)^(?=##\s+\d{4}-\d{2}-\d{2})", text)
    entries = []
    for sec in sections:
        m = re.match(r"##\s+(\d{4}-\d{2}-\d{2}).*?\n(.*)", sec, re.S)
        if not m:
            continue
        date = m.group(1)
        body = m.group(2)
        # 去掉 --- 分隔线之后的残余（前导元数据块）
        body = re.split(r"(?m)^---\s*$", body)[0].strip()
        if body:
            entries.append((date, body))
    entries.sort(key=lambda x: x[0])
    return entries


def find_status_file(project_dir):
    for name in ["状态.md", "_项目状态.md", "_状态.md"]:
        p = project_dir / name
        if p.exists():
            return p
    return None


def build_profile_content(pid, todoist_proj, status_file, project_dir_rel):
    lines = ["📋 项目基础档案", ""]
    name = todoist_proj.get("name", pid) if todoist_proj else pid

    lines.append(f"## Todoist 项目 · {name}")
    if todoist_proj:
        desc = (todoist_proj.get("description") or "").strip()
        lines.append(desc if desc else "_(Todoist 无 description)_")
    else:
        lines.append(f"_(未在 Todoist 找到匹配项目 · 关键词: {TODOIST_KEYWORD.get(pid, '?')})_")
    lines.append("")

    if status_file and status_file.exists():
        status_text = status_file.read_text(encoding="utf-8", errors="replace").strip()
        # 截断到 2500 字避免单卡过长
        truncated = False
        if len(status_text) > 2500:
            status_text = status_text[:2500] + "\n\n_(已截断，原文共 {} 字)_".format(len(status_text))
            truncated = True
        lines.append(f"## 项目状态（from {status_file.name}）")
        lines.append(status_text)
        lines.append("")

    lines.append(f"> 📂 Obsidian 路径：`{project_dir_rel}/`")
    lines.append(f"> ℹ️ AI 一键整理时自动加载此卡作为 **{name}** 的背景资料")
    return "\n".join(lines)


def post_json(url, body, sync_secret, timeout=20):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-Sync-Secret": sync_secret,
            "User-Agent": "projectfeed-migrate/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true", help="仅打印清单，不写入")
    g.add_argument("--execute", action="store_true", help="实际执行写入")
    ap.add_argument("--progress-only", action="store_true", help="只处理 progress 卡")
    ap.add_argument("--profile-only", action="store_true", help="只处理 profile 卡")
    args = ap.parse_args()

    dry = args.dry_run
    sync_secret = get_sync_secret()

    # Todoist 数据（profile 用）
    todoist_by_id = {}
    if not args.progress_only:
        try:
            token = get_todoist_token()
            todoist_projects = fetch_todoist_projects(token)
            for pid, keyword in TODOIST_KEYWORD.items():
                for p in todoist_projects:
                    name = p.get("name", "")
                    if keyword and keyword in name:
                        todoist_by_id[pid] = p
                        break
        except Exception as e:
            print(f"⚠️  Todoist 拉取失败（将用空 description）: {e}", file=sys.stderr)

    # 收集数据
    all_progress = []
    all_profile = []

    for pid, rel in PROJECT_DIRS.items():
        project_dir = VAULT / rel
        log_file = project_dir / "进展日志.md"

        if not args.profile_only:
            entries = parse_progress_log(log_file)
            source_ref = f"{rel}/进展日志.md"
            for date, content in entries:
                all_progress.append((pid, date, content, source_ref))

        if not args.progress_only:
            profile_content = build_profile_content(
                pid, todoist_by_id.get(pid), find_status_file(project_dir), rel
            )
            all_profile.append((pid, profile_content))

    # ==== 打印清单 ====
    mode = "🔍 DRY-RUN 预览" if dry else "🚀 执行"
    print(f"\n{'='*70}\n{mode}\n{'='*70}")
    print(f"合计：{len(all_progress)} 条 progress 卡 · {len(all_profile)} 张 profile 卡\n")

    if not args.profile_only and all_progress:
        print("━━━ Progress 卡清单 ━━━")
        prev = None
        for pid, date, content, _ in all_progress:
            if pid != prev:
                print(f"\n  【{pid}】")
                prev = pid
            first_line = next((l for l in content.split("\n") if l.strip()), "")
            snippet = first_line[:68] + ("..." if len(first_line) > 68 else "")
            print(f"    {date}  {snippet}")
        print()

    if not args.progress_only and all_profile:
        print("━━━ Profile 卡清单 ━━━")
        for pid, content in all_profile:
            has_todoist = "## Todoist 项目" in content and "(Todoist 无 description)" not in content and "(未在 Todoist 找到" not in content
            has_status = "## 项目状态" in content
            lines_cnt = content.count("\n") + 1
            chars = len(content)
            print(f"  {pid:<18}  Todoist:{'✓' if has_todoist else '✗'}  状态.md:{'✓' if has_status else '✗'}  ({chars} 字 / {lines_cnt} 行)")
        print()

    if dry:
        print("(--dry-run 模式，未实际写入。确认后加 --execute 执行)")
        return

    # ==== 实际执行 ====
    print(f"\n{'='*70}\n开始写入 projectfeed D1\n{'='*70}\n")

    if not args.profile_only:
        print(f"📝 写入 {len(all_progress)} 条 progress 卡...")
        ok, err = 0, 0
        for pid, date, content, source_ref in all_progress:
            try:
                post_json(
                    f"{API_BASE}/api/progress",
                    {
                        "project_id": pid,
                        "content": content,
                        "source": "feedback",
                        "source_ref": source_ref,
                        "override_created_at": date,
                    },
                    sync_secret,
                )
                ok += 1
                print(f"  ✓ {pid} {date}", flush=True)
            except urllib.error.HTTPError as e:
                err += 1
                print(f"  ✗ {pid} {date}: HTTP {e.code} {e.read().decode()[:150]}", flush=True)
            except Exception as e:
                err += 1
                print(f"  ✗ {pid} {date}: {e}", flush=True)
        print(f"\nProgress: {ok} 成功 / {err} 失败\n")

    if not args.progress_only:
        print(f"📌 写入 {len(all_profile)} 张 profile 卡...")
        ok, err = 0, 0
        for pid, content in all_profile:
            try:
                r = post_json(f"{API_BASE}/api/profile/{pid}", {"content": content}, sync_secret)
                ok += 1
                print(f"  ✓ {pid} ({r.get('action', '?')})", flush=True)
            except urllib.error.HTTPError as e:
                err += 1
                print(f"  ✗ {pid}: HTTP {e.code} {e.read().decode()[:150]}", flush=True)
            except Exception as e:
                err += 1
                print(f"  ✗ {pid}: {e}", flush=True)
        print(f"\nProfile: {ok} 成功 / {err} 失败\n")


if __name__ == "__main__":
    main()
