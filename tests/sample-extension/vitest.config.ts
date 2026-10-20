import { defineProject } from 'vitest/config';
import { vscodeExtensionHost } from '../../dist/index.js';

export default defineProject({
  plugins: [
    vscodeExtensionHost({
      version: 'stable'
    })
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true
  }
});
