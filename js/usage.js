/* Token & cost usage monitor: logging, pricing, budgets and the Usage dashboard. */
import { DB, S, saveSettings, LS } from './store.js';
import { DEFAULT_PRICES, PROVIDERS } from './config.js';
import { $, esc, uid, toast, openModal, fmtNum, fmtUSD, dayKey, dayStart, monthStart, timeStr, download } from './util.js';
import { updatePrices } from './updates.js';

export let LOG = [];
let hooks = { getContext: () => null };
export function initUsage(h) { hooks = { ...hooks, ...h }; }

export async function loadUsage() {
  try { LOG = (await DB.all('usage')).sort((a, b) => a.ts - b.ts); } catch { LOG = []; }
}

/** Rough token estimate when a provider doesn't report usage (~4 chars per token). */
export const estimateTokens = t => Math.ceil(String(t || '').length / 4);

export function findPrice(model) {
  const id = String(model || '').toLowerCase(), short = id.split('/').pop();
  let best = null;
  for (const p of S.prices || []) {
    const m = String(p.match || '').toLowerCase().trim();
    if (m && (short.startsWith(m) || id.startsWith(m)) && (!best || m.length > best.match.length)) best = p;
  }
  return best;
}

/** Cost in USD for a usage entry, or null when no price is known. */
export function costOf(e) {
  if (!e) return null;
  if (e.cost != null && +e.cost >= 0) return +e.cost;   // provider-reported actual cost (OpenRouter)
  const p = findPrice(e.model);
  if (!p) return null;
  if ((+p.in || +p.out) && (e.in || e.out)) return ((+p.in || 0) * (e.in || 0) + (+p.out || 0) * (e.out || 0)) / 1e6;
  if (p.unit && +p.per && e.units) {
    if (p.unit === '1M chars') return e.units / 1e6 * p.per;
    if (p.unit === 'minute') return e.units / 60 * p.per;
    return e.units * p.per;
  }
  return null;
}

export async function recordUsage(e) {
  const entry = { id: uid(), ts: Date.now(), in: 0, out: 0, reasoning: 0, cached: 0, units: 0, est: false, ...e };
  LOG.push(entry);
  try { await DB.put('usage', entry); } catch (err) { console.warn('usage save failed', err); }
  checkBudget();
  dispatchEvent(new CustomEvent('nova:usage', { detail: entry }));
  return entry;
}

export function sum(entries) {
  const r = { in: 0, out: 0, reasoning: 0, cost: 0, req: 0, unpriced: 0, est: 0 };
  for (const e of entries) {
    r.in += e.in || 0; r.out += e.out || 0; r.reasoning += e.reasoning || 0; r.req++;
    const c = costOf(e);
    if (c == null) r.unpriced++; else r.cost += c;
    if (e.est) r.est++;
  }
  return r;
}
export const since = ts => LOG.filter(e => e.ts >= ts);

export function budgetState() {
  const d = sum(since(dayStart())).cost, m = sum(since(monthStart())).cost;
  const b = S.budget || {};
  return { d, m, dp: +b.daily ? d / b.daily : 0, mp: +b.monthly ? m / b.monthly : 0 };
}
function checkBudget() {
  const b = budgetState(), today = dayKey(Date.now()), month = today.slice(0, 7), warned = LS.get('nova.budgetWarn', {});
  if (b.dp >= 1 && warned.d !== today) { toast(`⚠️ Daily budget reached: ${fmtUSD(b.d)} of ${fmtUSD(S.budget.daily)}`, 7000); warned.d = today; }
  else if (b.mp >= 1 && warned.m !== month) { toast(`⚠️ Monthly budget reached: ${fmtUSD(b.m)} of ${fmtUSD(S.budget.monthly)}`, 7000); warned.m = month; }
  else if (b.dp >= 0.8 && b.dp < 1 && warned.d80 !== today) { toast(`Heads up: 80% of today's budget used (${fmtUSD(b.d)})`, 5000); warned.d80 = today; }
  LS.set('nova.budgetWarn', warned);
}
/** 'ok' | 'warn' | 'over' — for colouring the header pill. */
export function budgetLevel() {
  const b = budgetState(), p = Math.max(b.dp, b.mp);
  return p >= 1 ? 'over' : p >= 0.8 ? 'warn' : 'ok';
}

/* ---------- Dashboard ---------- */
let range = '7d', metric = 'cost';
const RANGES = { today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All time' };
const KIND_ICON = { chat: '💬', image: '🎨', video: '🎬', tts: '🔊', stt: '🎙️', embed: '🧬' };

function rangeStart() { return range === 'today' ? dayStart() : range === '7d' ? dayStart(6) : range === '30d' ? dayStart(29) : 0; }

function meter(label, value, limit, fmt) {
  if (!limit) return `<div class="meter"><div class="meter-top"><span>${label}</span><span>${fmt(value)} <small class="hint">· no limit set</small></span></div><div class="bar"><i style="width:0"></i></div></div>`;
  const p = value / limit, lvl = p >= 1 ? 'over' : p >= 0.8 ? 'warn' : 'ok';
  const status = lvl === 'over' ? '⛔ Over limit' : lvl === 'warn' ? '⚠️ Near limit' : '✓ On track';
  return `<div class="meter ${lvl}"><div class="meter-top"><span>${label}</span><span>${fmt(value)} / ${fmt(limit)} · <b>${status}</b></span></div><div class="bar"><i style="width:${Math.min(100, p * 100).toFixed(1)}%"></i></div></div>`;
}

function dashHTML() {
  const entries = since(rangeStart()), t = sum(entries), b = budgetState(), ctx = hooks.getContext();
  const byModel = new Map();
  for (const e of entries) {
    const k = `${e.provider}|${e.model}|${e.kind}`;
    const g = byModel.get(k) || { provider: e.provider, model: e.model, kind: e.kind, list: [] };
    g.list.push(e); byModel.set(k, g);
  }
  const rows = [...byModel.values()].map(g => ({ ...g, s: sum(g.list) })).sort((a, b) => b.s.cost - a.s.cost || (b.s.in + b.s.out) - (a.s.in + a.s.out));
  const recent = entries.slice(-25).reverse();
  const tiles = [
    ['Cost', fmtUSD(t.cost), t.unpriced ? `${t.unpriced} unpriced` : 'estimated'],
    ['Input tokens', fmtNum(t.in), 'prompt + context'],
    ['Output tokens', fmtNum(t.out), t.reasoning ? `${fmtNum(t.reasoning)} reasoning` : 'completions'],
    ['Requests', fmtNum(t.req), t.est ? `${t.est} estimated` : 'all reported'],
  ];
  return `<div class="dlg-title"><h2>📊 Usage & cost</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
  <div class="seg" id="u-range">${Object.entries(RANGES).map(([k, l]) => `<button data-r="${k}" class="${k === range ? 'active' : ''}">${l}</button>`).join('')}</div>
  <div class="tiles">${tiles.map(([l, v, s]) => `<div class="tile"><small>${l}</small><b>${v}</b><span>${esc(s)}</span></div>`).join('')}</div>
  ${ctx ? `<h3>Current chat</h3>
    ${meter(`Context window · ${esc(ctx.model)}`, ctx.tokens, ctx.limit, fmtNum)}
    <p class="hint">${ctx.est ? '≈ estimated' : 'Reported by provider'} · this chat so far: ${fmtNum(ctx.chatTokens)} tokens, ${fmtUSD(ctx.chatCost)}${S.historyLimit ? ` · sending last ${S.historyLimit} messages` : ''}</p>` : ''}
  <h3>Budgets</h3>
  ${meter('Today', b.d, +S.budget.daily, fmtUSD)}
  ${meter('This month', b.m, +S.budget.monthly, fmtUSD)}
  <div class="grid2"><label>Daily budget (USD)<input id="u-bd" type="number" min="0" step="0.5" value="${+S.budget.daily || ''}" placeholder="none"></label>
  <label>Monthly budget (USD)<input id="u-bm" type="number" min="0" step="1" value="${+S.budget.monthly || ''}" placeholder="none"></label></div>
  <div class="chart-head"><h3>Daily ${metric === 'cost' ? 'cost' : 'tokens'}</h3><div class="seg sm" id="u-metric"><button data-m="cost" class="${metric === 'cost' ? 'active' : ''}">Cost</button><button data-m="tokens" class="${metric === 'tokens' ? 'active' : ''}">Tokens</button></div></div>
  <div id="u-chart" class="chart"></div>
  <h3>By model</h3>
  ${rows.length ? `<div class="tablewrap"><table class="utable"><thead><tr><th>Model</th><th class="c-req">Req</th><th>Tokens ↑ / ↓</th><th>Cost</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><span class="kind">${KIND_ICON[r.kind] || '•'}</span> ${esc(r.model)}<small>${esc(PROVIDERS[r.provider]?.name || r.provider)}</small></td><td class="c-req">${r.s.req}</td><td>${fmtNum(r.s.in)} / ${fmtNum(r.s.out)}</td><td>${r.s.unpriced === r.s.req ? '<span class="hint">no price</span>' : fmtUSD(r.s.cost)}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="hint">No usage in this period yet.</p>'}
  ${recent.length ? `<h3>Recent requests</h3><div class="tablewrap"><table class="utable"><thead><tr><th>Time</th><th>Model</th><th>Tokens / units</th><th>Cost</th></tr></thead><tbody>
    ${recent.map(e => { const c = costOf(e); return `<tr><td>${dayKey(e.ts).slice(5)} ${timeStr(e.ts)}</td><td>${KIND_ICON[e.kind] || ''} ${esc(e.model)}</td><td>${e.in || e.out ? `↑${fmtNum(e.in)} ↓${fmtNum(e.out)}` : ''}${e.units ? ` ${fmtNum(e.units)} ${unitName(e.kind)}` : ''}${e.est ? ' <span class="badge" title="Estimated — provider did not report usage">est</span>' : ''}</td><td>${c == null ? '—' : fmtUSD(c)}</td></tr>`; }).join('')}
  </tbody></table></div>` : ''}
  <p class="hint">Costs are estimates from the editable price table. Your provider's billing page is the source of truth.</p>
  <div class="dlg-actions"><button class="btn danger" id="u-reset">Reset</button><button class="btn" id="u-csv">⬇ CSV</button><button class="btn" id="u-prices">💲 Prices</button><button class="btn primary" data-close>Done</button></div>`;
}
const unitName = k => ({ image: 'img', video: 's', tts: 'chars', stt: 's' }[k] || '');

export function openUsage() {
  openModal(dashHTML(), 'wide');
  drawChart();
  $('#u-range').onclick = e => { const b = e.target.closest('[data-r]'); if (b) { range = b.dataset.r; openUsage(); } };
  $('#u-metric').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { metric = b.dataset.m; openUsage(); } };
  const saveBudget = () => { S.budget = { daily: +$('#u-bd').value || 0, monthly: +$('#u-bm').value || 0 }; saveSettings(); dispatchEvent(new CustomEvent('nova:usage')); };
  $('#u-bd').onchange = () => { saveBudget(); openUsage(); };
  $('#u-bm').onchange = () => { saveBudget(); openUsage(); };
  $('#u-csv').onclick = exportCSV;
  $('#u-prices').onclick = () => openPrices();
  $('#u-reset').onclick = async () => {
    if (!confirm('Delete all usage history? Chats are not affected.')) return;
    try { await DB.clear('usage'); } catch {}
    LOG = []; dispatchEvent(new CustomEvent('nova:usage')); openUsage();
  };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function drawChart() {
  const el = $('#u-chart'); if (!el) return;
  const nDays = range === '30d' || range === 'all' ? 30 : range === '7d' ? 7 : 7;
  const data = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const from = dayStart(i), to = dayStart(i - 1), s = sum(LOG.filter(e => e.ts >= from && e.ts < to));
    data.push({ from, ...s, value: metric === 'cost' ? s.cost : s.in + s.out });
  }
  const W = Math.max(280, el.clientWidth || 560), H = 190, pl = 46, pr = 6, pt = 12, pb = 26;
  const max = niceMax(Math.max(...data.map(d => d.value))), bw = (W - pl - pr) / data.length, gap = Math.max(2, Math.min(8, bw * 0.28));
  const y = v => pt + (H - pt - pb) * (1 - v / max), fmt = metric === 'cost' ? fmtUSD : fmtNum;
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily ${metric} for the last ${data.length} days">`;
  for (const f of [0, 0.5, 1]) {
    const yy = y(max * f).toFixed(1);
    svg += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" class="grid"/><text x="${pl - 6}" y="${(+yy + 4).toFixed(1)}" text-anchor="end" class="axis">${fmt(max * f)}</text>`;
  }
  const every = Math.ceil(data.length / 7);
  data.forEach((d, i) => {
    const x = pl + i * bw + gap / 2, w = Math.max(1, bw - gap), top = y(d.value), h = H - pb - top;
    if (d.value > 0 && h > 0.5) {
      const r = Math.min(4, w / 2, h);
      svg += `<path class="barmark" data-i="${i}" d="M${x},${H - pb} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - pb} Z"/>`;
    }
    if (i % every === 0 || i === data.length - 1) {
      const dt = new Date(d.from);
      svg += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle" class="axis">${data.length <= 7 ? dt.toLocaleDateString(undefined, { weekday: 'short' }) : `${dt.getDate()}/${dt.getMonth() + 1}`}</text>`;
    }
  });
  svg += `<line x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}" class="baseline"/></svg><div class="ctip" hidden></div>`;
  el.innerHTML = svg;
  const tip = el.querySelector('.ctip'), s = el.querySelector('svg');
  const show = ev => {
    const rect = s.getBoundingClientRect(), x = ev.clientX - rect.left, i = Math.floor((x - pl) / bw);
    if (i < 0 || i >= data.length) { tip.hidden = true; return; }
    const d = data[i];
    s.querySelectorAll('.barmark').forEach(b => b.classList.toggle('hot', +b.dataset.i === i));
    tip.innerHTML = `<b>${new Date(d.from).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>${fmtUSD(d.cost)} · ${d.req} req<br>↑${fmtNum(d.in)} ↓${fmtNum(d.out)} tokens`;
    tip.hidden = false;
    const tx = Math.min(Math.max(pl + i * bw + bw / 2 - 70, 0), W - 150);
    tip.style.left = tx + 'px'; tip.style.top = '0px';
  };
  s.addEventListener('pointermove', show);
  s.addEventListener('pointerdown', show);
  s.addEventListener('pointerleave', () => { tip.hidden = true; s.querySelectorAll('.barmark.hot').forEach(b => b.classList.remove('hot')); });
}

function exportCSV() {
  const head = ['time', 'provider', 'model', 'kind', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens', 'units', 'estimated', 'cost_usd'];
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const lines = LOG.map(e => { const c = costOf(e); return [new Date(e.ts).toISOString(), e.provider, e.model, e.kind, e.in, e.out, e.reasoning, e.cached, e.units, e.est ? 1 : 0, c == null ? '' : c.toFixed(6)].map(q).join(','); });
  download([head.join(','), ...lines].join('\n'), `nova-usage-${dayKey(Date.now())}.csv`, 'text/csv');
}

/* ---------- Price editor ---------- */
function priceCard(p, i) {
  const units = ['', 'image', 'second', '1M chars', 'minute'];
  return `<div class="pcard" data-i="${i}">
    <div class="phead"><input data-f="match" value="${esc(p.match || '')}" placeholder="model prefix e.g. gpt-5-mini" aria-label="Model prefix"><button class="icon sm" data-del="${i}" title="Remove" aria-label="Remove">🗑</button></div>
    <div class="pgrid"><label>In /1M<input data-f="in" type="number" step="any" min="0" value="${p.in ?? ''}"></label>
    <label>Out /1M<input data-f="out" type="number" step="any" min="0" value="${p.out ?? ''}"></label>
    <label>Unit<select data-f="unit">${units.map(u => `<option value="${u}" ${u === (p.unit || '') ? 'selected' : ''}>${u || '—'}</option>`).join('')}</select></label>
    <label>$/unit<input data-f="per" type="number" step="any" min="0" value="${p.per ?? ''}"></label></div></div>`;
}
function collectPrices() {
  return [...document.querySelectorAll('.pcard')].map(c => {
    const g = f => c.querySelector(`[data-f="${f}"]`).value.trim();
    const o = { match: g('match') };
    if (g('in') !== '') o.in = +g('in'); if (g('out') !== '') o.out = +g('out');
    if (g('unit')) o.unit = g('unit'); if (g('per') !== '') o.per = +g('per');
    return o;
  }).filter(p => p.match);
}
function openPrices(list = S.prices) {
  openModal(`<div class="dlg-title"><h2>💲 Price table</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">USD. Token prices are per 1M tokens; unit prices are per image, per second of video, per 1M characters (voice) or per minute (transcription). Model IDs match by prefix — the longest match wins. Defaults are approximate list prices; check your provider's pricing page.</p>
    <input id="p-filter" placeholder="🔎 Filter models…">
    <div id="p-list">${list.map(priceCard).join('')}</div>
    <div class="dlg-actions"><button class="btn" id="p-or">↻ Update from OpenRouter</button><button class="btn" id="p-defaults">Restore defaults</button><button class="btn" id="p-add">＋ Add model</button><button class="btn" id="p-back">Back</button><button class="btn primary" id="p-save">Save prices</button></div>`, 'wide');
  $('#p-filter').oninput = e => { const q = e.target.value.toLowerCase(); document.querySelectorAll('.pcard').forEach(c => { c.hidden = q && !c.querySelector('[data-f=match]').value.toLowerCase().includes(q); }); };
  $('#p-list').onclick = e => { const b = e.target.closest('[data-del]'); if (b) b.closest('.pcard').remove(); };
  $('#p-add').onclick = () => { $('#p-list').insertAdjacentHTML('afterbegin', priceCard({}, Date.now())); $('#p-list .pcard input').focus(); };
  $('#p-defaults').onclick = () => { if (confirm('Replace your price table with the defaults?')) openPrices(structuredClone(DEFAULT_PRICES)); };
  $('#p-back').onclick = openUsage;
  $('#p-or').onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Updating…';
    try { const r = await updatePrices([...new Set(LOG.map(x => x.model))]); toast(`💲 ${r.updated} updated, ${r.added} added`); openPrices(); }
    catch (err) { toast(err.message, 5000); e.target.disabled = false; e.target.textContent = '↻ Update from OpenRouter'; }
  };
  $('#p-save').onclick = () => { S.prices = collectPrices(); saveSettings(); dispatchEvent(new CustomEvent('nova:usage')); toast('Prices saved'); openUsage(); };
}
