import { defineConfig } from 'tsdown';

export default defineConfig({
  // the extension-host bridge is loaded by @vscode/test-electron by path,
  // so bundlers can't discover it — it must be listed explicitly
  entry: ['src/index.ts', 'src/external-extension-host-runner.mts'],
  sourcemap: true,
  hash: false,
});
