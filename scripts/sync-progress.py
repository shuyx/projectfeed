#!/usr/bin/env python3
"""
sync-progress.py — 把一条 Obsidian 进展同步到 projectfeed D1

Usage:
    sync-progress.py <project_id> <source> <content_file_or_inline> [<source_ref>]

Args:
    project_id  : 12 个预设项目之一（xiangcheng / bci / ai-cap / ...）
    source      : feedback | recap | capsule | manual
    content     : 精简版内容（<= 1500 字）。如果以 @ 开头，则从文件读（如 @/tmp/content.md）
    source_ref  : 可选，源 .md 路径（用于溯源）

Examples:
    sync-progress.py xiangcheng feedback "今天与张老师沟通劳务合同..." "🔌 祥承电子/进展日志.md"
    sync-progress.py ai-cap capsule @/tmp/capsule-summary.md "👔 时间胶囊/2026/04/20260424-xxx.md"

项目 id 参考：
    xiangcheng       祥承电子          P0
    dechuang-robot   德创具身智能      P0
    bci              脑机接口          P0
    dechuang-sched   德创调度          P1
    nantong          南通船舶          P1
    kuangchuang      宽创文化具身      P1
    drone            无人机            P2
    embodied-data    具身数据          P2
    fmea             西门子 FMEA       P2
    emba             EMBA 论文         P2
    ai-cap           AI 能力建设       持续
    personal         个人与家庭        持续
"""

import json
import os
import sys
import urllib.request
import urllib.error


API_URL = "https://feed.ai-robot.fans/api/progress"
SECRETS_FILE = os.path.expanduser("~/.claude/serects api.env")
VALID_SOURCES = ("feedback", "recap", "capsule", "manual")
VALID_PROJECT_IDS = (
    "xiangcheng", "dechuang-robot", "bci",
    "dechuang-sched", "nantong", "kuangchuang",
    "drone", "embodied-data", "fmea", "emba",
    "ai-cap", "personal",
)
MAX_CONTENT = 1500


def get_secret():
    """从 ~/.claude/serects api.env 的 ## ProjectFeed Sync 段提取 secret。"""
    try:
        with open(SECRETS_FILE, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        sys.exit(f"❌ 找不到 {SECRETS_FILE}")

    parts = text.split("## ProjectFeed Sync")
    if len(parts) < 2:
        sys.exit("❌ serects api.env 里没有 '## ProjectFeed Sync' 段")
    section = parts[1].split("\n## ", 1)[0]
    for line in section.splitlines():
        s = line.strip()
        if s.startswith("secret"):
            # 支持中文冒号和英文冒号
            for sep in ("：", ":"):
                if sep in s:
                    return s.split(sep, 1)[1].strip()
    sys.exit("❌ ProjectFeed Sync 段里没有 'secret' 行")


def load_content(arg):
    if arg.startswith("@"):
        path = os.path.expanduser(arg[1:])
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    return arg


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    project_id = sys.argv[1]
    source = sys.argv[2]
    content = load_content(sys.argv[3])
    source_ref = sys.argv[4] if len(sys.argv) > 4 else None

    if project_id not in VALID_PROJECT_IDS:
        sys.exit(f"❌ 未知 project_id: {project_id}\n合法值: {', '.join(VALID_PROJECT_IDS)}")
    if source not in VALID_SOURCES:
        sys.exit(f"❌ 未知 source: {source}\n合法值: {', '.join(VALID_SOURCES)}")
    if not content:
        sys.exit("❌ content 为空")
    if len(content) > MAX_CONTENT:
        sys.exit(f"❌ content 超长（{len(content)} > {MAX_CONTENT}）")

    secret = get_secret()
    body = {"project_id": project_id, "content": content, "source": source}
    if source_ref:
        body["source_ref"] = source_ref

    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-Sync-Secret": secret,
            # CF bot filter rejects default Python UA; mimic curl
            "User-Agent": "projectfeed-sync/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read().decode("utf-8"))
        short_id = (resp.get("id") or "?")[:8]
        print(f"✅ 已同步 projectfeed · project={project_id} source={source} id={short_id}...")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        sys.exit(f"❌ HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        sys.exit(f"❌ 网络错误: {e.reason}")


if __name__ == "__main__":
    main()
