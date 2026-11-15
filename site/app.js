// Global Human Needs Monitor. Live-polls four feeds and cross-filters every panel.
//   1. Corpus      data/discovery/corpus/*.jsonl  (every screened signal, scored by the ruler)
//   2. Issues      GitHub REST API, ETag-conditional (304s don't count against the rate limit)
//   3. Run log     data/discovery/runs.jsonl + hypotheses.json
//   4. Raw stream  Hacker News search API (unscored, unreviewed)
// Override repo/branch for forks or testing: ?repo=owner/name&branch=main
(() => {
  'use strict';
  const H = window.HN;
  const params = new URLSearchParams(location.search);
  const REPO = params.get('repo') || '010egg/human-needs';
  const BRANCH = params.get('branch') || 'main';
  const POLL_MS = Number(params.get('poll')) || 60000;
  const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
  const API = `https://api.github.com/repos/${REPO}/issues`;
  const HN_API = 'https://hn.algolia.com/api/v1/search_by_date';
  const SUBMIT = `https://github.com/${REPO}/issues/new?template=need.yml`;
  const TIER = { money: '💰 有钱在动', firsthand: '🗣 一手抱怨', suppressed: '🔇 被删除', '': '其他' };
  const KIND = { complaint: '抱怨', job: '招聘', ad: '广告', other: '其他' };
  const VERDICT = { supported: '支持', refuted: '被推翻', inconclusive: '尚无定论', insufficient: '样本不足' };
  const HN_QUERIES = ['"I wish there was"', '"is there a way to"', '"struggling with"', '"frustrated with"',
    '"can\'t afford"', '"my parents"', '"every single time"', '"no idea how to"'];

  // ---------- state ----------
  const S = {
    corpus: new Map(), issues: new Map(), runs: [], hyps: [], stream: [],
    feeds: { corpus: 'idle', issues: 'idle', runs: 'idle', stream: 'idle' },
    corpusIndex: null, issuesEtag: null, issuesSince: null, issuesBackoffUntil: 0, hnSince: 0, hnQuery: 0,
    lastPoll: 0, nextPoll: 0, firstLoadIds: null, newIds: new Set(),
    f: { q: '', range: 30, tier: '', minRuler: 0, needsOnly: true, country: '', area: '', cell: null, day: null, needKey: '', solution: '' },
    mapMetric: 'count', clusterSort: 'ruler', world: null,
  };

  // ---------- utils ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const pct = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';
  const now = () => Date.now() / 1000;
  const ago = (t) => {
    const s = now() - t;
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  };
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const pips = (v) => `<span class="pips" aria-label="${v}/3">${[1, 2, 3].map((i) => `<i class="${v >= i - 0.5 ? 'on' : ''}"></i>`).join('')}</span>`;

  async function getJSON(url, opts = {}) {
    const r = await fetch(url, { cache: 'no-store', ...opts });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return r.json();
  }
  async function getText(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return r.text();
  }
  // Prefer the live branch on GitHub; fall back to the copy deployed with this page.
  async function fetchData(path, asText) {
    const bust = `?t=${Math.floor(Date.now() / 30000)}`;
    try { return await (asText ? getText(RAW + path + bust) : getJSON(RAW + path + bust)); } catch (e) {
      return asText ? getText(path + bust) : getJSON(path + bust);
    }
  }
  const parseJsonl = (txt) => txt.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

  // ---------- feeds ----------
  async function pollCorpus() {
    try {
      const idx = await fetchData('data/discovery/corpus/index.json');
      const changed = !S.corpusIndex || idx.updated_at !== S.corpusIndex.updated_at;
      if (changed) {
        const known = new Set((S.corpusIndex || {}).shards || []);
        const shards = (idx.shards || []).slice(-3);
        // Monthly shards are append-only: refetch new shards and the current (last) one.
        const todo = shards.filter((s, i) => !known.has(s) || i === shards.length - 1);
        for (const s of todo) {
          for (const r of parseJsonl(await fetchData(`data/discovery/corpus/${s}`, true))) S.corpus.set(r.id, r);
        }
        S.corpusIndex = idx;
      }
      S.feeds.corpus = 'ok';
      return changed;
    } catch (e) {
      S.feeds.corpus = e.status === 404 ? 'empty' : 'bad';
      return false;
    }
  }

  async function pollRuns() {
    try {
      const [runs, hyps] = await Promise.all([
        fetchData('data/discovery/runs.jsonl', true).then(parseJsonl).catch(() => []),
        fetchData('data/discovery/hypotheses.json').catch(() => ({ hypotheses: [] })),
      ]);
      S.runs = runs.slice(-200);
      S.hyps = hyps.hypotheses || [];
      S.feeds.runs = 'ok';
    } catch (_) { S.feeds.runs = 'bad'; }
  }

  async function pollIssues() {
    if (Date.now() < S.issuesBackoffUntil) { S.feeds.issues = 'warn'; return false; }
    let signals = {};
    try { signals = await fetchData('data/discovery/signals.json'); } catch (_) { /* optional */ }
    try {
      let changed = false;
      if (!S.issuesSince) {
        // Initial load: all `need` issues (up to 1000).
        for (let page = 1; page <= 10; page++) {
          const r = await fetch(`${API}?labels=need&state=all&per_page=100&page=${page}`, { headers: { Accept: 'application/vnd.github+json' } });
          checkRate(r);
          if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
          const batch = (await r.json()).filter((i) => !i.pull_request);
          batch.forEach((i) => S.issues.set(i.number, H.issueToRecord(i, signals)));
          if (batch.length < 100) break;
        }
        changed = true;
      } else {
        // Incremental: only issues updated since the last poll, conditional on ETag.
        const headers = { Accept: 'application/vnd.github+json' };
        if (S.issuesEtag) headers['If-None-Match'] = S.issuesEtag;
        const r = await fetch(`${API}?labels=need&state=all&sort=updated&direction=desc&per_page=100&since=${S.issuesSince}`, { headers });
        checkRate(r);
        if (r.status !== 304) {
          if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
          S.issuesEtag = r.headers.get('ETag');
          for (const i of (await r.json()).filter((x) => !x.pull_request)) {
            S.issues.set(i.number, H.issueToRecord(i, signals));
            changed = true;
          }
        }
      }
      const latest = [...S.issues.values()].map((r) => r.updated_at).sort().pop();
      S.issuesSince = latest || new Date(Date.now() - 86400000).toISOString();
      if (S.feeds.issues !== 'warn') S.feeds.issues = 'ok';
      return changed;
    } catch (e) {
      S.feeds.issues = e.status === 403 || e.status === 429 ? 'warn' : 'bad';
      if (S.feeds.issues === 'warn' && !S.issuesBackoffUntil) S.issuesBackoffUntil = Date.now() + 10 * 60000;
      return false;
    }
  }
  function checkRate(r) {
    const left = Number(r.headers.get('X-RateLimit-Remaining'));
    const reset = Number(r.headers.get('X-RateLimit-Reset'));
    if (!Number.isNaN(left) && left < 5 && reset) {
      S.issuesBackoffUntil = reset * 1000;
      S.feeds.issues = 'warn';
    } else if (S.feeds.issues === 'warn') {
      S.issuesBackoffUntil = 0;
      S.feeds.issues = 'ok';
    }
  }

  async function pollStream() {
    try {
      const q = HN_QUERIES[S.hnQuery++ % HN_QUERIES.length];
      const since = S.hnSince || Math.floor(now() - 6 * 3600);
      const u = `${HN_API}?query=${encodeURIComponent(q)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=30`;
      const res = await getJSON(u);
      const known = new Set(S.stream.map((s) => s.id));
      const fresh = [];
      for (const h of res.hits || []) {
        if (known.has(h.objectID)) continue;
        const text = (h.comment_text || h.story_text || h.title || '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#x2F;/g, '/').replace(/\s+/g, ' ').trim();
        const score = H.painScore(text);
        if (score < 3) continue;
        fresh.push({ id: h.objectID, text, score, t: h.created_at_i, url: `https://news.ycombinator.com/item?id=${h.objectID}`, fresh: S.stream.length > 0 });
      }
      S.stream = [...fresh, ...S.stream].sort((a, b) => b.t - a.t).slice(0, 80);
      S.feeds.stream = 'ok';
    } catch (_) { S.feeds.stream = 'bad'; }
  }

  async function pollAll(first) {
    S.lastPoll = Date.now();
    S.nextPoll = S.lastPoll + POLL_MS;
    renderLive();
    const before = new Set(allRecords().map((r) => r.id));
    await Promise.all([pollCorpus(), pollIssues(), pollRuns(), pollStream()]);
    const after = allRecords();
    if (first) S.firstLoadIds = new Set(after.map((r) => r.id));
    else {
      const added = after.filter((r) => !before.has(r.id));
      added.forEach((r) => S.newIds.add(r.id));
      if (added.length) toast(`新增 ${added.length} 条信号`);
    }
    render();
  }

  // ---------- derived data ----------
  const allRecords = () => [...S.corpus.values(), ...S.issues.values()];

  function filterFor(except) {
    const f = S.f;
    const out = {};
    if (f.needsOnly) out.is_need = true;
    if (f.q) out.q = f.q;
    if (f.range) out.since = now() - f.range * 86400;
    if (f.tier && except !== 'tier') out.tier = [f.tier];
    if (f.minRuler) out.min_ruler = f.minRuler;
    if (f.country && except !== 'country') out.country = [f.country];
    if (f.area && except !== 'area') out.area = [f.area];
    if (f.cell && except !== 'cell') { out.eq_cost = f.cell[0]; out.eq_pay = f.cell[1]; }
    if (f.day && except !== 'day') { out.since = f.day; out.until = f.day + 86400; }
    if (f.needKey) out.need_key = f.needKey;
    if (f.solution) out.solution = f.solution;
    return out;
  }
  function view(except) {
    const all = allRecords();
    const rep = H.repetition(all);
    const f = filterFor(except);
    return { all, rep, rows: all.filter((r) => H.matches(r, f, { rep })) };
  }

  // ---------- rendering ----------
  function render() {
    const v = view();
    renderFeeds();
    renderCrumbs();
    renderKpis(v);
    renderMap(view('country'));
    renderAreas(view('area'));
    renderMatrix(view('cell'));
    renderTimeline(view('day'));
    renderClusters(v);
    renderPeers(v);
    renderHealth();
    renderHyps(v.all);
    renderStream();
    writeHash();
  }

  function renderLive() {
    const el = $('live');
    const bad = Object.values(S.feeds).filter((s) => s === 'bad').length;
    const warn = Object.values(S.feeds).filter((s) => s === 'warn').length;
    el.className = 'live ' + (bad ? 'bad' : warn ? 'warn' : S.lastPoll ? 'ok' : '');
    const secs = Math.max(0, Math.round((S.nextPoll - Date.now()) / 1000));
    const t = S.lastPoll ? new Date(S.lastPoll).toLocaleTimeString('zh-CN', { hour12: false }) : '--';
    $('live-text').textContent = `${bad ? '部分数据源异常' : '实时'} · 更新于 ${t} · ${secs}s 后刷新`;
  }

  function renderFeeds() {
    const label = {
      corpus: ['语料库', { ok: () => `${S.corpus.size} 条`, empty: () => '尚无数据', bad: () => '加载失败', idle: () => '…' }],
      issues: ['GitHub Issues', { ok: () => `${S.issues.size} 条`, warn: () => '限流中，稍后恢复', bad: () => '加载失败', idle: () => '…' }],
      runs: ['运行日志/假设', { ok: () => `${S.runs.length} 次运行`, bad: () => '加载失败', idle: () => '…' }],
      stream: ['HN 实时流', { ok: () => `${S.stream.length} 条`, bad: () => '加载失败', idle: () => '…' }],
    };
    $('feeds').innerHTML = Object.entries(label).map(([k, [name, m]]) => {
      const st = S.feeds[k];
      const cls = st === 'empty' ? 'idle' : st;
      return `<span class="feed ${cls}">${name}：${esc((m[st] || m.idle)())}</span>`;
    }).join('');
  }

  function renderCrumbs() {
    const f = S.f;
    const chips = [];
    if (f.country) chips.push(['country', '国家', countryName(f.country)]);
    if (f.area) chips.push(['area', '领域', f.area]);
    if (f.cell) chips.push(['cell', '代价×支付', `${f.cell[0]} × ${f.cell[1]}`]);
    if (f.day) chips.push(['day', '日期', day(f.day)]);
    if (f.needKey) chips.push(['needKey', '需求簇', f.needKey]);
    if (f.solution) chips.push(['solution', '同行', f.solution]);
    $('crumbs').innerHTML = chips.map(([k, l, v]) =>
      `<button class="chip" data-k="${k}" title="移除"><span>${l}：<b>${esc(v)}</b></span><span class="x">✕</span></button>`).join('')
      + (chips.length ? '<button class="chip clear" data-k="*">全部清除</button>' : '');
  }
  const countryName = (id) => (H.COUNTRY_TABLE.find((c) => c[0] === id) || [id, id])[1];

  function renderKpis(v) {
    const needs = v.rows.filter((r) => r.is_need);
    const all = v.all.filter((r) => H.matches(r, { ...filterFor(), is_need: undefined }, { rep: v.rep }));
    const costly = needs.filter((r) => (r.cost || 0) >= 2).length;
    const paying = needs.filter((r) => (r.pay || 0) >= 2).length;
    const wc = H.wilson(costly, needs.length);
    const wp = H.wilson(paying, needs.length);
    const countries = new Set(needs.map((r) => (H.countryOf(r.region) || {}).id).filter(Boolean));
    const keys = new Set(needs.map((r) => r.need_key).filter(Boolean));
    const day1 = needs.filter((r) => (r.created || r.screened_at) > now() - 86400).length;
    const money = needs.filter((r) => r.tier === 'money').length;
    const ci = (w) => (needs.length ? `95% 区间 ${pct(w.lo)}–${pct(w.hi)}` : '');
    const k = [
      [all.length, '信号（含非需求）', ''],
      [needs.length, '真实需求信号', all.length ? `占信号 ${pct(needs.length / all.length)}` : ''],
      [keys.size, '需求簇', '同一需求的独立目击合并'],
      [needs.length ? pct(wc.p) : '—', '有代价证据（≥2）', ci(wc)],
      [needs.length ? pct(wp.p) : '—', '有支付证据（≥2）', ci(wp)],
      [countries.size, '覆盖国家/地区', ''],
      [money, '💰 有钱在动', '招聘/广告来源'],
      [day1, '24 小时新增', ''],
    ];
    $('kpis').innerHTML = k.map(([b, s, i]) => `<div class="kpi"><b>${esc(b)}</b><span>${esc(s)}</span><i>${esc(i)}</i></div>`).join('');
  }

  // ----- map -----
  function renderMap(v) {
    const el = $('map');
    if (!S.world) { el.innerHTML = '<div class="empty">地图加载中…</div>'; return; }
    const W = 960; const Hh = 480;
    const counts = new Map(); const rulerSum = new Map();
    let unknown = 0; let other = 0;
    for (const r of v.rows) {
      const c = H.countryOf(r.region);
      if (!c) { unknown++; continue; }
      if (!c.id) { other++; continue; }
      counts.set(c.id, (counts.get(c.id) || 0) + 1);
      rulerSum.set(c.id, (rulerSum.get(c.id) || 0) + H.rulerScore(r, v.rep.get(r.need_key) || 1));
    }
    const metric = (id) => (S.mapMetric === 'count' ? counts.get(id) || 0 : counts.get(id) ? rulerSum.get(id) / counts.get(id) : 0);
    const max = Math.max(1, ...[...counts.keys()].map(metric));
    const color = d3.scaleSequential(d3.interpolateRgb(css('--seq-0'), css('--seq-1'))).domain([0, max]);
    if (!el.querySelector('svg')) {
      const proj = d3.geoNaturalEarth1().fitSize([W, Hh], S.world);
      const path = d3.geoPath(proj);
      const svg = d3.select(el).html('').append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('role', 'img').attr('aria-label', '全球需求分布地图');
      svg.selectAll('path').data(S.world.features).join('path').attr('class', 'land').attr('d', path)
        .on('click', (e, d) => { S.f.country = S.f.country === d.id ? '' : d.id; render(); })
        .on('mousemove', (e, d) => tip(e, d))
        .on('mouseleave', () => tip());
      d3.select(el).append('div').attr('class', 'legend');
    }
    d3.select(el).selectAll('path.land')
      .attr('fill', (d) => (counts.get(d.id) ? color(metric(d.id)) : css('--empty-land')))
      .classed('sel', (d) => d.id === S.f.country);
    el._metric = { counts, metric };
    d3.select(el).select('.legend').html(
      `<span>${S.mapMetric === 'count' ? '0' : '0 分'}</span><span class="ramp" style="background:linear-gradient(90deg,${css('--seq-0')},${css('--seq-1')})"></span><span>${S.mapMetric === 'count' ? max : max.toFixed(1) + ' 分'}</span>`);
    const total = v.rows.length;
    $('map-note').textContent = total
      ? `${total} 条中：${total - unknown - other} 条可定位到国家；${unknown} 条原帖未提及地区（${pct(unknown / total)}）${other ? `，${other} 条地区未识别` : ''}。地区只在原帖明确提及时记录，不做猜测。`
      : '暂无数据。';
  }
  const tipEl = Object.assign(document.createElement('div'), { className: 'tip' });
  document.body.appendChild(tipEl);
  function tip(e, d) {
    if (!e) { tipEl.style.display = 'none'; return; }
    const m = $('map')._metric;
    const name = countryName(d.id) !== d.id ? countryName(d.id) : d.properties.name;
    const n = m ? m.counts.get(d.id) || 0 : 0;
    tipEl.innerHTML = `<b>${esc(name)}</b><br>${n} 条需求信号${n && S.mapMetric === 'ruler' ? ` · 平均尺子分 ${m.metric(d.id).toFixed(1)}` : ''}`;
    tipEl.style.display = 'block';
    tipEl.style.left = Math.min(e.clientX + 12, innerWidth - 250) + 'px';
    tipEl.style.top = e.clientY + 12 + 'px';
  }

  // ----- areas -----
  function renderAreas(v) {
    const m = new Map();
    for (const r of v.rows) if (r.area) m.set(r.area, (m.get(r.area) || 0) + 1);
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (!rows.length) { $('areas').innerHTML = '<div class="empty">暂无数据</div>'; return; }
    const max = rows[0][1];
    $('areas').innerHTML = `<div class="bars">${rows.map(([a, n]) =>
      `<button class="bar ${S.f.area === a ? 'sel' : S.f.area ? 'dim' : ''}" data-area="${esc(a)}">
        <span>${esc(a)}</span><span class="track"><span class="fill" style="width:${(n / max) * 100}%"></span></span><span class="n">${n}</span></button>`).join('')}</div>`;
  }

  // ----- ruler matrix -----
  function renderMatrix(v) {
    const grid = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    for (const r of v.rows) grid[Math.min(3, r.cost || 0)][Math.min(3, r.pay || 0)]++;
    const max = Math.max(1, ...grid.flat());
    const color = d3.interpolateRgb(css('--seq-0'), css('--seq-1'));
    const txt = (x) => (x / max > 0.55 ? css('--surface') : css('--text'));
    let h = '<div class="matrix"><div class="lab">代价 ↓ 支付 →</div>' + [0, 1, 2, 3].map((p) => `<div class="lab">${p}</div>`).join('');
    for (let c = 3; c >= 0; c--) {
      h += `<div class="lab">${c}</div>`;
      for (let p = 0; p < 4; p++) {
        const n = grid[c][p];
        const sel = S.f.cell && S.f.cell[0] === c && S.f.cell[1] === p;
        h += `<button class="cell ${sel ? 'sel' : ''}" data-cell="${c},${p}" style="background:${color(n / max)};color:${txt(n)}" aria-label="代价 ${c} 支付 ${p}：${n} 条">${n}</button>`;
      }
    }
    $('matrix').innerHTML = h + '</div>';
  }

  // ----- timeline -----
  function renderTimeline(v) {
    const el = $('timeline');
    const days = S.f.range || 90;
    const start = Math.floor(now() / 86400) - days + 1;
    const tiers = ['money', 'firsthand', 'suppressed', ''];
    const data = Array.from({ length: days }, (_, i) => ({ d: (start + i) * 86400, money: 0, firsthand: 0, suppressed: 0, '': 0 }));
    for (const r of v.rows) {
      const i = Math.floor((r.created || r.screened_at) / 86400) - start;
      if (i >= 0 && i < days) data[i][tiers.includes(r.tier) ? r.tier : '']++;
    }
    const total = data.reduce((s, d) => s + tiers.reduce((a, t) => a + d[t], 0), 0);
    if (!total) { el.innerHTML = '<div class="empty">所选时间范围内暂无信号</div>'; return; }
    const W = 900; const Hh = 180; const m = { t: 8, r: 8, b: 22, l: 30 };
    const x = d3.scaleBand().domain(data.map((d) => d.d)).range([m.l, W - m.r]).padding(0.15);
    const stack = d3.stack().keys(tiers)(data);
    const y = d3.scaleLinear().domain([0, d3.max(stack, (s) => d3.max(s, (d) => d[1])) || 1]).nice().range([Hh - m.b, m.t]);
    const col = { money: css('--tier-money'), firsthand: css('--tier-firsthand'), suppressed: css('--tier-suppressed'), '': css('--tier-other') };
    const svg = d3.select(el).html('').attr('class', 'tl').append('svg').attr('viewBox', `0 0 ${W} ${Hh}`).attr('role', 'img').attr('aria-label', '每日信号数');
    svg.append('g').selectAll('g').data(stack).join('g').attr('fill', (s) => col[s.key])
      .selectAll('rect').data((s) => s).join('rect')
      .attr('x', (d) => x(d.data.d)).attr('width', x.bandwidth())
      .attr('y', (d) => y(d[1])).attr('height', (d) => Math.max(0, y(d[0]) - y(d[1])))
      .attr('opacity', (d) => (S.f.day && S.f.day !== d.data.d ? 0.3 : 1))
      .on('click', (e, d) => { S.f.day = S.f.day === d.data.d ? null : d.data.d; render(); })
      .append('title').text((d) => `${day(d.data.d)}：${tiers.reduce((a, t) => a + d.data[t], 0)} 条`);
    const every = Math.ceil(days / 8);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${Hh - m.b})`)
      .call(d3.axisBottom(x).tickValues(data.filter((_, i) => i % every === 0).map((d) => d.d)).tickFormat((t) => day(t).slice(5)).tickSizeOuter(0));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSizeOuter(0));
    d3.select(el).append('div').attr('class', 'tiers').html(tiers.slice(0, 3).map((t) => `<span style="--c:${col[t]}">${TIER[t]}</span>`).join(''));
  }

  // ----- clusters -----
  function renderClusters(v) {
    const cl = H.clusters(v.rows, v.rep);
    const key = S.clusterSort;
    cl.sort((a, b) => (b[key] - a[key]) || (b.ruler - a.ruler) || (b.repetition - a.repetition));
    const el = $('clusters');
    if (!cl.length) { el.innerHTML = '<tr><td class="empty">没有符合条件的需求簇</td></tr>'; return; }
    el.innerHTML = `<thead><tr><th>需求</th><th class="num">尺子分</th><th class="num">重复</th><th>代价</th><th>不满</th><th>支付</th><th>领域</th><th>地区</th><th>数据层</th></tr></thead><tbody>${
      cl.slice(0, 60).map((c) => {
        const isNew = c.records.some((r) => S.newIds.has(r.id));
        return `<tr class="row" data-key="${esc(c.key)}" tabindex="0">
          <td class="title">${isNew ? '<span class="tag new">新</span>' : ''}${esc(c.title)}<small>${esc(c.key.startsWith('#') ? `Issue ${c.key}` : c.key)} · ${ago(c.last)}${c.issue ? ` · <a href="https://github.com/${REPO}/issues/${c.issue}" target="_blank" rel="noopener">#${c.issue}</a>` : ''}</small></td>
          <td class="num"><span class="score">${c.ruler}</span></td>
          <td class="num">${c.repetition}</td>
          <td>${pips(c.cost)}</td><td>${pips(c.dissatisfaction)}</td><td>${pips(c.pay)}</td>
          <td>${c.areas.map((a) => `<span class="tag">${esc(a)}</span>`).join('')}</td>
          <td>${c.countries.slice(0, 3).map((a) => `<span class="tag">${esc(a)}</span>`).join('') || '<span class="tag">未提及</span>'}</td>
          <td>${c.tiers.map((t) => `<span class="tag t-${t}">${TIER[t] || t}</span>`).join('')}</td></tr>`;
      }).join('')}</tbody>`;
  }

  // ----- peers -----
  function renderPeers(v) {
    const l = H.landscape(v.rows);
    const el = $('peers');
    if (!l.length) {
      el.innerHTML = '<tr><td class="empty">当前筛选下还没有被提及的现有方案或出钱的机构。<br>数据来自原帖中提到的产品/服务，以及招聘、广告背后的公司。</td></tr>';
      return;
    }
    el.innerHTML = `<thead><tr><th>方案 / 机构</th><th class="num">被提及</th><th class="num">出钱信号</th><th>卡在哪（用户原话改写）</th><th>相关需求</th></tr></thead><tbody>${
      l.slice(0, 40).map((e) => `<tr class="row" data-sol="${esc(e.key)}" tabindex="0">
        <td><b>${esc(e.name)}</b>${S.f.solution === e.key ? ' <span class="tag new">已选</span>' : ''}</td>
        <td class="num">${e.mentions}</td><td class="num">${e.funded || ''}</td>
        <td>${e.complaints.slice(0, 3).map(([c, n]) => `${esc(c)}${n > 1 ? ` <small>×${n}</small>` : ''}`).join('<br>') || '<small>未说明</small>'}</td>
        <td>${e.needKeys.slice(0, 3).map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</td></tr>`).join('')}</tbody>`;
  }

  // ----- source health -----
  function renderHealth() {
    const el = $('health');
    if (!S.runs.length) {
      el.innerHTML = '<div class="empty">自动发现流水线尚未运行。<br>在仓库 Settings → Secrets 添加 <code>ANTHROPIC_API_KEY</code> 后，<br>它会每 6 小时运行一次。</div>';
      return;
    }
    const recent = S.runs.filter((r) => r.run_at > now() - 7 * 86400);
    const sum = (k) => recent.reduce((s, r) => s + (r[k] || 0), 0);
    const last = S.runs[S.runs.length - 1];
    const stale = now() - last.run_at > 8 * 3600;
    const src = new Map();
    for (const r of recent) for (const [name, h] of Object.entries(r.sources || {})) {
      const e = src.get(name) || { tier: h.tier, posts: 0, ok: 0, fail: 0, lastOk: 0, lastErr: '' };
      e.posts += h.posts || 0;
      if (h.ok) { e.ok++; e.lastOk = Math.max(e.lastOk, r.run_at); } else { e.fail++; e.lastErr = h.error; }
      src.set(name, e);
    }
    el.innerHTML = `<p class="note">最近一次运行：${ago(last.run_at)}${stale ? ' <b style="color:var(--warn)">（超过 8 小时，可能停摆）</b>' : ''}，近 7 天 ${recent.length} 次</p>
      <div class="funnel">${[['采集', sum('collected')], ['过初筛', sum('prefiltered')], ['模型审', sum('screened')], ['真实需求', sum('needs')], ['新立项', sum('new')]]
        .map(([l, n]) => `<div><b>${n}</b>${l}</div>`).join('')}</div>
      ${[...src.entries()].sort((a, b) => a[1].tier.localeCompare(b[1].tier)).map(([name, e]) => `<div class="src">
        <span><b>${esc(name)}</b> <span class="tag t-${e.tier}">${TIER[e.tier] || e.tier}</span></span>
        <span class="${e.fail && !e.ok ? 't-bad' : ''}">${e.fail ? `<span style="color:var(--bad)">${e.fail} 次失败</span> · ` : ''}${e.posts} 条</span>
        <span class="meta">${e.lastOk ? `最后成功 ${ago(e.lastOk)}` : '近 7 天未成功'}${e.lastErr ? ` · ${esc(e.lastErr)}` : ''}</span></div>`).join('')}`;
  }

  // ----- hypotheses -----
  function renderHyps(all) {
    const el = $('hyps');
    if (!S.hyps.length) { el.innerHTML = '<div class="empty">还没有假设。在 data/discovery/hypotheses.json 里写下你想被数据检验的判断。</div>'; return; }
    el.innerHTML = S.hyps.map((h) => {
      const e = H.evaluateHypothesis(h, all);
      const hist = H.hypothesisHistory(h, all, 12);
      const flips = hist.filter((x, i) => i && x.verdict !== hist[i - 1].verdict && !['insufficient'].includes(hist[i - 1].verdict)).length;
      const scale = Math.max(h.threshold * 2, e.hi, 0.1);
      const pos = (x) => `${Math.min(100, (x / scale) * 100)}%`;
      return `<div class="hyp">
        <div class="hyp-top"><span>${esc(h.statement)}</span><span class="verdict v-${e.verdict}">${VERDICT[e.verdict]}</span></div>
        <div class="ci" title="点估计 ${pct(e.p)}，95% 区间 ${pct(e.lo)}–${pct(e.hi)}，阈值 ${pct(h.threshold)}">
          ${e.n ? `<span class="band" style="left:${pos(e.lo)};width:calc(${pos(e.hi)} - ${pos(e.lo)})"></span><span class="pt" style="left:${pos(e.p)}"></span>` : ''}
          <span class="th" style="left:${pos(h.threshold)}"></span></div>
        <div class="hyp-meta">
          <span>${e.n ? `${e.k}/${e.n} = ${pct(e.p)}（95%：${pct(e.lo)}–${pct(e.hi)}）` : '样本为 0'} · 阈值 ${h.op === '<' ? '<' : '>'} ${pct(h.threshold)} · 至少 ${h.min_n} 条</span>
          <span class="strip" title="近 12 周每周末的裁决${flips ? `，翻转 ${flips} 次` : ''}">${hist.map((x) => `<i class="s-${x.verdict}" title="${day(x.asOf)}：${VERDICT[x.verdict]}"></i>`).join('')}</span>
        </div></div>`;
    }).join('');
  }

  // ----- stream -----
  function renderStream() {
    const el = $('stream');
    if (!S.stream.length) {
      el.innerHTML = `<li class="empty">${S.feeds.stream === 'bad' ? '无法连接 Hacker News。' : '正在等待新的高信号帖子…'}</li>`;
      return;
    }
    el.innerHTML = S.stream.slice(0, 40).map((s) => {
      const prefill = `${SUBMIT}&title=${encodeURIComponent('[需求] ')}&problem=${encodeURIComponent(`（来自 ${s.url}，请用自己的话改写，去掉可识别信息）\n\n`)}`;
      return `<li class="${s.fresh ? 'fresh' : ''}"><div class="txt">${esc(s.text)}</div>
        <div class="row2"><span>信号强度 ${s.score} · ${ago(s.t)}</span><span><a href="${esc(s.url)}" target="_blank" rel="noopener">原帖</a> · <a href="${esc(prefill)}" target="_blank" rel="noopener">整理成需求</a></span></div></li>`;
    }).join('');
    S.stream.forEach((s) => { s.fresh = false; });
  }

  // ----- drawer -----
  function openCluster(key) {
    const v = view();
    const recs = v.all.filter((r) => r.need_key === key).sort((a, b) => H.rulerScore(b, 1) - H.rulerScore(a, 1));
    const rep = v.rep.get(key) || recs.length;
    $('drawer-title').textContent = recs[0] ? recs[0].title : key;
    $('drawer-body').innerHTML = `<p class="note">需求簇 <b>${esc(key)}</b> · 独立目击 ${rep} 次 · 下面是每一条证据。
      <button class="chip" id="focus-key">只看这个需求簇</button></p>` + recs.map((r) => {
      const score = H.rulerScore(r, rep);
      return `<article class="sig">
        <h3>${esc(r.title || '（非需求）')} <span class="score">${score}</span></h3>
        <div>${r.tier ? `<span class="tag t-${r.tier}">${TIER[r.tier]}</span>` : ''}<span class="tag">${KIND[r.kind] || r.kind || ''}</span><span class="tag">${esc(r.source)}</span><span class="tag">${day(r.created || r.screened_at)}</span>${r.region ? `<span class="tag">📍 ${esc(r.region)}</span>` : ''}${S.newIds.has(r.id) ? '<span class="tag new">新</span>' : ''}</div>
        ${r.problem ? `<p>${esc(r.problem)}</p>` : ''}
        <dl>
          ${r.who ? `<dt>谁</dt><dd>${esc(r.who)}</dd>` : ''}
          <dt>代价 ${r.cost || 0}/3</dt><dd>${esc(r.cost_evidence) || '—'}</dd>
          <dt>不满 ${r.dissatisfaction || 0}/3</dt><dd>${esc(r.dissatisfaction_evidence) || '—'}</dd>
          <dt>支付 ${r.pay || 0}/3</dt><dd>${esc(r.pay_evidence) || '—'}</dd>
          ${r.workaround ? `<dt>现在怎么办</dt><dd>${esc(r.workaround)}</dd>` : ''}
          ${(r.existing_solutions || []).length ? `<dt>现有方案</dt><dd>${r.existing_solutions.map((s) => `<b>${esc(s.name)}</b>${s.complaint ? `：${esc(s.complaint)}` : ''}`).join('<br>')}</dd>` : ''}
          ${r.company ? `<dt>出钱的机构</dt><dd>${esc(r.company)}</dd>` : ''}
          ${r.reason ? `<dt>模型判断</dt><dd><small>${esc(r.reason)}${r.confidence < 1 ? ` · 置信度 ${Number(r.confidence).toFixed(2)}` : ''}</small></dd>` : ''}
          <dt>来源</dt><dd>${/^https?:/.test(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>` : esc(r.url)}${r.issue ? ` · <a href="https://github.com/${REPO}/issues/${r.issue}" target="_blank" rel="noopener">Issue #${r.issue}</a>` : ''}</dd>
        </dl></article>`;
    }).join('');
    $('focus-key').onclick = () => { S.f.needKey = key; closeDrawer(); render(); };
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawer-close').focus();
  }
  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
  }

  let toastTimer;
  function toast(msg) {
    $('toast').textContent = msg;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500);
  }

  // ---------- URL state ----------
  function writeHash() {
    const f = S.f; const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.range !== 30) p.set('range', f.range);
    if (f.tier) p.set('tier', f.tier);
    if (f.minRuler) p.set('ruler', f.minRuler);
    if (!f.needsOnly) p.set('all', '1');
    if (f.country) p.set('country', f.country);
    if (f.area) p.set('area', f.area);
    if (f.cell) p.set('cell', f.cell.join(','));
    if (f.day) p.set('day', f.day);
    if (f.needKey) p.set('key', f.needKey);
    if (f.solution) p.set('sol', f.solution);
    const h = p.toString();
    history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    Object.assign(S.f, {
      q: p.get('q') || '', range: p.has('range') ? Number(p.get('range')) : 30, tier: p.get('tier') || '',
      minRuler: Number(p.get('ruler')) || 0, needsOnly: p.get('all') !== '1', country: p.get('country') || '',
      area: p.get('area') || '', cell: p.get('cell') ? p.get('cell').split(',').map(Number) : null,
      day: Number(p.get('day')) || null, needKey: p.get('key') || '', solution: p.get('sol') || '',
    });
    $('q').value = S.f.q; $('range').value = String(S.f.range); $('tier').value = S.f.tier;
    $('minruler').value = String(S.f.minRuler); $('needs-only').checked = S.f.needsOnly;
  }

  // ---------- events ----------
  let qTimer;
  $('q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.f.q = e.target.value.trim(); render(); }, 150); });
  $('range').addEventListener('change', (e) => { S.f.range = Number(e.target.value); S.f.day = null; render(); });
  $('tier').addEventListener('change', (e) => { S.f.tier = e.target.value; render(); });
  $('minruler').addEventListener('change', (e) => { S.f.minRuler = Number(e.target.value); render(); });
  $('needs-only').addEventListener('change', (e) => { S.f.needsOnly = e.target.checked; render(); });
  $('crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = b.dataset.k;
    if (k === '*') Object.assign(S.f, { country: '', area: '', cell: null, day: null, needKey: '', solution: '' });
    else S.f[k] = k === 'cell' || k === 'day' ? null : '';
    render();
  });
  $('areas').addEventListener('click', (e) => { const b = e.target.closest('[data-area]'); if (!b) return; S.f.area = S.f.area === b.dataset.area ? '' : b.dataset.area; render(); });
  $('matrix').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cell]'); if (!b) return;
    const c = b.dataset.cell.split(',').map(Number);
    S.f.cell = S.f.cell && S.f.cell[0] === c[0] && S.f.cell[1] === c[1] ? null : c; render();
  });
  const rowOpen = (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-key]'); if (tr) openCluster(tr.dataset.key);
  };
  $('clusters').addEventListener('click', rowOpen);
  $('clusters').addEventListener('keydown', (e) => { if (e.key === 'Enter') rowOpen(e); });
  $('peers').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-sol]'); if (!tr) return; S.f.solution = S.f.solution === tr.dataset.sol ? '' : tr.dataset.sol; render(); });
  for (const [id, key] of [['map-metric', 'mapMetric'], ['cluster-sort', 'clusterSort']]) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      S[key] = b.dataset.v;
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      render();
    });
  }
  $('drawer-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  window.addEventListener('hashchange', () => { readHash(); render(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { $('map').innerHTML = ''; render(); });

  // ---------- boot ----------
  readHash();
  render();
  d3.json('vendor/countries-110m.json').then((topo) => {
    S.world = topojson.feature(topo, topo.objects.countries);
    render();
  });
  pollAll(true);
  setInterval(() => pollAll(false), POLL_MS);
  setInterval(renderLive, 1000);
  // Pause-safe: refresh immediately when the tab becomes visible again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.lastPoll > POLL_MS) pollAll(false); });
})();
