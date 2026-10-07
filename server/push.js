/* Web Push (RFC 8030/8291/8292) with zero dependencies: VAPID signing (ES256) + aes128gcm payload encryption. */
import { generateKeyPairSync, createPrivateKey, createECDH, randomBytes, hkdfSync, createCipheriv, sign } from 'node:crypto';
import { env } from './env.js';
import { json, fail, readJSON } from './http.js';
import { requireUser } from './auth.js';
import { dataPath, readJSONFile, writeJSONFile } from './db.js';

let vapid = null;
const b64u = b => Buffer.from(b).toString('base64url');
export async function initPush() {
  vapid = await readJSONFile(dataPath('vapid.json'), null);
  if (!vapid) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    vapid = { privateJwk: privateKey.export({ format: 'jwk' }), publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])) };
    await writeJSONFile(dataPath('vapid.json'), vapid);
  }
}
export const vapidPublicKey = () => vapid?.publicKey;

function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@nova.local' }));
  const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: createPrivateKey({ key: vapid.privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${vapid.publicKey}`;
}
/** Encrypt a payload for a subscription (RFC 8291, aes128gcm). Exported for tests. */
export function encrypt(sub, plaintext) {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url'), authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = createECDH('prime256v1'), asPublic = ecdh.generateKeys(), shared = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}
const subsFile = uid => dataPath('u', uid, 'push.json');
/** Send a notification to every device of a user. Dead subscriptions are removed. */
export async function notifyUser(uid, data) {
  if (!vapid) return 0;
  const subs = await readJSONFile(subsFile(uid), []); if (!subs.length) return 0;
  let sent = 0; const keep = [];
  await Promise.all(subs.map(async s => {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(s.endpoint) }, body: encrypt(s, JSON.stringify(data)), signal: AbortSignal.timeout(15000) });
      if (r.status === 404 || r.status === 410) return;
      keep.push(s); if (r.ok) sent++;
    } catch { keep.push(s); }
  }));
  if (keep.length !== subs.length) await writeJSONFile(subsFile(uid), keep);
  return sent;
}
export async function pushRoutes(req, res, url) {
  if (url.pathname === '/api/push/key') return json(res, 200, { publicKey: vapidPublicKey() });
  const user = requireUser(req, res); if (!user) return;
  if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
    const { subscription } = await readJSON(req);
    if (!/^https:\/\//.test(subscription?.endpoint || '') || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return fail(res, 400, 'Invalid subscription');
    const subs = (await readJSONFile(subsFile(user.id), [])).filter(s => s.endpoint !== subscription.endpoint);
    subs.push({ endpoint: subscription.endpoint, keys: subscription.keys, added: Date.now() });
    await writeJSONFile(subsFile(user.id), subs.slice(-10));
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const { endpoint } = await readJSON(req);
    await writeJSONFile(subsFile(user.id), (await readJSONFile(subsFile(user.id), [])).filter(s => s.endpoint !== endpoint));
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/push/test' && req.method === 'POST') return json(res, 200, { sent: await notifyUser(user.id, { title: '🔔 Nova Studio', body: 'Notifications are working.', url: './' }) });
  return fail(res, 404, 'Not found');
}
