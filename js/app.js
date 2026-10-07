/* ============================================================
   Nova Studio — bring-your-own-key AI studio
   Chat · Image · Video · Voice · Skills · Usage monitor · PWA
   ============================================================ */
import { PROVIDERS, VOICES, MODE_LABEL, APP_VERSION, contextFor } from './config.js';
import { S, saveSettings, replaceSettings, loadSkills, saveSkillsLS, DB, LS } from './store.js';
import { $, $$, uid, esc, sleep, toast, openModal, closeModal, fmtNum, fmtUSD, timeStr, dayKey, dayStart,
  parseDataUrl, dataUrlToBlob, blobToDataURL, download, copy } from './util.js';
import { initUsage, loadUsage, recordUsage, estimateTokens, costOf, sum, since, budgetLevel, openUsage } from './usage.js';
import { initFiles, openExplorer, refreshExplorer, entries as fileEntries } from './files.js';
import { initConnectors, openConnectors, activeTools, toolsSystemNote, runTool, enabledCount } from './connectors.js';
import { initLogs, log, openLogs } from './logs.js';
import { unlockScreen, vaultOn, lockNow, armAutoLock, vaultSettingsHTML, bindVaultSettings } from './vault.js';
import { applyLang, langNote, currentLang } from './i18n.js';
import { openCanvas, RUNNABLE } from './canvas.js';
import { initProjects, projects, currentProject, projectById, projectBarHTML, openProjectMenu, editProject, setProject } from './projects.js';
import { initGallery, openGallery, openImageTools } from './gallery.js';
import { initKB, openKB, setKBHooks, kbById, search as kbSearch, contextBlock } from './kb.js';
import { initVoice, startVoice } from './voice.js';
import { initCompare, openCompare } from './compare.js';
import { initAccount, accountTabHTML, bindAccountTab, signedIn, api as serverApi, openShares } from './account.js';
import { initSync, syncNow, syncActive, syncStatusHTML, setSyncEnabled, resetSyncState } from './sync.js';
import { initTasks, openTasks } from './tasks.js';
import {
  initRuns, loadRuns, startRun, endRun, startStep, endStep, decideStep, addArtifact,
  runForMsg, isTrusted, trustOnce, auditNote, sessionTrust, openRuns, openRun,
} from './runs.js';
import { autoUpdate } from './updates.js';
initLogs();

/* ---------- State ---------- */
let convos = [], cur = null, pending = [], busy = false, abortCtl = null;
let mode = LS.get('nova.mode', 'chat');
let skills = loadSkills();
let serverKeys = new Set(), serverStatus = '', serverFeatures = {};
const saveSkills = () => saveSkillsLS(skills);
const messagesEl = $('#messages'), input = $('#input'), sendBtn = $('#sendBtn'), micBtn = $('#micBtn'), modal = $('#modal');

/* ---------- Connection: direct keys or Nova proxy server ---------- */
const proxyRoot = () => (S.proxy.url || new URL('.', location.href).href).replace(/\/+$/, '');
const viaProxy = pid => S.proxy.enabled && serverKeys.has(pid);
const proxyHeaders = () => ({ ...(S.proxy.token ? { 'x-nova-token': S.proxy.token } : {}), ...(S.account?.token ? { 'x-nova-session': S.account.token } : {}) });
const hasKey = pid => {
  const P = PROVIDERS[pid]; if (!P) return false;
  if (viaProxy(pid)) return true;
  return P.keyless ? (pid !== 'custom' || !!S.bases.custom) : !!S.keys[pid];
};
function base(pid) {
  if (viaProxy(pid)) return `${proxyRoot()}/proxy/${pid}`;
  const b = (S.bases[pid] || PROVIDERS[pid].base || '').replace(/\/+$/, '');
  if (!b) throw new Error(`Set a Base URL for ${PROVIDERS[pid].name} in Settings ⚙️`);
  return b;
}
function key(pid) {
  if (viaProxy(pid)) return '';
  const k = S.keys[pid];
  if (!k && !PROVIDERS[pid].keyless) throw new Error(`Add your ${PROVIDERS[pid].name} API key in Settings ⚙️${S.proxy.enabled ? ' (or on your Nova server)' : ''}`);
  return k || '';
}
function authHeaders(pid, json = true) {
  const h = viaProxy(pid) ? proxyHeaders() : {};
  if (json) h['Content-Type'] = 'application/json';
  const k = key(pid); if (k) h.Authorization = 'Bearer ' + k;
  if (pid === 'openrouter') { h['X-Title'] = 'Nova Studio'; h['HTTP-Referer'] = location.origin.startsWith('http') ? location.origin : 'https://nova.studio'; }
  return h;
}
function gHeaders(pid, json = true) { const h = viaProxy(pid) ? proxyHeaders() : { 'x-goog-api-key': key(pid) }; if (json) h['Content-Type'] = 'application/json'; return h; }
function aHeaders(pid) {
  const h = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...(viaProxy(pid) ? proxyHeaders() : { 'x-api-key': key(pid), 'anthropic-dangerous-direct-browser-access': 'true' }) };
  return h;
}
const elHeaders = pid => ({ 'Content-Type': 'application/json', Accept: 'audio/mpeg', ...(viaProxy(pid) ? proxyHeaders() : { 'xi-api-key': key(pid) }) });

async function loadServerConfig(quiet = true) {
  serverKeys = new Set(); serverStatus = ''; serverFeatures = {};
  if (!S.proxy.enabled) return;
  try {
    const r = await fetch(proxyRoot() + '/proxy/config', { headers: proxyHeaders() });
    if (r.status === 401) throw new Error('wrong or missing access token');
    if (!r.ok) throw new Error('server returned ' + r.status);
    const j = await r.json();
    serverKeys = new Set(j.providers || []); serverFeatures = j.features || {};
    if (j.user && S.account?.token) { S.account.role = j.user.role; }
    serverStatus = `✓ Connected · server keys for: ${[...serverKeys].map(p => PROVIDERS[p]?.name || p).join(', ') || 'none'}`;
  } catch (e) {
    serverStatus = `⚠️ Can't reach Nova server: ${e.message}`;
    if (!quiet) toast(serverStatus, 5000);
  }
}

const relayOn = () => S.proxy.enabled && !!serverFeatures.relay;
/** Fetch any URL through the Nova server relay (web reader, MCP servers). */
function relayFetch(url, init = {}) {
  const h = { ...proxyHeaders(), 'x-relay-url': url };
  for (const [k, v] of Object.entries(init.headers || {})) h[k.toLowerCase() === 'authorization' ? 'x-relay-authorization' : k] = v;
  return fetch(proxyRoot() + '/relay', { method: init.method || 'GET', headers: h, body: init.body, signal: init.signal });
}

async function ok(res) {
  if (res.ok) return res;
  let msg = '';
  try {
    const t = await res.text();
    try { let j = JSON.parse(t); if (Array.isArray(j)) j = j[0]; msg = j?.error?.message || j?.detail?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || (typeof j?.detail === 'string' ? j.detail : '') || t; }
    catch { msg = t; }
  } catch {}
  const hint = res.status === 401 ? ' (check your API key)' : res.status === 429 ? ' (rate limit or quota reached)' : '';
  throw new Error(`${res.status}${hint} — ${String(msg).slice(0, 500)}`);
}
async function* sse(res) {
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}
async function toDataUrlMaybe(url) { try { const r = await fetch(url); if (!r.ok) throw 0; return await blobToDataURL(await r.blob()); } catch { return url; } }
function pcmToWav(b64, rate = 24000) {
  const pcm = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), buf = new ArrayBuffer(44 + pcm.length), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

/* ---------- Markdown + math ---------- */
if (window.DOMPurify) DOMPurify.addHook('afterSanitizeAttributes', n => { if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener'); } });
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)([^$\n]{1,300}?[^\s$\\])\$(?![\w$])/g;
function md(text) {
  const maths = [];
  // protect math outside code fences / inline code so Markdown doesn't mangle it
  const protectedText = String(text).split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((seg, i) => i % 2 ? seg : seg.replace(MATH_RE, (m, a, b, c, d) => {
    const tex = a ?? b ?? c ?? d;
    if (d !== undefined && !/[\\^_{}=]/.test(d)) return m; // plain "$5 and $10" stays text
    maths.push({ tex, display: a !== undefined || b !== undefined });
    return `@@MATH${maths.length - 1}@@`;
  })).join('');
  let html = window.marked ? marked.parse(protectedText, { breaks: true, gfm: true }) : esc(protectedText).replace(/\n/g, '<br>');
  if (window.DOMPurify) html = DOMPurify.sanitize(html);
  return html.replace(/@@MATH(\d+)@@/g, (_, i) => { const m = maths[+i]; return `<span class="math${m.display ? ' display' : ''}" data-tex="${esc(m.tex)}">${esc(m.tex)}</span>`; });
}
function renderMath(el) {
  if (!window.katex) return;
  el.querySelectorAll('.math[data-tex]').forEach(s => {
    try { katex.render(s.dataset.tex, s, { displayMode: s.classList.contains('display'), throwOnError: false }); s.removeAttribute('data-tex'); } catch {}
  });
}
function plain(t) {
  return String(t || '').replace(/```[\s\S]*?```/g, ' (code block) ').replace(/`([^`]+)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/\$\$?([^$]+)\$\$?/g, '$1').replace(/[*_~>|]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '').replace(/\n{2,}/g, '\n').trim();
}
function chunkText(t, n) {
  const parts = t.split(/(?<=[.!?。])\s+|\n+/), out = []; let c = '';
  for (const p of parts) {
    if ((c + ' ' + p).length > n && c) { out.push(c); c = p; } else c = c ? c + ' ' + p : p;
    while (c.length > n) { out.push(c.slice(0, n)); c = c.slice(n); }
  }
  if (c.trim()) out.push(c);
  return out;
}

/* ---------- Files ---------- */
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|ts|jsx|tsx|py|java|kt|c|cc|cpp|h|hpp|cs|go|rs|rb|php|swift|html|htm|css|scss|xml|yaml|yml|toml|ini|env|sql|sh|bat|ps1|log|srt|vtt|tex|r|lua|dart|vue|svelte)$/i;
function kindOf(f) {
  const t = f.type || '';
  if (t.startsWith('image/')) return 'image'; if (t.startsWith('audio/')) return 'audio'; if (t.startsWith('video/')) return 'video';
  if (t === 'application/pdf' || /\.pdf$/i.test(f.name)) return 'pdf';
  if (t.startsWith('text/') || t === 'application/json' || TEXT_EXT.test(f.name)) return 'text';
  return 'file';
}
const readFile = (f, asText) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); asText ? r.readAsText(f) : r.readAsDataURL(f); });
function compressImage(dataUrl, max = 2048, q = 0.9) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const { width: w, height: h } = img, s = Math.min(1, max / Math.max(w, h));
      if (s === 1 && dataUrl.length < 2.5e6) return res(dataUrl);
      const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => res(dataUrl); img.src = dataUrl;
  });
}
async function addFiles(files) {
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`); continue; }
    const kind = kindOf(f);
    try {
      if (kind === 'text') { pending.push({ id: uid(), name: f.name || 'file.txt', mime: f.type || 'text/plain', kind, text: (await readFile(f, true)).slice(0, 300000) }); continue; }
      let data = await readFile(f, false);
      if (kind === 'image') data = await compressImage(data);
      pending.push({ id: uid(), name: f.name || kind, mime: parseDataUrl(data).mime || f.type, kind, data });
    } catch { toast('Could not read ' + f.name); }
  }
  renderAttachBar();
}
const attIcon = k => ({ image: '🖼️', audio: '🎵', video: '🎞️', pdf: '📕', text: '📄', file: '📦' }[k] || '📦');
function renderAttachBar() {
  $('#attachBar').innerHTML = pending.map(a => `<div class="att">${a.kind === 'image' ? `<img src="${a.data}" alt="">` : attIcon(a.kind)}<span>${esc(a.name)}</span><button class="x" data-rm="${a.id}" aria-label="Remove ${esc(a.name)}">✕</button></div>`).join('');
}

/* ---------- System prompt & history ---------- */
function buildSystem(convo = cur) {
  const proj = projectById(convo?.projectId);
  return [S.system, langNote(), proj?.instructions ? `## Project: ${proj.name}\n${proj.instructions}` : '', ...skills.filter(s => s.enabled).map(s => `## Skill: ${s.name}\n${s.prompt}`)].filter(Boolean).join('\n\n');
}
/** Chat provider/model for a conversation (project default wins). */
function chatModelFor(convo) {
  if (convo?.model && PROVIDERS[convo.model.provider]) return convo.model;
  const pm = projectById(convo?.projectId)?.model;
  return pm && PROVIDERS[pm.provider] ? pm : S.chat;
}
function historyFor(convo, exclude) {
  let h = convo.messages.filter(m => m !== exclude && !m.pending);
  if (+S.historyLimit > 0 && h.length > +S.historyLimit) h = h.slice(-S.historyLimit);
  return h;
}
function binOK(a, type) { if (a.kind === 'image' || a.kind === 'pdf') return true; return type === 'gemini' && (a.kind === 'audio' || a.kind === 'video'); }
function msgText(m, type) {
  if (m.role === 'assistant') { let t = (m.tools || []).map(c => `[Used tool ${c.name}${c.label ? ' (' + c.label + ')' : ''} → ${(c.result || '').slice(0, 300).replace(/\s+/g, ' ')}]`).join('\n'); t += (t ? '\n' : '') + (m.text || ''); for (const x of m.media || []) t += `\n[Generated ${x.kind}${x.prompt ? ': ' + x.prompt : ''}]`; return t.replace(/\n\n_⏹ Stopped_$/, '').trim(); }
  let t = m.text || '';
  for (const a of m.atts || []) {
    if (binOK(a, type)) continue;
    if (a.kind === 'text') t += `\n\n--- File: ${a.name} ---\n${a.text}`;
    else if (a.kind === 'audio') t += a.transcript ? `\n\n[Transcript of audio "${a.name}"]:\n${a.transcript}` : `\n\n[Audio "${a.name}" attached — no transcript available]`;
    else t += `\n\n[Attached "${a.name}" (${a.mime}) — this model can't read this file type]`;
  }
  return t.trim();
}
function toBlocks(m, type) {
  const out = [], text = msgText(m, type);
  if (m.role === 'user') for (const a of (m.atts || []).filter(a => binOK(a, type))) {
    const { mime, b64 } = parseDataUrl(a.data);
    if (type === 'openai') out.push(a.kind === 'image' ? { type: 'image_url', image_url: { url: a.data } } : { type: 'file', file: { filename: a.name, file_data: a.data } });
    else if (type === 'anthropic') out.push(a.kind === 'image' ? { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } } : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
    else out.push({ inline_data: { mime_type: mime, data: b64 } });
  }
  if (text) out.push(type === 'gemini' ? { text } : { type: 'text', text });
  return out;
}
function buildTurns(history, type) {
  const turns = [];
  for (const m of history) {
    const b = toBlocks(m, type); if (!b.length) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role && type !== 'openai') last.blocks.push(...b); else turns.push({ role: m.role, blocks: b });
  }
  if (type !== 'openai') while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}
function estimateContext(convo) {
  let n = estimateTokens(buildSystem(convo));
  for (const m of historyFor(convo)) {
    n += estimateTokens(msgText(m, 'openai')) + 4;
    for (const a of m.atts || []) n += a.kind === 'image' ? 800 : a.kind === 'pdf' ? 2500 : 0;
  }
  return n;
}

/* ---------- Chat engines (streaming; each returns usage or null) ---------- */
const EFFORT_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 24576 };
const hasTemp = () => S.temperature !== '' && S.temperature != null;

const parseArgs = a => { if (a && typeof a === 'object') return a; try { return JSON.parse(a || '{}') || {}; } catch { return {}; } };
async function chatOpenAI(pid, model, history, system, out, signal, opts = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const t of buildTurns(history, 'openai')) messages.push({ role: t.role, content: t.blocks.every(b => b.type === 'text') ? t.blocks.map(b => b.text).join('\n\n') : t.blocks });
  messages.push(...(opts.extra || []));
  const body = { model, messages, stream: true };
  if (opts.tools?.length) body.tools = opts.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } }));
  if (PROVIDERS[pid].usageOpt) body.stream_options = { include_usage: true };
  if (hasTemp()) body.temperature = +S.temperature;
  if (S.reasoning) {
    if (pid === 'openai' && /^(o\d|gpt-5)/.test(model)) body.reasoning_effort = S.reasoning;
    else if (pid === 'openrouter') body.reasoning = { effort: S.reasoning === 'minimal' ? 'low' : S.reasoning };
  }
  const res = await ok(await fetch(base(pid) + '/chat/completions', { method: 'POST', headers: authHeaders(pid), body: JSON.stringify(body), signal }));
  let usage = null, text = ''; const calls = [];
  for await (const d of sse(res)) {
    if (d === '[DONE]') break;
    let j; try { j = JSON.parse(d); } catch { continue; }
    if (j.error) throw new Error(j.error.message || 'Stream error');
    const delta = j.choices?.[0]?.delta;
    const think = delta?.reasoning_content || (typeof delta?.reasoning === 'string' ? delta.reasoning : '');
    if (think) out.think(think);
    if (delta?.content) { text += delta.content; out.text(delta.content); }
    for (const im of delta?.images || []) out.media({ kind: 'image', src: im.image_url?.url });
    for (const tc of delta?.tool_calls || []) {
      const i = tc.index ?? (tc.id || !calls.length ? calls.length : calls.length - 1);
      const c = calls[i] ||= { id: '', name: '', args: '' };
      if (tc.id) c.id = tc.id;
      if (tc.function?.name && !c.name) c.name = tc.function.name;
      if (tc.function?.arguments) c.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    }
    const u = j.usage || j.x_groq?.usage;
    if (u) usage = { in: u.prompt_tokens || 0, out: u.completion_tokens || 0, reasoning: u.completion_tokens_details?.reasoning_tokens || 0, cached: u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0 };
  }
  const done = calls.filter(c => c?.name).map(c => ({ id: c.id || 'call_' + uid(), name: c.name, raw: c.args || '{}', args: parseArgs(c.args) }));
  return { usage, calls: done, native: done.length ? { role: 'assistant', content: text || null, tool_calls: done.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw } })) } : null };
}
async function chatAnthropic(pid, model, history, system, out, signal, opts = {}) {
  const body = { model, max_tokens: +S.maxTokens || 8192, stream: true, messages: [...buildTurns(history, 'anthropic').map(t => ({ role: t.role, content: t.blocks })), ...(opts.extra || [])] };
  if (system) body.system = system;
  if (opts.tools?.length) body.tools = opts.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters || { type: 'object', properties: {} } }));
  if (S.reasoning) {
    const b = EFFORT_BUDGET[S.reasoning] || 4096;
    body.thinking = { type: 'enabled', budget_tokens: b };
    body.max_tokens = Math.max(body.max_tokens, b + 4096);
  } else if (hasTemp()) body.temperature = +S.temperature;
  const res = await ok(await fetch(base(pid) + '/messages', { method: 'POST', headers: aHeaders(pid), body: JSON.stringify(body), signal }));
  const usage = { in: 0, out: 0, reasoning: 0, cached: 0 }; let got = false;
  const blocks = [];
  for await (const d of sse(res)) {
    let j; try { j = JSON.parse(d); } catch { continue; }
    if (j.type === 'message_start' && j.message?.usage) {
      const u = j.message.usage; got = true;
      usage.in = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      usage.cached = u.cache_read_input_tokens || 0; usage.out = u.output_tokens || 0;
    }
    if (j.type === 'content_block_start') blocks[j.index ?? blocks.length] = { ...j.content_block, _json: '' };
    if (j.type === 'content_block_delta') {
      const b = blocks[j.index ?? blocks.length - 1] ||= { type: 'text', text: '', _json: '' }, dl = j.delta || {};
      if (dl.type === 'text_delta') { b.text = (b.text || '') + dl.text; out.text(dl.text); }
      else if (dl.type === 'thinking_delta') { b.thinking = (b.thinking || '') + dl.thinking; out.think(dl.thinking); }
      else if (dl.type === 'signature_delta') b.signature = (b.signature || '') + dl.signature;
      else if (dl.type === 'input_json_delta') b._json += dl.partial_json || '';
    }
    if (j.type === 'message_delta' && j.usage) { got = true; usage.out = j.usage.output_tokens ?? usage.out; }
    if (j.type === 'error') throw new Error(j.error?.message || 'Stream error');
  }
  const list = blocks.filter(Boolean);
  const calls = list.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b._json ? parseArgs(b._json) : (b.input || {}) }));
  const native = calls.length ? { role: 'assistant', content: list.map(b =>
    b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b._json ? parseArgs(b._json) : (b.input || {}) }
    : b.type === 'text' ? (b.text ? { type: 'text', text: b.text } : null)
    : b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' }
    : b.type === 'redacted_thinking' ? { type: 'redacted_thinking', data: b.data } : null).filter(Boolean) } : null;
  return { usage: got ? usage : null, calls, native };
}
function geminiParts(parts, out) {
  for (const p of parts || []) {
    if (p.text) (p.thought ? out.think : out.text)(p.text);
    const inl = p.inlineData || p.inline_data;
    if (inl?.data) out.media({ kind: 'image', src: `data:${inl.mimeType || inl.mime_type || 'image/png'};base64,${inl.data}` });
  }
}
const geminiUsage = u => u ? { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), reasoning: u.thoughtsTokenCount || 0, cached: u.cachedContentTokenCount || 0 } : null;
/** Convert a JSON Schema to the OpenAPI subset Gemini accepts. */
function geminiSchema(s) {
  if (!s || typeof s !== 'object') return { type: 'string' };
  if (!s.type && Array.isArray(s.anyOf || s.oneOf)) { const f = (s.anyOf || s.oneOf).find(x => x && x.type !== 'null') || {}; return { ...geminiSchema(f), ...(s.description ? { description: s.description } : {}) }; }
  const o = {}; let type = s.type;
  if (Array.isArray(type)) { if (type.includes('null')) o.nullable = true; type = type.find(t => t !== 'null'); }
  type = type || (s.properties ? 'object' : s.items ? 'array' : 'string');
  o.type = type;
  if (s.description) o.description = String(s.description).slice(0, 1000);
  if (type === 'string' && Array.isArray(s.enum)) o.enum = s.enum.map(String);
  if (type === 'object') {
    o.properties = {};
    for (const [k, v] of Object.entries(s.properties || {})) o.properties[k] = geminiSchema(v);
    const req = (s.required || []).filter(r => r in o.properties); if (req.length) o.required = req;
  }
  if (type === 'array') o.items = geminiSchema(s.items || { type: 'string' });
  return o;
}
async function chatGemini(pid, model, history, system, out, signal, opts = {}) {
  const body = { contents: [...buildTurns(history, 'gemini').map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: t.blocks })), ...(opts.extra || [])] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (opts.tools?.length) body.tools = [{ functionDeclarations: opts.tools.map(t => { const p = geminiSchema(t.parameters); return { name: t.name, description: t.description, ...(Object.keys(p.properties || {}).length ? { parameters: p } : {}) }; }) }];
  const gc = {};
  if (hasTemp()) gc.temperature = +S.temperature;
  if (S.reasoning) gc.thinkingConfig = { includeThoughts: true };
  if (Object.keys(gc).length) body.generationConfig = gc;
  const res = await ok(await fetch(`${base(pid)}/models/${model}:streamGenerateContent?alt=sse`, { method: 'POST', headers: gHeaders(pid), body: JSON.stringify(body), signal }));
  let usage = null; const parts = [];
  for await (const d of sse(res)) {
    let j; try { j = JSON.parse(d); } catch { continue; }
    if (j.error) throw new Error(j.error.message);
    const ps = j.candidates?.[0]?.content?.parts || [];
    for (const p of ps) {
      const prev = parts[parts.length - 1];
      if (prev && p.text != null && prev.text != null && !!prev.thought === !!p.thought && !p.thoughtSignature && !prev.thoughtSignature) prev.text += p.text;
      else parts.push({ ...p });
    }
    geminiParts(ps, out);
    if (j.usageMetadata) usage = geminiUsage(j.usageMetadata);
  }
  const calls = parts.filter(p => p.functionCall).map(p => ({ id: 'g_' + uid(), gid: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args || {} }));
  return { usage, calls, native: calls.length ? { role: 'model', parts } : null };
}
function toolResults(type, results) {
  if (type === 'anthropic') return [{ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.text, ...(r.error ? { is_error: true } : {}) })) }];
  if (type === 'gemini') return [{ role: 'user', parts: results.map(r => ({ functionResponse: { name: r.name, ...(r.gid ? { id: r.gid } : {}), response: { result: r.text } } })) }];
  return results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.text }));
}
function callChat(pid, model, history, system, out, signal, opts) {
  if (!model) throw new Error('Pick a model first (tap the model name at the top).');
  const t = PROVIDERS[pid].type;
  if (t === 'anthropic') return chatAnthropic(pid, model, history, system, out, signal, opts);
  if (t === 'gemini') return chatGemini(pid, model, history, system, out, signal, opts);
  if (t === 'openai') return chatOpenAI(pid, model, history, system, out, signal, opts);
  throw new Error(PROVIDERS[pid].name + ' does not support chat');
}
/* ---------- Embeddings (knowledge bases) ---------- */
const EMBED_DEFAULT = { openai: 'text-embedding-3-small', gemini: 'gemini-embedding-001', ollama: 'nomic-embed-text', custom: 'text-embedding-3-small' };
function embedChoice() {
  const pref = S.embed?.provider || 'auto';
  if (pref === 'none') return null;
  for (const pid of pref === 'auto' ? ['openai', 'gemini'] : [pref]) {
    if (!PROVIDERS[pid] || !hasKey(pid)) continue;
    return { provider: pid, model: (pref !== 'auto' && S.embed.model) || EMBED_DEFAULT[pid] };
  }
  return null;
}
const embedAvailable = e => !!e && !!PROVIDERS[e.provider] && hasKey(e.provider);
async function embedTexts(pid, model, texts, signal) {
  const P = PROVIDERS[pid], est = texts.reduce((a, t) => a + estimateTokens(t), 0);
  if (P.type === 'gemini') {
    const j = await (await ok(await fetch(`${base(pid)}/models/${model}:batchEmbedContents`, { method: 'POST', headers: gHeaders(pid), signal,
      body: JSON.stringify({ requests: texts.map(t => ({ model: 'models/' + model, content: { parts: [{ text: t }] } })) }) }))).json();
    recordUsage({ provider: pid, model, kind: 'embed', in: est, est: true });
    return { vectors: (j.embeddings || []).map(e => e.values) };
  }
  const j = await (await ok(await fetch(base(pid) + '/embeddings', { method: 'POST', headers: authHeaders(pid), signal, body: JSON.stringify({ model, input: texts }) }))).json();
  recordUsage({ provider: pid, model, kind: 'embed', in: j.usage?.prompt_tokens ?? est, est: !j.usage });
  return { vectors: (j.data || []).sort((a, b) => a.index - b.index).map(d => d.embedding) };
}
/* ---------- Knowledge bases in chat ---------- */
let draftKb = { kbIds: [], kbOff: [] };
function activeKbIds(convo) {
  const c = convo || draftKb, proj = projectById(c.projectId ?? currentProject()?.id);
  return [...new Set([...(c.kbIds || []), ...(proj?.kbIds || [])])].filter(id => kbById(id) && !(c.kbOff || []).includes(id));
}
function toggleKbForChat(id, force) {
  const c = cur || draftKb; c.kbIds ||= []; c.kbOff ||= [];
  const on = force ?? !activeKbIds(cur).includes(id);
  if (on) { c.kbOff = c.kbOff.filter(x => x !== id); if (!c.kbIds.includes(id)) c.kbIds.push(id); }
  else { c.kbIds = c.kbIds.filter(x => x !== id); if (projectById(c.projectId ?? currentProject()?.id)?.kbIds?.includes(id)) c.kbOff.push(id); }
  if (cur) saveConvo(cur);
  renderSkillBar();
}
function retrievalQuery(history) {
  const users = history.filter(m => m.role === 'user' && m.text);
  const last = users.at(-1)?.text || '';
  return last.length < 60 && users.length > 1 ? users.at(-2).text.slice(-300) + '\n' + last : last;
}

/** One-shot completion (used by the prompt enhancer). */
async function complete(text, system, signal) {
  let res = ''; const { provider, model } = S.chat;
  const ctl = signal ? null : new AbortController();
  const u = (await callChat(provider, model, [{ role: 'user', text, atts: [] }], system, { text: t => res += t, think: () => {}, media: () => {} }, signal || ctl.signal)).usage;
  await recordUsage({ provider, model, kind: 'chat', in: u?.in ?? estimateTokens(system + text), out: u?.out ?? estimateTokens(res), est: !u, tag: 'enhance' });
  return res.trim();
}

/* ---------- Run modes ---------- */
async function runChat(convo, asst, signal) {
  const { provider, model } = chatModelFor(convo), P = PROVIDERS[provider];
  asst.meta = `${P.name} · ${model}`; asst.provider = provider; asst.model = model;
  if (P.type !== 'gemini') for (const m of convo.messages) for (const a of m.atts || []) {
    if (a.kind === 'audio' && !a.transcript) {
      asst.status = `Transcribing ${a.name}…`; renderMessage(asst);
      try { a.transcript = await transcribe(dataUrlToBlob(a.data), a.name); } catch (e) { a.transcript = `(transcription failed: ${e.message})`; }
    }
  }
  asst.status = ''; renderMessage(asst);
  const history = historyFor(convo, asst);
  const tools = ['openai', 'anthropic', 'gemini'].includes(P.type) ? activeTools() : [];
  let system = [buildSystem(convo), toolsSystemNote(tools)].filter(Boolean).join('\n\n');
  const kbIds = activeKbIds(convo);
  if (kbIds.length) {
    asst.status = 'Searching your documents…'; renderMessage(asst);
    try {
      const ctx = contextBlock(await kbSearch(kbIds, retrievalQuery(history), { signal }));
      if (ctx.text) { system += '\n\n' + ctx.text; asst.sources = ctx.sources; }
    } catch (e) { if (e.name === 'AbortError') throw e; log('warn', 'Knowledge search failed', e.message); }
    asst.status = ''; renderMessage(asst);
  }
  asst._estIn = estimateContext({ messages: history }) + (tools.length ? estimateTokens(JSON.stringify(tools.map(t => [t.name, t.description, t.parameters]))) : 0);
  const out = {
    text: t => { if (asst._sep && asst.text.trim()) asst.text += '\n\n'; asst._sep = false; asst.text += t; scheduleRender(asst); },
    think: t => { asst.thinking = (asst.thinking || '') + t; scheduleRender(asst); },
    media: x => { if (x.src) asst.media.push(x); },
  };
  const extra = [], tot = { in: 0, out: 0, reasoning: 0, cached: 0, ctx: 0 };
  let reported = false, step = 0;
  const run = tools.length ? startRun({ goal: userGoal(convo, asst), convoId: convo.id, msgId: asst.id, plan: convo.plan || [] }) : null;
  if (run) {
    auditNote(run, 'model', `${P.name} · ${model}`);
    if (run.plan.length) advancePlan(run, run.plan[0].id, 'doing');
  }
  for (;;) {
    let r;
    try { r = await callChat(provider, model, history, system, out, signal, { tools, extra }); }
    catch (e) {
      if (tools.length && e.name !== 'AbortError' && /tool|function/i.test(e.message)) e.message += '\n\nTip: this model may not support tools — turn off connectors (🔌) or pick another model.';
      throw e;
    }
    if (r.usage) { reported = true; tot.in += r.usage.in; tot.out += r.usage.out; tot.reasoning += r.usage.reasoning || 0; tot.cached += r.usage.cached || 0; tot.ctx = r.usage.in + r.usage.out; }
    asst._u = reported ? { ...tot } : null;
    if (!r.calls?.length || !tools.length) break;
    if (++step > (+S.maxToolSteps || 8)) { asst.text += `\n\n_⚠️ Stopped after ${step - 1} tool steps (change the limit in 🔌 Connectors)._`; break; }
    extra.push(r.native);
    const results = [];
    for (const c of r.calls) {
      const tool = tools.find(t => t.name === c.name);
      let label = ''; try { label = String(tool?.label?.(c.args) || '').slice(0, 100); } catch {}
      const card = { id: c.id, name: c.name, icon: tool?.icon || '🔧', connector: tool?.connector || 'Tool', label, args: JSON.stringify(c.args, null, 1).slice(0, 1500), status: 'running' };
      asst.tools = [...(asst.tools || []), card]; renderMessage(asst);
      const step = run ? startStep(run, { name: c.name, connector: card.connector, icon: card.icon, label, args: card.args }) : null;
      let res = null;
      if (!tool) res = { text: `Error: unknown tool "${c.name}".`, error: true };
      else if (tool.confirm && !alwaysAllow.has(tool.name) && !isTrusted(c.name)) {
        card.status = 'approve'; renderMessage(asst);
        notify('🔌 Approval needed', `${card.connector}: ${c.name}`);
        if (!await waitApproval(card.id, signal)) { res = { text: 'The user declined to run this tool.', error: true }; decideStep(run, step, 'declined'); }
        else decideStep(run, step, sessionTrust().allowAll ? 'auto' : 'once');
      } else {
        decideStep(run, step, sessionTrust().allowAll ? 'auto' : (alwaysAllow.has(tool.name) ? 'always' : 'trusted'));
      }
      if (!res) {
        card.status = 'running'; renderMessage(asst);
        res = await runTool(tool, c.args, { signal, progress: p => { card.progress = p; scheduleRender(asst); } });
      }
      card.status = res.error ? 'error' : 'ok'; card.result = res.text.slice(0, 4000); delete card.progress;
      endStep(run, step, res.error ? 'error' : 'ok', card.result);
      renderMessage(asst);
      results.push({ ...c, ...res });
    }
    extra.push(...toolResults(P.type, results));
    asst._sep = true;
  }
  if (!asst.text && !asst.media.length && !asst.tools?.length) asst.text = '_(empty response)_';
  if (run) {
    for (const m of asst.media || []) addArtifact(run, { kind: m.kind || 'file', name: m.kind === 'video' ? 'video.mp4' : 'image.png', data: m.src || (m.blob ? blobURL(m.blob) : ''), size: m.blob?.size || 0 });
    if (run.plan.length) for (const p of run.plan) if (p.status === 'todo' || p.status === 'doing') p.status = 'skipped';
  }
}
/** The user's goal for this turn — the last user message before the assistant reply. */
function userGoal(convo, asst) {
  const i = convo.messages.findIndex(m => m.id === asst.id);
  return (convo.messages.slice(0, i < 0 ? undefined : i).reverse().find(m => m.role === 'user')?.text || '').slice(0, 500);
}
const alwaysAllow = new Set(), approvals = new Map();
function waitApproval(id, signal) {
  return new Promise((res, rej) => {
    approvals.set(id, res);
    signal.addEventListener('abort', () => { approvals.delete(id); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}
function answerApproval(m, tid, allow, always) {
  const card = m?.tools?.find(c => c.id === tid), res = approvals.get(tid);
  if (!card || !res) return;
  if (always) { alwaysAllow.add(card.name); toast(`“${card.name}” will run without asking until you reload`); }
  else if (allow) trustOnce(card.name);
  approvals.delete(tid); res(allow);
}
const sizeToAspect = s => { const [w, h] = String(s).split('x').map(Number); if (!w || !h) return '1:1'; const r = w / h; return r > 1.5 ? '16:9' : r > 1.2 ? '4:3' : r < 0.67 ? '9:16' : r < 0.84 ? '3:4' : '1:1'; };

async function runImage(convo, user, asst, signal) {
  const { provider, model, size } = S.image, P = PROVIDERS[provider], prompt = (user.text || '').trim();
  const imgs = (user.atts || []).filter(a => a.kind === 'image');
  asst.meta = `${P.name} · ${model}`; asst.status = imgs.length ? 'Editing image…' : 'Generating image…'; renderMessage(asst);
  if (!prompt) throw new Error('Type a prompt describing the image.');
  if (!model) throw new Error('Pick an image model first.');
  const srcs = []; let usage = null;
  const collect = { text: t => asst.text += t, think: () => {}, media: x => srcs.push(x.src) };
  if (P.type === 'gemini') {
    if (/^imagen/.test(model)) {
      const j = await (await ok(await fetch(`${base(provider)}/models/${model}:predict`, { method: 'POST', headers: gHeaders(provider), signal,
        body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: sizeToAspect(size) } }) }))).json();
      for (const p of j.predictions || []) if (p.bytesBase64Encoded) srcs.push(`data:${p.mimeType || 'image/png'};base64,${p.bytesBase64Encoded}`);
    } else {
      const parts = [...imgs.map(a => { const { mime, b64 } = parseDataUrl(a.data); return { inline_data: { mime_type: mime, data: b64 } }; }), { text: prompt }];
      const j = await (await ok(await fetch(`${base(provider)}/models/${model}:generateContent`, { method: 'POST', headers: gHeaders(provider), signal,
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }) }))).json();
      geminiParts(j.candidates?.[0]?.content?.parts, collect);
      usage = geminiUsage(j.usageMetadata);
    }
  } else if (provider === 'openrouter') {
    // OpenRouter Image API — one endpoint for 60+ image models (Seedream, Flux, Recraft, GPT-Image, Gemini image, …).
    const body = { model, prompt, n: 1 };
    if (size && size !== 'auto') body.aspect_ratio = sizeToAspect(size);
    if (user.imgOpts?.background && user.imgOpts.background !== 'auto') body.background = user.imgOpts.background;
    if (imgs.length) body.input_references = imgs.map(a => ({ type: 'image_url', image_url: { url: a.data } }));
    let j;
    try {
      j = await (await ok(await fetch(base(provider) + '/images', { method: 'POST', headers: authHeaders(provider), signal,
        body: JSON.stringify(body) }))).json();
      for (const d of j.data || []) {
        if (d.b64_json) srcs.push(`data:${d.media_type || 'image/png'};base64,${d.b64_json}`);
        else if (d.url) srcs.push(await toDataUrlMaybe(d.url));
      }
      if (j.usage) { usage = { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0, cost: j.usage.cost }; }
    } catch (e) {
      if (e.name === 'AbortError' || signal.aborted) throw e;
      // Chat-completions fallback for models not yet on the Image API (e.g. older Gemini image previews).
      const content = [{ type: 'text', text: prompt }, ...imgs.map(a => ({ type: 'image_url', image_url: { url: a.data } }))];
      j = await (await ok(await fetch(base(provider) + '/chat/completions', { method: 'POST', headers: authHeaders(provider), signal,
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], modalities: ['image', 'text'] }) }))).json();
      const msg = j.choices?.[0]?.message;
      if (typeof msg?.content === 'string') asst.text = msg.content;
      for (const im of msg?.images || []) srcs.push(im.image_url?.url);
      if (j.usage) usage = { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0, cost: j.usage.cost };
    }
  } else if (P.type === 'openai') {
    let r;
    if (imgs.length && provider === 'openai') {
      const fd = new FormData(); fd.append('model', model); fd.append('prompt', prompt);
      if (size && size !== 'auto') fd.append('size', size);
      imgs.forEach((a, i) => fd.append(imgs.length > 1 ? 'image[]' : 'image', dataUrlToBlob(a.data), `image${i}.${(a.mime.split('/')[1] || 'png')}`));
      if (user.imgOpts?.mask) fd.append('mask', dataUrlToBlob(user.imgOpts.mask), 'mask.png');
      if (user.imgOpts?.background && /^gpt-image/.test(model)) fd.append('background', user.imgOpts.background);
      r = await fetch(base(provider) + '/images/edits', { method: 'POST', headers: authHeaders(provider, false), body: fd, signal });
    } else {
      const body = { model, prompt, n: 1 };
      if (size && size !== 'auto') body.size = size;
      if (!/^gpt-image/.test(model)) body.response_format = 'b64_json';
      r = await fetch(base(provider) + '/images/generations', { method: 'POST', headers: authHeaders(provider), body: JSON.stringify(body), signal });
    }
    const j = await (await ok(r)).json();
    for (const d of j.data || []) {
      if (d.b64_json) srcs.push('data:image/png;base64,' + d.b64_json); else if (d.url) srcs.push(await toDataUrlMaybe(d.url));
      if (d.revised_prompt) asst.text = '_' + d.revised_prompt + '_';
    }
    if (j.usage) usage = { in: j.usage.input_tokens || 0, out: j.usage.output_tokens || 0 };
  } else throw new Error(P.name + ' does not support image generation.');
  const good = srcs.filter(Boolean);
  if (!good.length) throw new Error('No image came back. ' + (asst.text ? '' : 'The prompt may have been blocked, or this model may not output images.'));
  asst.media.push(...good.map(src => ({ kind: 'image', src, prompt })));
  asst.usage = await recordUsage({ provider, model, kind: 'image', in: usage?.in || 0, out: usage?.out || 0,
    cost: usage?.cost, units: good.length, convoId: convo.id });
}

async function runVideo(convo, user, asst, signal) {
  const { provider, model, seconds, size } = S.video, P = PROVIDERS[provider], prompt = (user.text || '').trim();
  const img = (user.atts || []).find(a => a.kind === 'image');
  asst.meta = `${P.name} · ${model}`; asst.status = 'Submitting video job…'; renderMessage(asst);
  if (!prompt) throw new Error('Describe the video you want.');
  askNotifyPermission();
  let secs = +seconds || 8, cost;
  if (provider === 'openai') {
    const b = base(provider), h = authHeaders(provider, false);
    let res;
    if (img) {
      const fd = new FormData(); fd.append('model', model); fd.append('prompt', prompt); fd.append('seconds', String(seconds)); fd.append('size', size);
      fd.append('input_reference', dataUrlToBlob(img.data), img.name || 'reference.png');
      res = await fetch(b + '/videos', { method: 'POST', headers: h, body: fd, signal });
    } else res = await fetch(b + '/videos', { method: 'POST', headers: authHeaders(provider), body: JSON.stringify({ model, prompt, seconds: String(seconds), size }), signal });
    let job = await (await ok(res)).json();
    while (['queued', 'in_progress', 'processing', 'pending'].includes(job.status)) {
      asst.status = `Rendering video… ${Math.round(job.progress ?? 0)}%`; renderMessage(asst);
      await sleep(5000, signal);
      job = await (await ok(await fetch(`${b}/videos/${job.id}`, { headers: h, signal }))).json();
    }
    if (job.status !== 'completed') throw new Error('Video failed: ' + (job.error?.message || job.status));
    secs = +job.seconds || secs;
    asst.status = 'Downloading video…'; renderMessage(asst);
    const blob = await (await ok(await fetch(`${b}/videos/${job.id}/content`, { headers: h, signal }))).blob();
    asst.media.push({ kind: 'video', blob, prompt });
  } else if (P.type === 'gemini') {
    const inst = { prompt };
    if (img) { const p = parseDataUrl(img.data); inst.image = { bytesBase64Encoded: p.b64, mimeType: p.mime }; }
    const b = base(provider);
    let op = await (await ok(await fetch(`${b}/models/${model}:predictLongRunning`, { method: 'POST', headers: gHeaders(provider), signal,
      body: JSON.stringify({ instances: [inst], parameters: { aspectRatio: sizeToAspect(size) === '9:16' ? '9:16' : '16:9' } }) }))).json();
    let t = 0;
    while (!op.done) {
      asst.status = `Rendering video… ${t}s`; renderMessage(asst);
      await sleep(8000, signal); t += 8;
      op = await (await ok(await fetch(`${b}/${op.name}`, { headers: gHeaders(provider, false), signal }))).json();
    }
    if (op.error) throw new Error(op.error.message || 'Video failed');
    const r = op.response?.generateVideoResponse || op.response;
    let uri = r?.generatedSamples?.[0]?.video?.uri || r?.generatedVideos?.[0]?.video?.uri;
    if (!uri) throw new Error('No video returned' + (r?.raiMediaFilteredReasons ? ': ' + r.raiMediaFilteredReasons.join(', ') : ' (possibly blocked by safety filters).'));
    if (viaProxy(provider) && uri.startsWith(PROVIDERS.gemini.base)) uri = b + uri.slice(PROVIDERS.gemini.base.length);
    secs = 8;
    asst.status = 'Downloading video…'; renderMessage(asst);
    try { const blob = await (await ok(await fetch(uri, { headers: gHeaders(provider, false), signal }))).blob(); asst.media.push({ kind: 'video', blob, prompt }); }
    catch (e) {
      if (e.name === 'AbortError' || viaProxy(provider)) throw e;
      asst.media.push({ kind: 'video', src: uri + (uri.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key(provider)), prompt });
      asst.text = '_Download this video soon — Google links expire after ~2 days._';
    }
  } else if (provider === 'openrouter') {
    // OpenRouter Video API — async job over 30 models (Veo, Seedance, Wan, Kling, Hailuo, Sora, Runway, Flux…).
    const b = base(provider), h = authHeaders(provider, false);
    const body = { model, prompt, duration: secs };
    if (size && size !== 'auto') body.size = size;
    if (img) body.frame_images = [{ type: 'image_url', image_url: { url: img.data }, frame_type: 'first_frame' }];
    let job = await (await ok(await fetch(b + '/videos', { method: 'POST', headers: authHeaders(provider), body: JSON.stringify(body), signal }))).json();
    const pollUrl = job.polling_url || `${b}/videos/${job.id}`;
    let t = 0;
    while (['pending', 'in_progress', 'queued', 'processing'].includes(job.status)) {
      asst.status = `Rendering video… ${t}s`; renderMessage(asst);
      await sleep(8000, signal); t += 8;
      job = await (await ok(await fetch(pollUrl, { headers: h, signal }))).json();
      secs = +job.duration || secs;
    }
    if (job.status !== 'completed') throw new Error('Video failed: ' + ((job.error && (job.error.message || job.error)) || job.status));
    asst.status = 'Downloading video…'; renderMessage(asst);
    const dl = job.unsigned_urls?.[0] || `${b}/videos/${job.id}/content`;
    const blob = await (await ok(await fetch(dl, { headers: h, signal }))).blob();
    asst.media.push({ kind: 'video', blob, prompt });
    cost = job.usage?.cost;
  } else throw new Error(`${P.name} doesn't support video here. Use OpenAI (Sora), Google (Veo) or OpenRouter.`);
  asst.usage = await recordUsage({ provider, model, kind: 'video', units: secs, cost, convoId: convo.id });
  notify('🎬 Your video is ready', prompt.slice(0, 80));
}

/* ---------- Turn orchestration ---------- */
let voiceActive = false;
function ensureConvo() { if (!cur) { cur = { id: uid(), title: 'New chat', messages: [], updated: Date.now(), projectId: currentProject()?.id || '', kbIds: [...draftKb.kbIds], kbOff: [...draftKb.kbOff] }; draftKb = { kbIds: [], kbOff: [] }; convos.unshift(cur); } return cur; }
async function saveConvo(c) {
  try { delete c.imgOptsTmp; await DB.put('convos', stripForSave(c)); dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'convos', id: c.id } })); }
  catch (e) { console.error(e); log('error', 'Could not save chat', e.message); toast('Could not save chat: ' + e.message); }
}
/** Structured-clone-safe copy (keeps Blobs, drops transient _fields). */
function stripForSave(c) {
  return { ...c, messages: c.messages.map(m => { const o = {}; for (const k in m) if (!k.startsWith('_') && k !== 'pending' && k !== 'status') o[k] = m[k]; return o; }) };
}
async function send() {
  if (busy) { abortCtl?.abort(); return; }
  const text = input.value.trim();
  if (!text && !pending.length) return;
  if (/^\/\S*$/.test(text) && slashItems.length) { pickSlash(slashIdx); return; }
  stopSpeak(); hideSlash();
  const convo = ensureConvo();
  const user = { id: uid(), role: 'user', text, atts: pending, mode, ts: Date.now() };
  pending = []; renderAttachBar(); input.value = ''; autosize(); LS.set('nova.draft', '');
  if (convo.title === 'New chat') convo.title = (text || user.atts[0]?.name || 'Untitled').replace(/\s+/g, ' ').slice(0, 50);
  convo.messages.push(user);
  navigator.vibrate?.(8);
  return await runTurn(convo, user, mode);
}
async function runTurn(convo, user, runMode) {
  const asst = { id: uid(), role: 'assistant', text: '', media: [], meta: '', mode: runMode, pending: true, status: '', ts: Date.now() };
  convo.messages.push(asst); renderMessages(); scrollBottom(); renderConvoList();
  setBusy(true); abortCtl = new AbortController(); const signal = abortCtl.signal;
  try {
    if (runMode === 'chat') await runChat(convo, asst, signal);
    else if (runMode === 'image') await runImage(convo, user, asst, signal);
    else await runVideo(convo, user, asst, signal);
  } catch (e) {
    console.error(e);
    if (e.name === 'AbortError') asst.text += (asst.text ? '\n\n' : '') + '_⏹ Stopped_';
    else asst.error = (e instanceof TypeError && /fetch|network|load/i.test(e.message))
      ? `Network/CORS error: ${e.message}. Check the API key, base URL and your connection — or this provider may not allow direct browser requests (use the Nova server proxy).`
      : (e.message || String(e));
  }
  if (runMode === 'chat' && (asst._u || asst.text || asst.thinking || asst.tools?.length)) {
    const u = asst._u;
    asst.usage = await recordUsage({ provider: asst.provider, model: asst.model, kind: 'chat', convoId: convo.id,
      in: u?.in ?? asst._estIn ?? 0, out: u?.out ?? estimateTokens((asst.text || '') + (asst.thinking || '')),
      reasoning: u?.reasoning || 0, cached: u?.cached || 0, ctx: u?.ctx || 0, est: !u });
  }
  delete asst.pending; delete asst.status;
  setBusy(false); abortCtl = null; convo.updated = Date.now();
  const r = runForMsg(convo.id, asst.id);
  if (r) endRun(r, asst.error ? 'error' : 'done', asst.error);
  renderMessage(asst); renderConvoList(); updatePill(); await saveConvo(convo);
  if (runMode === 'chat' && S.tts.auto && asst.text && !asst.error && !voiceActive) speak(asst.text, asst.id);
  return asst;
}
async function regenerate(id) {
  if (busy || !cur) return;
  const i = cur.messages.findIndex(x => x.id === id); if (i < 1) return;
  const user = cur.messages[i - 1]; if (user.role !== 'user') return;
  const m = cur.messages[i].mode || 'chat';
  cur.messages.splice(i);
  await runTurn(cur, user, m);
}
let wakeLock = null;
async function setBusy(b) {
  busy = b; sendBtn.textContent = b ? '■' : '➤'; sendBtn.classList.toggle('stop', b);
  sendBtn.title = b ? 'Stop (Esc)' : 'Send'; sendBtn.setAttribute('aria-label', sendBtn.title);
  try { if (b && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); else if (!b && wakeLock) { await wakeLock.release(); wakeLock = null; } } catch { wakeLock = null; }
}

/* ---------- Rendering ---------- */
const blobUrls = new WeakMap();
function blobURL(b) { if (!blobUrls.has(b)) blobUrls.set(b, URL.createObjectURL(b)); return blobUrls.get(b); }
function attHTML(a) {
  if (a.kind === 'image') return `<img class="attimg" src="${a.data}" alt="${esc(a.name)}" data-act="zoom">`;
  if (a.kind === 'audio') return `<div class="att">🎵<audio controls src="${a.data}"></audio></div>`;
  return `<div class="att">${attIcon(a.kind)}<span>${esc(a.name)}</span></div>`;
}
function mediaHTML(x) {
  const src = x.blob ? blobURL(x.blob) : x.src; if (!src) return '';
  if (x.kind === 'video') return `<figure><video controls playsinline src="${esc(src)}"></video><a class="dl" href="${esc(src)}" download="nova-video.mp4" target="_blank" aria-label="Download video">⬇</a></figure>`;
  const ext = (parseDataUrl(src).mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return `<figure><img src="${esc(src)}" alt="${esc(x.prompt || 'generated image')}" loading="lazy" data-act="zoom"><button class="dl tlb" data-act="imgtools" aria-label="Image tools" title="Image tools">🛠</button><a class="dl" href="${esc(src)}" download="nova-image.${ext}" target="_blank" aria-label="Download image">⬇</a></figure>`;
}
function usageLabel(m) {
  const u = m.usage; if (!u) return '';
  const c = costOf(u), parts = [];
  if (u.in || u.out) parts.push(`↑${fmtNum(u.in)} ↓${fmtNum(u.out)}${u.est ? '≈' : ''}`);
  if (u.units && u.kind !== 'chat') parts.push(`${fmtNum(u.units)} ${{ image: 'img', video: 's', tts: 'chars', stt: 's' }[u.kind] || ''}`);
  if (c != null) parts.push(fmtUSD(c));
  return `<span class="tok" title="${u.est ? 'Estimated — provider did not report usage' : 'Reported by provider'}${u.reasoning ? ` · ${u.reasoning} reasoning tokens` : ''}">${parts.join(' · ')}</span>`;
}
const TOOL_ST = { ok: '✓', error: '⚠️', approve: '✋' };
function toolCardHTML(c) {
  const st = c.status === 'running' ? `<span class="dots"><i></i><i></i><i></i></span>${esc(c.progress || '')}` : TOOL_ST[c.status] || '';
  let body = '';
  if (c.status === 'approve') body = `<div class="approve"><p>Allow <b>${esc(c.connector)}</b> to run <code>${esc(c.name)}</code> with:</p><pre>${esc(c.args || '{}')}</pre>
    <div class="inrow wrap"><button class="btn sm primary" data-act="tool-allow" data-tid="${esc(c.id)}">Allow once</button><button class="btn sm" data-act="tool-always" data-tid="${esc(c.id)}">Always allow</button><button class="btn sm danger" data-act="tool-deny" data-tid="${esc(c.id)}">Deny</button></div></div>`;
  else if (c.result != null) body = `<div class="tbody"><small>Input</small><pre>${esc(c.args || '{}')}</pre><small>Result</small><pre>${esc(c.result)}</pre></div>`;
  return `<details class="toolcard ${c.status}" ${c.status === 'approve' ? 'open' : ''}><summary><span class="ti">${c.icon}</span><span class="tn"><b>${esc(c.connector)}</b> ${esc(c.label || c.name)}</span><span class="ts">${st}</span></summary>${body}</details>`;
}
/** Collapsed plan strip shown on a live run; the run modal has the editable list. */
function planStripHTML(run) {
  if (!run?.plan?.length) return '';
  const done = run.plan.filter(p => p.status === 'done' || p.status === 'skipped').length;
  return `<button class="planstrip" data-act="openrun" data-rid="${esc(run.id)}" title="Open run details">
    <span class="psbar"><i style="width:${Math.round(done / run.plan.length * 100)}%"></i></span>
    <span class="pstext">📋 ${done}/${run.plan.length} plan steps · ${run.steps.length} tool step${run.steps.length === 1 ? '' : 's'}</span></button>`;
}
function msgHTML(m) {
  const u = m.role === 'user';
  let h = `<div class="msg ${m.role}" id="m-${m.id}">` + (u ? '' : '<div class="avatar" aria-hidden="true">⚡</div>') + '<div class="bubble">';
  if (m.atts?.length) h += `<div class="atts">${m.atts.map(attHTML).join('')}</div>`;
  if (m.thinking) h += `<details class="think" ${m.pending && !m.text ? 'open' : ''}><summary>💭 ${m.pending && !m.text ? 'Thinking…' : 'Reasoning'}</summary><div class="md">${md(m.thinking)}</div></details>`;
  if (m.tools?.length) h += `<div class="tools">${m.tools.map(toolCardHTML).join('')}</div>`;
  if (!u && m.pending) h += planStripHTML(runForMsg(convo.id, m.id));
  if (m.text) h += u ? `<div class="utext">${esc(m.text).replace(/\n/g, '<br>')}</div>` : `<div class="md">${md(m.text)}</div>`;
  if (m.media?.length) h += `<div class="media">${m.media.map(mediaHTML).join('')}</div>`;
  if (m.sources?.length && !m.pending) h += `<div class="sources"><span>📚</span>${m.sources.map(x => `<button class="chip sm" data-act="source" data-n="${x.n}" title="${esc(x.text.slice(0, 200))}">[${x.n}] ${esc(x.doc)}${x.page ? ' · ' + esc(x.page) : ''}</button>`).join('')}</div>`;
  if (m.pending && (!m.text || m.status)) h += `<div class="status"><span class="dots"><i></i><i></i><i></i></span>${esc(m.status || '')}</div>`;
  if (m.error) h += `<div class="error">⚠️ ${esc(m.error)}</div>`;
  if (!m.pending) {
    const speakBtn = m.text ? `<button data-act="speak" title="Read aloud" aria-label="Read aloud" class="${speakingId === m.id ? 'on' : ''}">${speakingId === m.id ? '⏹' : '🔊'}</button>` : '';
    h += u
      ? `<div class="actions"><span class="meta">${m.ts ? timeStr(m.ts) : ''}</span><button data-act="copy" title="Copy" aria-label="Copy">📋</button><button data-act="edit" title="Edit & resend" aria-label="Edit">✏️</button><button data-act="delete" title="Delete" aria-label="Delete">🗑</button></div>`
      : `<div class="actions">${m.text ? '<button data-act="copy" title="Copy" aria-label="Copy">📋</button>' : ''}${speakBtn}<button data-act="retry" title="Regenerate with current model" aria-label="Regenerate">↻</button><button data-act="delete" title="Delete" aria-label="Delete">🗑</button><span class="meta">${esc(m.meta || '')}${m.ts ? ' · ' + timeStr(m.ts) : ''}${m.usage ? ' · ' : ''}${usageLabel(m)}</span></div>`;
  }
  return h + '</div></div>';
}
const EXT = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', html: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', shell: 'sh', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', rust: 'rs', php: 'php', ruby: 'rb', sql: 'sql', yaml: 'yml', xml: 'xml', markdown: 'md', kotlin: 'kt', swift: 'swift' };
function linkCitations(el, n) {
  const walker = document.createTreeWalker(el.querySelector('.bubble > .md') || el, NodeFilter.SHOW_TEXT);
  const nodes = []; let t; while ((t = walker.nextNode())) if (/\[\d+\]/.test(t.nodeValue) && !t.parentElement.closest('pre,code,a')) nodes.push(t);
  for (const node of nodes) {
    const frag = document.createDocumentFragment(); let last = 0;
    node.nodeValue.replace(/\[(\d+)\]/g, (m, d, i) => {
      if (+d < 1 || +d > n) return m;
      frag.append(node.nodeValue.slice(last, i));
      const b = document.createElement('button'); b.className = 'cite'; b.dataset.act = 'source'; b.dataset.n = d; b.textContent = d; frag.append(b);
      last = i + m.length; return m;
    });
    if (last) { frag.append(node.nodeValue.slice(last)); node.replaceWith(frag); }
  }
}
function decorate(el, final) {
  if (!el) return;
  el.querySelectorAll('.md pre').forEach(pre => {
    if (pre.querySelector('.codebar')) { if (final && !pre.querySelector('.run')) pre.querySelector('.codebar').remove(); else return; }
    const code = pre.querySelector('code'), lang = (code?.className.match(/language-([\w+#-]+)/) || [])[1] || '';
    const runnable = RUNNABLE.test(lang) || (!lang && /^\s*<(!doctype|html|svg)/i.test(code?.textContent || ''));
    pre.insertAdjacentHTML('afterbegin', `<div class="codebar"><span>${esc(lang || 'code')}</span>${runnable && final ? `<button data-act="runcode" data-lang="${esc(lang || 'html')}" class="run">▶ Run</button>` : ''}<button data-act="copycode">Copy</button><button data-act="dlcode" data-ext="${EXT[lang.toLowerCase()] || 'txt'}" aria-label="Download code">⬇</button></div>`);
  });
  if (final) {
    if (window.hljs) el.querySelectorAll('.md pre code').forEach(c => { try { hljs.highlightElement(c); } catch {} });
    renderMath(el);
    const msg = cur?.messages.find(x => 'm-' + x.id === el.id);
    if (msg?.sources?.length) linkCitations(el, msg.sources.length);
  }
}
function welcomeHTML() {
  const proj = currentProject();
  if (proj) return `<div class="welcome"><div class="logo">${esc(proj.icon || '📁')}</div><h1>${esc(proj.name)}</h1><p>${esc((proj.instructions || 'New chats here use this project\'s instructions' + (proj.model ? ' and model' : '') + '.').slice(0, 220))}</p>
    <div class="inrow wrap center"><button class="btn" data-act="projedit">⚙️ Project settings</button>${proj.kbIds?.length ? `<span class="chip sm on">📚 ${proj.kbIds.length} knowledge base${proj.kbIds.length > 1 ? 's' : ''}</span>` : ''}${proj.model ? `<span class="chip sm">🤖 ${esc(proj.model.model)}</span>` : ''}</div></div>`;
  const anyKey = Object.keys(PROVIDERS).some(id => S.keys[id]) || hasKey('custom') || serverKeys.size;
  return `<div class="welcome"><div class="logo">⚡</div><h1>Nova Studio</h1><p>Your own AI studio — any provider, any model. Chat, images, video, voice, files, connectors & skills.</p>
  ${anyKey ? '' : '<button class="btn primary" data-act="settings">🔑 Add your first API key</button>'}
  <div class="cards">
    <button class="card" data-act="try" data-mode="chat" data-p="Explain how black holes form, simply.">💬<b>Chat</b><span>Files, photos, PDFs, audio</span></button>
    <button class="card" data-act="try" data-mode="image" data-p="A cozy night market in Kuala Lumpur in the rain, neon reflections, cinematic photo">🎨<b>Image</b><span>Generate or edit pictures</span></button>
    <button class="card" data-act="try" data-mode="video" data-p="Slow drone shot gliding over misty rainforest hills at sunrise, birds flying">🎬<b>Video</b><span>Sora or Veo</span></button>
    <button class="card" data-act="files">📁<b>My files</b><span>Explore, filter & scan this device</span></button>
    <button class="card" data-act="knowledge">📚<b>Chat with documents</b><span>Answers with page citations</span></button>
    <button class="card" data-act="voice">🎧<b>Live voice</b><span>Talk hands-free</span></button>
  </div>
  <p class="hint tip">Tip: type <kbd>/</kbd> for commands and skills</p></div>`;
}
function renderMessages() {
  messagesEl.innerHTML = cur?.messages.length ? cur.messages.map(msgHTML).join('') : welcomeHTML();
  messagesEl.querySelectorAll('.msg').forEach(el => decorate(el, true));
  updatePill(); updateFab(); renderSkillBar(); updateChip();
}
function renderMessage(m) {
  const el = document.getElementById('m-' + m.id); if (!el) return;
  const near = isNearBottom(); el.outerHTML = msgHTML(m);
  decorate(document.getElementById('m-' + m.id), !m.pending);
  if (near) scrollBottom();
}
const rafPending = new Set();
function scheduleRender(m) { if (rafPending.has(m)) return; rafPending.add(m); requestAnimationFrame(() => { rafPending.delete(m); renderMessage(m); }); }
const isNearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
function scrollBottom(smooth) { messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }
function updateFab() { $('#fab').hidden = isNearBottom(); }
function renderConvoList() {
  convos.sort((a, b) => b.updated - a.updated);
  const q = $('#search').value.trim().toLowerCase();
  const pid = currentProject()?.id, scoped = pid ? convos.filter(c => c.projectId === pid) : convos;
  const list = q ? scoped.filter(c => (c.title || '').toLowerCase().includes(q) || c.messages.some(m => (m.text || '').toLowerCase().includes(q))) : scoped;
  const group = c => { const d = c.updated; return d >= dayStart() ? 'Today' : d >= dayStart(1) ? 'Yesterday' : d >= dayStart(6) ? 'This week' : 'Older'; };
  let last = '', html = '';
  for (const c of list) {
    const g = group(c); if (g !== last) { html += `<div class="cgroup">${g}</div>`; last = g; }
    html += `<div class="convo ${c === cur ? 'active' : ''}" data-id="${c.id}" role="button" tabindex="0"><span>${esc(c.title || 'Untitled')}</span><button class="icon sm" data-ren="${c.id}" title="Rename" aria-label="Rename">✏️</button><button class="icon sm" data-del="${c.id}" title="Delete" aria-label="Delete">🗑</button></div>`;
  }
  $('#convoList').innerHTML = html || `<p class="hint pad">${q ? 'No matches' : 'No chats yet'}</p>`;
}
function updateChip() {
  const c = mode === 'chat' ? chatModelFor(cur || { projectId: currentProject()?.id }) : S[mode], P = PROVIDERS[c.provider];
  $('#modelChip').innerHTML = `<span class="dot ${hasKey(c.provider) ? 'ok' : ''}" aria-hidden="true"></span><b>${esc(c.model || 'Pick a model')}</b><small>${esc(P?.name || '')}${viaProxy(c.provider) ? ' 🔒' : ''}</small><span aria-hidden="true">▾</span>`;
}
function convoTotals(c) {
  let tokens = 0, cost = 0;
  for (const m of c?.messages || []) if (m.usage) { tokens += (m.usage.in || 0) + (m.usage.out || 0); cost += costOf(m.usage) || 0; }
  return { tokens, cost };
}
function updatePill() {
  const pill = $('#usagePill'), t = cur ? convoTotals(cur) : null;
  const today = sum(since(dayStart()));
  const [tok, cost, label] = t && t.tokens ? [t.tokens, t.cost, 'this chat'] : [today.in + today.out, today.cost, 'today'];
  pill.className = 'pill lvl-' + budgetLevel();
  pill.innerHTML = `🪙 <b>${fmtNum(tok)}</b><small>${fmtUSD(cost)}</small>`;
  pill.title = `Usage ${label}: ${fmtNum(tok)} tokens, ${fmtUSD(cost)} — tap for dashboard`;
}
function contextInfo() {
  if (!cur?.messages.length) return null;
  const model = S.chat.model;
  const lastA = [...cur.messages].reverse().find(m => m.role === 'assistant' && m.usage?.kind === 'chat');
  const exact = lastA && !lastA.usage.est;
  const t = convoTotals(cur);
  return { model, limit: contextFor(model), tokens: exact ? (lastA.usage.ctx || lastA.usage.in + lastA.usage.out) : estimateContext(cur), est: !exact, chatTokens: t.tokens, chatCost: t.cost };
}
function renderSkillBar() {
  const bar = $('#skillBar');
  if (mode === 'chat') bar.innerHTML = skills.filter(s => s.enabled).map(s => `<button class="chip on" data-skill-off="${s.id}" title="Turn off ${esc(s.name)}">${esc(s.icon)} ${esc(s.name)} ✕</button>`).join('') + '<button class="chip" data-act-skills>🧩 Skills</button>'
    + (() => { const n = enabledCount(); return `<button class="chip ${n ? 'on' : ''}" data-act-connectors title="Connectors">🔌 ${n ? n + ' on' : 'Connectors'}</button>`; })()
    + activeKbIds(cur).map(id => `<button class="chip on" data-kb-off="${id}" title="Stop using this knowledge base in this chat">📚 ${esc(kbById(id).name)} ✕</button>`).join('')
    + (S.reasoning ? `<button class="chip" data-act-settings title="Reasoning effort">💭 ${esc(S.reasoning)}</button>` : '');
  else bar.innerHTML = `<button class="chip" id="enhBtn">✨ Enhance prompt</button><button class="chip" data-act-picker>${mode === 'image' ? '📐 ' + esc(S.image.size) : '⏱ ' + esc(S.video.seconds) + 's · ' + esc(S.video.size)}</button>`;
}
function setMode(m) {
  mode = ['chat', 'image', 'video'].includes(m) ? m : 'chat'; LS.set('nova.mode', mode);
  $$('#modes button').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-pressed', b.dataset.mode === mode); });
  input.placeholder = { chat: 'Message…  (/ for commands)', image: 'Describe an image… (attach a photo to edit it)', video: 'Describe a video scene… (attach an image to animate)' }[mode];
  updateChip(); renderSkillBar();
}
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; }
function applyTheme() {
  const t = S.theme === 'system' ? '' : S.theme;
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('meta[name=theme-color]').content = dark ? '#0a0c11' : '#f6f7fb';
}

/* ---------- Slash menu ---------- */
const COMMANDS = [
  { key: 'new', icon: '✏️', label: 'New chat', run: () => newChat() },
  { key: 'chat', icon: '💬', label: 'Switch to Chat', run: () => setMode('chat') },
  { key: 'image', icon: '🎨', label: 'Switch to Image', run: () => setMode('image') },
  { key: 'video', icon: '🎬', label: 'Switch to Video', run: () => setMode('video') },
  { key: 'model', icon: '🤖', label: 'Choose model', run: () => openPicker() },
  { key: 'usage', icon: '📊', label: 'Usage & cost dashboard', run: () => openUsage() },
  { key: 'skills', icon: '🧩', label: 'Manage skills', run: () => openSkills() },
  { key: 'files', icon: '📁', label: 'My files — explore, filter & scan', run: () => openExplorer() },
  { key: 'connectors', icon: '🔌', label: 'Connectors & MCP servers', run: () => openConnectors() },
  { key: 'gallery', icon: '🖼️', label: 'Gallery of generated images & videos', run: () => openGallery() },
  { key: 'knowledge', icon: '📚', label: 'Knowledge bases — chat with documents', run: () => openKB() },
  { key: 'compare', icon: '⚖️', label: 'Compare models side by side', run: () => openCompare() },
  { key: 'voice', icon: '🎧', label: 'Live voice conversation', run: () => startVoice() },
  { key: 'tasks', icon: '⏰', label: 'Scheduled tasks', run: () => openTasks() },
  { key: 'runs', icon: '▶', label: 'Runs — plan, steps & audit', run: () => openRuns() },
  { key: 'share', icon: '🔗', label: 'Share this chat', run: () => shareChat() },
  { key: 'sync', icon: '🔄', label: 'Sync now', run: () => syncActive() ? syncNow(true) : openSettings('account') },
  { key: 'project', icon: '📁', label: 'New project', run: () => editProject(null) },
  { key: 'logs', icon: '🐞', label: 'Error logs', run: () => openLogs() },
  { key: 'lock', icon: '🔒', label: 'Lock the key vault', run: () => vaultOn() ? lockNow() : openSettings('security') },
  { key: 'settings', icon: '⚙️', label: 'Settings', run: () => openSettings() },
  { key: 'export', icon: '⬇', label: 'Export this chat (Markdown)', run: () => exportChatMD() },
];
let slashItems = [], slashIdx = 0;
function updateSlash() {
  const m = /^\/(\S*)$/.exec(input.value);
  if (!m) return hideSlash();
  const q = m[1].toLowerCase();
  slashItems = [
    ...COMMANDS.map(c => ({ ...c, type: 'cmd' })),
    ...skills.map(s => ({ type: 'skill', key: s.name.toLowerCase().replace(/\s+/g, '-'), icon: s.icon, label: `${s.enabled ? 'Turn off' : 'Turn on'} “${s.name}” skill`, skill: s })),
  ].filter(i => i.key.includes(q) || i.label.toLowerCase().includes(q)).slice(0, 12);
  slashIdx = 0;
  if (!slashItems.length) return hideSlash();
  renderSlash();
}
function renderSlash() {
  const el = $('#slashMenu');
  el.innerHTML = slashItems.map((it, i) => `<button role="option" aria-selected="${i === slashIdx}" class="${i === slashIdx ? 'sel' : ''}" data-i="${i}"><span>${esc(it.icon)}</span><b>/${esc(it.key)}</b><small>${esc(it.label)}</small></button>`).join('');
  el.hidden = false;
  el.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function hideSlash() { $('#slashMenu').hidden = true; slashItems = []; }
function pickSlash(i) {
  const it = slashItems[i]; if (!it) return;
  input.value = ''; autosize(); hideSlash();
  if (it.type === 'skill') { it.skill.enabled = !it.skill.enabled; saveSkills(); renderSkillBar(); toast(`${it.skill.icon} ${it.skill.name} ${it.skill.enabled ? 'on' : 'off'}`); }
  else it.run();
  input.focus();
}

/* ---------- Model picker ---------- */
async function listModels(pid) {
  const P = PROVIDERS[pid];
  if (P.type === 'anthropic') { const j = await (await ok(await fetch(base(pid) + '/models?limit=100', { headers: aHeaders(pid) }))).json(); return (j.data || []).map(x => x.id); }
  if (P.type === 'gemini') { const j = await (await ok(await fetch(base(pid) + '/models?pageSize=1000', { headers: gHeaders(pid, false) }))).json(); return (j.models || []).map(m => m.name.replace(/^models\//, '')); }
  if (P.type === 'openai') { const j = await (await ok(await fetch(base(pid) + '/models', { headers: authHeaders(pid, false) }))).json(); return (j.data || j.models || []).map(x => x.id || x.name).filter(Boolean).sort(); }
  return [];
}
/** OpenRouter takes exact pixel sizes like the other video providers. */
const vidSizes = () => ['1280x720', '720x1280', '1792x1024', '1024x1792'];
/** OpenRouter serves image and video models from separate catalogues. */
async function listModelsByMode(pid, mode) {
  if (pid !== 'openrouter' || !['image', 'video'].includes(mode)) return null;
  const j = await (await ok(await fetch(`${base(pid)}/models?output_modalities=${mode}`, { headers: authHeaders(pid, false) }))).json();
  return (j.data || []).map(x => x.id).filter(Boolean).sort();
}
function openPicker() {
  const cfg = S[mode], opts = Object.entries(PROVIDERS).filter(([, p]) => p.models[mode]);
  const sel = (list, v) => list.map(x => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('');
  openModal(`<div class="dlg-title"><h2>${MODE_LABEL[mode]} model</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <label>Provider<select id="pk-prov">${opts.map(([id, p]) => `<option value="${id}" ${id === cfg.provider ? 'selected' : ''}>${esc(p.name)}${hasKey(id) ? (viaProxy(id) ? ' 🔒' : ' ✓') : ''}</option>`).join('')}</select></label>
    <label>Model ID<div class="inrow"><input id="pk-model" value="${esc(cfg.model)}" placeholder="type or pick a model id" autocomplete="off" spellcheck="false"><button class="btn" id="pk-fetch" title="Load all models from provider">🔄 Load all</button></div></label>
    <div id="pk-info" class="hint"></div>
    <div id="pk-models" class="modelgrid"></div>
    ${mode === 'image' ? `<label>Size<select id="pk-size">${sel(['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', '512x512'], cfg.size)}</select></label>` : ''}
    ${mode === 'video' ? `<div class="grid2"><label>Seconds<select id="pk-sec">${sel(['4', '6', '8', '10', '12'], cfg.seconds)}</select></label><label>Size<select id="pk-vsize">${sel(vidSizes(), cfg.size)}</select></label></div>` : ''}
    <p id="pk-warn" class="hint"></p>
    <div class="dlg-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pk-save">Use this model</button></div>`);
  const prov = $('#pk-prov'), mdl = $('#pk-model');
  const fetchedFor = pid => S.fetched[mode === 'image' || mode === 'video' ? `${pid}:${mode}` : pid] || [];
  const fill = () => {
    const pid = prov.value, q = mdl.value.toLowerCase();
    const fetched = fetchedFor(pid);
    const all = [...new Set([...(PROVIDERS[pid].models[mode] || []).filter(Boolean), ...fetched])];
    const shown = (q && fetched.length ? all.filter(m => m.toLowerCase().includes(q)) : all).slice(0, 80);
    $('#pk-models').innerHTML = shown.map(m => `<button class="chip sm ${m === mdl.value ? 'on' : ''}" data-m="${esc(m)}">${esc(m)}</button>`).join('');
    const pr = mdl.value && costOf({ model: mdl.value, in: 1e6, out: 0 }), po = mdl.value && costOf({ model: mdl.value, in: 0, out: 1e6 });
    $('#pk-info').innerHTML = mode === 'chat' && mdl.value ? `Context ≈ ${fmtNum(contextFor(mdl.value))} tokens · ${pr != null ? `${fmtUSD(pr)} in / ${fmtUSD(po)} out per 1M` : 'no price set (Usage → Prices)'}` : '';
    $('#pk-warn').innerHTML = hasKey(pid) ? '' : `⚠️ No API key / URL for ${esc(PROVIDERS[pid].name)} yet — <a href="#" id="pk-gokey">add it in Settings</a>.`;
  };
  fill();
  prov.onchange = () => { mdl.value = (PROVIDERS[prov.value].models[mode] || [''])[0]; fill(); };
  mdl.oninput = fill;
  $('#pk-models').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { mdl.value = b.dataset.m; fill(); } };
  $('#pk-warn').onclick = e => { if (e.target.id === 'pk-gokey') { e.preventDefault(); openSettings(); } };
  $('#pk-fetch').onclick = async () => {
    const pid = prov.value, b = $('#pk-fetch'); b.disabled = true; b.textContent = '…';
    try {
      const byMode = ['image', 'video'].includes(mode);
      const l = await (listModelsByMode(pid, mode) || listModels(pid));
      S.fetched[byMode ? `${pid}:${mode}` : pid] = l;
      saveSettings(); fill(); toast(`${l.length} ${mode} models loaded — type to filter`);
    } catch (e) { toast(e.message, 4500); }
    b.disabled = false; b.textContent = '🔄 Load all';
  };
  $('#pk-save').onclick = () => {
    cfg.provider = prov.value; cfg.model = mdl.value.trim();
    if (mode === 'image') cfg.size = $('#pk-size').value;
    if (mode === 'video') { cfg.seconds = $('#pk-sec').value; cfg.size = $('#pk-vsize').value; }
    saveSettings(); updateChip(); renderSkillBar(); closeModal();
  };
}

/* ---------- Settings ---------- */
function openSettings(section) {
  const opt = (list, v) => list.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  const keyRows = Object.entries(PROVIDERS).map(([id, p]) => `<div class="keyrow">
    <div class="kname"><span>${esc(p.name)} ${serverKeys.has(id) ? '<span class="badge ok">🔒 server key</span>' : ''}</span>${p.link ? `<a href="${p.link}" target="_blank" rel="noopener">get key ↗</a>` : ''}</div>
    ${id === 'ollama' ? '' : `<div class="inrow"><input type="password" data-key="${id}" value="${esc(S.keys[id] || '')}" placeholder="${serverKeys.has(id) ? 'Using server key (optional override off)' : p.keyless ? 'API key (optional)' : 'Paste API key'}" autocomplete="off" spellcheck="false"><button class="btn sm" data-eye aria-label="Show key">👁</button></div>`}
    ${id === 'custom' || id === 'ollama' ? `<input data-base="${id}" value="${esc(S.bases[id] || '')}" placeholder="Base URL ${esc(p.base || 'e.g. https://my-server.com/v1')}">` : ''}
  </div>`).join('');
  const ttsOpts = [['browser', 'Browser (free, offline)'], ['openai', 'OpenAI'], ['gemini', 'Google Gemini'], ['elevenlabs', 'ElevenLabs'], ['custom', 'Custom OpenAI-compatible']];
  const sttOpts = [['browser', 'Browser (free)'], ['openai', 'OpenAI'], ['groq', 'Groq Whisper'], ['gemini', 'Google Gemini'], ['custom', 'Custom OpenAI-compatible']];
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  openModal(`<div class="dlg-title"><h2>⚙️ Settings</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <nav class="tabs" id="st-tabs">${[['keys', '🔑 Keys'], ['model', '🧠 Model'], ['voice', '🔊 Voice'], ['app', '📱 App'], ['account', '👤 Account'], ['security', '🔒 Security'], ['data', '💾 Data']].map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</nav>

    <section data-sec="keys">
      <div class="card-box">
        <label class="check"><input type="checkbox" id="st-proxy" ${S.proxy.enabled ? 'checked' : ''}> Use my Nova server (keys stay on the server)</label>
        <div id="st-proxybox" ${S.proxy.enabled ? '' : 'hidden'}>
          <label>Server URL<input id="st-purl" value="${esc(S.proxy.url)}" placeholder="${esc(new URL('.', location.href).href)} (this site)"></label>
          <label>Access token<input id="st-ptoken" type="password" value="${esc(S.proxy.token)}" placeholder="APP_TOKEN from your server .env" autocomplete="off"></label>
          <div class="inrow"><button class="btn sm" id="st-ptest">Test connection</button><span class="hint" id="st-pstatus">${esc(serverStatus)}</span></div>
        </div>
      </div>
      <p class="hint">🔒 Browser keys are saved only on this device and sent directly to each provider. With the Nova server, keys never reach the browser.</p>
      ${keyRows}
    </section>

    <section data-sec="model" hidden>
      <label>System prompt<textarea id="st-system" rows="4">${esc(S.system)}</textarea></label>
      <div class="grid2">
        <label>Reasoning / thinking<select id="st-reason">${opt([['', 'Off / model default'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], S.reasoning)}</select></label>
        <label>Memory (messages sent)<select id="st-hist">${opt([['0', 'Whole chat'], ['40', 'Last 40'], ['20', 'Last 20'], ['10', 'Last 10'], ['4', 'Last 4']], String(S.historyLimit || 0))}</select></label>
        <label>Temperature (blank = default)<input id="st-temp" type="number" step="0.1" min="0" max="2" value="${esc(S.temperature)}"></label>
        <label>Max output tokens (Claude)<input id="st-max" type="number" min="256" value="${esc(S.maxTokens)}"></label>
      </div>
      <p class="hint">Reasoning applies to OpenAI o-series/GPT-5, Claude (extended thinking), Gemini 2.5 and OpenRouter. Shorter memory = fewer tokens per message.</p>
    </section>

    <section data-sec="voice" hidden>
      <h3>Text-to-speech</h3>
      <div class="grid2"><label>Provider<select id="st-tts">${opt(ttsOpts, S.tts.provider)}</select></label>
      <label>Model<input id="st-ttsmodel" list="dl-ttsmodel" value="${esc(S.tts.model)}" placeholder="default"></label></div>
      <label>Voice<input id="st-voice" list="dl-voice" value="${esc(S.tts.voice)}" placeholder="default voice"></label>
      <datalist id="dl-ttsmodel"></datalist><datalist id="dl-voice"></datalist>
      <div class="inrow spread"><label class="check"><input type="checkbox" id="st-auto" ${S.tts.auto ? 'checked' : ''}> Auto-read replies aloud</label><button class="btn sm" id="st-test">🔊 Test voice</button></div>
      <h3>Speech-to-text (mic & audio files)</h3>
      <div class="grid2"><label>Provider<select id="st-stt">${opt(sttOpts, S.stt.provider)}</select></label>
      <label>Language (browser mic)<input id="st-lang" value="${esc(S.stt.lang)}" placeholder="${esc(navigator.language)} e.g. ms-MY"></label></div>
      <label>Model<input id="st-sttmodel" value="${esc(S.stt.model)}" placeholder="default"></label>
    </section>

    <section data-sec="app" hidden>
      <div class="grid2"><label>Theme<select id="st-theme">${opt([['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], S.theme)}</select></label>
      <label>Enter key<select id="st-enter">${opt([['1', 'Sends (desktop)'], ['0', 'New line']], S.sendOnEnter ? '1' : '0')}</select></label></div>
      <label>Interface language<select id="st-uilang">${opt([['auto', 'Automatic (device)'], ['en', 'English'], ['ms', 'Bahasa Melayu']], S.lang || 'auto')}</select></label>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="st-notify" ${S.notify ? 'checked' : ''}> Notify me when a video finishes</label>
      <h3>Stay up to date</h3>
      <label class="check"><input type="checkbox" id="st-upmodels" ${S.autoUpdate.models ? 'checked' : ''}> Refresh model lists weekly (from providers you have keys for)</label>
      <label class="check" style="margin-top:6px"><input type="checkbox" id="st-upprices" ${S.autoUpdate.prices ? 'checked' : ''}> Update prices weekly from OpenRouter's public catalogue</label>
      <h3>Install as an app</h3>
      ${standalone ? '<p>✅ Running as an installed app.</p>' : isIOS ? '<p>On iPhone/iPad: tap <b>Share</b> → <b>Add to Home Screen</b>.</p>' : `<p class="hint">Install Nova Studio for a full-screen app with offline access.</p><button class="btn" id="st-install" ${deferredInstall ? '' : 'disabled'}>📲 Install app</button>${deferredInstall ? '' : '<p class="hint">If the button is disabled, use your browser menu → “Install app” / “Add to Home screen”. Installing needs HTTPS.</p>'}`}
      <p class="hint">Nova Studio v${APP_VERSION} · ${navigator.serviceWorker?.controller ? 'offline-ready ✓' : 'offline cache not active yet'}</p>
    </section>

    <section data-sec="account" hidden><div id="st-account">${accountTabHTML()}</div></section>
    <section data-sec="security" hidden><div id="st-vault">${vaultSettingsHTML()}</div></section>

    <section data-sec="data" hidden>
      <div class="inrow wrap"><button class="btn" id="st-export">⬇ Export backup</button><button class="btn" id="st-import">⬆ Import backup</button><button class="btn danger" id="st-clear">🗑 Delete all chats</button></div>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="st-inckeys"> Include API keys in export</label>
      <input type="file" id="st-file" accept=".json,application/json" hidden>
      <p class="hint" id="st-storage"></p>
      <h3>Troubleshooting</h3>
      <button class="btn" id="st-logs">🐞 View logs</button>
    </section>
    <div class="dlg-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="st-save">Save</button></div>`, 'wide');

  const showTab = t => { $$('#st-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t)); $$('[data-sec]').forEach(s => s.hidden = s.dataset.sec !== t); };
  showTab(section || 'keys');
  $('#st-tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };
  const rebindVault = () => { $('#st-vault').innerHTML = vaultSettingsHTML(); bindVaultSettings(rebindVault); };
  bindVaultSettings(rebindVault);
  const rebindAccount = () => { $('#st-account').innerHTML = accountTabHTML(); bindAccountTab(rebindAccount); };
  bindAccountTab(rebindAccount);
  $('#st-logs').onclick = openLogs;
  const langBefore = currentLang();
  const fillVoice = () => {
    const p = $('#st-tts').value;
    $('#dl-ttsmodel').innerHTML = (PROVIDERS[p]?.models.tts || []).filter(Boolean).map(m => `<option value="${m}">`).join('');
    const voices = p === 'browser' ? (window.speechSynthesis?.getVoices() || []).map(v => v.name) : (VOICES[p] || []);
    $('#dl-voice').innerHTML = voices.map(v => `<option value="${esc(v)}">`).join('');
  };
  fillVoice();
  $('#st-tts').onchange = () => { $('#st-voice').value = ''; $('#st-ttsmodel').value = ''; fillVoice(); };
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = fillVoice;
  $('#modalBody').onclick = e => { const b = e.target.closest('[data-eye]'); if (b) { const i = b.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; } };
  $('#st-proxy').onchange = e => { $('#st-proxybox').hidden = !e.target.checked; };
  navigator.storage?.estimate?.().then(e => { const el = $('#st-storage'); if (el) el.textContent = `Storage used: ${fmtNum(e.usage / 1024 / 1024)} MB of ~${fmtNum(e.quota / 1024 / 1024)} MB available.`; });

  const collect = () => {
    $$('[data-key]').forEach(i => { const v = i.value.trim(); if (v) S.keys[i.dataset.key] = v; else delete S.keys[i.dataset.key]; });
    $$('[data-base]').forEach(i => { const v = i.value.trim(); if (v) S.bases[i.dataset.base] = v; else delete S.bases[i.dataset.base]; });
    S.proxy = { enabled: $('#st-proxy').checked, url: $('#st-purl').value.trim(), token: $('#st-ptoken').value.trim() };
    S.system = $('#st-system').value; S.temperature = $('#st-temp').value; S.maxTokens = +$('#st-max').value || 8192;
    S.reasoning = $('#st-reason').value; S.historyLimit = +$('#st-hist').value || 0;
    S.tts = { provider: $('#st-tts').value, model: $('#st-ttsmodel').value.trim(), voice: $('#st-voice').value.trim(), auto: $('#st-auto').checked };
    S.stt = { provider: $('#st-stt').value, model: $('#st-sttmodel').value.trim(), lang: $('#st-lang').value.trim() };
    S.theme = $('#st-theme').value; S.sendOnEnter = $('#st-enter').value === '1'; S.notify = $('#st-notify').checked; S.lang = $('#st-uilang').value; S.autoUpdate = { ...S.autoUpdate, models: $('#st-upmodels').checked, prices: $('#st-upprices').checked };
  };
  $('#st-ptest').onclick = async () => { collect(); $('#st-pstatus').textContent = 'Testing…'; await loadServerConfig(); $('#st-pstatus').textContent = serverStatus || 'Proxy is off'; };
  $('#st-test').onclick = () => { collect(); speak('Hello! This is how I sound. Nova Studio is ready.', 'test'); };
  $('#st-install')?.addEventListener('click', installApp);
  $('#st-save').onclick = async () => {
    collect(); saveSettings(); applyTheme(); closeModal();
    if (currentLang() !== langBefore) { location.reload(); return; }
    await loadServerConfig(false);
    updateChip(); renderSkillBar(); if (!cur?.messages.length) renderMessages();
    toast('Settings saved');
  };
  $('#st-export').onclick = () => exportAll($('#st-inckeys').checked);
  $('#st-import').onclick = () => $('#st-file').click();
  $('#st-file').onchange = e => e.target.files[0] && importAll(e.target.files[0]);
  $('#st-clear').onclick = async () => { if (!confirm('Delete ALL chats? This cannot be undone.')) return; const now = Date.now(); await DB.putMany('convos', convos.map(c => ({ id: c.id, deleted: true, updated: now }))); convos.forEach(c => dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'convos', id: c.id } }))); convos = []; cur = null; renderConvoList(); renderMessages(); toast('All chats deleted'); };
}
async function exportAll(includeKeys) {
  toast('Preparing backup…');
  const conv = await Promise.all(convos.map(async c => ({ ...c, messages: await Promise.all(c.messages.map(async m => ({ ...m, media: await Promise.all((m.media || []).map(async x => x.blob ? { kind: x.kind, prompt: x.prompt, src: await blobToDataURL(x.blob) } : x)) }))) })));
  const s = structuredClone(S); if (!includeKeys) { s.keys = {}; s.proxy = { ...s.proxy, token: '' }; }
  let usage = []; try { usage = await DB.all('usage'); } catch {}
  download(JSON.stringify({ app: 'nova-studio', v: 2, settings: s, skills, convos: conv, usage }), `nova-backup-${dayKey(Date.now())}.json`);
}
async function importAll(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'nova-studio' && !j.convos) throw new Error('not a Nova Studio backup');
    if (j.settings) replaceSettings(j.settings);
    if (Array.isArray(j.skills)) { skills = j.skills; saveSkills(); }
    if (j.convos?.length) await DB.putMany('convos', j.convos);
    if (j.usage?.length) await DB.putMany('usage', j.usage);
    convos = (await DB.all('convos')).filter(c => !c.deleted); cur = null; await loadUsage();
    closeModal(); applyTheme(); await loadServerConfig(); renderConvoList(); renderMessages(); setMode(mode); toast('Backup imported');
  } catch (e) { toast('Import failed: ' + e.message, 4500); }
}

/* ---------- Skills manager ---------- */
function openSkills() {
  openModal(`<div class="dlg-title"><h2>🧩 Skills</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">Skills are reusable instructions added to the AI's system prompt in Chat mode. Turn on as many as you like — or type <kbd>/</kbd> in the message box to toggle them fast.</p>
    <div id="sk-list"></div>
    <div class="dlg-actions"><button class="btn" id="sk-import">Import</button><button class="btn" id="sk-export">Export</button><button class="btn" data-close>Done</button><button class="btn primary" id="sk-new">＋ New skill</button></div>
    <input type="file" id="sk-file" accept=".json,application/json" hidden>`);
  renderSkillList();
  $('#sk-list').onchange = e => { const t = e.target.closest('[data-sk-toggle]'); if (t) { const s = skills.find(x => x.id === t.dataset.skToggle); s.enabled = t.checked; saveSkills(); renderSkillBar(); } };
  $('#sk-list').onclick = e => { const b = e.target.closest('[data-sk-edit]'); if (b) editSkill(b.dataset.skEdit); };
  $('#sk-new').onclick = () => editSkill(null);
  $('#sk-export').onclick = () => download(JSON.stringify(skills, null, 2), 'nova-skills.json');
  $('#sk-import').onclick = () => $('#sk-file').click();
  $('#sk-file').onchange = async e => {
    try {
      const arr = JSON.parse(await e.target.files[0].text()), list = Array.isArray(arr) ? arr : [arr];
      for (const s of list) if (s.name && s.prompt) { const ex = skills.find(x => x.id === s.id); if (ex) Object.assign(ex, s); else skills.push({ id: s.id || uid(), icon: s.icon || '🧩', name: s.name, prompt: s.prompt, enabled: !!s.enabled }); }
      saveSkills(); renderSkillList(); renderSkillBar(); toast('Skills imported');
    } catch (err) { toast('Import failed: ' + err.message); }
  };
}
function renderSkillList() {
  $('#sk-list').innerHTML = skills.map(s => `<div class="skill"><div class="sk-ico">${esc(s.icon || '🧩')}</div><div class="sk-body"><b>${esc(s.name)}</b><small>${esc(s.prompt)}</small></div>
    <label class="switch" title="On/off"><input type="checkbox" data-sk-toggle="${s.id}" ${s.enabled ? 'checked' : ''} aria-label="Enable ${esc(s.name)}"><span></span></label><button class="icon sm" data-sk-edit="${s.id}" title="Edit" aria-label="Edit ${esc(s.name)}">✏️</button></div>`).join('') || '<p class="hint">No skills yet.</p>';
}
function editSkill(id) {
  const s = id ? skills.find(x => x.id === id) : { id: uid(), icon: '🧩', name: '', prompt: '', enabled: true };
  openModal(`<div class="dlg-title"><h2>${id ? 'Edit skill' : 'New skill'}</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <div class="grid2" style="grid-template-columns:80px 1fr"><label>Icon<input id="ske-icon" value="${esc(s.icon)}" maxlength="4"></label><label>Name<input id="ske-name" value="${esc(s.name)}" placeholder="e.g. Marketing Guru"></label></div>
    <label>Instructions<textarea id="ske-prompt" rows="9" placeholder="Describe how the AI should behave when this skill is on…">${esc(s.prompt)}</textarea></label>
    <p class="hint">≈ ${fmtNum(estimateTokens(s.prompt))} tokens added to every message while on.</p>
    <div class="dlg-actions">${id ? '<button class="btn danger" id="ske-del">Delete</button>' : ''}<button class="btn" id="ske-back">Back</button><button class="btn primary" id="ske-save">Save skill</button></div>`);
  $('#ske-back').onclick = openSkills;
  $('#ske-save').onclick = () => {
    s.icon = $('#ske-icon').value.trim() || '🧩'; s.name = $('#ske-name').value.trim(); s.prompt = $('#ske-prompt').value.trim();
    if (!s.name || !s.prompt) return toast('Name and instructions are required');
    if (!id) skills.push(s);
    saveSkills(); renderSkillBar(); openSkills();
  };
  if (id) $('#ske-del').onclick = () => { if (confirm('Delete this skill?')) { skills = skills.filter(x => x.id !== id); saveSkills(); renderSkillBar(); openSkills(); } };
}

/* ---------- Chat options, edit, export ---------- */
function openChatMenu() {
  if (!cur) return toast('Start a chat first');
  const t = convoTotals(cur);
  openModal(`<div class="dlg-title"><h2>💬 ${esc(cur.title)}</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">${cur.messages.length} messages · ${fmtNum(t.tokens)} tokens · ${fmtUSD(t.cost)}</p>
    <div class="menu">
      <button data-cm="rename">✏️ Rename</button>
      <button data-cm="share">🔗 Share link (read-only)</button>
      <button data-cm="html">🌐 Export as web page (.html)</button>
      <button data-cm="md">⬇ Export as Markdown</button>
      <button data-cm="usage">📊 Usage dashboard</button>
      <button data-cm="delete" class="danger">🗑 Delete chat</button>
    </div>`);
  $('.menu').onclick = e => {
    const b = e.target.closest('[data-cm]'); if (!b) return;
    const a = b.dataset.cm;
    if (a === 'rename') { closeModal(); renameConvo(cur.id); }
    else if (a === 'md') { closeModal(); exportChatMD(); }
    else if (a === 'html') { closeModal(); exportChatHTML(); }
    else if (a === 'share') shareChat();
    else if (a === 'usage') openUsage();
    else if (a === 'delete') { closeModal(); deleteConvo(cur.id); }
  };
}
async function renameConvo(id) {
  const c = convos.find(x => x.id === id); if (!c) return;
  const t = prompt('Rename chat', c.title); if (t == null || !t.trim()) return;
  c.title = t.trim().slice(0, 80); renderConvoList(); await saveConvo(c);
}
async function deleteConvo(id) {
  if (busy) return toast('Stop the current generation first');
  if (!confirm('Delete this chat?')) return;
  await DB.put('convos', { id, deleted: true, updated: Date.now() }).catch(() => {});
  dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'convos', id } }));
  convos = convos.filter(c => c.id !== id);
  if (cur?.id === id) cur = null;
  renderConvoList(); renderMessages();
}
async function shareChat() {
  if (!cur?.messages.length) return toast('Nothing to share yet');
  if (!signedIn()) {
    openModal(`<div class="dlg-title"><h2>🔗 Share</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
      <p>Share links are hosted on your <b>Nova server</b>. Sign in under Settings → 👤 Account to create links anyone can open.</p>
      <p class="hint">Without a server you can export the chat as a single web page file and send it.</p>
      <div class="dlg-actions"><button class="btn" id="sh-acc">Sign in</button><button class="btn primary" id="sh-html">🌐 Export as web page</button></div>`);
    $('#sh-acc').onclick = () => openSettings('account');
    $('#sh-html').onclick = () => { closeModal(); exportChatHTML(); };
    return;
  }
  if (!confirm('Create a public, read-only link to this chat? Anyone with the link can read it (images included, attachments are not).')) return;
  const messages = cur.messages.map(m => ({ role: m.role, text: m.text || (m.error ? '⚠️ ' + m.error : ''), meta: m.meta || '', ts: m.ts || 0,
    media: (m.media || []).filter(x => x.kind === 'image' && x.src?.startsWith('data:image') && x.src.length < 4e6).map(x => ({ kind: 'image', src: x.src })), sources: m.sources || [] }));
  try { const r = await serverApi('/api/share', { method: 'POST', body: { title: cur.title, messages } }); openShares(r.id); }
  catch (e) { toast(e.message, 5000); }
}
function exportChatHTML() {
  if (!cur?.messages.length) return toast('Nothing to export yet');
  const body = cur.messages.map(m => m.role === 'user'
    ? `<div class="u"><div>${esc(m.text || '').replace(/\n/g, '<br>')}</div></div>`
    : `<div class="a"><div class="md">${md(m.text || '')}</div>${(m.media || []).filter(x => x.src?.startsWith('data:image')).map(x => `<img src="${x.src}" alt="">`).join('')}${m.meta ? `<small>${esc(m.meta)}</small>` : ''}</div>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(cur.title)}</title>
<style>body{margin:0;background:#f6f7fb;color:#151821;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:820px;margin:0 auto;padding:24px 16px}h1{font-size:22px}
.u{display:flex;justify-content:flex-end;margin:16px 0}.u div{background:#e8e9fb;padding:10px 14px;border-radius:18px 18px 4px 18px;max-width:85%}
.a{margin:16px 0}.a img{max-width:100%;border-radius:12px;display:block;margin:8px 0}.a small{color:#636b7e}pre{background:#0d1117;color:#e6edf3;padding:12px;border-radius:10px;overflow:auto}code{font-family:ui-monospace,monospace}
table{border-collapse:collapse}td,th{border:1px solid #dde1ea;padding:6px 10px}@media(prefers-color-scheme:dark){body{background:#0a0c11;color:#e9ebf1}.u div{background:#1e2330}td,th{border-color:#252a35}}</style></head>
<body><main><h1>${esc(cur.title)}</h1><p><small>Exported from Nova Studio · ${new Date().toLocaleString()}</small></p>${body}</main></body></html>`;
  download(html, `${cur.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'chat'}.html`, 'text/html');
}
function exportChatMD() {
  if (!cur?.messages.length) return toast('Nothing to export yet');
  let out = `# ${cur.title}\n\n_Exported from Nova Studio · ${new Date().toLocaleString()}_\n\n`;
  for (const m of cur.messages) {
    out += `### ${m.role === 'user' ? '🧑 You' : '⚡ Nova' + (m.meta ? ` (${m.meta})` : '')}${m.ts ? ` · ${new Date(m.ts).toLocaleString()}` : ''}\n\n`;
    if (m.atts?.length) out += m.atts.map(a => `📎 ${a.name}`).join('  \n') + '\n\n';
    if (m.text) out += m.text + '\n\n';
    for (const x of m.media || []) out += `_[${x.kind}${x.prompt ? ': ' + x.prompt : ''}]_\n\n`;
    if (m.error) out += `> ⚠️ ${m.error}\n\n`;
  }
  download(out, `${cur.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'chat'}.md`, 'text/markdown');
}
function editMessage(m) {
  if (busy) return toast('Stop the current generation first');
  openModal(`<div class="dlg-title"><h2>✏️ Edit message</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <textarea id="ed-text" rows="8">${esc(m.text)}</textarea>
    <p class="hint">Saving resends this message — later replies in this chat are replaced.</p>
    <div class="dlg-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ed-save">Save & resend</button></div>`);
  const ta = $('#ed-text'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  $('#ed-save').onclick = async () => {
    const t = ta.value.trim(); if (!t && !m.atts?.length) return;
    closeModal(); m.text = t; m.ts = Date.now();
    const i = cur.messages.indexOf(m); cur.messages.splice(i + 1);
    await runTurn(cur, m, m.mode || 'chat');
  };
}
async function deleteMessage(m) {
  if (busy) return toast('Stop the current generation first');
  cur.messages = cur.messages.filter(x => x !== m);
  renderMessages(); await saveConvo(cur);
}
function zoomImage(src) {
  openModal(`<div class="dlg-title"><h2>🖼️ Image</h2><button class="icon sm" data-close aria-label="Close">✕</button></div><img src="${esc(src)}" class="zoomed" alt=""><div class="dlg-actions"><a class="btn" href="${esc(src)}" download="nova-image.png">⬇ Download</a><button class="btn primary" data-close>Close</button></div>`, 'wide');
}

/* ---------- Text-to-speech ---------- */
let audioEl = null, speakingId = null, speakToken = 0;
function refreshSpeak() { $$('[data-act="speak"]').forEach(b => { const id = b.closest('.msg')?.id.slice(2); b.textContent = id === speakingId ? '⏹' : '🔊'; b.classList.toggle('on', id === speakingId); }); }
async function ttsBlob(text) {
  const p = S.tts.provider, P = PROVIDERS[p];
  if (p === 'elevenlabs') {
    const model = S.tts.model || 'eleven_multilingual_v2';
    const r = await ok(await fetch(`${base(p)}/text-to-speech/${S.tts.voice || '21m00Tcm4TlvDq8ikWAM'}`, { method: 'POST', headers: elHeaders(p), body: JSON.stringify({ text, model_id: model }) }));
    recordUsage({ provider: p, model, kind: 'tts', units: text.length });
    return r.blob();
  }
  if (P?.type === 'gemini') {
    const model = S.tts.model || P.models.tts[0];
    const r = await ok(await fetch(`${base(p)}/models/${model}:generateContent`, { method: 'POST', headers: gHeaders(p),
      body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: S.tts.voice || 'Kore' } } } } }) }));
    const j = await r.json(), inl = j.candidates?.[0]?.content?.parts?.find(x => x.inlineData)?.inlineData;
    if (!inl) throw new Error('No audio returned');
    const u = geminiUsage(j.usageMetadata);
    recordUsage({ provider: p, model, kind: 'tts', in: u?.in || 0, out: u?.out || 0, units: text.length });
    const rate = +(/rate=(\d+)/.exec(inl.mimeType || '')?.[1] || 24000);
    return /wav|mp3|mpeg|ogg/.test(inl.mimeType || '') ? dataUrlToBlob(`data:${inl.mimeType};base64,${inl.data}`) : pcmToWav(inl.data, rate);
  }
  const model = S.tts.model || P?.models.tts?.[0] || 'tts-1';
  const r = await ok(await fetch(base(p) + '/audio/speech', { method: 'POST', headers: authHeaders(p), body: JSON.stringify({ model, voice: S.tts.voice || 'alloy', input: text, response_format: 'mp3' }) }));
  recordUsage({ provider: p, model, kind: 'tts', units: text.length });
  return r.blob();
}
function playBlob(blob, my) {
  return new Promise(res => {
    const url = URL.createObjectURL(blob); audioEl = new Audio(url);
    const done = () => { clearInterval(chk); URL.revokeObjectURL(url); res(); };
    const chk = setInterval(() => { if (my !== speakToken) { audioEl?.pause(); done(); } }, 200);
    audioEl.onended = done; audioEl.onerror = done; audioEl.play().catch(done);
  });
}
async function speak(text, id) {
  stopSpeak(); const my = ++speakToken; speakingId = id; refreshSpeak();
  const clean = plain(text); if (!clean) return;
  try {
    if (S.tts.provider === 'browser') {
      if (!window.speechSynthesis) throw new Error('Speech is not supported in this browser');
      for (const c of chunkText(clean, 250)) {
        if (my !== speakToken) break;
        await new Promise(res => {
          const u = new SpeechSynthesisUtterance(c), v = speechSynthesis.getVoices().find(v => v.name === S.tts.voice);
          if (v) { u.voice = v; u.lang = v.lang; } u.onend = res; u.onerror = res; speechSynthesis.speak(u);
        });
      }
    } else {
      const chunks = chunkText(clean, 3500); let next = ttsBlob(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const blob = await next; if (my !== speakToken) break;
        if (i + 1 < chunks.length) { next = ttsBlob(chunks[i + 1]); next.catch(() => {}); }
        await playBlob(blob, my);
      }
    }
  } catch (e) { toast('Voice: ' + e.message, 4500); }
  if (my === speakToken) { speakingId = null; refreshSpeak(); }
}
function stopSpeak() { speakToken++; try { window.speechSynthesis?.cancel(); } catch {} if (audioEl) { audioEl.pause(); audioEl = null; } speakingId = null; refreshSpeak(); }

/* ---------- Speech-to-text ---------- */
async function transcribe(blob, name, seconds = 0) {
  let pid = S.stt.provider;
  if (!pid || pid === 'browser') pid = ['openai', 'groq', 'gemini'].find(hasKey);
  if (!pid) throw new Error('Choose a speech-to-text provider with an API key in Settings → Voice');
  const P = PROVIDERS[pid], model = (pid === S.stt.provider && S.stt.model) || P.models.stt?.[0] || 'whisper-1';
  if (P.type === 'gemini') {
    const { mime, b64 } = parseDataUrl(await blobToDataURL(blob));
    const j = await (await ok(await fetch(`${base(pid)}/models/${model}:generateContent`, { method: 'POST', headers: gHeaders(pid),
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: 'Transcribe this audio verbatim in its original language. Output only the transcript.' }] }] }) }))).json();
    const u = geminiUsage(j.usageMetadata);
    recordUsage({ provider: pid, model, kind: 'stt', in: u?.in || 0, out: u?.out || 0, units: seconds });
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  }
  const ext = ((blob.type.split('/')[1] || 'webm').split(';')[0]).replace('mpeg', 'mp3').replace('x-m4a', 'm4a');
  const fd = new FormData(); fd.append('file', blob, name || `speech.${ext}`); fd.append('model', model);
  const j = await (await ok(await fetch(base(pid) + '/audio/transcriptions', { method: 'POST', headers: authHeaders(pid, false), body: fd }))).json();
  recordUsage({ provider: pid, model, kind: 'stt', in: j.usage?.input_tokens || 0, out: j.usage?.output_tokens || 0, units: seconds || Math.round(j.duration || j.usage?.seconds || 0) });
  return j.text || '';
}
let rec = null, recog = null, recStart = 0;
async function toggleMic() {
  if (rec) { rec.stop(); return; }
  if (recog) { recog.stop(); return; }
  if (S.stt.provider === 'browser') {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('This browser has no built-in speech recognition. Pick OpenAI, Groq or Gemini in Settings → Voice.', 5000); return; }
    recog = new SR(); recog.continuous = true; recog.interimResults = true; recog.lang = S.stt.lang || navigator.language;
    const before = input.value;
    recog.onresult = e => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; input.value = (before ? before + ' ' : '') + t; autosize(); };
    recog.onend = () => { recog = null; micBtn.classList.remove('rec'); };
    recog.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Mic: ' + e.error); };
    recog.start(); micBtn.classList.add('rec'); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }), chunks = [];
    rec = new MediaRecorder(stream); recStart = Date.now();
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); micBtn.classList.remove('rec');
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), secs = Math.round((Date.now() - recStart) / 1000); rec = null;
      micBtn.classList.add('busy'); micBtn.disabled = true;
      try { const t = await transcribe(blob, null, secs); input.value = (input.value ? input.value + ' ' : '') + t; autosize(); input.focus(); }
      catch (e) { toast('Transcription failed: ' + e.message, 4500); }
      micBtn.classList.remove('busy'); micBtn.disabled = false;
    };
    rec.start(); micBtn.classList.add('rec'); toast('Recording… tap 🎙️ again to stop');
  } catch (e) { toast('Microphone unavailable: ' + e.message); }
}

/* ---------- Prompt enhancer ---------- */
async function enhance() {
  const t = input.value.trim(); if (!t) return toast('Type an idea first');
  const b = $('#enhBtn'); b.disabled = true; b.textContent = '✨ Enhancing…';
  try {
    const out = await complete(t, `Rewrite the user's idea as ONE vivid, detailed ${mode === 'video' ? 'video generation prompt (camera movement, action, pacing, lighting, ambient sound)' : 'image generation prompt (subject, setting, style, lighting, composition, mood, lens)'}. Keep the user's language. Output ONLY the prompt, under 120 words.`);
    if (out) { input.value = out.replace(/^["']|["']$/g, ''); autosize(); }
  } catch (e) { toast('Enhance failed: ' + e.message, 4500); }
  b.disabled = false; b.textContent = '✨ Enhance prompt';
}

/* ---------- PWA: service worker, install, offline, notifications ---------- */
let deferredInstall = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('#installBtn').hidden = false; });
addEventListener('appinstalled', () => { deferredInstall = null; $('#installBtn').hidden = true; toast('Nova Studio installed 🎉'); });
async function installApp() {
  if (!deferredInstall) return openSettings('app');
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null; $('#installBtn').hidden = true;
}
function registerSW() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (!reg) return;
    const promptUpdate = () => toast('A new version of Nova Studio is ready', 0, { label: 'Update', fn: () => reg.waiting?.postMessage('skipWaiting') });
    if (reg.waiting && navigator.serviceWorker.controller) promptUpdate();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(e => console.warn('SW registration failed', e));
  // Reload only when an *update* takes over — not when the first-ever worker claims the page.
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadController || refreshing) return; refreshing = true; location.reload(); });
}
function updateOnline() { $('#offline').hidden = navigator.onLine; }
function askNotifyPermission() { if (S.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); }
async function notify(title, body, convoId) {
  if (!document.hidden) { if (convoId) toast(`${title}`, 0, { label: 'Open', fn: () => openConvoById(convoId) }); return; }
  if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const data = { url: convoId ? `./?chat=${encodeURIComponent(convoId)}` : './' };
  try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) reg.showNotification(title, { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png', data }); else new Notification(title, { body }); } catch {}
}
function openConvoById(id) {
  const c = convos.find(x => x.id === id); if (!c) return false;
  appApi.openConvo(id, c.messages.at(-1)?.id); return true;
}

/* ---------- Events ---------- */
const sidebar = $('#sidebar'), scrim = $('#scrim');
const openSide = () => { sidebar.classList.add('open'); scrim.classList.add('show'); };
const closeSide = () => { sidebar.classList.remove('open'); scrim.classList.remove('show'); };
function newChat() { if (busy) return toast('Stop the current generation first'); stopSpeak(); cur = null; pending = []; renderAttachBar(); renderMessages(); renderConvoList(); closeSide(); input.focus(); }
$('#openSide').onclick = openSide; $('#closeSide').onclick = closeSide; scrim.onclick = closeSide;
$('#newChat').onclick = newChat; $('#newChat2').onclick = newChat;
$('#openSettings').onclick = () => { closeSide(); openSettings(); };
$('#openSkills').onclick = () => { closeSide(); openSkills(); };
$('#openUsage').onclick = () => { closeSide(); openUsage(); };
$('#openFiles').onclick = () => { closeSide(); openExplorer(); };
$('#openGallery').onclick = () => { closeSide(); openGallery(); };
$('#openKB').onclick = () => { closeSide(); openKB(); };
$('#openCompare').onclick = () => { closeSide(); openCompare(); };
$('#openTasks').onclick = () => { closeSide(); openTasks(); };
$('#openRuns').onclick = () => { closeSide(); openRuns(); };
$('#voiceBtn').onclick = () => startVoice();
function renderProjBar() { $('#projBar').innerHTML = projectBarHTML(); }
$('#projBar').onclick = e => { const b = e.target.closest('#projBtn'); if (b) openProjectMenu(b); };
const appApi = {
  getConvos: () => convos,
  openConvo: (id, msgId) => {
    const c = convos.find(x => x.id === id); if (!c) return;
    if (c.projectId && c.projectId !== currentProject()?.id) setProject(c.projectId); else if (!c.projectId && currentProject()) setProject('');
    cur = c; renderMessages(); renderConvoList(); updateChip();
    setTimeout(() => document.getElementById('m-' + msgId)?.scrollIntoView({ block: 'center' }), 50);
  },
  attachDataUrl: (src, name) => { pending.push({ id: uid(), name, mime: parseDataUrl(src).mime || 'image/png', kind: 'image', data: src }); renderAttachBar(); setMode('chat'); input.focus(); },
  addLocalImage: async (src, label, prompt) => {
    const c = ensureConvo(); if (c.title === 'New chat') c.title = label;
    const m = { id: uid(), role: 'assistant', text: `_${label}_`, media: [{ kind: 'image', src, prompt }], meta: 'On device', mode: 'image', ts: Date.now() };
    c.messages.push(m); c.updated = Date.now(); renderMessages(); scrollBottom(); renderConvoList(); await saveConvo(c);
  },
  imageJob: async ({ src, prompt, mask, background }) => {
    if (busy) return toast('Stop the current generation first');
    const c = ensureConvo(); if (c.title === 'New chat') c.title = prompt.slice(0, 50);
    const user = { id: uid(), role: 'user', text: prompt, atts: [{ id: uid(), name: 'image.png', mime: 'image/png', kind: 'image', data: src }], mode: 'image', ts: Date.now(), imgOpts: { mask, background } };
    c.messages.push(user);
    await runTurn(c, user, 'image');
    delete user.imgOpts; await saveConvo(c);
  },
};
initGallery(appApi);
initVoice({
  canChat: () => hasKey(chatModelFor(cur || { projectId: currentProject()?.id }).provider),
  modelLabel: () => chatModelFor(cur || { projectId: currentProject()?.id }).model,
  sendText: async (text, onText) => {
    if (busy) return null;
    voiceActive = true; setMode('chat'); input.value = text;
    const iv = setInterval(() => { const a = cur?.messages.at(-1); if (a?.role === 'assistant') onText?.(a.text || ''); }, 150);
    try { return await send(); } finally { clearInterval(iv); voiceActive = false; }
  },
  speak: (text, id) => speak(text, id),
  stopSpeak: () => stopSpeak(),
  abort: () => abortCtl?.abort(),
  transcribe: (blob, secs) => transcribe(blob, null, secs),
});
initAccount({
  root: proxyRoot, headers: proxyHeaders,
  onSignedIn: async () => { resetSyncState(); setSyncEnabled(true); await loadServerConfig(); updateChip(); },
  onSignedOut: async () => { resetSyncState(); serverKeys = new Set(); await loadServerConfig(); updateChip(); },
  syncStatusHTML, syncNow: loud => syncNow(loud), setSyncEnabled,
});
async function reloadFromSync(touched) {
  if (touched.has('convos')) {
    const all = (await DB.all('convos')).filter(c => !c.deleted);
    if (busy && cur) { const i = all.findIndex(c => c.id === cur.id); if (i >= 0) all[i] = cur; }
    const curId = cur?.id; convos = all;
    cur = curId ? (convos.find(c => c.id === curId) || null) : null;
    renderConvoList(); if (!busy) renderMessages();
  }
  if (touched.has('projects')) { const { reloadProjects } = await import('./projects.js'); await reloadProjects(); }
  if (touched.has('kbs') || touched.has('chunks')) await initKB({ embed: embedTexts, embedChoice, embedAvailable, saveSettings });
  if (touched.has('usage')) { await loadUsage(); updatePill(); }
  if (touched.has('meta:skills')) { skills = loadSkills(); renderSkillBar(); }
  if (touched.has('meta:settings')) { applyTheme(); setMode(mode); renderSkillBar(); }
}
initSync({ root: proxyRoot, headers: proxyHeaders, reload: reloadFromSync });
initTasks({
  serverTasks: () => signedIn() && S.proxy.enabled,
  api: serverApi, hasKey, isBusy: () => busy,
  projects: () => projects,
  openConvo: id => { if (!openConvoById(id)) toast('Result not synced yet — try again in a moment'); },
  syncNow: () => syncNow(),
  notify: (title, body, convoId) => notify(title, body, convoId),
  runLocal: async t => {
    if (busy) throw new Error('Nova is busy — the task will run when the current reply finishes');
    const c = { id: uid(), title: `⏰ ${t.name} — ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`, messages: [], updated: Date.now(), projectId: t.projectId || '', model: { provider: t.provider, model: t.model }, scheduled: t.id };
    convos.unshift(c);
    const user = { id: uid(), role: 'user', text: t.prompt + (t.webSearch ? '\n\n(Search the web first if a search tool is available.)' : ''), atts: [], mode: 'chat', ts: Date.now() };
    c.messages.push(user);
    const a = await runTurn(c, user, 'chat');
    renderConvoList();
    if (a?.error) throw new Error(a.error);
    return c.id;
  },
});
initCompare({
  hasKey, md, buildSystem: () => buildSystem(cur || { projectId: currentProject()?.id }), callChat, estimate: estimateTokens, recordUsage, costOf,
  continueInChat: async (prompt, r) => {
    cur = null; const c = ensureConvo(); c.title = prompt.replace(/\s+/g, ' ').slice(0, 50);
    c.messages.push({ id: uid(), role: 'user', text: prompt, atts: [], mode: 'chat', ts: Date.now() });
    c.messages.push({ id: uid(), role: 'assistant', text: r.text, media: [], mode: 'chat', meta: `${PROVIDERS[r.provider].name} · ${r.model} (compare)`, ts: Date.now() });
    c.updated = Date.now(); renderMessages(); renderConvoList(); scrollBottom(); await saveConvo(c);
  },
});
$('#openConnectors').onclick = () => { closeSide(); openConnectors(); };
$('#installBtn').onclick = installApp;
$('#usagePill').onclick = () => openUsage();
$('#chatMenu').onclick = openChatMenu;
$('#modelChip').onclick = openPicker;
$('#fab').onclick = () => scrollBottom(true);
$('#search').oninput = renderConvoList;
$('#modes').onclick = e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); };
$('#attachBar').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { pending = pending.filter(a => a.id !== b.dataset.rm); renderAttachBar(); } };
$('#skillBar').onclick = e => {
  const off = e.target.closest('[data-skill-off]');
  if (off) { const s = skills.find(x => x.id === off.dataset.skillOff); if (s) { s.enabled = false; saveSkills(); renderSkillBar(); } return; }
  if (e.target.closest('[data-act-skills]')) return openSkills();
  if (e.target.closest('[data-act-connectors]')) return openConnectors();
  const kbOff = e.target.closest('[data-kb-off]'); if (kbOff) return toggleKbForChat(kbOff.dataset.kbOff, false);
  if (e.target.closest('[data-act-settings]')) return openSettings('model');
  if (e.target.closest('[data-act-picker]')) return openPicker();
  if (e.target.closest('#enhBtn')) enhance();
};
$('#convoList').onclick = e => {
  const del = e.target.closest('[data-del]'); if (del) { e.stopPropagation(); return deleteConvo(del.dataset.del); }
  const ren = e.target.closest('[data-ren]'); if (ren) { e.stopPropagation(); return renameConvo(ren.dataset.ren); }
  const row = e.target.closest('[data-id]'); if (!row) return;
  if (busy) return toast('Stop the current generation first');
  stopSpeak(); cur = convos.find(c => c.id === row.dataset.id); renderMessages(); renderConvoList(); scrollBottom(); closeSide();
};
$('#convoList').onkeydown = e => { if (e.key === 'Enter' && e.target.matches('.convo')) e.target.click(); };
$('#slashMenu').onclick = e => { const b = e.target.closest('[data-i]'); if (b) pickSlash(+b.dataset.i); };
messagesEl.addEventListener('scroll', updateFab, { passive: true });
messagesEl.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.closest('.msg')?.id.slice(2), m = cur?.messages.find(x => x.id === id);
  switch (b.dataset.act) {
    case 'copy': copy(m.text); break;
    case 'speak': speakingId === id ? stopSpeak() : speak(m.text, id); break;
    case 'retry': regenerate(id); break;
    case 'edit': editMessage(m); break;
    case 'delete': deleteMessage(m); break;
    case 'zoom': zoomImage(b.getAttribute('src')); break;
    case 'imgtools': { const im = b.closest('figure').querySelector('img'); openImageTools(im.getAttribute('src'), im.alt); break; }
    case 'runcode': openCanvas(b.closest('pre').querySelector('code')?.innerText || '', b.dataset.lang); break;
    case 'copycode': copy(b.closest('pre').querySelector('code')?.innerText || ''); break;
    case 'dlcode': download(b.closest('pre').querySelector('code')?.innerText || '', `nova-code.${b.dataset.ext}`, 'text/plain'); break;
    case 'settings': openSettings(); break;
    case 'usage': openUsage(); break;
    case 'files': openExplorer(); break;
    case 'projedit': editProject(currentProject()); break;
    case 'knowledge': openKB(); break;
    case 'voice': startVoice(); break;
    case 'source': {
      const x = m?.sources?.find(y => String(y.n) === b.dataset.n); if (!x) break;
      openModal(`<div class="dlg-title"><h2>📚 [${x.n}] ${esc(x.doc)}</h2><button class="icon sm" data-close aria-label="Close">✕</button></div><p class="hint">${esc(x.kb)}${x.page ? ' · ' + esc(x.page) : ''}</p><div class="kb-hit"><p>${esc(x.text).replace(/\n/g, '<br>')}</p></div><div class="dlg-actions"><button class="btn primary" data-close>Close</button></div>`);
      break;
    }
    case 'connectors': openConnectors(); break;
    case 'tool-allow': answerApproval(m, b.dataset.tid, true); break;
    case 'tool-always': answerApproval(m, b.dataset.tid, true, true); break;
    case 'tool-deny': answerApproval(m, b.dataset.tid, false); break;
    case 'openrun': openRun(b.dataset.rid); break;
    case 'try': setMode(b.dataset.mode); input.value = b.dataset.p; autosize(); input.focus(); break;
  }
});
modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); });
sendBtn.onclick = send;
micBtn.onclick = toggleMic;
const attachMenu = $('#attachMenu');
$('#attachBtn').onclick = e => { e.stopPropagation(); attachMenu.hidden = !attachMenu.hidden; };
document.addEventListener('click', e => { if (!attachMenu.hidden && !e.target.closest('#attachMenu')) attachMenu.hidden = true; });
attachMenu.onclick = e => {
  const b = e.target.closest('[data-am]'); if (!b) return;
  attachMenu.hidden = true;
  if (b.dataset.am === 'upload') $('#fileInput').click();
  else if (b.dataset.am === 'camera') $('#cameraInput').click();
  else if (b.dataset.am === 'files') openExplorer();
};
$('#cameraInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#fileInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
let draftT;
input.addEventListener('input', () => { autosize(); updateSlash(); clearTimeout(draftT); draftT = setTimeout(() => LS.set('nova.draft', input.value), 400); });
input.addEventListener('keydown', e => {
  if (!$('#slashMenu').hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; return renderSlash(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; return renderSlash(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickSlash(slashIdx); }
    if (e.key === 'Escape') { e.preventDefault(); return hideSlash(); }
  }
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (e.key === 'Enter' && !e.isComposing && ((e.ctrlKey || e.metaKey) || (!e.shiftKey && S.sendOnEnter && !coarse))) { e.preventDefault(); send(); }
});
input.addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && busy && !modal.open) { abortCtl?.abort(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); }
  if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); input.focus(); }
});
const box = $('#box');
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); box.classList.add('drag'); } }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) box.classList.remove('drag'); }));
document.addEventListener('drop', e => { const f = [...(e.dataTransfer?.files || [])]; if (f.length) addFiles(f); });
addEventListener('online', updateOnline); addEventListener('offline', updateOnline);
addEventListener('nova:usage', updatePill);
addEventListener('nova:connectors', renderSkillBar);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

/* ---------- Boot ---------- */
initUsage({ getContext: contextInfo });
initConnectors({
  relay: relayOn, relayFetch,
  serverHas: pid => S.proxy.enabled && serverKeys.has(pid),
  proxyBase: pid => `${proxyRoot()}/proxy/${pid}`, proxyHeaders,
  openExplorer: () => openExplorer(),
});
['pointerdown', 'keydown'].forEach(t => addEventListener(t, () => armAutoLock(), { passive: true }));
(async function boot() {
  applyTheme();
  await unlockScreen();
  armAutoLock();
  applyLang();
  await initProjects({
    onChange: () => { renderProjBar(); if (cur && (cur.projectId || '') !== (currentProject()?.id || '')) cur = null; renderConvoList(); renderMessages(); updateChip(); },
    kbs: () => (window.__novaKbs?.() || []),
    countFor: id => convos.filter(c => c.projectId === id).length,
  });
  renderProjBar();
  await initKB({ embed: embedTexts, embedChoice, embedAvailable, saveSettings });
  setKBHooks({ inChat: id => activeKbIds(cur).includes(id), toggleForChat: toggleKbForChat });
  try { convos = (await DB.all('convos')).filter(c => !c.deleted); } catch (e) { console.warn('IndexedDB unavailable — chats will not persist', e); log('error', 'IndexedDB unavailable', e.message); }
  await loadUsage();
  await loadRuns();
  initRuns({ complete });
  const params = new URLSearchParams(location.search);
  setMode(params.get('mode') || mode);
  const shared = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join('\n');
  input.value = shared || LS.get('nova.draft', '');
  const openChat = params.get('chat');
  if (params.toString()) history.replaceState(null, '', location.pathname);
  autosize(); renderConvoList(); renderMessages(); updateOnline();
  initFiles({
    attach: files => addFiles(files),
    ask: text => { setMode('chat'); input.value = text; autosize(); input.focus(); },
    onChange: () => refreshExplorer(),
  });
  window.speechSynthesis?.getVoices();
  registerSW();
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone) $('#installBtn').hidden = false;
  await loadServerConfig(); updateChip(); if (!cur) renderMessages();
  if (syncActive()) await syncNow();
  if (openChat && !openConvoById(openChat)) toast('That chat is not on this device yet');
  setTimeout(() => autoUpdate({ listModels, hasKey, usedModels: () => [...new Set(convos.flatMap(c => c.messages.filter(m => m.usage?.model).map(m => m.usage.model)))] }).catch(() => {}), 20000);
})();
