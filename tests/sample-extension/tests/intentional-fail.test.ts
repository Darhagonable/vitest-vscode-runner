// This test intentionally fails so the failure path through the extension
// host bridge is exercised on every run. it.fails passes when vitest sees
// the failure — if the bridge ever swallowed it, this test would fail.
import { describe, expect, it } from 'vitest';

describe('intentional failure', () => {
  it.fails('fails on purpose', () => {
    expect(1).toBe(2);
  });
});
