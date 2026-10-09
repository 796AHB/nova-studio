/* Persistence: settings (localStorage) and conversations + usage log (IndexedDB). */
import { PROVIDERS, DEFAULT_PRICES, DEFAULT_SKILLS } from './config.js';
import { toast } from './util.js';

export const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast('Browser storage is full or blocked'); } },
};

export const DEFAULTS = {
  keys: {}, bases: {}, fetched: {},
  chat: { provider: 'openai', model: 'gpt-5-mini' },
  image: { provider: 'openai', model: 'gpt-image-1', size: '1024x1024' },
  video: { provider: 'openai', model: 'sora-2', seconds: '8', size: '1280x720' },
  tts: { provider: 'browser', model: '', voice: '', auto: false },
  stt: { provider: 'browser', model: '', lang: '' },
  system: 'You are Broin, a brilliant, friendly and helpful AI assistant. Use Markdown formatting when useful.',
  temperature: '', maxTokens: 8192, reasoning: '', historyLimit: 0,
  theme: 'system', sendOnEnter: true, notify: true,
  proxy: { enabled: false, url: '', token: '' },
  budget: { daily: 0, monthly: 0 },
  prices: null,
  connectors: { enabled: {}, cfg: {}, mcp: [] },
  maxToolSteps: 8,
  files: { hidden: false, maxFiles: 50000 },
  vaultAutoLock: 0, lang: 'auto',
  embed: { provider: 'auto', model: '' },
  autoUpdate: { models: true, prices: false, lastModels: 0, lastPrices: 0 },
  sync: { enabled: false, last: 0 },
  account: { username: '', role: '', token: '' },
  pricesSeen: null,
};

function load() {
  const s = LS.get('nova.settings', {}), d = structuredClone(DEFAULTS);
  for (const k in d) {
    if (s[k] === undefined) continue;
    d[k] = (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) ? { ...d[k], ...s[k] } : s[k];
  }
  for (const m of ['chat', 'image', 'video']) if (!PROVIDERS[d[m].provider]) d[m] = structuredClone(DEFAULTS[m]);
  if (!Array.isArray(d.prices)) d.prices = structuredClone(DEFAULT_PRICES);
  // add price entries introduced in newer versions (but never re-add ones the user deleted)
  const seen = new Set(s.pricesSeen || d.prices.map(p => p.match));
  for (const dp of DEFAULT_PRICES) if (!seen.has(dp.match) && !d.prices.some(p => p.match === dp.match)) d.prices.push(structuredClone(dp));
  d.pricesSeen = DEFAULT_PRICES.map(p => p.match);
  return d;
}

/** Live settings object — mutate it, then call saveSettings(). */
export const S = load();
let saveFilter = null;
/** Optional transform applied before writing settings (used by the key vault to strip secrets). */
export const setSaveFilter = fn => { saveFilter = fn; };
export const saveSettings = () => { LS.set('nova.settings', saveFilter ? saveFilter(S) : S); dispatchEvent(new CustomEvent('nova:settings')); };
export function replaceSettings(obj) {
  const keys = { ...S.keys, ...(obj.keys || {}) };
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, structuredClone(DEFAULTS), obj, { keys });
  if (!Array.isArray(S.prices)) S.prices = structuredClone(DEFAULT_PRICES);
  saveSettings();
}

export const loadSkills = () => LS.get('nova.skills', structuredClone(DEFAULT_SKILLS));
export const saveSkillsLS = skills => { LS.set('nova.skills', skills); dispatchEvent(new CustomEvent('nova:skills')); };

/* ---------- IndexedDB ---------- */
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('nova-studio', 5);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('convos')) db.createObjectStore('convos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('usage')) db.createObjectStore('usage', { keyPath: 'id' }).createIndex('ts', 'ts');
      if (!db.objectStoreNames.contains('roots')) db.createObjectStore('roots', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kbs')) db.createObjectStore('kbs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'id' }).createIndex('kb', 'kbId');
      if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
    r.onblocked = () => toast('Close other AHB Broin tabs to finish the upgrade');
  });
  return dbp;
}
async function run(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
export const DB = {
  all: store => run(store, 'readonly', s => s.getAll()),
  put: (store, v) => run(store, 'readwrite', s => s.put(v)),
  putMany: (store, arr) => run(store, 'readwrite', s => { arr.forEach(v => s.put(v)); }),
  del: (store, id) => run(store, 'readwrite', s => s.delete(id)),
  clear: store => run(store, 'readwrite', s => s.clear()),
  get: (store, id) => run(store, 'readonly', s => s.get(id)),
  byIndex: (store, index, value) => run(store, 'readonly', s => s.index(index).getAll(value)),
  delByIndex: (store, index, value) => run(store, 'readwrite', s => { const r = s.index(index).openKeyCursor(IDBKeyRange.only(value)); r.onsuccess = () => { const c = r.result; if (c) { s.delete(c.primaryKey); c.continue(); } }; }),
};
