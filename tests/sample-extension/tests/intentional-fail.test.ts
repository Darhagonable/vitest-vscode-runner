import { describe, expect, it } from 'vitest';
// This test intentionally fails so file-level and test-level reporting can be
// inspected in Vitest and IDE integrations.
describe('intentional failure', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });
});
