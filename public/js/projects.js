/* Projects: group chats with their own instructions, default model and knowledge bases. */
import { DB, LS } from './store.js';
import { PROVIDERS } from './config.js';
import { $, esc, uid, toast, openModal, closeModal } from './util.js';

export let projects = [];
let current = LS.get('nova.project', '');
let hooks = { onChange: () => {}, kbs: () => [], countFor: () => 0 };
export const currentProject = () => projects.find(p => p.id === current) || null;
export const projectById = id => projects.find(p => p.id === id) || null;

export async function initProjects(h) {
  hooks = { ...hooks, ...h };
  try { projects = (await DB.all('projects')).filter(p => !p.deleted).sort((a, b) => a.name.localeCompare(b.name)); } catch { projects = []; }
  if (current && !currentProject()) current = '';
}
export function setProject(id) { current = id || ''; LS.set('nova.project', current); hooks.onChange(); }
export async function saveProject(p) {
  p.updated = Date.now();
  const i = projects.findIndex(x => x.id === p.id);
  if (i >= 0) projects[i] = p; else projects.push(p);
  projects.sort((a, b) => a.name.localeCompare(b.name));
  try { await DB.put('projects', p); } catch (e) { toast('Could not save project: ' + e.message); }
  dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'projects', id: p.id } }));
}
export async function deleteProject(p) {
  projects = projects.filter(x => x.id !== p.id);
  try { await DB.put('projects', { id: p.id, deleted: true, updated: Date.now() }); } catch {}
  dispatchEvent(new CustomEvent('nova:changed', { detail: { store: 'projects', id: p.id } }));
  if (current === p.id) setProject('');
}
/** Replace from sync. */
export async function reloadProjects() { await initProjects(hooks); hooks.onChange(); }

export function projectBarHTML() {
  const p = currentProject();
  return `<button class="projbtn" id="projBtn" aria-haspopup="menu"><span>${p ? esc(p.icon || '📁') + ' ' + esc(p.name) : '💬 All chats'}</span><span class="chev">▾</span></button>`;
}
export function openProjectMenu(anchor) {
  const menu = document.createElement('div');
  menu.className = 'popmenu projmenu'; menu.setAttribute('role', 'menu');
  menu.innerHTML = `<button data-p="">💬 <span>All chats</span></button>${projects.map(p => `<button data-p="${p.id}" class="${p.id === current ? 'sel' : ''}">${esc(p.icon || '📁')} <span>${esc(p.name)}</span><small>${hooks.countFor(p.id)}</small></button>`).join('')}
    <hr><button data-new>＋ <span>New project</span></button>${current ? '<button data-edit>⚙️ <span>Project settings</span></button>' : ''}`;
  anchor.parentElement.append(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', outside, true); };
  const outside = e => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
  setTimeout(() => document.addEventListener('click', outside, true));
  menu.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    close();
    if (b.hasAttribute('data-new')) return editProject(null);
    if (b.hasAttribute('data-edit')) return editProject(currentProject());
    setProject(b.dataset.p);
  };
}
export function editProject(p) {
  const isNew = !p; p = p ? structuredClone(p) : { id: uid(), name: '', icon: '📁', instructions: '', model: null, kbIds: [] };
  const kbs = hooks.kbs();
  const chatProviders = Object.entries(PROVIDERS).filter(([, x]) => x.models.chat);
  openModal(`<div class="dlg-title"><h2>${isNew ? 'New project' : 'Project settings'}</h2><button class="icon sm" data-close aria-label="Close">✕</button></div>
    <div class="grid2" style="grid-template-columns:80px 1fr"><label>Icon<input id="pj-icon" value="${esc(p.icon)}" maxlength="4"></label><label>Name<input id="pj-name" value="${esc(p.name)}" placeholder="e.g. Work, Thesis, Kedai online"></label></div>
    <label>Project instructions<textarea id="pj-ins" rows="6" placeholder="Context and rules for every chat in this project, e.g. who you are, the audience, tone, facts to remember…">${esc(p.instructions)}</textarea></label>
    <div class="grid2"><label>Default model (optional)<select id="pj-prov"><option value="">Use my current model</option>${chatProviders.map(([id, x]) => `<option value="${id}" ${p.model?.provider === id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label>Model ID<input id="pj-model" value="${esc(p.model?.model || '')}" placeholder="e.g. gpt-5-mini" spellcheck="false"></label></div>
    <h3>Knowledge bases</h3>
    ${kbs.length ? kbs.map(k => `<label class="check"><input type="checkbox" value="${k.id}" class="pj-kb" ${p.kbIds?.includes(k.id) ? 'checked' : ''}> ${esc(k.icon || '📚')} ${esc(k.name)} <small class="hint">${k.docs?.length || 0} docs</small></label>`).join('') : '<p class="hint">No knowledge bases yet — create one in 📚 Knowledge to let chats in this project answer from your documents.</p>'}
    <div class="dlg-actions">${isNew ? '' : '<button class="btn danger" id="pj-del">Delete project</button>'}<button class="btn" data-close>Cancel</button><button class="btn primary" id="pj-save">${isNew ? 'Create project' : 'Save'}</button></div>`);
  $('#pj-prov').onchange = e => { if (e.target.value && !$('#pj-model').value) $('#pj-model').value = PROVIDERS[e.target.value].models.chat[0]; };
  $('#pj-save').onclick = async () => {
    p.name = $('#pj-name').value.trim(); if (!p.name) return toast('Give the project a name');
    p.icon = $('#pj-icon').value.trim() || '📁'; p.instructions = $('#pj-ins').value.trim();
    const prov = $('#pj-prov').value, model = $('#pj-model').value.trim();
    p.model = prov && model ? { provider: prov, model } : null;
    p.kbIds = [...document.querySelectorAll('.pj-kb:checked')].map(i => i.value);
    await saveProject(p); closeModal();
    if (isNew) setProject(p.id); else hooks.onChange();
    toast(isNew ? `${p.icon} Project created` : 'Project saved');
  };
  if (!isNew) $('#pj-del').onclick = async () => {
    if (!confirm(`Delete project “${p.name}”? Its chats are kept and moved to All chats.`)) return;
    await deleteProject(p); closeModal(); hooks.onChange(); toast('Project deleted');
  };
}
