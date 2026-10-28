import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Plugin, ViteUserConfig } from 'vitest/config';
import { downloadAndUnzipVSCode, type DownloadOptions, type TestOptions } from '@vscode/test-electron';
import type { DownloadPlatform, DownloadVersion } from '@vscode/test-electron/out/download.js';
import { createVSCodeExtensionHostPool } from './external-pool';

/** Matching {@link TestOptions} and {@link DownloadOptions}. */
export interface VSCodeExtensionHostPluginOptions {
  /**
   * The VS Code version to download. Valid versions are:
   * - `'stable'`
   * - `'insiders'`
   * - `'1.32.0'`, `'1.31.1'`, etc
   *
   * Defaults to `stable`, which is latest stable version.
   *
   * *If a local copy exists at `.vscode-test/vscode-<VERSION>`, skip download.*
   */
  version?: DownloadVersion;
  /**
   * The VS Code platform to download. If not specified, it defaults to the
   * current platform.
   *
   * Possible values are:
   * 	- `win32-x64-archive`
   * 	- `win32-arm64-archive`
   * 	- `darwin`
   * 	- `darwin-arm64`
   * 	- `linux-x64`
   * 	- `linux-arm64`
   * 	- `linux-armhf`
   */
  platform?: DownloadPlatform;
  /**
   * Path where the downloaded VS Code instance is stored.
   * Defaults to `.vscode-test` within the project root.
   */
  cachePath?: string;
  /**
   * The VS Code executable path used for testing.
   *
   * If not passed, will use `options.version` to download a copy of VS Code
   * for testing. If `version` is not specified either, will download and use
   * latest stable release.
   */
  vscodeExecutablePath?: string;
  /**
   * Whether VS Code should be launched using default settings and extensions
   * installed on this machine. If `false`, then separate directories will
   * be used inside the `.vscode-test` folder within the project.
   *
   * Defaults to `false`.
   */
  reuseMachineInstall?: boolean;
  /**
   * Absolute path to the extension root. Passed to `--extensionDevelopmentPath`.
   * Must include a `package.json` Extension Manifest.
   *
   * Defaults to the vitest project root.
   */
  extensionDevelopmentPath?: string | string[];
  /**
   * A list of launch arguments passed to VS Code executable, in addition to
   * `--extensionDevelopmentPath` and `--extensionTestsPath` which are provided
   * by `extensionDevelopmentPath` and the runner's bridge respectively.
   *
   * If the first argument is a path to a file/folder/workspace, the launched
   * VS Code instance will open it.
   *
   * See `code --help` for possible arguments.
   */
  launchArgs?: string[];
  /**
   * Number of milliseconds after which to time out if no data is received
   * from the remote when downloading VS Code. Note that this is an 'idle'
   * timeout and does not enforce the total time VS Code may take to download.
   */
  timeout?: number;
  /** Keep VS Code instances warm between test runs (watch mode). */
  reuseWorker?: boolean;
}

// Keep the shim id file-shaped rather than a Rollup virtual id. Vitest gives
// inlined modules CommonJS globals from their module URL; a normal-looking path
// keeps that path stable and debuggable across platforms.
const vscodeShimFileName = '.vitest-vscode-extension-host-vscode.cjs';
const vscodeShimSource = "module.exports = require('vscode');\n";

export function vscodeRunner(options: VSCodeExtensionHostPluginOptions): Plugin {
  let vscodeShimId: string | undefined;

  return {
    name: 'vitest-vscode-extension-host',
    config(config: ViteUserConfig) {
      if (config.test?.pool !== undefined) {
        throw new Error('[vitest-vscode-extension-host] test.pool is managed by vscodeRunner().');
      }

      config.test = { ...config.test, pool: createVSCodeExtensionHostPool(options) };
    },
    async configResolved(resolved) {
      const vscodeShimPath = path.join(resolvePath(resolved.root, options.cachePath ?? '.vscode-test'), vscodeShimFileName);
      ensureVSCodeShimFile(vscodeShimPath);
      vscodeShimId = normalizeModuleId(vscodeShimPath);

      if (options.vscodeExecutablePath) {
        return;
      }

      // Warm the download before any worker starts so a cold fetch cannot
      // race the bridge startup timeout.
      options.vscodeExecutablePath = await downloadVSCodeExecutable({
        ...options,
        cachePath: path.resolve(resolved.root, options.cachePath ?? '.vscode-test')
      });
    },
    resolveId(id: string) {
      if (id === 'vscode' && vscodeShimId !== undefined) {
        return vscodeShimId;
      }

      return undefined;
    },
    load(id: string) {
      if (normalizeModuleId(id) !== vscodeShimId) {
        return undefined;
      }

      /*
       * As of May 22, 2026, this runner is developed against VS Code 1.121.0
       * test downloads via @vscode/test-electron 2.5.2. In that extension-host
       * runtime, VS Code exposes its API as a virtual CommonJS module named
       * `vscode`; there is no real package on disk. The extension host knows
       * how to answer `require('vscode')`, while normal Node/Vite resolution
       * does not.
       *
       * Do not mark `vscode` as a Vitest external dependency here. In Vitest
       * 4.1.7, the relevant source is `VitestModuleEvaluator.convertIdToImportUrl()`
       * in:
       * https://github.com/vitest-dev/vitest/blob/v4.1.7/packages/vitest/src/runtime/moduleRunner/moduleEvaluator.ts
       *
       * That method has a Windows-specific branch equivalent to:
       *
       *   if (!isWindows || isBuiltin(id) || /^(?:node:|data:|http:|https:|file:)/.test(id)) return id;
       *   return pathToFileURL(id).toString();
       *
       * That conversion is correct for real Windows paths such as
       * `C:\...\package.js`, because native ESM imports need file URLs there.
       * It is harmful for this virtual module: bare `vscode` can become a file
       * URL, bypassing the extension-host CommonJS hook and making Node search
       * for a real `vscode` file or package.
       *
       * The shim file is also written to disk in the runner cache. VS Code's
       * CommonJS hook receives the parent module filename during
       * `require('vscode')`; a real parent path keeps that hook on the same
       * path as normal extension modules instead of a Vite-only virtual id.
       *
       * Mapping `vscode` to this package-owned shim keeps test imports natural:
       * `import * as vscode from 'vscode'` and named imports still work. Vitest
       * resolves only this real-looking module id, then the shim performs the
       * one lookup that must stay inside the extension host:
       * `require('vscode')`.
       */
      return vscodeShimSource;
    }
  };
}

export async function downloadVSCodeExecutable(
  options: Pick<VSCodeExtensionHostPluginOptions, 'cachePath' | 'version' | 'platform' | 'timeout'>,
): Promise<string> {
  return downloadAndUnzipVSCode({
    cachePath: options.cachePath,
    version: process.env.VSCODE_VERSION ?? options.version,
    platform: options.platform,
    timeout: options.timeout
  });
}

function resolvePath(root: string, value: string) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function ensureVSCodeShimFile(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, vscodeShimSource);
}

function normalizeModuleId(id: string) {
  return id.split('?')[0].replace(/\\/g, '/');
}
