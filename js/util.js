/* Small shared helpers. */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(new DOMException('Aborted', 'AbortError'));
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** toast(message, ms?, action?) — action = { label, fn } shows a button. */
export function toast(msg, ms = 2600, action) {
  const t = $('#toast');
  t.replaceChildren();
  const span = document.createElement('span'); span.textContent = msg; t.append(span);
  if (action) {
    const b = document.createElement('button'); b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); action.fn(); };
    t.append(b);
  }
  t.classList.toggle('actionable', !!action);
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), action ? Math.max(ms, 9000) : ms);
}

export function openModal(html, cls = '') {
  const m = $('#modal');
  $('#modalBody').innerHTML = html;
  m.className = cls;
  if (!m.open) m.showModal();
  $('#modalBody').scrollTop = 0;
}
export const closeModal = () => $('#modal').close();

export function fmtNum(n) {
  n = +n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
export function fmtUSD(n) {
  n = +n || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}
export const pad2 = n => String(n).padStart(2, '0');
export const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
export const timeStr = ts => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
export function dayStart(daysAgo = 0) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - daysAgo); return d.getTime(); }
export function monthStart() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); }

export function parseDataUrl(u) {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(u || '');
  return m ? { mime: (m[1] || 'application/octet-stream').split(';')[0], b64: m[3] } : { mime: '', b64: '' };
}
export function dataUrlToBlob(u) {
  const { mime, b64 } = parseDataUrl(u);
  return new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: mime });
}
export const blobToDataURL = b => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b);
});
export function download(content, name, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export function copy(t) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(t).then(() => toast('Copied'), () => fallbackCopy(t));
  fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta); ta.select();
  try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed'); }
  ta.remove();
}

export function fmtBytes(n) {
  n = +n || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$/, '') + ' ' + u[i];
}
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  return d.getFullYear() === now.getFullYear() ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
const scriptCache = new Map();
/** Lazy-load a classic script once (used for PDF / Office text extraction). */
export function loadScript(src) {
  if (!scriptCache.has(src)) scriptCache.set(src, new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => { scriptCache.delete(src); rej(new Error('Could not load ' + src.split('/').slice(-3, -1).join(' ') + ' (offline?)')); };
    document.head.append(s);
  }));
  return scriptCache.get(src);
}
