import { createRequire } from 'node:module';
import * as net from 'node:net';
import { FramedIpc } from './framed-ipc.js';

export async function run(): Promise<void> {
  const port = Number(process.env.VITEST_RUNNER_IPC_PORT);
  const host = process.env.VITEST_RUNNER_IPC_HOST || '127.0.0.1';

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Missing VITEST_RUNNER_IPC_PORT for Vitest VS Code bridge.');
  }

  const socket = net.connect({ host, port });
  const ipc = new FramedIpc(socket);
  const stopped = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  await stopped;

  const { init, runBaseTests, setupEnvironment } = await import('vitest/worker');
  const stopPromise = new Promise<void>((resolve, reject) => {
    ipc.on('error', reject);
    ipc.on('close', resolve);

    init({
      on: callback => ipc.on('message', callback),
      off: callback => ipc.off('message', callback),
      post: data => {
        ipc.send(data);

        if (isStoppedResponse(data)) {
          queueMicrotask(() => {
            ipc.close();
            resolve();
          });
        }
      },
      deserialize: data => data,
      serialize: data => data,
      setup: setupEnvironment,
      runTests: (state, traces) => runBaseTests('run', state, traces),
      collectTests: (state, traces) => runBaseTests('collect', state, traces)
    });

    ipc.send({ __vscode_vitest_bridge_ready__: true });
  });

  await stopPromise;
  await closeVSCodeWindow();
}

function isStoppedResponse(data: unknown) {
  return typeof data === 'object'
    && data !== null
    && '__vitest_worker_response__' in data
    && (data as { type?: unknown }).type === 'stopped';
}

async function closeVSCodeWindow() {
  try {
    /*
     * Keep this on the same resolution path as test modules. As of May 22,
     * 2026, this runner is developed against VS Code 1.121.0 test downloads
     * via @vscode/test-electron 2.5.2, where the `vscode` API is a virtual
     * CommonJS module provided by the extension host, not a real package.
     *
     * In Vitest 4.1.7, a dynamic ESM import can be routed through the external
     * module evaluator. The relevant source is
     * `VitestModuleEvaluator.convertIdToImportUrl()` in:
     * https://github.com/vitest-dev/vitest/blob/v4.1.7/packages/vitest/src/runtime/moduleRunner/moduleEvaluator.ts
     *
     * On Windows, that method normalizes non-URL external ids as file:// URLs
     * for real path imports, which is not valid for the virtual `vscode`
     * module.
     */
    const vscode = createRequire(import.meta.url)('vscode') as typeof import('vscode');
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  } catch {
    // VS Code usually closes after the extension test runner resolves. This is
    // only a best-effort fallback for runs where the test window stays open.
  }
}
