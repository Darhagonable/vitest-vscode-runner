import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';

describe('vscode API', () => {
  it('exposes the extension host API', () => {
    expect(typeof vscode.window.createOutputChannel).toBe('function');
    expect(typeof vscode.commands.executeCommand).toBe('function');
  });

  it('runs inside the extension host', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: 'hello from the extension host' });
    expect(doc.getText()).toBe('hello from the extension host');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
