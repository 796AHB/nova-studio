/* File-based storage (no database needed). Everything lives in DATA_DIR:
   users.json, sessions.json, vapid.json, shares/<id>.json and u/<userId>/... per user. */
import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './env.js';

const queues = new Map();
/** Serialise writes per file so concurrent requests never interleave. */
function queued(file, fn) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(file, next.finally(() => { if (queues.get(file) === next) queues.delete(file); }));
  return next;
}
export const dataPath = (...p) => path.join(DATA_DIR, ...p);
export async function readJSONFile(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function writeJSONFile(file, data) {
  return queued(file, async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
  });
}
export const removeFile = file => queued(file, () => rm(file, { force: true }));
export async function listDir(dir) { try { return await readdir(dir); } catch { return []; } }
export const safeName = id => String(id).replace(/[^A-Za-z0-9_.-]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).slice(0, 240);
export const newId = (n = 12) => randomBytes(n).toString('base64url');

/* ---------- Per-user synced record stores ---------- */
export const STORES = ['convos', 'projects', 'kbs', 'chunks', 'usage', 'meta'];
const userCache = new Map();   // uid → { seq, idx: { store: { id: { u, s, d, z } } } }
async function userState(uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  const st = { seq: 0, idx: {} };
  for (const s of STORES) {
    st.idx[s] = await readJSONFile(dataPath('u', uid, s, '_index.json'), {});
    for (const v of Object.values(st.idx[s])) if (v.s > st.seq) st.seq = v.s;
  }
  userCache.set(uid, st);
  return st;
}
const saveIndex = (uid, store, st) => writeJSONFile(dataPath('u', uid, store, '_index.json'), st.idx[store]);

/** Apply one change with last-write-wins. Returns 'applied' | 'stale'. */
export async function putRecord(uid, store, { id, updated, deleted, data }) {
  if (!STORES.includes(store)) throw new Error('Unknown store ' + store);
  const st = await userState(uid), cur = st.idx[store][id];
  updated = +updated;
  if (!updated) return 'stale';            // records must carry a timestamp
  if (cur && cur.u >= updated) return 'stale';
  const file = dataPath('u', uid, store, safeName(id) + '.json');
  const s = ++st.seq;
  if (deleted) { await removeFile(file); st.idx[store][id] = { u: updated, s, d: 1 }; }
  else { const body = JSON.stringify(data); await writeJSONFile(file, data); st.idx[store][id] = { u: updated, s, z: body.length }; }
  await saveIndex(uid, store, st);
  return 'applied';
}
export async function getRecord(uid, store, id) {
  const st = await userState(uid), cur = st.idx[store]?.[id];
  if (!cur || cur.d) return null;
  return readJSONFile(dataPath('u', uid, store, safeName(id) + '.json'), null);
}
/** Changes after a cursor, in order, limited by count and bytes. */
export async function changesSince(uid, since, { maxCount = 400, maxBytes = 8 * 1024 * 1024 } = {}) {
  const st = await userState(uid), all = [];
  for (const store of STORES) for (const [id, v] of Object.entries(st.idx[store])) if (v.s > since) all.push({ store, id, ...v });
  all.sort((a, b) => a.s - b.s);
  const out = []; let bytes = 0, cursor = since;
  for (const c of all) {
    if (out.length >= maxCount || (bytes > 0 && bytes + (c.z || 0) > maxBytes)) return { changes: out, cursor, more: true, seq: st.seq };
    if (c.d) out.push({ store: c.store, id: c.id, updated: c.u, deleted: true });
    else {
      const data = await readJSONFile(dataPath('u', uid, c.store, safeName(c.id) + '.json'), null);
      if (data != null) { out.push({ store: c.store, id: c.id, updated: c.u, data }); bytes += c.z || 0; }
    }
    cursor = c.s;
  }
  return { changes: out, cursor: Math.max(cursor, since), more: false, seq: st.seq };
}
export async function storeStats(uid) {
  const st = await userState(uid), out = {};
  for (const s of STORES) { const v = Object.values(st.idx[s]).filter(x => !x.d); out[s] = { count: v.length, bytes: v.reduce((a, x) => a + (x.z || 0), 0) }; }
  return out;
}
export async function deleteUserData(uid) { userCache.delete(uid); await rm(dataPath('u', uid), { recursive: true, force: true }); }
