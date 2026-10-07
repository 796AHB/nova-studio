/* Keeps model lists and prices fresh.
   • Model lists: weekly, from each provider you have a key for.
   • Prices: from OpenRouter's public model catalogue (prices per token for most major models). */
import { PROVIDERS } from './config.js';
import { S, saveSettings } from './store.js';
import { toast } from './util.js';
import { log } from './logs.js';

const WEEK = 7 * 864e5;
export async function autoUpdate({ listModels, hasKey, usedModels }) {
  const now = Date.now();
  if (S.autoUpdate.models && now - (S.autoUpdate.lastModels || 0) > WEEK) {
    let n = 0;
    for (const pid of Object.keys(PROVIDERS)) {
      if (['custom', 'ollama', 'elevenlabs'].includes(pid) || !hasKey(pid)) continue;
      try { const l = await listModels(pid); if (l.length) { S.fetched[pid] = l; n++; } } catch (e) { log('warn', `Model list update failed for ${pid}: ${e.message}`); }
    }
    S.autoUpdate.lastModels = now; saveSettings();
    if (n) log('info', `Model lists refreshed for ${n} providers`);
  }
  if (S.autoUpdate.prices && now - (S.autoUpdate.lastPrices || 0) > WEEK) {
    try { const r = await updatePrices(usedModels()); if (r.changed) toast(`💲 Prices updated for ${r.changed} models`); } catch (e) { log('warn', 'Price update failed: ' + e.message); }
  }
}

/** Update token prices from OpenRouter (and add entries for models you've used that have no price). */
export async function updatePrices(usedModels = []) {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error('OpenRouter catalogue unavailable (' + r.status + ')');
  const models = ((await r.json()).data || []).filter(m => +m.pricing?.prompt > 0 || +m.pricing?.completion > 0);
  const short = id => id.split('/').pop().replace(/:.*$/, '').toLowerCase();
  const find = match => {
    const m = match.toLowerCase();
    const exact = models.filter(x => short(x.id) === m);
    let pre = exact.length ? exact : models.filter(x => short(x.id).startsWith(m));
    if (!pre.length) pre = models.filter(x => short(x.id).length >= 4 && m.startsWith(short(x.id))).sort((a, b) => short(b.id).length - short(a.id).length).slice(0, 1);  // dated ids, e.g. magistral-small-2509
    return pre.sort((a, b) => short(a.id).length - short(b.id).length || (a.id.includes('~') ? 1 : 0) - (b.id.includes('~') ? 1 : 0))[0];
  };
  const per1M = v => Math.round(+v * 1e6 * 10000) / 10000;
  let changed = 0, added = 0;
  for (const p of S.prices) {
    if (p.unit && !(+p.in || +p.out)) continue;
    const m = find(p.match); if (!m) continue;
    const inp = per1M(m.pricing.prompt), out = per1M(m.pricing.completion);
    if (inp !== +p.in || out !== +p.out) { p.in = inp; p.out = out; changed++; }
  }
  for (const id of usedModels) {
    const s = short(id); if (!s || S.prices.some(p => s.startsWith(String(p.match).toLowerCase()))) continue;
    const m = find(s); if (!m) continue;
    S.prices.push({ match: s, in: per1M(m.pricing.prompt), out: per1M(m.pricing.completion) }); added++;
  }
  S.autoUpdate.lastPrices = Date.now(); saveSettings();
  dispatchEvent(new CustomEvent('nova:usage'));
  return { changed: changed + added, updated: changed, added };
}
