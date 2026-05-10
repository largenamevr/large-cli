'use strict';

const vscode = require('vscode');
const path = require('path');

async function openLargeCli() {
  const terminal = vscode.window.createTerminal({
    name: 'large-cli',
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  const scriptPath = path.join(__dirname, 'large-cli.js');
  const command = `node "${scriptPath}"`;

  terminal.show(true);
  await vscode.commands.executeCommand('workbench.action.terminal.clear');
  terminal.sendText(command, true);
}

function activate(context) {
  const disposable = vscode.commands.registerCommand('largeCli.open', openLargeCli);
  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
