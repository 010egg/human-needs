"""Append-only corpus of every screened signal (structured + paraphrased; never raw post text).

data/discovery/corpus/YYYY-MM.jsonl   one record per screened post
data/discovery/corpus/index.json      shard list + last update, polled by the dashboard
data/discovery/runs.jsonl             one line per run: per-source health and funnel counts

Rejected posts are kept too: they are the denominator when we say "X% of signals are about Y".
"""
import json
import time
from collections import defaultdict
from pathlib import Path

RECORD_FIELDS = [
    "id", "url", "source", "tier", "kind", "created", "screened_at", "is_need", "confidence",
    "need_key", "title", "problem", "who", "area", "severity", "frequency", "region",
    "cost", "cost_evidence", "dissatisfaction", "dissatisfaction_evidence", "pay", "pay_evidence",
    "existing_solutions", "company", "workaround", "issue", "reason",
]


def to_record(result, post, screened_at):
    r = dict(result)
    rec = {
        "id": post.id, "url": post.url, "source": post.source, "tier": post.meta.get("tier", ""),
        "created": post.created, "screened_at": screened_at, "is_need": bool(r.get("is_real_need")),
        "area": (r.get("area") or "").split(" / ")[0], "issue": 0,
        **{k: r.get(k) for k in RECORD_FIELDS if k in r},
    }
    return {k: rec.get(k, "") for k in RECORD_FIELDS}


class Corpus:
    def __init__(self, root):
        self.root = Path(root)
        self.dir = self.root / "corpus"

    def shards(self):
        return sorted(self.dir.glob("*.jsonl"))

    def load(self, months=6):
        out = []
        for f in self.shards()[-months:]:
            out += [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        return out

    def append(self, records, now=None):
        if not records:
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        by_month = defaultdict(list)
        for r in records:
            by_month[time.strftime("%Y-%m", time.gmtime(r["screened_at"]))].append(r)
        for month, recs in by_month.items():
            with (self.dir / f"{month}.jsonl").open("a", encoding="utf-8") as f:
                for r in recs:
                    f.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")
        self.write_index(now)

    def write_index(self, now=None):
        idx = {"updated_at": int(now or time.time()), "shards": [f.name for f in self.shards()]}
        (self.dir / "index.json").write_text(json.dumps(idx, indent=2) + "\n", encoding="utf-8")

    def log_run(self, entry):
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "runs.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def repetition(records):
    """need_key -> number of independent sightings (distinct URLs)."""
    seen = defaultdict(set)
    for r in records:
        if r.get("is_need") and r.get("need_key"):
            seen[r["need_key"]].add(r["url"])
    return {k: len(v) for k, v in seen.items()}


def top_keys(records, limit=150):
    rep = repetition(records)
    return [k for k, _ in sorted(rep.items(), key=lambda kv: -kv[1])[:limit]]
