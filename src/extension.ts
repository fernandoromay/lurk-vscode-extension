import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('Lurk extension activated.');

  // Pass configured HLS path to proxy via environment variable
  const config = vscode.workspace.getConfiguration('lurk');
  const hlsPath = config.get<string>('hlsPath');
  
  if (hlsPath) {
      process.env.LURK_HLS_PATH = hlsPath;
  }
}

export function deactivate() {}
