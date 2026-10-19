import { defineConfig } from 'vitest/config';
import { vscodeExtensionHost } from '../dist/index.js';

export default defineConfig({
  plugins: [
    vscodeExtensionHost({
      version: '1.121.0',
      debug: {
        port: 9230,
        break: true
      },
      startupTimeoutMs: 300_000
    })
  ],
  test: {
    include: ['test/suite/**/*.test.ts'],
    globals: true
  }
});
