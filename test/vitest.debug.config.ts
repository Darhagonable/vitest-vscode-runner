import { defineConfig } from 'vitest/config';
import { vscodeExtensionHost } from '../dist/index.js';

export default defineConfig({
  plugins: [
    vscodeExtensionHost({
      extensionDevelopmentPath: 'test/sample-extension',
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
