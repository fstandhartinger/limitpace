import { expect, test } from 'claude-code/testing';
import { pace, headroom, status, epoch, windowReading, parseCodex, parseMapped, combined, advice, snapshot, changed, upsertBlock, demoReadings, HOUR, WEEK } from '../hooks/core.mjs';
import { harness, treeText, findButton } from './harness.mjs';
import { normalizeOptions } from '../hooks/limitpace.mjs';
const NOW = 1_800_000_000_000;
const configPath = '/home/test/.config/limitpace/config.json';
const configFiles = data => ({ [configPath]: JSON.stringify(data) });

// These pure/host simulation tests also run via scripts/test-local.mjs while the
// official runtime is unavailable. Runtime drawing tests are in runtime.test.ts.
test('options preserve valid layouts and advisor modes without changing the input', async () => {
  for (const layout of ['auto', 'detailed', 'compact', 'off']) {
    for (const advisor of ['off', 'prompt', 'file', 'both']) {
      const input = { layout, advisor, config_file: 'demo:single', refresh_minutes: '10' };
      expect(normalizeOptions(input)).toEqual({ ...input, refresh_minutes: 10 });
      expect(input.refresh_minutes).toBe('10');
    }
  }
  expect(normalizeOptions().refresh_minutes).toBe(5);
});
test('options fall back for invalid modes and coerce and clamp refresh minutes', async () => {
  for (const invalid of ['', 'unknown', null, 42, {}]) {
    const options = normalizeOptions({ layout: invalid, advisor: invalid });
    expect(options.layout).toBe('auto'); expect(options.advisor).toBe('off');
  }
  for (const [input, expected] of [[undefined, 5], ['bad', 5], [NaN, 5], ['2.5', 2.5], [1, 1], [60, 60], [0, 1], [-10, 1], [61, 60], [Infinity, 60], [-Infinity, 1]]) {
    expect(normalizeOptions({ refresh_minutes: input }).refresh_minutes).toBe(expected);
  }
});
test('registration applies normalized modes and intervals before enabling host work', async () => {
  const headless = harness({ advisor: 'invalid', refresh_minutes: 'bad' });
  await headless.start(false);
  expect(headless.calls.length).toBe(0); expect(headless.timers.length).toBe(0);
  const h = harness({ config_file: 'demo:single', layout: 'invalid', advisor: 'invalid', refresh_minutes: 120 }, { now: NOW });
  await h.start();
  expect(h.timers[0].ms).toBe(3600000); expect(h.tools.length).toBe(0);
  expect(treeText(await h.render())).toContain('Session');
  const fallback = harness({ config_file: 'demo:single', refresh_minutes: 'bad' });
  await fallback.start(); expect(fallback.timers[0].ms).toBe(300000);
  const minimum = harness({ config_file: 'demo:single', refresh_minutes: -10 });
  await minimum.start(); expect(minimum.timers[0].ms).toBe(60000);
});
test('pace clamps to the window and calculates signed headroom and status', async () => {
  const w = windowReading(47, NOW + 0.62 * 5 * HOUR, 5 * HOUR);
  expect(Math.round(pace(w, NOW))).toBe(38);
  expect(Math.round(headroom(w, NOW))).toBe(-9);
  expect(status(w, NOW)).toBe('over');
  expect(pace(w, NOW - 10 * HOUR)).toBe(0);
  expect(pace(w, NOW + 10 * HOUR)).toBe(100);
  expect(status({ ...w, used: 90 }, NOW)).toBe('critical');
  expect(status({ ...w, used: 20 }, NOW)).toBe('under');
  expect(pace({ used: 10, length: HOUR }, NOW)).toBeUndefined();
});
test('reset normalization and custom JSON dotted paths preserve missing readings', async () => {
  expect(epoch(NOW / 1000)).toBe(NOW);
  expect(epoch(NOW)).toBe(NOW);
  expect(epoch(new Date(NOW).toISOString())).toBe(NOW);
  const parsed = parseMapped({ week: { used: 32, reset: NOW / 1000 }, days: 14 }, { weekPercent: 'week.used', weekResetsAt: 'week.reset', weekWindowDays: 'days' });
  expect(parsed.week.length).toBe(14 * 24 * HOUR);
  expect(parsed.session).toBeUndefined();
  expect(windowReading(null, NOW, HOUR)).toBeUndefined();
});
test('Codex snake_case selects longest weekly and shortest session windows', async () => {
  const r = parseCodex({ rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: NOW / 1000 }, secondary_window: { used_percent: 85, limit_window_seconds: 604800, reset_at: NOW / 1000 } } });
  expect(r.session.used).toBe(42); expect(r.week.used).toBe(85); expect(r.week.length).toBe(WEEK);
});
test('Codex camelCase, window minutes and duration-free fallback', async () => {
  const r = parseCodex({ rateLimit: { primaryWindow: { usedPercent: 85, windowMinutes: 10080, resetAt: NOW / 1000 }, secondaryWindow: { usedPercent: 42, windowMinutes: 300, resetAt: NOW / 1000 } } });
  expect(r.week.used).toBe(85); expect(r.session.used).toBe(42);
  const fallback = parseCodex({ rate_limit: { primary_window: { used_percent: 85 }, secondary_window: { used_percent: 42 } } });
  expect(fallback.week.used).toBe(85); expect(fallback.session.used).toBe(42);
});
test('combined Claude percentage and pace use configured weights only on measured profiles', async () => {
  const readings = demoReadings('multi', NOW); readings[0].weight = 3;
  const result = combined(readings, NOW);
  expect(result.used).toBe((99 * 3 + 56) / 4); expect(Math.round(result.pace)).toBe(48);
});
test('advisor names best provider, delegate command, contains no model identifiers', async () => {
  const text = advice(demoReadings('multi', NOW), NOW);
  expect(text).toContain('now: Devin'); expect(text).toContain('via `codex exec`');
  expect(text).not.toMatch(/(opus|sonnet|haiku|fable|gpt-|o[1-9]\b|gemini)/i);
  expect(advice([{ ...demoReadings('single', NOW)[0], week: windowReading(95, NOW + WEEK / 2, WEEK) }], NOW)).toContain('keep delegation small');
});
test('advisor change uses recommendation and all session/week headroom points', async () => {
  const readings = demoReadings('multi', NOW), before = snapshot(readings, NOW);
  expect(changed(before, snapshot(readings, NOW + 60000), 5)).toBe(false);
  readings[2].session.used += 6;
  expect(changed(before, snapshot(readings, NOW), 5)).toBe(true);
});
test('marker upsert is idempotent and preserves all outside bytes, malformed blocks refuse edits', async () => {
  const original = 'before\r\n\n<!-- limitpace:start -->\nold\n<!-- limitpace:end -->\r\nafter\n';
  const once = upsertBlock(original, 'new');
  expect(once).toBe('before\r\n\n<!-- limitpace:start -->\nnew\n<!-- limitpace:end -->\r\nafter\n');
  expect(upsertBlock(once, 'new')).toBe(once);
  expect(upsertBlock('prefix\n<!-- limitpace:start -->\nbroken', 'new')).toBe('prefix\n<!-- limitpace:start -->\nbroken');
  expect(upsertBlock(upsertBlock('outside', 'new'), 'new')).toBe(upsertBlock('outside', 'new'));
});
test('single demo detailed band fits 120 and 60 columns and preserves another mod', async () => {
  const h = harness({ config_file: 'demo:single' }, { now: NOW, otherBand: { type: 'Text', props: {}, children: ['other mod'] } });
  await h.start();
  for (const columns of [120, 60]) {
    const text = treeText(await h.render(columns));
    expect(text).toContain('Session'); expect(text).toContain('47%'); expect(text).toContain('Week'); expect(text).toContain('31%'); expect(text).toContain('other mod');
    for (const row of text.split('\n')) expect(row.length <= columns).toBe(true);
  }
  expect(treeText(await h.emit('ui.render', { component: 'AbovePrompt', props: { hasSurvey: true } }))).toBe('other mod');
});
test('multi demo compact band includes profiles, Codex and Devin', async () => {
  const h = harness({ config_file: 'demo:multi' }, { now: NOW }); await h.start();
  const text = treeText(await h.render());
  expect(text).toContain('Claude W 78%'); expect(text).toContain('A W99 S0'); expect(text).toContain('B* W56 S47'); expect(text).toContain('Codex W85'); expect(text).toContain('Devin W32');
  for (const columns of [100, 70, 60, 30]) expect(treeText(await h.render(columns)).length <= columns).toBe(true);
});
test('expired credential makes no fetch, shows open-session hint and stores no token', async () => {
  const h = harness({}, { now: NOW, files: { '/home/test/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'TEST-SENTINEL', expiresAt: NOW - 1 } }) } });
  await h.start();
  expect(h.calls.filter(c => c.name === 'http.fetch').length).toBe(0);
  expect(treeText(await h.render())).toContain('open a session on Claude');
  expect(JSON.stringify([...h.store.values()])).not.toContain('TEST-SENTINEL');
});
test('429 keeps prior reading and throttles retries across shared sessions', async () => {
  let fetches = 0;
  const store = new Map();
  const settings = { now: NOW, store, files: { '/home/test/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'TEST-SENTINEL', expiresAt: NOW + HOUR } }) }, fetch: async () => {
    fetches++;
    return fetches === 1 ? { ok: true, status: 200, text: JSON.stringify({ five_hour: { utilization: 47, resets_at: new Date(NOW + HOUR).toISOString() }, seven_day: { utilization: 31, resets_at: new Date(NOW + WEEK / 2).toISOString() } }) } : { ok: false, status: 429, text: 'TEST-SENTINEL' };
  } };
  const h = harness({}, settings); await h.start();
  const first = h.state.get('view').readings[0];
  h.setNow(NOW + 6 * 60000); await h.emit('turn.complete', {});
  expect(h.state.get('view').readings[0].week.used).toBe(31);
  expect(h.state.get('view').readings[0].fetchedAt).toBe(first.fetchedAt);
  expect(h.state.get('view').readings[0].error).toContain('rate limited');
  await h.emit('turn.complete', {}); expect(fetches).toBe(2);
  const other = harness({}, { ...settings, now: NOW + 7 * 60000 }); await other.start(); expect(fetches).toBe(2);
  expect(JSON.stringify([...store.values()])).not.toContain('TEST-SENTINEL');
});
test('current session uses free usage without credential read and reacts to measure', async () => {
  const settings = { now: NOW, limits: [{ kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + WEEK / 2).toISOString() }] };
  const h = harness({}, settings); await h.start();
  expect(h.calls.filter(c => c.name === 'http.fetch' || c.name === 'fs.read').length).toBe(0);
  settings.limits[0].percentUsed = 40; await h.emit('session.measure', {});
  expect(h.state.get('view').readings[0].week.used).toBe(40);
});
test('prompt advisor injects once, then only on threshold or recommendation change', async () => {
  const h = harness({ advisor: 'prompt', config_file: 'demo:multi' }, { now: NOW }); await h.start();
  await h.emit('prompt.submit', { text: 'one', context: ['existing'] });
  await h.emit('prompt.submit', { text: 'two' });
  expect(h.injected[0].length).toBe(2); expect(h.injected[1].length).toBe(0);
  const view = h.state.get('view'); view.readings[2].session.used += 6;
  await h.emit('prompt.submit', { text: 'three' }); expect(h.injected[2].length).toBe(1);
  expect(h.tools[0].name).toBe('usage');
});
test('/limitpace text and non-drawing command fallback return plain summary', async () => {
  const h = harness({ config_file: 'demo:single' }, { now: NOW, surfaces: [] }); await h.start();
  expect((await h.emit('command.run', { command: 'limitpace', args: 'text' })).text).toContain('session: 47%');
  expect((await h.emit('command.run', { command: 'limitpace', args: '' })).text).toContain('week: 31%');
});
test('demo shortcut makes no file, network or process calls even on refresh/pane', async () => {
  const h = harness({ config_file: 'demo:multi', advisor: 'both' }, { now: NOW }); await h.start();
  await h.emit('command.run', { command: 'limitpace', args: 'refresh' });
  const pane = await h.render(120, 'Pane'); await findButton(pane, 'switch-0').props.onPress();
  expect(h.calls.filter(c => c.name.startsWith('fs.') || c.name.startsWith('http.') || c.name.startsWith('process.')).length).toBe(0);
});
test('headless advisor-off start performs no host work', async () => {
  const h = harness(); await h.start(false);
  expect(h.calls.length).toBe(0); expect(h.timers.length).toBe(0);
});
test('file advisor preserves outside text, writes at most every 30 minutes and only on change', async () => {
  const data = { advisor: { minChangePoints: 5 }, providers: [{ id: 'local', label: 'Local', type: 'json', path: '/quota.json' }] };
  const h = harness({ advisor: 'file' }, { now: NOW, limits: [{ kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + WEEK / 2).toISOString() }], files: { ...configFiles(data), '/project/AGENTS.md': 'before\r\n<!-- limitpace:start -->\nold\n<!-- limitpace:end -->\r\nafter', '/quota.json': JSON.stringify({ weekPercent: 20, weekResetsAt: NOW + WEEK / 2 }) } });
  await h.start(); const once = h.files.get('/project/AGENTS.md');
  expect(once.startsWith('before\r\n')).toBe(true); expect(once.endsWith('\r\nafter')).toBe(true);
  await h.emit('turn.complete', {}); expect(h.calls.filter(c => c.name === 'fs.write').length).toBe(1);
  h.setNow(NOW + 31 * 60000); await h.emit('turn.complete', {}); expect(h.calls.filter(c => c.name === 'fs.write').length).toBe(1);
  h.files.set('/quota.json', JSON.stringify({ weekPercent: 30, weekResetsAt: NOW + WEEK / 2 }));
  await h.emit('command.run', { command: 'limitpace', args: 'refresh' }); expect(h.calls.filter(c => c.name === 'fs.write').length).toBe(2);
});
test('file advisor does not create missing instructions unless explicitly allowed', async () => {
  const limits = [{ kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + WEEK / 2).toISOString() }];
  const h = harness({ advisor: 'file' }, { now: NOW, limits }); await h.start(); expect(h.files.has('/project/CLAUDE.md')).toBe(false);
  const create = harness({ advisor: 'file' }, { now: NOW, limits, files: configFiles({ advisor: { createIfMissing: true } }) });
  await create.start(); expect(create.files.get('/project/CLAUDE.md')).toContain('<!-- limitpace:start -->');
});
test('pane switcher substitutes argv without shell and reports failure without stdout leakage', async () => {
  const data = { claudeProfiles: [{ label: 'A', configDir: '~/.claude-A' }], switchCommand: ['switch-account', '{label}'] };
  const h = harness({}, { now: NOW, files: configFiles(data), run: async () => ({ exitCode: 1, stdout: 'TEST-SENTINEL', stderr: 'TEST-SENTINEL' }) });
  await h.start(); const pane = await h.render(120, 'Pane'); await findButton(pane, 'switch-0').props.onPress();
  expect(h.calls.find(c => c.name === 'process.run').args[0]).toEqual(['switch-account', 'A']);
  expect(h.toasts[0]).toContain('switch failed'); expect(h.toasts.join()).not.toContain('TEST-SENTINEL');
});
test('Codex provider reads auth in memory, sends only usage request and never caches a token', async () => {
  const data = { providers: [{ id: 'codex', label: 'Codex', type: 'codex', authFile: '/codex-auth.json' }] };
  let url;
  const h = harness({}, { now: NOW, limits: [{ kind: 'seven_day', percentUsed: 31 }], files: { ...configFiles(data), '/codex-auth.json': JSON.stringify({ tokens: { access_token: 'TEST-SENTINEL', account_id: 'TEST-ACCOUNT' } }) }, fetch: async (request, init) => {
    url = request;
    expect(init.headers.Authorization).toBe('Bearer TEST-SENTINEL'); expect(init.headers['ChatGPT-Account-Id']).toBe('TEST-ACCOUNT');
    return { ok: true, status: 200, text: JSON.stringify({ rateLimit: { primaryWindow: { usedPercent: 85, limitWindowSeconds: 604800, resetAt: NOW / 1000 }, secondaryWindow: { usedPercent: 42, limitWindowSeconds: 18000, resetAt: NOW / 1000 } } }) };
  } });
  await h.start();
  expect(url).toBe('https://chatgpt.com/backend-api/wham/usage'); expect(h.state.get('view').readings[1].week.used).toBe(85);
  expect(JSON.stringify([...h.store.values()])).not.toContain('TEST-SENTINEL'); expect(JSON.stringify([...h.state.values()])).not.toContain('TEST-ACCOUNT');
});
test('configured JSON and command providers parse mapped usage with no shell', async () => {
  const data = { providers: [{ id: 'json', label: 'JSON', type: 'json', path: '/quota.json', map: { weekPercent: 'weekly_percent', weekResetsAt: 'weekly_reset_at' } }, { id: 'cmd', label: 'Command', type: 'command', argv: ['usage-tool', '--json'], map: { weekPercent: 'week.used', weekResetsAt: 'week.reset' } }] };
  const h = harness({}, { now: NOW, limits: [{ kind: 'seven_day', percentUsed: 31 }], files: { ...configFiles(data), '/quota.json': JSON.stringify({ weekly_percent: 25, weekly_reset_at: NOW + WEEK / 2 }) }, run: async args => {
    expect(args).toEqual(['usage-tool', '--json']); return { exitCode: 0, stdout: JSON.stringify({ week: { used: 44, reset: NOW + WEEK / 2 } }), stderr: '' };
  } });
  await h.start(); expect(h.state.get('view').readings[1].week.used).toBe(25); expect(h.state.get('view').readings[2].week.used).toBe(44);
});
test('Keychain tokenCommand is argv only and never stored or drawn', async () => {
  const data = { claudeProfiles: [{ label: 'Keychain', configDir: '/keychain-profile', tokenCommand: ['keychain-reader', '--token'] }] };
  const h = harness({}, { now: NOW, files: configFiles(data), run: async args => {
    expect(args).toEqual(['keychain-reader', '--token']); return { exitCode: 0, stdout: 'TEST-SENTINEL\n', stderr: '' };
  }, fetch: async (url, init) => {
    expect(init.headers.Authorization).toBe('Bearer TEST-SENTINEL'); return { ok: true, status: 200, text: JSON.stringify({ seven_day: { utilization: 25, resets_at: new Date(NOW + WEEK / 2).toISOString() } }) };
  } });
  await h.start(); expect(h.state.get('view').readings[0].week.used).toBe(25); expect(treeText(await h.render())).not.toContain('TEST-SENTINEL');
});
test('timer refreshes cached external readings only after the configured interval', async () => {
  let runs = 0;
  const data = { providers: [{ id: 'cmd', label: 'Command', type: 'command', argv: ['quota'] }] };
  const h = harness({ refresh_minutes: 10 }, { now: NOW, limits: [{ kind: 'seven_day', percentUsed: 31 }], files: configFiles(data), run: async () => {
    runs++; return { exitCode: 0, stdout: JSON.stringify({ weekPercent: 20 + runs, weekResetsAt: NOW + WEEK / 2 }), stderr: '' };
  } });
  await h.start(); expect(h.timers.length).toBe(1); expect(h.timers[0].ms).toBe(600000);
  h.setNow(NOW + 5 * 60000); await h.emit('turn.complete'); expect(runs).toBe(1);
  h.setNow(NOW + 10 * 60000); await h.timers[0].callback(); expect(runs).toBe(2); expect(h.state.get('view').readings[1].week.used).toBe(22);
});
test('relative explicit advisor target is under the project root', async () => {
  const h = harness({ advisor: 'file' }, { now: NOW, limits: [{ kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + WEEK / 2).toISOString() }], files: { ...configFiles({ advisor: { target: 'notes.md' } }), '/project/notes.md': 'Original notes\n' } });
  await h.start(); expect(h.files.get('/project/notes.md')).toContain('Original notes\n<!-- limitpace:start -->');
});
test('shared cache is re-read after credential access immediately before fetching', async () => {
  const h = harness({}, { now: NOW, files: { '/home/test/.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'TEST-SENTINEL', expiresAt: NOW + HOUR } }) } });
  const original = h.host.fs.read;
  h.host.fs.read = async path => {
    const contents = await original(path);
    if (path.endsWith('.credentials.json')) {
      const key = h.calls.filter(c => c.name === 'store.get').slice(-1)[0].args[0];
      h.store.set(key, { id: 'claude:cached', label: 'Claude', type: 'claude', week: windowReading(31, NOW + WEEK / 2, WEEK), source: 'another session', fetchedAt: NOW });
    }
    return contents;
  };
  await h.start();
  expect(h.calls.filter(c => c.name === 'http.fetch').length).toBe(0);
  expect(h.state.get('view').readings[0].week.used).toBe(31);
});
test('profile-swap credentialsFile profiles: active one detected in memory, inactive one measured from its own file', async () => {
  const cred = (t, r) => JSON.stringify({ claudeAiOauth: { accessToken: t, refreshToken: r, expiresAt: NOW + HOUR } });
  const config = { claudeProfiles: [
    { label: 'Work', configDir: '~/.claude', credentialsFile: '~/.claude/accounts/Work.json' },
    { label: 'Home', configDir: '~/.claude', credentialsFile: '~/.claude/accounts/Home.json' },
  ] };
  const fetched = [];
  const h = harness({ config_file: '/cfg.json' }, { now: NOW,
    limits: [{ kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + WEEK / 2).toISOString() }],
    files: { '/cfg.json': JSON.stringify(config),
      '/home/test/.claude/.credentials.json': cred('SENTINEL-HOME-A', 'SENTINEL-HOME-R'),
      '/home/test/.claude/accounts/Work.json': cred('SENTINEL-WORK-A', 'SENTINEL-WORK-R'),
      '/home/test/.claude/accounts/Home.json': cred('SENTINEL-HOME-OLD', 'SENTINEL-HOME-R') },
    fetch: async (url, init) => { fetched.push(init.headers.Authorization); return { ok: true, status: 200, text: JSON.stringify({ five_hour: { utilization: 5, resets_at: new Date(NOW + HOUR).toISOString() }, seven_day: { utilization: 70, resets_at: new Date(NOW + WEEK / 2).toISOString() } }) }; } });
  await h.start();
  const view = h.state.get('view').readings;
  expect(view.find(r => r.label === 'Home').current).toBe(true);
  expect(view.find(r => r.label === 'Home').week.used).toBe(12);
  expect(view.find(r => r.label === 'Work').current).toBe(false);
  expect(view.find(r => r.label === 'Work').week.used).toBe(70);
  expect(fetched).toEqual(['Bearer SENTINEL-WORK-A']);
  expect(JSON.stringify([...h.store.values()])).not.toContain('SENTINEL');
});
