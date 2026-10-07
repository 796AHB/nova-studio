/* Connectors: tools the AI can call during a chat.
   Built-in connectors run in the browser; remote MCP servers are reached directly or through the Nova server relay. */
import { S, saveSettings, LS } from './store.js';
import { APP_VERSION } from './config.js';
import { $, $$, esc, uid, toast, openModal, closeModal, fmtNum, fmtBytes, fmtDate } from './util.js';
import * as F from './files.js';

let net = { relay: () => false, relayFetch: null, serverHas: () => false, proxyBase: () => '', proxyHeaders: () => ({}), openExplorer: () => {} };
export function initConnectors(n) { net = { ...net, ...n }; }

const cfg = id => (S.connectors.cfg[id] ||= {});
const MAX_RESULT = 12000;
const clip = (s, n = MAX_RESULT) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…(truncated, ${fmtNum(s.length - n)} more characters)` : s; };
async function getJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch {} throw new Error(`${r.status} ${r.statusText} ${m}`.trim()); }
  return r.json();
}
const obj = (props, required = []) => ({ type: 'object', properties: props, required });
const str = d => ({ type: 'string', description: d });
const num = d => ({ type: 'number', description: d });
const int = d => ({ type: 'integer', description: d });
const bool = d => ({ type: 'boolean', description: d });
const enm = (vals, d) => ({ type: 'string', enum: vals, description: d });

/* ---------- Built-in connectors ---------- */
export const BUILTIN = [
  {
    id: 'files', icon: '📁', name: 'My Files', desc: 'Let the AI explore folders you added: search names, filter by type/size/date, read documents (PDF, Word, Excel, text, code) and find duplicates.',
    status: () => F.hasFiles() ? `${fmtNum(F.entries.length)} files in ${F.roots.length} source${F.roots.length === 1 ? '' : 's'}` : 'No folders added yet',
    action: { label: '📂 Open My Files', run: () => net.openExplorer() },
    tools: [
      { name: 'files_overview', description: 'Overview of the user\'s local file library: sources, file counts and sizes by type. Call this first when the user asks about their files.', parameters: obj({}),
        label: () => 'overview', run: () => {
          if (!F.hasFiles()) return 'No local folders are connected. Ask the user to open “📁 My Files” and add a folder or files.';
          const by = {}; for (const e of F.entries) { const k = by[e.kind] ||= { n: 0, s: 0 }; k.n++; k.s += e.size; }
          return `Sources:\n${F.roots.map(r => `- ${r.name}/ (${fmtNum(r.count)} files, ${fmtBytes(r.size)}${r.status !== 'ready' ? ', ' + r.status : ''})`).join('\n')}\nBy type:\n${Object.entries(by).map(([k, v]) => `- ${k}: ${v.n} files, ${fmtBytes(v.s)}`).join('\n')}\nPaths look like "${F.roots[0]?.name}/sub/folder/file.ext".`;
        } },
      { name: 'files_search', description: 'Find local files by name and filters. Returns matching paths with size and modified date.',
        parameters: obj({ query: str('Words or wildcard pattern matched against the file path, e.g. "invoice 2024" or "*.pdf". Optional.'), kind: enm(['all', 'image', 'video', 'audio', 'document', 'code', 'archive', 'other'], 'File type filter'),
          extensions: str('Comma-separated extensions, e.g. "pdf,docx"'), min_size_mb: num('Minimum size in MB'), max_size_mb: num('Maximum size in MB'), modified_within_days: int('Only files modified in the last N days'),
          folder: str('Limit to this folder path'), sort: enm(['name', 'newest', 'oldest', 'largest', 'smallest'], 'Sort order'), limit: int('Max results (default 50, max 300)') }),
        label: a => [a.query && `“${a.query}”`, a.kind && a.kind !== 'all' && a.kind, a.extensions, a.folder && `in ${a.folder}`].filter(Boolean).join(' ') || 'all files',
        run: a => {
          if (!F.hasFiles()) return 'No local folders are connected yet.';
          const all = F.query({ q: a.query, kind: a.kind || 'all', ext: a.extensions, minSize: (a.min_size_mb || 0) * 1048576, maxSize: (a.max_size_mb || 0) * 1048576, days: a.modified_within_days, folder: a.folder, sort: a.sort || 'name' });
          const lim = Math.min(+a.limit || 50, 300), r = all.slice(0, lim);
          return `${all.length} match${all.length === 1 ? '' : 'es'} (${fmtBytes(all.reduce((x, e) => x + e.size, 0))} total)${all.length > lim ? `, showing ${lim}` : ''}:\n` + r.map(e => `${e.path} | ${fmtBytes(e.size)} | ${fmtDate(e.modified)}`).join('\n');
        } },
      { name: 'files_list_folder', description: 'List subfolders and files inside a folder of the local library. Use an empty path for the top level.',
        parameters: obj({ path: str('Folder path, e.g. "Downloads/receipts". Empty for top level.') }),
        label: a => a.path || '/', run: a => {
          const { folders, files } = F.listFolder(a.path || '');
          if (!folders.length && !files.length) return `Folder "${a.path}" is empty or does not exist.`;
          return [...folders.map(f => `[folder] ${f.path}/ (${fmtNum(f.count)} files, ${fmtBytes(f.size)})`), ...files.slice(0, 300).map(e => `${e.path} | ${fmtBytes(e.size)} | ${fmtDate(e.modified)}`)].join('\n') + (files.length > 300 ? `\n…and ${files.length - 300} more files` : '');
        } },
      { name: 'files_read', description: 'Read the text content of a local file (text, code, CSV, Markdown, PDF, Word .docx, Excel .xlsx). Use offset to page through long files.',
        parameters: obj({ path: str('Exact file path from search results'), offset: int('Character offset to start from (default 0)'), max_chars: int('Max characters to return (default 12000, max 40000)') }, ['path']),
        label: a => a.path, run: async a => {
          const e = F.findEntry(a.path); if (!e) return `File not found: ${a.path}. Use files_search to find the exact path.`;
          if (!F.canExtract(e)) return `${e.path} is a ${e.kind} file (.${e.ext}, ${fmtBytes(e.size)}). Its content can't be read as text — ask the user to attach it to the chat if it's an image or audio.`;
          const off = Math.max(0, +a.offset || 0), n = Math.min(+a.max_chars || 12000, 40000);
          const t = await F.extractText(e, off + n + 1);
          return `${e.path} (${fmtBytes(e.size)}, modified ${fmtDate(e.modified)})\n---\n${t.slice(off, off + n)}${t.length > off + n ? `\n…(more text — call again with offset ${off + n})` : ''}`;
        } },
      { name: 'files_search_content', description: 'Search for text INSIDE local documents and code files (full-text search). Returns files with matching snippets.',
        parameters: obj({ text: str('Text to find (case-insensitive)'), kind: enm(['all', 'document', 'code'], 'Limit to a type'), folder: str('Limit to this folder path'), limit: int('Max files to return (default 20)') }, ['text']),
        label: a => `“${a.text}”${a.folder ? ' in ' + a.folder : ''}`, run: async (a, ctx) => {
          if (!F.hasFiles()) return 'No local folders are connected yet.';
          const list = F.query({ kind: a.kind || 'all', folder: a.folder });
          const r = await F.grep(a.text, list, { signal: ctx.signal, maxResults: Math.min(+a.limit || 20, 100), onProgress: (d, n) => ctx.progress(`${d}/${n} files`) });
          return r.length ? r.map(x => `${x.e.path}:\n${x.hits.map(h => `  …${h.before}[${h.match}]${h.after}…`).join('\n')}`).join('\n') : `No files contain "${a.text}".`;
        } },
      { name: 'files_scan_report', description: 'Analyse the local library: storage by type, largest files, duplicate files (content-verified), old and empty files. Good for cleanup advice.',
        parameters: obj({}), label: () => 'scan', run: async (a, ctx) => F.hasFiles() ? F.reportText(await F.scanReport({ signal: ctx.signal, onProgress: (d, n) => ctx.progress(`hashing ${d}/${n}`) })) : 'No local folders are connected yet.' },
    ],
  },
  {
    id: 'web', icon: '🌐', name: 'Web reader', desc: 'Read any web page the AI or you point to and turn it into clean text.',
    status: () => net.relay() ? 'Using your Nova server' : cfg('web').jina ? 'Using Jina Reader (r.jina.ai)' : 'Needs the Nova server or Jina Reader (most sites block direct browser reads)',
    settings: [{ key: 'jina', type: 'check', label: 'Fallback: use Jina Reader (r.jina.ai) — the URL is sent to that service' }],
    tools: [{ name: 'web_read', description: 'Fetch a web page and return its readable text content.', parameters: obj({ url: str('Full http(s) URL') }, ['url']),
      label: a => a.url, run: async a => readWeb(a.url) }],
  },
  {
    id: 'search', icon: '🔎', name: 'Web search', desc: 'Search the live web with Tavily (free tier available).',
    status: () => net.serverHas('tavily') ? 'Using server key 🔒' : cfg('search').key ? 'API key set' : 'Add a Tavily API key (tavily.com) or set TAVILY_API_KEY on your Nova server',
    settings: [{ key: 'key', type: 'password', label: 'Tavily API key', placeholder: 'tvly-…' }],
    tools: [{ name: 'web_search', description: 'Search the web for current information. Returns an answer summary and top results with URLs.',
      parameters: obj({ query: str('Search query'), max_results: int('1-10, default 5'), topic: enm(['general', 'news'], 'Use news for recent events') }, ['query']),
      label: a => `“${a.query}”`, run: async a => {
        const body = { query: a.query, max_results: Math.min(+a.max_results || 5, 10), topic: a.topic || 'general', include_answer: true };
        const viaServer = net.serverHas('tavily');
        if (!viaServer && !cfg('search').key) throw new Error('Web search needs a Tavily API key (Connectors → Web search).');
        const url = viaServer ? net.proxyBase('tavily') + '/search' : 'https://api.tavily.com/search';
        const headers = { 'Content-Type': 'application/json', ...(viaServer ? net.proxyHeaders() : { Authorization: 'Bearer ' + cfg('search').key }) };
        const j = await getJSON(url, { method: 'POST', headers, body: JSON.stringify(body) });
        return clip(`${j.answer ? 'Answer: ' + j.answer + '\n\n' : ''}${(j.results || []).map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 700)}`).join('\n\n')}`);
      } }],
  },
  {
    id: 'wiki', icon: '📚', name: 'Wikipedia', desc: 'Search and read Wikipedia articles in any language. No key needed.',
    settings: [{ key: 'lang', type: 'text', label: 'Language code (en, ms, id, ar, zh…)', placeholder: 'en' }],
    tools: [
      { name: 'wikipedia_search', description: 'Search Wikipedia. Returns article titles and snippets.', parameters: obj({ query: str('Search terms'), lang: str('Wikipedia language code, default from settings') }, ['query']),
        label: a => `“${a.query}”`, run: async a => {
          const l = (a.lang || cfg('wiki').lang || 'en').replace(/[^a-z-]/gi, '');
          const j = await getJSON(`https://${l}.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=${encodeURIComponent(a.query)}`);
          const r = j.query?.search || [];
          return r.length ? r.map(x => `${x.title}: ${x.snippet.replace(/<[^>]+>/g, '')}`).join('\n') : 'No results.';
        } },
      { name: 'wikipedia_article', description: 'Read the plain-text content of a Wikipedia article by exact title.', parameters: obj({ title: str('Article title'), lang: str('Language code') }, ['title']),
        label: a => a.title, run: async a => {
          const l = (a.lang || cfg('wiki').lang || 'en').replace(/[^a-z-]/gi, '');
          const j = await getJSON(`https://${l}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(a.title)}`);
          const p = Object.values(j.query?.pages || {})[0];
          return p?.extract ? clip(`# ${p.title}\nhttps://${l}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}\n\n${p.extract}`) : `Article "${a.title}" not found.`;
        } },
    ],
  },
  {
    id: 'weather', icon: '🌦️', name: 'Weather', desc: 'Current weather and forecast for any place (Open-Meteo, no key).',
    tools: [{ name: 'weather_forecast', description: 'Get current conditions and a daily forecast for a city or place.', parameters: obj({ place: str('City or place name, e.g. "Kuala Lumpur"'), days: int('Forecast days 1-14, default 3') }, ['place']),
      label: a => a.place, run: async a => {
        const g = (await getJSON(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(a.place)}`)).results?.[0];
        if (!g) return `Place "${a.place}" not found.`;
        const d = Math.min(Math.max(+a.days || 3, 1), 14);
        const w = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&timezone=auto&forecast_days=${d}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum`);
        const c = w.current, u = w.current_units;
        return `${g.name}, ${g.admin1 ? g.admin1 + ', ' : ''}${g.country} (local time ${c.time})
Now: ${WMO[c.weather_code] || c.weather_code}, ${c.temperature_2m}${u.temperature_2m} (feels ${c.apparent_temperature}${u.temperature_2m}), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} ${u.wind_speed_10m}, precipitation ${c.precipitation} mm
Forecast:\n${w.daily.time.map((t, i) => `${t}: ${WMO[w.daily.weather_code[i]] || ''}, ${w.daily.temperature_2m_min[i]}–${w.daily.temperature_2m_max[i]}°C, rain ${w.daily.precipitation_probability_max[i] ?? '?'}% (${w.daily.precipitation_sum[i]} mm)`).join('\n')}`;
      } }],
  },
  {
    id: 'github', icon: '🐙', name: 'GitHub', desc: 'Search repositories and code, read files, list issues. Token optional (needed for private repos and higher limits).',
    settings: [{ key: 'token', type: 'password', label: 'Personal access token (optional)', placeholder: 'github_pat_…' }],
    tools: [
      { name: 'github_search_repos', description: 'Search GitHub repositories.', parameters: obj({ query: str('Search query, e.g. "pwa chat stars:>100"'), limit: int('Max results, default 8') }, ['query']),
        label: a => `“${a.query}”`, run: async a => {
          const j = await gh(`/search/repositories?per_page=${Math.min(+a.limit || 8, 30)}&q=${encodeURIComponent(a.query)}`);
          return (j.items || []).map(r => `${r.full_name} ★${r.stargazers_count} — ${r.description || ''}\n${r.html_url} (updated ${r.pushed_at?.slice(0, 10)})`).join('\n') || 'No repositories found.';
        } },
      { name: 'github_read_file', description: 'Read a file or list a directory in a GitHub repository.', parameters: obj({ repo: str('owner/name'), path: str('File or folder path; empty for root'), ref: str('Branch, tag or commit (optional)') }, ['repo']),
        label: a => `${a.repo}/${a.path || ''}`, run: async a => {
          const j = await gh(`/repos/${a.repo}/contents/${(a.path || '').replace(/^\/+/, '')}${a.ref ? '?ref=' + encodeURIComponent(a.ref) : ''}`);
          if (Array.isArray(j)) return j.map(x => `${x.type === 'dir' ? '[dir] ' : ''}${x.path}${x.size ? ` (${fmtBytes(x.size)})` : ''}`).join('\n');
          if (j.encoding === 'base64') return clip(new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, '')), c => c.charCodeAt(0))));
          return `Cannot show this item (${j.type}).`;
        } },
      { name: 'github_list_issues', description: 'List issues or pull requests of a repository.', parameters: obj({ repo: str('owner/name'), state: enm(['open', 'closed', 'all'], 'default open'), limit: int('default 10') }, ['repo']),
        label: a => a.repo, run: async a => {
          const j = await gh(`/repos/${a.repo}/issues?state=${a.state || 'open'}&per_page=${Math.min(+a.limit || 10, 50)}`);
          return j.map(i => `#${i.number} ${i.pull_request ? '[PR] ' : ''}${i.title} — ${i.user?.login}, ${i.comments} comments, ${i.state} (${i.html_url})`).join('\n') || 'No issues.';
        } },
    ],
  },
  {
    id: 'notes', icon: '📝', name: 'Notes & memory', desc: 'A private notebook on this device. The AI can save facts you want remembered and look them up later.',
    status: () => `${notes().length} notes saved`,
    action: { label: '🗑 Clear all notes', run: () => { if (confirm('Delete all saved notes?')) { setNotes([]); toast('Notes cleared'); openConnectors(); } } },
    tools: [
      { name: 'notes_save', description: 'Save a note to the user\'s private notebook (only when the user asks you to remember/save something).', parameters: obj({ title: str('Short title'), content: str('Note text') }, ['title', 'content']),
        label: a => a.title, run: a => { const l = notes(); const n = { id: uid(), title: a.title, content: a.content, ts: Date.now() }; l.push(n); setNotes(l); return `Saved note "${a.title}" (id ${n.id}).`; } },
      { name: 'notes_search', description: 'Search the user\'s saved notes. Empty query lists recent notes.', parameters: obj({ query: str('Words to look for (optional)') }),
        label: a => a.query ? `“${a.query}”` : 'recent', run: a => {
          const q = (a.query || '').toLowerCase().split(/\s+/).filter(Boolean);
          const r = notes().filter(n => q.every(t => (n.title + ' ' + n.content).toLowerCase().includes(t))).slice(-30).reverse();
          return r.length ? r.map(n => `[${n.id}] ${n.title} (${fmtDate(n.ts)}): ${n.content}`).join('\n') : 'No matching notes.';
        } },
      { name: 'notes_delete', description: 'Delete a note by id.', parameters: obj({ id: str('Note id') }, ['id']), confirm: true,
        label: a => a.id, run: a => { const l = notes(), n = l.filter(x => x.id !== a.id); setNotes(n); return l.length === n.length ? 'Note not found.' : 'Deleted.'; } },
    ],
  },
  {
    id: 'utils', icon: '🧮', name: 'Calculator & clock', desc: 'Exact maths and the current date/time in any time zone.',
    tools: [
      { name: 'calculate', description: 'Evaluate a math expression exactly. Supports + - * / ^ %, parentheses, sqrt, abs, round, floor, ceil, min, max, log (base 10), ln, exp, sin, cos, tan (radians), pi, e.', parameters: obj({ expression: str('e.g. "(1250*0.06)/12 + sqrt(2)"') }, ['expression']),
        label: a => a.expression, run: a => { const v = calc(a.expression); return `${a.expression} = ${Number.isInteger(v) ? v : +v.toPrecision(15)}`; } },
      { name: 'current_datetime', description: 'Get the current date and time.', parameters: obj({ timezone: str('IANA time zone, e.g. "Asia/Kuala_Lumpur" (default: device time zone)') }),
        label: a => a.timezone || 'local', run: a => {
          const tz = a.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
          return `${new Date().toLocaleString('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' })} (${tz}); ISO ${new Date().toISOString()}`;
        } },
    ],
  },
];
const WMO = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail' };
const notes = () => LS.get('nova.notes', []);
const setNotes = l => { LS.set('nova.notes', l); dispatchEvent(new CustomEvent('nova:notes')); };
async function gh(path) {
  const h = { Accept: 'application/vnd.github+json' }; if (cfg('github').token) h.Authorization = 'Bearer ' + cfg('github').token;
  return getJSON('https://api.github.com' + path, { headers: h });
}

/* ---------- Web reader ---------- */
export async function readWeb(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  let html, ct = '';
  if (net.relay()) {
    const r = await net.relayFetch(url, { method: 'GET', headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${(await r.text()).slice(0, 200)}`);
    ct = r.headers.get('content-type') || ''; html = await r.text();
  } else if (cfg('web').jina) {
    const r = await fetch('https://r.jina.ai/' + url, { headers: { Accept: 'text/plain' } });
    if (!r.ok) throw new Error(`Jina Reader: ${r.status}`);
    return clip(await r.text());
  } else {
    try { const r = await fetch(url); ct = r.headers.get('content-type') || ''; html = await r.text(); }
    catch { throw new Error('This site blocks direct browser reads. Turn on the Nova server, or enable Jina Reader in Connectors → Web reader.'); }
  }
  if (!/html|xml/.test(ct) && !/^\s*</.test(html)) return clip(`${url}\n\n${html}`);
  const doc = new DOMParser().parseFromString(html.replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>|<br\s*\/?>/gi, '$&\n'), 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,form,aside,header [role=navigation],[aria-hidden=true]').forEach(n => n.remove());
  const main = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  const text = (main?.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
  const links = [...(main?.querySelectorAll('a[href^="http"]') || [])].slice(0, 15).map(a => `- ${a.textContent.trim().slice(0, 60)}: ${a.getAttribute('href')}`).filter(l => l.length > 6).join('\n');
  return clip(`# ${doc.title || url}\n${url}\n\n${text}${links ? '\n\nLinks:\n' + links : ''}`);
}

/* ---------- Safe calculator ---------- */
export function calc(src) {
  const s = String(src).replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '');
  let i = 0;
  const F1 = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, log: Math.log10, ln: Math.log, exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan };
  const FN = { min: Math.min, max: Math.max, pow: Math.pow };
  const C = { pi: Math.PI, e: Math.E };
  const peek = () => s[i], eat = c => s[i] === c && ++i;
  function expr() { let v = term(); for (;;) { if (eat('+')) v += term(); else if (eat('-')) v -= term(); else return v; } }
  function term() { let v = power(); for (;;) { if (eat('*')) v *= power(); else if (eat('/')) v /= power(); else if (eat('%')) v %= power(); else return v; } }
  function power() { const b = unary(); if (eat('^') || (s[i] === '*' && s[i + 1] === '*' && (i += 2))) return b ** power(); return b; }
  function unary() { if (eat('-')) return -unary(); if (eat('+')) return unary(); return atom(); }
  function atom() {
    if (eat('(')) { const v = expr(); if (!eat(')')) throw new Error('Missing )'); return v; }
    const m = /^(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)/i.exec(s.slice(i)); if (m) { i += m[0].length; return parseFloat(m[0]); }
    const w = /^[a-z]+/i.exec(s.slice(i)); if (w) {
      const n = w[0].toLowerCase(); i += w[0].length;
      if (n in C && peek() !== '(') return C[n];
      if (!eat('(')) throw new Error('Unknown name ' + n);
      const args = [expr()]; while (eat(',')) args.push(expr());
      if (!eat(')')) throw new Error('Missing )');
      if (F1[n]) return F1[n](args[0]); if (FN[n]) return FN[n](...args);
      throw new Error('Unknown function ' + n);
    }
    throw new Error(`Unexpected "${s[i] ?? 'end'}"`);
  }
  const v = expr(); if (i < s.length) throw new Error(`Unexpected "${s[i]}"`);
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

/* ---------- MCP (Model Context Protocol) client: Streamable HTTP ---------- */
const sessions = new Map(); // server id -> { sid, proto }
let rpcId = 0;
async function mcpFetch(srv, init) {
  const headers = { ...init.headers };
  if (srv.auth) headers.authorization = /^(bearer|basic|token) /i.test(srv.auth) ? srv.auth : 'Bearer ' + srv.auth;
  if (srv.relay) {
    if (!net.relay()) throw new Error('“Route through Nova server” is on, but the Nova server is not connected (Settings → Keys).');
    return net.relayFetch(srv.url, { ...init, headers });
  }
  try { return await fetch(srv.url, { ...init, headers }); }
  catch (e) { throw new Error(`Can't reach ${srv.url} (${e.message}). If it blocks browser requests (CORS), turn on “Route through Nova server”.`); }
}
async function mcpRpc(srv, method, params, notify = false) {
  const s = sessions.get(srv.id) || {};
  const id = ++rpcId, body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (s.sid) headers['mcp-session-id'] = s.sid;
  if (s.proto) headers['mcp-protocol-version'] = s.proto;
  const r = await mcpFetch(srv, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id'); if (sid) sessions.set(srv.id, { ...s, sid });
  if (r.status === 404 && s.sid && method !== 'initialize') { sessions.delete(srv.id); await mcpInit(srv); return mcpRpc(srv, method, params, notify); }
  if (notify) return null;
  if (!r.ok) throw new Error(`MCP ${method}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const ct = r.headers.get('content-type') || '';
  let msg;
  if (ct.includes('text/event-stream')) {
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '', data = '';
    outer: while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).replace(/\r$/, ''); buf = buf.slice(k + 1);
        if (line.startsWith('data:')) data += line.slice(5).trim();
        else if (line === '' && data) { try { const m = JSON.parse(data); if (m.id === id) { msg = m; break outer; } } catch {} data = ''; }
      }
    }
    if (!msg && data) try { msg = JSON.parse(data); } catch {}
    reader.cancel().catch(() => {});
  } else {
    const j = await r.json(); msg = Array.isArray(j) ? j.find(m => m.id === id) : j;
  }
  if (!msg) throw new Error(`MCP ${method}: no response`);
  if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
  return msg.result;
}
async function mcpInit(srv) {
  const r = await mcpRpc(srv, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Nova Studio', version: APP_VERSION } });
  sessions.set(srv.id, { ...(sessions.get(srv.id) || {}), proto: r.protocolVersion || '2025-06-18' });
  await mcpRpc(srv, 'notifications/initialized', null, true).catch(() => {});
  return r;
}
export async function mcpConnect(srv) {
  sessions.delete(srv.id);
  const info = await mcpInit(srv);
  const tools = []; let cursor;
  do { const r = await mcpRpc(srv, 'tools/list', cursor ? { cursor } : {}); tools.push(...(r.tools || [])); cursor = r.nextCursor; } while (cursor && tools.length < 500);
  srv.tools = tools.map(t => ({ name: t.name, description: (t.description || '').slice(0, 1000), inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
  srv.serverName = info.serverInfo?.name || ''; srv.error = ''; srv.checked = Date.now();
  saveSettings();
  return srv.tools;
}
async function mcpCall(srv, name, args) {
  if (!sessions.has(srv.id)) await mcpInit(srv);
  const r = await mcpRpc(srv, 'tools/call', { name, arguments: args || {} });
  const parts = (r.content || []).map(c => c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text || `[resource ${c.resource?.uri}]`) : c.type === 'resource_link' ? `[link ${c.uri}]` : `[${c.type}${c.mimeType ? ' ' + c.mimeType : ''}]`);
  if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent));
  const text = parts.join('\n') || '(no output)';
  if (r.isError) throw new Error(text);
  return text;
}

/* ---------- Active tool list for a chat request ---------- */
const safeName = s => s.replace(/[^a-zA-Z0-9_-]/g, '_');
export function enabledCount() {
  return BUILTIN.filter(c => S.connectors.enabled[c.id]).length + S.connectors.mcp.filter(m => m.enabled && m.tools?.length).length;
}
export function activeTools() {
  const out = [];
  for (const c of BUILTIN) if (S.connectors.enabled[c.id]) for (const t of c.tools) out.push({ ...t, connector: c.name, icon: c.icon });
  for (const m of S.connectors.mcp) if (m.enabled) for (const t of m.tools || []) {
    if (m.disabledTools?.includes(t.name)) continue;
    const name = safeName(`${m.prefix}_${t.name}`).slice(0, 64);
    out.push({ name, description: t.description || t.name, parameters: t.inputSchema, connector: m.name, icon: '🔌', confirm: m.confirm !== false,
      label: a => Object.values(a || {}).filter(v => typeof v !== 'object').join(' ').slice(0, 80), run: a => mcpCall(m, t.name, a) });
  }
  return out;
}
export function toolsSystemNote(tools) {
  if (!tools.length) return '';
  const names = [...new Set(tools.map(t => `${t.icon} ${t.connector}`))].join(', ');
  return `## Connectors\nYou can call tools from these connectors: ${names}. Use them when they help answer accurately; you may call several in a row. Cite web sources with their URLs.${S.connectors.enabled.files ? ' The user\'s local files are available through the files_* tools (paths start with the source folder name) — use them when the user asks about their files, documents, photos or storage.' : ''}`;
}
/** Run a tool call. Returns { text, error }. */
export async function runTool(tool, args, ctx) {
  try {
    const r = await tool.run(args || {}, ctx);
    return { text: clip(typeof r === 'string' ? r : JSON.stringify(r, null, 1)) };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { text: 'Error: ' + (e.message || String(e)), error: true };
  }
}

/* ---------- Connectors screen ---------- */
export function openConnectors() {
  const card = c => {
    const on = !!S.connectors.enabled[c.id], st = c.status?.() || '';
    return `<div class="conn ${on ? 'on' : ''}">
      <div class="conn-h"><span class="conn-ico">${c.icon}</span><div class="conn-t"><b>${esc(c.name)}</b><small>${esc(c.desc)}</small></div>
      <label class="switch" title="On/off"><input type="checkbox" data-conn="${c.id}" ${on ? 'checked' : ''} aria-label="Enable ${esc(c.name)}"><span></span></label></div>
      ${st ? `<div class="conn-st">${esc(st)}</div>` : ''}
      ${(c.settings || []).map(f => f.type === 'check'
        ? `<label class="check"><input type="checkbox" data-cfg="${c.id}.${f.key}" ${cfg(c.id)[f.key] ? 'checked' : ''}> ${esc(f.label)}</label>`
        : `<label>${esc(f.label)}<input type="${f.type}" data-cfg="${c.id}.${f.key}" value="${esc(cfg(c.id)[f.key] || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false"></label>`).join('')}
      <details class="conn-tools"><summary>${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}</summary>${c.tools.map(t => `<div><code>${t.name}</code> — ${esc(t.description)}</div>`).join('')}</details>
      ${c.action ? `<button class="btn sm" data-conn-act="${c.id}">${c.action.label}</button>` : ''}
    </div>`;
  };
  const mcpCard = m => `<div class="conn ${m.enabled ? 'on' : ''}">
    <div class="conn-h"><span class="conn-ico">🔌</span><div class="conn-t"><b>${esc(m.name)}</b><small>${esc(m.url)}${m.relay ? ' · via Nova server' : ''}</small></div>
    <label class="switch"><input type="checkbox" data-mcp-on="${m.id}" ${m.enabled ? 'checked' : ''} aria-label="Enable ${esc(m.name)}"><span></span></label></div>
    <div class="conn-st">${m.error ? '⚠️ ' + esc(m.error) : m.tools ? `✓ ${m.tools.length} tools${m.serverName ? ' · ' + esc(m.serverName) : ''}${m.confirm !== false ? ' · asks before running' : ''}` : 'Not connected yet'}</div>
    ${m.tools?.length ? `<details class="conn-tools"><summary>Tools</summary>${m.tools.map(t => `<label class="check"><input type="checkbox" data-mcp-tool="${m.id}" value="${esc(t.name)}" ${m.disabledTools?.includes(t.name) ? '' : 'checked'}> <code>${esc(t.name)}</code> <small class="hint">${esc(t.description.slice(0, 120))}</small></label>`).join('')}</details>` : ''}
    <div class="inrow wrap"><button class="btn sm" data-mcp-refresh="${m.id}">↻ Connect / refresh</button><button class="btn sm" data-mcp-edit="${m.id}">✏️ Edit</button><button class="btn sm danger" data-mcp-del="${m.id}">Remove</button></div></div>`;
  openModal(`<div class="dlg-title"><h2>🔌 Connectors</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <p class="hint">Turn on connectors to let the AI use tools while chatting. Each enabled connector adds a little to every message's token cost. Works with OpenAI, Claude, Gemini and most OpenAI-compatible models that support tool calling.</p>
    <h3>Built-in</h3><div class="conns">${BUILTIN.map(card).join('')}</div>
    <h3>MCP servers</h3>
    <p class="hint">Connect any remote MCP server (Streamable HTTP), e.g. your company tools, Zapier, a database or calendar server.</p>
    <div class="conns">${S.connectors.mcp.map(mcpCard).join('') || ''}</div>
    <button class="btn" id="mcp-add">＋ Add MCP server</button>
    <label style="margin-top:16px">Max tool steps per reply<input id="cn-steps" type="number" min="1" max="30" value="${+S.maxToolSteps || 8}"></label>
    <div class="dlg-actions"><button class="btn primary" id="cn-done">Done</button></div>`, 'wide');
  const body = $('#modalBody');
  body.onchange = e => {
    const t = e.target;
    if (t.dataset.conn) { S.connectors.enabled[t.dataset.conn] = t.checked; t.closest('.conn').classList.toggle('on', t.checked); }
    else if (t.dataset.cfg) { const [c, k] = t.dataset.cfg.split('.'); cfg(c)[k] = t.type === 'checkbox' ? t.checked : t.value.trim(); }
    else if (t.dataset.mcpOn) { const m = S.connectors.mcp.find(x => x.id === t.dataset.mcpOn); m.enabled = t.checked; if (t.checked && !m.tools) refresh(m); }
    else if (t.dataset.mcpTool) { const m = S.connectors.mcp.find(x => x.id === t.dataset.mcpTool); const set = new Set(m.disabledTools || []); t.checked ? set.delete(t.value) : set.add(t.value); m.disabledTools = [...set]; }
    else if (t.id === 'cn-steps') S.maxToolSteps = Math.min(Math.max(+t.value || 8, 1), 30);
    saveSettings(); dispatchEvent(new CustomEvent('nova:connectors'));
  };
  body.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.connAct) { const c = BUILTIN.find(x => x.id === b.dataset.connAct); closeModal(); c.action.run(); }
    else if (b.dataset.mcpRefresh) refresh(S.connectors.mcp.find(x => x.id === b.dataset.mcpRefresh), b);
    else if (b.dataset.mcpEdit) editMcp(S.connectors.mcp.find(x => x.id === b.dataset.mcpEdit));
    else if (b.dataset.mcpDel) { if (confirm('Remove this MCP server?')) { S.connectors.mcp = S.connectors.mcp.filter(x => x.id !== b.dataset.mcpDel); saveSettings(); openConnectors(); dispatchEvent(new CustomEvent('nova:connectors')); } }
    else if (b.id === 'mcp-add') editMcp(null);
    else if (b.id === 'cn-done') { saveSettings(); closeModal(); dispatchEvent(new CustomEvent('nova:connectors')); }
  };
  async function refresh(m, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    try { const t = await mcpConnect(m); toast(`✓ ${m.name}: ${t.length} tools`); }
    catch (err) { m.error = err.message; saveSettings(); toast(err.message, 6000); }
    if ($('#modal').open && $('#mcp-add')) openConnectors();
  }
}
function editMcp(m) {
  const isNew = !m; m = m || { id: uid(), name: '', url: '', auth: '', relay: net.relay(), confirm: true, enabled: true };
  openModal(`<div class="dlg-title"><h2>${isNew ? 'Add' : 'Edit'} MCP server</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <label>Name<input id="mc-name" value="${esc(m.name)}" placeholder="e.g. Company CRM"></label>
    <label>Server URL (Streamable HTTP endpoint)<input id="mc-url" value="${esc(m.url)}" placeholder="https://example.com/mcp" spellcheck="false"></label>
    <label>Authorization (optional)<input id="mc-auth" type="password" value="${esc(m.auth || '')}" placeholder="Bearer token or API key" autocomplete="off"></label>
    <label class="check" style="margin-top:12px"><input type="checkbox" id="mc-relay" ${m.relay ? 'checked' : ''}> Route through my Nova server (fixes CORS; recommended)</label>
    <label class="check" style="margin-top:8px"><input type="checkbox" id="mc-confirm" ${m.confirm !== false ? 'checked' : ''}> Ask me before each tool runs</label>
    <p class="hint">Only connect servers you trust — their tools can read or change data in the services they connect to.</p>
    <div class="dlg-actions"><button class="btn" id="mc-back">Back</button><button class="btn primary" id="mc-save">${isNew ? 'Add & connect' : 'Save & reconnect'}</button></div>`);
  $('#mc-back').onclick = openConnectors;
  $('#mc-save').onclick = async () => {
    const url = $('#mc-url').value.trim();
    if (!/^https?:\/\//.test(url)) return toast('Enter a valid http(s) URL');
    Object.assign(m, { name: $('#mc-name').value.trim() || new URL(url).hostname, url, auth: $('#mc-auth').value.trim(), relay: $('#mc-relay').checked, confirm: $('#mc-confirm').checked });
    m.prefix = safeName(m.name.toLowerCase()).replace(/_+/g, '_').slice(0, 20) || 'mcp';
    if (isNew) S.connectors.mcp.push(m);
    saveSettings();
    const b = $('#mc-save'); b.disabled = true; b.textContent = 'Connecting…';
    try { const t = await mcpConnect(m); m.enabled = true; toast(`✓ Connected: ${t.length} tools`); }
    catch (err) { m.error = err.message; saveSettings(); toast(err.message, 6000); }
    dispatchEvent(new CustomEvent('nova:connectors'));
    openConnectors();
  };
}
