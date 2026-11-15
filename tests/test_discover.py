"""Run: python -m unittest discover tests  (no network, no API key needed)"""
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from discover import extract, match, prefilter, run, sources  # noqa: E402
from discover.common import find_privacy_issues, load_config  # noqa: E402
from discover.publish import issue_body, labels_for  # noqa: E402
import export_needs  # noqa: E402

FX = json.loads((ROOT / "tests/fixtures/sources.json").read_text(encoding="utf-8"))


def all_posts():
    return (sources.parse_hn(FX["hackernews"]) + sources.parse_v2ex(FX["v2ex"])
            + sources.parse_reddit(FX["reddit"], "Teachers"))


def result(post_id, **kw):
    r = {"post_id": post_id, "is_real_need": True, "confidence": 0.9, "title": "老人不会线上挂号",
         "problem": "医院只能线上挂号，老人不会用手机，子女每次都要请假回去帮忙挂号，耽误工作。",
         "who": "高龄老人及其子女", "area": "健康医疗 / Health", "severity": 4, "frequency": "monthly",
         "workaround": "子女请假代办", "region": "中国", "duplicate_of": 0, "reason": "concrete lived problem",
         "kind": "complaint", "need_key": "老人线上挂号困难", "cost": 2, "cost_evidence": "每次请假一天",
         "dissatisfaction": 2, "dissatisfaction_evidence": "医院只提供小程序", "pay": 1, "pay_evidence": "",
         "existing_solutions": [{"name": "医院小程序", "complaint": "老人不会用"}], "company": ""}
    r.update(kw)
    return r


class FakeClient:
    """Mimics client.beta.messages.create and records the requests it receives."""
    def __init__(self, responder):
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))
        self.responder = responder

    def _create(self, **kw):
        self.calls.append(kw)
        ids = re.findall(r'<post id="([^"]+)"', kw["messages"][0]["content"])
        payload = {"results": [self.responder(i) for i in ids]}
        return SimpleNamespace(stop_reason="end_turn",
                               content=[SimpleNamespace(type="thinking", thinking=""),
                                        SimpleNamespace(type="text", text=json.dumps(payload, ensure_ascii=False))])


class FakeGitHub:
    def __init__(self):
        self.issues, self.comments, self.n = [], [], 100

    def create_issue(self, title, body, labels):
        self.n += 1
        self.issues.append((title, body, labels))
        return {"number": self.n}

    def comment(self, number, body):
        self.comments.append((number, body))


class SourcesTest(unittest.TestCase):
    def test_parsers(self):
        hn = sources.parse_hn(FX["hackernews"])
        self.assertEqual(hn[0].id, "hackernews:101")
        self.assertIn("\n", hn[0].text)          # <p> became a newline
        self.assertNotIn("<p>", hn[0].text)
        self.assertEqual(hn[0].title, "Ask HN: What problem do you face every week?")
        rd = sources.parse_reddit(FX["reddit"], "Teachers")
        self.assertEqual(len(rd), 1)             # stickied thread dropped
        self.assertEqual(rd[0].source, "reddit/r/Teachers")
        self.assertTrue(rd[0].url.startswith("https://www.reddit.com/r/Teachers/"))


class TieredSourcesTest(unittest.TestCase):
    def test_telegram(self):
        page = (ROOT / "tests/fixtures/telegram.html").read_text(encoding="utf-8")
        posts = sources.parse_telegram(page)
        self.assertEqual([p.id for p in posts], ["telegram:examplechan/11", "telegram:examplechan/12"])
        self.assertEqual(posts[0].text, "第一行\n第二行 有链接")
        self.assertEqual(posts[0].url, "https://t.me/examplechan/11")
        self.assertGreater(posts[0].created, 0)

    def test_meta_ads_never_leak_token_url(self):
        payload = {"data": [{"id": "55", "page_name": "CareCo", "ad_creative_bodies": ["Caring for a parent?"],
                             "ad_delivery_start_time": "2026-11-01T00:00:00+0000",
                             "ad_snapshot_url": "https://x/?access_token=SECRET"}]}
        p = sources.parse_meta_ads(payload)[0]
        self.assertNotIn("SECRET", json.dumps(p.to_dict()))
        self.assertEqual(p.url, "https://www.facebook.com/ads/library/?id=55")

    def test_collect_tiers_and_health(self):
        cfg = {"sources": {"a": {"enabled": True, "tier": "money"}, "b": {"enabled": True}}}
        fake = {"a": lambda c, s: [sources.Post("a", "a:1", "u", "", "x", 0)],
                "b": lambda c, s: (_ for _ in ()).throw(OSError("down"))}
        with unittest.mock.patch.dict(sources.SOURCES, fake, clear=True):
            health = {}
            posts = sources.collect(cfg, 0, health)
        self.assertEqual(posts[0].meta["tier"], "money")
        self.assertFalse(health["b"]["ok"])
        self.assertEqual(health["b"]["tier"], "firsthand")

    def test_money_tier_bypasses_noise_filter(self):
        job = sources.Post("hackernews/hiring", "j:1", "u", "", "We're hiring nurses-scheduling engineers. " * 3, 0,
                           meta={"tier": "money"})
        self.assertEqual(prefilter.select([job], 9), [job])


class PrefilterTest(unittest.TestCase):
    def test_select(self):
        picked = {p.id for p in prefilter.select(all_posts(), limit=10)}
        self.assertEqual(picked, {"hackernews:101", "v2ex:9001", "reddit:abc"})


class MatchTest(unittest.TestCase):
    def test_shortlist_finds_similar(self):
        needs = [{"id": 1, "title": "老人不会线上挂号", "problem": "医院只能线上挂号老人不会用"},
                 {"id": 2, "title": "外卖骑手没有休息的地方", "problem": "骑手夏天没地方休息"}]
        p = [x for x in all_posts() if x.id == "v2ex:9001"]
        self.assertEqual(match.shortlist(p, needs, per_post=1)[0]["id"], 1)


class ExtractTest(unittest.TestCase):
    def test_request_and_validation(self):
        posts = prefilter.select(all_posts(), 10)
        client = FakeClient(lambda i: result(i, duplicate_of=999))
        out = extract.Extractor("claude-opus-5-5", client=client).screen(posts, [{"id": 5, "title": "x"}])
        self.assertEqual(len(out), 3)
        self.assertTrue(all(r["duplicate_of"] == 0 for r in out))  # unknown id discarded
        req = client.calls[0]
        self.assertEqual(req["model"], "claude-opus-5-5")
        self.assertEqual(req["output_config"]["format"]["type"], "json_schema")
        self.assertIn("<existing_needs>", req["messages"][0]["content"])

    def test_areas_match_template(self):
        tpl = (ROOT / ".github/ISSUE_TEMPLATE/need.yml").read_text(encoding="utf-8")
        for a in extract.AREAS:
            self.assertIn(f"- {a}\n", tpl)
        for f in extract.FREQUENCIES.values():
            self.assertIn(f"- {f}\n", tpl)


class PublishTest(unittest.TestCase):
    def test_issue_body_roundtrips_through_export(self):
        post = all_posts()[0]
        parsed = export_needs.parse_body(issue_body(result(post.id), post))
        self.assertEqual(parsed["severity"], 4)
        self.assertEqual(parsed["area"], "健康医疗")
        self.assertEqual(parsed["frequency_key"], "monthly")
        self.assertEqual(parsed["source_key"], "auto")
        self.assertEqual(parsed["source_url"], post.url)
        self.assertEqual(parsed["willingness_to_pay_key"], "")
        self.assertIn("来源:自动发现", labels_for(result(post.id)))


class RunTest(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config()
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_end_to_end(self):
        def responder(pid):
            if pid == "reddit:abc":
                return result(pid, is_real_need=False, confidence=0.8, reason="no")
            if pid == "v2ex:9001":
                return result(pid, problem="联系我 13812345678 医院只能线上挂号老人不会用手机")
            return result(pid)
        gh = FakeGitHub()
        report, seen, signals, records = run.run(
            self.cfg, extract.Extractor("m", client=FakeClient(responder)),
            github=gh, now=1763300000, state_dir=self.state, posts=all_posts(), needs=[])
        self.assertEqual(len(gh.issues), 1)                       # only the HN post passes every gate
        title, body, labels = gh.issues[0]
        self.assertIn("news.ycombinator.com/item?id=101", body)
        self.assertIn("| 代价 cost | 2/3 |", body)
        whys = sorted(r["why"] for r in report["rejected"])
        self.assertEqual(whys, ["not a need / low confidence", "personal info in output"])
        self.assertEqual(len(records), 3)                          # every screened post enters the corpus
        self.assertEqual(sum(r["is_need"] for r in records), 2)
        self.assertNotIn("text", records[0])                       # never raw post text
        self.assertEqual(len(seen), len(all_posts()))              # every post is now seen
        self.assertEqual(signals, {"101": [{"source": "hackernews",
                                            "url": "https://news.ycombinator.com/item?id=101",
                                            "found_at": 1763300000}]})

    def test_duplicate_becomes_evidence(self):
        gh = FakeGitHub()
        posts = [p for p in all_posts() if p.id == "v2ex:9001"]
        ex = extract.Extractor("m", client=FakeClient(lambda i: result(i, duplicate_of=7)))
        report, _, signals, _ = run.run(self.cfg, ex, github=gh, now=1, state_dir=self.state, posts=posts,
                                        needs=[{"id": 7, "title": "老人不会线上挂号", "problem": "x"}])
        self.assertEqual(gh.issues, [])
        self.assertEqual(gh.comments[0][0], 7)
        self.assertEqual(list(signals), ["7"])

    def test_failed_batch_is_retried_next_time(self):
        class Boom:
            def screen(self, *a):
                raise RuntimeError("api down")
        report, seen, _, _ = run.run(self.cfg, Boom(), now=1, state_dir=self.state, posts=all_posts(), needs=[])
        self.assertEqual(report["failed_batches"], 1)
        self.assertNotIn("hackernews:101", seen)
        self.assertIn("hackernews:102", seen)                     # prefiltered-out posts are still marked

    def test_ruler_gate_and_repetition(self):
        cfg = dict(self.cfg, min_ruler_score=6)
        weak = lambda i: result(i, cost=1, dissatisfaction=1, pay=1)  # noqa: E731  3 + repetition bonus
        ex = extract.Extractor("m", client=FakeClient(weak))
        report, _, _, records = run.run(cfg, ex, github=FakeGitHub(), now=1, state_dir=self.state,
                                        posts=all_posts(), needs=[])
        # Same need_key seen 3 times in this run: bonus 0, 1, 2 -> scores 3, 4, 5, all below 6.
        self.assertEqual(report["new"], [])
        self.assertTrue(all(r["why"].startswith("ruler") for r in report["rejected"]))
        # Those sightings are now history: the next sighting gets the full +3 bonus and passes.
        from discover.corpus import Corpus
        Corpus(self.state).append(records, now=1)
        post = [p for p in all_posts() if p.id == "hackernews:101"][0]
        post.id, post.url = "hackernews:999", "https://news.ycombinator.com/item?id=999"
        report, *_ = run.run(cfg, ex, github=FakeGitHub(), now=2, state_dir=self.state, posts=[post], needs=[])
        self.assertEqual(report["new"][0]["ruler"], 6)

    def test_privacy(self):
        self.assertEqual(find_privacy_issues("每月花 300 元"), [])
        self.assertTrue(find_privacy_issues("a@b.co"))


import unittest.mock  # noqa: E402

if __name__ == "__main__":
    unittest.main()
