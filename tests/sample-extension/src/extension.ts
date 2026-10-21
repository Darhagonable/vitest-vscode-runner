import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Sample Extension');
  channel.appendLine('Sample extension activated.');

  const command = vscode.commands.registerCommand('sample-extension.helloWorld', () => {
    vscode.window.showInformationMessage('Hello from the sample extension!');
  });

  context.subscriptions.push(channel, command);
}

export function deactivate(): void {
  // nothing to clean up
}
