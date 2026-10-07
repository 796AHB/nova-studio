/* Gallery of every image and video generated across chats, plus image tools. */
import { S } from './store.js';
import { $, $$, esc, toast, fmtDate, parseDataUrl, download } from './util.js';

let api = null;
export function initGallery(a) { api = a; }
const urls = new WeakMap();
const srcOf = x => { if (x.blob) { if (!urls.has(x.blob)) urls.set(x.blob, URL.createObjectURL(x.blob)); return urls.get(x.blob); } return x.src; };

function items() {
  const out = [];
  for (const c of api.getConvos()) for (const m of c.messages || []) for (const [i, x] of (m.media || []).entries()) {
    const src = srcOf(x); if (!src) continue;
    out.push({ kind: x.kind, src, prompt: x.prompt || '', convo: c, msg: m, i, ts: m.ts || c.updated, meta: m.meta || '' });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
let filter = 'all', dlg = null;
export function openGallery() {
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'galDlg'; document.body.append(dlg); dlg.addEventListener('click', onClick); }
  render();
  if (!dlg.open) dlg.showModal();
}
function render() {
  const all = items(), list = all.filter(x => filter === 'all' || x.kind === filter);
  const n = k => all.filter(x => x.kind === k).length;
  dlg.innerHTML = `<div class="gal"><div class="dlg-title"><h2>🖼️ Gallery</h2><div class="inrow"><div class="seg sm">${[['all', `All ${all.length}`], ['image', `Images ${n('image')}`], ['video', `Videos ${n('video')}`]].map(([k, l]) => `<button data-g="filter" data-k="${k}" class="${filter === k ? 'active' : ''}">${l}</button>`).join('')}</div><button class="icon sm" data-g="close" aria-label="Close">✕</button></div></div>
    <div class="gal-grid">${list.map((x, i) => `<button class="gal-item" data-g="open" data-i="${all.indexOf(x)}" title="${esc(x.prompt)}">${x.kind === 'video' ? `<video src="${esc(x.src)}" muted preload="metadata"></video><span class="gal-badge">▶</span>` : `<img src="${esc(x.src)}" alt="${esc(x.prompt)}" loading="lazy">`}</button>`).join('') || '<p class="hint pad">Nothing yet — create images or videos and they will appear here.</p>'}</div></div>`;
  dlg._all = all;
}
function onClick(e) {
  if (e.target === dlg) return dlg.close();
  const b = e.target.closest('[data-g]'); if (!b) return;
  const g = b.dataset.g;
  if (g === 'close') dlg.close();
  else if (g === 'filter') { filter = b.dataset.k; render(); }
  else if (g === 'open') viewer(dlg._all[+b.dataset.i]);
  else if (g === 'back') render();
  else if (g === 'chat') { const x = dlg._x; dlg.close(); api.openConvo(x.convo.id, x.msg.id); }
  else if (g === 'tools') { const x = dlg._x; dlg.close(); openImageTools(x.src, x.prompt); }
}
function viewer(x) {
  dlg._x = x;
  const ext = x.kind === 'video' ? 'mp4' : (parseDataUrl(x.src).mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  dlg.innerHTML = `<div class="gal"><div class="dlg-title"><h2>${x.kind === 'video' ? '🎬' : '🖼️'} ${esc(fmtDate(x.ts))}</h2><button class="icon sm" data-g="back" aria-label="Back">✕</button></div>
    <div class="gal-view">${x.kind === 'video' ? `<video src="${esc(x.src)}" controls playsinline autoplay></video>` : `<img src="${esc(x.src)}" alt="">`}</div>
    <p class="gal-cap">${esc(x.prompt)}${x.meta ? `<br><small class="hint">${esc(x.meta)}</small>` : ''}</p>
    <div class="fx-bar"><button class="btn sm" data-g="back">← All</button><a class="btn sm" href="${esc(x.src)}" download="nova-${x.kind}.${ext}">⬇ Download</a><button class="btn sm" data-g="chat">💬 Open chat</button>${x.kind === 'image' ? '<button class="btn sm primary" data-g="tools">🛠 Image tools</button>' : ''}</div></div>`;
}

/* ---------- Image tools ---------- */
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => rej(new Error('Could not load image')); i.src = src; }); }
function canvasOf(img, w = img.naturalWidth, h = img.naturalHeight) { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); return c; }

/** On-device upscale: repeated 2× high-quality resampling + light sharpening. */
export async function upscaleLocal(src, factor = 2) {
  const img = await loadImg(src);
  let c = canvasOf(img);
  const maxSide = 4096;
  for (let f = 1; f < factor; f *= 2) {
    if (Math.max(c.width, c.height) * 2 > maxSide) break;
    const n = document.createElement('canvas'); n.width = c.width * 2; n.height = c.height * 2;
    const x = n.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, n.width, n.height);
    c = n;
  }
  sharpen(c, 0.4);
  return c.toDataURL('image/png');
}
function sharpen(c, amt) {
  const x = c.getContext('2d'), { width: w, height: h } = c;
  if (w * h > 9e6) return;
  const src = x.getImageData(0, 0, w, h), d = src.data, out = x.createImageData(w, h), o = out.data;
  const k = [0, -amt, 0, -amt, 1 + 4 * amt, -amt, 0, -amt, 0];
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const i = (y * w + xx) * 4;
    for (let ch = 0; ch < 3; ch++) {
      let s = 0, ki = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++, ki++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)), x2 = Math.min(w - 1, Math.max(0, xx + dx));
        s += d[(yy * w + x2) * 4 + ch] * k[ki];
      }
      o[i + ch] = s;
    }
    o[i + 3] = d[i + 3];
  }
  x.putImageData(out, 0, 0);
}

let tdlg = null;
export async function openImageTools(src, prompt = '') {
  if (!tdlg) { tdlg = document.createElement('dialog'); tdlg.id = 'toolDlg'; document.body.append(tdlg); }
  let img;
  try { img = await loadImg(src); } catch (e) { return toast(e.message); }
  const W = img.naturalWidth, H = img.naturalHeight;
  const prov = S.image.provider, maskOK = prov === 'openai';
  tdlg.innerHTML = `<div class="tools-ui"><div class="dlg-title"><h2>🛠 Image tools</h2><button class="icon sm" id="it-close" aria-label="Close">✕</button></div>
    <div class="it-stage"><div class="it-wrap"><img id="it-img" src="${esc(src)}" alt=""><canvas id="it-paint" width="${W}" height="${H}"></canvas></div></div>
    <p class="hint">${W}×${H}px · Image model: ${esc(S.image.model)} (${esc(prov)})</p>
    <div class="it-tools">
      <button class="btn sm" data-t="upscale2">🔍 Upscale 2× <small>on device</small></button>
      <button class="btn sm" data-t="upscale4">🔍 4×</button>
      <button class="btn sm" data-t="bg">✂️ Remove background</button>
      <button class="btn sm" data-t="variation">🎲 Variation</button>
      <button class="btn sm" data-t="attach">📎 Use in chat</button>
    </div>
    <h3>🖌 Edit with mask</h3>
    <p class="hint">${maskOK ? 'Paint over the area to change, then describe the change.' : 'Mask editing needs an OpenAI image model (Image mode → model). Other models will edit the whole image from your description.'}</p>
    <div class="inrow wrap it-brush"><label class="check">Brush <input type="range" id="it-size" min="5" max="200" value="${Math.round(Math.max(W, H) / 25)}"></label><button class="chip sm on" id="it-mode">🖌 Brush</button><button class="chip sm" id="it-clear">Clear mask</button></div>
    <div class="inrow"><input id="it-prompt" placeholder="e.g. replace the sky with a sunset" value=""><button class="btn primary" id="it-apply">Apply edit</button></div>
  </div>`;
  if (!tdlg.open) tdlg.showModal();
  const paint = $('#it-paint', tdlg), pc = paint.getContext('2d');
  let erasing = false, drawing = false, painted = false, last = null;
  const pos = e => { const r = paint.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  const stroke = (a, b) => {
    pc.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    pc.strokeStyle = 'rgba(255,60,90,0.55)'; pc.fillStyle = pc.strokeStyle; pc.lineCap = 'round'; pc.lineJoin = 'round'; pc.lineWidth = +$('#it-size', tdlg).value;
    pc.beginPath(); pc.moveTo(...a); pc.lineTo(...b); pc.stroke(); painted = true;
  };
  paint.onpointerdown = e => { drawing = true; paint.setPointerCapture(e.pointerId); last = pos(e); stroke(last, last); };
  paint.onpointermove = e => { if (!drawing) return; const p = pos(e); stroke(last, p); last = p; };
  paint.onpointerup = paint.onpointercancel = () => { drawing = false; };
  $('#it-mode', tdlg).onclick = e => { erasing = !erasing; e.target.textContent = erasing ? '🧽 Eraser' : '🖌 Brush'; };
  $('#it-clear', tdlg).onclick = () => { pc.clearRect(0, 0, W, H); painted = false; };
  $('#it-close', tdlg).onclick = () => tdlg.close();
  const pngOf = c => c.toDataURL('image/png');
  const base = () => pngOf(canvasOf(img));
  tdlg.querySelector('.it-tools').onclick = async e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    const t = b.dataset.t;
    if (t === 'attach') { tdlg.close(); api.attachDataUrl(src, 'image.png'); return; }
    if (t.startsWith('upscale')) {
      b.disabled = true; b.textContent = 'Upscaling…';
      try { const out = await upscaleLocal(src, t === 'upscale4' ? 4 : 2); tdlg.close(); api.addLocalImage(out, `Upscaled ${t === 'upscale4' ? 4 : 2}× on device`, prompt); }
      catch (err) { toast(err.message); b.disabled = false; }
      return;
    }
    tdlg.close();
    if (t === 'bg') api.imageJob({ src: base(), prompt: 'Remove the background completely. Keep the main subject exactly as it is, with clean edges.' + (prov === 'openai' ? '' : ' Place it on a plain pure-white background.'), background: prov === 'openai' ? 'transparent' : '' });
    else if (t === 'variation') api.imageJob({ src: base(), prompt: `Create a fresh variation of this image with the same subject and style${prompt ? ` (original prompt: ${prompt})` : ''}.` });
  };
  $('#it-apply', tdlg).onclick = () => {
    const text = $('#it-prompt', tdlg).value.trim(); if (!text) return toast('Describe the change');
    let mask = '';
    if (painted && maskOK) {
      const m = document.createElement('canvas'); m.width = W; m.height = H;
      const mx = m.getContext('2d'), pd = pc.getImageData(0, 0, W, H).data, md = mx.createImageData(W, H);
      for (let i = 3; i < pd.length; i += 4) md.data[i] = pd[i] > 10 ? 0 : 255;   // painted → fully transparent = area to edit
      mx.putImageData(md, 0, 0);
      mask = pngOf(m);
    }
    tdlg.close();
    api.imageJob({ src: base(), prompt: text, mask });
  };
}
export { $$ };
