// Issue triage for `need` issues: derive labels from the form and flag possible personal info.
// Used by .github/workflows/label.yml via actions/github-script; pure functions are unit-tested
// in tests/triage.test.js (run: node --test tests/*.test.js).

const MANAGED_PREFIXES = ['area:', '痛度:', '来源:'];
const PRIVACY_LABEL = '隐私待查';

function field(body, heading) {
  const text = (body || '').replace(/\r\n/g, '\n');
  const m = text.match(new RegExp('^### ' + heading + '[^\\n]*\\n+([^\\n]+)', 'm'));
  const v = m ? m[1].trim() : '';
  return v === '_No response_' ? '' : v;
}

// Labels this bot owns, computed from the issue body.
function computeLabels(body) {
  const labels = [];
  const area = field(body, '所属领域');
  if (area) labels.push('area:' + area.split(' / ')[0].trim());
  const sev = field(body, '有多痛').match(/^(\d)/);
  if (sev) labels.push('痛度:' + sev[1]);
  const src = field(body, '信息来源');
  if (src.startsWith('我亲身')) labels.push('来源:亲历');
  else if (src.startsWith('我亲眼')) labels.push('来源:观察');
  else if (src.startsWith('自动发现')) labels.push('来源:自动发现');
  else if (src) labels.push('来源:转述');
  return labels;
}

const PRIVACY_PATTERNS = [
  ['邮箱 / email', /[\w.+-]+@[\w-]+(\.[\w-]+)+/],
  ['中国大陆手机号 / CN mobile', /(?<!\d)1[3-9]\d{9}(?!\d)/],
  ['国际电话 / phone number', /\+\d[\d\s-]{7,}\d/],
  ['身份证号 / ID number', /(?<!\d)\d{17}[\dXx](?!\d)/],
  ['疑似卡号或账号 / card or account number', /(?<!\d)(\d[ -]?){12,19}(?!\d)/],
];

// Returns the kinds of personal info found (never the values themselves).
function findPrivacyIssues(text) {
  return PRIVACY_PATTERNS.filter(([, re]) => re.test(text || '')).map(([kind]) => kind);
}

async function run({ github, context }) {
  const issue = context.payload.issue;
  const repo = context.repo;
  const current = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));

  const wanted = computeLabels(issue.body);
  const stale = current.filter(
    (l) => MANAGED_PREFIXES.some((p) => l.startsWith(p)) && !wanted.includes(l));
  for (const name of stale) {
    await github.rest.issues.removeLabel({ ...repo, issue_number: issue.number, name }).catch(() => {});
  }
  const missing = wanted.filter((l) => !current.includes(l));

  const found = findPrivacyIssues(`${issue.title}\n${issue.body}`);
  if (found.length && !current.includes(PRIVACY_LABEL)) {
    missing.push(PRIVACY_LABEL);
    await github.rest.issues.createComment({
      ...repo,
      issue_number: issue.number,
      body: [
        '🔒 自动检查发现这条需求里可能含有个人信息 / This issue may contain personal information:',
        '',
        ...found.map((k) => `- ${k}`),
        '',
        '请编辑 issue 删除这些内容（地区写到国家或省/州即可）。维护者确认后会移除 `' + PRIVACY_LABEL + '` 标签。',
        'Please edit the issue to remove it. See [PRIVACY.md](../blob/main/PRIVACY.md).',
        '',
        '_误报？没关系，维护者会人工确认。 / False positive? A maintainer will review._',
      ].join('\n'),
    });
  }
  if (missing.length) {
    await github.rest.issues.addLabels({ ...repo, issue_number: issue.number, labels: missing });
  }
  return { added: missing, removed: stale };
}

module.exports = { computeLabels, findPrivacyIssues, run, PRIVACY_LABEL };
