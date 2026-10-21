import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteUserConfig } from 'vitest/config';
import {
  createVSCodeExtensionHostPool,
  downloadVSCodeExecutable,
  type VSCodeDebugOptions, type VSCodePoolOptions

} from './external-pool.js';

export interface VSCodeExtensionHostPluginOptions {
  extensionTestsPath?: string;
  version?: string;
  cachePath?: string;
  vscodeExecutablePath?: string;
  launchArgs?: string[];
  debug?: boolean | VSCodeDebugOptions;
  reuseWorker?: boolean;
  startupTimeoutMs?: number;
}

// Keep the shim id file-shaped rather than a Rollup virtual id. Vitest gives
// inlined modules CommonJS globals from their module URL; a normal-looking path
// keeps that path stable and debuggable across platforms.
const vscodeShimFileName = '.vitest-vscode-extension-host-vscode.cjs';
const vscodeShimSource = "module.exports = require('vscode');\n";

export function vscodeExtensionHost(options: VSCodeExtensionHostPluginOptions): Plugin {
  let vscodeShimId: string | undefined;
  let poolOptions: VSCodePoolOptions | undefined;

  return {
    name: 'vitest-vscode-extension-host',
    config(config: ViteUserConfig) {
      const root = resolveRoot(config.root);
      const test = getOrCreateRecord(config as Record<string, unknown>, 'test');

      const vscodeShimPath = path.join(resolvePath(root, options.cachePath ?? '.vscode-test'), vscodeShimFileName);
      ensureVSCodeShimFile(vscodeShimPath);
      vscodeShimId = normalizeModuleId(vscodeShimPath);

      if (test.pool !== undefined) {
        throw new Error('[vitest-vscode-extension-host] test.pool is managed by vscodeExtensionHost().');
      }

      poolOptions = createPoolOptions(root, options);
      test.pool = createVSCodeExtensionHostPool(poolOptions);
    },
    async configResolved() {
      if (!poolOptions || poolOptions.vscodeExecutablePath) {
        return;
      }

      poolOptions.vscodeExecutablePath = await downloadVSCodeExecutable(poolOptions);
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

function createPoolOptions(root: string, options: VSCodeExtensionHostPluginOptions) {
  return {
    extensionDevelopmentPath: root,
    extensionTestsPath: resolvePath(root, options.extensionTestsPath ?? defaultExtensionTestsPath()),
    version: options.version,
    cachePath: resolveOptionalPath(root, options.cachePath ?? '.vscode-test'),
    vscodeExecutablePath: resolveOptionalPath(root, options.vscodeExecutablePath),
    launchArgs: options.launchArgs,
    debug: options.debug,
    reuseWorker: options.reuseWorker ?? true,
    startupTimeoutMs: options.startupTimeoutMs
  };
}

function defaultExtensionTestsPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'external-extension-host-runner.mjs');
}

function resolveRoot(root: string | undefined) {
  if (!root) {
    return process.cwd();
  }

  return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
}

function resolveOptionalPath(root: string, value: string | undefined) {
  return value ? resolvePath(root, value) : undefined;
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

function getOrCreateRecord(parent: Record<string, unknown>, key: string) {
  const current = parent[key];

  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }

  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}
