import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runTests,
  SilentReporter,
  TestRunFailedError
} from '@vscode/test-electron';
import { FramedIpc } from './framed-ipc.js';
import type { PoolOptions, PoolRunnerInitializer, PoolWorker } from 'vitest/node';
import type { VSCodeExtensionHostPluginOptions } from './plugin.js';

// The bundled bridge runner executed inside the VS Code extension host.
const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'external-extension-host-runner.mjs');

export function createVSCodeExtensionHostPool(options: VSCodeExtensionHostPluginOptions): PoolRunnerInitializer {
  return {
    name: 'vscodeExtensionHost',
    createPoolWorker: (poolOptions: PoolOptions) => new VSCodeExtensionHostWorker(poolOptions, options)
  };
}

class VSCodeExtensionHostWorker implements PoolWorker {
  readonly name = 'vscodeExtensionHost';

  private readonly events = new EventEmitter();
  private readonly pendingErrors: unknown[] = [];
  private server: net.Server | undefined;
  private ipc: FramedIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeExtensionHostPluginOptions
  ) {}

  on(event: string, callback: (arg: unknown) => void): void {
    this.events.on(event, callback);

    if (event === 'error') {
      this.flushPendingErrors();
    }
  }

  off(event: string, callback: (arg: unknown) => void): void {
    this.events.off(event, callback);
  }

  send(message: unknown): void {
    if (!this.ipc) {
      this.emitError(new Error('VS Code extension-host worker is not connected.'));
      return;
    }

    this.ipc.send(message);
  }

  deserialize(data: unknown): unknown {
    return data;
  }

  async start(): Promise<void> {
    if (this.ipc) {
      return;
    }

    const { server, port, connected } = await this.createServer();
    this.server = server;

    // Anchor the cache at the project root so nothing leaks outside the
    // package in monorepos.
    const root = this.poolOptions.project.config.root;
    const cachePath = path.resolve(root, this.options.cachePath ?? '.vscode-test');
    this.profilePath = path.join(cachePath, `profile-${randomUUID().slice(0, 8)}`);

    const launchArgs = this.options.launchArgs
      ? [...this.options.launchArgs]
      : ['--disable-extensions'];

    const debugArg = this.createDebugLaunchArg();
    if (debugArg) {
      launchArgs.push(debugArg);
    }

    // Use a per-worker profile directory under the cache folder so concurrent
    // VS Code instances don't share state; test-electron skips its cwd-based
    // defaults when these args are present.
    if (!hasLaunchArg('extensions-dir', launchArgs)) {
      launchArgs.push(`--extensions-dir=${path.join(this.profilePath, 'extensions')}`);
    }

    if (!hasLaunchArg('user-data-dir', launchArgs)) {
      launchArgs.push(`--user-data-dir=${path.join(this.profilePath, 'user-data')}`);
    }

    // VS Code's Vitest extension runs test processes under Electron-as-Node.
    // The spawned VS Code must start as Electron, not inherit that mode.
    // runTests() merges process.env, so sanitize the environment directly.
    delete process.env.ELECTRON_RUN_AS_NODE;

    this.run = runTests({
      vscodeExecutablePath: this.options.vscodeExecutablePath,
      version: process.env.VSCODE_VERSION ?? this.options.version,
      cachePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: runnerPath,
      extensionTestsEnv: {
        VITEST_RUNNER_IPC_HOST: '127.0.0.1',
        VITEST_RUNNER_IPC_PORT: String(port)
      },
      launchArgs,
      reporter: new SilentReporter()
    });
    let bridgeConnected = false;
    const connectedBeforeExit = connected.then(() => {
      bridgeConnected = true;
    });
    const exitedBeforeConnect = this.run.then(
      () => {
        if (!bridgeConnected) {
          throw new Error('VS Code exited before the extension-host Vitest bridge connected.');
        }
      },
      error => {
        if (!bridgeConnected) {
          throw error;
        }
      }
    );

    try {
      await withTimeout(
        Promise.race([
          connectedBeforeExit,
          exitedBeforeConnect
        ]),
        this.options.startupTimeoutMs
          ?? (this.poolOptions.project.config.inspector.waitForDebugger ? 300_000 : 30_000),
        'Timed out waiting for the VS Code extension-host Vitest bridge to connect.'
      );
    } catch (error) {
      this.cleanupAfterFailedStart();
      throw error;
    }

    this.run.catch(error => {
      if (!this.stopping) {
        this.emitError(error);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ipc?.close();
    this.server?.close();

    try {
      if (this.run) {
        await withTimeout(
          this.run,
          5_000,
          'Timed out waiting for VS Code to close after the Vitest worker stopped.'
        );
      }
    } catch (error) {
      if (!this.isVSCodeTestRunFailure(error)) {
        throw error;
      }
    } finally {
      this.ipc = undefined;
      this.server = undefined;
      this.run = undefined;
      this.stopping = false;
    }

    if (this.profilePath) {
      await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
      this.profilePath = undefined;
    }
  }

  canReuse(): boolean {
    return this.options.reuseWorker !== false;
  }

  private createDebugLaunchArg(): string | undefined {
    const { enabled, port = 9229, waitForDebugger } = this.poolOptions.project.config.inspector;
    if (!enabled) {
      return undefined;
    }

    return waitForDebugger
      ? `--inspect-brk-extensions=${port}`
      : `--inspect-extensions=${port}`;
  }

  private async createServer() {




    let resolveConnected: () => void = () => {};
    let rejectConnected: (reason?: any) => void = () => {};
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });

    const server = net.createServer(socket => {
      let bridgeReady = false;
      this.ipc = new FramedIpc(socket);
      this.ipc.on('message', message => {
        if (isBridgeReadyMessage(message)) {
          bridgeReady = true;
          resolveConnected();
          return;
        }

        this.events.emit('message', message);
      });
      this.ipc.on('error', error => {
        if (bridgeReady) {
          this.emitError(error);
        } else {
          rejectConnected(error);
        }
      });
      this.ipc.on('close', () => {
        if (!bridgeReady) {
          rejectConnected(new Error('VS Code extension-host Vitest bridge disconnected before it became ready.'));
          return;
        }

        if (!this.stopping) {
          this.events.emit('exit');
        }
      });
    });

    server.on('error', rejectConnected);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Could not allocate TCP port for VS Code Vitest worker.');
    }

    return {
      server,
      port: address.port,
      connected
    };
  }

  private isVSCodeTestRunFailure(error: unknown) {
    return error instanceof TestRunFailedError
      && path.basename(runnerPath).startsWith('external-extension-host-runner');
  }

  private cleanupAfterFailedStart() {
    this.stopping = true;
    this.ipc?.destroy();
    this.server?.close();

    if (this.profilePath) {
      void rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
      this.profilePath = undefined;
    }

    this.ipc = undefined;
    this.server = undefined;
    this.run = undefined;
    this.stopping = false;
  }

  private emitError(error: unknown): void {
    if (this.events.listenerCount('error') === 0) {
      this.pendingErrors.push(error);
      return;
    }

    this.events.emit('error', error);
  }

  private flushPendingErrors(): void {
    while (this.pendingErrors.length > 0 && this.events.listenerCount('error') > 0) {
      this.events.emit('error', this.pendingErrors.shift());
    }
  }
}

function isBridgeReadyMessage(message: unknown) {
  return typeof message === 'object'
    && message !== null
    && (message as { __vscode_vitest_bridge_ready__?: boolean }).__vscode_vitest_bridge_ready__ === true;
}

function hasLaunchArg(name: string, args: string[]) {
  return args.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<void> ((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref();
  });

  return Promise.race([
    promise,
    timeoutPromise
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}
