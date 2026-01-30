import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ClawdbotViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('clawdbot.panel', provider)
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
}

class ClawdbotViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'send') {
        this.sendPrompt(msg.text);
      }
    });
  }

  async sendPrompt(text: string) {
    // TODO: collect context + debug console + send to gateway
    if (this.view) {
      this.view.webview.postMessage({ type: 'log', text: `Sent: ${text}` });
    }
  }

  private getHtml(): string {
    return `<!doctype html>
<html>
  <body>
    <h3>Clawdbot</h3>
    <textarea id="prompt" rows="4" style="width:100%"></textarea>
    <button id="send">Send</button>
    <pre id="log"></pre>
    <script>
      const log = document.getElementById('log');
      document.getElementById('send').onclick = () => {
        const text = document.getElementById('prompt').value;
        vscode.postMessage({ type: 'send', text });
      };
      window.addEventListener('message', (event) => {
        if (event.data.type === 'log') {
          log.textContent += event.data.text + '\n';
        }
      });
      const vscode = acquireVsCodeApi();
    </script>
  </body>
</html>`;
  }
}

export function deactivate() {}
