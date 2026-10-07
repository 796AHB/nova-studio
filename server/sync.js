/* Sync across devices: last-write-wins per record, cursor-based pull. */
import { json, fail, readJSON } from './http.js';
import { requireUser } from './auth.js';
import { putRecord, changesSince, STORES, dataPath, readJSONFile, writeJSONFile } from './db.js';
import { env } from './env.js';

const MAX = (+env.SYNC_MAX_MB || 50) * 1024 * 1024;
export async function syncRoute(req, res) {
  const user = requireUser(req, res); if (!user) return;
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const body = await readJSON(req, MAX);
  const since = Math.max(0, +body.since || 0);
  const results = {}; let usageAdded = [];
  for (const c of Array.isArray(body.changes) ? body.changes.slice(0, 2000) : []) {
    if (!STORES.includes(c.store) || typeof c.id !== 'string' || !c.id || c.id.length > 200) continue;
    const r = await putRecord(user.id, c.store, c);
    results[`${c.store}:${c.id}`] = r;
    if (r === 'applied' && c.store === 'usage' && !c.deleted && c.data) usageAdded.push(c.data);
  }
  if (usageAdded.length) await addStats(user.id, usageAdded);
  const pull = await changesSince(user.id, since, { maxCount: +body.limit || 400 });
  return json(res, 200, { ...pull, results });
}
/** Keep a small per-user summary of synced usage for the admin dashboard. */
async function addStats(uid, entries) {
  const file = dataPath('u', uid, 'stats.json'), st = await readJSONFile(file, { in: 0, out: 0, req: 0, months: {} });
  for (const e of entries) {
    const mo = new Date(+e.ts || Date.now()).toISOString().slice(0, 7), m = st.months[mo] ||= { in: 0, out: 0, req: 0 };
    for (const t of [st, m]) { t.in += +e.in || 0; t.out += +e.out || 0; t.req++; }
  }
  await writeJSONFile(file, st);
}
