import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  downloadAndUnzipVSCode,
  TestRunFailedError
} from '@vscode/test-electron';
import { defaultCachePath } from '@vscode/test-electron/out/download.js';
import { killTree } from '@vscode/test-electron/out/util.js';
import { FramedIpc } from './framed-ipc.js';

export interface VSCodeDebugOptions {
  port?: number;
  /**
   * Pause extension-host startup until a debugger attaches. Defaults to false.
   */
  break?: boolean;
}

export interface VSCodePoolOptions {
  extensionDevelopmentPath: string | string[];
  extensionTestsPath: string;
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
  terminate(): Promise<void>;
}

export function createVSCodeExtensionHostPool(options: VSCodePoolOptions): PoolShape {
  return {
    name: 'vscodeExtensionHost',
    createPoolWorker() {
      return new VSCodeExtensionHostWorker(options);
    }
  };
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
      if (error instanceof Error && error.message.startsWith('Timed out waiting for VS Code to close')) {
        await this.run?.terminate();
      } else if (!this.isVSCodeTestRunFailure(error)) {
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

    if (this.run) {
      void this.run.terminate().catch(() => undefined);
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
  const executable = options.vscodeExecutablePath ?? await downloadVSCodeExecutable(options);
  const args = createVSCodeArgs(options);
  const shell = process.platform === 'win32';
  const child = spawn(shell ? `"${executable}"` : executable, args, {
    env: createVSCodeEnvironment(options.extensionTestsEnv),
    shell
  });

  child.stdout?.on('data', chunk => process.stdout.write(chunk));
  child.stderr?.on('data', chunk => process.stderr.write(chunk));

  const finished = waitForVSCode(child);

  return {
    finished,
    async terminate() {
      await terminateProcessTree(child, finished);
    }
  };
}

export async function downloadVSCodeExecutable(options: Pick<VSCodePoolOptions, 'cachePath' | 'extensionDevelopmentPath'>): Promise<string> {
  return downloadAndUnzipVSCode({
    cachePath: options.cachePath,
    extensionDevelopmentPath: options.extensionDevelopmentPath
  });
}

function createVSCodeEnvironment(extensionTestsEnv: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extensionTestsEnv
  };

  // VS Code's Vitest extension runs test processes under Electron-as-Node.
  // The downloaded VS Code executable must start as Electron, not inherit that mode.
  delete env.ELECTRON_RUN_AS_NODE;

  return env;
}

function createVSCodeArgs(options: VSCodeLaunchOptions) {
  let args = [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--extensionTestsPath=${options.extensionTestsPath}`
  ];

  const extensionDevelopmentPaths = Array.isArray(options.extensionDevelopmentPath)
    ? options.extensionDevelopmentPath
    : [options.extensionDevelopmentPath];

  args.push(...extensionDevelopmentPaths.map(item => `--extensionDevelopmentPath=${item}`));
  args = [
    ...(options.launchArgs ?? []),
    ...args
  ];
  args.push(...createProfileArguments(args, options.cachePath));

  return args;
}

function createProfileArguments(args: string[], cachePath: string | undefined) {
  const profilePath = cachePath ?? defaultCachePath;
  const out: string[] = [];

  if (!hasLaunchArg('extensions-dir', args)) {
    out.push(`--extensions-dir=${path.join(profilePath, 'extensions')}`);
  }

  if (!hasLaunchArg('user-data-dir', args)) {
    out.push(`--user-data-dir=${path.join(profilePath, 'user-data')}`);
  }

  return out;
}

function hasLaunchArg(name: string, args: string[]) {
  return args.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function waitForVSCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let finished = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) {
        return;
      }

      finished = true;
      console.log(`Exit code:   ${code ?? signal}`);
      child.stdout?.destroy();
      child.stderr?.destroy();

      if (code === 0) {
        resolve(0);
      } else {
        reject(new TestRunFailedError(code ?? undefined, signal ?? undefined));
      }
    };

    child.on('error', reject);
    child.on('close', finish);
    child.on('exit', finish);
  });
}

async function terminateProcessTree(child: ChildProcess, finished: Promise<number>) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGINT');

  try {
    await withTimeout(finished, 2_000, 'Timed out gracefully closing VS Code.');
    return;
  } catch {
    await killTree(child.pid, true);
  }

  await finished.catch(() => undefined);
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
