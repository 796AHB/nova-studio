# ⚡ Nova Studio

Your own **bring-your-own-key AI studio**, installable on phone and desktop (PWA):

- **Chat with any model.** OpenAI, Claude, Gemini, OpenRouter, Groq, DeepSeek, Grok, Mistral, Together, Ollama, or any OpenAI-compatible endpoint.
- **Create media and talk.** Images, video, hands-free voice conversations, and image editing.
- **Use your own material.** Chat with your documents, explore the files on your device, and connect tools and MCP servers.
- **Organise and compare.** Projects, skills, side-by-side model comparison, and scheduled tasks.
- **Keep it in sync and under control.** Sync across devices, share links, and a token and cost monitor with budgets.

It works as a **static site** (keys stay encrypted in your browser) or with the optional **Nova server**. The server is a zero-dependency Node.js app that holds your keys and adds accounts, sync, share links, scheduled tasks and push notifications.

---

## Contents

1. [Features](#features)
2. [Quick start](#quick-start)
3. [Nova server: accounts, sync, sharing, tasks](#nova-server)
4. [Feature guides](#feature-guides)
5. [Privacy & security](#privacy--security)
6. [Project structure & development](#project-structure)

---

## Features

| | Feature | Highlights |
|---|---|---|
| 💬 | **Chat** | Streaming Markdown, code with **▶ Run** (sandboxed preview), math, reasoning display, edit and resend, regenerate, search, Markdown or HTML export |
| 🔑 | **Any provider** | Type any model ID or load the full list. Model lists refresh weekly. |
| 📎 | **Attachments** | Photos, camera, PDFs, audio (auto-transcribed), text and code files, paste and drag-and-drop |
| 🎨 | **Images** | GPT-Image, DALL·E, Imagen, Gemini, FLUX, Grok, and the ✨ prompt enhancer. **Image tools:** mask editing (paint the area to change), remove background, on-device upscale 2×/4×, variations |
| 🎬 | **Video** | Sora 2 and Veo 3. Attach an image to animate it. |
| 🖼️ | **Gallery** | Every generated image and video in one place |
| 🎧 | **Live voice** | Hands-free conversation with automatic end-of-speech detection. Tap to interrupt. |
| 🔊 | **Voice** | TTS: browser, OpenAI, Gemini, ElevenLabs. STT: browser, Whisper, Groq, Gemini. |
| 📚 | **Chat with documents** | Knowledge bases from PDFs, Word, Excel, text, code and web pages. Hybrid search (semantic + keyword), answers with clickable **[1] citations** and page numbers. |
| 📁 | **My Files** | Explore folders on your phone, PC or laptop: filters, search inside documents, duplicate and large-file scan |
| 🔌 | **Connectors** | Tool calling: My Files, Web reader, Web search, Wikipedia, Weather, GitHub, Notes, Calculator, plus **any MCP server**, with optional approval before each tool runs |
| 📁 | **Projects** | Group chats with their own instructions, default model and knowledge bases |
| 🧩 | **Skills** | Reusable instruction packs. Toggle them with `/`. |
| ⚖️ | **Compare models** | Same question to 2–4 models side by side: speed, tokens, cost, ⚡ fastest and 💲 cheapest badges |
| ⏰ | **Scheduled tasks** | E.g. a daily news brief at 8:00. Runs on the server (even when your phone is off) or on this device. |
| 🔄 | **Sync** | Chats, projects, knowledge bases, skills, notes, usage and settings across devices. API keys are never synced. |
| 🔗 | **Share links** | Read-only public link to a chat (revocable), or export a self-contained `.html` |
| 📊 | **Usage monitor** | Real token counts, cost per message, chat and model, daily chart, budgets, CSV export, editable prices (auto-update from OpenRouter) |
| 👥 | **Accounts** | Admin and users, daily request limits, per-user usage, password change |
| 🔒 | **Key vault** | Encrypt keys with a PIN (AES-256-GCM, PBKDF2 310k). Auto-lock. |
| 🇲🇾 | **Bahasa Melayu** | Full interface in Malay (Settings → App → Interface language). The AI replies in Malay too. |
| 🐞 | **Logs** | Errors and failed API calls, with keys redacted. Copy or download for troubleshooting. |
| 📲 | **PWA** | Install to home screen, offline app shell, update prompt, share target, shortcuts, push notifications |

**Shortcuts:** `Enter` sends (desktop) · `Shift+Enter` adds a new line · `Ctrl/⌘+K` starts a new chat · `Esc` stops · `/` opens commands (`/files`, `/knowledge`, `/compare`, `/voice`, `/tasks`, `/share`, `/gallery`, `/usage`, `/lock`…)

---

## Quick start

### Option A: static hosting (no server)

Upload the **`public/`** folder to any HTTPS host. For example, drag it onto <https://app.netlify.com/drop>, or use GitHub Pages, Cloudflare Pages or Vercel. Open the site, then go to **⚙️ Settings → 🔑 Keys** and add your keys. Turn on **🔒 Security → Key vault** to encrypt them.

Static hosting gives you everything except accounts, sync, share links, server tasks and push notifications. Some providers block browser requests (CORS); use the server for those.

### Option B: Nova server (recommended)

Node.js 18.17 or newer. **No `npm install` needed.**

```bash
cp .env.example .env     # add provider keys; set APP_TOKEN or ADMIN_USER/ADMIN_PASSWORD
npm start                # → http://localhost:8787
```

Open the app, go to **Settings → 👤 Account**, and create the admin account (or sign in).

**Docker** (keep `data/` on a volume and back it up):

```bash
docker build -t nova-studio .
docker run -d -p 8787:8787 --env-file .env -v nova-data:/app/data --name nova nova-studio
```

**Deploy:** Render, Railway, Fly.io or any VPS behind HTTPS (Caddy or nginx). Installing the app and receiving push notifications both need HTTPS.

---

## Nova server

| Feature | How it works |
|---|---|
| **Key proxy** | `/proxy/<provider>/…` adds the server's keys. Providers with a server key show 🔒 in the app. |
| **Accounts** | First admin from `.env` (`ADMIN_USER`/`ADMIN_PASSWORD`) or created in the app. If `APP_TOKEN` is set, it's required for that first setup. Passwords use scrypt; sessions are random tokens stored hashed (30-day sliding expiry). |
| **Users** | Admin → **👥 Manage users**: add, disable, reset password, make admin, set a daily request limit, see per-user usage and storage. |
| **Sync** | Per-record last-write-wins, with a cursor so only changes are transferred. Videos over 12 MB and attachments over 10 MB stay on their device. |
| **Share links** | `/s/<random id>` serves a read-only page. Revoke from **Settings → Account → My shared links**. Pages are marked `noindex`. |
| **Scheduled tasks** | Runs with the server's keys, optionally after a Tavily web search, then saves the result as a chat (synced to your devices) and sends a **push notification**. Missed runs within 12 hours catch up after a restart. |
| **Push** | Standard Web Push (VAPID + aes128gcm) implemented without dependencies. Keys are generated into `data/vapid.json`. On iPhone, install the app to the Home Screen first (iOS 16.4+). |
| **Relay** | Used by the web reader and MCP servers. Blocks localhost, LAN, link-local and cloud-metadata addresses, including IPv6 and numeric tricks. |

**Single-user mode:** with only `APP_TOKEN` set (no accounts), the token holder gets sync, share and tasks as the built-in owner.

All server settings are listed in [`.env.example`](.env.example). **Back up the `data/` folder**: it holds accounts, synced data, shares and tasks.

---

## Feature guides

<details><summary><b>📚 Chat with your documents</b></summary>

1. Open **📚 Knowledge**, then **＋ New knowledge base**.
2. Add documents: **Upload**, **From My Files**, **Web page** or **Paste text**.
3. Tap **Use in this chat**, or attach the knowledge base to a **Project** so every chat in it uses it.
4. Ask questions. Answers cite `[1] report.pdf · p.4`; tap a citation to see the excerpt.

Documents are indexed **on your device**. Only the few excerpts relevant to each question are sent to the AI. Semantic search uses OpenAI `text-embedding-3-small` or Gemini `gemini-embedding-001` (or Ollama/custom); without those it falls back to keyword search.
</details>

<details><summary><b>🎧 Live voice</b></summary>

Tap 🎧 next to the mic. Speak naturally; Nova detects when you stop, answers using your current model, skills, connectors and knowledge, then speaks the reply and listens again. Tap the big button to interrupt or skip ahead. Choose voices under Settings → 🔊 Voice. Use a headset to avoid echo.
</details>

<details><summary><b>⏰ Scheduled tasks</b></summary>

Open **⏰ Tasks**, then **＋ New task**. Pick when it runs (every day, weekdays, weekly, hourly or once), the time zone and the model.

- **On the server:** tasks run even when every device is off. Turn on **🔔 notifications** under Settings → Account.
- **On this device:** tasks run while Nova is open, and missed runs happen when you open it.
</details>

<details><summary><b>🛠 Image tools</b></summary>

Tap 🛠 on any generated image, or open it from the Gallery.

- **Mask edit:** paint the area to change, then describe the change. Needs an OpenAI image model; other models edit the whole image.
- **Remove background:** transparent background on gpt-image-1, white on others.
- **Upscale:** 2× or 4× on device, free.
- **Variation.**
- **Use in chat.**
</details>

<details><summary><b>▶ Code canvas</b></summary>

HTML, SVG, JavaScript and Mermaid code blocks get a **▶ Run** button. The preview runs in a sandboxed frame with its own origin, so the code cannot read your keys or chats. The console output appears below the preview.
</details>

<details><summary><b>🔌 Connectors & MCP</b></summary>

See **🔌 Connectors** in the app. Each enabled connector adds tool descriptions (tokens) to every message, so enable only what you need. For MCP servers, use **Route through my Nova server** to avoid CORS problems, and keep **Ask before running** on for servers you don't fully trust.
</details>

<details><summary><b>📁 My Files on each device</b></summary>

- **PC/laptop (Chrome or Edge):** folder access is remembered; tap **Reconnect** after a restart.
- **Android:** pick a folder or files each session.
- **iPhone:** pick files.

Filters, **search inside** (PDF, Word, Excel, text, code) and **Scan** (duplicates, large and old files) all run on the device.
</details>

---

## Privacy & security

- **Keys:** in browser mode, keys stay on your device and can be encrypted with the vault. In server mode, keys live in `.env` and never reach the browser. **API keys are never synced.**
- **Your data:** chats, knowledge bases and files stay on your device unless you turn on sync (they then go to *your* server) or send them to an AI provider while chatting.
- **Previews:** AI-generated code previews run in an isolated sandbox origin.
- **Server protections:** strict Content-Security-Policy, rate limits, request size limits, private-network blocking for the relay, hashed sessions, and scrypt passwords.
- **Share links:** public to anyone who has the link. Revoke them when no longer needed.
- **Costs:** figures are estimates from the price table. Your provider's billing page is the source of truth.

---

## Project structure

```
nova-studio/
├── public/                  ← the PWA (deploy this folder alone for static hosting)
│   ├── index.html  sw.js  manifest.webmanifest  sandbox.html  share.html
│   ├── css/app.css
│   └── js/
│       ├── app.js           ← UI shell, providers, chat engines, tool loop
│       ├── config.js        ← providers, models, prices, skills
│       ├── store.js         ← settings + IndexedDB
│       ├── usage.js         ← usage log, budgets, dashboard
│       ├── files.js         ← My Files explorer
│       ├── connectors.js    ← built-in connectors + MCP client
│       ├── kb.js            ← knowledge bases (chunking, embeddings, hybrid search)
│       ├── voice.js  compare.js  canvas.js  gallery.js  projects.js
│       ├── account.js  sync.js  tasks.js  schedule.js  updates.js
│       └── vault.js  i18n.js  logs.js  util.js  share.js
├── server.js                ← HTTP server, proxy, relay, static files
├── server/                  ← auth, db (file storage), sync, share, push, tasks, providers
├── .env.example  Dockerfile  package.json
```

**Development:** `npm run dev` restarts the server on changes. When you release, bump `VERSION` in `public/sw.js` so installed apps show the update prompt.

**Adding an interface language:** add a dictionary in `public/js/i18n.js`. **Adding a provider:** add it to `PROVIDERS` in `config.js` (and `server/providers.js` for server keys).

## License

MIT
