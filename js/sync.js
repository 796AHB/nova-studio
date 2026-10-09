/* Sync across devices through your AHB Broin server.
   Local changes are queued ("dirty") and pushed; remote changes are pulled with a cursor.
   Conflicts: last write wins per record. API keys are never synced. */
import { S, LS, DB, saveSettings, loadSkills, saveSkillsLS } from './store.js';
import { esc, blobToDataURL, dataUrlToBlob, toast, fmtDate } from './util.js';
import { log } from './logs.js';

const DIRTY = 'nova.sync.dirty', CURSOR = 'nova.sync.cursor', META_T = 'nova.sync.metaTimes';
let net = null, dirty = LS.get(DIRTY, {}), timer = null, running = null, applying = false, status = '';
let saveT;
const persistDirty = () => { clearTimeout(saveT); saveT = setTimeout(() => LS.set(DIRTY, dirty), 200); };
const metaTimes = () => LS.get(META_T, {});
const SETTINGS_FIELDS = ['system', 'temperature', 'maxTokens', 'reasoning', 'historyLimit', 'chat', 'image', 'video', 'tts', 'stt', 'theme', 'lang', 'budget', 'prices', 'pricesSeen', 'maxToolSteps', 'embed', 'autoUpdate', 'files'];

export function initSync(n) {
  net = n;
  addEventListener('nova:changed', e => { const d = e.detail || {}; if (d.store && d.id) mark(d.store, d.id); });
  addEventListener('nova:usage', e => { if (e.detail?.id) mark('usage', e.detail.id); });
  addEventListener('nova:settings', () => { if (!applying) { touchMeta('settings'); } });
  addEventListener('nova:skills', () => { if (!applying) touchMeta('skills'); });
  addEventListener('nova:notes', () => { if (!applying) touchMeta('notes'); });
  addEventListener('online', () => schedule(500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(800); });
  setInterval(() => { if (!document.hidden) schedule(0); }, 120000);
}
export const syncActive = () => !!(S.sync.enabled && S.account?.token);
function touchMeta(id) { const t = metaTimes(); t[id] = Date.now(); LS.set(META_T, t); mark('meta', id); }
function mark(store, id) { if (!syncActive()) return; dirty[`${store}:${id}`] = Date.now(); persistDirty(); schedule(4000); }
function schedule(ms) { if (!syncActive()) return; clearTimeout(timer); timer = setTimeout(() => syncNow(), ms); }

export function setSyncEnabled(on) {
  S.sync.enabled = on; saveSettings();
  if (on) { markAllLocal().then(() => syncNow(true)); }
}
/** First sync on a device: queue everything that exists locally. */
async function markAllLocal() {
  for (const store of ['convos', 'projects', 'kbs', 'chunks', 'usage']) {
    try { for (const r of await DB.all(store)) dirty[`${store}:${r.id}`] = Date.now(); } catch {}
  }
  for (const id of ['settings', 'skills', 'notes']) dirty[`meta:${id}`] = Date.now();
  persistDirty();
}

/* ---------- Encoding ---------- */
const f32ToB64 = v => { const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(s); };
const b64ToF32 = s => { const u = Uint8Array.from(atob(s), c => c.charCodeAt(0)); return new Float32Array(u.buffer); };
async function encodeConvo(c) {
  const msgs = [];
  for (const m of c.messages || []) {
    const o = { ...m };
    if (m.media?.length) o.media = await Promise.all(m.media.map(async x => {
      if (x.blob) return x.blob.size < 12 * 1024 * 1024 ? { kind: x.kind, prompt: x.prompt, src: await blobToDataURL(x.blob) } : { kind: x.kind, prompt: x.prompt, src: '', note: 'Too large to sync' };
      return x;
    }));
    if (m.atts?.length) o.atts = m.atts.map(a => (a.data?.length || 0) > 10e6 ? { ...a, data: '', note: 'Too large to sync' } : a);
    delete o.imgOpts;
    msgs.push(o);
  }
  return { ...c, messages: msgs };
}
function decodeConvo(c) {
  for (const m of c.messages || []) for (const x of m.media || []) if (x.kind === 'video' && x.src?.startsWith('data:')) { x.blob = dataUrlToBlob(x.src); delete x.src; }
  return c;
}
async function localRecord(store, id) {
  if (store === 'meta') {
    const updated = metaTimes()[id] || 0;
    if (!updated) return null;            // never changed on this device → nothing to send (don't overwrite other devices)
    if (id === 'settings') { const d = {}; for (const k of SETTINGS_FIELDS) d[k] = structuredClone(S[k]); d.connectors = { enabled: S.connectors.enabled, mcp: S.connectors.mcp.map(m => ({ ...m, auth: '' })) }; return { updated, data: d }; }
    if (id === 'skills') return { updated, data: loadSkills() };
    if (id === 'notes') return { updated, data: LS.get('nova.notes', []) };
    return null;
  }
  const r = await DB.get(store, id);
  if (!r) return store === 'chunks' || store === 'usage' ? { updated: Date.now(), deleted: true } : null;
  if (r.deleted) return { updated: r.updated || Date.now(), deleted: true };
  if (store === 'convos') return { updated: r.updated || Date.now(), data: await encodeConvo(r) };
  if (store === 'chunks') return { updated: r.updated || 1, data: { ...r, vec: r.vec ? f32ToB64(r.vec) : null } };
  if (store === 'usage') return { updated: r.ts || 1, data: r };
  return { updated: r.updated || Date.now(), data: r };
}
async function applyRemote(c, touched) {
  const { store, id } = c;
  if (store === 'meta') {
    if (c.deleted || !c.data) return;
    const t = metaTimes(); if ((t[id] || 0) >= c.updated) return;
    applying = true;
    try {
      if (id === 'settings') {
        for (const k of SETTINGS_FIELDS) if (c.data[k] !== undefined) S[k] = c.data[k];
        if (c.data.connectors) {
          S.connectors.enabled = c.data.connectors.enabled || {};
          const auth = Object.fromEntries(S.connectors.mcp.map(m => [m.id, m.auth]));
          S.connectors.mcp = (c.data.connectors.mcp || []).map(m => ({ ...m, auth: auth[m.id] || '' }));
        }
        saveSettings();
      } else if (id === 'skills') { saveSkillsLS(c.data); }
      else if (id === 'notes') { LS.set('nova.notes', c.data); }
    } finally { applying = false; }
    t[id] = c.updated; LS.set(META_T, t); touched.add('meta:' + id);
    return;
  }
  if (c.deleted) {
    if (store === 'chunks' || store === 'usage') await DB.del(store, id); else await DB.put(store, { id, deleted: true, updated: c.updated });
  } else {
    let d = c.data;
    if (store === 'convos') d = decodeConvo(d);
    if (store === 'chunks') d = { ...d, vec: d.vec ? b64ToF32(d.vec) : null };
    await DB.put(store, d);
  }
  touched.add(store);
}

/* ---------- Sync loop ---------- */
export function syncNow(loud) {
  if (!syncActive()) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    const touched = new Set(); let rounds = 0, pushed = 0, pulled = 0;
    try {
      while (rounds++ < 50) {
        // build a batch of local changes (≈4 MB)
        const keys = Object.keys(dirty), changes = [], marks = {}; let bytes = 0;
        for (const k of keys) {
          if (bytes > 4e6 || changes.length >= 300) break;
          const i = k.indexOf(':'), store = k.slice(0, i), id = k.slice(i + 1);
          const rec = await localRecord(store, id).catch(() => null);
          marks[k] = dirty[k];
          if (!rec) continue;
          const ch = { store, id, updated: rec.updated, ...(rec.deleted ? { deleted: true } : { data: rec.data }) };
          bytes += rec.deleted ? 50 : JSON.stringify(ch.data).length; changes.push(ch);
        }
        const since = LS.get(CURSOR, 0);
        const r = await fetch(net.root() + '/api/sync', { method: 'POST', headers: { ...net.headers(), 'content-type': 'application/json' }, body: JSON.stringify({ since, changes }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) throw new Error('Session expired — sign in again (Settings → Account)');
        if (!r.ok) throw new Error(j.error?.message || 'Sync failed (' + r.status + ')');
        for (const k of Object.keys(marks)) if (dirty[k] === marks[k]) delete dirty[k];
        persistDirty(); pushed += changes.length;
        for (const c of j.changes || []) { if (dirty[`${c.store}:${c.id}`]) continue; await applyRemote(c, touched); pulled++; }
        LS.set(CURSOR, j.cursor || since);
        if (!j.more && !Object.keys(dirty).length) break;
      }
      S.sync.last = Date.now(); S.sync.error = ''; applying = true; saveSettings(); applying = false;
      status = `✓ Synced ${fmtDate(S.sync.last)} ${new Date(S.sync.last).toLocaleTimeString()}${pushed || pulled ? ` · ↑${pushed} ↓${pulled}` : ''}`;
      if (touched.size) await net.reload(touched);
      if (loud) toast('🔄 ' + status.replace('✓ ', ''));
    } catch (e) {
      S.sync.error = e.message; status = '⚠️ ' + e.message; log('warn', 'Sync: ' + e.message);
      if (loud) toast('Sync: ' + e.message, 5000);
    }
    running = null;
  })();
  return running;
}
export function syncStatusHTML() {
  if (!syncActive()) return 'Sync is off';
  const pending = Object.keys(dirty).length;
  return esc(status || (S.sync.last ? `Last sync ${new Date(S.sync.last).toLocaleString()}` : 'Not synced yet')) + (pending ? ` · ${pending} pending` : '');
}
export function resetSyncState() { dirty = {}; LS.set(DIRTY, {}); LS.set(CURSOR, 0); LS.set(META_T, {}); }
