/* Knowledge bases: "chat with your documents".
   Documents are split into chunks and indexed on this device. Search is hybrid: keyword (BM25) plus
   semantic embeddings when an embedding provider is available. Relevant excerpts are added to the
   chat with numbered citations. */
import { DB, S } from './store.js';
import { $, $$, esc, uid, toast, openModal, closeModal, fmtNum, fmtBytes, fmtDate } from './util.js';
import * as F from './files.js';
import { readWeb } from './connectors.js';

export let kbs = [];
let api = null;          // { embed(pid, model, texts, signal) → { vectors, tokens }, embedChoice() → {provider, model}|null }
export async function initKB(a) {
  api = a;
  try { kbs = (await DB.all('kbs')).filter(k => !k.deleted).sort((a, b) => a.name.localeCompare(b.name)); } catch { kbs = []; }
  window.__novaKbs = () => kbs;
}
export const kbById = id => kbs.find(k => k.id === id);
async function saveKB(k) {
  k.updated = Date.now();
  if (!kbs.includes(k)) kbs.push(k);
  await DB.put('kbs', k);
  dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'kbs', id: k.id } }));
}

/* ---------- Chunking ---------- */
const CHUNK = 1100, OVERLAP = 180;
export function chunkText(text) {
  const out = []; let page = null;
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}|(?=\n--- (?:Page|Sheet))/);
  let buf = '', bufPage = null;
  const flush = () => { const t = buf.trim(); if (t.length > 20) out.push({ text: t, page: bufPage }); buf = buf.slice(-OVERLAP); bufPage = page; };
  for (let b of blocks) {
    const pm = /--- (Page|Sheet):? ([^-\n]+?) ---/.exec(b);
    if (pm) { page = (pm[1] === 'Page' ? 'p.' : '') + pm[2].trim(); if (!buf.trim()) bufPage = page; b = b.replace(pm[0], ''); }
    if (bufPage == null) bufPage = page;
    b = b.trim(); if (!b) continue;
    while (b.length > CHUNK) {             // very long paragraph: split on sentences
      const cut = Math.max(b.lastIndexOf('. ', CHUNK), b.lastIndexOf('\n', CHUNK), CHUNK * 0.6) + 1;
      buf += (buf ? '\n' : '') + b.slice(0, cut); flush(); b = b.slice(cut).trim();
    }
    if ((buf + b).length > CHUNK) flush();
    buf += (buf ? '\n\n' : '') + b;
  }
  if (buf.trim().length > 20) out.push({ text: buf.trim(), page: bufPage });
  return out;
}

/* ---------- Indexing ---------- */
export async function addDocument(kb, { name, size = 0, text, source = '' }, { signal, onProgress } = {}) {
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error(`${name}: no readable text`);
  const doc = { id: uid(), name, size, source, chunks: chunks.length, chars: text.length, added: Date.now() };
  const rows = chunks.map((c, i) => ({ id: `${kb.id}:${doc.id}:${i}`, kbId: kb.id, docId: doc.id, docName: name, i, text: c.text, page: c.page || null, vec: null }));
  const emb = kb.embed && api.embedAvailable(kb.embed) ? kb.embed : null;
  if (emb) {
    for (let i = 0; i < rows.length; i += 64) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      onProgress?.(`Embedding ${name} ${Math.min(i + 64, rows.length)}/${rows.length}`);
      const { vectors } = await api.embed(emb.provider, emb.model, rows.slice(i, i + 64).map(r => r.text), signal);
      vectors.forEach((v, j) => { rows[i + j].vec = new Float32Array(v); });
      if (!kb.embed.dim) kb.embed.dim = vectors[0]?.length || 0;
    }
  }
  await DB.putMany('chunks', rows);
  rows.forEach(r => dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'chunks', id: r.id } })));
  kb.docs.push(doc); kb.chunks = (kb.chunks || 0) + rows.length; kb.vectors = !!emb && (kb.vectors !== false);
  bm25Cache.delete(kb.id);
  await saveKB(kb);
  return doc;
}
export async function removeDocument(kb, docId) {
  const rows = await DB.byIndex('chunks', 'kb', kb.id);
  const del = rows.filter(r => r.docId === docId);
  await Promise.all(del.map(r => DB.del('chunks', r.id)));
  del.forEach(r => dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'chunks', id: r.id } })));
  kb.docs = kb.docs.filter(d => d.id !== docId); kb.chunks = Math.max(0, (kb.chunks || 0) - del.length);
  bm25Cache.delete(kb.id); await saveKB(kb);
}
export async function deleteKB(kb) {
  const rows = await DB.byIndex('chunks', 'kb', kb.id);
  await DB.delByIndex('chunks', 'kb', kb.id);
  rows.forEach(r => dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'chunks', id: r.id } })));
  kbs = kbs.filter(k => k.id !== kb.id);
  await DB.put('kbs', { id: kb.id, deleted: true, updated: Date.now() });
  dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'kbs', id: kb.id } }));
}
/** Re-embed every chunk (after changing the embedding model). */
export async function rebuildEmbeddings(kb, { signal, onProgress } = {}) {
  const emb = api.embedChoice();
  if (!emb) throw new Error('No embedding provider available (add an OpenAI, Gemini or compatible key, or pick one in Knowledge → Settings).');
  const rows = await DB.byIndex('chunks', 'kb', kb.id);
  kb.embed = { ...emb, dim: 0 };
  for (let i = 0; i < rows.length; i += 64) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress?.(`Embedding ${Math.min(i + 64, rows.length)}/${rows.length}`);
    const { vectors } = await api.embed(emb.provider, emb.model, rows.slice(i, i + 64).map(r => r.text), signal);
    vectors.forEach((v, j) => { rows[i + j].vec = new Float32Array(v); });
    kb.embed.dim = vectors[0]?.length || kb.embed.dim;
  }
  await DB.putMany('chunks', rows); rows.forEach(r => dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'chunks', id: r.id } }))); kb.vectors = true; await saveKB(kb);
}

/* ---------- Search ---------- */
const STOP = new Set('a an the and or of to in on for is are was were be been it this that with as at by from not no yes but if then so do does did have has had i you he she we they them my your our their its what which who how when where why can will would should could dan yang di ke dari ini itu untuk dengan pada ialah adalah atau tidak saya anda kami mereka dia apa bagaimana bila mana kenapa'.split(' '));
const tok = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{2,}/gu)?.filter(w => !STOP.has(w)) || [];
const bm25Cache = new Map();
async function loadIndex(kbId) {
  if (bm25Cache.has(kbId)) return bm25Cache.get(kbId);
  const rows = await DB.byIndex('chunks', 'kb', kbId);
  const docs = rows.map(r => { const t = tok(r.text), tf = new Map(); for (const w of t) tf.set(w, (tf.get(w) || 0) + 1); return { r, tf, len: t.length }; });
  const df = new Map(); for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const idx = { docs, df, avg: docs.reduce((a, d) => a + d.len, 0) / Math.max(docs.length, 1) };
  bm25Cache.set(kbId, idx);
  return idx;
}
function bm25(idx, q, k1 = 1.4, b = 0.75) {
  const terms = [...new Set(tok(q))], N = idx.docs.length;
  return idx.docs.map(d => {
    let s = 0;
    for (const t of terms) { const f = d.tf.get(t); if (!f) continue; const n = idx.df.get(t) || 0; s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * f * (k1 + 1) / (f + k1 * (1 - b + b * d.len / idx.avg)); }
    return { r: d.r, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
}
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

/** Hybrid search across knowledge bases. Returns [{ text, docName, page, kbName, score }]. */
export async function search(kbIds, query, { k = 6, signal } = {}) {
  const list = kbIds.map(kbById).filter(Boolean); if (!list.length || !query.trim()) return [];
  const fused = new Map();
  const add = (arr, w) => arr.forEach((x, rank) => { const f = fused.get(x.r.id) || { r: x.r, s: 0 }; f.s += w / (60 + rank); fused.set(x.r.id, f); });
  for (const kb of list) {
    const idx = await loadIndex(kb.id);
    add(bm25(idx, query).slice(0, 40), 1);
    if (kb.vectors && kb.embed && api.embedAvailable(kb.embed)) {
      try {
        const { vectors } = await api.embed(kb.embed.provider, kb.embed.model, [query], signal);
        const qv = vectors[0];
        const sims = idx.docs.filter(d => d.r.vec?.length === qv.length).map(d => ({ r: d.r, s: cos(qv, d.r.vec) })).sort((a, b) => b.s - a.s).slice(0, 40);
        add(sims, 1.2);
      } catch (e) { if (e.name === 'AbortError') throw e; console.warn('embedding search failed, keyword only', e); }
    }
  }
  return [...fused.values()].sort((a, b) => b.s - a.s).slice(0, k).map(x => ({ text: x.r.text, docName: x.r.docName, page: x.r.page, kbName: kbById(x.r.kbId)?.name || '', score: x.s }));
}
/** System-prompt block + sources list for a chat turn. */
export function contextBlock(hits) {
  if (!hits.length) return { text: '', sources: [] };
  const sources = hits.map((h, i) => ({ n: i + 1, doc: h.docName, page: h.page, kb: h.kbName, text: h.text.slice(0, 1200) }));
  const text = `## Knowledge base excerpts\nThe user has connected documents. Use these excerpts when relevant and cite them inline like [1] or [2][3]. If they don't contain the answer, say so briefly and answer from general knowledge if helpful.\n\n` +
    hits.map((h, i) => `[${i + 1}] ${h.docName}${h.page ? ` (${h.page})` : ''}:\n${h.text}`).join('\n\n');
  return { text, sources };
}

/* ============================================================
   UI
   ============================================================ */
let hooks = { activeIds: () => [], toggleForChat: () => {}, inChat: () => false };
export function setKBHooks(h) { hooks = { ...hooks, ...h }; }
let busy = null;

export function openKB(id) {
  if (id) return openKBDetail(kbById(id));
  const emb = api.embedChoice();
  openModal(`<div class="dlg-title"><h2>📚 Knowledge</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">Add documents (PDF, Word, Excel, text, code, web pages) and chat with them. Answers cite the exact document and page. Indexing happens on this device; only the excerpts relevant to each question are sent to the AI.</p>
    <div class="kbs">${kbs.map(k => `<button class="kb-card ${hooks.inChat(k.id) ? 'on' : ''}" data-kb="${k.id}"><span class="kb-ico">${esc(k.icon || '📚')}</span><span class="kb-t"><b>${esc(k.name)}</b><small>${k.docs.length} doc${k.docs.length === 1 ? '' : 's'} · ${fmtNum(k.chunks || 0)} chunks · ${k.vectors ? 'semantic + keyword' : 'keyword search'}</small></span>${hooks.inChat(k.id) ? '<span class="badge ok">in chat</span>' : ''}</button>`).join('') || '<p class="hint">No knowledge bases yet.</p>'}</div>
    <h3>Search engine</h3>
    <p class="hint">${emb ? `Semantic search uses <b>${esc(emb.model)}</b> (${esc(emb.provider)}).` : 'No embedding provider found — keyword search only. Add an OpenAI or Gemini key (or pick an Ollama/custom model below) for smarter semantic search.'}</p>
    <div class="grid2"><label>Embedding provider<select id="kb-ep">${[['auto', 'Automatic'], ['openai', 'OpenAI'], ['gemini', 'Google Gemini'], ['ollama', 'Ollama (local)'], ['custom', 'Custom OpenAI-compatible'], ['none', 'None (keyword only)']].map(([v, l]) => `<option value="${v}" ${S.embed.provider === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Embedding model<input id="kb-em" value="${esc(S.embed.model)}" placeholder="default (text-embedding-3-small / gemini-embedding-001 / nomic-embed-text)"></label></div>
    <div class="dlg-actions"><button class="btn" data-close>Close</button><button class="btn primary" id="kb-new">＋ New knowledge base</button></div>`, 'wide');
  $('.kbs').onclick = e => { const b = e.target.closest('[data-kb]'); if (b) openKBDetail(kbById(b.dataset.kb)); };
  const saveEmb = () => { S.embed = { provider: $('#kb-ep').value, model: $('#kb-em').value.trim() }; api.saveSettings(); };
  $('#kb-ep').onchange = () => { saveEmb(); openKB(); };
  $('#kb-em').onchange = saveEmb;
  $('#kb-new').onclick = async () => {
    const name = prompt('Name for the knowledge base', 'My documents'); if (!name?.trim()) return;
    const emb2 = api.embedChoice();
    const kb = { id: uid(), name: name.trim().slice(0, 60), icon: '📚', docs: [], chunks: 0, embed: emb2 ? { ...emb2, dim: 0 } : null, vectors: !!emb2, created: Date.now() };
    await saveKB(kb); openKBDetail(kb);
  };
}

function openKBDetail(kb) {
  if (!kb) return openKB();
  const inChat = hooks.inChat(kb.id);
  openModal(`<div class="dlg-title"><h2>${esc(kb.icon || '📚')} ${esc(kb.name)}</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <div class="inrow wrap"><button class="btn ${inChat ? '' : 'primary'}" id="kd-use">${inChat ? '✓ Used in this chat — turn off' : '💬 Use in this chat'}</button><span class="hint">${kb.vectors && kb.embed ? `Semantic: ${esc(kb.embed.model)}` : 'Keyword search'} · ${fmtNum(kb.chunks || 0)} chunks</span></div>
    <h3>Documents (${kb.docs.length})</h3>
    <div class="kb-docs">${kb.docs.map(d => `<div class="kb-doc"><span>${/\.pdf$/i.test(d.name) ? '📕' : /^https?:/.test(d.source) ? '🌐' : '📄'}</span><div><b>${esc(d.name)}</b><small>${d.chunks} chunks · ${d.size ? fmtBytes(d.size) + ' · ' : ''}${fmtDate(d.added)}</small></div><button class="icon sm" data-rm="${d.id}" aria-label="Remove ${esc(d.name)}">🗑</button></div>`).join('') || '<p class="hint">No documents yet — add some below.</p>'}</div>
    <div class="inrow wrap" style="margin-top:10px"><button class="btn" id="kd-up">📎 Upload files</button><button class="btn" id="kd-files">📁 From My Files</button><button class="btn" id="kd-url">🌐 Add web page</button><button class="btn" id="kd-paste">📝 Paste text</button></div>
    <input type="file" id="kd-input" multiple hidden accept=".pdf,.docx,.xlsx,.xls,.ods,.txt,.md,.csv,.tsv,.json,.html,.htm,.xml,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.rs,.php,.rb,.sql,.yml,.yaml,.log,.srt,.vtt">
    <div id="kd-progress" class="hint"></div>
    <h3>Test search</h3>
    <div class="inrow"><input id="kd-q" placeholder="Ask something to see which excerpts are found"><button class="btn" id="kd-search">Search</button></div>
    <div id="kd-results"></div>
    <div class="dlg-actions"><button class="btn danger" id="kd-del">Delete</button><button class="btn" id="kd-ren">Rename</button>${api.embedChoice() ? `<button class="btn" id="kd-rebuild">${kb.vectors ? '↻ Re-embed' : '✨ Enable semantic search'}</button>` : ''}<button class="btn" id="kd-back">← All</button><button class="btn primary" data-close>Done</button></div>`, 'wide');
  const prog = t => { const el = $('#kd-progress'); if (el) el.textContent = t; };
  const run = async (label, fn) => {
    if (busy) return toast('Please wait for the current indexing to finish');
    const ctl = new AbortController(); busy = ctl; prog(label);
    try { await fn(ctl.signal); } catch (e) { if (e.name !== 'AbortError') toast(e.message, 5000); }
    busy = null; openKBDetail(kb);
  };
  const ingest = (items) => run('Reading…', async signal => {
    let ok = 0;
    for (const it of items) {
      try { prog(`Reading ${it.name}…`); const text = await it.getText(); await addDocument(kb, { name: it.name, size: it.size, text, source: it.source }, { signal, onProgress: prog }); ok++; }
      catch (e) { if (e.name === 'AbortError') throw e; toast(`${it.name}: ${e.message}`, 5000); }
    }
    if (ok) toast(`📚 Added ${ok} document${ok === 1 ? '' : 's'}`);
  });
  $('#kd-use').onclick = () => { hooks.toggleForChat(kb.id); openKBDetail(kb); };
  $('#kd-up').onclick = () => $('#kd-input').click();
  $('#kd-input').onchange = e => ingest([...e.target.files].map(f => { const ent = { id: uid(), name: f.name, ext: (f.name.split('.').pop() || '').toLowerCase(), size: f.size, file: f }; return { name: f.name, size: f.size, getText: () => F.extractText(ent, 5e6) }; }));
  $('#kd-files').onclick = () => pickFromMyFiles(list => { openKBDetail(kb); ingest(list.map(e => ({ name: e.name, size: e.size, source: e.path, getText: () => F.extractText(e, 5e6) }))); });
  $('#kd-url').onclick = () => { const u = prompt('Web page URL'); if (u) ingest([{ name: u.replace(/^https?:\/\//, '').slice(0, 80), source: u, getText: () => readWeb(u) }]); };
  $('#kd-paste').onclick = () => {
    openModal(`<div class="dlg-title"><h2>📝 Paste text</h2></div><label>Title<input id="pt-t" value="Notes"></label><label>Text<textarea id="pt-x" rows="12"></textarea></label><div class="dlg-actions"><button class="btn" id="pt-c">Cancel</button><button class="btn primary" id="pt-s">Add</button></div>`);
    $('#pt-c').onclick = () => openKBDetail(kb);
    $('#pt-s').onclick = () => { const t = $('#pt-x').value; const n = $('#pt-t').value.trim() || 'Notes'; openKBDetail(kb); ingest([{ name: n, size: t.length, getText: async () => t }]); };
  };
  $('.kb-docs').onclick = async e => { const b = e.target.closest('[data-rm]'); if (b && confirm('Remove this document from the knowledge base?')) { await removeDocument(kb, b.dataset.rm); openKBDetail(kb); } };
  const doSearch = async () => {
    const q = $('#kd-q').value.trim(); if (!q) return;
    $('#kd-results').innerHTML = '<p class="hint">Searching…</p>';
    try {
      const hits = await search([kb.id], q, { k: 5 });
      $('#kd-results').innerHTML = hits.map((h, i) => `<div class="kb-hit"><b>[${i + 1}] ${esc(h.docName)}${h.page ? ' · ' + esc(h.page) : ''}</b><p>${esc(h.text.slice(0, 400))}${h.text.length > 400 ? '…' : ''}</p></div>`).join('') || '<p class="hint">Nothing relevant found.</p>';
    } catch (err) { $('#kd-results').innerHTML = `<p class="hint">⚠️ ${esc(err.message)}</p>`; }
  };
  $('#kd-search').onclick = doSearch;
  $('#kd-q').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
  $('#kd-back').onclick = () => openKB();
  $('#kd-ren').onclick = async () => { const n = prompt('Rename', kb.name); if (n?.trim()) { kb.name = n.trim().slice(0, 60); await saveKB(kb); openKBDetail(kb); } };
  $('#kd-del').onclick = async () => { if (confirm(`Delete “${kb.name}” and its index? Your original files are not touched.`)) { await deleteKB(kb); hooks.toggleForChat(kb.id, false); openKB(); } };
  const rb = $('#kd-rebuild'); if (rb) rb.onclick = () => run('Embedding…', signal => rebuildEmbeddings(kb, { signal, onProgress: prog }).then(() => toast('✨ Semantic search ready')));
}

function pickFromMyFiles(done) {
  if (!F.hasFiles()) { toast('Add a folder in 📁 My Files first'); closeModal(); F.openExplorer(); return; }
  const list = F.query({ kind: 'all' }).filter(F.canExtract);
  openModal(`<div class="dlg-title"><h2>📁 Choose documents</h2></div>
    <input id="pk-f" type="search" placeholder="Filter by name…">
    <div class="pick-list">${list.slice(0, 1000).map(e => `<label class="check pick"><input type="checkbox" value="${e.id}"> <span>${esc(e.path)}</span><small>${fmtBytes(e.size)}</small></label>`).join('') || '<p class="hint">No readable documents found in your folders.</p>'}</div>
    <div class="dlg-actions"><button class="btn" id="pk-all">Select shown</button><button class="btn" id="pk-c">Cancel</button><button class="btn primary" id="pk-ok">Add selected</button></div>`, 'wide');
  $('#pk-f').oninput = e => { const q = e.target.value.toLowerCase(); $$('.pick').forEach(l => { l.hidden = q && !l.textContent.toLowerCase().includes(q); }); };
  $('#pk-all').onclick = () => $$('.pick:not([hidden]) input').forEach(i => { i.checked = true; });
  $('#pk-c').onclick = () => closeModal();
  $('#pk-ok').onclick = () => { const ids = new Set($$('.pick input:checked').map(i => i.value)); const sel = list.filter(e => ids.has(e.id)); if (!sel.length) return toast('Select some files'); done(sel); };
}
