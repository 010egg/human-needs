// Browse data/needs.json. No dependencies, no build step.
(() => {
  const REPO = '010egg/human-needs';
  const REPO_URL = `https://github.com/${REPO}`;
  const SUBMIT_URL = `${REPO_URL}/issues/new?template=need.yml`;

  const FREQ = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年几次', rare: '关键时刻' };
  const SRC = { firsthand: '亲历', observed: '观察', hearsay: '转述' };
  const PAY = { none: '不愿/无力付费', little: '少量', moderate: '中等', high: '很多', unsure: '不确定' };

  const $ = (id) => document.getElementById(id);
  const els = {
    q: $('q'), area: $('area'), severity: $('severity'), source: $('source'),
    sort: $('sort'), openOnly: $('open-only'),
  };
  $('submit-link').href = SUBMIT_URL;
  $('repo-link').href = REPO_URL;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const impact = (n) => (n.upvotes + 1) * (n.severity || 1);
  const isOpen = (n) => n.state === 'open' && n.status !== '已有方案';

  let all = [];

  async function load() {
    for (const url of ['data/needs.json', '../data/needs.json']) {
      try {
        const r = await fetch(url, { cache: 'no-cache' });
        if (r.ok) return await r.json();
      } catch (_) { /* try next */ }
    }
    throw new Error('无法加载数据 / Could not load data');
  }

  // ---- URL hash <-> filter state, so filtered views can be shared ----
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    els.q.value = p.get('q') || '';
    els.area.value = p.get('area') || '';
    els.severity.value = p.get('sev') || '';
    els.source.value = p.get('src') || '';
    els.sort.value = p.get('sort') || 'impact';
    els.openOnly.checked = p.get('all') !== '1';
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (els.q.value) p.set('q', els.q.value);
    if (els.area.value) p.set('area', els.area.value);
    if (els.severity.value) p.set('sev', els.severity.value);
    if (els.source.value) p.set('src', els.source.value);
    if (els.sort.value !== 'impact') p.set('sort', els.sort.value);
    if (!els.openOnly.checked) p.set('all', '1');
    const h = p.toString();
    history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  }

  function filtered() {
    const terms = els.q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const minSev = Number(els.severity.value) || 0;
    const list = all.filter((n) => {
      if (n.duplicate) return false;
      if (els.openOnly.checked && !isOpen(n)) return false;
      if (els.area.value && n.area !== els.area.value) return false;
      if (minSev && (n.severity || 0) < minSev) return false;
      if (els.source.value && n.source_key !== els.source.value) return false;
      if (terms.length) {
        const hay = [n.title, n.problem, n.who, n.region, n.workaround, n.extra, n.area, n.area_en]
          .join(' ').toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    const by = {
      impact: (a, b) => impact(b) - impact(a) || b.upvotes - a.upvotes,
      upvotes: (a, b) => b.upvotes - a.upvotes || (b.severity || 0) - (a.severity || 0),
      new: (a, b) => b.created_at.localeCompare(a.created_at),
      severity: (a, b) => (b.severity || 0) - (a.severity || 0) || b.upvotes - a.upvotes,
    }[els.sort.value] || (() => 0);
    return list.sort(by);
  }

  function card(n) {
    const chips = [
      n.area && `<span class="chip">${esc(n.area)}</span>`,
      n.severity && `<span class="chip">痛度 ${n.severity}/5</span>`,
      n.frequency_key && `<span class="chip">${esc(FREQ[n.frequency_key])}</span>`,
      n.region && `<span class="chip">📍 ${esc(n.region)}</span>`,
      n.source_key && `<span class="chip">${esc(SRC[n.source_key])}</span>`,
      n.status && n.status !== '待整理' && n.status !== '已整理' && `<span class="chip status">${esc(n.status)}</span>`,
    ].filter(Boolean).join('');
    const rows = [
      ['谁 / Who', n.who],
      ['现在怎么凑合 / Workaround', n.workaround],
      ['付费意愿 / Willing to pay', PAY[n.willingness_to_pay_key]],
      ['补充 / Extra', n.extra],
    ].filter(([, v]) => v);
    const details = rows.length
      ? `<details><summary>更多 / More</summary><dl>${rows.map(([k, v]) =>
          `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>`
      : '';
    return `<li class="card" data-sev="${n.severity || 1}">
      <h2><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h2>
      <div class="meta">${chips}</div>
      <p class="problem clamp">${esc(n.problem)}</p>
      ${details}
      <div class="foot-row">
        <span>👍 ${n.upvotes} · 💬 ${n.comments} · ${esc(n.created_at.slice(0, 10))}</span>
        <a href="${esc(n.url)}" target="_blank" rel="noopener">我也有这个需求，去点 👍 →</a>
      </div>
    </li>`;
  }

  function renderSummary() {
    const live = all.filter((n) => !n.duplicate);
    const open = live.filter(isOpen);
    const severe = open.filter((n) => (n.severity || 0) >= 4);
    const regions = new Set(live.map((n) => (n.region || '').split(/[·・,，/]/)[0].trim()).filter(Boolean));
    const votes = live.reduce((s, n) => s + n.upvotes, 0);
    $('summary').innerHTML = [
      [live.length, '条需求 / needs'],
      [open.length, '待解决 / open'],
      [severe.length, '严重（痛度≥4）/ severe'],
      [votes, '个 👍 认同 / upvotes'],
      [regions.size, '个地区 / regions'],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  }

  function render() {
    writeHash();
    const list = filtered();
    const live = all.filter((n) => !n.duplicate).length;
    $('count').textContent = `显示 ${list.length} / ${live} 条 · Showing ${list.length} of ${live}`;
    $('list').innerHTML = list.map(card).join('');
    const empty = $('empty');
    empty.hidden = list.length > 0;
    if (!list.length) {
      empty.innerHTML = live
        ? '没有符合条件的需求。换个筛选条件试试。<br>No needs match these filters.'
        : `还没有需求——你可以成为第一个。<br>No needs yet. Be the first.<br>
           <a class="btn primary" href="${SUBMIT_URL}">＋ 提交一条需求 / Submit a need</a>`;
    }
  }

  function fillAreas() {
    const counts = {};
    all.forEach((n) => { if (n.area && !n.duplicate) counts[n.area] = (counts[n.area] || 0) + 1; });
    const en = Object.fromEntries(all.map((n) => [n.area, n.area_en]));
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([a, c]) => {
      const o = document.createElement('option');
      o.value = a;
      o.textContent = `${a}${en[a] ? ' / ' + en[a] : ''} (${c})`;
      els.area.appendChild(o);
    });
  }

  let t;
  els.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 120); });
  [els.area, els.severity, els.source, els.sort, els.openOnly].forEach((e) => e.addEventListener('change', render));
  window.addEventListener('hashchange', () => { readHash(); render(); });

  load().then((data) => {
    all = data;
    fillAreas();
    readHash();
    renderSummary();
    render();
  }).catch((e) => {
    $('count').textContent = e.message;
  });
})();
