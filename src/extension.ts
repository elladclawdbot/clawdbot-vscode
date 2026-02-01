import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

const EXT_VERSION = '0.1.1';

let flutterProc: ChildProcessWithoutNullStreams | undefined;
let flutterLogs: string[] = [];
let flutterOutput: vscode.OutputChannel | undefined;
let attachedFiles = new Set<string>();

export function activate(context: vscode.ExtensionContext) {
  console.log(`[Clawdbot] Extension activated v${EXT_VERSION}`);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.text = `Clawdbot v${EXT_VERSION}`;
  status.tooltip = 'Clawdbot extension is active';
  status.show();
  context.subscriptions.push(status);

  const provider = new ClawdbotViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('clawdbot.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.sendPrompt', async () => {
      const prompt = await vscode.window.showInputBox({ prompt: 'Send prompt to Clawdbot' });
      if (prompt) provider.sendPrompt(prompt);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.document.getText(editor.selection);
      if (sel) provider.sendPrompt(sel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.addFileToContext', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Add to Context'
      });
      if (!uris) return;
      for (const u of uris) attachedFiles.add(u.fsPath);
      vscode.window.showInformationMessage(`Added ${uris.length} file(s) to context.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.clearContextFiles', async () => {
      attachedFiles.clear();
      vscode.window.showInformationMessage('Cleared context files.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.flutterRun', async () => {
      const cfg = vscode.workspace.getConfiguration('clawdbot');
      const cmd = cfg.get<string>('flutterRunCommand') || 'flutter run';
      startFlutter(cmd);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.flutterHotReload', async () => {
      if (!flutterProc) {
        vscode.window.showWarningMessage('Flutter process not started. Run Clawdbot: Flutter Run first.');
        return;
      }
      flutterProc.stdin.write('r\n');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.flutterHotRestart', async () => {
      if (!flutterProc) {
        vscode.window.showWarningMessage('Flutter process not started. Run Clawdbot: Flutter Run first.');
        return;
      }
      flutterProc.stdin.write('R\n');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.showFlutterLogs', async () => {
      flutterOutput = flutterOutput ?? vscode.window.createOutputChannel('Clawdbot Flutter Logs');
      flutterOutput.show();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      const cfg = vscode.workspace.getConfiguration('clawdbot');
      if (cfg.get<boolean>('autoHotReloadOnSave') && flutterProc) {
        flutterProc.stdin.write('r\n');
      }
    })
  );
}

class ClawdbotViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage(async (msg) => {
      console.log('[Clawdbot] onDidReceiveMessage:', msg);
      if (msg.type === 'send') {
        await this.sendPrompt(msg.text);
      }
    });
  }

  async sendPrompt(text: string) {
    console.log('[Clawdbot] sendPrompt:', text);
    if (!this.view) return;

    this.view.webview.postMessage({ type: 'log', text: `You: ${text}` });

    const cfg = vscode.workspace.getConfiguration('clawdbot');
    const gatewayUrl = cfg.get<string>('gatewayUrl') || '';
    const gatewayToken = cfg.get<string>('gatewayToken') || '';
    const includeWorkspace = cfg.get<boolean>('includeWorkspaceContext') ?? true;

    if (!gatewayUrl || !gatewayToken) {
      this.view.webview.postMessage({
        type: 'log',
        text: 'Missing gatewayUrl or gatewayToken in settings.'
      });
      return;
    }

    const context = includeWorkspace ? await collectWorkspaceContext() : undefined;

    try {
      const preamble = [
        'You are answering inside a VS Code extension on the user\'s machine.',
        'Use the provided WorkspaceContext to reason about files and paths.',
        'Do NOT assume access to the server filesystem.'
      ].join(' ');

      const inputText = context
        ? `${preamble}\n\nUserPrompt:\n${text}\n\n[WorkspaceContext]\n${context}`
        : `${preamble}\n\nUserPrompt:\n${text}`;

      const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken}`,
          'x-clawdbot-agent-id': 'main'
        },
        body: JSON.stringify({
          model: 'clawdbot:main',
          input: inputText
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        this.view.webview.postMessage({ type: 'log', text: `Gateway error: ${res.status} ${errText}` });
        return;
      }

      const data: any = await res.json();
      const outputText = extractOutputText(data);
      this.view.webview.postMessage({ type: 'log', text: outputText || JSON.stringify(data) });
    } catch (err: any) {
      this.view.webview.postMessage({ type: 'log', text: `Request failed: ${err?.message || err}` });
    }
  }

  private getHtml(): string {
    return [
      '<!doctype html>',
      '<html>',
      '  <body>',
      `    <h3>Clawdbot v${EXT_VERSION}</h3>`,
      '    <textarea id="prompt" rows="4" style="width:100%"></textarea>',
      '    <button id="send" type="button">Send</button>',
      '    <pre id="log"></pre>',
      '    <script>',
      '      const vscode = acquireVsCodeApi();',
      '      const log = document.getElementById("log");',
      "      log.textContent += '[webview] ready\\n';",
      '      const prompt = document.getElementById("prompt");',
      '      document.getElementById("send").onclick = () => {',
      '        const text = prompt.value;',
      "        log.textContent += '[webview] click send\\n';",
      '        vscode.postMessage({ type: "send", text });',
      '        prompt.value = "";',
      '      };',
      '      window.addEventListener("message", (event) => {',
      '        if (event.data.type === "log") {',
      '          log.textContent += event.data.text + "\\n";',
      '        }',
      '      });',
      '    </script>',
      '  </body>',
      '</html>'
    ].join('\n');
  }
}

async function collectWorkspaceContext(): Promise<string> {
  const parts: string[] = [];
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    parts.push('workspace: (none)');
  } else {
    parts.push('workspaceFolders:');
    for (const f of folders) {
      parts.push(`- ${f.name}: ${f.uri.fsPath}`);
    }
  }

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const filePath = editor.document.uri.fsPath;
    parts.push(`activeFile: ${filePath}`);
    const sel = editor.document.getText(editor.selection);
    if (sel) {
      parts.push('selection:');
      parts.push(sel);
    }
    parts.push('activeFileContent:');
    parts.push(trimToMax(editor.document.getText()));
  }

  // attached files content
  if (attachedFiles.size) {
    parts.push('attachedFiles:');
    for (const filePath of attachedFiles) {
      try {
        const uri = vscode.Uri.file(filePath);
        const data = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(data).toString('utf8');
        parts.push(`--- ${filePath} ---`);
        parts.push(trimToMax(text));
      } catch (e) {
        parts.push(`--- ${filePath} (failed to read) ---`);
      }
    }
  }

  const cfg = vscode.workspace.getConfiguration('clawdbot');

  // include markdown files
  if (cfg.get<boolean>('includeMarkdownFiles') ?? true) {
    const maxMd = cfg.get<number>('maxMarkdownFiles') ?? 20;
    const mdFiles = await vscode.workspace.findFiles('**/*.md', '**/{node_modules,.git,build,dist,ios/Pods,android/.gradle}', maxMd);
    if (mdFiles.length) {
      parts.push('markdownFiles:');
      for (const f of mdFiles) {
        try {
          const data = await vscode.workspace.fs.readFile(f);
          const text = Buffer.from(data).toString('utf8');
          parts.push(`--- ${f.fsPath} ---`);
          parts.push(trimToMax(text));
        } catch (e) {
          parts.push(`--- ${f.fsPath} (failed to read) ---`);
        }
      }
    }
  }

  // file list (paths only)
  const maxFiles = cfg.get<number>('maxWorkspaceFiles') ?? 200;
  const excludes = '**/{.git,node_modules,build,dist,ios/Pods,android/.gradle,**/*.lock}';
  const files = await vscode.workspace.findFiles('**/*', excludes, maxFiles);
  if (files.length) {
    parts.push(`workspaceFiles (first ${files.length}):`);
    for (const f of files) {
      const rel = folders[0] ? path.relative(folders[0].uri.fsPath, f.fsPath) : f.fsPath;
      parts.push(`- ${rel}`);
    }
  }

  // flutter logs
  const maxLogLines = cfg.get<number>('maxLogLines') ?? 200;
  if (flutterLogs.length) {
    const tail = flutterLogs.slice(-maxLogLines);
    parts.push('flutterLogsTail:');
    parts.push(tail.join('\n'));
  }

  return parts.join('\n');
}

function trimToMax(text: string): string {
  const cfg = vscode.workspace.getConfiguration('clawdbot');
  const maxChars = cfg.get<number>('maxFileChars') ?? 20000;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[trimmed ${text.length - maxChars} chars]`;
}

function startFlutter(cmd: string) {
  if (flutterProc) {
    vscode.window.showWarningMessage('Flutter run already active.');
    return;
  }

  flutterOutput = flutterOutput ?? vscode.window.createOutputChannel('Clawdbot Flutter Logs');
  flutterOutput.clear();
  flutterOutput.show();

  flutterLogs = [];
  flutterProc = spawn(cmd, { shell: true });

  flutterProc.stdout.on('data', (data) => {
    const text = data.toString();
    flutterOutput?.append(text);
    appendLogs(text);
  });

  flutterProc.stderr.on('data', (data) => {
    const text = data.toString();
    flutterOutput?.append(text);
    appendLogs(text);
  });

  flutterProc.on('exit', (code) => {
    flutterOutput?.appendLine(`\n[Flutter exited with code ${code}]`);
    flutterProc = undefined;
  });
}

function appendLogs(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  flutterLogs.push(...lines);
  if (flutterLogs.length > 2000) {
    flutterLogs = flutterLogs.slice(-2000);
  }
}

function extractOutputText(data: any): string {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  if (Array.isArray(data.output)) {
    const parts: string[] = [];
    for (const item of data.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c.type === 'output_text' && typeof c.text === 'string') {
          parts.push(c.text);
        }
      }
    }
    return parts.join('');
  }
  return '';
}

export function deactivate() {
  console.log(`[Clawdbot] Extension deactivated v${EXT_VERSION}`);
}
