/*
 * E2E driver for the VS Code extension-host runner.
 *
 * The outer suite never loads the plugin itself: the sample-extension
 * project is exercised exclusively through one nested Vitest instance in
 * watch mode (vitest/node's startVitest, the same pattern vitest's own
 * test suite uses). The nested root is tests/sample-extension, so it
 * cannot see this file or the unit tests. Run completion is observed via
 * the reporter's onTestRunEnd hook — no side channels.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVitest, type Reporter, type Vitest } from 'vitest/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sampleRoot = join(repoRoot, 'tests/sample-extension');
const sampleTestFile = join(sampleRoot, 'tests/vscode-api-pass.test.ts');

let ctx: Vitest | undefined;
let originalSource: string | undefined;
let notifyRun: () => void = () => {};
let runCount = 0;

// Silent except for run completion: each onTestRunEnd counts the run and
 // wakes whoever is waiting for it.
const reporter: Reporter = {
  onTestRunEnd() {
    runCount++;
    notifyRun();
    notifyRun = () => {};
  }
};

function waitForRuns(total: number, timeoutMs = 90_000) {
  if (runCount >= total) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for nested vitest run #${total}.`)), timeoutMs);
    timer.unref();
    notifyRun = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function assertSampleResults(label: string) {
  const files = ctx!.state.getFiles();
  const passFile = files.find(file => file.name.includes('vscode-api-pass'));
  const failFile = files.find(file => file.name.includes('intentional-fail'));

  expect(passFile, `${label}: passing sample file should have run`).toBeDefined();
  expect(failFile, `${label}: failing sample file should have run`).toBeDefined();
  expect(passFile?.result?.state, `${label}: success must propagate`).toBe('pass');
  expect(failFile?.result?.state, `${label}: unexpected failure must propagate`).toBe('fail');
}

beforeAll(async () => {
  console.log('▶ nested vitest: running sample-extension inside VS Code (watch mode)');
  ctx = await startVitest([], { root: sampleRoot, watch: true, reporters: [reporter] });
  await waitForRuns(1);
}, 120_000);

afterAll(async () => {
  if (originalSource !== undefined) {
    await writeFile(sampleTestFile, originalSource);
    originalSource = undefined;
  }

  await ctx?.close();
  ctx = undefined;
});

describe('vscode worker', () => {
  it('reports pass and fail results from the extension host', () => {
    assertSampleResults('initial run');
  });

  it('reruns tests inside the extension host on file change', { timeout: 120_000 }, async () => {
    originalSource = await readFile(sampleTestFile, 'utf8');
    // Content change, not just mtime: the watcher reliably schedules a rerun.
    await writeFile(sampleTestFile, originalSource + '\n// e2e: trigger rerun\n');
    await waitForRuns(2);

    assertSampleResults('rerun');
  });
});
