import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Sample Extension');
  channel.appendLine('Sample extension activated.');
  context.subscriptions.push(channel);
}

export function deactivate(): void {
  // nothing to clean up
}
