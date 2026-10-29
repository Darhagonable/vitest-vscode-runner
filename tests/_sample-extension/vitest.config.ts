import { defineConfig } from 'vitest/config';
import { vscodeRunner } from 'vitest-vscode-runner';

export default defineConfig({
  plugins: [
    vscodeRunner({
      version: 'stable',
      launchArgs: ['--log', 'off', '--disable-gpu'],
    })
  ],
  test: {
    include: ['tests/**/*.test.ts']
  }
});
