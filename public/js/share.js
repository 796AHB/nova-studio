/* Public read-only view of a shared chat (/s/<id>). Content is sanitised before display. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = t => (window.marked && window.DOMPurify) ? DOMPurify.sanitize(marked.parse(String(t), { breaks: true, gfm: true })) : esc(t).replace(/\n/g, '<br>');
async function main() {
  const id = location.pathname.split('/').filter(Boolean).pop();
  const box = document.getElementById('sh-msgs');
  try {
    const r = await fetch('/api/share/' + encodeURIComponent(id));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'Not found');
    document.title = j.title + ' · AHB Broin';
    document.getElementById('sh-title').textContent = j.title;
    document.getElementById('sh-sub').textContent = `Shared ${new Date(j.created).toLocaleString()} · ${j.messages.length} messages · read-only`;
    box.innerHTML = j.messages.map(m => m.role === 'user'
      ? `<div class="msg user"><div class="bubble"><div class="utext">${esc(m.text).replace(/\n/g, '<br>')}</div></div></div>`
      : `<div class="msg assistant"><div class="avatar">⚡</div><div class="bubble"><div class="md">${md(m.text)}</div>${(m.media || []).map(x => `<div class="media"><figure><img src="${esc(x.src)}" alt=""></figure></div>`).join('')}${m.sources?.length ? `<div class="sources"><span>📚</span>${m.sources.map(s => `<span class="chip sm">[${s.n}] ${esc(s.doc)}${s.page ? ' · ' + esc(s.page) : ''}</span>`).join('')}</div>` : ''}${m.meta ? `<span class="meta">${esc(m.meta)}</span>` : ''}</div></div>`).join('');
    if (window.hljs) box.querySelectorAll('pre code').forEach(c => { try { hljs.highlightElement(c); } catch {} });
  } catch (e) {
    document.getElementById('sh-title').textContent = 'Link not available';
    box.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', main); else main();
