/* Upstream AI providers and their server-side keys (from .env). */
import { env } from './env.js';

const bearer = k => ({ authorization: `Bearer ${k}` });
export const UPSTREAMS = {
  openai:     { type: 'openai',    base: 'https://api.openai.com/v1',                        key: env.OPENAI_API_KEY,     auth: bearer },
  anthropic:  { type: 'anthropic', base: 'https://api.anthropic.com/v1',                     key: env.ANTHROPIC_API_KEY,  auth: k => ({ 'x-api-key': k }) },
  gemini:     { type: 'gemini',    base: 'https://generativelanguage.googleapis.com/v1beta', key: env.GEMINI_API_KEY,     auth: k => ({ 'x-goog-api-key': k }) },
  openrouter: { type: 'openai',    base: 'https://openrouter.ai/api/v1',                     key: env.OPENROUTER_API_KEY, auth: bearer },
  groq:       { type: 'openai',    base: 'https://api.groq.com/openai/v1',                   key: env.GROQ_API_KEY,       auth: bearer },
  deepseek:   { type: 'openai',    base: 'https://api.deepseek.com/v1',                      key: env.DEEPSEEK_API_KEY,   auth: bearer },
  xai:        { type: 'openai',    base: 'https://api.x.ai/v1',                              key: env.XAI_API_KEY,        auth: bearer },
  mistral:    { type: 'openai',    base: 'https://api.mistral.ai/v1',                        key: env.MISTRAL_API_KEY,    auth: bearer },
  together:   { type: 'openai',    base: 'https://api.together.xyz/v1',                      key: env.TOGETHER_API_KEY,   auth: bearer },
  elevenlabs: { type: 'other',     base: 'https://api.elevenlabs.io/v1',                     key: env.ELEVENLABS_API_KEY, auth: k => ({ 'xi-api-key': k }) },
  tavily:     { type: 'other',     base: 'https://api.tavily.com',                           key: env.TAVILY_API_KEY,     auth: bearer },
};
// Optional base-URL overrides, e.g. OPENAI_BASE_URL=https://my-gateway.example.com/v1
for (const [pid, up] of Object.entries(UPSTREAMS)) { const o = env[`${pid.toUpperCase()}_BASE_URL`]; if (o) up.base = o.replace(/\/+$/, ''); }
export const configured = Object.keys(UPSTREAMS).filter(p => UPSTREAMS[p].key);
export const chatProviders = () => configured.filter(p => ['openai', 'anthropic', 'gemini'].includes(UPSTREAMS[p].type));

async function call(url, opts, timeoutMs = 180_000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) throw new Error(`${r.status} ${(j?.error?.message || j?.message || t).toString().slice(0, 300)}`);
  return j;
}
/** Non-streaming chat completion using the server's own key. → { text, usage: { in, out } } */
export async function complete({ provider, model, system, prompt }) {
  const up = UPSTREAMS[provider];
  if (!up?.key) throw new Error(`The server has no key for ${provider}`);
  const h = { 'content-type': 'application/json', ...up.auth(up.key) };
  if (up.type === 'anthropic') {
    const j = await call(`${up.base}/messages`, { method: 'POST', headers: { ...h, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content: prompt }] }) });
    return { text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), usage: { in: j.usage?.input_tokens || 0, out: j.usage?.output_tokens || 0 } };
  }
  if (up.type === 'gemini') {
    const j = await call(`${up.base}/models/${model}:generateContent`, { method: 'POST', headers: h, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] }) });
    const u = j.usageMetadata || {};
    return { text: (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''), usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
  }
  const j = await call(`${up.base}/chat/completions`, { method: 'POST', headers: h, body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }) });
  return { text: j.choices?.[0]?.message?.content || '', usage: { in: j.usage?.prompt_tokens || 0, out: j.usage?.completion_tokens || 0 } };
}
/** Web search with the server's Tavily key. */
export async function webSearch(query, topic = 'general') {
  const up = UPSTREAMS.tavily; if (!up.key) return null;
  const j = await call(`${up.base}/search`, { method: 'POST', headers: { 'content-type': 'application/json', ...up.auth(up.key) }, body: JSON.stringify({ query: query.slice(0, 380), max_results: 6, include_answer: true, topic }) }, 60_000);
  return j;
}
