"""Automatic need discovery.

    collect (tiered sources) -> prefilter -> Claude screening + 4-part evidence scoring
    -> corpus (every screened signal) -> ruler gate -> GitHub issue / evidence comment

    python -m discover.run --dry-run            # no GitHub writes, nothing saved; prints a report
    python -m discover.run --publish            # create issues/comments, append corpus, save state

Env: ANTHROPIC_API_KEY (required), GITHUB_TOKEN + REPO (for --publish).
Optional: REDDIT_CLIENT_ID/SECRET, META_AD_LIBRARY_TOKEN, INBOX_DIR.
"""
import argparse
import json
import time
from pathlib import Path

from . import match, prefilter, ruler, sources
from .common import ROOT, find_privacy_issues, load_config
from .corpus import Corpus, repetition, to_record, top_keys
from .publish import GitHub, evidence_comment, issue_body, labels_for

STATE_DIR = ROOT / "data" / "discovery"


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def prune_seen(seen, now, days):
    cutoff = now - days * 86400
    return {k: v for k, v in seen.items() if v >= cutoff}


def accept(r, min_conf, min_score, rep):
    """Final gate before anything becomes a public issue."""
    if not r["is_real_need"] or r["confidence"] < min_conf or not r["severity"]:
        return False, "not a need / low confidence"
    if not r["title"].strip() or len(r["problem"].strip()) < 20:
        return False, "empty record"
    if find_privacy_issues(" ".join([r["title"], r["problem"], r["who"], r["workaround"], r["region"],
                                     r["cost_evidence"], r["dissatisfaction_evidence"], r["pay_evidence"]])):
        return False, "personal info in output"
    score = ruler.score(r, rep)
    if score < min_score:
        return False, f"ruler {score} < {min_score}"
    return True, ""


def run(config, extractor, github=None, now=None, state_dir=STATE_DIR, posts=None, needs=None):
    now = int(now or time.time())
    state_dir = Path(state_dir)
    seen = prune_seen(load_json(state_dir / "seen.json", {}), now, config["seen_retention_days"])
    signals = load_json(state_dir / "signals.json", {})
    needs = list(needs if needs is not None else load_json(ROOT / "data" / "needs.json", []))
    corpus = Corpus(state_dir)
    history = corpus.load()
    all_keys = list(repetition(history))
    frequent = top_keys(history, 30)

    health = {}
    if posts is None:
        print("collecting…")
        posts = sources.collect(config, since=now - config["lookback_hours"] * 3600, health=health)
    fresh = [p for p in posts if p.id not in seen]
    picked = prefilter.select(fresh, config["max_posts_per_run"])
    picked_ids = {p.id for p in picked}
    print(f"{len(posts)} collected, {len(fresh)} unseen, {len(picked)} pass prefilter")
    for p in fresh:
        if p.id not in picked_ids:
            seen[p.id] = now  # filtered out: never look at it again

    report = {"run_at": now, "collected": len(posts), "unseen": len(fresh), "prefiltered": len(picked),
              "screened": 0, "needs": 0, "new": [], "evidence": [], "rejected": [], "failed_batches": 0}
    records, created = [], 0
    by_id = {p.id: p for p in picked}
    bs = config["batch_size"]
    for i in range(0, len(picked), bs):
        batch = picked[i:i + bs]
        try:
            results = extractor.screen(batch, match.shortlist(batch, needs),
                                       match.shortlist_keys(batch, all_keys, frequent=frequent))
        except Exception as e:  # noqa: BLE001 - leave batch unseen so the next run retries it
            print(f"  batch {i // bs} failed: {type(e).__name__}: {e}")
            report["failed_batches"] += 1
            continue
        report["screened"] += len(batch)
        for r in results:
            post = by_id[r["post_id"]]
            seen[post.id] = now
            rec = to_record(r, post, now)
            records.append(rec)
            if rec["is_need"]:
                report["needs"] += 1
            # Repetition counts this sighting plus earlier ones of the same need_key.
            rep = repetition(history + records).get(rec["need_key"], 1) if rec["need_key"] else 1
            ok, why = accept(r, config["min_confidence"], config["min_ruler_score"], rep)
            if not ok:
                report["rejected"].append({"url": post.url, "why": why, "reason": r["reason"]})
                continue
            if r["duplicate_of"]:
                n = r["duplicate_of"]
                rec["issue"] = n
                signals.setdefault(str(n), []).append({"source": post.source, "url": post.url, "found_at": now})
                report["evidence"].append({"issue": n, "url": post.url})
                if github:
                    github.comment(n, evidence_comment(r, post))
                continue
            if created >= config["max_new_issues_per_run"]:
                report["rejected"].append({"url": post.url, "why": "per-run cap reached", "reason": ""})
                continue
            entry = {"title": r["title"], "area": r["area"], "severity": r["severity"], "region": r["region"],
                     "url": post.url, "ruler": ruler.score(r, rep), "tier": rec["tier"]}
            if github:
                issue = github.create_issue(r["title"], issue_body(r, post), labels_for(r))
                entry["issue"] = rec["issue"] = issue["number"]
                needs.append({"id": issue["number"], "title": r["title"], "problem": r["problem"]})
                signals.setdefault(str(issue["number"]), []).append(
                    {"source": post.source, "url": post.url, "found_at": now})
            report["new"].append(entry)
            created += 1

    report["sources"] = health
    return report, seen, signals, records


def main():
    ap = argparse.ArgumentParser(description="Automatic need discovery")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="no GitHub writes, nothing saved")
    mode.add_argument("--publish", action="store_true", help="create issues/comments, save corpus and state")
    ap.add_argument("--report", type=Path, help="write the run report JSON here")
    args = ap.parse_args()

    from .extract import Extractor  # imported late so --help works without the SDK installed
    config = load_config()
    report, seen, signals, records = run(config, Extractor(config["model"], config["effort"]),
                                         github=GitHub() if args.publish else None)
    if args.publish:
        corpus = Corpus(STATE_DIR)
        corpus.append(records, now=report["run_at"])
        corpus.log_run({k: report[k] for k in ("run_at", "collected", "unseen", "prefiltered", "screened",
                                               "needs", "failed_batches", "sources")}
                       | {"new": len(report["new"]), "evidence": len(report["evidence"])})
        save_json(STATE_DIR / "seen.json", seen)
        save_json(STATE_DIR / "signals.json", signals)
    if args.report:
        save_json(args.report, report)
    print(f"screened {report['screened']}: {report['needs']} needs, {len(report['new'])} new issues, "
          f"{len(report['evidence'])} evidence, {len(report['rejected'])} rejected")
    for n in report["new"]:
        print(f"  + [ruler {n['ruler']}] {n['title']}  ({n['area']}, {n['region'] or '?'})  {n['url']}")


if __name__ == "__main__":
    main()
