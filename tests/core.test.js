// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const core = require('../site/core.js');
const issues = require('./fixtures/issues.json');

const ROOT = path.join(__dirname, '..');

test('issue body parsing matches the Python exporter', () => {
  const py = JSON.parse(execFileSync('python3', ['-c', `
import json, sys; sys.path.insert(0, 'scripts'); import export_needs as e
print(json.dumps([e.parse_body(i["body"]) for i in json.load(open("tests/fixtures/issues.json")) if "pull_request" not in i], ensure_ascii=False))
`], { cwd: ROOT }).toString());
  issues.filter((i) => !i.pull_request).forEach((issue, idx) => {
    const js = core.parseIssueBody(issue.body);
    for (const k of ['problem', 'who', 'area', 'area_en', 'workaround', 'region', 'frequency_key', 'source_key']) {
      assert.strictEqual(js[k] || '', py[idx][k] || '', `${k} differs for issue ${issue.number}`);
    }
    assert.strictEqual(js.severity, py[idx].severity);
  });
});

test('ruler matches discover/ruler.py', () => {
  const cases = [[0, 0, 0, 1], [3, 3, 3, 9], [1, 2, 0, 3], [2, 1, 1, 2]];
  const py = JSON.parse(execFileSync('python3', ['-c', `
import json; from discover import ruler
print(json.dumps([ruler.score({"cost": c, "dissatisfaction": d, "pay": p}, rep) for c, d, p, rep in ${JSON.stringify(cases)}]))
`], { cwd: ROOT }).toString());
  assert.deepStrictEqual(cases.map(([c, d, p, rep]) => core.rulerScore({ cost: c, dissatisfaction: d, pay: p }, rep)), py);
});

test('issueToRecord derives conservative scores', () => {
  const r = core.issueToRecord(issues[0], { 1: [{}, {}] });
  assert.strictEqual(r.cost, 2);            // severity 4
  assert.strictEqual(r.pay, 2);             // moderate
  assert.strictEqual(r.dissatisfaction, 1); // workaround given
  assert.strictEqual(r.extra_repetition, 7); // 5 👍 + 2 sightings
  assert.strictEqual(core.issueToRecord(issues[2]).is_need, false); // duplicate
});

test('countries normalize across languages', () => {
  assert.strictEqual(core.countryOf('中国·四川').id, '156');
  assert.strictEqual(core.countryOf('USA').id, '840');
  assert.strictEqual(core.countryOf('Kenya').name, '肯尼亚');
  assert.deepStrictEqual(core.countryOf('Atlantis'), { id: '', name: 'Atlantis' });
  assert.strictEqual(core.countryOf(''), null);
  const atlas = require('../site/vendor/countries-110m.json');
  const ids = new Set(atlas.objects.countries.geometries.map((g) => g.id));
  const missing = core.COUNTRY_TABLE.filter(([id]) => !ids.has(id) && !['344', '702'].includes(id)); // HK/SG too small for 110m
  assert.deepStrictEqual(missing.map((c) => c[1]), []);
});

test('wilson interval', () => {
  const w = core.wilson(11, 1000);
  assert.ok(w.lo > 0.005 && w.lo < 0.0111 && w.hi > 0.0111 && w.hi < 0.02);
  assert.deepStrictEqual(core.wilson(0, 0), { p: 0, lo: 0, hi: 1 });
});

function rec(i, over) {
  return { url: `u${i}`, is_need: true, need_key: 'k', area: '健康医疗', tier: 'firsthand', kind: 'complaint',
    cost: 0, dissatisfaction: 0, pay: 0, severity: 3, screened_at: 1000 + i, created: 1000 + i, ...over };
}

test('hypotheses can be supported, refuted, or left open', () => {
  const recs = [];
  for (let i = 0; i < 1000; i++) recs.push(rec(i, { area: i < 11 ? '养老' : '健康医疗' }));
  const h = { id: 'h', of: { is_need: true }, subset: { area: ['养老'] }, op: '>', threshold: 0.05, min_n: 100 };
  assert.strictEqual(core.evaluateHypothesis(h, recs).verdict, 'refuted');
  assert.strictEqual(core.evaluateHypothesis({ ...h, op: '<' }, recs).verdict, 'supported');
  assert.strictEqual(core.evaluateHypothesis({ ...h, threshold: 0.011 }, recs).verdict, 'inconclusive');
  assert.strictEqual(core.evaluateHypothesis(h, recs.slice(0, 50)).verdict, 'insufficient');
  // asOf: only records screened before the cutoff count
  assert.strictEqual(core.evaluateHypothesis(h, recs, 1005).n, 5);
  assert.strictEqual(core.hypothesisHistory(h, recs, 3, 2000).length, 3);
});

test('filters, keywords and min_ruler', () => {
  const r = rec(1, { title: 'Caregiver burnout', region: '美国', cost: 2, pay: 2 });
  const rep = new Map([['k', 3]]);
  assert.ok(core.matches(r, { country: ['840'], keywords: ['护理', 'caregiver'] }));
  assert.ok(!core.matches(r, { country: ['156'] }));
  assert.ok(core.matches(r, { min_ruler: 6 }, { rep }));   // 2+0+2+2
  assert.ok(!core.matches(r, { min_ruler: 7 }, { rep }));
  assert.ok(!core.matches(r, { q: 'caregiver unrelated' }));
});

test('landscape and clusters', () => {
  const recs = [
    rec(1, { existing_solutions: [{ name: 'CareApp', complaint: '太贵' }] }),
    rec(2, { existing_solutions: [{ name: 'careapp ', complaint: '太贵' }, { name: 'Other', complaint: '' }] }),
    rec(3, { kind: 'job', company: 'CareCo', need_key: 'k2' }),
    rec(4, { is_need: false, existing_solutions: [{ name: 'Ignored', complaint: 'x' }] }),
  ];
  const l = core.landscape(recs);
  assert.strictEqual(l[0].key, 'careapp');
  assert.strictEqual(l[0].mentions, 2);
  assert.deepStrictEqual(l[0].complaints, [['太贵', 2]]);
  assert.strictEqual(l.find((e) => e.key === 'careco').funded, 1);
  assert.ok(!l.some((e) => e.key === 'ignored'));
  const cl = core.clusters(recs, core.repetition(recs));
  assert.strictEqual(cl.find((c) => c.key === 'k').repetition, 2);
});

test('painScore', () => {
  assert.ok(core.painScore('My parents are 80 and every single time they need a doctor I have to take a day off work.') >= 4);
  assert.strictEqual(core.painScore("We're hiring! Show HN: my new tool for everything you could ever need"), 0);
});
