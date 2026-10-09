/* Runs: plan → steps → artifacts → audit.
   An agent-style workspace layer on top of chat. A "run" is one assistant turn that
   used tools or produced a plan; it keeps a plan (editable before it runs), a step
   per tool call with timings and the permission decision that let it through, any
   artifacts it produced, and a full audit trail you can export.

   Tool trust is SESSION-scoped: `allowAll` lives in memory only and is cleared on
   reload. Every auto-approved call is recorded in the audit trail with its
   permission state, so blanket approval is never silent. */

import { DB, S, saveSettings } from './store.js';
import { $, esc, uid, openModal, closeModal, download, copy, toast, fmtDate, timeStr, fmtNum } from './util.js';
import { log, redact } from './logs.js';

let net = { complete: null, chatModelFor: () => S.chat, currentConvoId: () => null };
export function initRuns(n) { net = { ...net, ...n }; }

/* ---------- session tool trust (never persisted) ---------- */
let allowAll = false;
const trustedOnce = new Set();
export const sessionTrust = () => ({ allowAll, trustedOnce: [...trustedOnce] });
export function setAllowAll(v) {
  allowAll = !!v;
  if (allowAll) log('warn', 'Tool approval: allowing all tools for this session', 'Every auto-approved tool call is recorded in the run audit trail.');
  dispatchEvent(new CustomEvent('nova:trust'));
}
export const isTrusted = name => allowAll || trustedOnce.has(name);
export function trustOnce(name) { trustedOnce.add(name); }

/* ---------- state ---------- */
let RUNS = [];
export const runs = () => RUNS;
export async function loadRuns() {
  try { RUNS = (await DB.all('runs')).sort((a, b) => b.ts - a.ts); } catch { RUNS = []; }
  return RUNS;
}
const save = r => DB.put('runs', r).catch(e => log('warn', 'Could not save run', e.message));

/* ---------- audit trail ---------- */
function audit(run, ev, extra = {}) {
  run.audit ||= [];
  run.audit.push({ ts: Date.now(), ev, ...extra });
  if (run.audit.length > 500) run.audit = run.audit.slice(-500);
}
export function auditNote(run, ev, text) { if (run) { audit(run, ev, { text: redact(text).slice(0, 500) }); save(run); } }

/* ---------- plan ---------- */
/** Ask the model for a short, editable plan as JSON steps. Falls back to a single step. */
export async function draftPlan(goal, signal) {
  const sys = 'You turn a goal into a short ordered plan of concrete steps for an AI assistant that can use tools (web search, web reader, notes, calculator, GitHub, local files, MCP servers) and produce images and documents. Reply with ONLY a JSON array of 2-6 objects: {"step": "short imperative description"}. No prose, no markdown fence.';
  let raw = '';
  try { raw = await net.complete(goal, sys, signal); }
  catch (e) { if (e.name === 'AbortError') throw e; log('warn', 'Plan generation failed', e.message); }
  const m = raw.match(/\[[\s\S]*\]/);
  let items = [];
  if (m) { try { items = JSON.parse(m[0]); } catch { try { items = JSON.parse(m[0].replace(/,\s*$/, '')); } catch {} } }
  const steps = items.map(x => typeof x === 'string' ? x : x?.step).filter(s => typeof s === 'string' && s.trim()).slice(0, 8);
  return (steps.length ? steps : [goal]).map(text => ({ id: uid(), text: text.trim().slice(0, 300), status: 'todo' }));
}

/* ---------- runs ---------- */
export function startRun({ goal, convoId, msgId, plan }) {
  const run = { id: uid(), ts: Date.now(), goal: String(goal || '').slice(0, 500), convoId, msgId, plan: plan || [], steps: [], artifacts: [], audit: [], status: 'running' };
  audit(run, 'run.start', { goal: run.goal });
  RUNS.unshift(run);
  save(run);
  return run;
}
export function setPlan(run, plan) { run.plan = plan.map(p => ({ id: p.id || uid(), text: p.text, status: p.status || 'todo' })); audit(run, 'plan.edit', { text: plan.map(p => p.text).join(' → ') }); save(run); }
export function advancePlan(run, stepId, status) {
  const p = run.plan.find(x => x.id === stepId);
  if (!p) return;
  p.status = status; p.at = Date.now();
  audit(run, 'plan.step', { text: `${status}: ${p.text}` });
  save(run);
}
/** Record one tool call as a run step. `decision` is how approval was resolved. */
export function startStep(run, { name, connector, icon, label, args }) {
  if (!run) return null;
  const st = { id: uid(), name, connector, icon, label: label || name, args, status: 'running', startedAt: Date.now(), decision: null };
  run.steps.push(st);
  audit(run, 'tool.start', { text: `${connector} · ${label || name}`, step: st.id });
  save(run);
  return st;
}
export function endStep(run, st, status, result) {
  if (!run || !st) return;
  st.status = status; st.endedAt = Date.now(); st.ms = st.endedAt - st.startedAt;
  if (result != null) st.result = String(result).slice(0, 2000);
  audit(run, 'tool.end', { text: `${status} in ${(st.ms / 1000).toFixed(1)}s`, step: st.id, decision: st.decision });
  save(run);
}
export function decideStep(run, st, decision) { if (st) { st.decision = decision; audit(run, 'tool.decision', { text: decision, step: st.id, decision }); save(run); } }
export function addArtifact(run, art) {
  if (!run) return null;
  const a = { id: uid(), ts: Date.now(), ...art };
  run.artifacts.push(a);
  audit(run, 'artifact.add', { text: `${a.kind || 'file'}: ${a.name}` });
  save(run);
  return a;
}
export function endRun(run, status = 'done', note) {
  if (!run) return;
  run.status = status; run.endedAt = Date.now(); if (note) run.note = note;
  audit(run, 'run.end', { text: status + (note ? ` — ${note}` : '') });
  save(run);
  dispatchEvent(new CustomEvent('nova:runs'));
}
export const runById = id => RUNS.find(r => r.id === id);
export const runForMsg = (convoId, msgId) => [...RUNS].reverse().find(r => r.convoId === convoId && r.msgId === msgId);

/* ---------- audit export ---------- */
const PERM_TEXT = { auto: 'auto-approved (session trust)', once: 'approved once', always: 'allow always', declined: 'declined', trusted: 'already trusted' };
export function auditJSON(run) {
  return JSON.stringify({ app: 'AHB Broin', exported: new Date().toISOString(), goal: run.goal, status: run.status, plan: run.plan, steps: run.steps, artifacts: run.artifacts.map(a => ({ ...a, data: a.data ? `[${a.kind || 'file'} omitted]` : '' })), audit: run.audit }, null, 2);
}
export function auditText(run) {
  const L = [];
  L.push(`AHB Broin run — ${run.status}`, `Goal: ${run.goal}`, `Started: ${new Date(run.ts).toLocaleString()}`, '');
  if (run.plan?.length) { L.push('PLAN'); run.plan.forEach((p, i) => L.push(`  ${i + 1}. [${p.status}] ${p.text}`)); L.push(''); }
  if (run.steps?.length) { L.push('STEPS'); run.steps.forEach(s => L.push(`  ${s.icon} ${s.connector} · ${s.label} (${s.name}) — ${s.status}${s.ms != null ? ` in ${(s.ms / 1000).toFixed(1)}s` : ''}${s.decision ? ` · ${PERM_TEXT[s.decision] || s.decision}` : ''}`)); L.push(''); }
  if (run.artifacts?.length) { L.push('ARTIFACTS'); run.artifacts.forEach(a => L.push(`  ${a.kind || 'file'}: ${a.name}`)); L.push(''); }
  L.push('AUDIT TRAIL');
  (run.audit || []).forEach(e => L.push(`  ${new Date(e.ts).toLocaleTimeString()} ${e.ev}${e.text ? ` — ${e.text}` : ''}`));
  return L.join('\n');
}

/* ---------- UI ---------- */
const ST_ICON = { todo: '○', doing: '◐', done: '●', skipped: '–' };
const PERM_BADGE = { auto: '⚡ auto-approved (session trust)', once: '✓ approved once', always: '✓ allow always', declined: '✋ declined', trusted: '✓ already trusted' };

function planHTML(run, editable) {
  if (!run.plan?.length) return '';
  return `<div class="plan"><div class="plan-h">📋 Plan ${editable ? '<button class="btn sm" data-r-act="plan-save">Save</button>' : ''}</div>
    <ol class="planlist">${run.plan.map((p, i) => editable
      ? `<li class="${p.status}"><select data-r-step="${p.id}" class="pst"><option value="todo" ${p.status === 'todo' ? 'selected' : ''}>todo</option><option value="doing" ${p.status === 'doing' ? 'selected' : ''}>doing</option><option value="done" ${p.status === 'done' ? 'selected' : ''}>done</option><option value="skipped" ${p.status === 'skipped' ? 'selected' : ''}>skipped</option></select><input data-r-text="${p.id}" value="${esc(p.text)}" aria-label="Step ${i + 1}"></li>`
      : `<li class="${p.status}"><span class="pm">${ST_ICON[p.status] || '○'}</span> ${esc(p.text)}${p.at ? `<small>${timeStr(p.at)}</small>` : ''}</li>`).join('')}</ol></div>`;
}
function stepsHTML(run) {
  if (!run.steps?.length) return '';
  return `<div class="steps"><div class="steps-h">🔧 Steps</div>${run.steps.map(s => `<details class="step ${s.status}"><summary>
      <span class="ti">${s.icon || '🔧'}</span><span class="tn"><b>${esc(s.connector)}</b> ${esc(s.label || s.name)}</span>
      <span class="ts">${s.status === 'running' ? '<span class="dots"><i></i><i></i><i></i></span>' : s.status === 'ok' ? '✓' : '⚠️'}${s.ms != null ? ` ${(s.ms / 1000).toFixed(1)}s` : ''}</span></summary>
    <div class="tbody">${s.decision ? `<small>Permission</small><p class="perm${s.decision === 'auto' ? ' p-auto' : ''}${s.decision === 'declined' ? ' p-declined' : ''}">${PERM_BADGE[s.decision] || esc(s.decision)}</p>` : ''}<small>Input</small><pre>${esc(s.args || '{}')}</pre>${s.result != null ? `<small>Result</small><pre>${esc(s.result)}</pre>` : ''}</div></details>`).join('')}</div>`;
}
function artifactsHTML(run) {
  if (!run.artifacts?.length) return '';
  return `<div class="arts"><div class="arts-h">📎 Artifacts</div><div class="artgrid">${run.artifacts.map(a => `<div class="art">
    ${a.kind === 'image' && a.data ? `<img src="${esc(a.data)}" alt="${esc(a.name)}" loading="lazy">` : a.kind === 'link' ? `<div class="artico">🔗</div>` : '<div class="artico">📄</div>'}
    <div class="artb"><a href="${esc(a.href || a.data || '#')}" ${a.href ? 'target="_blank" rel="noopener"' : ''} download="${esc(a.name)}">${esc(a.name)}</a>
    <small>${esc(a.kind || 'file')}${a.size ? ' · ' + fmtNum(a.size) + ' B' : ''}</small></div></div>`).join('')}</div></div>`;
}
function auditHTML(run) {
  const rows = (run.audit || []).slice().reverse().map(e => `<div class="logrow info"><span class="lt">${timeStr(e.ts)}</span><b>${esc(e.ev)}</b>${e.text ? ` ${esc(e.text)}` : ''}</div>`).join('');
  return `<details class="audit"><summary>🧾 Audit trail (${run.audit?.length || 0})</summary><div class="logs">${rows || '<p class="hint">No events</p>'}</div></details>`;
}

export function openRun(runId) {
  const run = runById(runId);
  if (!run) return toast('That run is no longer on this device');
  const live = run.status === 'running';
  openModal(`<div class="dlg-title"><h2>▶ ${live ? 'Run' : 'Run summary'}</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">${esc(run.goal)}</p>
    ${live ? planHTML(run, true) : planHTML(run, false)}
    ${stepsHTML(run)}
    ${artifactsHTML(run)}
    ${auditHTML(run)}
    <div class="dlg-actions">
      <button class="btn" data-r-act="json">⬇ Audit JSON</button>
      <button class="btn" data-r-act="txt">📋 Copy audit</button>
      <button class="btn primary" data-close>Done</button>
    </div>`, 'wide');
  const body = $('#modalBody');
  body.onclick = e => {
    const b = e.target.closest('[data-r-act]'); if (!b) return;
    if (b.dataset.rAct === 'plan-save') {
      const plan = [...body.querySelectorAll('[data-r-text]')].map(inp => ({ id: inp.dataset.rText, text: inp.value.trim() || 'Step', status: body.querySelector(`[data-r-step="${inp.dataset.rText}"]`)?.value || 'todo' }));
      setPlan(run, plan); toast('Plan saved'); openRun(run.id);
    } else if (b.dataset.rAct === 'json') download(auditJSON(run), `nova-run-${run.id}.json`);
    else if (b.dataset.rAct === 'txt') copy(auditText(run));
  };
}

/** Runs screen: history, live run, and the session trust control. */
export function openRuns() {
  const t = sessionTrust();
  const rows = RUNS.map(r => `<div class="runrow ${r.status}"><button class="runmain" data-r-open="${r.id}">
      <span class="rs">${r.status === 'running' ? '<span class="dots"><i></i><i></i><i></i></span>' : r.status === 'done' ? '✓' : '⚠️'}</span>
      <span class="rt">${esc(r.goal || '(no goal)')}</span>
      <span class="rm">${fmtDate(r.ts)} · ${timeStr(r.ts)} · ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}${r.artifacts.length ? ` · ${r.artifacts.length} artifact${r.artifacts.length === 1 ? '' : 's'}` : ''}${r.plan.length ? ` · ${r.plan.length} plan step${r.plan.length === 1 ? '' : 's'}` : ''}</span></button></div>`).join('');
  openModal(`<div class="dlg-title"><h2>▶ Runs</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">Every tool-using turn is recorded here: plan, steps with timings, the permission decision for each, artifacts, and a full audit trail you can export.</p>
    <label class="check trust"><input type="checkbox" id="r-allowall" ${t.allowAll ? 'checked' : ''}> Allow all tools this session <span class="badge" title="Cleared when you reload or close the tab. Every auto-approved call is written to the run audit trail.">session only</span></label>
    ${t.trustedOnce.length ? `<p class="hint">Trusted this session: ${t.trustedOnce.map(esc).join(', ')}</p>` : ''}
    ${allowAll ? '<p class="hint warn">⚠️ All tools run without asking, including MCP servers. Every call is logged to the audit trail. Turn this off to go back to asking.</p>' : ''}
    <div class="runlist">${rows || '<p class="hint">No runs yet. Chat that uses connectors (🔌) will show up here.</p>'}</div>
    <div class="dlg-actions"><button class="btn primary" data-close>Done</button></div>`, 'wide');
  const body = $('#modalBody');
  $('#r-allowall').onchange = e => { setAllowAll(e.target.checked); openRuns(); };
  body.onclick = e => { const b = e.target.closest('[data-r-open]'); if (b) openRun(b.dataset.rOpen); };
}