import { readFile, writeFile, unlink } from 'node:fs/promises';
import { cases } from './local-test-kit.mjs';
const temporary = new URL('../tests/.unit-local.mjs', import.meta.url);
try {
  const source = (await readFile(new URL('../tests/unit.test.ts', import.meta.url), 'utf8')).replace("from 'claude-code/testing'", "from '../scripts/local-test-kit.mjs'");
  await writeFile(temporary, source);
  await import(temporary.href);
  let failures = 0;
  for (const { name, body } of cases) {
    try { await body(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  console.log(`${cases.length - failures} passed, ${failures} failed (local unit/host simulation only)`);
  process.exitCode = failures ? 1 : 0;
} finally { await unlink(temporary).catch(() => {}); }
