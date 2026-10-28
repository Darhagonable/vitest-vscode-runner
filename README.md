**THIS IS A PROTOTYPE. USE AT YOUR OWN RISK. NO SUPPORT SHOULD BE EXPECTED**

# vitest-vscode-runner

Experimental Vitest plugin for running VS Code extension tests inside a real VS Code Extension Development Host.

Inspired by [@gitbybit/vscode-extension-test-vitest-runner](https://www.npmjs.com/package/@gitbybit/vscode-extension-test-vitest-runner).

## Why This Exists

VS Code extension tests that import `vscode` need to execute inside the VS Code extension host. Normal Vitest workers run in regular Node processes, so `import * as vscode from 'vscode'` cannot be resolved there.

This package provides a Vitest plugin backed by a custom pool. The pool launches VS Code with `@vscode/test-electron`, connects the external Vitest process to a small bridge running inside the extension host, and runs the test files there.

```text
Vitest CLI / IDE
  -> custom Vitest pool
     -> @vscode/test-electron
        -> VS Code Extension Development Host
           -> Vitest worker bridge
              -> test files import "vscode"
```

## Usage

```ts
import { defineConfig } from 'vitest/config';
import { vscodeRunner } from 'vitest-vscode-runner';

export default defineConfig({
  plugins: [
    vscodeRunner({
      version: '1.121.0'
    })
  ],
  test: {
    include: ['test/**/*.test.ts'],
    globals: true
  }
});
```

The plugin sets Vitest to a single in-process VS Code extension-host worker, resolves the virtual `vscode` module through an extension-host CommonJS shim, and points Vitest at the internal extension-host bridge.

The plugin resolves the VS Code test executable during Vitest's config startup via `@vscode/test-electron`, before the custom pool starts running test files. If the matching VS Code test build is not already cached, the first run downloads it into `cachePath` (`.vscode-test` by default); later runs reuse that cache. This keeps download time out of individual test timeouts while avoiding package-manager install hooks.

If VS Code is provisioned separately, pass its executable path to skip `@vscode/test-electron` downloads:

```ts
vscodeRunner({
  vscodeExecutablePath: '/path/to/Code'
});
```

This runner is developed against VS Code 1.121.0 test downloads through `@vscode/test-electron` 3.1.0, with `vitest` 5.0.5. In that VS Code extension-host runtime, the `vscode` module is not a package on disk. VS Code provides it as a virtual CommonJS module to extension code. The runner keeps test imports natural (`import * as vscode from 'vscode'`) but maps that specifier to an internal shim that calls `require('vscode')` inside the extension host.

This avoids a subtle platform trap in Vitest's external-module path. The relevant source is [`VitestModuleEvaluator.convertIdToImportUrl()`](https://github.com/vitest-dev/vitest/blob/v5.0.0/packages/vitest/src/runtime/moduleRunner/moduleEvaluator.ts) in `packages/vitest/src/runtime/moduleRunner/moduleEvaluator.ts`. On Windows, that method converts non-URL external ids to `file://` URLs so native ESM can import real Windows paths. That conversion is correct for paths, but not for the virtual `vscode` module. If bare `vscode` is externalized, it can be treated like a path and Node will search for a real file/package instead of letting the extension host provide the API.

Useful options:

```ts
vscodeRunner({
  extensionDevelopmentPath: 'path/to/extension', // defaults to the project root
  launchArgs: ['--disable-extensions'],
  platform: 'linux-x64',
  timeout: 60_000
});
```

Pin the VS Code build with `version` (`'stable'`, `'insiders'`, or an exact version like `'1.121.0'`). The `VSCODE_VERSION` environment variable overrides it when set, so CI matrices can vary the build without changing committed config. `platform` and `timeout` are forwarded to the `@vscode/test-electron` download.

## Debugging

Tests run inside the spawned VS Code extension host. IDE debuggers must attach to that extension host, not to the outer npm or Vitest process.

Do not use an IDE's normal Vitest debug action for breakpoints in these tests. That debugs the outer Vitest process; test code that imports `vscode` runs in the spawned extension host.

### Using vitest's inspector flags

Run with `--inspect` or `--inspect-brk` exactly as you would for any vitest project:

```sh
vitest --inspect-brk
```

The plugin translates vitest's inspector settings into `--inspect-brk-extensions=9229` on the VS Code process, pausing the extension host at startup until a debugger attaches. The bridge connect timeout is automatically raised to 5 minutes under `--inspect-brk` so it has time to connect after you attach. Use a custom port with `--inspect-port=9230`.

### Repo Debug Script

This repo includes a manual debugging script:

```sh
pnpm run debug:extension-host
```

It runs the suite with `vitest --inspect-brk`: the plugin translates vitest's inspector flag into `--inspect-brk-extensions=9229`, pausing the extension host at startup until a debugger attaches, with the bridge connect timeout raised to 5 minutes.

```ts
vitest --run --inspect-brk --no-file-parallelism
```

### VS Code

This repo includes `.vscode/launch.json` with:

```json
{
  "name": "Attach Vitest VS Code Extension Host",
  "type": "extensionHost",
  "request": "attach",
  "port": 9229,
  "sourceMaps": true
}
```

To debug a test:

1. Set a breakpoint in `tests/sample-extension/tests/*.test.ts` or `tests/sample-extension/src/extension.ts`.
2. Start the debuggable run:

   ```sh
   pnpm run debug:extension-host tests/sample-extension/tests/vscode-api-pass.test.ts
   ```

3. Wait for:

   ```text
   Started local extension host with pid ...
   ```

4. Run the `Attach Vitest VS Code Extension Host` debug configuration.

### JetBrains IDEs

For PHPStorm, WebStorm, or IntelliJ IDEA, create this run configuration once:

```text
Type: Attach to Node.js/Chrome
Host: 127.0.0.1
Port: 9229
```

To debug a test:

1. Set a breakpoint in `tests/sample-extension/tests/*.test.ts` or `tests/sample-extension/src/extension.ts`.
2. Start the debuggable run:

   ```sh
   pnpm run debug:extension-host tests/sample-extension/tests/vscode-api-pass.test.ts
   ```

3. Wait for:

   ```text
   Started local extension host with pid ...
   ```

4. Run the `Attach to Node.js/Chrome` configuration.

Only one extension-host debug run can use `127.0.0.1:9229` and the test VS Code profile at a time. Stop the current debug run before starting another one.

## Repository Layout

```text
src/
  plugin.ts                         public Vitest plugin/helper
  external-pool.ts                  custom Vitest pool that launches VS Code
  external-extension-host-runner.mts bridge loaded by VS Code
  framed-ipc.ts                     small framed TCP protocol

tests/
  vscode-worker.test.ts             e2e suite: boots a single nested Vitest
                                    instance (watch mode) on the sample project
  unit/                             transport unit tests
  sample-extension/                 fixture VS Code extension: the dev-extension
                                    host, exercised only by the nested instance
    tests/                          sample Vitest tests
    vitest.config.ts                consumer config using the plugin

vitest.config.ts                    outer suite (e2e + unit tests); the plugin
                                    itself is only loaded by the nested instance
```

## Test Coverage

`pnpm test` boots a single nested Vitest instance (watch mode) against
`tests/sample-extension` — the same plugin setup a consumer would have —
and verifies end to end that:

- The VS Code instance is found in, or downloaded into,
  `tests/sample-extension/.vscode-test` only; no `.vscode-test`
  is created at the repo root.
- Tests run inside/through the VS Code extension host.
- Tests can access the `vscode` APIs.
- The extension can be activated directly from source.
- Tests can register and execute VS Code commands.
- Vitest correctly reports a test inside the VS Code instance as passed.
- Vitest correctly reports a test inside the VS Code instance as failed
  (assertion errors and thrown runtime errors propagate).
- Vitest correctly reports a test inside the VS Code instance as
  expectedly failed (`it.fails` passes).
- The plugin correctly forwards `console.log` output from inside the
  VS Code instance to Vitest.
- Watch mode works: changing a test file reruns it inside the same
  VS Code instance.

Unit tests for the IPC transport live in `tests/unit/`.

## Scripts

The repo keeps only public workflow scripts in `package.json`:

```sh
pnpm run build                    # build the plugin and sample extension
pnpm run typecheck                # typecheck all TypeScript projects
pnpm run debug:extension-host     # build, then start a debuggable extension-host run
pnpm test              # build, then run the Vitest dogfood suite
pnpm run test:extension-host-debugger
```

`pnpm run build` clears `dist/`, then compiles the runner.

`pnpm run typecheck` checks the plugin, test harness, sample suite, and sample extension projects.

The sample suite intentionally contains one failing test so file-level and test-level reporting can be inspected in Vitest and IDE integrations.

`pnpm run test:extension-host-debugger` is not part of the manual debugging flow. It is an internal smoke check for this repo that verifies the extension-host inspector can stop at a breakpoint in `tests/sample-extension/tests/vscode-api-pass.test.ts`.

## Current Limits

- The extension host bridge uses a TCP connection to report back to the external Vitest process.
