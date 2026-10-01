import { color, pace, headroom, resetText, combined, cleanLabel } from './core.mjs';

export function barRow(Box, Text, label, window, now, columns, weekly = false) {
  if (!window) return Text({ dimColor: true, children: `${label.padEnd(7)} ? unmeasured` });
  const p = pace(window, now), h = headroom(window, now);
  const head = h === undefined ? '?' : `${Math.round(Math.abs(h))} ${h >= 0 ? 'under' : 'over'}`;
  const suffix = columns >= 88
    ? ` ${Math.round(window.used)}%  pace ${p === undefined ? '?' : Math.round(p) + '%'}  ${head}  resets ${resetText(window, now, weekly)}`
    : columns >= 55 ? ` ${Math.round(window.used)}% p${p === undefined ? '?' : Math.round(p)} ${head}` : ` ${Math.round(window.used)}%`;
  const width = Math.max(3, Math.min(40, columns - 11 - suffix.length));
  const filled = Math.round(window.used / 100 * width);
  const marker = p === undefined ? -1 : Math.min(width - 1, Math.floor(p / 100 * width));
  const cells = Array.from({ length: width }, (_, i) => Text({
    color: i === marker ? 'cyan' : i < filled ? color(window, now) : 'gray',
    children: i === marker ? '┃' : i < filled ? '█' : '░',
  }));
  return Box({ flexDirection: 'row', children: [
    Text({ children: label.padEnd(7) + '▕' }), ...cells, Text({ children: '▏' + suffix }),
  ] });
}
export function compactParts(readings, now, columns) {
  const c = combined(readings, now);
  const total = c.used === undefined ? 'Claude W?' : `Claude W ${Math.round(c.used)}%${columns >= 100 && c.pace !== undefined ? ` (pace ${Math.round(c.pace)})` : ''}`;
  const parts = [{ text: total, color: c.used >= 90 ? 'red' : c.used <= c.pace ? 'green' : 'yellow' }];
  for (const r of readings) {
    const label = cleanLabel(r.label) + (r.current ? '*' : '');
    const text = `${label} W${r.week ? Math.round(r.week.used) : '?'}${columns >= 100 && r.session ? ` S${Math.round(r.session.used)}` : ''}${r.error ? ' !' : ''}`;
    parts.push({ text, color: color(r.week, now), dim: !r.week });
  }
  // Keep every provider visible while space allows; cut only at whole segments.
  let remaining = Math.max(0, columns - 2);
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const prefix = i ? ' │ ' : '';
    let text = prefix + parts[i].text;
    if (text.length > remaining) {
      if (remaining >= 3) result.push({ text: ' …', dim: true });
      break;
    }
    result.push({ ...parts[i], text }); remaining -= text.length;
  }
  return result;
}
export function band(Box, Text, readings, now, columns, layout) {
  const claude = readings.filter(r => r.type === 'claude');
  const extra = readings.filter(r => r.type !== 'claude');
  const detailed = layout === 'detailed' || (layout === 'auto' && claude.length === 1 && extra.length === 0);
  if (!detailed) return Box({ flexDirection: 'row', children: compactParts(readings, now, columns).map(p => Text({ color: p.color, dimColor: p.dim, children: p.text })) });
  const current = claude.find(r => r.current) ?? claude[0];
  if (!current) return Text({ dimColor: true, children: 'Claude ? configure a profile' });
  return Box({ flexDirection: 'column', children: [
    barRow(Box, Text, 'Session', current.session, now, columns),
    barRow(Box, Text, 'Week', current.week, now, columns, true),
    ...(current.error ? [Text({ dimColor: true, wrap: 'truncate', children: current.error })] : []),
    ...(extra.length ? [Box({ flexDirection: 'row', children: compactParts(extra, now, columns).slice(1).map(p => Text({ color: p.color, dimColor: p.dim, children: p.text.replace(/^ │ /, ' ') })) })] : []),
  ] });
}
