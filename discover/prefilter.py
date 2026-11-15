"""Cheap keyword pre-filter so we only spend model calls on posts likely to describe a need."""
import re

MIN_CHARS = 60
MAX_CHARS = 3000  # longer posts are trimmed before being sent to the model

# Phrases that tend to accompany a lived problem. Weighted roughly by signal strength.
SIGNALS = [
    (3, r"\bi wish (there was|i could|someone)\b"),
    (3, r"\bis there (a|any) (way|app|tool|service)\b"),
    (2, r"\b(struggl|frustrat|exhaust|overwhelm|desperate|stuck|can'?t afford|no idea how)\w*"),
    (2, r"\b(every (single )?(time|day|week)|hours? (a|per) (day|week)|waste[sd]? (hours|days))\b"),
    (2, r"\bmy (mom|mum|dad|parents?|grandma|grandpa|kid|son|daughter|wife|husband|patient|student)s?\b"),
    (1, r"\b(help|advice|problem|issue|nightmare|impossible|afford|cost|denied|waitlist)\b"),
    (3, r"(有没有(什么|办法|工具|软件)|求推荐|怎么办|太难了|好难|崩溃|头疼|没人管|没办法)"),
    (2, r"(每次都|每天都|每个月都|浪费.{0,4}(时间|钱)|花了.{0,6}(小时|天|万|千)|付不起|看不起病)"),
    (2, r"(我(妈|爸|父母|爷爷|奶奶|孩子|老婆|老公)|老人|残疾|视障|骑手|房东|中介)"),
    (1, r"(问题|麻烦|困扰|焦虑|担心|吐槽|坑)"),
]
NOISE = [
    r"\b(hiring|we'?re hiring|launch(ed|ing)? (my|our)|show hn|promo code|giveaway)\b",
    r"(招聘|内推|推广|优惠码|抽奖|出售|转让|求购)",
]
_SIG = [(w, re.compile(p, re.I)) for w, p in SIGNALS]
_NOISE = [re.compile(p, re.I) for p in NOISE]


def score(post):
    text = f"{post.title}\n{post.text}"
    if len(text.strip()) < MIN_CHARS:
        return 0
    if post.meta.get("tier") == "money":
        return 5  # job posts and ads are evidence by construction; the model judges them
    if any(rx.search(text) for rx in _NOISE):
        return 0
    return sum(w for w, rx in _SIG if rx.search(text))


def select(posts, limit, min_score=2, money_share=1 / 3):
    """Highest-signal posts first, capped at `limit`; money-tier posts take at most `money_share` of it."""
    scored = [(score(p), p) for p in posts]
    keep = [p for s, p in sorted(scored, key=lambda x: -x[0]) if s >= min_score]
    money = [p for p in keep if p.meta.get("tier") == "money"][:int(limit * money_share)]
    rest = [p for p in keep if p.meta.get("tier") != "money"]
    out = (money + rest)[:limit]
    for p in out:
        p.text = p.text[:MAX_CHARS]
    return out
