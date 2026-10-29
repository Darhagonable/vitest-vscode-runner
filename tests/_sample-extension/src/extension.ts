import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  // NOTE: do not create output channels here. Channel registration is async
  // in VS Code; creating one in a fast test run races extension-host teardown
  // (DisposableStore "already been disposed" errors in doCreateOutputChannel).
  const command = vscode.commands.registerCommand('sample-extension.helloWorld', () => {
    vscode.window.showInformationMessage('Hello from the sample extension!');
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {
  // nothing to clean up
}
