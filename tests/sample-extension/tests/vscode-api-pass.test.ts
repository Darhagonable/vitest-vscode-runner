import * as vscode from 'vscode';
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { activate } from '../src/extension';

describe('vscode API', () => {
  it('exposes the extension host API', () => {
    // Env-gated markers for the repo's watch-mode e2e driver: one line and
    // one console.log per run, only when the driver sets these.
    const marker = process.env.VSCODE_RUNNER_WATCH_MARKER;

    if (marker) {
      appendFileSync(marker, 'run\n');
    }

    const consoleProbe = process.env.VSCODE_RUNNER_CONSOLE_E2E;

    if (consoleProbe) {
      console.log(consoleProbe);
    }

    expect(typeof vscode.window.createOutputChannel).toBe('function');
    expect(typeof vscode.commands.executeCommand).toBe('function');
  });

  it('runs inside the extension host', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: 'hello from the extension host' });
    expect(doc.getText()).toBe('hello from the extension host');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});

describe('sample extension', () => {
  it('can be imported and activated directly from source', () => {
    const subscriptions: vscode.Disposable[] = [];
    activate({ subscriptions } as unknown as vscode.ExtensionContext);
    expect(subscriptions).toHaveLength(1);
    subscriptions.forEach(disposable => disposable.dispose());
  });

  it('registers and executes a command', async () => {
    const subscriptions: vscode.Disposable[] = [];
    activate({ subscriptions } as unknown as vscode.ExtensionContext);

    await expect(vscode.commands.executeCommand('sample-extension.helloWorld')).resolves.toBeUndefined();

    subscriptions.forEach(disposable => disposable.dispose());
  });
});
