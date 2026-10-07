/* Small HTTP helpers shared by the server modules. */
export function json(res, status, obj, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
export const fail = (res, status, message) => json(res, status, { error: { message } });
export const clientIP = req => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '?';

/** Read and parse a JSON body with a size limit. */
export async function readJSON(req, maxBytes = 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > maxBytes) { const e = new Error('Request body too large'); e.status = 413; throw e; } chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const e = new Error('Invalid JSON'); e.status = 400; throw e; }
}

/** Sliding-window rate limiter: limiter(key) → true when over the limit. */
export function makeLimiter(perWindow, windowMs = 60_000) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, w] of hits) if (!w.some(t => now - t < windowMs)) hits.delete(k); }, windowMs).unref();
  return key => {
    const now = Date.now(), w = (hits.get(key) || []).filter(t => now - t < windowMs);
    w.push(now); hits.set(key, w);
    return w.length > perWindow;
  };
}
