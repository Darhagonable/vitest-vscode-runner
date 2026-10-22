/*
 * E2E driver for the VS Code extension-host runner.
 *
 * The outer suite never loads the plugin itself: the sample-extension
 * project is exercised exclusively through inner Vitest instances started
 * here with vitest/node's startVitest — the same pattern vitest's own test
 * suite uses. The inner instance's root is tests/sample-extension, so it
 * cannot see this file or the unit tests (no recursion, no shared files).
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVitest, type Vitest } from 'vitest/node';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sampleRoot = join(repoRoot, 'tests/sample-extension');
const sampleTestFile = join(sampleRoot, 'tests/vscode-api-pass.test.ts');

// Env-gated marker channel: the sample test appends a line per run only when
// this env var points at a file, so watch reruns can be counted without
// side effects in normal runs.
const markerEnv = 'VSCODE_RUNNER_WATCH_MARKER';

let ctx: Vitest | undefined;
let originalSource: string | undefined;
let markerFile: string | undefined;

afterEach(async () => {
  if (originalSource !== undefined) {
    await writeFile(sampleTestFile, originalSource);
    originalSource = undefined;
  }

  if (ctx) {
    await ctx.close();
    ctx = undefined;
  }

  if (markerFile) {
    await rm(markerFile, { force: true });
    delete process.env[markerEnv];
    markerFile = undefined;
  }
});

async function markerCount(): Promise<number> {
  if (!markerFile) {
    return 0;
  }

  try {
    const content = await readFile(markerFile, 'utf8');
    return content.trim() ? content.trim().split('\n').length : 0;
  } catch {
    return 0;
  }
}

async function waitForMarkers(minimum: number, timeoutMs: number, message: string) {
  const start = Date.now();

  while ((await markerCount()) < minimum) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out: ${message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/*
 * @vscode/test-electron prints one "Exit code:" line per VS Code instance
 * from this process via console.log. Counting them during a session counts
 * spawned extension hosts.
 */
function trackExitCodes() {
  const original = console.log;
  let count = 0;

  console.log = (...args: unknown[]) => {
    if (String(args[0]).startsWith('Exit code:')) {
      count++;
    }

    original(...args);
  };

  return {
    count: () => count,
    restore() {
      console.log = original;
    }
  };
}

describe('vscode worker', () => {
  it('runs the sample-extension suite through the plugin', { timeout: 180_000 }, async () => {
    ctx = await startVitest('test', [], { root: sampleRoot });

    const files = ctx.state.getFiles();

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.result?.state, `${file.name} should pass`).toBe('pass');
    }
  });

  it('reruns tests inside the extension host on file change', { timeout: 180_000 }, async () => {
    markerFile = join(tmpdir(), `vscode-runner-watch-${process.pid}-${Date.now()}.log`);
    process.env[markerEnv] = markerFile;

    ctx = await startVitest('test', [], { root: sampleRoot, watch: true });
    await waitForMarkers(1, 90_000, 'initial sample run never executed in the extension host.');

    originalSource = await readFile(sampleTestFile, 'utf8');
    // Content change, not just mtime: the watcher reliably schedules a rerun.
    await writeFile(sampleTestFile, originalSource + '\n// watch e2e: trigger rerun\n');

    await waitForMarkers(2, 60_000, 'watch rerun never executed in the extension host.');
  });

  it.fails('keeps exactly one warm VS Code host across a watch session', { timeout: 180_000 }, async () => {
    markerFile = join(tmpdir(), `vscode-runner-watch-${process.pid}-${Date.now()}.log`);
    process.env[markerEnv] = markerFile;

    // Track for the whole session: hosts spawned per test file exit early,
    // long before close().
    const exitCodes = trackExitCodes();
    const watch = await startVitest('test', [], { root: sampleRoot, watch: true });
    ctx = watch;
    await waitForMarkers(1, 90_000, 'initial sample run never executed in the extension host.');

    originalSource = await readFile(sampleTestFile, 'utf8');
    await writeFile(sampleTestFile, originalSource + '\n// watch e2e: trigger rerun\n');
    await waitForMarkers(2, 60_000, 'watch rerun never executed in the extension host.');

    await watch.close();
    ctx = undefined;
    exitCodes.restore();

    // One warm extension-host worker means exactly one VS Code instance for
    // the whole session. Passes once worker reuse is the effective default.
    expect(exitCodes.count()).toBe(1);
  });
});
