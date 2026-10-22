/*
 * E2E driver for the VS Code extension-host runner.
 *
 * The outer suite never loads the plugin itself: the sample-extension
 * project is exercised exclusively through one inner Vitest instance in
 * watch mode (vitest/node's startVitest, the same pattern vitest's own
 * test suite uses). The inner instance's root is tests/sample-extension,
 * so it cannot see this file or the unit tests (no recursion, no shared
 * files). Every test below is an observation of that single session:
 * result reporting, console forwarding, watch reruns, and host reuse.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVitest, type Reporter, type Vitest } from 'vitest/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sampleRoot = join(repoRoot, 'tests/sample-extension');
const sampleTestFile = join(sampleRoot, 'tests/vscode-api-pass.test.ts');

// Env-gated marker channel: the sample test appends a line per run only when
// this env var points at a file, so watch reruns can be counted without
// side effects in normal runs.
const markerEnv = 'VSCODE_RUNNER_WATCH_MARKER';
const consoleEnv = 'VSCODE_RUNNER_CONSOLE_E2E';

// No-op reporter: every hook is optional, so the inner session prints
// nothing — except user console logs, which are captured (not printed) for
// the forwarding assertion. All other assertions read ctx.state, the marker
// file, or the exit-code tracker instead of printed output.
function createSilentReporter(logs: string[]): Reporter {
  return {
    onUserConsoleLog(log) {
      logs.push(log.content);
    }
  };
}

/*
 * @vscode/test-electron prints one "Exit code:" line per VS Code instance
 * from this process via console.log. Counting them across the session
 * counts spawned extension hosts; counted lines are swallowed so the outer
 * reporter does not re-print them.
 */
function trackExitCodes() {
  const original = console.log;
  let count = 0;

  console.log = (...args: unknown[]) => {
    if (String(args[0]).startsWith('Exit code:')) {
      count++;
      return;
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

let ctx: Vitest | undefined;
let originalSource: string | undefined;
let markerFile: string | undefined;
let exitCodes: ReturnType<typeof trackExitCodes> | undefined;
let consoleLogs: string[] = [];
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

beforeAll(async () => {
  markerFile = join(tmpdir(), `vscode-runner-watch-${process.pid}-${Date.now()}.log`);
  process.env[markerEnv] = markerFile;
  process.env[consoleEnv] = `vscode-runner-console-${process.pid}-${Date.now()}`;

  exitCodes = trackExitCodes();
  consoleLogs = [];

  ctx = await startVitest(
    [],
    { root: sampleRoot, watch: true, reporters: [createSilentReporter(consoleLogs)] }
  );

  await waitForMarkers(1, 90_000, 'initial sample run never executed in the extension host.');
}, 120_000);

afterAll(async () => {
  if (originalSource !== undefined) {
    await writeFile(sampleTestFile, originalSource);
    originalSource = undefined;
  }

  if (ctx) {
    await ctx.close();
    ctx = undefined;
  }

  exitCodes?.restore();

  if (markerFile) {
    await rm(markerFile, { force: true });
    delete process.env[markerEnv];
    markerFile = undefined;
  }

  delete process.env[consoleEnv];
});

describe('vscode worker', () => {
  it('reports pass and fail results from the extension host', () => {
    const files = ctx!.state.getFiles();
    const passFile = files.find(file => file.name.includes('vscode-api-pass'));
    const failFile = files.find(file => file.name.includes('intentional-fail'));

    expect(passFile, 'passing sample file should have run').toBeDefined();
    expect(failFile, 'failing sample file should have run').toBeDefined();
    expect(passFile?.result?.state, 'success must propagate to the outer vitest').toBe('pass');
    expect(failFile?.result?.state, 'unexpected failure must propagate to the outer vitest').toBe('fail');
  });

  it('forwards console output from the extension host', () => {
    const token = process.env[consoleEnv]!;
    expect(consoleLogs.some(log => log.includes(token)), 'console.log inside the host must reach vitest').toBe(true);
  });

  it('reruns tests inside the extension host on file change', { timeout: 120_000 }, async () => {
    originalSource = await readFile(sampleTestFile, 'utf8');
    // Content change, not just mtime: the watcher reliably schedules a rerun.
    await writeFile(sampleTestFile, originalSource + '\n// watch e2e: trigger rerun\n');

    await waitForMarkers(2, 60_000, 'watch rerun never executed in the extension host.');
  });

  it.fails('keeps exactly one warm VS Code host across the session', () => {
    // Counted before close: with today's per-file workers, hosts exit during
    // the runs. One warm extension-host worker means exactly one VS Code
    // instance for the whole session. Passes once worker reuse is the
    // effective default.
    expect(exitCodes!.count()).toBe(1);
  });
});
