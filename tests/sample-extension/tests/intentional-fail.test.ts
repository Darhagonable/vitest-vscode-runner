// This file genuinely fails on every run: it is the fixture through which
// the e2e suite (tests/vscode-worker.test.ts) verifies that assertion
// failures, thrown runtime errors, and it.fails semantics cross the
// extension-host bridge and are reported correctly by the outer Vitest.
import { describe, expect, it } from 'vitest';

describe('intentional failure', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });

  it('throws on purpose', () => {
    throw new Error('boom from the extension host');
  });

  it.fails('expected failure passes through', () => {
    expect(1).toBe(2);
  });
});
