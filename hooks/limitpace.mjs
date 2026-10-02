import { parseClaude, parseCodex, parseMapped, parseSession, demoReadings, advice, snapshot, changed, summary, upsertBlock, cleanLabel, resetText } from './core.mjs';
import { band, barRow } from './drawing.mjs';

const VERSION = '0.1.1';
const VIEW = { plugin: 'limitpace', key: 'view' };
const INJECTED = { plugin: 'limitpace', key: 'injected' };
let config = null;
let options = {};
let enabled = false;
let refreshing = false;

function expand(path, home) {
  return String(path).replace(/^~(?=[/\\]|$)/, home).replace(/\\/g, '/').replace(/\/$/, '');
}
function hash(value) {
  let n = 2166136261;
  for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return (n >>> 0).toString(16);
}
function argv(value) {
  return Array.isArray(value) && value.length > 0 && value.every(a => typeof a === 'string' && !a.includes('\0')) ? value : undefined;
}
async function loadConfig($) {
  if (config) return config;
  // These shortcuts deliberately need no host reads, including env and config.
  if (/^demo:(single|multi)$/.test(options.config_file)) {
    config = { demo: options.config_file.slice(5), profiles: [], providers: [], advisor: {} };
    return config;
  }
  const home = (await $.env.get('HOME')) ?? '';
  const currentDir = expand((await $.env.get('CLAUDE_CONFIG_DIR')) || '~/.claude', home);
  const path = expand(options.config_file, home);
  let data = {}, configError;
  try {
    if (path && await $.fs.exists(path)) data = JSON.parse(await $.fs.read(path));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  } catch { data = {}; configError = 'Config unreadable or invalid JSON; using this Claude session.'; }
  const inputProfiles = Array.isArray(data.claudeProfiles) ? data.claudeProfiles : [{ label: 'Claude', configDir: currentDir }];
  const profiles = inputProfiles.filter(p => p && typeof p.configDir === 'string').map((p, i) => {
    const configDir = expand(p.configDir, home);
    const credentialsFile = typeof p.credentialsFile === 'string' ? expand(p.credentialsFile, home) : undefined;
    return {
      id: 'claude:' + hash(configDir + (credentialsFile ? '|' + credentialsFile : '')), label: cleanLabel(p.label ?? `Claude ${i + 1}`), type: 'claude',
      configDir, credentialsFile, current: !credentialsFile && configDir === currentDir,
      weight: Number(p.weight) > 0 ? Number(p.weight) : 1, tokenCommand: argv(p.tokenCommand),
    };
  });
  // Profile-swap setups keep every account's login in its own file and swap one into the shared config dir.
  // The active one is the profile whose stored login matches the live one (compared in memory, never kept).
  if (!profiles.some(p => p.current)) {
    for (const p of profiles.filter(p => p.credentialsFile && p.configDir === currentDir)) {
      try {
        const live = JSON.parse(await $.fs.read(p.configDir + '/.credentials.json')).claudeAiOauth ?? {};
        const stored = JSON.parse(await $.fs.read(p.credentialsFile));
        const o = stored.claudeAiOauth ?? {};
        let same = (o.refreshToken && o.refreshToken === live.refreshToken) || (o.accessToken && o.accessToken === live.accessToken);
        if (!same && stored.accountUuid) {
          const meta = JSON.parse(await $.fs.read(currentDir === expand('~/.claude', home) ? home + '/.claude.json' : currentDir + '/.claude.json'));
          same = meta?.oauthAccount?.accountUuid === stored.accountUuid;
        }
        if (same) { p.current = true; break; }
      } catch { /* unknown stays not-current */ }
    }
  }
  const providers = (Array.isArray(data.providers) ? data.providers : []).filter(p => p && ['codex', 'json', 'command'].includes(p.type)).map((p, i) => ({
    id: cleanLabel(p.id ?? `provider-${i + 1}`), label: cleanLabel(p.label ?? p.id ?? `Provider ${i + 1}`), type: p.type,
    authFile: expand(p.authFile ?? '~/.codex/auth.json', home), path: expand(p.path ?? '', home),
    argv: argv(p.argv), map: p.map ?? {}, delegate: p.delegate ? cleanLabel(p.delegate) : undefined,
  }));
  // Store identity includes source config, preventing unrelated configurations sharing an id.
  for (const p of [...profiles, ...providers]) p.cacheKey = 'reading:' + p.id + ':' + hash(JSON.stringify({ type: p.type, configDir: p.configDir, credentialsFile: p.credentialsFile, authFile: p.authFile, path: p.path, argv: p.argv, map: p.map, tokenCommand: p.tokenCommand }));
  config = { profiles, providers, advisor: data.advisor ?? {}, switchCommand: argv(data.switchCommand), demo: ['single', 'multi'].includes(data.demo) ? data.demo : undefined, home, configError };
  return config;
}
function publicReading(provider, fields, now) {
  return JSON.parse(JSON.stringify({ id: provider.id, label: provider.label, type: provider.type, current: provider.current,
    weight: provider.weight, delegate: provider.delegate, fetchedAt: now, ...fields }));
}
async function recentReading($, provider, now, force) {
  const latest = await $.store.get(provider.cacheKey);
  if (!force && latest && now - (latest.checkedAt ?? latest.fetchedAt) < options.refresh_minutes * 60000) {
    return { ...latest, label: provider.label, current: provider.current, delegate: provider.delegate, weight: provider.weight };
  }
}
async function measure($, provider, now, force, live) {
  const key = provider.cacheKey;
  const previous = await $.store.get(key);
  if (provider.current && (live.session || live.week)) {
    const reading = publicReading(provider, { session: live.session ?? previous?.session, week: live.week ?? previous?.week, source: 'Claude session' }, now);
    await $.store.set(key, reading); return reading;
  }
  // Always re-read the shared store immediately before fetching.
  const cached = await $.store.get(key);
  if (!force && cached && now - (cached.checkedAt ?? cached.fetchedAt) < options.refresh_minutes * 60000) {
    return { ...cached, label: provider.label, current: provider.current, delegate: provider.delegate, weight: provider.weight };
  }
  let fields, source, error;
  try {
    if (provider.type === 'claude') {
      let token;
      if (provider.tokenCommand) {
        const result = await $.process.run(provider.tokenCommand, { timeoutMs: 5000 });
        if (result.exitCode !== 0) throw new Error();
        token = result.stdout.trim();
      } else {
        const credentials = JSON.parse(await $.fs.read(provider.credentialsFile ?? provider.configDir + '/.credentials.json'));
        const oauth = credentials.claudeAiOauth;
        if (!oauth?.accessToken || !Number.isFinite(Number(oauth.expiresAt)) || Number(oauth.expiresAt) <= now) {
          error = `token expired or missing; open a session on ${provider.label}`;
        } else token = oauth.accessToken;
      }
      if (!error && token) {
        const latest = await recentReading($, provider, now, force);
        if (latest) return latest;
        const response = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
          headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'limitpace/' + VERSION },
        });
        if (response.status === 429) error = 'usage rate limited; keeping last reading';
        else if (!response.ok) error = 'usage unavailable (HTTP ' + response.status + ')';
        else fields = parseClaude(JSON.parse(response.text));
      } else if (!error) error = `token missing; open a session on ${provider.label}`;
      source = 'Claude OAuth usage';
    } else if (provider.type === 'codex') {
      const auth = JSON.parse(await $.fs.read(provider.authFile));
      const token = auth.tokens?.access_token;
      if (!token) error = 'token missing; open a Codex session';
      else {
        const latest = await recentReading($, provider, now, force);
        if (latest) return latest;
        const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
        if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
        const response = await $.http.fetch('https://chatgpt.com/backend-api/wham/usage', { headers });
        if (response.status === 429) error = 'usage rate limited; keeping last reading';
        else if (!response.ok) error = 'usage unavailable (HTTP ' + response.status + ')';
        else fields = parseCodex(JSON.parse(response.text));
      }
      source = 'Codex usage';
    } else if (provider.type === 'json') {
      fields = parseMapped(JSON.parse(await $.fs.read(provider.path)), provider.map); source = 'configured JSON';
    } else {
      if (!provider.argv) throw new Error();
      const result = await $.process.run(provider.argv, { timeoutMs: 5000 });
      if (result.exitCode !== 0) throw new Error();
      fields = parseMapped(JSON.parse(result.stdout), provider.map); source = 'configured command';
    }
    if (!error && !fields?.session && !fields?.week) { error = 'no usage windows reported'; fields = undefined; }
  } catch {
    // Never echo thrown messages or process output: either can contain credentials.
    error = provider.type === 'claude' ? `credentials or usage unavailable; open a session on ${provider.label}` : 'usage unavailable; check configured source';
  }
  const reading = publicReading(provider, {
    session: fields?.session ?? cached?.session, week: fields?.week ?? cached?.week,
    source: source ?? cached?.source ?? 'unavailable', error,
    fetchedAt: fields ? now : cached?.fetchedAt ?? now, checkedAt: now,
  }, now);
  await $.store.set(key, reading);
  return reading;
}
async function refresh($, force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const cfg = await loadConfig($);
    const now = await $.clock.now();
    let readings;
    if (cfg.demo) readings = demoReadings(cfg.demo, now);
    else {
      const live = parseSession((await $.session.usage()).rateLimits);
      readings = [];
      for (const provider of [...cfg.profiles, ...cfg.providers]) readings.push(await measure($, provider, now, force, live));
    }
    await $.state.set(VIEW, { readings, now, ...(cfg.configError ? { configError: cfg.configError } : {}) });
    if (enabled && ['file', 'both'].includes(options.advisor) && !cfg.demo) await writeAdvisor($, readings, now);
  } finally { refreshing = false; }
}
async function writeAdvisor($, readings, now) {
  const root = await $.session.root() || await $.session.cwd();
  const target = config.advisor.target;
  let path;
  if (target && target !== 'auto') {
    const expanded = expand(target, config.home);
    path = expanded.startsWith('/') || /^[A-Za-z]:\//.test(expanded) ? expanded : root + '/' + expanded;
  }
  else if (await $.fs.exists(root + '/AGENTS.md')) path = root + '/AGENTS.md';
  else path = root + '/CLAUDE.md';
  const key = 'advisor-file:' + hash(path);
  const last = await $.store.get(key);
  const snap = snapshot(readings, now);
  const threshold = Math.max(1, Number(config.advisor.minChangePoints) || 5);
  if (last && (now - last.writtenAt < 30 * 60000 || !changed(last.snapshot, snap, threshold))) return;
  const exists = await $.fs.exists(path);
  if (!exists && config.advisor.createIfMissing !== true) return;
  const original = exists ? await $.fs.read(path) : '';
  const body = advice(readings, now) + '\n\nUpdated ' + new Date(Math.floor(now / 60000) * 60000).toISOString() + '.';
  const updated = upsertBlock(original, body);
  if (updated === original) return;
  await $.fs.write(path, updated);
  await $.store.set(key, { snapshot: snap, writtenAt: now });
}
async function switchProfile($, profile) {
  if (config.demo) { await $.ui.toast('demo: account switch disabled'); return; }
  try {
    if (config.switchCommand) {
      const command = config.switchCommand.map(part => part.replaceAll('{label}', profile.label));
      const result = await $.process.run(command, { timeoutMs: 5000 });
      await $.ui.toast(result.exitCode === 0 ? `new sessions use ${profile.label}` : 'switch failed; check configured command');
    } else {
      const dir = profile.configDir.replaceAll("'", "'\\''");
      const copied = await $.ui.copy(`CLAUDE_CONFIG_DIR='${dir}' claude`);
      await $.ui.toast(copied.isCopied ? `copied: start a session on ${profile.label}` : 'clipboard unavailable');
    }
  } catch { await $.ui.toast('switch unavailable; check configured command'); }
}
export function normalizeOptions(userOptions = {}) {
  const normalized = { layout: 'auto', config_file: '~/.config/limitpace/config.json', advisor: 'off', refresh_minutes: 5, ...userOptions };
  if (!['auto', 'detailed', 'compact', 'off'].includes(normalized.layout)) normalized.layout = 'auto';
  if (!['off', 'prompt', 'file', 'both'].includes(normalized.advisor)) normalized.advisor = 'off';
  const minutes = Number(normalized.refresh_minutes);
  normalized.refresh_minutes = Number.isNaN(minutes) ? 5 : Math.min(60, Math.max(1, minutes));
  return normalized;
}
export function register(on, userOptions) {
  config = null; enabled = false; refreshing = false;
  options = normalizeOptions(userOptions);
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    enabled = e.isInteractive || options.advisor !== 'off';
    if (!enabled) return result;
    await refresh($);
    $.clock.every(options.refresh_minutes * 60000, async () => refresh($));
    if (['prompt', 'both'].includes(options.advisor)) await $.tool.register({ name: 'usage', description: 'Current subscription usage and provider-neutral delegation advice', inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
    await $.command.register({ name: 'limitpace', description: 'Usage, pace and account switcher', argumentHint: '[refresh|text]', immediate: true });
    return result;
  });
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const result = await next(e);
    if (enabled) await refresh($);
    return result;
  });
  on('session.measure', async ($, e, next) => {
    const result = await next(e);
    if (enabled) await refresh($);
    return result;
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (enabled && !e.agentId) await refresh($);
    return result;
  });
  on('prompt.submit', async ($, e, next) => {
    if (!enabled || !['prompt', 'both'].includes(options.advisor)) return next(e);
    const { value: view } = await $.state.get(VIEW);
    if (!view) return next(e);
    const now = await $.clock.now();
    const snap = snapshot(view.readings, now);
    const { value: last } = await $.state.get(INJECTED);
    if (!changed(last, snap, Math.max(1, Number(config?.advisor.minChangePoints) || 5))) return next(e);
    const result = await next({ ...e, context: [...(e.context ?? []), advice(view.readings, now)] });
    if (!result.drop) await $.state.set(INJECTED, snap);
    return result;
  });
  on('tool.call', { tool: 'mcp__limitpace__usage' }, async ($, e, next) => {
    if (!enabled || !['prompt', 'both'].includes(options.advisor)) return next(e);
    await refresh($);
    const { value: view } = await $.state.get(VIEW);
    return { result: advice(view?.readings ?? [], await $.clock.now()) };
  });
  on('command.run', { command: 'limitpace' }, async ($, e) => {
    const arg = e.args.trim();
    if (arg === 'refresh' || !config) await refresh($, arg === 'refresh');
    const { value: view } = await $.state.get(VIEW);
    const text = summary(view?.readings ?? [], await $.clock.now()) || 'LimitPace: no configured providers.';
    if (arg === 'text' || arg === 'refresh') return { text };
    if (arg) return { text: 'Use /limitpace [refresh|text].' };
    const surfaces = await $.session.surfaces();
    if (!surfaces.some(s => s === 'terminal' || s === 'desktop')) return { text };
    const opened = await $.ui.open({ id: 'limitpace', title: 'LimitPace', focus: true, closeOnEscape: true, rows: 30, columns: 66 });
    return opened.isPlaced ? {} : { text };
  });
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || options.layout === 'off') return next(e);
    const { value: view } = await $.state.get(VIEW);
    if (!enabled || !view?.readings.length) return next(e);
    const existing = await next(e);
    const { Box, Text } = $.ui.resolve(e);
    return Box({ flexDirection: 'column', paddingX: 1, children: [
      ...(existing ? [existing] : []),
      band(Box, Text, view.readings, view.now, Math.max(1, e.props.bodyColumns - 2), options.layout),
      ...(view.configError ? [Text({ dimColor: true, wrap: 'truncate', children: view.configError })] : []),
    ] });
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'limitpace') return next(e);
    const { value: view = { readings: [], now: 0 } } = await $.state.get(VIEW);
    const { Box, Text, Button } = $.ui.resolve(e);
    const columns = Math.max(1, e.props.bodyColumns - 2);
    const profiles = config?.demo ? view.readings.filter(r => r.type === 'claude') : config?.profiles ?? [];
    return Box({ flexDirection: 'column', paddingX: 1, children: [
      Text({ bold: true, children: 'Usage and pace' }),
      Text({ dimColor: true, children: '\nSwitch for new sessions (current session stays on its account)' }),
      ...profiles.slice(0, 9).map((p, i) => Button({ key: 'switch-' + i, label: p.label, plain: true, hotkey: String(i + 1), onPress: async () => switchProfile($, p) })),
      Box({ flexDirection: 'row', columnGap: 2, children: [
        Button({ key: 'refresh', label: 'Refresh (r)', hotkey: 'r', onPress: async () => refresh($, true) }),
        Button({ key: 'close', label: 'Close (c)', hotkey: 'c', onPress: async () => $.ui.close({ id: 'limitpace' }) }),
      ] }),
      ...view.readings.flatMap(r => [
        Text({ bold: true, children: '\n' + r.label + (r.current ? ' * this session' : '') }),
        barRow(Box, Text, 'Session', r.session, view.now, columns),
        barRow(Box, Text, 'Week', r.week, view.now, columns, true),
        ...(columns < 88 ? [Text({ dimColor: true, wrap: 'wrap', children: `Resets: session ${resetText(r.session, view.now)} · week ${resetText(r.week, view.now, true)}` })] : []),
        Text({ dimColor: true, wrap: 'wrap', children: `${r.source} · age ${Math.max(0, Math.floor((view.now - r.fetchedAt) / 60000))}m${r.error ? '\n' + r.error : ''}` }),
      ]),
    ] });
  });
}
