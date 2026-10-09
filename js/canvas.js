/* Code canvas: run HTML / SVG / JavaScript / Mermaid from AI answers in a sandboxed frame.
   The frame has an opaque origin, so previewed code can't read the app's keys, chats or storage. */
import { $, esc, download, copy } from './util.js';

export const RUNNABLE = /^(html|htm|svg|xml|javascript|js|mermaid)$/i;
let panel = null, frame = null, ready = false, pendingHtml = null, current = null;

function buildHtml(code, lang) {
  lang = (lang || '').toLowerCase();
  if (lang === 'mermaid') return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px;font-family:system-ui;background:#fff}</style></head><body><pre class="mermaid">${esc(code)}</pre><script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js"><\/script><script>mermaid.initialize({startOnLoad:true,securityLevel:'strict'})<\/script></body></html>`;
  if (lang === 'javascript' || lang === 'js') return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:14px;font:13px ui-monospace,monospace;background:#0d1117;color:#e6edf3}#out div{padding:2px 0;border-bottom:1px solid #ffffff12;white-space:pre-wrap}.error{color:#ff7b72}.warn{color:#e3b341}</style></head><body><div id="out"></div><script>(function(){var o=document.getElementById('out');['log','info','warn','error'].forEach(function(k){var f=console[k];console[k]=function(){var d=document.createElement('div');d.className=k;d.textContent=Array.prototype.map.call(arguments,function(x){try{return typeof x==='object'?JSON.stringify(x,null,2):String(x)}catch(_){return String(x)}}).join(' ');o.appendChild(d);f.apply(console,arguments)}});addEventListener('error',function(e){console.error(e.message)})})();<\/script><script>${code.replace(/<\/script/gi, '<\\/script')}<\/script></body></html>`;
  if ((lang === 'svg' || lang === 'xml') && /<svg[\s>]/i.test(code)) return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`;
  return /<html[\s>]|<!doctype/i.test(code) ? code : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${code}</body></html>`;
}

function ensurePanel() {
  if (panel) return;
  panel = document.createElement('aside');
  panel.id = 'canvas';
  panel.innerHTML = `<div class="cv-head"><b>▶ Preview</b><div class="seg sm" id="cv-tabs"><button data-t="preview" class="active">Preview</button><button data-t="code">Code</button></div>
    <span class="cv-sp"></span><button class="icon sm" id="cv-rerun" title="Run again" aria-label="Run again">↻</button><button class="icon sm" id="cv-copy" title="Copy code" aria-label="Copy code">📋</button><button class="icon sm" id="cv-dl" title="Download .html" aria-label="Download">⬇</button><button class="icon sm" id="cv-max" title="Full screen" aria-label="Full screen">⛶</button><button class="icon sm" id="cv-close" title="Close" aria-label="Close preview">✕</button></div>
    <div class="cv-body"><iframe id="cv-frame" title="Code preview" sandbox="allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock" allow="fullscreen" referrerpolicy="no-referrer"></iframe><pre id="cv-code" hidden></pre></div>
    <div class="cv-console" id="cv-console" hidden></div>`;
  document.body.append(panel);
  frame = $('#cv-frame', panel);
  addEventListener('message', e => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.type === 'nova-sandbox-ready') { ready = true; if (pendingHtml) { frame.contentWindow.postMessage({ type: 'nova-render', html: pendingHtml }, '*'); pendingHtml = null; } }
    else if (d.type === 'nova-console') {
      const c = $('#cv-console', panel); c.hidden = false;
      const row = document.createElement('div'); row.className = d.level; row.textContent = String(d.text).slice(0, 2000);
      c.append(row); c.scrollTop = c.scrollHeight;
    }
  });
  $('#cv-tabs', panel).onclick = e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    $('#cv-tabs', panel).querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    frame.hidden = b.dataset.t !== 'preview'; $('#cv-code', panel).hidden = b.dataset.t !== 'code';
  };
  $('#cv-rerun', panel).onclick = () => current && openCanvas(current.code, current.lang);
  $('#cv-copy', panel).onclick = () => current && copy(current.code);
  $('#cv-dl', panel).onclick = () => current && download(buildHtml(current.code, current.lang), 'nova-preview.html', 'text/html');
  $('#cv-max', panel).onclick = () => panel.classList.toggle('max');
  $('#cv-close', panel).onclick = closeCanvas;
}
export function openCanvas(code, lang) {
  ensurePanel();
  current = { code, lang };
  const html = buildHtml(code, lang);
  $('#cv-code', panel).textContent = code;
  const con = $('#cv-console', panel); con.replaceChildren(); con.hidden = true;
  document.body.classList.add('canvas-open');
  ready = false; pendingHtml = html;
  frame.src = new URL('sandbox.html', location.href).href + '#' + Date.now();
}
export function closeCanvas() { document.body.classList.remove('canvas-open'); panel?.classList.remove('max'); if (frame) frame.src = 'about:blank'; }
