#!/usr/bin/env node
/* AHB Broin server — zero dependencies (Node 18.17+).
   • Serves the PWA from ./public
   • /proxy/<provider>/…  AI providers with server-side keys (keys never reach the browser)
   • /relay               web reader + MCP servers, with private-network blocking
   • /api/…               accounts, sync, share links, scheduled tasks, push notifications
   Start:  node server.js      (reads .env if present) */
import './server/env.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { env, ROOT, DATA_DIR } from './server/env.js';
import { json, fail, clientIP, makeLimiter } from './server/http.js';
import { UPSTREAMS, configured } from './server/providers.js';
import { initAuth, authRoutes, authenticate, canProxy, overDailyLimit, accountsEnabled } from './server/auth.js';
import { syncRoute } from './server/sync.js';
import { shareRoutes } from './server/share.js';
import { initPush, pushRoutes } from './server/push.js';
import { initTasks, taskRoutes } from './server/tasks.js';

const PUBLIC = path.join(ROOT, 'public');
const PORT = +env.PORT || 8787;
const HOST = env.HOST || '0.0.0.0';
const APP_TOKEN = env.APP_TOKEN || '';
const MAX_BODY = (+env.MAX_BODY_MB || 50) * 1024 * 1024;
const ALLOW_ORIGINS = (env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const RELAY = env.RELAY !== '0';
const RELAY_ALLOW_PRIVATE = env.RELAY_ALLOW_PRIVATE === '1';
const RELAY_MAX = (+env.RELAY_MAX_MB || 10) * 1024 * 1024;
const rateLimited = makeLimiter(+env.RATE_LIMIT || 120);
const apiLimited = makeLimiter(+env.API_RATE_LIMIT || 300);

const FORWARD_REQ = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'http-referer', 'x-title'];
const FORWARD_RES = ['content-type', 'content-disposition', 'retry-after', 'x-request-id', 'request-id'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const CSP = ["default-src 'self'", "script-src 'self' https://cdnjs.cloudflare.com", "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com", "img-src 'self' data: blob: https:", "media-src 'self' data: blob: https:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* data: blob:", "worker-src 'self' blob:", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'self'", "frame-src 'self'", "frame-ancestors 'none'"].join('; ');
const SANDBOX_CSP = "sandbox allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";

function security(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=(self)');
}
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOW_ORIGINS.length) return;
  if (ALLOW_ORIGINS.includes('*') || ALLOW_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, x-nova-token, x-nova-session, anthropic-version, anthropic-beta, openai-beta, http-referer, x-title, x-relay-url, x-relay-authorization, mcp-session-id, mcp-protocol-version, last-event-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, content-type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
async function* limitedBody(req) {
  let n = 0;
  for await (const chunk of req) { n += chunk.length; if (n > MAX_BODY) throw new Error('Request body too large'); yield chunk; }
}

/* ---------- AI provider proxy ---------- */
async function proxy(req, res, url) {
  const [, , pid, ...rest] = url.pathname.split('/');
  const a = authenticate(req);
  if (pid === 'config') {
    if (!canProxy(a)) return fail(res, 401, accountsEnabled() ? 'Sign in to your AHB Broin server' : 'Invalid access token');
    return json(res, 200, { providers: configured, auth: !!APP_TOKEN, user: a.user ? { username: a.user.username, role: a.user.role } : null,
      features: { relay: RELAY, accounts: accountsEnabled(), sync: !!a.user, share: !!a.user, tasks: !!a.user, push: !!a.user } });
  }
  const up = UPSTREAMS[pid];
  if (!up) return fail(res, 404, `Unknown provider "${pid}"`);
  if (!up.key) return fail(res, 404, `No server key configured for ${pid}`);
  if (!canProxy(a)) return fail(res, 401, accountsEnabled() ? 'Sign in to your AHB Broin server' : 'Invalid access token');
  if (rateLimited(a.user?.id || clientIP(req))) return fail(res, 429, 'Too many requests — slow down a little');
  if (overDailyLimit(a.user)) return fail(res, 429, 'Daily request limit reached for your account — ask the admin to raise it');
  if (+req.headers['content-length'] > MAX_BODY) return fail(res, 413, 'Request body too large');

  const search = new URLSearchParams(url.search); search.delete('key');          // never accept client-supplied keys
  const target = `${up.base}/${rest.map(decodeURIComponent).map(encodeURIComponent).join('/').replace(/%3A/gi, ':')}${search.toString() ? '?' + search : ''}`;
  const headers = {};
  for (const h of FORWARD_REQ) if (req.headers[h]) headers[h] = req.headers[h];
  if (pid === 'anthropic' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  Object.assign(headers, up.auth(up.key));
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body: hasBody ? limitedBody(req) : undefined, duplex: hasBody ? 'half' : undefined, signal: ac.signal, redirect: 'follow' });
  } catch (e) {
    if (ac.signal.aborted) return;
    return fail(res, 502, `Upstream error: ${e.message}`);
  }
  const out = { 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
  for (const h of FORWARD_RES) { const v = upstream.headers.get(h); if (v) out[h] = v; }
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

/* ---------- Relay (web reader + MCP servers) with SSRF protection ---------- */
const BLOCK = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) BLOCK.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16]]) BLOCK.addSubnet(a, p, 'ipv6');
export function isPrivateIP(ip) {
  const v = net.isIP(ip); if (!v) return true;
  const mapped = /^::ffff:(?:([0-9.]+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(ip.toLowerCase());   // IPv4-mapped IPv6 in either form
  if (mapped) {
    const v4 = mapped[1] || [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join('.');
    return BLOCK.check(v4, 'ipv4');
  }
  return BLOCK.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}
async function checkTarget(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new Error('Credentials in URLs are not allowed');
  if (RELAY_ALLOW_PRIVATE) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error('Host not found'); });
  if (!addrs.length || addrs.some(x => isPrivateIP(x.address))) throw new Error('Blocked: private or local network address (set RELAY_ALLOW_PRIVATE=1 to allow)');
  return u;
}
const RELAY_REQ = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const RELAY_RES = ['content-type', 'mcp-session-id', 'content-disposition', 'retry-after'];
async function relay(req, res) {
  if (!RELAY) return fail(res, 404, 'Relay is disabled on this server');
  const a = authenticate(req);
  if (!canProxy(a)) return fail(res, 401, accountsEnabled() ? 'Sign in to your AHB Broin server' : 'Invalid access token');
  if (rateLimited(a.user?.id || clientIP(req))) return fail(res, 429, 'Too many requests');
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return fail(res, 405, 'Method not allowed');
  let target = String(req.headers['x-relay-url'] || '');
  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; AHBBroin/2; +https://github.com)' };
  for (const h of RELAY_REQ) if (req.headers[h]) headers[h] = req.headers[h];
  if (req.headers['x-relay-authorization']) headers.authorization = req.headers['x-relay-authorization'];
  let body;
  if (req.method === 'POST') {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX_BODY) return fail(res, 413, 'Body too large'); chunks.push(c); }
    body = Buffer.concat(chunks);
  }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let up;
  try {
    for (let hop = 0; ; hop++) {
      await checkTarget(target);
      up = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: ac.signal });
      if (up.status >= 300 && up.status < 400 && up.headers.get('location') && hop < 5 && req.method === 'GET') { target = new URL(up.headers.get('location'), target).href; continue; }
      break;
    }
  } catch (e) {
    if (ac.signal.aborted) return;
    return fail(res, /^(Blocked|Only|Invalid|Credentials)/.test(e.message) ? 400 : 502, e.message);
  }
  const out = { 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-relay-final-url': target };
  for (const h of RELAY_RES) { const v = up.headers.get(h); if (v) out[h] = v; }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  const streaming = (up.headers.get('content-type') || '').includes('event-stream');
  let sent = 0;
  const src = Readable.fromWeb(up.body);
  src.on('data', c => { sent += c.length; if (!streaming && sent > RELAY_MAX) { src.destroy(); res.end(); } });
  src.on('error', () => res.destroy()).pipe(res);
}

/* ---------- Static files ---------- */
async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (/^\/s\/[\w-]+\/?$/.test(rel)) rel = '/share.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'Forbidden');
  let target = file;
  try { if (!(await stat(target)).isFile()) throw 0; }
  catch { if (path.extname(rel)) return fail(res, 404, 'Not found'); target = path.join(PUBLIC, 'index.html'); }
  const ext = path.extname(target);
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  headers['cache-control'] = ext === '.html' || target.endsWith('sw.js') || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=3600';
  if (target.endsWith('sandbox.html')) headers['content-security-policy'] = SANDBOX_CSP;
  else if (ext === '.html') headers['content-security-policy'] = CSP;
  if (target.endsWith('share.html')) headers['x-robots-tag'] = 'noindex';
  const body = await readFile(target);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ---------- Router ---------- */
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  security(res); cors(req, res);
  res.on('finish', () => { if (p.startsWith('/proxy/') || p === '/relay' || p.startsWith('/api/')) console.log(`${new Date().toISOString()} ${req.method} ${p} ${res.statusCode} ${Date.now() - t0}ms`); });
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (p === '/healthz') return json(res, 200, { ok: true, providers: configured.length });
    if (p.startsWith('/proxy/')) return await proxy(req, res, url);
    if (p === '/relay') return await relay(req, res);
    if (p.startsWith('/api/')) {
      if (apiLimited(clientIP(req))) return fail(res, 429, 'Too many requests');
      if (p.startsWith('/api/auth/') || p.startsWith('/api/admin/')) return await authRoutes(req, res, url);
      if (p === '/api/sync') return await syncRoute(req, res);
      if (p.startsWith('/api/share')) return await shareRoutes(req, res, url);
      if (p.startsWith('/api/push/')) return await pushRoutes(req, res, url);
      if (p.startsWith('/api/tasks')) return await taskRoutes(req, res, url);
      return fail(res, 404, 'Not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
    return await serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Server error'); else res.destroy();
  }
});
server.requestTimeout = 0;      // long video jobs / streams
server.headersTimeout = 60_000;

await initAuth();
await initPush();
await initTasks();
server.listen(PORT, HOST, () => {
  console.log(`⚡ AHB Broin on http://localhost:${PORT}`);
  console.log(`   Data folder: ${DATA_DIR}`);
  console.log(`   Server keys: ${configured.join(', ') || 'none (users can still enter keys in the browser)'}`);
  console.log(`   Accounts: ${accountsEnabled() ? 'on' : 'off — open the app → Settings → Account to create the admin'}`);
  if (!APP_TOKEN && !accountsEnabled() && configured.length) console.warn('   ⚠️  No APP_TOKEN and no accounts — anyone who can reach this server can spend your API credits.');
});
