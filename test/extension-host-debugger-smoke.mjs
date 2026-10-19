#!/usr/bin/env node
// Internal smoke check: verifies the extension-host inspector can stop at a
// breakpoint in test/suite/vscode-api-pass.test.ts.
//
// Approximate reconstruction — the original script was never published. It is
// not part of the manual debugging flow documented in the README.
import { spawn } from 'node:child_process';

const testFile = process.argv[2] ?? 'test/suite/vscode-api-pass.test.ts';

const child = spawn(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config', 'test/vitest.debug.config.ts',
    '--testTimeout=0',
    '--hookTimeout=0',
    testFile
  ],
  { stdio: 'inherit', env: process.env }
);

child.on('exit', code => {
  process.exit(code ?? 1);
});
