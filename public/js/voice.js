/* Live voice mode: hands-free conversation.
   Listen → transcribe → AI reply (normal chat, with skills/connectors/knowledge) → speak → listen again.
   Uses the browser's speech recognition when chosen, otherwise records with automatic
   end-of-speech detection and transcribes with your speech-to-text provider. */
import { S } from './store.js';
import { $, esc, toast } from './util.js';
import { log } from './logs.js';

let api = null, el = null, state = 'idle', active = false, muted = false;
let rec = null, recog = null, stream = null, audioCtx = null, raf = 0, level = 0;
export function initVoice(a) { api = a; }

function ui() {
  if (el) return;
  el = document.createElement('div'); el.id = 'voice';
  el.innerHTML = `<div class="vc-top"><span class="vc-model" id="vc-model"></span><button class="icon" id="vc-x" aria-label="End voice mode">✕</button></div>
    <div class="vc-center"><div class="orb" id="vc-orb"><i></i></div><p class="vc-state" id="vc-state">…</p>
    <p class="vc-you" id="vc-you"></p><div class="vc-ai" id="vc-ai"></div></div>
    <div class="vc-bar"><button class="vbtn" id="vc-mute" aria-label="Mute microphone">🎙️</button><button class="vbtn main" id="vc-act" aria-label="Talk / interrupt">⏹</button><button class="vbtn end" id="vc-end" aria-label="End voice mode">✕</button></div>`;
  document.body.append(el);
  $('#vc-x', el).onclick = stop; $('#vc-end', el).onclick = stop;
  $('#vc-mute', el).onclick = () => { muted = !muted; $('#vc-mute', el).textContent = muted ? '🔇' : '🎙️'; $('#vc-mute', el).classList.toggle('on', muted); if (muted) cancelListen(); else if (state === 'idle') loop(); };
  $('#vc-act', el).onclick = () => {
    if (state === 'speaking') { api.stopSpeak(); }
    else if (state === 'thinking') { api.abort(); }
    else if (state === 'listening') { finishListen(); }
    else if (state === 'idle') { muted = false; $('#vc-mute', el).textContent = '🎙️'; loop(); }
  };
}
const STATES = { listening: ['Listening…', '⏺'], hearing: ['Listening…', '⏺'], transcribing: ['Transcribing…', '⏹'], thinking: ['Thinking…', '⏹'], speaking: ['Speaking… tap to interrupt', '✋'], idle: ['Paused — tap to talk', '🎙️'] };
function set(s) {
  state = s;
  if (!el) return;
  el.dataset.state = s;
  $('#vc-state', el).textContent = STATES[s]?.[0] || s;
  $('#vc-act', el).textContent = STATES[s]?.[1] || '⏹';
}

export async function startVoice() {
  if (active) return;
  if (!api.canChat()) return toast('Add an API key first (⚙️ Settings)');
  ui(); active = true; muted = false;
  el.classList.add('show');
  $('#vc-model', el).textContent = api.modelLabel();
  $('#vc-you', el).textContent = ''; $('#vc-ai', el).textContent = '';
  try { await navigator.wakeLock?.request('screen'); } catch {}
  loop();
}
export function stop() {
  active = false; cancelListen(); api.stopSpeak();
  if (state === 'thinking') api.abort();
  cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); stream = null;
  audioCtx?.close().catch(() => {}); audioCtx = null;
  el?.classList.remove('show'); set('idle');
}

async function loop() {
  while (active && !muted) {
    let text = '';
    try { text = (await listen()).trim(); }
    catch (e) { if (!active) return; log('warn', 'Voice listen failed: ' + e.message); toast('🎙️ ' + e.message, 5000); set('idle'); return; }
    if (!active) return;
    if (!text) { continue; }
    $('#vc-you', el).textContent = '“' + text + '”'; $('#vc-ai', el).textContent = '';
    set('thinking');
    const reply = await api.sendText(text, t => { $('#vc-ai', el).textContent = t.slice(-600); });
    if (!active) return;
    if (!reply?.text || reply.error) { if (reply?.error) toast(reply.error, 6000); set('idle'); return; }
    set('speaking');
    await api.speak(reply.text, reply.id);
  }
  if (active) set('idle');
}

/* ---------- Listening ---------- */
let finishFn = null;
function cancelListen() { try { recog?.abort(); } catch {} recog = null; if (rec && rec.state !== 'inactive') { rec._cancel = true; rec.stop(); } finishFn = null; }
function finishListen() { finishFn?.(); }

function listen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  return (S.stt.provider === 'browser' || !S.stt.provider) && SR ? listenBrowser(SR) : listenRecorder();
}
function listenBrowser(SR) {
  return new Promise((res, rej) => {
    set('listening');
    recog = new SR(); recog.lang = S.stt.lang || navigator.language; recog.interimResults = true; recog.continuous = false;
    let final = '', interim = '';
    recog.onresult = e => {
      interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) final += e.results[i][0].transcript; else interim += e.results[i][0].transcript; }
      set('hearing'); $('#vc-you', el).textContent = final + interim;
    };
    recog.onerror = e => { if (e.error === 'no-speech' || e.error === 'aborted') return; rej(new Error(e.error === 'not-allowed' ? 'Microphone permission denied' : 'Speech recognition: ' + e.error)); };
    recog.onend = () => { recog = null; res(final || interim); };
    finishFn = () => { try { recog?.stop(); } catch {} };
    try { recog.start(); } catch (e) { rej(e); }
  });
}
async function listenRecorder() {
  if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch(() => { throw new Error('Microphone permission denied'); });
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream), an = audioCtx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const buf = new Float32Array(an.fftSize);
  set('listening');
  return new Promise((res, rej) => {
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    let started = 0, lastVoice = 0, floor = 0.01, calib = [], t0 = performance.now();
    const tick = () => {
      if (!rec || rec.state === 'inactive') return;
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v; level = Math.sqrt(sum / buf.length);
      el?.style.setProperty('--lvl', Math.min(1, level * 12).toFixed(3));
      const now = performance.now();
      if (now - t0 < 350) { calib.push(level); floor = Math.max(0.006, calib.reduce((a, b) => a + b, 0) / calib.length); }
      const voice = level > floor * 2.6 + 0.004;
      if (voice) { lastVoice = now; if (!started) { started = now; set('hearing'); } }
      if (started && now - lastVoice > 1100) return rec.stop();       // end of speech
      if (started && now - started > 45000) return rec.stop();        // safety limit
      if (!started && now - t0 > 30000) { rec._cancel = true; return rec.stop(); }  // nothing said
      raf = requestAnimationFrame(tick);
    };
    rec.onstop = async () => {
      cancelAnimationFrame(raf); src.disconnect(); el?.style.setProperty('--lvl', 0);
      const cancelled = rec._cancel; const secs = started ? Math.round((lastVoice - started) / 1000) + 1 : 0; rec = null;
      if (cancelled || !started) return res('');
      set('transcribing');
      try { res(await api.transcribe(new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }), secs)); } catch (e) { rej(e); }
    };
    finishFn = () => { if (rec?.state === 'recording') { if (!started) started = performance.now() - 500; rec.stop(); } };
    rec.start(100); raf = requestAnimationFrame(tick);
  });
}
export { esc };
