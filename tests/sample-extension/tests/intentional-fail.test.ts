// This test genuinely fails on every run: it is the fixture through which
// the e2e driver (tests/vscode-worker.test.ts) verifies that an unexpected
// failure inside the extension host is reported as a failure by the pool.
// The expected-failure variant below keeps it.fails semantics covered too.
import { describe, expect, it } from 'vitest';

describe('intentional failure', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });

  it.fails('expected failure passes through', () => {
    expect(1).toBe(2);
  });
});
