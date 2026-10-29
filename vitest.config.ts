import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/e2e/**/*.test.ts']
  }
});
