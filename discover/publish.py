"""Turn screened results into GitHub issues (new needs) or comments (more evidence for an existing need)."""
import json
import os
import urllib.request

from .extract import FREQUENCIES

AUTO_SOURCE = "自动发现 / Auto-discovered"
AUTO_LABEL = "来源:自动发现"


def issue_body(r, post):
    """Same headings as the issue form, so export_needs.py parses auto issues like human ones."""
    sections = [
        ("遇到了什么问题？/ What is the problem?", r["problem"]),
        ("谁有这个需求？/ Who has this need?", r["who"]),
        ("所属领域 / Area", r["area"]),
        ("现在怎么凑合解决？/ Current workaround", r["workaround"] or "_No response_"),
        ("有多痛？/ How painful?", f"{r['severity']}"),
        ("多频繁？/ How often?", FREQUENCIES[r["frequency"]]),
        ("愿意为解决它付出多少？/ Willingness to pay", "_No response_"),
        ("国家/地区 / Country or region", r["region"] or "_No response_"),
        ("信息来源 / Source", AUTO_SOURCE),
        ("原始来源 / Original post", post.url),
        ("补充（可选）/ Anything else", _extra(r, post)),
    ]
    return "\n\n".join(f"### {h}\n\n{v}" for h, v in sections)


def _extra(r, post):
    def line(name, score, ev):
        return f"| {name} | {score}/3 | {ev or '—'} |"
    rows = ["| 证据 | 分 | 说明 |", "|---|---|---|",
            line("代价 cost", r["cost"], r["cost_evidence"]),
            line("不满 dissatisfaction", r["dissatisfaction"], r["dissatisfaction_evidence"]),
            line("支付意愿 pay", r["pay"], r["pay_evidence"])]
    sols = [f"- **{s['name']}**：{s['complaint'] or '未说明不足'}" for s in r.get("existing_solutions", [])]
    parts = [
        f"🤖 由自动发现系统从 {post.source}（{post.meta.get('tier', '')}）的公开内容整理改写，"
        f"置信度 {r['confidence']:.2f}。维护者审核前请勿视为已确认。",
        "", *rows,
    ]
    if sols:
        parts += ["", "现有方案及其不足：", *sols]
    if r.get("company"):
        parts += ["", f"相关机构（招聘/广告方）：{r['company']}"]
    parts += ["", f"需求键：`{r['need_key']}` · 判定理由：{r['reason']}"]
    return "\n".join(parts)


def labels_for(r):
    return ["need", "status:待整理", AUTO_LABEL,
            "area:" + r["area"].split(" / ")[0], f"痛度:{r['severity']}"]


def evidence_comment(r, post):
    return (f"🤖 自动发现：在 {post.source} 又看到一例相似的需求 → {post.url}\n\n"
            f"> {r['title']}：{r['problem'][:200]}\n\n"
            "_这说明该需求可能更普遍。如果判断有误，请忽略本条。_")


class GitHub:
    def __init__(self, repo=None, token=None):
        self.repo = repo or os.environ["REPO"]
        self.token = token or os.environ["GITHUB_TOKEN"]

    def _call(self, method, path, payload):
        req = urllib.request.Request(
            f"https://api.github.com/repos/{self.repo}{path}", method=method,
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                     "Content-Type": "application/json", "User-Agent": "human-needs-discovery"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def create_issue(self, title, body, labels):
        return self._call("POST", "/issues", {"title": title, "body": body, "labels": labels})

    def comment(self, number, body):
        return self._call("POST", f"/issues/{number}/comments", {"body": body})
