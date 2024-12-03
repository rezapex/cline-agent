import { commands, window } from 'jetbrains';
import { ClineProvider } from './ClineProvider';

export function registerCommands(context: any, sidebarProvider: ClineProvider) {
    context.subscriptions.push(
        commands.registerCommand("cline.plusButtonClicked", async () => {
            sidebarProvider.clearTask();
            sidebarProvider.postStateToWebview();
            sidebarProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" });
        }),
    );

    context.subscriptions.push(
        commands.registerCommand("cline.popoutButtonClicked", async () => {
            const tabProvider = new ClineProvider(context, sidebarProvider.outputChannel);
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
        }),
    );

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
}
