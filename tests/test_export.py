"""Run: python -m unittest discover tests"""
import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import export_needs as ex  # noqa: E402

FIXTURE = json.loads((ROOT / "tests/fixtures/issues.json").read_text(encoding="utf-8"))


def records():
    return sorted((ex.to_record(i) for i in FIXTURE if "pull_request" not in i), key=lambda n: n["id"])


class ParseTest(unittest.TestCase):
    def test_fields(self):
        a = records()[0]
        self.assertEqual(a["title"], "测试样例 A：多行问题描述")
        self.assertEqual(a["problem"], "第一行\n第二行 | 含竖线")
        self.assertEqual(a["area"], "健康医疗")
        self.assertEqual(a["area_en"], "Health")
        self.assertEqual(a["severity"], 4)
        self.assertEqual(a["frequency_key"], "daily")
        self.assertEqual(a["willingness_to_pay_key"], "moderate")
        self.assertEqual(a["source_key"], "firsthand")
        self.assertEqual(a["region"], "中国·四川")
        self.assertEqual(a["status"], "已整理")
        self.assertEqual(a["upvotes"], 5)
        self.assertFalse(a["duplicate"])

    def test_no_response_and_keys(self):
        b = records()[1]
        self.assertEqual(b["workaround"], "")
        self.assertEqual(b["willingness_to_pay_key"], "")
        self.assertEqual(b["area_en"], "Mental health & Social")
        self.assertEqual(b["frequency_key"], "rare")
        self.assertEqual(b["source_key"], "hearsay")

    def test_duplicate(self):
        c = records()[2]
        self.assertTrue(c["duplicate"])
        self.assertEqual(c["source_key"], "observed")

    def test_empty_body(self):
        out = ex.parse_body(None)
        self.assertEqual(out["frequency_key"], "")
        self.assertNotIn("severity", out)

    def test_template_options_have_keys(self):
        """Every dropdown option in the issue form must map to a machine key."""
        tpl = (ROOT / ".github/ISSUE_TEMPLATE/need.yml").read_text(encoding="utf-8")
        for zh, table in [("每天", ex.FREQUENCY_KEYS), ("不愿或无力付费", ex.PAY_KEYS), ("我亲身经历", ex.SOURCE_KEYS)]:
            block = tpl[tpl.index(zh) - 20:].split("validations:")[0]
            opts = [l.strip()[2:] for l in block.splitlines() if l.strip().startswith("- ")]
            self.assertTrue(opts)
            for o in opts:
                self.assertTrue(ex._key(o, table), f"no key for option {o!r}")


class OutputTest(unittest.TestCase):
    def test_write_outputs(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            ex.write_outputs(records(), out)
            data = json.loads((out / "needs.json").read_text(encoding="utf-8"))
            self.assertEqual([n["id"] for n in data], [1, 2, 3])

            with (out / "needs.csv").open(encoding="utf-8-sig", newline="") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 3)
            self.assertEqual(rows[0]["problem"], "第一行\n第二行 | 含竖线")

            stats = (out / "STATS.md").read_text(encoding="utf-8")
            self.assertIn("需求总数：**2**", stats)  # duplicate excluded
            self.assertIn("重复已合并", stats)
            self.assertNotIn("重复样例", stats)
            self.assertIn("| 中国 | 1 |", stats)


if __name__ == "__main__":
    unittest.main()
