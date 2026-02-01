import * as vscode from 'vscode';
import * as path from 'path';

const EXT_VERSION = '0.0.6';
let flutterTerminal: vscode.Terminal | undefined;

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
    vscode.commands.registerCommand('clawdbot.flutterRun', async () => {
      const cfg = vscode.workspace.getConfiguration('clawdbot');
      const cmd = cfg.get<string>('flutterRunCommand') || 'flutter run';
      flutterTerminal = flutterTerminal ?? vscode.window.createTerminal('Clawdbot Flutter');
      flutterTerminal.show();
      flutterTerminal.sendText(cmd);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.flutterHotReload', async () => {
      if (!flutterTerminal) {
        vscode.window.showWarningMessage('Flutter terminal not started. Run Clawdbot: Flutter Run first.');
        return;
      }
      flutterTerminal.sendText('r');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawdbot.flutterHotRestart', async () => {
      if (!flutterTerminal) {
        vscode.window.showWarningMessage('Flutter terminal not started. Run Clawdbot: Flutter Run first.');
        return;
      }
      flutterTerminal.sendText('R');
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
      parts.push(`- ${f.name}: ${f.fsPath}`);
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
  }

  // file list (paths only)
  const cfg = vscode.workspace.getConfiguration('clawdbot');
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

  return parts.join('\n');
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
