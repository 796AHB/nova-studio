/* Read-only share links for chats: /s/<id>. Links are long random IDs; owners can revoke them. */
import { json, fail, readJSON } from './http.js';
import { requireUser } from './auth.js';
import { dataPath, readJSONFile, writeJSONFile, removeFile, newId } from './db.js';

const MAX = 25 * 1024 * 1024;
const clean = s => String(s ?? '').slice(0, 200000);
export async function shareRoutes(req, res, url) {
  const m = /^\/api\/share(?:\/([\w-]+))?$/.exec(url.pathname);
  if (url.pathname === '/api/shares' && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return;
    return json(res, 200, { shares: await readJSONFile(dataPath('u', user.id, 'shares.json'), []) });
  }
  if (!m) return fail(res, 404, 'Not found');
  const id = m[1];
  if (!id && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return;
    const b = await readJSON(req, MAX);
    const messages = (Array.isArray(b.messages) ? b.messages : []).slice(0, 500).map(x => ({
      role: x.role === 'user' ? 'user' : 'assistant', text: clean(x.text), meta: clean(x.meta).slice(0, 200), ts: +x.ts || 0,
      media: (Array.isArray(x.media) ? x.media : []).filter(y => /^data:image\/(png|jpe?g|webp|gif);base64,/.test(y.src || '') && y.src.length < 4e6).slice(0, 8).map(y => ({ kind: 'image', src: y.src })),
      sources: (Array.isArray(x.sources) ? x.sources : []).slice(0, 20).map(s => ({ n: +s.n, doc: clean(s.doc).slice(0, 200), page: clean(s.page).slice(0, 40) })),
    }));
    if (!messages.length) return fail(res, 400, 'Nothing to share');
    const sid = newId(18), share = { id: sid, title: clean(b.title).slice(0, 120) || 'Shared chat', owner: user.id, created: Date.now(), messages };
    await writeJSONFile(dataPath('shares', sid + '.json'), share);
    const list = await readJSONFile(dataPath('u', user.id, 'shares.json'), []);
    list.unshift({ id: sid, title: share.title, created: share.created, count: messages.length });
    await writeJSONFile(dataPath('u', user.id, 'shares.json'), list);
    return json(res, 200, { id: sid, path: `/s/${sid}` });
  }
  if (id && req.method === 'GET') {
    const s = await readJSONFile(dataPath('shares', id + '.json'), null);
    if (!s) return fail(res, 404, 'This share link was removed or never existed');
    const { owner, ...pubShare } = s;
    return json(res, 200, pubShare, { 'x-robots-tag': 'noindex' });
  }
  if (id && req.method === 'DELETE') {
    const user = requireUser(req, res); if (!user) return;
    const s = await readJSONFile(dataPath('shares', id + '.json'), null);
    if (!s || (s.owner !== user.id && user.role !== 'admin')) return fail(res, 404, 'Not found');
    await removeFile(dataPath('shares', id + '.json'));
    const list = (await readJSONFile(dataPath('u', s.owner, 'shares.json'), [])).filter(x => x.id !== id);
    await writeJSONFile(dataPath('u', s.owner, 'shares.json'), list);
    return json(res, 200, { ok: true });
  }
  return fail(res, 405, 'Method not allowed');
}
