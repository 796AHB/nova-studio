/* Model compare: send one prompt to several models at once and compare quality, speed and cost. */
import { PROVIDERS } from './config.js';
import { S, LS } from './store.js';
import { $, $$, esc, uid, toast, fmtNum, fmtUSD, copy } from './util.js';

let api = null, dlg = null, runs = [], ctl = null;
export function initCompare(a) { api = a; }
const slotsKey = 'nova.compareSlots';
function defaultSlots() {
  const s = [{ ...S.chat }];
  for (const [pid, m] of [['anthropic', 'claude-sonnet-5-5'], ['gemini', 'gemini-2.5-flash'], ['openai', 'gpt-5-mini']]) if (s.length < 2 && api.hasKey(pid) && pid !== S.chat.provider) s.push({ provider: pid, model: m });
  if (s.length < 2) s.push({ ...S.chat });
  return s;
}
let slots = null;

export function openCompare() {
  slots ||= LS.get(slotsKey, null) || defaultSlots();
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'cmpDlg'; document.body.append(dlg); dlg.addEventListener('close', () => ctl?.abort()); }
  render();
  if (!dlg.open) dlg.showModal();
}
function render() {
  const chatProv = Object.entries(PROVIDERS).filter(([, p]) => p.models.chat);
  dlg.innerHTML = `<div class="cmp"><div class="dlg-title"><h2>⚖️ Compare models</h2><button class="icon sm" id="cm-x" aria-label="Close">✕</button></div>
    <div class="cmp-slots">${slots.map((s, i) => `<div class="cmp-slot"><select data-i="${i}" class="cm-p" aria-label="Provider ${i + 1}">${chatProv.map(([id, p]) => `<option value="${id}" ${id === s.provider ? 'selected' : ''}>${esc(p.name)}${api.hasKey(id) ? '' : ' ⚠️'}</option>`).join('')}</select>
      <input data-i="${i}" class="cm-m" value="${esc(s.model)}" list="cm-dl-${i}" aria-label="Model ${i + 1}" spellcheck="false"><datalist id="cm-dl-${i}">${[...new Set([...(PROVIDERS[s.provider]?.models.chat || []), ...(S.fetched[s.provider] || [])])].filter(Boolean).slice(0, 200).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
      ${slots.length > 2 ? `<button class="icon sm" data-rm="${i}" aria-label="Remove model ${i + 1}">✕</button>` : ''}</div>`).join('')}
      ${slots.length < 4 ? '<button class="chip" id="cm-add">＋ Add model</button>' : ''}</div>
    <div class="inrow cmp-in"><textarea id="cm-q" rows="2" placeholder="Ask the same question to every model…">${esc(dlg._q || '')}</textarea><button class="btn primary" id="cm-go">${ctl ? '■ Stop' : 'Compare'}</button></div>
    <div class="cmp-cols" style="--n:${slots.length}">${slots.map((s, i) => colHTML(runs[i], s, i)).join('')}</div></div>`;
  $('#cm-x', dlg).onclick = () => dlg.close();
  $$('.cm-p', dlg).forEach(sel => sel.onchange = () => { const i = +sel.dataset.i; slots[i] = { provider: sel.value, model: PROVIDERS[sel.value].models.chat[0] || '' }; save(); render(); });
  $$('.cm-m', dlg).forEach(inp => inp.onchange = () => { slots[+inp.dataset.i].model = inp.value.trim(); save(); });
  $$('[data-rm]', dlg).forEach(b => b.onclick = () => { slots.splice(+b.dataset.rm, 1); runs = []; save(); render(); });
  const add = $('#cm-add', dlg); if (add) add.onclick = () => { slots.push({ ...S.chat }); save(); render(); };
  $('#cm-q', dlg).oninput = e => { dlg._q = e.target.value; };
  $('#cm-q', dlg).onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !matchMedia('(pointer: coarse)').matches) && !e.shiftKey) { e.preventDefault(); go(); } };
  $('#cm-go', dlg).onclick = () => ctl ? ctl.abort() : go();
  dlg.querySelector('.cmp-cols').onclick = e => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const r = runs[+b.dataset.i]; if (!r) return;
    if (b.dataset.c === 'copy') copy(r.text);
    else if (b.dataset.c === 'chat') { dlg.close(); api.continueInChat(r.prompt, r); }
  };
}
const save = () => LS.set(slotsKey, slots);
function colHTML(r, s, i) {
  const name = `${esc(s.model || '?')}<small>${esc(PROVIDERS[s.provider]?.name || '')}</small>`;
  if (!r) return `<div class="cmp-col"><div class="cmp-h">${name}</div><div class="cmp-out hint">Waiting for a question…</div></div>`;
  const best = r.done && runs.filter(x => x?.done && !x.error).length > 1;
  const fastest = best && runs.filter(x => x?.done && !x.error).every(x => x.total >= r.total);
  const cheapest = best && r.cost != null && runs.filter(x => x?.done && !x.error && x.cost != null).every(x => x.cost >= r.cost);
  return `<div class="cmp-col" id="cmp-${i}"><div class="cmp-h">${name}${fastest ? '<span class="badge ok">⚡ fastest</span>' : ''}${cheapest ? '<span class="badge ok">💲 cheapest</span>' : ''}</div>
    <div class="cmp-out md">${r.error ? `<div class="error">⚠️ ${esc(r.error)}</div>` : api.md(r.text || '') + (r.done ? '' : '<span class="dots"><i></i><i></i><i></i></span>')}</div>
    <div class="cmp-meta">${r.ttft != null ? `⏱ first ${(r.ttft / 1000).toFixed(1)}s` : ''}${r.done && !r.error ? ` · total ${(r.total / 1000).toFixed(1)}s · ↑${fmtNum(r.in)} ↓${fmtNum(r.out)}${r.est ? '≈' : ''} · ${r.cost != null ? fmtUSD(r.cost) : 'no price'}${r.total ? ` · ${Math.round(r.out / Math.max(r.total - (r.ttft || 0), 1) * 1000)} tok/s` : ''}` : ''}</div>
    ${r.done && !r.error ? `<div class="cmp-act"><button class="btn sm" data-c="copy" data-i="${i}">📋 Copy</button><button class="btn sm" data-c="chat" data-i="${i}">💬 Continue in chat</button></div>` : ''}</div>`;
}
function paint(i) {
  const old = $('#cmp-' + i, dlg); if (!old) return;
  const tmp = document.createElement('div'); tmp.innerHTML = colHTML(runs[i], slots[i], i); old.replaceWith(tmp.firstElementChild);
}
async function go() {
  const q = ($('#cm-q', dlg).value || '').trim(); if (!q) return toast('Type a question');
  for (const s of slots) if (!api.hasKey(s.provider)) return toast(`Add a key for ${PROVIDERS[s.provider].name} first`);
  ctl = new AbortController(); runs = slots.map(() => ({ text: '', done: false, prompt: q }));
  render();
  const system = api.buildSystem();
  await Promise.all(slots.map(async (s, i) => {
    const r = runs[i], t0 = performance.now(); let raf = 0;
    try {
      const res = await api.callChat(s.provider, s.model, [{ role: 'user', text: q, atts: [] }], system, {
        text: t => { if (r.ttft == null) r.ttft = performance.now() - t0; r.text += t; if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(i); }); },
        think: () => { if (r.ttft == null) r.ttft = performance.now() - t0; }, media: () => {},
      }, ctl.signal, {});
      r.total = performance.now() - t0;
      const u = res?.usage;
      r.in = u?.in ?? api.estimate(system + q); r.out = u?.out ?? api.estimate(r.text); r.est = !u;
      const entry = await api.recordUsage({ provider: s.provider, model: s.model, kind: 'chat', in: r.in, out: r.out, reasoning: u?.reasoning || 0, est: !u, tag: 'compare' });
      r.cost = api.costOf(entry); r.provider = s.provider; r.model = s.model;
    } catch (e) { r.error = e.name === 'AbortError' ? 'Stopped' : e.message; r.total = performance.now() - t0; }
    r.done = true; paint(i);
  }));
  ctl = null; render();
}
export { uid };
