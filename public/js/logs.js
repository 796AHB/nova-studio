/* Error & activity log: catches JS errors, failed API calls and app events (keys are redacted). */
import { APP_VERSION } from './config.js';
import { LS } from './store.js';
import { $, esc, openModal, download, copy, toast } from './util.js';

const KEY = 'nova.logs', MAX = 300;
let logs = LS.get(KEY, []);
let saveT;
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => LS.set(KEY, logs), 300); };

/** Remove anything that looks like an API key / token. */
export function redact(s) {
  return String(s ?? '')
    .replace(/\b(sk|rk|pk|tvly|xai|gsk|github_pat|ghp|AIza)[-_A-Za-z0-9]{10,}/g, '$1-•••')
    .replace(/(bearer\s+)[^\s"']+/gi, '$1•••')
    .replace(/([?&](key|api_key|token)=)[^&\s"']+/gi, '$1•••');
}
export function log(level, msg, detail) {
  logs.push({ ts: Date.now(), level, msg: redact(msg).slice(0, 500), detail: detail ? redact(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000) : '' });
  if (logs.length > MAX) logs = logs.slice(-MAX);
  persist();
}
export const errorCount = () => logs.filter(l => l.level === 'error' && Date.now() - l.ts < 864e5).length;

export function initLogs() {
  addEventListener('error', e => log('error', e.message || 'Script error', `${e.filename || ''}:${e.lineno || ''}:${e.colno || ''}\n${e.error?.stack || ''}`));
  addEventListener('unhandledrejection', e => log('error', 'Unhandled: ' + (e.reason?.message || e.reason), e.reason?.stack));
  // Wrap fetch to record failed network/API calls (bodies are never logged).
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const t0 = performance.now();
    try {
      const r = await orig(input, init);
      if (!r.ok && !/\/proxy\/config|\/api\/sync/.test(url)) log(r.status >= 500 ? 'error' : 'warn', `HTTP ${r.status} ${(init?.method || 'GET')} ${shortUrl(url)}`, `${Math.round(performance.now() - t0)} ms`);
      return r;
    } catch (e) {
      if (e.name !== 'AbortError') log('error', `Network error ${(init?.method || 'GET')} ${shortUrl(url)}: ${e.message}`);
      throw e;
    }
  };
}
const shortUrl = u => { try { const x = new URL(u, location.href); return x.host + x.pathname.slice(0, 80); } catch { return String(u).slice(0, 80); } };

function report() {
  return `AHB Broin ${APP_VERSION}\n${navigator.userAgent}\n${new Date().toISOString()}\n\n` +
    logs.map(l => `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.msg}${l.detail ? '\n    ' + l.detail.replace(/\n/g, '\n    ') : ''}`).join('\n');
}
export function openLogs() {
  const rows = [...logs].reverse().slice(0, 200).map(l => `<div class="logrow ${l.level}"><span class="lt">${new Date(l.ts).toLocaleString()}</span><b>${l.level === 'error' ? '⛔' : l.level === 'warn' ? '⚠️' : 'ℹ️'} ${esc(l.msg)}</b>${l.detail ? `<pre>${esc(l.detail)}</pre>` : ''}</div>`).join('');
  openModal(`<div class="dlg-title"><h2>🐞 Logs</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">Errors, failed API calls and events from this device (newest first). API keys are hidden. Share this when reporting a problem.</p>
    <div class="logs">${rows || '<p class="hint">No log entries — all good 🎉</p>'}</div>
    <div class="dlg-actions"><button class="btn danger" id="lg-clear">Clear</button><button class="btn" id="lg-copy">📋 Copy</button><button class="btn" id="lg-dl">⬇ Download</button><button class="btn primary" data-close>Done</button></div>`, 'wide');
  $('#lg-clear').onclick = () => { logs = []; LS.set(KEY, logs); openLogs(); };
  $('#lg-copy').onclick = () => copy(report());
  $('#lg-dl').onclick = () => download(report(), `nova-logs-${Date.now()}.txt`, 'text/plain');
}
