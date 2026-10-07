/* Key vault: encrypts API keys and tokens with a PIN/passphrase (PBKDF2-SHA256 → AES-GCM-256).
   When the vault is on, secrets are never written to storage in plain text and the app asks for the
   PIN on start. The PIN itself is never stored. */
import { S, LS, saveSettings, setSaveFilter } from './store.js';
import { $, esc, toast } from './util.js';
import { log } from './logs.js';

const KEY = 'nova.vault', ITER = 310000;
let cryptoKey = null, salt = null, idleTimer = null;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export const vaultOn = () => !!LS.get(KEY, null);
export const unlocked = () => !!cryptoKey;

function secretsOf(s) {
  return { keys: s.keys || {}, proxyToken: s.proxy?.token || '', session: s.account?.token || '', cfg: s.connectors?.cfg || {}, mcp: Object.fromEntries((s.connectors?.mcp || []).map(m => [m.id, m.auth || ''])) };
}
function applySecrets(sec) {
  S.keys = { ...(sec.keys || {}) };
  S.proxy.token = sec.proxyToken || '';
  if (S.account) S.account.token = sec.session || '';
  S.connectors.cfg = { ...S.connectors.cfg, ...(sec.cfg || {}) };
  for (const m of S.connectors.mcp) if (sec.mcp?.[m.id] != null) m.auth = sec.mcp[m.id];
}
/** Copy of settings with secrets removed (what gets written to localStorage while the vault is on). */
function stripped(s) {
  const c = structuredClone(s);
  c.keys = {}; c.proxy = { ...c.proxy, token: '' }; if (c.account) c.account = { ...c.account, token: '' }; c.connectors = { ...c.connectors, cfg: {}, mcp: c.connectors.mcp.map(m => ({ ...m, auth: '' })) };
  return c;
}
async function derive(pin, saltBytes) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: saltBytes, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal() {
  if (!cryptoKey) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(JSON.stringify(secretsOf(S))));
  LS.set(KEY, { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct), iter: ITER });
}
function installFilter() {
  setSaveFilter(s => { seal(); return stripped(s); });
}

export async function enableVault(pin) {
  if (!crypto.subtle) throw new Error('Encryption needs HTTPS (or localhost).');
  if (String(pin).length < 4) throw new Error('Use at least 4 characters.');
  salt = crypto.getRandomValues(new Uint8Array(16));
  cryptoKey = await derive(pin, salt);
  installFilter();
  await seal(); saveSettings();
  log('info', 'Key vault enabled');
}
export async function disableVault() {
  if (!cryptoKey) throw new Error('Unlock first');
  setSaveFilter(null); LS.set(KEY, null); localStorage.removeItem(KEY);
  cryptoKey = null; salt = null; saveSettings();
  log('info', 'Key vault disabled');
}
export async function changePin(pin) { await enableVault(pin); }
async function tryUnlock(pin) {
  const v = LS.get(KEY, null); if (!v) return true;
  const s = unb64(v.salt), k = await derive(pin, s);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, k, unb64(v.ct));
    cryptoKey = k; salt = s; applySecrets(JSON.parse(dec.decode(pt))); installFilter();
    return true;
  } catch { return false; }
}
export function lockNow() { cryptoKey = null; sessionStorage.clear(); location.reload(); }

/** Resets the auto-lock timer on activity. */
export function armAutoLock() {
  const mins = +S.vaultAutoLock || 0;
  clearTimeout(idleTimer);
  if (!mins || !vaultOn()) return;
  idleTimer = setTimeout(lockNow, mins * 60000);
}

/** Show the lock screen until the user unlocks (or resets). Resolves when the app may continue. */
export function unlockScreen() {
  if (!vaultOn()) return Promise.resolve();
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.id = 'lockscreen';
    el.innerHTML = `<form class="lockbox" autocomplete="off"><div class="logo">🔒</div><h1>Nova Studio is locked</h1><p class="hint">Enter your PIN or passphrase to unlock your API keys.</p>
      <input id="lk-pin" type="password" inputmode="text" placeholder="PIN or passphrase" aria-label="PIN or passphrase" autofocus>
      <button class="btn primary" id="lk-go">Unlock</button><p class="lk-err" id="lk-err"></p>
      <button type="button" class="btn ghost sm" id="lk-reset">Forgot PIN? Reset saved keys</button></form>`;
    document.body.append(el);
    const pinEl = $('#lk-pin', el);
    setTimeout(() => pinEl.focus(), 50);
    let fails = 0;
    $('form', el).onsubmit = async e => {
      e.preventDefault();
      const b = $('#lk-go', el); b.disabled = true; b.textContent = 'Unlocking…';
      if (await tryUnlock(pinEl.value)) { el.remove(); log('info', 'Vault unlocked'); resolve(); return; }
      fails++; log('warn', 'Wrong vault PIN');
      $('#lk-err', el).textContent = fails >= 5 ? 'Wrong PIN. Wait a moment before trying again.' : 'Wrong PIN — try again.';
      pinEl.value = ''; pinEl.focus();
      setTimeout(() => { b.disabled = false; b.textContent = 'Unlock'; }, fails >= 5 ? 10000 : 400);
    };
    $('#lk-reset', el).onclick = () => {
      if (!confirm('This deletes your saved API keys and tokens on this device (chats are kept). You will need to enter keys again. Continue?')) return;
      localStorage.removeItem(KEY); el.remove(); toast('Vault reset — add your keys again in Settings'); resolve();
    };
  });
}

export function vaultSettingsHTML() {
  return `<h3>🔒 Key vault</h3>
    <p class="hint">Encrypt your API keys and tokens on this device with a PIN or passphrase. You'll enter it each time the app opens. There is no way to recover a forgotten PIN — you'd re-enter your keys.</p>
    ${vaultOn() ? `<p>✅ Vault is <b>on</b>.</p>
      <div class="grid2"><label>Auto-lock after inactivity<select id="vt-auto">${[[0, 'Never'], [5, '5 minutes'], [15, '15 minutes'], [60, '1 hour']].map(([v, l]) => `<option value="${v}" ${+S.vaultAutoLock === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <div class="inrow wrap" style="margin-top:10px"><button class="btn sm" id="vt-lock">🔒 Lock now</button><button class="btn sm" id="vt-change">Change PIN</button><button class="btn sm danger" id="vt-off">Turn off</button></div>`
    : `<div class="inrow"><input id="vt-pin" type="password" placeholder="New PIN or passphrase (min 4)" autocomplete="new-password"><input id="vt-pin2" type="password" placeholder="Repeat" autocomplete="new-password"></div><button class="btn sm" id="vt-on" style="margin-top:8px">Turn on vault</button>`}`;
}
export function bindVaultSettings(rerender) {
  const on = $('#vt-on'), off = $('#vt-off'), lock = $('#vt-lock'), change = $('#vt-change'), auto = $('#vt-auto');
  if (on) on.onclick = async () => {
    const a = $('#vt-pin').value, b = $('#vt-pin2').value;
    if (a !== b) return toast('PINs do not match');
    try { await enableVault(a); toast('🔒 Vault on — keys are encrypted'); rerender(); } catch (e) { toast(e.message); }
  };
  if (off) off.onclick = async () => { if (confirm('Store keys without encryption again?')) { await disableVault(); toast('Vault off'); rerender(); } };
  if (lock) lock.onclick = lockNow;
  if (change) change.onclick = async () => {
    const a = prompt('New PIN or passphrase (min 4 characters)'); if (!a) return;
    if (prompt('Repeat the new PIN') !== a) return toast('PINs do not match');
    try { await changePin(a); toast('PIN changed'); } catch (e) { toast(e.message); }
  };
  if (auto) auto.onchange = () => { S.vaultAutoLock = +auto.value; saveSettings(); armAutoLock(); };
}
export { esc };
