import { init, runBaseTests, setupEnvironment } from 'vitest/worker';
import * as net from 'node:net';
import { LineIpc } from './utils/ipc';

export async function run(): Promise<void> {
  const port = Number(process.env.VITEST_RUNNER_IPC_PORT);
  const host = process.env.VITEST_RUNNER_IPC_HOST || '127.0.0.1';

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Missing VITEST_RUNNER_IPC_PORT for Vitest VS Code bridge.');
  }

  const socket = net.connect({ host, port });
  const ipc = new LineIpc(socket);
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  await connected;

  const stopPromise = new Promise<void>((resolve, reject) => {
    ipc.on('error', reject);
    ipc.on('close', resolve);

    init({
      on: callback => ipc.on('message', callback),
      off: callback => ipc.off('message', callback),
      post: data => {
        ipc.send(data);
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
}

