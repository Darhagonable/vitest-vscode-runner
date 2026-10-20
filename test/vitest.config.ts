import { defineConfig } from 'vitest/config';
import { vscodeExtensionHost } from '../dist/index.js';

export default defineConfig({
  plugins: [
    vscodeExtensionHost({
      version: 'stable'
    })
  ],
  test: {
    include: ['test/suite/**/*.test.ts'],
    globals: true
  }
});
