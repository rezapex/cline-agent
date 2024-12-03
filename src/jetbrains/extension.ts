import { commands, window, workspace, ExtensionContext } from 'jetbrains';
import { ClineProvider } from './ClineProvider';
import { createClineAPI } from './exports';
import './utils/path'; // necessary to have access to String.prototype.toPosix

let outputChannel: any;

export function activate(context: ExtensionContext) {
    outputChannel = window.createOutputChannel("Cline");
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine("Cline extension activated");

    const sidebarProvider = new ClineProvider(context, outputChannel);

    context.subscriptions.push(
        window.registerWebviewViewProvider(ClineProvider.sideBarId, sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    context.subscriptions.push(
        commands.registerCommand("cline.plusButtonClicked", async () => {
            outputChannel.appendLine("Plus button Clicked");
            await sidebarProvider.clearTask();
            await sidebarProvider.postStateToWebview();
            await sidebarProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" });
        }),
    );

    const openClineInNewTab = async () => {
        outputChannel.appendLine("Opening Cline in new tab");
        const tabProvider = new ClineProvider(context, outputChannel);
        const lastCol = Math.max(...window.visibleTextEditors.map((editor: any) => editor.viewColumn || 0));

        const hasVisibleEditors = window.visibleTextEditors.length > 0;
        if (!hasVisibleEditors) {
            await commands.executeCommand("workbench.action.newGroupRight");
        }
        const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : 2;

        const panel = window.createWebviewPanel(ClineProvider.tabPanelId, "Cline", targetCol, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [context.extensionUri],
        });

        panel.iconPath = {
            light: Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_light.png"),
            dark: Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_dark.png"),
        };
        tabProvider.resolveWebviewView(panel);

        await delay(100);
        await commands.executeCommand("workbench.action.lockEditorGroup");
    };

    context.subscriptions.push(commands.registerCommand("cline.popoutButtonClicked", openClineInNewTab));
    context.subscriptions.push(commands.registerCommand("cline.openInNewTab", openClineInNewTab));

    context.subscriptions.push(
        commands.registerCommand("cline.settingsButtonClicked", () => {
            sidebarProvider.postMessageToWebview({ type: "action", action: "settingsButtonClicked" });
        }),
    );

    context.subscriptions.push(
        commands.registerCommand("cline.historyButtonClicked", () => {
            sidebarProvider.postMessageToWebview({ type: "action", action: "historyButtonClicked" });
        }),
    );

    const diffContentProvider = new (class {
        provideTextDocumentContent(uri: any): string {
            return Buffer.from(uri.query, "base64").toString("utf-8");
        }
    })();
    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider('cline-diff', diffContentProvider),
    );

    const handleUri = async (uri: any) => {
        const path = uri.path;
        const query = new URLSearchParams(uri.query.replace(/\+/g, "%2B"));
        const visibleProvider = ClineProvider.getVisibleInstance();
        if (!visibleProvider) {
            return;
        }
        switch (path) {
            case "/openrouter": {
                const code = query.get("code");
                if (code) {
                    await visibleProvider.handleOpenRouterCallback(code);
                }
                break;
            }
            default:
                break;
        }
    };
    context.subscriptions.push(window.registerUriHandler({ handleUri }));

    return createClineAPI(outputChannel, sidebarProvider);
}

export function deactivate() {
    outputChannel.appendLine("Cline extension deactivated");
}
