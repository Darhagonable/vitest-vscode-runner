import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runTests,
  SilentReporter,
  TestRunFailedError
} from '@vscode/test-electron';
import { LineIpc } from './line-ipc.js';
import type { PoolOptions, PoolRunnerInitializer, PoolWorker } from 'vitest/node';
import type { VSCodeExtensionHostPluginOptions } from './plugin.js';

// The bundled bridge runner executed inside the VS Code extension host.
const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'external-extension-host-runner.mjs');

/*
 * Watch-mode reuse: vitest reveals a task's file paths only in 'run'/'collect'
 * messages — its 'start' message carries none and is acked before 'run' is
 * even sent. So the worker defers connecting: 'start' is buffered and acked
 * here, and the first run request adopts this file's parked VS Code instance
 * from the map below — or cold boots a new one. Instances are keyed by their
 * files, so a file always reruns in its own extension host, never in another
 * file's. Works with the default isolate: true.
 */

/** Subset of vitest's worker protocol messages this pool inspects. */
interface WorkerMessage {
  __vitest_worker_request__?: boolean;
  __vitest_worker_response__?: boolean;
  type?: string;
  context?: { files?: readonly { filepath: string }[] };
  error?: unknown;
}

interface WarmConnection {
  filesKey: string;
  server: net.Server;
  ipc: LineIpc;
  run: Promise<number>;
  profilePath: string;
}

/*
 * Live VS Code instances parked by file key, outliving PoolWorker lifecycles.
 * shutdownWarmConnections() — called from the plugin's closeServer hook — is
 * the cleanup; destroying the IPC is the exit signal for the instance.
 */
const warmConnections = new Map<string, WarmConnection>();

export async function shutdownWarmConnections(): Promise<void> {
  const connections = [...warmConnections.values()];
  warmConnections.clear();

  await Promise.all(connections.map(async conn => {
    conn.ipc.destroy();
    conn.server.close();

    try {
      await conn.run; // let VS Code exit before removing its profile
    } catch { /* an exit failure must not block cleanup */ }

    rmSync(conn.profilePath, { recursive: true, force: true });
  }));
}

function filesKey(files: readonly { filepath: string }[]): string {
  return files.map(f => f.filepath).sort().join(',');
}

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
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private fileKey = '';
  private connecting: Promise<void> | undefined;
  private pending: unknown[] = [];
  // Set only while connect() awaits the bridge's 'started' ack to pace the
  // buffered flush; resolved from the message handler in wireIpcEvents().
  private resolveBridgeStarted?: () => void;
  private rejectBridgeStarted?: (reason?: unknown) => void;

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
    const msg = message as WorkerMessage;

    if (msg?.__vitest_worker_request__ === true) {
      // 'start' carries no files — buffer it and acknowledge immediately, so
      // vitest sends the run request that reveals which instance to use.
      if (msg.type === 'start') {
        this.pending.push(message);
        this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
        return;
      }

      if ((msg.type === 'run' || msg.type === 'collect') && Array.isArray(msg.context?.files)) {
        this.fileKey = filesKey(msg.context.files);

        if (!this.ipc && !this.connecting) {
          this.connecting = this.connect();
        }
      }

      // Acknowledge a stop that never had a bridge to reach it.
      if (msg.type === 'stop' && !this.ipc && !this.connecting) {
        this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
        return;
      }
    }

    if (this.ipc) {
      this.ipc.send(message);
    } else {
      this.pending.push(message);
    }
  }

  deserialize(data: unknown): unknown {
    return data;
  }

  async start(): Promise<void> {
    // No-op: which VS Code instance to use is only known once the first run
    // request arrives (see send()). Everything below happens lazily.
  }

  private async coldBoot(): Promise<void> {
    if (this.ipc) {
      return;
    }

    const { server, port, connected } = await this.createServer();
    this.server = server;

    // Anchor the download cache at the project root so nothing leaks outside
    // the package in monorepos. Per-worker profiles live in the OS temp dir:
    // short (unix socket path limits) and cleaned up on stop.
    const root = this.poolOptions.project.config.root;
    const cachePath = path.resolve(root, this.options.cachePath ?? '.vscode-test');
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);

    // Per-worker user-data and extensions dirs go in first: concurrent VS Code
    // instances never share state and nothing lands at the CWD default. User
    // launchArgs append last so they win by ordering.
    const launchArgs: string[] = [
      `--extensions-dir=${path.join(this.profilePath, 'extensions')}`,
      `--user-data-dir=${path.join(this.profilePath, 'user-data')}`
    ];

    const debugArg = this.createDebugLaunchArg();
    if (debugArg) {
      launchArgs.push(debugArg);
    }

    launchArgs.push(...(this.options.launchArgs ?? ['--disable-extensions']));

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
      await this.cleanupAfterFailedStart();
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

    if (this.connecting) {
      await this.connecting;
    }

    // Park the connection for the next run of these files — VS Code stays
    // alive. Vitest does not await runner teardown before scheduling the
    // next task, so same-file workers can overlap: only the first parks.
    if (this.options.reuseWorker !== false && this.ipc && this.server && this.run
      && this.profilePath && this.fileKey && !warmConnections.has(this.fileKey)) {
      this.server.unref();
      this.ipc.unref();

      warmConnections.set(this.fileKey, {
        filesKey: this.fileKey,
        server: this.server,
        ipc: this.ipc,
        run: this.run,
        profilePath: this.profilePath
      });

      this.ipc = undefined;
      this.server = undefined;
      this.run = undefined;
      this.profilePath = undefined;
      this.fileKey = '';
      this.stopping = false;
      return;
    }

    this.ipc?.close();
    this.server?.close();

    try {
      if (this.run) {
        // No timeout: vitest's own teardownTimeout bounds the whole pool.
        await this.run;
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

      if (this.profilePath) {
        await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
        this.profilePath = undefined;
      }
    }
  }

  canReuse(): boolean {
    // Always false: reuse is routed by file key through warmConnections, so
    // vitest never sends another file's run request over this connection.
    return false;
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
    const server = net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', error => reject(new Error('Could not start the local TCP server for the VS Code Vitest worker.', { cause: error })));
      server.listen(0, '127.0.0.1');
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Could not allocate TCP port for VS Code Vitest worker.');
    }

    let resolveConnected: () => void = () => {};
    let rejectConnected: (reason?: any) => void = () => {};
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });

    server.on('error', rejectConnected);

    server.on('connection', socket => {
      this.ipc = new LineIpc(socket);
      this.wireIpcEvents(resolveConnected, rejectConnected);
    });

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

  private async connect(): Promise<void> {
    try {
      const parked = this.options.reuseWorker === false ? undefined : warmConnections.get(this.fileKey);

      if (parked && !parked.ipc.closed) {
        warmConnections.delete(this.fileKey);
        this.adopt(parked);
      } else {
        if (parked) {
          // The parked instance died — release it before rebooting.
          warmConnections.delete(this.fileKey);
          parked.server.close();
          parked.ipc.destroy();
          rmSync(parked.profilePath, { recursive: true, force: true });
        }

        await this.coldBoot();
      }

      // Restore vitest's natural request/response pacing: the bridge runtime
      // handles 'start' asynchronously and only accepts 'run' once finished,
      // so the buffered batch is flushed around its ack.
      const pending = this.pending;
      this.pending = [];

      const startIdx = pending.findIndex(
        m => (m as WorkerMessage)?.__vitest_worker_request__ === true && (m as WorkerMessage).type === 'start'
      );

      if (startIdx === -1) {
        for (const message of pending) {
          this.ipc!.send(message);
        }
      } else {
        const { promise: bridgeStarted, resolve, reject } = Promise.withResolvers<void>();
        this.resolveBridgeStarted = resolve;
        this.rejectBridgeStarted = reject;

        for (let i = 0; i <= startIdx; i++) {
          this.ipc!.send(pending[i]);
        }

        try {
          await bridgeStarted;
        } finally {
          this.resolveBridgeStarted = undefined;
          this.rejectBridgeStarted = undefined;
        }

        for (let i = startIdx + 1; i < pending.length; i++) {
          this.ipc!.send(pending[i]);
        }
      }
    } catch (error) {
      this.pending = [];
      this.emitError(error);
    } finally {
      this.connecting = undefined;
    }
  }

  private adopt(parked: WarmConnection): void {
    this.server = parked.server;
    this.ipc = parked.ipc;
    this.run = parked.run;
    this.profilePath = parked.profilePath;
    this.fileKey = parked.filesKey;

    try { parked.server.ref(); } catch { /* already closed */ }
    this.ipc.ref();

    this.ipc.removeAllListeners();
    this.wireIpcEvents();
  }

  /*
   * Wire IPC events to this worker. Called on cold-start (from createServer)
   * and on warm-adopt (from adopt); the connected callbacks are only used on
   * cold-start — an adopted connection is already ready.
   */
  private wireIpcEvents(
    resolveConnected?: () => void,
    rejectConnected?: (reason?: any) => void
  ): void {
    let bridgeReady = resolveConnected === undefined;

    this.ipc!.on('message', message => {
      if (isBridgeReadyMessage(message)) {
        if (!bridgeReady) {
          bridgeReady = true;
          resolveConnected?.();
        }
        return;
      }

      // The bridge acks 'start' after our synthetic ack already unblocked
      // vitest, so the duplicate flows on harmlessly; it gates the paced
      // flush in connect(). A failing ack is escalated as a worker error.
      const msg = message as WorkerMessage;

      if (this.resolveBridgeStarted && msg?.__vitest_worker_response__ === true && msg.type === 'started') {
        if (msg.error !== undefined) {
          this.rejectBridgeStarted?.(msg.error);
          this.emitError(msg.error);
        } else {
          this.resolveBridgeStarted();
        }
      }

      this.events.emit('message', message);
    });
    this.ipc!.on('error', error => {
      if (bridgeReady) {
        this.emitError(error);
      } else {
        rejectConnected?.(error);
      }
    });
    this.ipc!.on('close', () => {
      if (!bridgeReady) {
        rejectConnected?.(new Error('VS Code extension-host Vitest bridge disconnected before it became ready.'));
        return;
      }

      // Unblock the paced flush if the bridge dies mid-acknowledgment.
      this.rejectBridgeStarted?.(new Error('The VS Code extension-host bridge disconnected before acknowledging start.'));

      if (!this.stopping) {
        this.events.emit('exit');
      }
    });
  }

  private async cleanupAfterFailedStart() {
    this.stopping = true;
    this.ipc?.destroy();
    this.server?.close();

    if (this.profilePath) {
      await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
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
