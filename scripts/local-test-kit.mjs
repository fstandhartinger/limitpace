// Small assertion adapter for pure/unit tests when the official runtime is off.
// This is not a replacement for Claude Code's UI validation or hook dispatch.
import assert from 'node:assert/strict';
export const cases = [];
export function test(name, body) { cases.push({ name, body }); }
export function expect(actual) {
  const check = (negated = false) => {
    const verify = (okay, message) => assert.ok(negated ? !okay : okay, message);
    return {
      toBe: expected => verify(Object.is(actual, expected), `expected ${JSON.stringify(actual)} ${negated ? 'not ' : ''}to be ${JSON.stringify(expected)}`),
      toEqual: expected => negated ? assert.notDeepEqual(actual, expected) : assert.deepEqual(actual, expected),
      toContain: expected => verify(actual.includes(expected), `expected value ${negated ? 'not ' : ''}to contain ${expected}`),
      toMatch: expected => verify(expected.test(actual), `expected ${actual} ${negated ? 'not ' : ''}to match ${expected}`),
      toBeDefined: () => verify(actual !== undefined, 'expected defined value'),
      toBeUndefined: () => verify(actual === undefined, 'expected undefined value'),
      get not() { return check(!negated); },
    };
  };
  return check();
}
