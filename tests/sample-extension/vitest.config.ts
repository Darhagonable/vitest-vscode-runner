import { defineConfig } from 'vitest/config';
import { vscodeExtensionHost } from '../../dist/index.js';

export default defineConfig({
  plugins: [
    vscodeExtensionHost({
      version: 'stable',
      launchArgs: ['--log', 'off', '--disable-gpu'],
      reuseWorker: true
    })
  ],
  test: {
    include: ['tests/**/*.test.ts']
  }
});
