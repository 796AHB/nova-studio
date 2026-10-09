/* Local Files: browse, filter, search inside and scan folders on this phone / PC / laptop.
   Files never leave the device unless you attach them or let the AI read them (Files connector).
   - Desktop Chrome/Edge/Opera: folder access is remembered (File System Access API).
   - Phones & other browsers: pick a folder or files each session. */
import { DB, S, saveSettings } from './store.js';
import { $, $$, esc, uid, toast, fmtNum, fmtBytes, fmtDate, loadScript, download } from './util.js';

/* ---------- File kinds ---------- */
const EXT = {
  image: 'jpg jpeg png gif webp heic heif bmp svg avif tif tiff ico raw dng cr2 nef arw',
  video: 'mp4 mov mkv webm avi 3gp m4v wmv flv mts',
  audio: 'mp3 wav m4a aac ogg oga flac opus amr wma mid midi',
  document: 'pdf doc docx odt rtf txt md markdown pages epub xls xlsx csv tsv ods numbers ppt pptx key odp log srt vtt',
  code: 'js mjs cjs ts tsx jsx py java kt c cc cpp h hpp cs go rs rb php swift html htm css scss less json jsonl xml yml yaml toml ini env sql sh bash zsh bat ps1 r lua dart vue svelte ipynb gradle',
  archive: 'zip rar 7z tar gz tgz bz2 xz apk ipa dmg iso jar',
};
const KIND_OF = {};
for (const [k, list] of Object.entries(EXT)) for (const e of list.split(' ')) KIND_OF[e] = k;
export const KINDS = { all: ['🗂️', 'All'], image: ['🖼️', 'Images'], video: ['🎞️', 'Videos'], audio: ['🎵', 'Audio'], document: ['📄', 'Docs'], code: ['💻', 'Code'], archive: ['🗜️', 'Archives'], other: ['📦', 'Other'] };
const TEXT_EXT = new Set('txt md markdown csv tsv log srt vtt rtf json jsonl xml yml yaml toml ini env sql sh bash zsh bat ps1 js mjs cjs ts tsx jsx py java kt c cc cpp h hpp cs go rs rb php swift html htm css scss less r lua dart vue svelte gradle ipynb'.split(' '));
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.cache', '.Trash', '$RECYCLE.BIN', 'System Volume Information', '.thumbnails']);
const extOf = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const kindOf = n => KIND_OF[extOf(n)] || 'other';
function iconOf(e) {
  const x = e.ext;
  if (x === 'pdf') return '📕'; if (/^(xls|xlsx|csv|tsv|ods|numbers)$/.test(x)) return '📊'; if (/^(ppt|pptx|key|odp)$/.test(x)) return '📽️';
  if (x === 'apk') return '🤖';
  return KINDS[e.kind]?.[0] || '📦';
}

/* ---------- State ---------- */
export const roots = [];      // { id, name, type: 'handle'|'picked', handle?, status, count, size, error? }
export let entries = [];      // { id, rootId, path, dir, name, ext, kind, size, modified, file?, handle? }
let hooks = { attach: async () => {}, ask: () => {}, onChange: () => {} };
export const canPickFolder = () => 'showDirectoryPicker' in window;
export const hasFiles = () => entries.length > 0;

function uniqueName(name) {
  let n = name || 'Files', i = 2;
  while (roots.some(r => r.name === n)) n = `${name} (${i++})`;
  return n;
}
function rebuild() { entries = roots.flatMap(r => r.entries || []); hooks.onChange(); }
export const getFile = e => e.file ? Promise.resolve(e.file) : e.handle.getFile();
export const findEntry = path => {
  const p = String(path || '').replace(/^\/+/, '').trim();
  return entries.find(e => e.path === p) || entries.find(e => e.path.toLowerCase() === p.toLowerCase()) || entries.find(e => e.path.endsWith('/' + p));
};

export async function initFiles(h) {
  hooks = { ...hooks, ...h };
  let saved = [];
  try { saved = await DB.all('roots'); } catch {}
  for (const r of saved) {
    const root = { id: r.id, name: uniqueName(r.name), type: 'handle', handle: r.handle, status: 'needs-permission', count: 0, size: 0, entries: [] };
    roots.push(root);
    try { if (await r.handle.queryPermission({ mode: 'read' }) === 'granted') scanRoot(root); } catch {}
  }
  hooks.onChange();
}

/* ---------- Adding sources ---------- */
export async function addFolder() {
  if (canPickFolder()) {
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'nova-files', mode: 'read' }); }
    catch (e) { if (e.name !== 'AbortError') toast('Could not open folder: ' + e.message); return null; }
    for (const r of roots) if (r.handle && await r.handle.isSameEntry?.(handle)) { toast('That folder is already added'); return r; }
    const root = { id: uid(), name: uniqueName(handle.name), type: 'handle', handle, status: 'scanning', count: 0, size: 0, entries: [] };
    roots.push(root);
    try { await DB.put('roots', { id: root.id, name: handle.name, handle }); } catch {}
    await scanRoot(root);
    return root;
  }
  return pickViaInput(true);
}
export const addPickedFiles = () => pickViaInput(false);

function pickViaInput(folder) {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    if (folder) { inp.webkitdirectory = true; inp.setAttribute('webkitdirectory', ''); }
    inp.onchange = () => res(addFileList([...inp.files], folder));
    inp.addEventListener('cancel', () => res(null));
    inp.click();
  });
}
export function addFileList(files, folder) {
  if (!files.length) return null;
  const first = files[0].webkitRelativePath || '';
  const base = folder && first.includes('/') ? first.split('/')[0] : `Picked ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  const root = { id: uid(), name: uniqueName(base), type: 'picked', status: 'ready', count: 0, size: 0, entries: [] };
  for (const f of files) {
    let rel = f.webkitRelativePath || f.name;
    if (folder && rel.includes('/')) rel = rel.split('/').slice(1).join('/');
    if (!S.files.hidden && rel.split('/').some(seg => seg.startsWith('.') || SKIP_DIRS.has(seg))) continue;
    root.entries.push(makeEntry(root, rel, f.name, f.size, f.lastModified, { file: f }));
  }
  finalize(root);
  roots.push(root); rebuild();
  return root;
}
function makeEntry(root, rel, name, size, modified, extra) {
  const path = `${root.name}/${rel}`;
  return { id: uid(), rootId: root.id, path, dir: path.slice(0, path.lastIndexOf('/')), name, ext: extOf(name), kind: kindOf(name), size, modified, ...extra };
}
function finalize(root) { root.count = root.entries.length; root.size = root.entries.reduce((a, e) => a + e.size, 0); }

export async function reconnect(root) {
  try {
    if (await root.handle.requestPermission({ mode: 'read' }) !== 'granted') { toast('Permission was not granted'); return; }
    await scanRoot(root);
  } catch (e) { toast('Could not reconnect: ' + e.message); }
}
let scanToken = 0;
export async function scanRoot(root) {
  const my = ++scanToken;
  root.status = 'scanning'; root.entries = []; root.error = ''; hooks.onChange();
  const max = +S.files.maxFiles || 50000;
  let last = 0;
  async function walk(dir, rel) {
    for await (const [name, h] of dir.entries()) {
      if (root.entries.length >= max) return;
      if (!S.files.hidden && name.startsWith('.')) continue;
      if (h.kind === 'directory') { if (!SKIP_DIRS.has(name)) await walk(h, rel + name + '/'); continue; }
      try { const f = await h.getFile(); root.entries.push(makeEntry(root, rel + name, name, f.size, f.lastModified, { handle: h })); } catch {}
      if (root.entries.length - last >= 400) { last = root.entries.length; root.count = last; hooks.onChange(); }
    }
  }
  try { await walk(root.handle, ''); root.status = 'ready'; }
  catch (e) { root.status = 'error'; root.error = e.message; }
  finalize(root);
  if (root.entries.length >= max) toast(`${root.name}: stopped at ${fmtNum(max)} files`);
  if (my === scanToken || root.status !== 'scanning') rebuild();
}
export async function removeRoot(root) {
  const i = roots.indexOf(root); if (i < 0) return;
  roots.splice(i, 1);
  try { await DB.del('roots', root.id); } catch {}
  rebuild();
}

/* ---------- Text extraction (text, code, PDF, Word, Excel) ---------- */
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/';
const textCache = new Map(); let cacheChars = 0;
export const canExtract = e => TEXT_EXT.has(e.ext) || /^(pdf|docx|xlsx|xls|ods)$/.test(e.ext);
export async function extractText(e, maxChars = 200000) {
  if (textCache.has(e.id)) return textCache.get(e.id).slice(0, maxChars);
  const f = await getFile(e);
  let text = '';
  if (TEXT_EXT.has(e.ext)) {
    if (f.size > 20 * 1024 * 1024) throw new Error('Text file is larger than 20 MB');
    text = await f.text();
    if (e.ext === 'ipynb') try { text = JSON.parse(text).cells.map(c => [].concat(c.source).join('')).join('\n\n'); } catch {}
  } else if (e.ext === 'pdf') {
    await loadScript(CDN + 'pdf.js/3.11.174/pdf.min.js');
    const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = CDN + 'pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    const pages = Math.min(pdf.numPages, 80);
    for (let i = 1; i <= pages && text.length < maxChars; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      text += `\n--- Page ${i} ---\n` + tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('');
    }
    if (pdf.numPages > pages) text += `\n…(${pdf.numPages - pages} more pages not read)`;
    if (!text.replace(/--- Page \d+ ---|\s/g, '')) text = '(This PDF has no text layer — it is probably scanned images.)';
  } else if (e.ext === 'docx') {
    await loadScript(CDN + 'mammoth/1.13.0/mammoth.browser.min.js');
    text = (await window.mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() })).value;
  } else if (/^(xlsx|xls|ods)$/.test(e.ext)) {
    await loadScript(CDN + 'xlsx/0.18.5/xlsx.full.min.js');
    const wb = window.XLSX.read(await f.arrayBuffer(), { type: 'array' });
    text = wb.SheetNames.map(n => `--- Sheet: ${n} ---\n` + window.XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
  } else throw new Error(`Can't read text from .${e.ext || '?'} files`);
  if (text.length < 2e6) {
    textCache.set(e.id, text); cacheChars += text.length;
    while (cacheChars > 3e7 && textCache.size) { const [k, v] = textCache.entries().next().value; textCache.delete(k); cacheChars -= v.length; }
  }
  return text.slice(0, maxChars);
}

/* ---------- Querying (shared by explorer UI and AI tools) ---------- */
export function query({ q = '', kind = 'all', ext = '', minSize = 0, maxSize = 0, days = 0, folder = '', sort = 'name', limit = 0 } = {}) {
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const exts = String(ext).toLowerCase().split(/[\s,]+/).map(x => x.replace(/^\./, '')).filter(Boolean);
  const since = days ? Date.now() - days * 864e5 : 0;
  const scope = String(folder).replace(/^\/+|\/+$/g, '');
  let r = entries.filter(e =>
    (kind === 'all' || e.kind === kind) &&
    (!exts.length || exts.includes(e.ext)) &&
    (!minSize || e.size >= minSize) && (!maxSize || e.size <= maxSize) &&
    (!since || e.modified >= since) &&
    (!scope || e.path.toLowerCase().startsWith(scope.toLowerCase() + '/')) &&
    (!terms.length || terms.every(t => wildcard(t).test(e.path.toLowerCase()))));
  const cmp = { name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }), newest: (a, b) => b.modified - a.modified, oldest: (a, b) => a.modified - b.modified, largest: (a, b) => b.size - a.size, smallest: (a, b) => a.size - b.size }[sort] || (() => 0);
  r.sort(cmp);
  return limit ? r.slice(0, limit) : r;
}
const wcCache = new Map();
function wildcard(t) {
  if (!wcCache.has(t)) wcCache.set(t, new RegExp(t.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')));
  return wcCache.get(t);
}
export function listFolder(path) {
  const p = String(path || '').replace(/^\/+|\/+$/g, '');
  if (!p) return { folders: roots.map(r => ({ name: r.name, path: r.name, count: r.count, size: r.size, root: r })), files: [] };
  const folders = new Map(), files = [], pre = p + '/';
  for (const e of entries) {
    if (!e.path.startsWith(pre)) continue;
    const rest = e.path.slice(pre.length), i = rest.indexOf('/');
    if (i < 0) files.push(e);
    else { const n = rest.slice(0, i), f = folders.get(n) || { name: n, path: pre + n, count: 0, size: 0 }; f.count++; f.size += e.size; folders.set(n, f); }
  }
  return { folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), files: files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) };
}

/** Search inside file contents. onProgress(done, total). Returns [{ e, hits: [snippet] }]. */
export async function grep(text, list, { signal, onProgress, maxResults = 200, maxFiles = 3000 } = {}) {
  const needle = String(text).toLowerCase(); if (!needle) return [];
  const cands = list.filter(e => canExtract(e) && e.size <= 30 * 1024 * 1024).slice(0, maxFiles);
  const out = [];
  for (let i = 0; i < cands.length && out.length < maxResults; i++) {
    if (signal?.aborted) break;
    onProgress?.(i, cands.length);
    let t; try { t = await extractText(cands[i], 2e6); } catch { continue; }
    const low = t.toLowerCase(), hits = []; let at = low.indexOf(needle);
    while (at >= 0 && hits.length < 3) {
      const s = Math.max(0, at - 60), en = Math.min(t.length, at + needle.length + 60);
      hits.push({ before: t.slice(s, at).replace(/\s+/g, ' '), match: t.slice(at, at + needle.length), after: t.slice(at + needle.length, en).replace(/\s+/g, ' ') });
      at = low.indexOf(needle, at + needle.length);
    }
    if (hits.length) out.push({ e: cands[i], hits });
    if (i % 20 === 0) await new Promise(r => setTimeout(r));
  }
  onProgress?.(cands.length, cands.length);
  return out;
}

/** Library scan report. Hashes same-size candidates to confirm duplicates. */
export async function scanReport({ signal, onProgress, hash = true } = {}) {
  const byKind = {};
  for (const k of Object.keys(KINDS)) if (k !== 'all') byKind[k] = { count: 0, size: 0 };
  let total = 0;
  for (const e of entries) { byKind[e.kind].count++; byKind[e.kind].size += e.size; total += e.size; }
  const largest = [...entries].sort((a, b) => b.size - a.size).slice(0, 15);
  const recent = [...entries].sort((a, b) => b.modified - a.modified).slice(0, 10);
  const yearAgo = Date.now() - 365 * 864e5, old = entries.filter(e => e.modified && e.modified < yearAgo);
  const empty = entries.filter(e => e.size === 0);
  const bySize = new Map();
  for (const e of entries) if (e.size > 0) { const l = bySize.get(e.size) || []; l.push(e); bySize.set(e.size, l); }
  const cand = [...bySize.values()].filter(l => l.length > 1);
  const groups = [];
  let done = 0, todo = cand.reduce((a, l) => a + l.length, 0);
  for (const l of cand) {
    if (signal?.aborted) break;
    if (!hash || l[0].size > 200 * 1024 * 1024 || !crypto.subtle) {
      const byName = new Map(); for (const e of l) { const k = e.name.toLowerCase(); byName.set(k, [...(byName.get(k) || []), e]); }
      for (const g of byName.values()) if (g.length > 1) groups.push({ files: g, size: g[0].size, sure: false });
      done += l.length; continue;
    }
    const byHash = new Map();
    for (const e of l) {
      if (signal?.aborted) break;
      try { const h = await sha256(await getFile(e)); byHash.set(h, [...(byHash.get(h) || []), e]); } catch {}
      onProgress?.(++done, todo);
    }
    for (const g of byHash.values()) if (g.length > 1) groups.push({ files: g, size: g[0].size, sure: true });
  }
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
  const wasted = groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
  return { count: entries.length, total, byKind, largest, recent, old: { count: old.length, size: old.reduce((a, e) => a + e.size, 0) }, empty, dupes: groups, wasted, partial: !!signal?.aborted };
}
async function sha256(file) {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function reportText(r) {
  const k = Object.entries(r.byKind).filter(([, v]) => v.count).map(([n, v]) => `- ${KINDS[n][1]}: ${fmtNum(v.count)} files, ${fmtBytes(v.size)}`).join('\n');
  return `File scan report (${roots.map(x => x.name).join(', ')}):
Total: ${fmtNum(r.count)} files, ${fmtBytes(r.total)}
By type:
${k}
Largest files:
${r.largest.slice(0, 10).map(e => `- ${e.path} (${fmtBytes(e.size)}, ${fmtDate(e.modified)})`).join('\n')}
Duplicates: ${r.dupes.length} groups, ${fmtBytes(r.wasted)} could be freed
${r.dupes.slice(0, 8).map(g => `- ${fmtBytes(g.size)} × ${g.files.length}: ${g.files.map(e => e.path).join(' | ')}`).join('\n')}
Not modified in over a year: ${fmtNum(r.old.count)} files, ${fmtBytes(r.old.size)}
Empty files: ${r.empty.length}`;
}

/* ============================================================
   Explorer UI
   ============================================================ */
const st = { view: 'browse', cwd: '', q: '', kind: 'all', size: 0, days: 0, sort: 'name', deep: false, shown: 200, sel: new Set(), grep: null, busy: null, report: null };
let dlg = null, thumbObs = null;
const thumbs = new Map();
const SIZES = [[0, 'Any size'], [1, '> 1 MB'], [10, '> 10 MB'], [100, '> 100 MB'], [1000, '> 1 GB']];
const AGES = [[0, 'Any time'], [1, 'Today'], [7, '7 days'], [30, '30 days'], [365, 'This year']];
const SORTS = [['name', 'Name'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['largest', 'Largest'], ['smallest', 'Smallest']];
const filtering = () => !!(st.q || st.kind !== 'all' || st.size || st.days || st.grep);

export function openExplorer() {
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'filesDlg'; document.body.append(dlg);
    dlg.addEventListener('close', cleanupThumbs);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onChange);
    dlg.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'fx-q' && st.deep) { e.preventDefault(); runGrep(); } });
  }
  render();
  if (!dlg.open) dlg.showModal();
}
export const refreshExplorer = () => { if (dlg?.open) render(); };

function render() {
  const busy = st.busy;
  const srcs = roots.map(r => `<div class="src ${r.status}" title="${esc(r.name)}"><span>${r.type === 'handle' ? '💻' : '📱'} ${esc(r.name)}</span><small>${r.status === 'scanning' ? `scanning… ${fmtNum(r.count)}` : r.status === 'needs-permission' ? 'tap to reconnect' : r.status === 'error' ? 'error' : `${fmtNum(r.count)} · ${fmtBytes(r.size)}`}</small>
    ${r.status === 'needs-permission' ? `<button class="chip sm on" data-fx="reconnect" data-id="${r.id}">🔓 Reconnect</button>` : r.type === 'handle' ? `<button class="icon sm" data-fx="rescan" data-id="${r.id}" title="Rescan" aria-label="Rescan">↻</button>` : ''}
    <button class="icon sm" data-fx="remove" data-id="${r.id}" title="Remove" aria-label="Remove ${esc(r.name)}">✕</button></div>`).join('');
  dlg.innerHTML = `<div class="fx">
  <div class="dlg-title"><h2>📁 My files</h2><div class="inrow"><div class="seg sm" role="tablist"><button data-fx="view" data-v="browse" class="${st.view === 'browse' ? 'active' : ''}">Explore</button><button data-fx="view" data-v="scan" class="${st.view === 'scan' ? 'active' : ''}">Scan</button></div><button class="icon sm" data-fx="close" aria-label="Close">✕</button></div></div>
  <div class="srcs">${srcs}<button class="chip" data-fx="add-folder">📂 Add folder</button><button class="chip" data-fx="add-files">📄 Add files</button></div>
  ${!roots.length ? emptyHTML() : st.view === 'scan' ? scanHTML() : browseHTML()}
  ${busy ? `<div class="fx-busy"><span class="dots"><i></i><i></i><i></i></span><span>${esc(busy.label)}</span><button class="btn sm" data-fx="cancel">Cancel</button></div>` : ''}
  </div>`;
  const q = $('#fx-q', dlg); if (q && document.activeElement === document.body) q.focus({ preventScroll: true });
  observeThumbs();
}
function emptyHTML() {
  const mobile = matchMedia('(pointer: coarse)').matches;
  return `<div class="fx-empty"><div class="logo">📁</div><h3>Explore files on this ${mobile ? 'phone' : 'computer'}</h3>
    <p class="hint">Browse, filter and search inside your files, find duplicates and big files — and let the AI explore them with you.<br>Everything stays on your device unless you attach a file or turn on the 📁 Files connector.</p>
    <div class="inrow wrap center"><button class="btn primary" data-fx="add-folder">📂 Choose a folder</button><button class="btn" data-fx="add-files">📄 Pick files</button></div>
    <p class="hint">${canPickFolder() ? '💻 Folder access is remembered on this browser.' : mobile ? '📱 On phones, pick a folder or files (e.g. Downloads, DCIM, Documents). You may need to pick again after reopening the app.' : 'This browser can read a folder you pick, for this session.'}</p></div>`;
}
function browseHTML() {
  const chips = Object.entries(KINDS).map(([k, [ic, l]]) => { const n = k === 'all' ? entries.length : entries.filter(e => e.kind === k).length; return n || k === 'all' ? `<button class="chip sm ${st.kind === k ? 'on' : ''}" data-fx="kind" data-k="${k}">${ic} ${l} <small>${fmtNum(n)}</small></button>` : ''; }).join('');
  const opt = (list, v) => list.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${l}</option>`).join('');
  const crumbs = ['<button data-fx="cd" data-p="">🏠</button>', ...st.cwd.split('/').filter(Boolean).map((seg, i, a) => `<button data-fx="cd" data-p="${esc(a.slice(0, i + 1).join('/'))}">${esc(seg)}</button>`)].join('<span>›</span>');
  let list = '', count = '';
  if (st.grep) {
    count = `${st.grep.length} file${st.grep.length === 1 ? '' : 's'} contain “${esc(st.grep.text)}”`;
    list = st.grep.length ? st.grep.slice(0, st.shown).map(r => rowHTML(r.e, r.hits)).join('') : '<p class="hint pad">No matches inside files.</p>';
  } else if (filtering()) {
    const r = query({ q: st.q, kind: st.kind, minSize: st.size * 1048576, days: st.days, folder: st.cwd, sort: st.sort });
    count = `${fmtNum(r.length)} file${r.length === 1 ? '' : 's'} · ${fmtBytes(r.reduce((a, e) => a + e.size, 0))}${st.cwd ? ` in ${esc(st.cwd.split('/').pop())}` : ''}`;
    list = r.slice(0, st.shown).map(e => rowHTML(e)).join('') + (r.length > st.shown ? `<button class="btn more" data-fx="more">Show ${fmtNum(Math.min(200, r.length - st.shown))} more</button>` : '') || '<p class="hint pad">No files match these filters.</p>';
  } else {
    const { folders, files } = listFolder(st.cwd);
    const sorted = files.sort({ newest: (a, b) => b.modified - a.modified, oldest: (a, b) => a.modified - b.modified, largest: (a, b) => b.size - a.size, smallest: (a, b) => a.size - b.size }[st.sort] || (() => 0));
    count = st.cwd ? `${folders.length} folder${folders.length === 1 ? '' : 's'} · ${fmtNum(files.length)} file${files.length === 1 ? '' : 's'}` : `${roots.length} source${roots.length === 1 ? '' : 's'} · ${fmtNum(entries.length)} files`;
    list = folders.map(f => `<div class="frow folder" data-fx="cd" data-p="${esc(f.path)}"><span class="ficon">📁</span><div class="fmain"><b>${esc(f.name)}</b><small>${fmtNum(f.count)} file${f.count === 1 ? '' : 's'} · ${fmtBytes(f.size)}</small></div><span class="chev">›</span></div>`).join('')
      + sorted.slice(0, st.shown).map(e => rowHTML(e)).join('') + (sorted.length > st.shown ? `<button class="btn more" data-fx="more">Show more</button>` : '');
    if (!folders.length && !files.length) list = '<p class="hint pad">This folder is empty.</p>';
  }
  const selN = st.sel.size;
  const aiBanner = S.connectors?.enabled?.files ? '' : `<div class="fx-ai"><span>🤖 Let the AI explore these files when you ask in chat?</span><button class="btn sm primary" data-fx="enable-ai">Turn on</button></div>`;
  return `${aiBanner}<div class="fx-search"><input id="fx-q" type="search" value="${esc(st.q)}" placeholder="${st.deep ? 'Search inside files… (Enter)' : 'Filter by name, e.g. invoice  or  *.pdf'}" autocomplete="off" aria-label="Search files">
    <label class="check deep" title="Search the text inside documents, PDFs, Word, Excel and code"><input type="checkbox" id="fx-deep" ${st.deep ? 'checked' : ''}> Inside</label>
    ${st.deep ? '<button class="btn sm primary" data-fx="grep">🔎 Search</button>' : ''}</div>
  <div class="fx-chips">${chips}</div>
  <div class="fx-filters"><select id="fx-size" aria-label="Size">${opt(SIZES, st.size)}</select><select id="fx-days" aria-label="Modified">${opt(AGES, st.days)}</select><select id="fx-sort" aria-label="Sort">${opt(SORTS, st.sort)}</select>${filtering() ? '<button class="chip sm" data-fx="clear">✕ Clear</button>' : ''}</div>
  <div class="crumbs">${crumbs}</div>
  <div class="fx-count"><span>${count}</span>${selN ? `<button class="chip sm" data-fx="selnone">Clear selection</button>` : ''}</div>
  <div class="flist" id="fx-list">${list}</div>
  ${selN ? `<div class="fx-bar"><span>${selN} selected</span><button class="btn sm" data-fx="attach">📎 Attach</button><button class="btn sm primary" data-fx="ask">✨ Ask AI</button></div>` : ''}`;
}
function rowHTML(e, hits) {
  const isImg = e.kind === 'image' && !/^(heic|heif|raw|dng|cr2|nef|arw|tif|tiff)$/.test(e.ext);
  return `<div class="frow ${st.sel.has(e.id) ? 'sel' : ''}" data-fx="open" data-id="${e.id}">
    <label class="fsel" data-fx="noop"><input type="checkbox" data-fx-sel="${e.id}" ${st.sel.has(e.id) ? 'checked' : ''} aria-label="Select ${esc(e.name)}"></label>
    <span class="ficon">${isImg ? `<img data-thumb="${e.id}" alt="">` : iconOf(e)}</span>
    <div class="fmain"><b>${esc(e.name)}</b><small>${filtering() || hits ? esc(e.dir) + ' · ' : ''}${fmtBytes(e.size)} · ${fmtDate(e.modified)}</small>
    ${hits ? hits.map(h => `<div class="hit">…${esc(h.before)}<mark>${esc(h.match)}</mark>${esc(h.after)}…</div>`).join('') : ''}</div></div>`;
}
function scanHTML() {
  const r = st.report;
  if (!r) return `<div class="fx-empty"><p>Scan ${fmtNum(entries.length)} files for big files, duplicates, old files and a storage breakdown.</p><button class="btn primary" data-fx="scan">🔍 Run scan</button><p class="hint">Duplicates are confirmed by comparing file contents (SHA-256) on this device.</p></div>`;
  const max = Math.max(...Object.values(r.byKind).map(v => v.size), 1);
  const bars = Object.entries(r.byKind).filter(([, v]) => v.count).sort((a, b) => b[1].size - a[1].size).map(([k, v]) =>
    `<div class="kbar"><span>${KINDS[k][0]} ${KINDS[k][1]}</span><div class="bar"><i style="width:${(v.size / max * 100).toFixed(1)}%"></i></div><small>${fmtBytes(v.size)} · ${fmtNum(v.count)}</small></div>`).join('');
  const fileList = l => l.map(e => `<div class="frow" data-fx="open" data-id="${e.id}"><span class="ficon">${iconOf(e)}</span><div class="fmain"><b>${esc(e.name)}</b><small>${esc(e.dir)} · ${fmtDate(e.modified)}</small></div><span class="fsize">${fmtBytes(e.size)}</span></div>`).join('');
  return `<div class="flist scan">
    <div class="tiles"><div class="tile"><small>Files</small><b>${fmtNum(r.count)}</b><span>${roots.length} source${roots.length === 1 ? '' : 's'}</span></div><div class="tile"><small>Total size</small><b>${fmtBytes(r.total)}</b><span>&nbsp;</span></div>
    <div class="tile"><small>Duplicates</small><b>${fmtBytes(r.wasted)}</b><span>${r.dupes.length} group${r.dupes.length === 1 ? '' : 's'}${r.partial ? ' (partial)' : ''}</span></div><div class="tile"><small>Untouched 1y+</small><b>${fmtBytes(r.old.size)}</b><span>${fmtNum(r.old.count)} files</span></div></div>
    <h3>Storage by type</h3>${bars}
    <h3>Largest files</h3>${fileList(r.largest)}
    <h3>Duplicates</h3>${r.dupes.length ? r.dupes.slice(0, 30).map(g => `<div class="dupe"><div class="dupe-h">${fmtBytes(g.size)} × ${g.files.length} ${g.sure ? '<span class="badge ok">identical</span>' : '<span class="badge">same name & size</span>'}</div>${fileList(g.files)}</div>`).join('') : '<p class="hint">No duplicates found 🎉</p>'}
    ${r.empty.length ? `<h3>Empty files (${r.empty.length})</h3>${fileList(r.empty.slice(0, 20))}` : ''}
    <h3>Recently modified</h3>${fileList(r.recent)}
  </div>
  <div class="fx-bar"><button class="btn sm" data-fx="scan">↻ Rescan</button><button class="btn sm" data-fx="report-dl">⬇ Report</button><button class="btn sm primary" data-fx="report-ask">✨ Ask AI for cleanup tips</button></div>`;
}

/* ---------- Preview ---------- */
async function preview(e) {
  const f = await getFile(e).catch(() => null);
  if (!f) return toast('Could not open this file — try rescanning the folder');
  const url = URL.createObjectURL(f); thumbs.set('pv-' + e.id, url);
  let body = '';
  if (e.kind === 'image') body = `<img src="${url}" alt="${esc(e.name)}" onerror="this.replaceWith(Object.assign(document.createElement('p'),{className:'hint',textContent:'This image format can\\'t be shown in the browser.'}))">`;
  else if (e.kind === 'video') body = `<video src="${url}" controls playsinline></video>`;
  else if (e.kind === 'audio') body = `<audio src="${url}" controls></audio>`;
  else if (canExtract(e)) body = `<pre class="pv-text" id="fx-text">Reading…</pre>`;
  else body = `<p class="hint">No preview for .${esc(e.ext || 'unknown')} files.</p>`;
  const pv = document.createElement('div'); pv.className = 'fx-preview';
  pv.innerHTML = `<div class="dlg-title"><h2 title="${esc(e.name)}">${iconOf(e)} ${esc(e.name)}</h2><button class="icon sm" data-fx="pv-close" aria-label="Close preview">✕</button></div>
    <p class="hint">${esc(e.dir)}<br>${fmtBytes(e.size)} · modified ${new Date(e.modified).toLocaleString()}</p>
    <div class="pv-body">${body}</div>
    <div class="fx-bar"><a class="btn sm" href="${url}" download="${esc(e.name)}">⬇ Save copy</a>${e.ext === 'pdf' ? `<a class="btn sm" href="${url}" target="_blank" rel="noopener">↗ Open</a>` : ''}<button class="btn sm" data-fx="pv-attach" data-id="${e.id}">📎 Attach</button><button class="btn sm primary" data-fx="pv-ask" data-id="${e.id}">✨ Ask AI</button></div>`;
  $('.fx', dlg).append(pv);
  if (canExtract(e) && e.kind !== 'image') {
    try { const t = await extractText(e, 60000); const el = $('#fx-text', dlg); if (el) el.textContent = t.length >= 60000 ? t + '\n…' : t || '(empty)'; }
    catch (err) { const el = $('#fx-text', dlg); if (el) el.textContent = '⚠️ ' + err.message; }
  }
}

/* ---------- Thumbnails ---------- */
function observeThumbs() {
  thumbObs?.disconnect();
  thumbObs = new IntersectionObserver(items => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      const img = it.target; thumbObs.unobserve(img);
      const e = entries.find(x => x.id === img.dataset.thumb); if (!e) continue;
      if (thumbs.has(e.id)) { img.src = thumbs.get(e.id); continue; }
      getFile(e).then(f => { const u = URL.createObjectURL(f); thumbs.set(e.id, u); img.src = u; }).catch(() => {});
      img.onerror = () => img.replaceWith(document.createTextNode('🖼️'));
    }
  }, { root: $('#fx-list', dlg), rootMargin: '200px' });
  $$('img[data-thumb]', dlg).forEach(i => thumbObs.observe(i));
}
function cleanupThumbs() { for (const u of thumbs.values()) URL.revokeObjectURL(u); thumbs.clear(); thumbObs?.disconnect(); }

/* ---------- Events ---------- */
let qTimer;
function onInput(ev) {
  if (ev.target.id === 'fx-q') {
    st.q = ev.target.value; st.shown = 200;
    if (st.deep) return;
    clearTimeout(qTimer); qTimer = setTimeout(() => { st.grep = null; rerenderKeepFocus(); }, 180);
  }
}
function rerenderKeepFocus() {
  const el = $('#fx-q', dlg), pos = el?.selectionStart;
  const scroller = $('#fx-list', dlg)?.scrollTop;
  render();
  const n = $('#fx-q', dlg); if (n && el && document.activeElement !== n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(pos, pos); } catch {} }
  if (scroller != null && !filtering()) { const l = $('#fx-list', dlg); if (l) l.scrollTop = scroller; }
}
function onChange(ev) {
  const t = ev.target;
  if (t.id === 'fx-size') { st.size = +t.value; st.grep = null; render(); }
  else if (t.id === 'fx-days') { st.days = +t.value; st.grep = null; render(); }
  else if (t.id === 'fx-sort') { st.sort = t.value; render(); }
  else if (t.id === 'fx-deep') { st.deep = t.checked; st.grep = null; render(); $('#fx-q', dlg)?.focus(); }
  else if (t.dataset.fxSel) { t.checked ? st.sel.add(t.dataset.fxSel) : st.sel.delete(t.dataset.fxSel); rerenderKeepFocus(); }
}
async function onClick(ev) {
  if (ev.target === dlg) return dlg.close();
  const b = ev.target.closest('[data-fx]'); if (!b) return;
  const a = b.dataset.fx, id = b.dataset.id, root = roots.find(r => r.id === id);
  switch (a) {
    case 'noop': return;
    case 'close': return dlg.close();
    case 'view': st.view = b.dataset.v; return render();
    case 'add-folder': { const r = await addFolder(); if (r) { st.cwd = r.name; st.view = 'browse'; } return render(); }
    case 'add-files': { const r = await addPickedFiles(); if (r) { st.cwd = r.name; st.view = 'browse'; } return render(); }
    case 'reconnect': await reconnect(root); return render();
    case 'rescan': await scanRoot(root); return render();
    case 'remove': if (confirm(`Remove “${root.name}” from Broin? (Your files are not deleted.)`)) { await removeRoot(root); if (st.cwd.startsWith(root.name)) st.cwd = ''; st.sel.clear(); st.report = null; render(); } return;
    case 'cd': st.cwd = b.dataset.p; st.shown = 200; st.grep = null; render(); $('#fx-list', dlg)?.scrollTo(0, 0); return;
    case 'kind': st.kind = b.dataset.k; st.shown = 200; st.grep = null; return render();
    case 'clear': Object.assign(st, { q: '', kind: 'all', size: 0, days: 0, grep: null, shown: 200 }); return render();
    case 'more': st.shown += 200; return rerenderKeepFocus();
    case 'selnone': st.sel.clear(); return render();
    case 'grep': return runGrep();
    case 'cancel': st.busy?.ctl.abort(); return;
    case 'open': { const e = entries.find(x => x.id === id); if (e) preview(e); return; }
    case 'pv-close': b.closest('.fx-preview').remove(); return;
    case 'attach': case 'ask': {
      const list = entries.filter(e => st.sel.has(e.id));
      await sendToChat(list, a === 'ask'); return;
    }
    case 'pv-attach': case 'pv-ask': { const e = entries.find(x => x.id === id); if (e) await sendToChat([e], a === 'pv-ask'); return; }
    case 'scan': return runScan();
    case 'enable-ai': S.connectors.enabled.files = true; saveSettings(); dispatchEvent(new CustomEvent('nova:connectors')); toast('📁 My Files connector is on — ask the AI about your files'); return render();
    case 'report-dl': return download(reportText(st.report), 'nova-file-scan.txt', 'text/plain');
    case 'report-ask': dlg.close(); hooks.ask(reportText(st.report) + '\n\nBased on this scan, what can I safely clean up or organise? Give me a prioritised list.'); return;
  }
}
async function sendToChat(list, ask) {
  if (!list.length) return;
  const files = [], skipped = [];
  for (const e of list.slice(0, 20)) { try { const f = await getFile(e); if (f.size > 25 * 1024 * 1024) skipped.push(e.name); else files.push(new File([f], e.name, { type: f.type, lastModified: f.lastModified })); } catch { skipped.push(e.name); } }
  if (skipped.length) toast(`Skipped (over 25 MB or unreadable): ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}`, 5000);
  if (!files.length) return;
  await hooks.attach(files);
  st.sel.clear(); dlg.close();
  if (ask) hooks.ask(files.length === 1 ? `Tell me about this file (${files[0].name}): what's in it and anything important I should know?` : `Summarise these ${files.length} files and how they relate to each other.`, true);
  else toast(`📎 ${files.length} file${files.length === 1 ? '' : 's'} attached`);
}
async function runGrep() {
  const text = st.q.trim(); if (!text) return toast('Type the text to search for');
  const ctl = new AbortController();
  const list = query({ kind: st.kind, minSize: st.size * 1048576, days: st.days, folder: st.cwd });
  st.busy = { ctl, label: 'Searching inside files…' }; render();
  const res = await grep(text, list, { signal: ctl.signal, onProgress: (d, n) => { const el = $('.fx-busy span:nth-child(2)', dlg); if (el) el.textContent = `Searching inside files… ${d}/${n}`; } });
  res.text = text; st.grep = res; st.busy = null; st.shown = 200; render();
}
async function runScan() {
  const ctl = new AbortController();
  st.busy = { ctl, label: 'Scanning…' }; render();
  st.report = await scanReport({ signal: ctl.signal, onProgress: (d, n) => { const el = $('.fx-busy span:nth-child(2)', dlg); if (el) el.textContent = `Checking duplicates… ${d}/${n}`; } });
  st.busy = null; render();
}
