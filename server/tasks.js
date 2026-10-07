/* Scheduled tasks that run on the server (so they work when your phone is off).
   Each run calls the AI with the server's key (optionally after a Tavily web search),
   saves the result as a chat in the user's synced data, and sends a push notification. */
import { json, fail, readJSON } from './http.js';
import { requireUser, allUserIds, userById } from './auth.js';
import { dataPath, readJSONFile, writeJSONFile, newId, putRecord } from './db.js';
import { complete, webSearch, chatProviders, UPSTREAMS } from './providers.js';
import { notifyUser } from './push.js';
import { nextRun, validTz } from '../public/js/schedule.js';

const file = uid => dataPath('u', uid, 'tasks.json');
const running = new Set();
const MAX_TASKS = 50;
let tasksByUser = new Map();

export async function initTasks() {
  for (const uid of allUserIds()) tasksByUser.set(uid, await readJSONFile(file(uid), []));
  // catch up on runs missed while the server was down (within 12 h), otherwise skip ahead
  const now = Date.now();
  for (const [uid, list] of tasksByUser) {
    let changed = false;
    for (const t of list) if (t.enabled && t.nextRun && t.nextRun < now - 12 * 3600e3) { t.nextRun = nextRun(t.schedule, t.tz, now); changed = true; }
    if (changed) await save(uid);
  }
  setInterval(tick, 20_000).unref();
  setTimeout(tick, 3000).unref();
}
const list = uid => { if (!tasksByUser.has(uid)) tasksByUser.set(uid, []); return tasksByUser.get(uid); };
const save = uid => writeJSONFile(file(uid), list(uid));

async function tick() {
  const now = Date.now();
  for (const [uid, tasks] of tasksByUser) for (const t of tasks) {
    if (t.enabled && t.nextRun && t.nextRun <= now && !running.has(t.id)) runTask(uid, t).catch(e => console.error('task failed', e));
  }
}
function validate(b) {
  const t = {
    name: String(b.name || '').trim().slice(0, 80) || 'Task',
    prompt: String(b.prompt || '').trim().slice(0, 8000),
    schedule: { type: ['daily', 'weekly', 'hourly', 'once'].includes(b.schedule?.type) ? b.schedule.type : 'daily', time: /^\d{1,2}:\d{2}$/.test(b.schedule?.time) ? b.schedule.time : '08:00', days: (b.schedule?.days || []).map(Number).filter(d => d >= 0 && d <= 6), minute: +b.schedule?.minute || 0, at: b.schedule?.at || '' },
    tz: validTz(b.tz) ? b.tz : 'UTC',
    provider: String(b.provider || ''), model: String(b.model || '').slice(0, 120),
    webSearch: !!b.webSearch, notify: b.notify !== false, enabled: b.enabled !== false, projectId: String(b.projectId || '').slice(0, 40),
  };
  if (!t.prompt) throw Object.assign(new Error('The task needs a prompt'), { status: 400 });
  if (!chatProviders().includes(t.provider)) throw Object.assign(new Error(`The server has no key for “${t.provider}”. Available: ${chatProviders().join(', ') || 'none'}`), { status: 400 });
  if (!t.model) throw Object.assign(new Error('Choose a model'), { status: 400 });
  return t;
}

export async function runTask(uid, t) {
  running.add(t.id);
  const started = Date.now();
  let text = '', usage = null, error = '', sources = [];
  try {
    const when = new Date().toLocaleString('en-GB', { timeZone: t.tz, dateStyle: 'full', timeStyle: 'short' });
    let prompt = t.prompt;
    if (t.webSearch && UPSTREAMS.tavily.key) {
      const r = await webSearch(t.prompt, /news|today|latest|berita|terkini/i.test(t.prompt) ? 'news' : 'general').catch(e => ({ error: e.message }));
      if (r?.results?.length) {
        sources = r.results.map((x, i) => ({ n: i + 1, doc: x.title || x.url, page: '', url: x.url }));
        prompt += `\n\n---\nWeb search results (retrieved ${when}):\n${r.answer ? 'Summary: ' + r.answer + '\n' : ''}${r.results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${(x.content || '').slice(0, 900)}`).join('\n\n')}\n---\nCite sources as [n] with their URLs.`;
      }
    }
    const out = await complete({ provider: t.provider, model: t.model, prompt,
      system: `You are Nova, running a scheduled task for the user called “${t.name}”. Current date and time: ${when} (${t.tz}). Do the task now and write a clear, well-formatted Markdown result. Do not ask questions back.` });
    text = out.text || '_(empty response)_'; usage = out.usage;
  } catch (e) { error = e.message; }
  const ts = Date.now(), cid = `task-${t.id}-${ts.toString(36)}`;
  const convo = {
    id: cid, title: `⏰ ${t.name} — ${new Date(ts).toLocaleDateString('en-GB', { timeZone: t.tz, day: 'numeric', month: 'short' })}`, updated: ts, projectId: t.projectId || '', scheduled: t.id,
    messages: [
      { id: cid + '-u', role: 'user', text: t.prompt, atts: [], mode: 'chat', ts: started },
      { id: cid + '-a', role: 'assistant', text, error: error || undefined, media: [], mode: 'chat', ts, meta: `${t.provider} · ${t.model} · scheduled`, sources: sources.length ? sources.map(s => ({ ...s, text: s.url })) : undefined,
        usage: usage ? { id: cid + '-usage', ts, provider: t.provider, model: t.model, kind: 'chat', in: usage.in, out: usage.out, est: false } : undefined },
    ],
  };
  await putRecord(uid, 'convos', { id: cid, updated: ts, data: convo });
  if (usage) await putRecord(uid, 'usage', { id: cid + '-usage', updated: ts, data: { id: cid + '-usage', ts, provider: t.provider, model: t.model, kind: 'chat', in: usage.in, out: usage.out, reasoning: 0, cached: 0, units: 0, est: false, tag: 'task' } });
  t.lastRun = ts; t.lastStatus = error ? 'error' : 'ok'; t.lastError = error.slice(0, 300); t.lastConvo = cid; t.runs = (t.runs || 0) + 1;
  t.nextRun = t.schedule.type === 'once' ? null : nextRun(t.schedule, t.tz, ts);
  if (t.schedule.type === 'once') t.enabled = false;
  await save(uid);
  running.delete(t.id);
  if (t.notify) notifyUser(uid, { title: error ? `⚠️ ${t.name} failed` : `⏰ ${t.name}`, body: error ? error.slice(0, 120) : text.replace(/[#*_`>]/g, '').slice(0, 140), url: `./?chat=${encodeURIComponent(cid)}`, tag: t.id }).catch(() => {});
  return { convoId: cid, error };
}

export async function taskRoutes(req, res, url) {
  const user = requireUser(req, res); if (!user) return;
  const tasks = list(user.id), m = /^\/api\/tasks(?:\/([\w-]+)(\/run)?)?$/.exec(url.pathname);
  if (!m) return fail(res, 404, 'Not found');
  const [, id, run] = m;
  if (!id && req.method === 'GET') return json(res, 200, { tasks, providers: chatProviders(), webSearch: !!UPSTREAMS.tavily.key });
  if (!id && req.method === 'POST') {
    if (tasks.length >= MAX_TASKS) return fail(res, 400, `Limit of ${MAX_TASKS} tasks`);
    const t = { id: newId(8), created: Date.now(), runs: 0, ...validate(await readJSON(req)) };
    t.nextRun = t.enabled ? nextRun(t.schedule, t.tz) : null;
    tasks.push(t); await save(user.id);
    return json(res, 200, { task: t });
  }
  const t = tasks.find(x => x.id === id); if (!t) return fail(res, 404, 'No such task');
  if (run && req.method === 'POST') {
    if (running.has(t.id)) return fail(res, 409, 'Already running');
    const r = await runTask(user.id, t);
    return json(res, 200, { ...r, task: t });
  }
  if (req.method === 'PATCH') {
    Object.assign(t, validate({ ...t, ...(await readJSON(req)) }));
    t.nextRun = t.enabled ? nextRun(t.schedule, t.tz) : null;
    await save(user.id); return json(res, 200, { task: t });
  }
  if (req.method === 'DELETE') { tasksByUser.set(user.id, tasks.filter(x => x !== t)); await save(user.id); return json(res, 200, { ok: true }); }
  return fail(res, 405, 'Method not allowed');
}
export { userById };
