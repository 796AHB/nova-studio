/* Interface language: English / Bahasa Melayu.
   Translates interface text in place (text nodes + placeholder/title/aria-label), never chat content,
   file names or code. Add a language by adding another dictionary. */
import { S } from './store.js';

const MS = {
  // Navigation & common
  'New chat': 'Sembang baharu', 'Search chats': 'Cari sembang', 'Files': 'Fail', 'Connect': 'Sambung', 'Skills': 'Kemahiran', 'Usage': 'Penggunaan', 'Settings': 'Tetapan',
  'Install app': 'Pasang aplikasi', 'Today': 'Hari ini', 'Yesterday': 'Semalam', 'This week': 'Minggu ini', 'Older': 'Lebih lama', 'No chats yet': 'Belum ada sembang', 'No matches': 'Tiada padanan',
  'Chat': 'Sembang', 'Image': 'Imej', 'Video': 'Video', 'Cancel': 'Batal', 'Save': 'Simpan', 'Done': 'Selesai', 'Close': 'Tutup', 'Back': 'Kembali', 'Delete': 'Padam', 'Remove': 'Buang',
  'Edit': 'Sunting', 'Copy': 'Salin', 'Copied': 'Disalin', 'Download': 'Muat turun', 'Rename': 'Namakan semula', 'Reset': 'Set semula', 'Import': 'Import', 'Export': 'Eksport', 'Send': 'Hantar', 'Stop': 'Henti',
  'Message…  (/ for commands)': 'Mesej…  (/ untuk arahan)', 'Message…': 'Mesej…', 'Describe an image… (attach a photo to edit it)': 'Terangkan imej… (lampirkan foto untuk disunting)',
  'Describe a video scene… (attach an image to animate)': 'Terangkan babak video… (lampirkan imej untuk dianimasikan)',
  'Attach files': 'Lampirkan fail', 'Voice input': 'Input suara', 'Choose provider & model': 'Pilih penyedia & model', 'Chat options': 'Pilihan sembang',
  'Upload from this device': 'Muat naik dari peranti ini', 'Take a photo': 'Ambil foto', 'Browse my files & folders': 'Layari fail & folder saya',
  'Enhance prompt': 'Tingkatkan arahan', 'Enhancing…': 'Sedang dipertingkat…', 'Connectors': 'Penyambung', 'Reasoning': 'Penaakulan', 'Thinking…': 'Sedang berfikir…',
  'Read aloud': 'Baca dengan kuat', 'Regenerate with current model': 'Jana semula dengan model semasa', 'Edit & resend': 'Sunting & hantar semula',
  "You're offline — chats are still readable; sending needs a connection.": 'Anda di luar talian — sembang masih boleh dibaca; menghantar memerlukan sambungan.',
  // Welcome
  'Your own AI studio — any provider, any model. Chat, images, video, voice, files, connectors & skills.': 'Studio AI anda sendiri — mana-mana penyedia, mana-mana model. Sembang, imej, video, suara, fail, penyambung & kemahiran.',
  'Add your first API key': 'Tambah kunci API pertama anda', 'Files, photos, PDFs, audio': 'Fail, foto, PDF, audio', 'Generate or edit pictures': 'Jana atau sunting gambar', 'Sora or Veo': 'Sora atau Veo',
  'My files': 'Fail saya', 'My Files': 'Fail Saya', 'Explore, filter & scan this device': 'Teroka, tapis & imbas peranti ini', 'Web, Wikipedia, GitHub, MCP…': 'Web, Wikipedia, GitHub, MCP…',
  'Tip: type': 'Petua: taip', 'for commands and skills': 'untuk arahan dan kemahiran', 'Projects': 'Projek', 'Knowledge': 'Pengetahuan', 'Compare': 'Banding', 'Voice': 'Suara', 'Gallery': 'Galeri',
  'Chat with documents': 'Sembang dengan dokumen', 'Compare models': 'Banding model', 'Live voice': 'Suara langsung', 'Talk hands-free': 'Bercakap tanpa tangan', 'Side by side answers': 'Jawapan sebelah-menyebelah',
  'All chats': 'Semua sembang', 'New project': 'Projek baharu', 'Scheduled tasks': 'Tugasan berjadual', 'Tasks': 'Tugasan', 'Logs': 'Log', 'Account': 'Akaun', 'Sign in': 'Log masuk', 'Sign out': 'Log keluar',
  // Settings
  'Keys': 'Kunci', 'Model': 'Model', 'App': 'Aplikasi', 'Data': 'Data', 'Security': 'Keselamatan', 'System prompt': 'Arahan sistem', 'Reasoning / thinking': 'Penaakulan / pemikiran',
  'Memory (messages sent)': 'Memori (mesej dihantar)', 'Whole chat': 'Seluruh sembang', 'Temperature (blank = default)': 'Suhu (kosong = lalai)', 'Max output tokens (Claude)': 'Token output maksimum (Claude)',
  'Text-to-speech': 'Teks-ke-pertuturan', 'Speech-to-text (mic & audio files)': 'Pertuturan-ke-teks (mikrofon & fail audio)', 'Provider': 'Penyedia', 'Language (browser mic)': 'Bahasa (mikrofon pelayar)',
  'Auto-read replies aloud': 'Baca balasan secara automatik', 'Test voice': 'Uji suara', 'Theme': 'Tema', 'System': 'Sistem', 'Dark': 'Gelap', 'Light': 'Cerah', 'Enter key': 'Kekunci Enter',
  'Sends (desktop)': 'Menghantar (desktop)', 'New line': 'Baris baharu', 'Notify me when a video finishes': 'Beritahu saya apabila video siap', 'Install as an app': 'Pasang sebagai aplikasi',
  'Interface language': 'Bahasa antara muka', 'Export backup': 'Eksport sandaran', 'Import backup': 'Import sandaran', 'Delete all chats': 'Padam semua sembang', 'Include API keys in export': 'Sertakan kunci API dalam eksport',
  'Use my AHB Broin server (keys stay on the server)': 'Guna pelayan AHB Broin saya (kunci kekal di pelayan)', 'Server URL': 'URL pelayan', 'Access token': 'Token akses', 'Test connection': 'Uji sambungan',
  'Paste API key': 'Tampal kunci API', 'get key ↗': 'dapatkan kunci ↗', 'Settings saved': 'Tetapan disimpan', 'Use this model': 'Guna model ini', 'Load all': 'Muat semua', 'Model ID': 'ID model', 'Size': 'Saiz', 'Seconds': 'Saat',
  'Lock now': 'Kunci sekarang', 'Change PIN': 'Tukar PIN', 'Turn off': 'Matikan', 'Turn on': 'Hidupkan', 'Turn on vault': 'Hidupkan peti kunci', 'Unlock': 'Buka kunci', 'AHB Broin is locked': 'AHB Broin dikunci',
  'Enter your PIN or passphrase to unlock your API keys.': 'Masukkan PIN atau frasa laluan untuk membuka kunci API anda.', 'PIN or passphrase': 'PIN atau frasa laluan', 'Forgot PIN? Reset saved keys': 'Lupa PIN? Set semula kunci tersimpan',
  'Auto-lock after inactivity': 'Kunci automatik selepas tidak aktif', 'Never': 'Tidak pernah',
  // Usage
  'Usage & cost': 'Penggunaan & kos', 'Cost': 'Kos', 'Input tokens': 'Token input', 'Output tokens': 'Token output', 'Requests': 'Permintaan', 'Budgets': 'Bajet', 'This month': 'Bulan ini',
  'Daily budget (USD)': 'Bajet harian (USD)', 'Monthly budget (USD)': 'Bajet bulanan (USD)', 'By model': 'Mengikut model', 'Recent requests': 'Permintaan terkini', 'Current chat': 'Sembang semasa',
  'Prices': 'Harga', 'Price table': 'Jadual harga', 'Save prices': 'Simpan harga', 'Restore defaults': 'Pulihkan lalai', 'Add model': 'Tambah model', 'Tokens': 'Token', 'All time': 'Sepanjang masa', '7 days': '7 hari', '30 days': '30 hari',
  'no limit set': 'tiada had ditetapkan', 'On track': 'Mengikut landasan', 'Near limit': 'Hampir had', 'Over limit': 'Melebihi had',
  // Skills & connectors
  'New skill': 'Kemahiran baharu', 'Edit skill': 'Sunting kemahiran', 'Save skill': 'Simpan kemahiran', 'Name': 'Nama', 'Icon': 'Ikon', 'Instructions': 'Arahan',
  'Built-in': 'Terbina dalam', 'MCP servers': 'Pelayan MCP', 'Add MCP server': 'Tambah pelayan MCP', 'Max tool steps per reply': 'Langkah alat maksimum setiap balasan',
  'Web reader': 'Pembaca web', 'Web search': 'Carian web', 'Weather': 'Cuaca', 'Notes & memory': 'Nota & memori', 'Calculator & clock': 'Kalkulator & jam',
  'Allow once': 'Benarkan sekali', 'Always allow': 'Sentiasa benarkan', 'Deny': 'Tolak', 'Input': 'Input', 'Result': 'Hasil',
  // Files
  'Explore': 'Teroka', 'Scan': 'Imbas', 'Add folder': 'Tambah folder', 'Add files': 'Tambah fail', 'Choose a folder': 'Pilih folder', 'Pick files': 'Pilih fail',
  'Inside': 'Dalam', 'Search': 'Cari', 'All': 'Semua', 'Images': 'Imej', 'Videos': 'Video', 'Audio': 'Audio', 'Docs': 'Dokumen', 'Code': 'Kod', 'Archives': 'Arkib', 'Other': 'Lain-lain',
  'Any size': 'Sebarang saiz', 'Any time': 'Bila-bila masa', 'This year': 'Tahun ini', 'Newest': 'Terbaharu', 'Oldest': 'Tertua', 'Largest': 'Terbesar', 'Smallest': 'Terkecil', 'Clear': 'Kosongkan',
  'Attach': 'Lampirkan', 'Ask AI': 'Tanya AI', 'Save copy': 'Simpan salinan', 'Run scan': 'Jalankan imbasan', 'Rescan': 'Imbas semula', 'Report': 'Laporan', 'Ask AI for cleanup tips': 'Tanya AI petua pembersihan',
  'Storage by type': 'Storan mengikut jenis', 'Largest files': 'Fail terbesar', 'Duplicates': 'Pendua', 'Recently modified': 'Diubah suai baru-baru ini', 'Total size': 'Jumlah saiz',
  'Let the AI explore these files when you ask in chat?': 'Benarkan AI meneroka fail ini apabila anda bertanya dalam sembang?', 'Clear selection': 'Kosongkan pilihan', 'Reconnect': 'Sambung semula',
  // Projects / KB / compare / voice / gallery / canvas / tasks / share
  'Project': 'Projek', 'Project instructions': 'Arahan projek', 'Default model (optional)': 'Model lalai (pilihan)', 'Knowledge bases': 'Pangkalan pengetahuan', 'Knowledge base': 'Pangkalan pengetahuan',
  'New knowledge base': 'Pangkalan pengetahuan baharu', 'Add documents': 'Tambah dokumen', 'From My Files': 'Dari Fail Saya', 'Sources': 'Sumber', 'Use in this chat': 'Guna dalam sembang ini',
  'Listening…': 'Sedang mendengar…', 'Thinking': 'Berfikir', 'Speaking…': 'Sedang bercakap…', 'Tap to talk': 'Ketik untuk bercakap', 'End': 'Tamat', 'Interrupt': 'Sampuk',
  'Run': 'Jalankan', 'Preview': 'Pratonton', 'Open in new tab': 'Buka dalam tab baharu', 'Remove background': 'Buang latar belakang', 'Upscale': 'Besarkan', 'Edit with mask': 'Sunting dengan topeng', 'Variation': 'Variasi',
  'Brush': 'Berus', 'Erase': 'Padam', 'Apply edit': 'Guna suntingan', 'Share': 'Kongsi', 'Share link': 'Pautan kongsi', 'Create link': 'Cipta pautan', 'Revoke': 'Batalkan', 'Export as HTML': 'Eksport sebagai HTML',
  'New task': 'Tugasan baharu', 'Run now': 'Jalankan sekarang', 'Daily': 'Harian', 'Weekly': 'Mingguan', 'Hourly': 'Setiap jam', 'Time': 'Masa', 'Prompt': 'Arahan', 'Enabled': 'Didayakan',
  'Sync now': 'Segerak sekarang', 'Sync across devices': 'Segerak merentas peranti', 'Username': 'Nama pengguna', 'Password': 'Kata laluan', 'Create account': 'Cipta akaun', 'Users': 'Pengguna',
};
const PATTERNS = [
  [/^(\S+) files? · (.+)$/, '$1 fail · $2'], [/^(\S+) files?$/, '$1 fail'], [/^(\d+) folders?$/, '$1 folder'], [/^(\d+) tools?$/, '$1 alat'], [/^(\d+) on$/, '$1 hidup'],
  [/^(\d+) selected$/, '$1 dipilih'], [/^(\d+) messages · (.+)$/, '$1 mesej · $2'], [/^(\S+) notes saved$/, '$1 nota disimpan'],
];
const DICTS = { ms: MS };
let dict = null, obs = null;
const SKIP = '.md, .utext, pre, code, textarea, .fmain b, .fmain small, #convoList span, #modelChip b, .hit, .tl, .tn, .ctip, .src span, .logs, .kb-doc b, .src-name, #lockscreen input, .cmp-out, .gal-cap';

export function currentLang() {
  const l = S.lang === 'auto' || !S.lang ? (navigator.language || 'en').slice(0, 2) : S.lang;
  return DICTS[l] ? l : 'en';
}
function tr(text) {
  const m = /^([^\p{L}\p{N}]*)([\s\S]*?)([\s:…]*)$/u.exec(text);
  if (!m || !m[2]) return null;
  const core = m[2];
  if (dict[core]) return m[1] + dict[core] + m[3];
  for (const [re, rep] of PATTERNS) if (re.test(core)) return m[1] + core.replace(re, rep) + m[3];
  return null;
}
function walk(root) {
  if (!dict || !root) return;
  if (root.nodeType === 3) { tNode(root); return; }
  if (root.nodeType !== 1) return;
  for (const a of ['placeholder', 'title', 'aria-label']) { const v = root.getAttribute?.(a); if (v) { const t = tr(v); if (t && t !== v) root.setAttribute(a, t); } }
  if (root.closest?.(SKIP)) return;
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: n => n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  let n; while ((n = it.nextNode())) {
    if (n.nodeType === 3) tNode(n);
    else for (const a of ['placeholder', 'title', 'aria-label']) { const v = n.getAttribute(a); if (v) { const t = tr(v); if (t && t !== v) n.setAttribute(a, t); } }
  }
}
function tNode(n) {
  const v = n.nodeValue; if (!v || !v.trim() || v.length > 300) return;
  if (n.parentElement?.closest(SKIP)) return;
  const t = tr(v); if (t && t !== v) n.nodeValue = t;
}
export function applyLang() {
  const l = currentLang();
  document.documentElement.lang = l === 'ms' ? 'ms' : 'en';
  dict = l === 'en' ? null : DICTS[l];
  obs?.disconnect();
  if (!dict) return false;
  walk(document.body);
  obs = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'characterData') tNode(m.target);
      else { for (const n of m.addedNodes) walk(n); if (m.type === 'attributes') walk(m.target); }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] });
  return true;
}
/** Instruction appended to the system prompt so the AI answers in the interface language by default. */
export const langNote = () => currentLang() === 'ms' ? 'The user\'s interface is in Bahasa Melayu. Reply in Bahasa Melayu unless the user writes in another language.' : '';
