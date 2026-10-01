import { expect, mock, test } from 'claude-code/testing';
const NOW = 1_800_000_000_000;
function stubs(on, data = {}, settings = {}) {
  mock.clock(on, { now: NOW });
  mock.env(on, { HOME: '/home/test' });
  mock.store(on, {});
  on('session.start', () => ({ cwd: '/project' }));
  on('command.register', () => ({ value: undefined }));
  on('session.usage', () => ({ value: { context: {}, rateLimits: settings.limits ?? [] } }));
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('config.json') }));
  on('fs.read', ($, e) => ({ value: e.path.endsWith('config.json') ? JSON.stringify(data) : JSON.stringify({ claudeAiOauth: { accessToken: 'TEST-SENTINEL', expiresAt: NOW - 1 } }) }));
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['other mod'] }));
}
const start = { surface: 'terminal', isInteractive: true, cwd: '/project' } as any;
const site = columns => ({ plugin: 'limitpace', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns } } as any);
for (const columns of [120, 60]) {
  test(`runtime detailed band at ${columns} columns`, async ($, on) => {
    stubs(on, { demo: 'single' });
    await $.session.start(start);
    const ui = await $.ui.mount(site(columns));
    expect(await ui.find({ type: 'Text', text: /Session/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /47%/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /31%/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /other mod/ })).toBeDefined();
    await ui.unmount();
  });
}
test('runtime compact band with two accounts and two extra providers', async ($, on) => {
  stubs(on, { demo: 'multi' });
  await $.session.start(start);
  const ui = await $.ui.mount(site(120));
  expect(await ui.find({ type: 'Text', text: /A W99 S0/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /B\* W56 S47/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /Codex W85/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /Devin W32/ })).toBeDefined();
  await ui.unmount();
});
test('runtime expired credential has no fetch and gives a useful hint', async ($, on) => {
  stubs(on);
  let fetches = 0;
  on('http.fetch', () => { fetches++; return { value: { ok: false, status: 500, headers: {}, text: '' } }; });
  await $.session.start(start);
  const ui = await $.ui.mount(site(120));
  expect(await ui.find({ type: 'Text', text: /open a session on Claude/ })).toBeDefined();
  expect(fetches).toBe(0);
  await ui.unmount();
});
test('runtime text command returns summary and demo collects no credentials or network', async ($, on) => {
  stubs(on, { demo: 'single' });
  let fetches = 0;
  on('http.fetch', () => { fetches++; return { value: { ok: false, status: 500, headers: {}, text: '' } }; });
  await $.session.start(start);
  const answer = await $.command.run({ command: 'limitpace', args: 'text' });
  expect(answer.text).toContain('session: 47%');
  expect(fetches).toBe(0);
});
test('startup state redraws a band mounted before session.start', async ($, on) => {
  stubs(on, { demo: 'single' });
  const ui = await $.ui.mount(site(120));
  expect(await ui.find({ type: 'Text', text: /47%/ })).toBeUndefined();
  await $.session.start(start);
  expect(await ui.find({ type: 'Text', text: /47%/ })).toBeDefined();
  await ui.unmount();
});
