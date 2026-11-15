"""Export issues labeled `need` into data/needs.json, data/needs.csv and data/STATS.md.

Usage:
    GITHUB_TOKEN=... REPO=owner/name python scripts/export_needs.py
    python scripts/export_needs.py --from-file issues.json   # offline, raw GitHub API issue list

Standard library only, so it runs anywhere without installing anything.
"""
import argparse
import csv
import io
import json
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

REPO = os.environ.get("REPO", "010egg/human-needs")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
ROOT = Path(__file__).resolve().parent.parent

# Issue-form heading prefix (Chinese part) -> output field
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
    "原始来源": "source_url",
}

# Dropdown option prefix -> stable machine key (keep in sync with .github/ISSUE_TEMPLATE/need.yml)
FREQUENCY_KEYS = {
    "每天": "daily", "每周": "weekly", "每月": "monthly",
    "每年几次": "yearly", "一生中少数关键时刻": "rare",
}
PAY_KEYS = {
    "不愿或无力付费": "none", "少量": "little", "中等": "moderate",
    "很多": "high", "不确定": "unsure",
}
SOURCE_KEYS = {"我亲身经历": "firsthand", "我亲眼观察": "observed", "听说或从网上": "hearsay",
               "自动发现": "auto"}

CSV_COLUMNS = [
    "id", "title", "url", "state", "status", "duplicate", "created_at", "updated_at",
    "upvotes", "comments", "signals", "area", "area_en", "severity", "frequency_key",
    "willingness_to_pay_key", "source_key", "source_url", "region", "who", "problem", "workaround", "extra",
]


def fetch_issues(retries=4):
    issues, page = [], 1
    while True:
        url = (f"https://api.github.com/repos/{REPO}/issues"
               f"?labels=need&state=all&per_page=100&page={page}")
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "human-needs-export",
            **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
        })
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    batch = json.load(r)
                break
            except (urllib.error.URLError, TimeoutError):
                if attempt == retries - 1:
                    raise
                time.sleep(2 ** attempt)
        batch = [i for i in batch if "pull_request" not in i]
        if not batch:
            return issues
        issues += batch
        page += 1


def _key(value, table):
    for prefix, key in table.items():
        if value.startswith(prefix):
            return key
    return ""


def parse_body(body):
    out = {}
    for block in re.split(r"^### ", (body or "").replace("\r\n", "\n"), flags=re.M)[1:]:
        head, _, value = block.partition("\n")
        value = value.strip()
        if value == "_No response_":
            value = ""
        for zh, key in FIELDS.items():
            if head.startswith(zh):
                out[key] = value
                break

    if "severity" in out:
        m = re.match(r"\s*(\d)", out["severity"])
        out["severity"] = int(m.group(1)) if m else None
    if "area" in out:
        zh, _, en = out["area"].partition(" / ")
        out["area"], out["area_en"] = zh.strip(), en.strip()
    out["frequency_key"] = _key(out.get("frequency", ""), FREQUENCY_KEYS)
    out["willingness_to_pay_key"] = _key(out.get("willingness_to_pay", ""), PAY_KEYS)
    out["source_key"] = _key(out.get("source", ""), SOURCE_KEYS)
    return out


def load_signals():
    """Independent sightings of each need found by discover/ (issue number -> list)."""
    try:
        return json.loads((ROOT / "data/discovery/signals.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def to_record(issue, signals=None):
    labels = [l["name"] for l in issue.get("labels", [])]
    status = next((l.split(":", 1)[1] for l in labels if l.startswith("status:")), "")
    return {
        "id": issue["number"],
        "title": re.sub(r"^\[需求\]\s*", "", issue["title"]).strip(),
        "url": issue["html_url"],
        "state": issue["state"],
        "status": status,
        "duplicate": "duplicate" in labels,
        "created_at": issue["created_at"],
        "updated_at": issue.get("updated_at", issue["created_at"]),
        "upvotes": (issue.get("reactions") or {}).get("+1", 0),
        "comments": issue.get("comments", 0),
        "signals": len((signals or {}).get(str(issue["number"]), [])),
        "labels": labels,
        **parse_body(issue.get("body")),
    }


def to_csv(needs):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    for n in needs:
        w.writerow({c: n.get(c, "") for c in CSV_COLUMNS})
    return buf.getvalue()


def _table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return lines


def to_stats(needs):
    live = [n for n in needs if not n["duplicate"]]
    open_ = [n for n in live if n["state"] == "open"]
    areas = Counter(n.get("area") or "未分类" for n in live)
    sev = Counter(n.get("severity") for n in live if n.get("severity"))
    src = Counter(n.get("source_key") or "unknown" for n in live)
    status = Counter(n.get("status") or "未标注" for n in live)
    regions = Counter(re.split(r"[·・,，/]", n["region"])[0].strip()
                      for n in live if n.get("region"))

    def esc(s):
        return s.replace("|", "\\|")

    # A rough priority signal: how many people share it, weighted by how much it hurts.
    def score(n):
        return (n["upvotes"] + 1) * (n.get("severity") or 1)

    top = sorted(open_, key=lambda n: (n["upvotes"], n.get("severity") or 0), reverse=True)[:20]
    urgent = sorted(open_, key=score, reverse=True)[:20]
    src_names = {"firsthand": "亲历", "observed": "观察", "hearsay": "转述", "auto": "自动发现", "unknown": "未知"}

    lines = ["# 统计概览 / Stats", "",
             f"需求总数：**{len(live)}**（开放 {len(open_)}，另有 {len(needs) - len(live)} 条重复已合并）", ""]
    lines += ["## 按领域 / By area", ""] + _table(["领域", "数量"], areas.most_common()) + [""]
    lines += ["## 痛度分布 / Severity", ""] + _table(
        ["痛度", "数量"], [(s, sev.get(s, 0)) for s in range(1, 6)]) + [""]
    lines += ["## 信息来源 / Source", ""] + _table(
        ["来源", "数量"], [(src_names.get(k, k), c) for k, c in src.most_common()]) + [""]
    lines += ["## 处理状态 / Status", ""] + _table(["状态", "数量"], status.most_common()) + [""]
    lines += ["## 地区 Top 15 / Regions", ""] + _table(["地区", "数量"], regions.most_common(15)) + [""]
    lines += ["## 最受认同 Top 20 / Most upvoted", ""] + _table(
        ["👍", "痛度", "领域", "需求"],
        [(n["upvotes"], n.get("severity") or "", n.get("area", ""), f"[{esc(n['title'])}]({n['url']})")
         for n in top]) + [""]
    lines += ["## 最值得解决 Top 20 / Highest impact", "",
              "> 排序分 = (👍 + 1) × 痛度。粗略指标，仅供参考。", ""] + _table(
        ["分", "👍", "痛度", "需求"],
        [(score(n), n["upvotes"], n.get("severity") or "", f"[{esc(n['title'])}]({n['url']})")
         for n in urgent])
    return "\n".join(lines) + "\n"


def write_outputs(needs, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "needs.json").write_text(
        json.dumps(needs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # utf-8-sig so Excel opens Chinese text correctly
    (out_dir / "needs.csv").write_text(to_csv(needs), encoding="utf-8-sig")
    (out_dir / "STATS.md").write_text(to_stats(needs), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from-file", type=Path, help="read raw GitHub issues JSON instead of calling the API")
    ap.add_argument("--out", type=Path, default=ROOT / "data", help="output directory (default: data/)")
    args = ap.parse_args()

    raw = json.loads(args.from_file.read_text(encoding="utf-8")) if args.from_file else fetch_issues()
    signals = load_signals()
    needs = sorted((to_record(i, signals) for i in raw if "pull_request" not in i), key=lambda n: n["id"])
    write_outputs(needs, args.out)
    print(f"exported {len(needs)} needs -> {args.out}")


if __name__ == "__main__":
    main()
