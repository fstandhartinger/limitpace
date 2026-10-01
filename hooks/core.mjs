// Pure functions: no credentials, host calls, model names or wall-clock globals.
export const HOUR = 3_600_000;
export const WEEK = 7 * 24 * HOUR;
export const clamp = (n, low = 0, high = 100) => Math.max(low, Math.min(high, n));
export function epoch(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  const ms = Number.isFinite(number) ? (Math.abs(number) < 1e11 ? number * 1000 : number) : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
export function percent(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n) : undefined;
}
export function windowReading(used, reset, length) {
  const n = percent(used);
  const resetsAt = epoch(reset);
  return n === undefined ? undefined : { used: n, ...(resetsAt === undefined ? {} : { resetsAt }), length };
}
export function pace(window, now) {
  if (!window || !Number.isFinite(window.resetsAt) || !(window.length > 0)) return undefined;
  return clamp((now - (window.resetsAt - window.length)) / window.length * 100);
}
export function headroom(window, now) {
  const p = pace(window, now);
  return p === undefined ? undefined : p - window.used;
}
export function status(window, now) {
  if (!window) return 'unknown';
  if (window.used >= 90) return 'critical';
  const h = headroom(window, now);
  return h === undefined ? 'unknown' : h >= 0 ? 'under' : 'over';
}
export const color = (w, now) => ({ under: 'green', over: 'yellow', critical: 'red', unknown: 'gray' })[status(w, now)];
export function parseClaude(json) {
  return {
    session: windowReading(json.five_hour?.utilization, json.five_hour?.resets_at, 5 * HOUR),
    week: windowReading(json.seven_day?.utilization, json.seven_day?.resets_at, WEEK),
  };
}
export function parseSession(limits = []) {
  return {
    session: windowReading(limits.find(r => r.kind === 'five_hour')?.percentUsed, limits.find(r => r.kind === 'five_hour')?.resetsAt, 5 * HOUR),
    week: windowReading(limits.find(r => r.kind === 'seven_day')?.percentUsed, limits.find(r => r.kind === 'seven_day')?.resetsAt, WEEK),
  };
}
export function parseCodex(json) {
  const rate = json.rate_limit ?? json.rateLimit ?? {};
  const primary = rate.primary_window ?? rate.primaryWindow;
  const secondary = rate.secondary_window ?? rate.secondaryWindow;
  const duration = w => Number(w?.limit_window_seconds ?? w?.limitWindowSeconds ?? (w?.window_minutes ?? w?.windowMinutes) * 60) * 1000;
  const windows = [primary, secondary].filter(Boolean);
  let week, session;
  if (windows.every(w => !(duration(w) > 0))) { week = primary; session = secondary; }
  else {
    week = windows.filter(w => duration(w) >= 24 * HOUR).sort((a, b) => duration(b) - duration(a))[0];
    session = windows.filter(w => duration(w) > 0 && duration(w) <= 6 * HOUR).sort((a, b) => duration(a) - duration(b))[0];
  }
  const read = (w, fallback) => w ? windowReading(w.used_percent ?? w.usedPercent, w.reset_at ?? w.resetAt, duration(w) > 0 ? duration(w) : fallback) : undefined;
  return { week: read(week, WEEK), session: read(session, 5 * HOUR) };
}
export function dotted(json, path) {
  return typeof path === 'string' ? path.split('.').reduce((v, k) => v && Object.hasOwn(v, k) ? v[k] : undefined, json) : undefined;
}
export function parseMapped(json, map = {}) {
  const read = key => dotted(json, map[key] ?? key);
  const days = Number(read('weekWindowDays'));
  return {
    session: windowReading(read('sessionPercent'), read('sessionResetsAt'), 5 * HOUR),
    week: windowReading(read('weekPercent'), read('weekResetsAt'), (days > 0 && Number.isFinite(days) ? days : 7) * 24 * HOUR),
  };
}
export function combined(readings, now) {
  const measured = readings.filter(r => r.type === 'claude' && r.week);
  const average = getter => {
    const entries = measured.map(r => ({ value: getter(r), weight: r.weight > 0 ? r.weight : 1 })).filter(r => Number.isFinite(r.value));
    return entries.length ? entries.reduce((s, r) => s + r.value * r.weight, 0) / entries.reduce((s, r) => s + r.weight, 0) : undefined;
  };
  return { used: average(r => r.week.used), pace: average(r => pace(r.week, now)) };
}
export function cleanLabel(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f|`<>]/g, ' ').slice(0, 64);
}
const modelPattern = /\b(?:opus|sonnet|haiku|fable|gpt-[\w.-]*|o[1-9]\b|gemini)\b/gi;
const advisorLabel = s => cleanLabel(s).replace(modelPattern, '[plan]');
export function snapshot(readings, now) {
  const points = {};
  for (const r of readings) for (const key of ['session', 'week']) {
    const h = headroom(r[key], now);
    if (h !== undefined) points[r.id + ':' + key] = h;
  }
  const eligible = readings.filter(r => !r.error && r.week && r.week.used < 95 && (!r.session || r.session.used < 90) && headroom(r.week, now) >= 0);
  eligible.sort((a, b) => headroom(b.week, now) - headroom(a.week, now));
  return { recommendation: eligible[0]?.id ?? null, points };
}
export function changed(before, after, threshold = 5) {
  if (!before || before.recommendation !== after.recommendation) return true;
  const keys = new Set([...Object.keys(before.points), ...Object.keys(after.points)]);
  return [...keys].some(k => before.points[k] === undefined || after.points[k] === undefined || Math.abs(before.points[k] - after.points[k]) >= threshold);
}
export function advice(readings, now) {
  const snap = snapshot(readings, now);
  const n = value => value === undefined ? '?' : String(Math.round(value));
  const rows = readings.map(r => `| ${advisorLabel(r.label)}${r.current ? ' *' : ''} | ${n(r.session?.used)} | ${n(r.week?.used)} | ${n(pace(r.week, now))} | ${n(headroom(r.week, now))} |`);
  const best = readings.find(r => r.id === snap.recommendation);
  return [
    '## LimitPace delegation advice',
    '| Provider / plan | Session % | Week % | Pace % | Headroom pts |',
    '| --- | ---: | ---: | ---: | ---: |', ...rows,
    `Prefer running subagents and delegated work on the provider with the most headroom relative to its pace line (now: ${best ? advisorLabel(best.label) : 'none under pace'}). Keep the strongest model for leading and judgement. Avoid providers whose session window is >= 90 % or week >= 95 %.`,
    ...(!best ? ['No provider is under pace with safe measured limits; keep delegation small.'] : []),
    'Claude subagents run on this session\'s Claude account (*).',
    ...readings.filter(r => r.delegate).map(r => `${advisorLabel(r.label)}: via \`${advisorLabel(r.delegate)}\`.`),
    ...(readings.some(r => r.error) ? ['Readings with errors are excluded from recommendations; refresh before relying on stale data.'] : []),
  ].join('\n');
}
export const START = '<!-- limitpace:start -->';
export const END = '<!-- limitpace:end -->';
export function upsertBlock(text, block) {
  const start = text.indexOf(START), end = text.indexOf(END);
  const replacement = `${START}\n${block}\n${END}`;
  if (start >= 0 || end >= 0) {
    // Refuse malformed/duplicate marker sets instead of risking outside text.
    if (start < 0 || end < start || text.indexOf(START, start + START.length) >= 0 || text.indexOf(END, end + END.length) >= 0) return text;
    return text.slice(0, start) + replacement + text.slice(end + END.length);
  }
  return text + (text.endsWith('\n') || text === '' ? '' : '\n') + replacement + '\n';
}
export function resetText(window, now, weekly = false) {
  if (!Number.isFinite(window?.resetsAt)) return '?';
  if (!weekly) {
    const minutes = Math.max(0, Math.ceil((window.resetsAt - now) / 60000));
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  return new Date(window.resetsAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
export function summary(readings, now) {
  return readings.map(r => {
    const parts = ['session', 'week'].map(k => {
      const w = r[k], p = pace(w, now), h = headroom(w, now);
      return `${k}: ${w ? Math.round(w.used) + '%' : '?'}; pace ${p === undefined ? '?' : Math.round(p) + '%'}; ${h === undefined ? 'headroom ?' : Math.round(Math.abs(h)) + ' ' + (h >= 0 ? 'under' : 'over')}; resets ${resetText(w, now, k === 'week')}`;
    });
    return `${r.label}${r.current ? '*' : ''} — ${parts.join(' | ')}\n  ${r.source}; age ${Math.max(0, Math.floor((now - r.fetchedAt) / 60000))}m${r.error ? '; ' + r.error : ''}`;
  }).join('\n');
}
export function demoReadings(mode, now) {
  const read = (id, label, type, s, w, sp, wp, current = false) => ({ id, label, type, current, source: 'demo', fetchedAt: now, session: windowReading(s, now + (100 - sp) / 100 * 5 * HOUR, 5 * HOUR), week: windowReading(w, now + (100 - wp) / 100 * WEEK, WEEK) });
  return mode === 'multi' ? [
    read('claude:A', 'A', 'claude', 0, 99, 25, 48),
    read('claude:B', 'B', 'claude', 47, 56, 38, 48, true),
    { ...read('codex', 'Codex', 'codex', 42, 85, 65, 60), delegate: 'codex exec' },
    { ...read('devin', 'Devin', 'json', 14, 32, 55, 61), delegate: 'devin' },
  ] : [read('claude:current', 'Claude', 'claude', 47, 31, 38, 52, true)];
}
