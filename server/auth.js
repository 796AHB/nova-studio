/* Accounts & sessions: scrypt-hashed passwords, random session tokens (stored hashed),
   admin user management, optional sign-up, per-user daily request limits. */
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { env } from './env.js';
import { dataPath, readJSONFile, writeJSONFile, newId, deleteUserData, storeStats } from './db.js';
import { json, fail, readJSON, clientIP, makeLimiter } from './http.js';

const APP_TOKEN = env.APP_TOKEN || '';
const ALLOW_SIGNUP = env.ALLOW_SIGNUP === '1';
const SESSION_DAYS = +env.SESSION_DAYS || 30;
const USER_DAILY_LIMIT = +env.USER_DAILY_LIMIT || 0;
const USERS = dataPath('users.json'), SESSIONS = dataPath('sessions.json');
let users = [], sessions = {};
const loginLimiter = makeLimiter(10, 5 * 60_000);

const sha = s => createHash('sha256').update(s).digest('hex');
function hashPassword(pw, salt = randomBytes(16).toString('base64')) {
  return { salt, hash: scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64') };
}
function checkPassword(pw, u) {
  const h = scryptSync(String(pw), u.salt, 64, { N: 16384, r: 8, p: 1 }), k = Buffer.from(u.hash, 'base64');
  return h.length === k.length && timingSafeEqual(h, k);
}
const pub = u => u && ({ id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, dailyLimit: u.dailyLimit || 0, created: u.created, lastLogin: u.lastLogin || 0 });
const saveUsers = () => writeJSONFile(USERS, { users });
const saveSessions = () => writeJSONFile(SESSIONS, sessions);
const validName = n => /^[a-zA-Z0-9_.@-]{3,40}$/.test(n || '');

export async function initAuth() {
  users = (await readJSONFile(USERS, { users: [] })).users;
  sessions = await readJSONFile(SESSIONS, {});
  if (env.ADMIN_USER && env.ADMIN_PASSWORD && !users.some(u => u.username.toLowerCase() === env.ADMIN_USER.toLowerCase())) {
    users.push({ id: newId(9), username: env.ADMIN_USER, role: 'admin', created: Date.now(), ...hashPassword(env.ADMIN_PASSWORD) });
    await saveUsers();
    console.log(`   Created admin account "${env.ADMIN_USER}"`);
  }
  const now = Date.now(); let changed = false;
  for (const [k, s] of Object.entries(sessions)) if (s.expires < now) { delete sessions[k]; changed = true; }
  if (changed) await saveSessions();
  setInterval(() => { const n = Date.now(); let c = false; for (const [k, s] of Object.entries(sessions)) if (s.expires < n) { delete sessions[k]; c = true; } if (c) saveSessions(); }, 3600_000).unref();
}
export const accountsEnabled = () => users.length > 0;
const OWNER = { id: 'owner', username: 'owner', role: 'admin' };

/** Who is calling? → { user, via: 'session'|'token'|'open'|null } */
export function authenticate(req) {
  const st = req.headers['x-nova-session'];
  if (st) {
    const s = sessions[sha(String(st))], u = s && s.expires > Date.now() && users.find(x => x.id === s.userId && !x.disabled);
    if (u) { if (s.expires - Date.now() < (SESSION_DAYS - 1) * 864e5) { s.expires = Date.now() + SESSION_DAYS * 864e5; saveSessions(); } return { user: u, via: 'session' }; }
  }
  if (APP_TOKEN) {
    const a = Buffer.from(String(req.headers['x-nova-token'] || '')), b = Buffer.from(APP_TOKEN);
    if (a.length === b.length && timingSafeEqual(a, b)) return { user: accountsEnabled() ? null : OWNER, via: 'token' };
  }
  if (!APP_TOKEN && !accountsEnabled()) return { user: null, via: 'open' };
  return { user: null, via: null };
}
/** May this caller use the AI proxy / relay? */
export const canProxy = a => !!(a.user || a.via === 'token' || a.via === 'open');

/* ---------- Per-user daily request limits ---------- */
const counters = new Map();
export function overDailyLimit(user) {
  if (!user) return false;
  const day = new Date().toISOString().slice(0, 10);
  let c = counters.get(user.id);
  if (!c || c.day !== day) { c = { day, n: 0 }; counters.set(user.id, c); }
  c.n++;
  const limit = user.role === 'admin' ? 0 : (user.dailyLimit || USER_DAILY_LIMIT);
  return !!limit && c.n > limit;
}
export const requestsToday = uid => { const c = counters.get(uid); return c && c.day === new Date().toISOString().slice(0, 10) ? c.n : 0; };

async function createSession(u, req) {
  const token = randomBytes(32).toString('base64url');
  sessions[sha(token)] = { userId: u.id, created: Date.now(), expires: Date.now() + SESSION_DAYS * 864e5, ua: String(req.headers['user-agent'] || '').slice(0, 120) };
  u.lastLogin = Date.now();
  await Promise.all([saveSessions(), saveUsers()]);
  return token;
}

/* ---------- Routes: /api/auth/* and /api/admin/* ---------- */
export async function authRoutes(req, res, url) {
  const p = url.pathname, m = req.method, a = authenticate(req);
  if (p === '/api/auth/status' && m === 'GET') return json(res, 200, { accounts: accountsEnabled(), signup: ALLOW_SIGNUP, setup: !accountsEnabled(), user: pub(a.user), via: a.via });
  if (p === '/api/auth/login' && m === 'POST') {
    if (loginLimiter(clientIP(req))) return fail(res, 429, 'Too many attempts — wait a few minutes');
    const { username, password } = await readJSON(req);
    const u = users.find(x => x.username.toLowerCase() === String(username || '').toLowerCase());
    if (!u || !checkPassword(password, u)) return fail(res, 401, 'Wrong username or password');
    if (u.disabled) return fail(res, 403, 'This account is disabled');
    return json(res, 200, { token: await createSession(u, req), user: pub(u) });
  }
  if ((p === '/api/auth/setup' || p === '/api/auth/signup') && m === 'POST') {
    const setup = p.endsWith('setup');
    if (setup && accountsEnabled()) return fail(res, 409, 'Setup is already done — sign in instead');
    if (setup && APP_TOKEN && a.via !== 'token') return fail(res, 401, 'Enter the server access token (APP_TOKEN) to create the first admin');
    if (!setup && !ALLOW_SIGNUP) return fail(res, 403, 'Sign-up is closed — ask the admin for an account');
    if (loginLimiter(clientIP(req))) return fail(res, 429, 'Too many attempts — wait a few minutes');
    const { username, password } = await readJSON(req);
    if (!validName(username)) return fail(res, 400, 'Username: 3–40 letters, numbers, . _ - @');
    if (String(password || '').length < 8) return fail(res, 400, 'Password must be at least 8 characters');
    if (users.some(x => x.username.toLowerCase() === username.toLowerCase())) return fail(res, 409, 'That username is taken');
    const u = { id: newId(9), username, role: setup ? 'admin' : 'user', created: Date.now(), ...hashPassword(password) };
    users.push(u); await saveUsers();
    return json(res, 200, { token: await createSession(u, req), user: pub(u) });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    const st = req.headers['x-nova-session']; if (st) { delete sessions[sha(String(st))]; await saveSessions(); }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth/password' && m === 'POST') {
    if (!a.user || a.via !== 'session') return fail(res, 401, 'Sign in first');
    const { oldPassword, newPassword } = await readJSON(req);
    if (!checkPassword(oldPassword, a.user)) return fail(res, 401, 'Current password is wrong');
    if (String(newPassword || '').length < 8) return fail(res, 400, 'Password must be at least 8 characters');
    Object.assign(a.user, hashPassword(newPassword));
    for (const [k, s] of Object.entries(sessions)) if (s.userId === a.user.id && k !== sha(String(req.headers['x-nova-session']))) delete sessions[k];
    await Promise.all([saveUsers(), saveSessions()]);
    return json(res, 200, { ok: true });
  }
  if (p.startsWith('/api/admin/')) {
    if (a.user?.role !== 'admin' || a.user === OWNER) return fail(res, 403, 'Admins only');
    if (p === '/api/admin/users' && m === 'GET') {
      const list = await Promise.all(users.map(async u => ({ ...pub(u), today: requestsToday(u.id), storage: await storeStats(u.id), stats: await readJSONFile(dataPath('u', u.id, 'stats.json'), {}) })));
      return json(res, 200, { users: list });
    }
    if (p === '/api/admin/users' && m === 'POST') {
      const { username, password, role } = await readJSON(req);
      if (!validName(username)) return fail(res, 400, 'Username: 3–40 letters, numbers, . _ - @');
      if (String(password || '').length < 8) return fail(res, 400, 'Password must be at least 8 characters');
      if (users.some(x => x.username.toLowerCase() === username.toLowerCase())) return fail(res, 409, 'That username is taken');
      const u = { id: newId(9), username, role: role === 'admin' ? 'admin' : 'user', created: Date.now(), ...hashPassword(password) };
      users.push(u); await saveUsers();
      return json(res, 200, { user: pub(u) });
    }
    const mm = /^\/api\/admin\/users\/([\w-]+)$/.exec(p);
    if (mm) {
      const u = users.find(x => x.id === mm[1]); if (!u) return fail(res, 404, 'No such user');
      if (m === 'PATCH') {
        const b = await readJSON(req);
        if (u.id === a.user.id && (b.disabled || b.role === 'user')) return fail(res, 400, "You can't disable or demote yourself");
        if ('disabled' in b) u.disabled = !!b.disabled;
        if (b.role === 'admin' || b.role === 'user') u.role = b.role;
        if ('dailyLimit' in b) u.dailyLimit = Math.max(0, +b.dailyLimit || 0);
        if (b.password) { if (String(b.password).length < 8) return fail(res, 400, 'Password must be at least 8 characters'); Object.assign(u, hashPassword(b.password)); }
        if (b.disabled || b.password) for (const [k, s] of Object.entries(sessions)) if (s.userId === u.id) delete sessions[k];
        await Promise.all([saveUsers(), saveSessions()]);
        return json(res, 200, { user: pub(u) });
      }
      if (m === 'DELETE') {
        if (u.id === a.user.id) return fail(res, 400, "You can't delete yourself");
        users = users.filter(x => x !== u);
        for (const [k, s] of Object.entries(sessions)) if (s.userId === u.id) delete sessions[k];
        await Promise.all([saveUsers(), saveSessions(), deleteUserData(u.id)]);
        return json(res, 200, { ok: true });
      }
    }
  }
  return fail(res, 404, 'Not found');
}
/** Resolve the user for per-user features (sync, share, tasks, push) or send 401. */
export function requireUser(req, res) {
  const a = authenticate(req);
  if (a.user) return a.user;
  fail(res, 401, accountsEnabled() ? 'Sign in to your AHB Broin server' : 'Set APP_TOKEN or create an account on the server to use this feature');
  return null;
}
export const allUserIds = () => [...users.map(u => u.id), ...(accountsEnabled() ? [] : ['owner'])];
export const userById = id => id === 'owner' ? OWNER : users.find(u => u.id === id);
