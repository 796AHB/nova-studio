/* Account on your AHB Broin server: sign in / create admin / sign up, password change, admin user management,
   push notifications. Works together with sync.js. */
import { S, saveSettings } from './store.js';
import { $, $$, esc, toast, openModal, fmtNum, fmtBytes, fmtDate } from './util.js';
import { log } from './logs.js';

let net = null;  // { root(), headers(), reloadConfig(), onSignedIn(), onSignedOut(), syncStatusHTML(), syncNow(), setSyncEnabled(on) }
export function initAccount(n) { net = n; }
export const signedIn = () => !!S.account?.token;

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(net.root() + path, { method, headers: { ...net.headers(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 401 && signedIn() && path !== '/api/auth/login') { log('warn', 'Session expired'); }
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `Server error ${r.status}`), { status: r.status });
  return j;
}

/* ---------- Settings → Account tab ---------- */
export function accountTabHTML() {
  if (signedIn()) {
    const a = S.account;
    return `<div class="card-box"><p>👤 Signed in as <b>${esc(a.username)}</b> ${a.role === 'admin' ? '<span class="badge ok">admin</span>' : ''}<br><small class="hint">${esc(net.root())}</small></p>
      <div class="inrow wrap"><button class="btn sm" id="ac-out">Sign out</button><button class="btn sm" id="ac-pw">Change password</button>${a.role === 'admin' ? '<button class="btn sm" id="ac-users">👥 Manage users</button>' : ''}<button class="btn sm" id="ac-shares">🔗 My shared links</button></div></div>
      <h3>🔄 Sync across devices</h3>
      <label class="check"><input type="checkbox" id="ac-sync" ${S.sync.enabled ? 'checked' : ''}> Sync chats, projects, knowledge bases, skills, notes, usage and settings</label>
      <p class="hint">API keys are never synced. Sign in with the same account on your phone and laptop.</p>
      <div class="inrow wrap"><button class="btn sm" id="ac-syncnow">↻ Sync now</button><span class="hint" id="ac-syncst">${net.syncStatusHTML()}</span></div>
      <h3>🔔 Notifications</h3>
      <p class="hint">Get notified on this device when a scheduled task finishes — even when the app is closed.</p>
      <div class="inrow wrap"><button class="btn sm" id="ac-push">${pushState() === 'on' ? '✓ Notifications on' : '🔔 Enable on this device'}</button>${pushState() === 'on' ? '<button class="btn sm" id="ac-pushtest">Send test</button><button class="btn sm" id="ac-pushoff">Turn off</button>' : ''}</div>`;
  }
  return `<p class="hint">Sign in to your <b>AHB Broin server</b> to sync across devices, share chat links, run scheduled tasks and get notifications. Your server runs <code>server.js</code> from this project.</p>
    <label>Server URL<input id="ac-url" value="${esc(S.proxy.url)}" placeholder="${esc(new URL('.', location.href).href)} (this site)"></label>
    <div id="ac-status" class="hint">Checking server…</div>
    <div id="ac-form"></div>`;
}
export async function bindAccountTab(rerender) {
  if (!signedIn()) {
    const statusEl = $('#ac-status'), form = $('#ac-form');
    const urlEl = $('#ac-url');
    const check = async () => {
      S.proxy.url = urlEl.value.trim(); saveSettings();
      let st;
      try { st = await api('/api/auth/status'); }
      catch (e) { statusEl.textContent = `⚠️ Can't reach an AHB Broin server here (${e.message}). Static hosting can't do accounts — deploy server.js (see README).`; form.innerHTML = ''; return; }
      const mode = st.setup ? 'setup' : 'login';
      statusEl.innerHTML = st.setup ? '✨ New server — create the admin account.' : `✓ AHB Broin server found${st.signup ? ' · sign-up is open' : ''}.`;
      form.innerHTML = `<div class="grid2"><label>Username<input id="ac-u" autocomplete="username" autocapitalize="off"></label><label>Password<input id="ac-p" type="password" autocomplete="${mode === 'setup' ? 'new-password' : 'current-password'}"></label></div>
        ${st.setup ? `<label>Server access token (APP_TOKEN, if set)<input id="ac-t" type="password" value="${esc(S.proxy.token)}"></label>` : ''}
        <div class="inrow wrap" style="margin-top:10px"><button class="btn primary" id="ac-go">${st.setup ? 'Create admin account' : 'Sign in'}</button>${st.signup ? '<button class="btn" id="ac-signup">Create account</button>' : ''}</div><p class="lk-err" id="ac-err"></p>`;
      const go = async path => {
        const err = $('#ac-err'); err.textContent = '';
        if (st.setup) { S.proxy.token = $('#ac-t').value.trim(); }
        try {
          const r = await api(path, { method: 'POST', body: { username: $('#ac-u').value.trim(), password: $('#ac-p').value } });
          S.account = { username: r.user.username, role: r.user.role, token: r.token };
          S.proxy.enabled = true; S.sync.enabled = true; saveSettings();
          toast(`👋 Signed in as ${r.user.username}`);
          await net.onSignedIn(); rerender();
        } catch (e) { err.textContent = e.message; }
      };
      $('#ac-go').onclick = () => go(st.setup ? '/api/auth/setup' : '/api/auth/login');
      $('#ac-p').onkeydown = e => { if (e.key === 'Enter') $('#ac-go').click(); };
      const su = $('#ac-signup'); if (su) su.onclick = () => go('/api/auth/signup');
    };
    urlEl.onchange = check; check();
    return;
  }
  $('#ac-out').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} S.account = { username: '', role: '', token: '' }; S.sync.enabled = false; saveSettings(); await net.onSignedOut(); toast('Signed out'); rerender(); };
  $('#ac-pw').onclick = async () => {
    const oldPassword = prompt('Current password'); if (!oldPassword) return;
    const newPassword = prompt('New password (min 8 characters)'); if (!newPassword) return;
    try { await api('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword } }); toast('Password changed — other devices were signed out'); } catch (e) { toast(e.message); }
  };
  const users = $('#ac-users'); if (users) users.onclick = openUsers;
  $('#ac-shares').onclick = () => openShares();
  $('#ac-sync').onchange = e => { net.setSyncEnabled(e.target.checked); rerender(); };
  $('#ac-syncnow').onclick = async () => { $('#ac-syncst').textContent = 'Syncing…'; await net.syncNow(true); $('#ac-syncst').innerHTML = net.syncStatusHTML(); };
  const pb = $('#ac-push'); if (pb) pb.onclick = async () => { try { await enablePush(); toast('🔔 Notifications on'); } catch (e) { toast(e.message, 5000); } rerender(); };
  const pt = $('#ac-pushtest'); if (pt) pt.onclick = async () => { try { const r = await api('/api/push/test', { method: 'POST' }); toast(r.sent ? 'Test sent 🔔' : 'No devices received it'); } catch (e) { toast(e.message); } };
  const po = $('#ac-pushoff'); if (po) po.onclick = async () => { await disablePush(); rerender(); };
}

/* ---------- Push notifications ---------- */
const pushState = () => localStorage.getItem('nova.push') === 'on' && 'Notification' in window && Notification.permission === 'granted' ? 'on' : 'off';
const b64ToU8 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support push notifications' + (/iphone|ipad/i.test(navigator.userAgent) ? ' — on iPhone, install the app to the Home Screen first (iOS 16.4+)' : ''));
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notification permission was not granted');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  localStorage.setItem('nova.push', 'on');
}
async function disablePush() {
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); } } catch {}
  localStorage.removeItem('nova.push'); toast('Notifications off');
}

/* ---------- Admin: users ---------- */
async function openUsers() {
  let list = [];
  try { list = (await api('/api/admin/users')).users; } catch (e) { return toast(e.message); }
  openModal(`<div class="dlg-title"><h2>👥 Users</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <div class="tablewrap"><table class="utable"><thead><tr><th>User</th><th>Today</th><th>Tokens (synced)</th><th>Storage</th><th></th></tr></thead><tbody>
    ${list.map(u => { const bytes = Object.values(u.storage || {}).reduce((a, x) => a + x.bytes, 0); return `<tr><td>${esc(u.username)} ${u.role === 'admin' ? '<span class="badge ok">admin</span>' : ''}${u.disabled ? ' <span class="badge">disabled</span>' : ''}<small>last sign-in ${u.lastLogin ? fmtDate(u.lastLogin) : 'never'}${u.dailyLimit ? ` · limit ${u.dailyLimit}/day` : ''}</small></td><td>${u.today} req</td><td>↑${fmtNum(u.stats?.in || 0)} ↓${fmtNum(u.stats?.out || 0)}<small>${fmtNum(u.stats?.req || 0)} requests</small></td><td>${fmtBytes(bytes)}</td><td><button class="btn sm" data-u="${u.id}">Edit</button></td></tr>`; }).join('')}
    </tbody></table></div>
    <h3>Add user</h3>
    <div class="grid2"><label>Username<input id="nu-u" autocapitalize="off"></label><label>Password (min 8)<input id="nu-p" type="text"></label></div>
    <label class="check" style="margin-top:8px"><input type="checkbox" id="nu-admin"> Admin</label>
    <div class="dlg-actions"><button class="btn" data-close>Close</button><button class="btn primary" id="nu-go">Add user</button></div>`, 'wide');
  $('#nu-go').onclick = async () => {
    try { await api('/api/admin/users', { method: 'POST', body: { username: $('#nu-u').value.trim(), password: $('#nu-p').value, role: $('#nu-admin').checked ? 'admin' : 'user' } }); toast('User added'); openUsers(); }
    catch (e) { toast(e.message); }
  };
  $$('[data-u]').forEach(b => b.onclick = () => editUser(list.find(u => u.id === b.dataset.u)));
}
function editUser(u) {
  openModal(`<div class="dlg-title"><h2>Edit ${esc(u.username)}</h2></div>
    <label class="check"><input type="checkbox" id="eu-dis" ${u.disabled ? 'checked' : ''}> Disabled (can't sign in)</label>
    <label class="check" style="margin-top:8px"><input type="checkbox" id="eu-admin" ${u.role === 'admin' ? 'checked' : ''}> Admin</label>
    <label>Daily AI request limit (0 = unlimited)<input id="eu-lim" type="number" min="0" value="${u.dailyLimit || 0}"></label>
    <label>New password (leave empty to keep)<input id="eu-pw" type="text"></label>
    <div class="dlg-actions"><button class="btn danger" id="eu-del">Delete user</button><button class="btn" id="eu-back">Back</button><button class="btn primary" id="eu-save">Save</button></div>`);
  $('#eu-back').onclick = openUsers;
  $('#eu-save').onclick = async () => {
    const body = { disabled: $('#eu-dis').checked, role: $('#eu-admin').checked ? 'admin' : 'user', dailyLimit: +$('#eu-lim').value || 0 };
    if ($('#eu-pw').value) body.password = $('#eu-pw').value;
    try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); toast('Saved'); openUsers(); } catch (e) { toast(e.message); }
  };
  $('#eu-del').onclick = async () => { if (!confirm(`Delete ${u.username} and all their synced data?`)) return; try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('User deleted'); openUsers(); } catch (e) { toast(e.message); } };
}

/* ---------- Shared links ---------- */
export async function openShares(justCreated) {
  let list = [];
  try { list = (await api('/api/shares')).shares; } catch (e) { return toast(e.message); }
  const link = id => new URL(`s/${id}`, net.root() + '/').href;
  openModal(`<div class="dlg-title"><h2>🔗 Shared links</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    ${justCreated ? `<div class="card-box"><p>✅ Anyone with this link can view the chat (read-only):</p><div class="inrow"><input id="sh-link" value="${esc(link(justCreated))}" readonly><button class="btn" id="sh-copy">📋 Copy</button></div>${navigator.share ? '<button class="btn sm" id="sh-native" style="margin-top:8px">📤 Share…</button>' : ''}</div>` : ''}
    <div class="kb-docs" style="max-height:none">${list.map(s => `<div class="kb-doc"><span>🔗</span><div><b>${esc(s.title)}</b><small>${fmtDate(s.created)} · ${s.count} messages</small></div><a class="btn sm" href="${esc(link(s.id))}" target="_blank" rel="noopener">Open</a><button class="btn sm danger" data-revoke="${s.id}">Revoke</button></div>`).join('') || '<p class="hint">No shared links yet.</p>'}</div>
    <div class="dlg-actions"><button class="btn primary" data-close>Done</button></div>`);
  const c = $('#sh-copy'); if (c) c.onclick = () => { navigator.clipboard?.writeText($('#sh-link').value).then(() => toast('Link copied')); };
  const n = $('#sh-native'); if (n) n.onclick = () => navigator.share({ title: 'AHB Broin chat', url: $('#sh-link').value }).catch(() => {});
  $$('[data-revoke]').forEach(b => b.onclick = async () => { if (!confirm('Revoke this link? It will stop working for everyone.')) return; try { await api('/api/share/' + b.dataset.revoke, { method: 'DELETE' }); toast('Link revoked'); openShares(); } catch (e) { toast(e.message); } });
}
