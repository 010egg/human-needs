// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { computeLabels, findPrivacyIssues, run, PRIVACY_LABEL } = require('../scripts/triage.js');
const issues = require(path.join(__dirname, 'fixtures/issues.json'));

test('computeLabels from form body', () => {
  assert.deepStrictEqual(computeLabels(issues[0].body), ['area:健康医疗', '痛度:4', '来源:亲历']);
  assert.deepStrictEqual(computeLabels(issues[1].body), ['area:心理与社交', '痛度:2', '来源:转述']);
  assert.deepStrictEqual(computeLabels(issues[2].body), ['area:其他', '痛度:1', '来源:观察']);
  assert.deepStrictEqual(computeLabels(''), []);
});

test('privacy detection', () => {
  assert.deepStrictEqual(findPrivacyIssues(issues[0].body), []);
  assert.deepStrictEqual(findPrivacyIssues('我 70 岁，每月花 300 元，2026 年'), []);
  assert.ok(findPrivacyIssues('联系 foo.bar@example.com').length);
  assert.ok(findPrivacyIssues('电话13812345678').some((k) => k.includes('手机')));
  assert.ok(findPrivacyIssues('call +254 712 345 678').some((k) => k.includes('phone')));
  assert.ok(findPrivacyIssues('110101199003071234').some((k) => k.includes('ID')));
  assert.ok(findPrivacyIssues('卡号 6222 0212 3456 7890').some((k) => k.includes('card')));
});

function fakeGithub() {
  const calls = [];
  const rec = (name) => async (args) => { calls.push([name, args]); };
  return { calls, rest: { issues: { removeLabel: rec('remove'), addLabels: rec('add'), createComment: rec('comment') } } };
}

test('run removes stale labels and flags privacy once', async () => {
  const github = fakeGithub();
  const issue = {
    number: 7,
    title: 't',
    body: issues[0].body + '\n\n邮箱 a@b.co',
    labels: [{ name: 'need' }, { name: 'area:养老' }, { name: '痛度:4' }],
  };
  const res = await run({ github, context: { repo: { owner: 'o', repo: 'r' }, payload: { issue } } });
  assert.deepStrictEqual(res.removed, ['area:养老']);
  assert.deepStrictEqual(res.added, ['area:健康医疗', '来源:亲历', PRIVACY_LABEL]);
  assert.strictEqual(github.calls.filter(([n]) => n === 'comment').length, 1);

  // Already flagged: no second comment.
  const github2 = fakeGithub();
  issue.labels.push({ name: PRIVACY_LABEL });
  await run({ github: github2, context: { repo: { owner: 'o', repo: 'r' }, payload: { issue } } });
  assert.strictEqual(github2.calls.filter(([n]) => n === 'comment').length, 0);
});
