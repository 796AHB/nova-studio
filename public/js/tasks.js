/* Scheduled tasks.
   • On your Nova server: run on time even when your devices are off; results sync to all devices + push notification.
   • On this device: run while the app is open (missed runs catch up when you open it). */
import { PROVIDERS } from './config.js';
import { S, LS } from './store.js';
import { $, $$, esc, uid, toast, openModal, closeModal, fmtDate } from './util.js';
import { nextRun, describe } from './schedule.js';
import { log } from './logs.js';

let app = null;   // { serverTasks(): bool, api(path, opts), hasKey(pid), runLocal(task) → convoId, openConvo(id), syncNow(), projects() }
export function initTasks(a) {
  app = a;
  setInterval(tickLocal, 30000);
  setTimeout(tickLocal, 4000);
}
const tz0 = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const local = () => LS.get('nova.tasks', []);
const saveLocal = l => { LS.set('nova.tasks', l); };
let runningLocal = false;

async function tickLocal() {
  if (runningLocal || app.isBusy()) return;
  const list = local(), now = Date.now();
  const due = list.find(t => t.enabled && t.nextRun && t.nextRun <= now);
  if (!due) return;
  runningLocal = true;
  try { await runLocalTask(due); } finally { runningLocal = false; }
}
async function runLocalTask(t) {
  const list = local(), x = list.find(y => y.id === t.id); if (!x) return;
  let convoId = '', error = '';
  try { convoId = await app.runLocal(x); } catch (e) { error = e.message; log('warn', `Task ${x.name} failed: ${e.message}`); }
  x.lastRun = Date.now(); x.lastStatus = error ? 'error' : 'ok'; x.lastError = error; x.lastConvo = convoId; x.runs = (x.runs || 0) + 1;
  x.nextRun = x.schedule.type === 'once' ? null : nextRun(x.schedule, x.tz);
  if (x.schedule.type === 'once') x.enabled = false;
  saveLocal(list);
  app.notify(error ? `⚠️ ${x.name} failed` : `⏰ ${x.name}`, error || 'Your scheduled task finished', convoId);
  return convoId;
}

/* ---------- UI ---------- */
export async function openTasks() {
  let server = null;
  if (app.serverTasks()) { try { server = await app.api('/api/tasks'); } catch (e) { server = { error: e.message }; } }
  const row = (t, where) => `<div class="task ${t.enabled ? '' : 'off'}"><div class="task-main"><b>${esc(t.name)}</b><small>${esc(describe(t.schedule))} · ${esc(t.tz)} · ${esc(t.model)}${t.webSearch ? ' · 🔎 web' : ''}</small>
      <small>${t.nextRun && t.enabled ? `Next: ${new Date(t.nextRun).toLocaleString()}` : t.enabled ? 'Not scheduled' : 'Paused'}${t.lastRun ? ` · Last: ${fmtDate(t.lastRun)} ${new Date(t.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${t.lastStatus === 'error' ? '⚠️' : '✓'}` : ''}</small></div>
      <div class="task-act">${t.lastConvo ? `<button class="btn sm" data-open="${esc(t.lastConvo)}" data-w="${where}">Result</button>` : ''}<button class="btn sm" data-run="${t.id}" data-w="${where}">▶ Run now</button><button class="btn sm" data-edit="${t.id}" data-w="${where}">Edit</button></div></div>`;
  openModal(`<div class="dlg-title"><h2>⏰ Scheduled tasks</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">Let Nova do things on a schedule: a morning news brief, a weekly report, a daily quote in Malay…</p>
    <h3>💻 On your Nova server <small class="hint">— runs even when your phone is off</small></h3>
    ${!app.serverTasks() ? '<p class="hint">Sign in to your Nova server (Settings → Account) to run tasks on the server and get push notifications.</p>'
      : server?.error ? `<p class="hint">⚠️ ${esc(server.error)}</p>`
      : `${server.tasks.map(t => row(t, 'server')).join('') || '<p class="hint">No server tasks yet.</p>'}<p class="hint">Models available on the server: ${esc((server.providers || []).join(', ') || 'none — add provider keys to the server .env')}</p>`}
    <h3>📱 On this device <small class="hint">— runs while Nova is open</small></h3>
    ${local().map(t => row(t, 'device')).join('') || '<p class="hint">No device tasks yet.</p>'}
    <div class="dlg-actions"><button class="btn" data-close>Close</button><button class="btn primary" id="tk-new">＋ New task</button></div>`, 'wide');
  const body = $('#modalBody');
  body.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const where = b.dataset.w;
    if (b.id === 'tk-new') return editTask(null, app.serverTasks() && server?.providers?.length ? 'server' : 'device', server);
    if (b.dataset.open) { closeModal(); if (where === 'server') await app.syncNow(); app.openConvo(b.dataset.open); return; }
    if (b.dataset.edit) { const t = (where === 'server' ? server.tasks : local()).find(x => x.id === b.dataset.edit); return editTask(t, where, server); }
    if (b.dataset.run) {
      b.disabled = true; b.textContent = 'Running…';
      try {
        if (where === 'server') { const r = await app.api(`/api/tasks/${b.dataset.run}/run`, { method: 'POST' }); if (r.error) toast('⚠️ ' + r.error, 6000); await app.syncNow(); closeModal(); app.openConvo(r.convoId); }
        else { const id = await runLocalTask(local().find(x => x.id === b.dataset.run)); closeModal(); if (id) app.openConvo(id); }
      } catch (err) { toast(err.message, 5000); openTasks(); }
    }
  };
}

const TYPES = [['daily', 'Every day'], ['weekdays', 'Weekdays (Mon–Fri)'], ['weekly', 'Weekly on…'], ['hourly', 'Every hour'], ['once', 'Once']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function editTask(t, where, server) {
  const isNew = !t;
  t = t ? structuredClone(t) : { name: '', prompt: '', schedule: { type: 'daily', time: '08:00', days: [1], minute: 0 }, tz: tz0(), provider: '', model: '', webSearch: false, notify: true, enabled: true, projectId: '' };
  const provs = where === 'server' ? (server?.providers || []) : Object.keys(PROVIDERS).filter(p => PROVIDERS[p].models.chat && app.hasKey(p));
  if (!provs.includes(t.provider)) { t.provider = provs.includes(S.chat.provider) ? S.chat.provider : provs[0] || ''; t.model = t.provider === S.chat.provider ? S.chat.model : PROVIDERS[t.provider]?.models.chat[0] || ''; }
  const typeVal = t.schedule.type === 'weekly' && (t.schedule.days || []).slice().sort().join() === '1,2,3,4,5' ? 'weekdays' : t.schedule.type;
  const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [t.tz];
  const projects = app.projects();
  openModal(`<div class="dlg-title"><h2>${isNew ? 'New task' : 'Edit task'} <small class="hint">${where === 'server' ? '· on server' : '· on this device'}</small></h2></div>
    ${isNew && app.serverTasks() && server?.providers?.length ? `<div class="seg sm" id="tk-where"><button data-w="server" class="${where === 'server' ? 'active' : ''}">💻 Server</button><button data-w="device" class="${where === 'device' ? 'active' : ''}">📱 This device</button></div>` : ''}
    <label>Name<input id="tk-name" value="${esc(t.name)}" placeholder="e.g. Morning brief"></label>
    <label>What should Nova do?<textarea id="tk-prompt" rows="5" placeholder="e.g. Summarise today's top 5 tech news stories in Bahasa Melayu with links.">${esc(t.prompt)}</textarea></label>
    <div class="grid2"><label>Repeat<select id="tk-type">${TYPES.map(([v, l]) => `<option value="${v}" ${v === typeVal ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label id="tk-timel">Time<input id="tk-time" type="time" value="${esc(t.schedule.time || '08:00')}"></label></div>
    <div id="tk-days" class="inrow wrap">${DAYS.map((d, i) => `<label class="check"><input type="checkbox" value="${i}" ${(t.schedule.days || []).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
    <label id="tk-minl">Minute past the hour<input id="tk-min" type="number" min="0" max="59" value="${t.schedule.minute || 0}"></label>
    <label id="tk-atl">Date & time<input id="tk-at" type="datetime-local" value="${t.schedule.at ? (d => { d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); })(new Date(t.schedule.at)) : ''}"></label>
    <label>Time zone<input id="tk-tz" value="${esc(t.tz)}" list="tk-tzs"><datalist id="tk-tzs">${tzs.map(z => `<option value="${esc(z)}">`).join('')}</datalist></label>
    <div class="grid2"><label>Provider<select id="tk-prov">${provs.map(p => `<option value="${p}" ${p === t.provider ? 'selected' : ''}>${esc(PROVIDERS[p]?.name || p)}</option>`).join('') || '<option value="">No providers available</option>'}</select></label>
    <label>Model<input id="tk-model" value="${esc(t.model)}" spellcheck="false"></label></div>
    ${projects.length ? `<label>Save results in project<select id="tk-proj"><option value="">All chats</option>${projects.map(p => `<option value="${p.id}" ${p.id === t.projectId ? 'selected' : ''}>${esc(p.icon || '📁')} ${esc(p.name)}</option>`).join('')}</select></label>` : ''}
    <label class="check" style="margin-top:10px"><input type="checkbox" id="tk-web" ${t.webSearch ? 'checked' : ''} ${where === 'server' && !server?.webSearch ? 'disabled' : ''}> 🔎 Search the web first ${where === 'server' ? (server?.webSearch ? '' : '<small class="hint">(needs TAVILY_API_KEY on the server)</small>') : '<small class="hint">(uses your enabled connectors)</small>'}</label>
    <label class="check" style="margin-top:6px"><input type="checkbox" id="tk-notify" ${t.notify !== false ? 'checked' : ''}> 🔔 Notify me</label>
    <label class="check" style="margin-top:6px"><input type="checkbox" id="tk-on" ${t.enabled ? 'checked' : ''}> Enabled</label>
    <p class="hint" id="tk-next"></p>
    <div class="dlg-actions">${isNew ? '' : '<button class="btn danger" id="tk-del">Delete</button>'}<button class="btn" id="tk-back">Back</button><button class="btn primary" id="tk-save">${isNew ? 'Create task' : 'Save'}</button></div>`);
  const sched = () => {
    const type = $('#tk-type').value;
    return type === 'weekdays' ? { type: 'weekly', time: $('#tk-time').value, days: [1, 2, 3, 4, 5] }
      : type === 'weekly' ? { type, time: $('#tk-time').value, days: $$('#tk-days input:checked').map(i => +i.value) }
      : type === 'hourly' ? { type, minute: +$('#tk-min').value || 0 }
      : type === 'once' ? { type, at: $('#tk-at').value ? new Date($('#tk-at').value).toISOString() : '' }
      : { type: 'daily', time: $('#tk-time').value };
  };
  const vis = () => {
    const type = $('#tk-type').value;
    $('#tk-days').hidden = type !== 'weekly'; $('#tk-minl').hidden = type !== 'hourly'; $('#tk-atl').hidden = type !== 'once'; $('#tk-timel').hidden = type === 'hourly' || type === 'once';
    const n = nextRun(sched(), $('#tk-tz').value || 'UTC');
    $('#tk-next').textContent = n ? `Next run: ${new Date(n).toLocaleString()} (your time)` : 'Not scheduled — check the date/time.';
  };
  vis();
  ['#tk-type', '#tk-time', '#tk-min', '#tk-at', '#tk-tz'].forEach(s => $(s).addEventListener('input', vis));
  $('#tk-days').onchange = vis;
  $('#tk-prov').onchange = e => { $('#tk-model').value = PROVIDERS[e.target.value]?.models.chat[0] || ''; };
  const w = $('#tk-where'); if (w) w.onclick = e => { const b = e.target.closest('[data-w]'); if (b) editTask(null, b.dataset.w, server); };
  $('#tk-back').onclick = openTasks;
  $('#tk-save').onclick = async () => {
    const data = { name: $('#tk-name').value.trim() || 'Task', prompt: $('#tk-prompt').value.trim(), schedule: sched(), tz: $('#tk-tz').value.trim() || 'UTC', provider: $('#tk-prov').value, model: $('#tk-model').value.trim(), webSearch: $('#tk-web').checked, notify: $('#tk-notify').checked, enabled: $('#tk-on').checked, projectId: $('#tk-proj')?.value || '' };
    if (!data.prompt) return toast('Tell Nova what to do');
    if (!data.provider || !data.model) return toast('Choose a provider and model');
    if (data.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    try {
      if (where === 'server') await app.api(isNew ? '/api/tasks' : `/api/tasks/${t.id}`, { method: isNew ? 'POST' : 'PATCH', body: data });
      else {
        const list = local(), item = isNew ? { id: uid(), created: Date.now(), runs: 0 } : list.find(x => x.id === t.id);
        Object.assign(item, data); item.nextRun = item.enabled ? nextRun(item.schedule, item.tz) : null;
        if (isNew) list.push(item); saveLocal(list);
      }
      toast(isNew ? '⏰ Task created' : 'Task saved'); openTasks();
    } catch (e) { toast(e.message, 5000); }
  };
  const del = $('#tk-del'); if (del) del.onclick = async () => {
    if (!confirm('Delete this task?')) return;
    if (where === 'server') { try { await app.api(`/api/tasks/${t.id}`, { method: 'DELETE' }); } catch (e) { return toast(e.message); } }
    else saveLocal(local().filter(x => x.id !== t.id));
    openTasks();
  };
}
