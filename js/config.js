/* Nova Studio — static configuration: providers, voices, skills, prices, context windows.
   Model lists are suggestions only: any model id can be typed in the app. */

export const APP_VERSION = '3.2.0';

export const PROVIDERS = {
  openai: { name: 'OpenAI', type: 'openai', base: 'https://api.openai.com/v1', link: 'https://platform.openai.com/api-keys', usageOpt: true, env: 'OPENAI_API_KEY',
    models: { chat: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4o', 'o4-mini'], image: ['gpt-image-1', 'dall-e-3'],
      video: ['sora-2', 'sora-2-pro'], tts: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], stt: ['gpt-4o-mini-transcribe', 'whisper-1'] } },
  anthropic: { name: 'Anthropic Claude', type: 'anthropic', base: 'https://api.anthropic.com/v1', link: 'https://console.anthropic.com/settings/keys', env: 'ANTHROPIC_API_KEY',
    models: { chat: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] } },
  gemini: { name: 'Google Gemini', type: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', link: 'https://aistudio.google.com/apikey', env: 'GEMINI_API_KEY',
    models: { chat: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], image: ['gemini-2.5-flash-image', 'imagen-4.0-generate-001'],
      video: ['veo-3.0-generate-001', 'veo-3.0-fast-generate-001'], tts: ['gemini-2.5-flash-preview-tts'], stt: ['gemini-2.5-flash'] } },
  openrouter: { name: 'OpenRouter', type: 'openai', base: 'https://openrouter.ai/api/v1', link: 'https://openrouter.ai/keys', usageOpt: true, env: 'OPENROUTER_API_KEY',
    models: { chat: ['openai/gpt-5', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat', 'meta-llama/llama-4-maverick'],
      image: ['google/gemini-3.1-flash-image', 'google/gemini-nano-banana-2.1', 'openai/gpt-image-2', 'openai/gpt-image-2.5-sunburst',
        'bytedance-seed/seedream-5-0-pro', 'bytedance-seed/seedream-4.5', 'black-forest-labs/flux.2-pro', 'black-forest-labs/flux-3-image',
        'x-ai/grok-imagine-image-2.0', 'recraft/recraft-v4', 'qwen/qwen-image-3', 'microsoft/mai-image-2.6', 'krea/krea-2-large'],
      video: ['google/veo-3.1', 'google/veo-3.1-fast', 'google/veo-3.1-lite', 'bytedance/seedance-2.0', 'bytedance/seedance-2.5',
        'bytedance/seedance-1-5-pro', 'minimax/hailuo-3', 'minimax/hailuo-2.3', 'alibaba/wan-2.7', 'alibaba/wan-3.0',
        'kwaivgi/kling-v3.0-pro', 'x-ai/grok-imagine-video', 'x-ai/grok-imagine-video-1.5', 'black-forest-labs/flux-3-video',
        'runway/gen-4.5'] } },
  groq: { name: 'Groq', type: 'openai', base: 'https://api.groq.com/openai/v1', link: 'https://console.groq.com/keys', usageOpt: true, env: 'GROQ_API_KEY',
    models: { chat: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct'], stt: ['whisper-large-v3-turbo', 'whisper-large-v3'] } },
  deepseek: { name: 'DeepSeek', type: 'openai', base: 'https://api.deepseek.com/v1', link: 'https://platform.deepseek.com/api_keys', usageOpt: true, env: 'DEEPSEEK_API_KEY',
    models: { chat: ['deepseek-chat', 'deepseek-reasoner'] } },
  xai: { name: 'xAI Grok', type: 'openai', base: 'https://api.x.ai/v1', link: 'https://console.x.ai', usageOpt: true, env: 'XAI_API_KEY',
    models: { chat: ['grok-4', 'grok-3-mini'], image: ['grok-2-image'] } },
  mistral: { name: 'Mistral', type: 'openai', base: 'https://api.mistral.ai/v1', link: 'https://console.mistral.ai/api-keys', env: 'MISTRAL_API_KEY',
    models: { chat: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'pixtral-large-latest'] } },
  together: { name: 'Together AI', type: 'openai', base: 'https://api.together.xyz/v1', link: 'https://api.together.ai/settings/api-keys', usageOpt: true, env: 'TOGETHER_API_KEY',
    models: { chat: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
      image: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1.1-pro'] } },
  ollama: { name: 'Ollama (local)', type: 'openai', base: 'http://localhost:11434/v1', keyless: true, link: 'https://ollama.com',
    models: { chat: ['llama3.2', 'qwen2.5', 'llava', 'gemma3'] } },
  custom: { name: 'Custom (OpenAI-compatible)', type: 'openai', base: '', keyless: true,
    models: { chat: [''], image: [''], tts: [''], stt: [''] } },
  elevenlabs: { name: 'ElevenLabs', type: 'elevenlabs', base: 'https://api.elevenlabs.io/v1', link: 'https://elevenlabs.io/app/settings/api-keys', env: 'ELEVENLABS_API_KEY',
    models: { tts: ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_v3'] } },
};

export const VOICES = {
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'],
  custom: ['alloy', 'nova', 'echo'],
  gemini: ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'],
  elevenlabs: ['21m00Tcm4TlvDq8ikWAM', 'EXAVITQu4vr4xnSDxMaL', 'pNInz6obpgDQGcFmaJgB'],
};

export const MODE_LABEL = { chat: 'Chat', image: 'Image', video: 'Video' };

export const DEFAULT_SKILLS = [
  { id: 'coder', icon: '💻', name: 'Senior Coder', enabled: false, prompt: 'You are an expert software engineer. Write clean, complete, production-ready code. Explain briefly, then give full code in fenced blocks with language tags. Point out edge cases and security issues.' },
  { id: 'translator', icon: '🌐', name: 'Translator BM⇄EN', enabled: false, prompt: 'Act as a translator. If the user writes in Malay, translate to natural English; otherwise translate to natural Bahasa Melayu. Keep tone and formatting. Output only the translation unless asked otherwise.' },
  { id: 'writer', icon: '✍️', name: 'Writer', enabled: false, prompt: 'You are a skilled writer and editor. Produce clear, engaging, well-structured writing that matches the requested tone and audience.' },
  { id: 'tutor', icon: '🎓', name: 'Tutor', enabled: false, prompt: 'Teach step by step like a patient tutor. Use simple examples and analogies, and end with a quick question to check understanding.' },
  { id: 'analyst', icon: '📊', name: 'Data Analyst', enabled: false, prompt: 'When given data or files, analyze them carefully, compute precisely, and present insights with tables and clear takeaways. State assumptions.' },
  { id: 'artist', icon: '🎨', name: 'Prompt Artist', enabled: false, prompt: 'Turn ideas into vivid, detailed prompts for image and video generators: subject, setting, style, lighting, lens/camera, motion, mood and composition.' },
  { id: 'concise', icon: '⚡', name: 'Concise', enabled: false, prompt: 'Be extremely concise. Answer in as few words as possible without losing accuracy.' },
];

/* Approximate public list prices in USD — EDITABLE in the app (Usage → Prices).
   Token prices: per 1M tokens (in / out). Unit prices: per image, per second of video,
   per 1M characters (TTS) or per minute (speech-to-text). `match` is a model-id prefix;
   the longest matching prefix wins. Verify against each provider's pricing page. */
export const DEFAULT_PRICES = [
  { match: 'gpt-5-nano', in: 0.05, out: 0.4 },
  { match: 'gpt-5-mini', in: 0.25, out: 2 },
  { match: 'gpt-5', in: 1.25, out: 10 },
  { match: 'gpt-4.1-nano', in: 0.1, out: 0.4 },
  { match: 'gpt-4.1-mini', in: 0.4, out: 1.6 },
  { match: 'gpt-4.1', in: 2, out: 8 },
  { match: 'gpt-4o-mini-tts', unit: '1M chars', per: 12 },
  { match: 'gpt-4o-mini-transcribe', unit: 'minute', per: 0.003 },
  { match: 'gpt-4o-mini', in: 0.15, out: 0.6 },
  { match: 'gpt-4o', in: 2.5, out: 10 },
  { match: 'o4-mini', in: 1.1, out: 4.4 },
  { match: 'o3', in: 2, out: 8 },
  { match: 'gpt-image-1', in: 5, out: 40, unit: 'image', per: 0.04 },
  { match: 'dall-e-3', unit: 'image', per: 0.04 },
  { match: 'sora-2-pro', unit: 'second', per: 0.3 },
  { match: 'sora-2', unit: 'second', per: 0.1 },
  { match: 'tts-1-hd', unit: '1M chars', per: 30 },
  { match: 'tts-1', unit: '1M chars', per: 15 },
  { match: 'whisper-1', unit: 'minute', per: 0.006 },
  { match: 'claude-opus-4-5', in: 5, out: 25 },
  { match: 'claude-opus-4', in: 15, out: 75 },
  { match: 'claude-sonnet-4', in: 3, out: 15 },
  { match: 'claude-haiku-4-5', in: 1, out: 5 },
  { match: 'claude-3-5-haiku', in: 0.8, out: 4 },
  { match: 'gemini-2.5-pro', in: 1.25, out: 10 },
  { match: 'gemini-2.5-flash-lite', in: 0.1, out: 0.4 },
  { match: 'gemini-2.5-flash-image', unit: 'image', per: 0.039 },
  { match: 'gemini-2.5-flash', in: 0.3, out: 2.5 },
  { match: 'imagen-4', unit: 'image', per: 0.04 },
  { match: 'veo-3.0-fast', unit: 'second', per: 0.15 },
  { match: 'veo-3', unit: 'second', per: 0.4 },
  { match: 'veo-3.1-fast', unit: 'second', per: 0.15 },
  { match: 'veo-3.1-lite', unit: 'second', per: 0.08 },
  { match: 'veo-3.1', unit: 'second', per: 0.4 },
  { match: 'deepseek-chat', in: 0.28, out: 0.42 },
  { match: 'deepseek-reasoner', in: 0.28, out: 0.42 },
  { match: 'grok-4', in: 3, out: 15 },
  { match: 'grok-3-mini', in: 0.3, out: 0.5 },
  { match: 'llama-3.3-70b', in: 0.59, out: 0.79 },
  { match: 'mistral-large', in: 2, out: 6 },
  { match: 'mistral-small', in: 0.1, out: 0.3 },
  { match: 'eleven_', unit: '1M chars', per: 150 },
  { match: 'text-embedding-3-small', in: 0.02, out: 0 },
  { match: 'text-embedding-3-large', in: 0.13, out: 0 },
  { match: 'gemini-embedding', in: 0.15, out: 0 },
];

/* Approximate context windows (tokens), matched by prefix. */
const CONTEXT = [
  ['gpt-5', 400000], ['gpt-4.1', 1000000], ['gpt-4o', 128000], ['o3', 200000], ['o4', 200000],
  ['claude', 200000], ['gemini-2.5', 1000000], ['gemini', 1000000], ['deepseek', 128000],
  ['grok-4', 256000], ['grok', 131072], ['llama', 128000], ['mistral', 128000], ['qwen', 128000],
];
export function contextFor(model) {
  const id = String(model || '').toLowerCase().split('/').pop();
  let best = null;
  for (const [p, n] of CONTEXT) if (id.startsWith(p) && (!best || p.length > best[0].length)) best = [p, n];
  return best ? best[1] : 128000;
}
