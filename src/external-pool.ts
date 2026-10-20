import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  downloadAndUnzipVSCode,
  runTests,
  TestRunFailedError
} from '@vscode/test-electron';
import { FramedIpc } from './framed-ipc.js';

export interface VSCodeDebugOptions {
  port?: number;
  /**
   * Pause extension-host startup until a debugger attaches. Defaults to false.
   */
  break?: boolean;
}

export interface VSCodePoolOptions {
  extensionDevelopmentPath: string;
  extensionTestsPath: string;
  version?: string;
  cachePath?: string;
  vscodeExecutablePath?: string;
  launchArgs?: string[];
  debug?: boolean | VSCodeDebugOptions;
  startupTimeoutMs?: number;
}

interface PoolShape {
  readonly name: string;
  createPoolWorker(options: unknown): VSCodeExtensionHostWorker;
}

interface VSCodeRun {
  readonly finished: Promise<number>;
}

export function createVSCodeExtensionHostPool(options: VSCodePoolOptions): PoolShape {
  return {
    name: 'vscodeExtensionHost',
    createPoolWorker(poolOptions: unknown) {
      return new VSCodeExtensionHostWorker(withInspectorDefaults(options, poolOptions));
    }
  };
}

/*
 * Translate vitest's own --inspect / --inspect-brk flags into extension-host
 * inspector arguments, so `vitest --inspect-brk` debugs extension-host code
 * the same way it debugs any other pool. Explicit `debug` and
 * `startupTimeoutMs` options take precedence.
 */
function withInspectorDefaults(options: VSCodePoolOptions, poolOptions: unknown): VSCodePoolOptions {
  const inspector = readInspectorConfig(poolOptions);

  if (inspector?.enabled) {
    options.debug ??= {
      port: inspector.port ?? 9229,
      break: inspector.waitForDebugger === true
    };
  }

  if (inspector?.waitForDebugger) {
    options.startupTimeoutMs ??= 300_000;
  }

  return options;
}

function readInspectorConfig(poolOptions: unknown): { enabled?: boolean; port?: number; waitForDebugger?: boolean } | undefined {
  const project = (poolOptions as { project?: { config?: Record<string, unknown> } } | undefined)?.project;
  return project?.config?.inspector as { enabled?: boolean; port?: number; waitForDebugger?: boolean } | undefined;
}

class VSCodeExtensionHostWorker {
  readonly name = 'vscodeExtensionHost';

  private readonly events = new EventEmitter();
  private readonly pendingErrors: unknown[] = [];
  private server: net.Server | undefined;
  private ipc: FramedIpc | undefined;
  private run: VSCodeRun | undefined;
  private stopping = false;

  constructor(private readonly options: VSCodePoolOptions) {}

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

    this.run = await launchVSCodeTests({
      vscodeExecutablePath: this.options.vscodeExecutablePath,
      cachePath: this.options.cachePath,
      extensionDevelopmentPath: this.options.extensionDevelopmentPath,
      version: this.options.version,
      extensionTestsPath: this.options.extensionTestsPath,
      extensionTestsEnv: {
        VITEST_RUNNER_IPC_HOST: '127.0.0.1',
        VITEST_RUNNER_IPC_PORT: String(port)
      },
      launchArgs: createLaunchArgs(this.options)
    });
    let bridgeConnected = false;
    const connectedBeforeExit = connected.then(() => {
      bridgeConnected = true;
    });
    const exitedBeforeConnect = this.run.finished.then(
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
        this.options.startupTimeoutMs ?? 30_000,
        'Timed out waiting for the VS Code extension-host Vitest bridge to connect.'
      );
    } catch (error) {
      this.cleanupAfterFailedStart();
      throw error;
    }

    this.run.finished.catch(error => {
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
          this.run.finished,
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
  }

  canReuse(_task: unknown): boolean {
    return true;
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
      && path.basename(this.options.extensionTestsPath).startsWith('external-extension-host-runner');
  }

  private cleanupAfterFailedStart() {
    this.stopping = true;
    this.ipc?.destroy();
    this.server?.close();

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

interface VSCodeLaunchOptions extends VSCodePoolOptions {
  extensionTestsEnv?: Record<string, string>;
}

function createLaunchArgs(options: VSCodePoolOptions) {
  const args = options.launchArgs
    ? [...options.launchArgs]
    : ['--disable-extensions'];
  const debugArg = createDebugLaunchArg(options.debug);

  if (debugArg) {
    args.push(debugArg);
  }

  return args;
}

function createDebugLaunchArg(debug: boolean | VSCodeDebugOptions | undefined) {
  if (!debug) {
    return undefined;
  }

  const options = debug === true ? {} : debug;
  const port = options.port ?? 9229;
  const flag = options.break === true ? '--inspect-brk-extensions' : '--inspect-extensions';

  return `${flag}=${port}`;
}

async function launchVSCodeTests(options: VSCodeLaunchOptions) {
  const vscodeExecutablePath = options.vscodeExecutablePath ?? await downloadVSCodeExecutable(options);

  // VS Code's Vitest extension runs test processes under Electron-as-Node.
  // The spawned VS Code must start as Electron, not inherit that mode.
  // runTests() merges process.env, so sanitize the environment directly.
  delete process.env.ELECTRON_RUN_AS_NODE;

  return {
    finished: runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: options.extensionDevelopmentPath,
      extensionTestsPath: options.extensionTestsPath,
      extensionTestsEnv: options.extensionTestsEnv,
      launchArgs: createLaunchArgs(options),
      cachePath: options.cachePath
    })
  };
}

export async function downloadVSCodeExecutable(options: Pick<VSCodePoolOptions, 'cachePath' | 'version'>): Promise<string> {
  return downloadAndUnzipVSCode({
    cachePath: options.cachePath,
    version: process.env.VSCODE_VERSION ?? options.version
  });
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
