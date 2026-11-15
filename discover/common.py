"""Shared types and helpers for the discovery pipeline."""
import html
import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
USER_AGENT = "human-needs-discovery/1.0 (+https://github.com/010egg/human-needs)"


@dataclass
class Post:
    """One public post or comment from a source, normalized."""
    source: str          # e.g. "hackernews", "v2ex", "reddit/r/Teachers"
    id: str              # globally unique: "<source>:<native id>"
    url: str
    title: str
    text: str
    created: int         # unix seconds
    meta: dict = field(default_factory=dict)

    def to_dict(self):
        return asdict(self)


def load_config(path=CONFIG_PATH):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def http_json(url, headers=None, data=None, retries=3, timeout=30):
    """GET (or POST when data is given) a JSON endpoint with retry + backoff."""
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def strip_html(s):
    s = re.sub(r"<(br|p|/p|li)[^>]*>", "\n", s or "", flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


# Keep in sync with scripts/triage.js (PRIVACY_PATTERNS).
PRIVACY_PATTERNS = [
    ("email", re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")),
    ("cn_mobile", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("phone", re.compile(r"\+\d[\d\s-]{7,}\d")),
    ("id_number", re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")),
    ("card_number", re.compile(r"(?<!\d)(\d[ -]?){12,19}(?!\d)")),
]


def find_privacy_issues(text):
    return [kind for kind, rx in PRIVACY_PATTERNS if rx.search(text or "")]
