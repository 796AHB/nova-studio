/* Schedule maths shared by the app and the AHB Broin server (no DOM, no dependencies).
   A schedule is { type: 'daily'|'weekly'|'hourly'|'once', time: 'HH:MM', days: [0-6] (0 = Sunday), minute, at: ISO }. */
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function partsIn(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WD.indexOf(p.weekday) };
}
const offsetAt = (ts, tz) => { const p = partsIn(ts, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000; };
/** Wall-clock time in a time zone → UTC timestamp (handles DST). */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = offsetAt(guess, tz); let ts = guess - off;
  const off2 = offsetAt(ts, tz); if (off2 !== off) ts = guess - off2;
  return ts;
}
export const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** Next run after `from` (ms) or null. */
export function nextRun(sch, tz = 'UTC', from = Date.now()) {
  if (!validTz(tz)) tz = 'UTC';
  if (sch.type === 'once') { const t = Date.parse(sch.at); return t > from ? t : null; }
  const now = partsIn(from, tz);
  if (sch.type === 'hourly') {
    const mi = Math.min(59, Math.max(0, +sch.minute || 0));
    for (let k = 0; k < 3; k++) { const base = new Date(Date.UTC(now.y, now.m - 1, now.d, now.h + k)); const t = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), base.getUTCHours(), mi, tz); if (t > from + 500) return t; }
    return null;
  }
  const [hh, mm] = String(sch.time || '08:00').split(':').map(Number);
  const days = sch.type === 'weekly' ? (sch.days?.length ? sch.days : [1]) : null;
  for (let k = 0; k <= 8; k++) {
    const day = new Date(Date.UTC(now.y, now.m - 1, now.d + k));
    if (days && !days.includes(day.getUTCDay())) continue;
    const t = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh || 0, mm || 0, tz);
    if (t > from + 500) return t;
  }
  return null;
}
export function describe(sch) {
  if (sch.type === 'once') return 'Once on ' + new Date(sch.at).toLocaleString();
  if (sch.type === 'hourly') return `Every hour at :${String(sch.minute || 0).padStart(2, '0')}`;
  if (sch.type === 'weekly') {
    const d = (sch.days || []).slice().sort();
    const label = d.join() === '1,2,3,4,5' ? 'Weekdays' : d.join() === '0,6' ? 'Weekends' : d.map(i => WD[i]).join(', ');
    return `${label} at ${sch.time}`;
  }
  return `Every day at ${sch.time}`;
}
