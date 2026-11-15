"""Shortlist existing needs that might duplicate a post, so the model can judge in one call.

Character bigrams work across Chinese and English without a tokenizer or embeddings.
"""
import re


def _grams(s):
    s = re.sub(r"\s+", " ", (s or "").lower())
    return {s[i:i + 2] for i in range(len(s) - 1)}


def similarity(a, b):
    ga, gb = _grams(a), _grams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / (len(ga | gb) or 1)


def shortlist(posts, needs, per_post=5, cap=40):
    """Return the existing needs most similar to any post in this batch."""
    live = [n for n in needs if not n.get("duplicate")]
    picked = {}
    for p in posts:
        text = f"{p.title} {p.text[:600]}"
        ranked = sorted(live, key=lambda n: similarity(text, f"{n['title']} {n.get('problem', '')[:300]}"),
                        reverse=True)
        for n in ranked[:per_post]:
            picked[n["id"]] = n
    return list(picked.values())[:cap]


def shortlist_keys(posts, keys, per_post=8, frequent=None, cap=80):
    """need_keys to show the model: the most similar to this batch, plus the most frequent ones."""
    picked = list(frequent or [])[:30]
    for p in posts:
        text = f"{p.title} {p.text[:600]}"
        picked += sorted(keys, key=lambda k: similarity(text, k), reverse=True)[:per_post]
    return list(dict.fromkeys(picked))[:cap]
