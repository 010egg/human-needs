"""Collectors for public sources. Each returns a list[Post].

All sources are public, read-only APIs. We never republish post text: Claude rewrites
the need in its own words and we link back to the original.
"""
import base64
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

from .common import USER_AGENT, Post, http_json, strip_html


# ---------- Hacker News (Algolia search API, no auth) ----------

def parse_hn(payload):
    posts = []
    for h in payload.get("hits", []):
        text = strip_html(h.get("comment_text") or h.get("story_text") or "")
        title = h.get("title") or h.get("story_title") or ""
        oid = h.get("objectID")
        if not oid or not (text or title):
            continue
        posts.append(Post(
            source="hackernews", id=f"hackernews:{oid}",
            url=f"https://news.ycombinator.com/item?id={oid}",
            title=title, text=text, created=int(h.get("created_at_i") or 0),
            meta={"points": h.get("points")},
        ))
    return posts


def fetch_hackernews(cfg, since):
    posts = {}
    for q in cfg.get("queries", []):
        params = urllib.parse.urlencode({
            "query": f'"{q}"', "tags": "(story,comment)",
            "numericFilters": f"created_at_i>{since}", "hitsPerPage": cfg.get("hits_per_query", 15),
        })
        for p in parse_hn(http_json(f"https://hn.algolia.com/api/v1/search_by_date?{params}")):
            posts[p.id] = p
    return list(posts.values())


# ---------- V2EX (public API, no auth, ~120 req/h) ----------

def parse_v2ex(payload):
    posts = []
    for t in payload or []:
        tid = t.get("id")
        if not tid:
            continue
        posts.append(Post(
            source="v2ex", id=f"v2ex:{tid}",
            url=t.get("url") or f"https://www.v2ex.com/t/{tid}",
            title=t.get("title", ""), text=(t.get("content") or "").strip(),
            created=int(t.get("created") or 0),
            meta={"node": (t.get("node") or {}).get("name"), "replies": t.get("replies")},
        ))
    return posts


def fetch_v2ex(cfg, since):
    posts = {}
    for ep in cfg.get("endpoints", []):
        for p in parse_v2ex(http_json(f"https://www.v2ex.com/api/{ep}")):
            if p.created >= since:
                posts[p.id] = p
    return list(posts.values())


# ---------- Reddit (OAuth app-only; needs REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET) ----------

def parse_reddit(payload, sub):
    posts = []
    for child in (payload.get("data") or {}).get("children", []):
        d = child.get("data") or {}
        if d.get("stickied") or d.get("over_18"):
            continue
        posts.append(Post(
            source=f"reddit/r/{sub}", id=f"reddit:{d.get('id')}",
            url="https://www.reddit.com" + d.get("permalink", ""),
            title=d.get("title", ""), text=(d.get("selftext") or "").strip(),
            created=int(d.get("created_utc") or 0),
            meta={"score": d.get("score"), "comments": d.get("num_comments")},
        ))
    return posts


def _reddit_token():
    cid, secret = os.environ.get("REDDIT_CLIENT_ID"), os.environ.get("REDDIT_CLIENT_SECRET")
    if not (cid and secret):
        return None
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    res = http_json("https://www.reddit.com/api/v1/access_token",
                    headers={"Authorization": f"Basic {auth}"},
                    data=b"grant_type=client_credentials")
    return res.get("access_token")


def fetch_reddit(cfg, since):
    token = _reddit_token()
    if not token:
        print("  reddit: skipped (set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to enable)")
        return []
    posts = []
    for sub in cfg.get("subreddits", []):
        url = f"https://oauth.reddit.com/r/{sub}/new?limit={cfg.get('per_subreddit', 15)}&raw_json=1"
        payload = http_json(url, headers={"Authorization": f"Bearer {token}"})
        posts += [p for p in parse_reddit(payload, sub) if p.created >= since]
        time.sleep(1)  # stay well under Reddit's rate limit
    return posts


# ---------- Money tier: HN "Who is hiring?" (companies paying to solve a problem) ----------

def fetch_hn_hiring(cfg, since):
    q = urllib.parse.urlencode({"tags": "story,author_whoishiring", "query": "Who is hiring", "hitsPerPage": 1})
    stories = http_json(f"https://hn.algolia.com/api/v1/search_by_date?{q}").get("hits", [])
    if not stories:
        return []
    sid = stories[0]["objectID"]
    q = urllib.parse.urlencode({"tags": f"comment,story_{sid}", "numericFilters": f"created_at_i>{since}",
                                "hitsPerPage": cfg.get("max_posts", 60)})
    hits = http_json(f"https://hn.algolia.com/api/v1/search_by_date?{q}").get("hits", [])
    top = [h for h in hits if str(h.get("parent_id")) == str(sid)]  # top-level comments = job posts
    posts = parse_hn({"hits": top})
    for p in posts:
        p.source = "hackernews/hiring"
        p.id = p.id.replace("hackernews:", "hn-hiring:")
        p.title = ""
    return posts


# ---------- Money tier: Meta Ad Library (needs META_AD_LIBRARY_TOKEN) ----------

def parse_meta_ads(payload):
    posts = []
    for ad in payload.get("data", []):
        body = "\n".join(ad.get("ad_creative_bodies") or [])
        if not body:
            continue
        start = ad.get("ad_delivery_start_time") or ""
        try:
            created = int(datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp())
        except ValueError:
            created = 0
        posts.append(Post(
            source="meta-ads", id=f"meta-ad:{ad['id']}",
            # Link to the public library page, never ad_snapshot_url (it embeds the access token).
            url=f"https://www.facebook.com/ads/library/?id={ad['id']}",
            title=ad.get("page_name", ""), text=body, created=created,
            meta={"advertiser": ad.get("page_name")},
        ))
    return posts


def fetch_meta_ads(cfg, since):
    token = os.environ.get("META_AD_LIBRARY_TOKEN")
    if not token:
        print("  meta_ads: skipped (set META_AD_LIBRARY_TOKEN to enable)")
        return []
    posts = []
    for term in cfg.get("search_terms", []):
        q = urllib.parse.urlencode({
            "search_terms": term, "ad_type": "ALL", "ad_active_status": "ACTIVE",
            "ad_reached_countries": json.dumps(cfg.get("countries", ["DE", "FR"])),
            "fields": "id,page_name,ad_creative_bodies,ad_delivery_start_time",
            "limit": cfg.get("per_term", 10), "access_token": token,
        })
        posts += parse_meta_ads(http_json(f"https://graph.facebook.com/v21.0/ads_archive?{q}"))
    return posts


# ---------- Suppressed tier: public Telegram channels (web preview, no login) ----------

class _TgParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.msgs, self._cur, self._depth, self._in_text = [], None, 0, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class") or ""
        if tag == "div" and "data-post" in a and "tgme_widget_message" in cls:
            self._cur = {"post": a["data-post"], "text": "", "time": ""}
            self.msgs.append(self._cur)
        elif self._cur is not None and tag == "div" and "tgme_widget_message_text" in cls:
            self._in_text, self._depth = True, 1
        elif self._in_text and tag == "div":
            self._depth += 1
        elif self._in_text and tag == "br":
            self._cur["text"] += "\n"
        elif self._cur is not None and tag == "time" and a.get("datetime"):
            self._cur["time"] = a["datetime"]

    def handle_endtag(self, tag):
        if self._in_text and tag == "div":
            self._depth -= 1
            if self._depth == 0:
                self._in_text = False

    def handle_data(self, data):
        if self._in_text:
            self._cur["text"] += data


def parse_telegram(page):
    p = _TgParser()
    p.feed(page)
    posts = []
    for m in p.msgs:
        try:
            created = int(datetime.fromisoformat(m["time"]).timestamp()) if m["time"] else 0
        except ValueError:
            created = 0
        text = m["text"].strip()
        if text:
            posts.append(Post(source=f"telegram/{m['post'].split('/')[0]}", id=f"telegram:{m['post']}",
                              url=f"https://t.me/{m['post']}", title="", text=text, created=created))
    return posts


def fetch_telegram(cfg, since):
    posts = []
    for ch in cfg.get("channels", []):
        req = urllib.request.Request(f"https://t.me/s/{urllib.parse.quote(ch)}", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as r:
            posts += [p for p in parse_telegram(r.read().decode("utf-8", "replace")) if p.created >= since]
        time.sleep(1)
    return posts


# ---------- Firsthand tier: local inbox (your own chat/community exports; never committed) ----------

def fetch_inbox(cfg, since):
    """Reads INBOX_DIR/*.jsonl, one {"id","text"[,"title","created","url"]} per line.

    Only import conversations you have the right to process. Raw text stays on your machine:
    only Claude's paraphrased, de-identified record reaches the corpus.
    """
    d = os.environ.get("INBOX_DIR")
    if not d:
        return []
    posts = []
    for f in sorted(Path(d).glob("*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            m = json.loads(line)
            posts.append(Post(source=f"inbox/{f.stem}", id=f"inbox:{f.stem}:{m['id']}",
                              url=m.get("url") or f"inbox:{f.stem}:{m['id']}", title=m.get("title", ""),
                              text=m["text"], created=int(m.get("created") or time.time())))
    return posts


SOURCES = {
    "hackernews": fetch_hackernews, "v2ex": fetch_v2ex, "reddit": fetch_reddit,
    "hn_hiring": fetch_hn_hiring, "meta_ads": fetch_meta_ads,
    "telegram": fetch_telegram, "inbox": fetch_inbox,
}


def collect(config, since, health=None):
    """Run every enabled source; one failing source never stops the others.

    `health` (dict) receives {source: {"tier", "ok", "posts", "error"}} for monitoring.
    """
    out = []
    for name, cfg in config.get("sources", {}).items():
        if not cfg.get("enabled") or name not in SOURCES:
            continue
        tier = cfg.get("tier", "firsthand")
        try:
            got = SOURCES[name](cfg, since)
            for p in got:
                p.meta["tier"] = tier
            print(f"  {name} [{tier}]: {len(got)} posts")
            out += got
            if health is not None:
                health[name] = {"tier": tier, "ok": True, "posts": len(got), "error": ""}
        except Exception as e:  # noqa: BLE001 - a source outage must not kill the run
            print(f"  {name} [{tier}]: FAILED ({type(e).__name__}: {e})")
            if health is not None:
                health[name] = {"tier": tier, "ok": False, "posts": 0, "error": f"{type(e).__name__}: {e}"[:200]}
    return out
