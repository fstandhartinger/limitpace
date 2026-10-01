// Produces honest simulated-host render previews, not Claude Code captures.
import { writeFile } from 'node:fs/promises';
import { harness } from '../tests/harness.mjs';
const styles = { green: 32, yellow: 33, red: 31, cyan: 36, gray: 90 };
function ansi(tree) {
  if (!tree) return '';
  if (typeof tree === 'string') return tree;
  if (tree.type === 'Button') return `\x1b[36m${tree.props.hotkey ? tree.props.hotkey + ': ' : ''}${tree.props.label}\x1b[0m`;
  const children = (tree.children ?? []).map(ansi);
  if (tree.type === 'Box') return children.join(tree.props.flexDirection === 'row' ? ' '.repeat(tree.props.columnGap ?? 0) : '\n');
  const codes = [tree.props.bold ? 1 : null, tree.props.dimColor ? 2 : null, styles[tree.props.color]].filter(Boolean);
  return (codes.length ? '\x1b[' + codes.join(';') + 'm' : '') + children.join('') + (codes.length ? '\x1b[0m' : '');
}
for (const mode of ['single', 'multi']) {
  const h = harness({ config_file: 'demo:' + mode }, { now: Date.parse('2026-10-01T08:00:00Z') });
  await h.start();
  for (const columns of mode === 'single' ? [120, 60] : [120, 70]) {
    const title = `LimitPace | ${mode} demo | ${columns} columns | SIMULATED HOST PREVIEW`;
    await writeFile(new URL(`../screenshots/demo-${mode}-${columns}.preview.ansi`, import.meta.url), '\x1b[1;37m' + title + '\x1b[0m\n\n' + ansi(await h.render(columns)) + '\n\n\x1b[90m> /limitpace                    usage and account switcher\x1b[0m\n');
  }
  await writeFile(new URL(`../screenshots/demo-${mode}-pane.preview.ansi`, import.meta.url), '\x1b[1;37mLimitPace | account pane | SIMULATED HOST PREVIEW\x1b[0m\n\n' + ansi(await h.render(100, 'Pane')) + '\n');
}
