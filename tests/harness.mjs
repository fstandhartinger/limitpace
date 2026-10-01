// Deterministic host simulation for unit tests. This never accesses the machine.
import { register } from '../hooks/limitpace.mjs';
export function harness(options = {}, settings = {}) {
  const hooks = [], state = new Map(), store = settings.store ?? new Map();
  const calls = [], timers = [], injected = [], toasts = [], commands = [], tools = [];
  let now = settings.now ?? 1_800_000_000_000;
  const files = new Map(Object.entries(settings.files ?? {}));
  const host = {
    env: { get: async name => (settings.env ?? { HOME: '/home/test' })[name] },
    fs: {
      exists: async path => files.has(path),
      read: async path => { if (!files.has(path)) throw new Error('missing file'); return files.get(path); },
      write: async (path, text) => { files.set(path, text); },
    },
    store: { get: async key => store.get(key), set: async (key, value) => { store.set(key, value); } },
    state: { get: async ref => ({ value: state.get(ref.key) }), set: async (ref, value) => { state.set(ref.key, value); } },
    clock: { now: async () => now, every: (ms, callback) => { timers.push({ ms, callback }); return { cancel() {} }; } },
    session: { usage: async () => ({ rateLimits: settings.limits ?? [] }), root: async () => '/project', cwd: async () => '/project', surfaces: async () => settings.surfaces ?? ['terminal'] },
    http: { fetch: async (url, init) => settings.fetch ? settings.fetch(url, init) : { ok: true, status: 200, text: JSON.stringify({}) } },
    process: { run: async (args, init) => settings.run ? settings.run(args, init) : { exitCode: 0, stdout: '', stderr: '' } },
    command: { register: async command => { commands.push(command); } },
    tool: { register: async tool => { tools.push(tool); } },
    ui: {
      resolve: () => Object.fromEntries(['Box','Text','Button'].map(type => [type, props => ({ type, props: { ...props, children: undefined }, children: Array.isArray(props.children) ? props.children : props.children === undefined ? [] : [props.children] })])),
      open: async () => ({ isPlaced: true }), close: async () => {}, copy: async () => ({ isCopied: true }),
      toast: async text => { toasts.push(text); },
    },
  };
  // Every call is explicit and recorded, so unexpected I/O can be asserted.
  for (const [namespace, methods] of Object.entries(host)) for (const [method, fn] of Object.entries(methods)) methods[method] = (...args) => {
    // Do not record HTTP headers or credential stdout, even in the test harness.
    calls.push({ name: namespace + '.' + method, args: namespace === 'http' ? [args[0]] : namespace === 'process' ? [args[0]] : args });
    return fn(...args);
  };
  register((name, matcher, handler) => {
    if (typeof matcher === 'function') { handler = matcher; matcher = {}; }
    hooks.push({ name, matcher, handler });
    return { catch() {} };
  }, options);
  async function emit(name, event = {}) {
    const handlers = hooks.filter(h => h.name === name && Object.entries(h.matcher).every(([key, value]) => Array.isArray(value) ? value.includes(event[key]) : value === event[key]));
    async function chain(index, e) {
      if (index < handlers.length) return handlers[index].handler(host, e, next => chain(index + 1, next));
      if (name === 'ui.render') return settings.otherBand ?? null;
      if (name === 'session.start') return { cwd: e.cwd };
      if (name === 'prompt.submit') { injected.push(e.context ?? []); return { text: e.text }; }
      return name === 'turn.complete' ? { text: '' } : {};
    }
    return chain(0, event);
  }
  return { emit, host, state, store, files, calls, timers, injected, toasts, commands, tools,
    setNow(value) { now = value; },
    async start(interactive = true) { return emit('session.start', { surface: interactive ? 'terminal' : null, isInteractive: interactive, cwd: '/project' }); },
    async render(columns = 120, component = 'AbovePrompt') { return emit('ui.render', { component, requestId: 'limitpace', surface: 'terminal', props: { hasSurvey: false, bodyColumns: columns } }); },
  };
}
export function treeText(tree) {
  if (!tree) return '';
  if (typeof tree === 'string') return tree;
  return (tree.children ?? []).map(treeText).join(tree.type === 'Box' && tree.props.flexDirection === 'column' ? '\n' : '');
}
export function findButton(tree, key) {
  if (tree?.type === 'Button' && tree.props.key === key) return tree;
  for (const child of tree?.children ?? []) { const found = findButton(child, key); if (found) return found; }
}
