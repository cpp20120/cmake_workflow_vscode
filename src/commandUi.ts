import * as vscode from 'vscode';
import { parseProgramArguments } from './profileActions';

export interface CommandServices {
  register(name: string, action: () => Promise<void>): void;
  trusted(): boolean;
  folder(): Promise<vscode.WorkspaceFolder | undefined>;
  call(folder: vscode.WorkspaceFolder, args: string[]): Promise<string>;
  execute(folder: vscode.WorkspaceFolder, args: string[], json?: boolean): Promise<string | undefined>;
  show(title: string, html: string): void;
}

export async function pickDirectory(folder: vscode.WorkspaceFolder, label: string): Promise<string | undefined> {
  const chosen = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: false,
    canSelectFolders: true, canSelectMany: false, openLabel: label });
  return chosen?.[0]?.fsPath;
}

export async function programArguments(prompt: string): Promise<string[] | undefined> {
  const text = await vscode.window.showInputBox({ prompt, value: '[]',
    validateInput: value => { try { parseProgramArguments(value); return undefined; } catch { return 'Enter a JSON array of strings, for example ["--case", "chain-4"].'; } } });
  return text === undefined ? undefined : parseProgramArguments(text);
}
