// Pure data logic for the dashboard. No DOM. Loaded by index.html and by tests/core.test.js.
(function (root) {
  'use strict';

  // ---------- Issue form parsing (mirrors scripts/export_needs.py) ----------
  const FIELDS = {
    '遇到了什么问题': 'problem', '谁有这个需求': 'who', '所属领域': 'area', '现在怎么凑合解决': 'workaround',
    '有多痛': 'severity', '多频繁': 'frequency', '愿意为解决它付出多少': 'willingness_to_pay',
    '国家/地区': 'region', '信息来源': 'source', '补充': 'extra', '原始来源': 'source_url',
  };
  const KEYS = {
    frequency: { '每天': 'daily', '每周': 'weekly', '每月': 'monthly', '每年几次': 'yearly', '一生中少数关键时刻': 'rare' },
    willingness_to_pay: { '不愿或无力付费': 'none', '少量': 'little', '中等': 'moderate', '很多': 'high', '不确定': 'unsure' },
    source: { '我亲身经历': 'firsthand', '我亲眼观察': 'observed', '听说或从网上': 'hearsay', '自动发现': 'auto' },
  };
  const keyOf = (v, table) => { for (const k in table) if ((v || '').startsWith(k)) return table[k]; return ''; };

  function parseIssueBody(body) {
    const out = {};
    const blocks = (body || '').replace(/\r\n/g, '\n').split(/^### /m).slice(1);
    for (const block of blocks) {
      const nl = block.indexOf('\n');
      const head = nl < 0 ? block : block.slice(0, nl);
      let value = nl < 0 ? '' : block.slice(nl + 1).trim();
      if (value === '_No response_') value = '';
      for (const zh in FIELDS) if (head.startsWith(zh)) { out[FIELDS[zh]] = value; break; }
    }
    const sev = (out.severity || '').match(/^\s*(\d)/);
    out.severity = sev ? Number(sev[1]) : 0;
    const [zh, en] = (out.area || '').split(' / ');
    out.area = (zh || '').trim();
    out.area_en = (en || '').trim();
    out.frequency_key = keyOf(out.frequency, KEYS.frequency);
    out.pay_key = keyOf(out.willingness_to_pay, KEYS.willingness_to_pay);
    out.source_key = keyOf(out.source, KEYS.source);
    return out;
  }

  // Human-submitted issue -> corpus-shaped record, so both feeds share one model.
  // Human forms carry no explicit cost/pay evidence, so we derive conservative scores:
  //   cost from severity (3->1, 4->2, 5->3), pay from the willingness dropdown,
  //   dissatisfaction 1 if a workaround is described. Repetition = 1 + 👍 + auto sightings.
  const PAY_SCORE = { none: 0, little: 1, moderate: 2, high: 3, unsure: 0, '': 0 };
  function issueToRecord(issue, signals) {
    const f = parseIssueBody(issue.body);
    const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    const auto = f.source_key === 'auto';
    const created = Math.floor(Date.parse(issue.created_at) / 1000) || 0;
    return {
      id: `issue:${issue.number}`, issue: issue.number, url: issue.html_url,
      source: auto ? 'auto' : 'github', tier: 'firsthand', kind: 'complaint',
      created, screened_at: created, is_need: !labels.includes('duplicate'),
      confidence: 1, need_key: `#${issue.number}`, title: (issue.title || '').replace(/^\[需求\]\s*/, ''),
      problem: f.problem || '', who: f.who || '', area: f.area, severity: f.severity,
      frequency: f.frequency_key, region: f.region || '', workaround: f.workaround || '',
      cost: Math.max(0, Math.min(3, f.severity - 2)), cost_evidence: '',
      dissatisfaction: f.workaround ? 1 : 0, dissatisfaction_evidence: '',
      pay: PAY_SCORE[f.pay_key] || 0, pay_evidence: '', existing_solutions: [], company: '',
      upvotes: (issue.reactions && issue.reactions['+1']) || 0,
      extra_repetition: ((issue.reactions && issue.reactions['+1']) || 0) + ((signals || {})[issue.number] || []).length,
      state: issue.state, labels, updated_at: issue.updated_at, origin: 'issues',
      reason: '',
    };
  }

  // ---------- Countries (ISO 3166 numeric = world-atlas ids) ----------
  // [id, 中文名, aliases...]. Matching is on the first segment of `region` ("中国·四川" -> "中国").
  const COUNTRY_TABLE = [
    ['156', '中国', 'china', 'prc', '中国大陆', '大陆'], ['158', '台湾', 'taiwan'], ['344', '香港', 'hong kong', 'hk'],
    ['840', '美国', 'united states', 'united states of america', 'usa', 'us', 'america'],
    ['124', '加拿大', 'canada'], ['484', '墨西哥', 'mexico'], ['076', '巴西', 'brazil'], ['032', '阿根廷', 'argentina'],
    ['152', '智利', 'chile'], ['170', '哥伦比亚', 'colombia'], ['604', '秘鲁', 'peru'], ['862', '委内瑞拉', 'venezuela'],
    ['826', '英国', 'united kingdom', 'uk', 'britain', 'england', 'scotland', 'wales'], ['372', '爱尔兰', 'ireland'],
    ['250', '法国', 'france'], ['276', '德国', 'germany'], ['380', '意大利', 'italy'], ['724', '西班牙', 'spain'],
    ['620', '葡萄牙', 'portugal'], ['528', '荷兰', 'netherlands', 'holland'], ['056', '比利时', 'belgium'],
    ['756', '瑞士', 'switzerland'], ['040', '奥地利', 'austria'], ['752', '瑞典', 'sweden'], ['578', '挪威', 'norway'],
    ['208', '丹麦', 'denmark'], ['246', '芬兰', 'finland'], ['616', '波兰', 'poland'], ['203', '捷克', 'czechia', 'czech republic'],
    ['348', '匈牙利', 'hungary'], ['642', '罗马尼亚', 'romania'], ['300', '希腊', 'greece'], ['804', '乌克兰', 'ukraine'],
    ['643', '俄罗斯', 'russia'], ['792', '土耳其', 'turkey', 'türkiye'], ['376', '以色列', 'israel'],
    ['682', '沙特阿拉伯', 'saudi arabia', '沙特'], ['784', '阿联酋', 'united arab emirates', 'uae'], ['364', '伊朗', 'iran'],
    ['368', '伊拉克', 'iraq'], ['818', '埃及', 'egypt'], ['504', '摩洛哥', 'morocco'], ['012', '阿尔及利亚', 'algeria'],
    ['566', '尼日利亚', 'nigeria'], ['288', '加纳', 'ghana'], ['404', '肯尼亚', 'kenya'], ['231', '埃塞俄比亚', 'ethiopia'],
    ['834', '坦桑尼亚', 'tanzania'], ['800', '乌干达', 'uganda'], ['646', '卢旺达', 'rwanda'], ['710', '南非', 'south africa'],
    ['716', '津巴布韦', 'zimbabwe'], ['180', '刚果（金）', 'dr congo', 'democratic republic of the congo', 'dem. rep. congo'],
    ['356', '印度', 'india'], ['586', '巴基斯坦', 'pakistan'], ['050', '孟加拉国', 'bangladesh', '孟加拉'],
    ['144', '斯里兰卡', 'sri lanka'], ['524', '尼泊尔', 'nepal'], ['004', '阿富汗', 'afghanistan'],
    ['392', '日本', 'japan'], ['410', '韩国', 'south korea', 'korea'], ['408', '朝鲜', 'north korea'],
    ['496', '蒙古', 'mongolia'], ['704', '越南', 'vietnam', 'viet nam'], ['764', '泰国', 'thailand'],
    ['458', '马来西亚', 'malaysia'], ['702', '新加坡', 'singapore'], ['360', '印度尼西亚', 'indonesia', '印尼'],
    ['608', '菲律宾', 'philippines'], ['104', '缅甸', 'myanmar', 'burma'], ['116', '柬埔寨', 'cambodia'],
    ['418', '老挝', 'laos'], ['398', '哈萨克斯坦', 'kazakhstan'], ['860', '乌兹别克斯坦', 'uzbekistan'],
    ['036', '澳大利亚', 'australia', '澳洲'], ['554', '新西兰', 'new zealand'],
  ];
  const COUNTRY_INDEX = new Map();
  const COUNTRY_NAME = new Map();
  for (const [id, zh, ...aliases] of COUNTRY_TABLE) {
    COUNTRY_NAME.set(id, zh);
    for (const a of [zh, ...aliases]) COUNTRY_INDEX.set(a.toLowerCase(), id);
  }
  function countryOf(region) {
    const first = (region || '').split(/[·・,，/|]/)[0].trim().toLowerCase();
    if (!first) return null;
    const id = COUNTRY_INDEX.get(first);
    return id ? { id, name: COUNTRY_NAME.get(id) } : { id: '', name: region.split(/[·・,，/|]/)[0].trim() };
  }

  // ---------- The ruler (mirrors discover/ruler.py) ----------
  const repetitionBonus = (rep) => Math.max(0, Math.min(3, Math.floor(rep) - 1));
  const rulerScore = (r, rep) => (r.cost || 0) + (r.dissatisfaction || 0) + (r.pay || 0) + repetitionBonus(rep || 1);

  // need_key -> distinct URLs (independent sightings), plus any extra repetition (👍 on issues).
  function repetition(records) {
    const urls = new Map();
    const extra = new Map();
    for (const r of records) {
      if (!r.is_need || !r.need_key) continue;
      if (!urls.has(r.need_key)) urls.set(r.need_key, new Set());
      urls.get(r.need_key).add(r.url);
      if (r.extra_repetition) extra.set(r.need_key, (extra.get(r.need_key) || 0) + r.extra_repetition);
    }
    const out = new Map();
    for (const [k, s] of urls) out.set(k, s.size + (extra.get(k) || 0));
    return out;
  }

  // ---------- Statistics ----------
  // Wilson score interval: honest bounds for a proportion, sane at small n.
  function wilson(k, n, z = 1.96) {
    if (!n) return { p: 0, lo: 0, hi: 1 };
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = p + (z * z) / (2 * n);
    const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
  }

  // ---------- Filters (also the hypothesis DSL) ----------
  // f: { is_need, area[], tier[], kind[], country[], keywords[], need_key, solution,
  //      min_cost, min_dissatisfaction, min_pay, min_severity, min_ruler, since, until, q }
  function matches(r, f, ctx) {
    if (!f) return true;
    if (f.is_need !== undefined && f.is_need !== null && r.is_need !== f.is_need) return false;
    if (f.area && f.area.length && !f.area.includes(r.area)) return false;
    if (f.tier && f.tier.length && !f.tier.includes(r.tier)) return false;
    if (f.kind && f.kind.length && !f.kind.includes(r.kind)) return false;
    if (f.country && f.country.length) {
      const c = countryOf(r.region);
      if (!c || !f.country.includes(c.id || c.name)) return false;
    }
    if (f.need_key && r.need_key !== f.need_key) return false;
    if (f.solution && !(r.existing_solutions || []).some((s) => normName(s.name) === f.solution)
        && normName(r.company) !== f.solution) return false;
    if (f.eq_cost !== undefined && f.eq_cost !== null && (r.cost || 0) !== f.eq_cost) return false;
    if (f.eq_pay !== undefined && f.eq_pay !== null && (r.pay || 0) !== f.eq_pay) return false;
    if ((r.cost || 0) < (f.min_cost || 0)) return false;
    if ((r.dissatisfaction || 0) < (f.min_dissatisfaction || 0)) return false;
    if ((r.pay || 0) < (f.min_pay || 0)) return false;
    if ((r.severity || 0) < (f.min_severity || 0)) return false;
    if (f.min_ruler) {
      const rep = ctx && ctx.rep ? ctx.rep.get(r.need_key) || 1 : 1;
      if (rulerScore(r, rep) < f.min_ruler) return false;
    }
    const t = r.created || r.screened_at || 0;
    if (f.since && t < f.since) return false;
    if (f.until && t >= f.until) return false;
    const terms = [...(f.keywords || []), ...((f.q || '').toLowerCase().split(/\s+/).filter(Boolean))];
    if (terms.length) {
      const hay = [r.title, r.problem, r.who, r.need_key, r.region, r.company, r.workaround,
        ...(r.existing_solutions || []).map((s) => s.name)].join(' ').toLowerCase();
      // keywords from a hypothesis are OR-ed; free-text search terms are AND-ed
      const kw = (f.keywords || []).map((k) => k.toLowerCase());
      const q = (f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (kw.length && !kw.some((k) => hay.includes(k))) return false;
      if (q.length && !q.every((k) => hay.includes(k))) return false;
    }
    return true;
  }

  // ---------- Hypotheses: claims the data can overturn ----------
  // h: { id, statement, of: filter (denominator), subset: filter (numerator within `of`),
  //      op: ">" | "<", threshold: 0..1, min_n }
  function evaluateHypothesis(h, records, asOf) {
    const scope = records.filter((r) => (!asOf || (r.screened_at || r.created) < asOf) && matches(r, h.of));
    const k = scope.filter((r) => matches(r, h.subset)).length;
    const n = scope.length;
    const w = wilson(k, n);
    let verdict = 'insufficient';
    if (n >= (h.min_n || 30)) {
      const above = w.lo > h.threshold;
      const below = w.hi < h.threshold;
      if (h.op === '<') verdict = below ? 'supported' : above ? 'refuted' : 'inconclusive';
      else verdict = above ? 'supported' : below ? 'refuted' : 'inconclusive';
    }
    return { id: h.id, k, n, ...w, verdict };
  }

  // Verdict at the end of each week, so you can see when the data changed its mind.
  function hypothesisHistory(h, records, weeks = 12, now = Date.now() / 1000) {
    const out = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const asOf = Math.floor(now - i * 7 * 86400);
      out.push({ asOf, ...evaluateHypothesis(h, records, asOf) });
    }
    return out;
  }

  // ---------- Peers: who already works on these needs, and where they fall short ----------
  function normName(s) { return (s || '').trim().toLowerCase(); }
  function landscape(records) {
    const m = new Map();
    const get = (name) => {
      const key = normName(name);
      if (!m.has(key)) m.set(key, { key, name: name.trim(), mentions: 0, funded: 0, complaints: new Map(), needKeys: new Set(), areas: new Set() });
      return m.get(key);
    };
    for (const r of records) {
      if (!r.is_need) continue;
      for (const s of r.existing_solutions || []) {
        if (!s.name || !s.name.trim()) continue;
        const e = get(s.name);
        e.mentions++;
        if (s.complaint) e.complaints.set(s.complaint, (e.complaints.get(s.complaint) || 0) + 1);
        if (r.need_key) e.needKeys.add(r.need_key);
        if (r.area) e.areas.add(r.area);
      }
      if (r.company && r.company.trim() && (r.kind === 'job' || r.kind === 'ad')) {
        const e = get(r.company);
        e.funded++;
        if (r.need_key) e.needKeys.add(r.need_key);
        if (r.area) e.areas.add(r.area);
      }
    }
    return [...m.values()]
      .map((e) => ({
        ...e,
        complaints: [...e.complaints.entries()].sort((a, b) => b[1] - a[1]),
        needKeys: [...e.needKeys], areas: [...e.areas],
      }))
      .sort((a, b) => (b.mentions + b.funded) - (a.mentions + a.funded));
  }

  // ---------- Need clusters ----------
  function clusters(records, rep) {
    const m = new Map();
    for (const r of records) {
      if (!r.is_need || !r.need_key) continue;
      if (!m.has(r.need_key)) m.set(r.need_key, { key: r.need_key, records: [], areas: new Set(), countries: new Set(), tiers: new Set() });
      const c = m.get(r.need_key);
      c.records.push(r);
      if (r.area) c.areas.add(r.area);
      const ct = countryOf(r.region);
      if (ct) c.countries.add(ct.name);
      if (r.tier) c.tiers.add(r.tier);
    }
    return [...m.values()].map((c) => {
      const n = c.records.length;
      const avg = (f) => c.records.reduce((s, r) => s + (r[f] || 0), 0) / n;
      const best = c.records.reduce((a, r) => (rulerScore(r, 1) > rulerScore(a, 1) ? r : a), c.records[0]);
      const repetitionCount = rep.get(c.key) || n;
      return {
        key: c.key, n, repetition: repetitionCount, title: best.title, best,
        cost: avg('cost'), dissatisfaction: avg('dissatisfaction'), pay: avg('pay'), severity: avg('severity'),
        ruler: Math.max(...c.records.map((r) => rulerScore(r, repetitionCount))),
        areas: [...c.areas], countries: [...c.countries], tiers: [...c.tiers],
        issue: (c.records.find((r) => r.issue) || {}).issue || 0,
        last: Math.max(...c.records.map((r) => r.created || r.screened_at || 0)),
        records: c.records,
      };
    });
  }

  // ---------- Live raw stream pre-filter (subset of discover/prefilter.py) ----------
  const PAIN = [
    [3, /\bi wish (there was|i could|someone)\b/i], [3, /\bis there (a|any) (way|app|tool|service)\b/i],
    [2, /\b(struggl|frustrat|exhaust|overwhelm|desperate|can'?t afford|no idea how)\w*/i],
    [2, /\b(every (single )?(time|day|week)|waste[sd]? (hours|days))\b/i],
    [2, /\bmy (mom|mum|dad|parents?|grandma|grandpa|kid|son|daughter|patient|student)s?\b/i],
    [3, /(有没有(什么|办法|工具|软件)|求推荐|怎么办|太难了|崩溃|没人管)/],
  ];
  const NOISE = /\b(hiring|show hn|promo code|giveaway)\b|(招聘|内推|推广|优惠码)/i;
  function painScore(text) {
    if (!text || text.length < 60 || NOISE.test(text)) return 0;
    return PAIN.reduce((s, [w, rx]) => s + (rx.test(text) ? w : 0), 0);
  }

  const api = {
    parseIssueBody, issueToRecord, countryOf, COUNTRY_TABLE, rulerScore, repetitionBonus, repetition,
    wilson, matches, evaluateHypothesis, hypothesisHistory, landscape, clusters, painScore, normName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HN = api;
})(typeof self !== 'undefined' ? self : this);
