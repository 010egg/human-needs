"""Export issues labeled `need` into data/needs.json and data/STATS.md.

Usage: GITHUB_TOKEN=... REPO=owner/name python scripts/export_needs.py
"""
import json
import os
import re
import urllib.request
from collections import Counter
from pathlib import Path

REPO = os.environ.get("REPO", "010egg/human-needs")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
ROOT = Path(__file__).resolve().parent.parent

FIELDS = {
    "遇到了什么问题": "problem",
    "谁有这个需求": "who",
    "所属领域": "area",
    "现在怎么凑合解决": "workaround",
    "有多痛": "severity",
    "多频繁": "frequency",
    "愿意为解决它付出多少": "willingness_to_pay",
    "国家/地区": "region",
    "信息来源": "source",
    "补充": "extra",
}


def fetch_issues():
    issues, page = [], 1
    while True:
        url = (f"https://api.github.com/repos/{REPO}/issues"
               f"?labels=need&state=all&per_page=100&page={page}")
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json",
            **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
        })
        with urllib.request.urlopen(req) as r:
            batch = json.load(r)
        batch = [i for i in batch if "pull_request" not in i]
        if not batch:
            return issues
        issues += batch
        page += 1


def parse_body(body):
    out = {}
    for block in re.split(r"^### ", body or "", flags=re.M)[1:]:
        head, _, value = block.partition("\n")
        value = value.strip()
        if value == "_No response_":
            value = ""
        for zh, key in FIELDS.items():
            if head.startswith(zh):
                out[key] = value
    if m := re.match(r"(\d)", out.get("severity", "")):
        out["severity"] = int(m.group(1))
    return out


def main():
    needs = []
    for i in fetch_issues():
        rec = {
            "id": i["number"],
            "title": re.sub(r"^\[需求\]\s*", "", i["title"]),
            "url": i["html_url"],
            "state": i["state"],
            "created_at": i["created_at"],
            "upvotes": i.get("reactions", {}).get("+1", 0),
            "comments": i["comments"],
            "labels": [l["name"] for l in i["labels"]],
            **parse_body(i["body"]),
        }
        needs.append(rec)
    needs.sort(key=lambda n: n["id"])

    data = ROOT / "data"
    data.mkdir(exist_ok=True)
    (data / "needs.json").write_text(
        json.dumps(needs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    areas = Counter(n.get("area", "").split(" / ")[0] or "未分类" for n in needs)
    top = sorted(needs, key=lambda n: (n["upvotes"], n.get("severity") or 0), reverse=True)[:20]
    lines = ["# 统计概览 / Stats", "", f"需求总数：**{len(needs)}**", "",
             "## 按领域", "", "| 领域 | 数量 |", "|---|---|"]
    lines += [f"| {a} | {c} |" for a, c in areas.most_common()]
    lines += ["", "## 最受认同 Top 20", "", "| 👍 | 痛度 | 需求 |", "|---|---|---|"]
    lines += [f"| {n['upvotes']} | {n.get('severity', '')} | [{n['title']}]({n['url']}) |" for n in top]
    (data / "STATS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"exported {len(needs)} needs")


if __name__ == "__main__":
    main()
