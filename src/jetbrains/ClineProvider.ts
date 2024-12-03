import { Anthropic } from "@anthropic-ai/sdk";
import axios from "axios";
import fs from "fs/promises";
import pWaitFor from "p-wait-for";
import * as path from "path";
import * as jetbrains from "jetbrains";
import { buildApiHandler } from "../../api";
import { downloadTask } from "../../integrations/misc/export-markdown";
import { openFile, openImage } from "../../integrations/misc/open-file";
import { selectImages } from "../../integrations/misc/process-images";
import { getTheme } from "../../integrations/theme/getTheme";
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker";
import { ApiProvider, ModelInfo } from "../../shared/api";
import { findLast } from "../../shared/array";
import { ExtensionMessage } from "../../shared/ExtensionMessage";
import { HistoryItem } from "../../shared/HistoryItem";
import { WebviewMessage } from "../../shared/WebviewMessage";
import { fileExistsAtPath } from "../../utils/fs";
import { Cline } from "../Cline";
import { openMention } from "../mentions";
import { getNonce } from "./getNonce";
import { getUri } from "./getUri";

type SecretKey =
    | "apiKey"
    | "openRouterApiKey"
    | "awsAccessKey"
    | "awsSecretKey"
    | "awsSessionToken"
    | "openAiApiKey"
    | "geminiApiKey"
    | "openAiNativeApiKey";
type GlobalStateKey =
    | "apiProvider"
    | "apiModelId"
    | "awsRegion"
    | "awsUseCrossRegionInference"
    | "vertexProjectId"
    | "vertexRegion"
    | "lastShownAnnouncementId"
    | "customInstructions"
    | "alwaysAllowReadOnly"
    | "taskHistory"
    | "openAiBaseUrl"
    | "openAiModelId"
    | "ollamaModelId"
    | "ollamaBaseUrl"
    | "lmStudioModelId"
    | "lmStudioBaseUrl"
    | "anthropicBaseUrl"
    | "azureApiVersion"
    | "openRouterModelId"
    | "openRouterModelInfo";

export const GlobalFileNames = {
    apiConversationHistory: "api_conversation_history.json",
    uiMessages: "ui_messages.json",
    openRouterModels: "openrouter_models.json",
};

export class ClineProvider implements jetbrains.WebviewViewProvider {
    public static readonly sideBarId = "claude-dev.SidebarProvider";
    public static readonly tabPanelId = "claude-dev.TabPanelProvider";
    private static activeInstances: Set<ClineProvider> = new Set();
    private disposables: any[] = [];
    private view?: any;
    private cline?: Cline;
    private workspaceTracker?: WorkspaceTracker;
    private latestAnnouncementId = "oct-28-2024";

    constructor(
        readonly context: any,
        private readonly outputChannel: any,
    ) {
        this.outputChannel.appendLine("ClineProvider instantiated");
        ClineProvider.activeInstances.add(this);
        this.workspaceTracker = new WorkspaceTracker(this);
    }

    async dispose() {
        this.outputChannel.appendLine("Disposing ClineProvider...");
        await this.clearTask();
        this.outputChannel.appendLine("Cleared task");
        if (this.view && "dispose" in this.view) {
            this.view.dispose();
            this.outputChannel.appendLine("Disposed webview");
        }
        while (this.disposables.length) {
            const x = this.disposables.pop();
            if (x) {
                x.dispose();
            }
        }
        this.workspaceTracker?.dispose();
        this.workspaceTracker = undefined;
        this.outputChannel.appendLine("Disposed all disposables");
        ClineProvider.activeInstances.delete(this);
    }

    public static getVisibleInstance(): ClineProvider | undefined {
        return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true);
    }

    resolveWebviewView(
        webviewView: any,
    ): void | Thenable<void> {
        this.outputChannel.appendLine("Resolving webview view");
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        this.setWebviewMessageListener(webviewView.webview);

        if ("onDidChangeViewState" in webviewView) {
            webviewView.onDidChangeViewState(
                () => {
                    if (this.view?.visible) {
                        this.postMessageToWebview({ type: "action", action: "didBecomeVisible" });
                    }
                },
                null,
                this.disposables,
            );
        } else if ("onDidChangeVisibility" in webviewView) {
            webviewView.onDidChangeVisibility(
                () => {
                    if (this.view?.visible) {
                        this.postMessageToWebview({ type: "action", action: "didBecomeVisible" });
                    }
                },
                null,
                this.disposables,
            );
        }

        webviewView.onDidDispose(
            async () => {
                await this.dispose();
            },
            null,
            this.disposables,
        );

        jetbrains.workspace.onDidChangeConfiguration(
            async (e: any) => {
                if (e && e.affectsConfiguration("workbench.colorTheme")) {
                    await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) });
                }
            },
            null,
            this.disposables,
        );

        this.clearTask();

        this.outputChannel.appendLine("Webview view resolved");
    }

    async initClineWithTask(task?: string, images?: string[]) {
        await this.clearTask();
        const { apiConfiguration, customInstructions, alwaysAllowReadOnly } = await this.getState();
        this.cline = new Cline(this, apiConfiguration, customInstructions, alwaysAllowReadOnly, task, images);
    }

    async initClineWithHistoryItem(historyItem: HistoryItem) {
        await this.clearTask();
        const { apiConfiguration, customInstructions, alwaysAllowReadOnly } = await this.getState();
        this.cline = new Cline(
            this,
            apiConfiguration,
            customInstructions,
            alwaysAllowReadOnly,
            undefined,
            undefined,
            historyItem,
        );
    }

    async postMessageToWebview(message: ExtensionMessage) {
        await this.view?.webview.postMessage(message);
    }

    private getHtmlContent(webview: any): string {
        const stylesUri = getUri(webview, this.context.extensionUri, [
            "webview-ui",
            "build",
            "static",
            "css",
            "main.css",
        ]);
        const scriptUri = getUri(webview, this.context.extensionUri, ["webview-ui", "build", "static", "js", "main.js"]);
        const codiconsUri = getUri(webview, this.context.extensionUri, [
            "node_modules",
            "@vscode",
            "codicons",
            "dist",
            "codicon.css",
        ]);
        const nonce = getNonce();

        return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
			<link href="${codiconsUri}" rel="stylesheet" />
            <title>Cline</title>
          </head>
          <body>
            <noscript>You need to enable JavaScript to run this app.</noscript>
            <div id="root"></div>
            <script nonce="${nonce}" src="${scriptUri}"></script>
          </body>
        </html>
      `;
    }

    private setWebviewMessageListener(webview: any) {
        webview.onDidReceiveMessage(
            async (message: WebviewMessage) => {
                switch (message.type) {
                    case "webviewDidLaunch":
                        this.postStateToWebview();
                        this.workspaceTracker?.initializeFilePaths();
                        getTheme().then((theme) =>
                            this.postMessageToWebview({ type: "theme", text: JSON.stringify(theme) }),
                        );
                        this.readOpenRouterModels().then((openRouterModels) => {
                            if (openRouterModels) {
                                this.postMessageToWebview({ type: "openRouterModels", openRouterModels });
                            }
                        });
                        this.refreshOpenRouterModels().then(async (openRouterModels) => {
                            if (openRouterModels) {
                                const { apiConfiguration } = await this.getState();
                                if (apiConfiguration.openRouterModelId) {
                                    await this.updateGlobalState(
                                        "openRouterModelInfo",
                                        openRouterModels[apiConfiguration.openRouterModelId],
                                    );
                                    await this.postStateToWebview();
                                }
                            }
                        });
                        break;
                    case "newTask":
                        await this.initClineWithTask(message.text, message.images);
                        break;
                    case "apiConfiguration":
                        if (message.apiConfiguration) {
                            const {
                                apiProvider,
                                apiModelId,
                                apiKey,
                                openRouterApiKey,
                                awsAccessKey,
                                awsSecretKey,
                                awsSessionToken,
                                awsRegion,
                                awsUseCrossRegionInference,
                                vertexProjectId,
                                vertexRegion,
                                openAiBaseUrl,
                                openAiApiKey,
                                openAiModelId,
                                ollamaModelId,
                                ollamaBaseUrl,
                                lmStudioModelId,
                                lmStudioBaseUrl,
                                anthropicBaseUrl,
                                geminiApiKey,
                                openAiNativeApiKey,
                                azureApiVersion,
                                openRouterModelId,
                                openRouterModelInfo,
                            } = message.apiConfiguration;
                            await this.updateGlobalState("apiProvider", apiProvider);
                            await this.updateGlobalState("apiModelId", apiModelId);
                            await this.storeSecret("apiKey", apiKey);
                            await this.storeSecret("openRouterApiKey", openRouterApiKey);
                            await this.storeSecret("awsAccessKey", awsAccessKey);
                            await this.storeSecret("awsSecretKey", awsSecretKey);
                            await this.storeSecret("awsSessionToken", awsSessionToken);
                            await this.updateGlobalState("awsRegion", awsRegion);
                            await this.updateGlobalState("awsUseCrossRegionInference", awsUseCrossRegionInference);
                            await this.updateGlobalState("vertexProjectId", vertexProjectId);
                            await this.updateGlobalState("vertexRegion", vertexRegion);
                            await this.updateGlobalState("openAiBaseUrl", openAiBaseUrl);
                            await this.storeSecret("openAiApiKey", openAiApiKey);
                            await this.updateGlobalState("openAiModelId", openAiModelId);
                            await this.updateGlobalState("ollamaModelId", ollamaModelId);
                            await this.updateGlobalState("ollamaBaseUrl", ollamaBaseUrl);
                            await this.updateGlobalState("lmStudioModelId", lmStudioModelId);
                            await this.updateGlobalState("lmStudioBaseUrl", lmStudioBaseUrl);
                            await this.updateGlobalState("anthropicBaseUrl", anthropicBaseUrl);
                            await this.storeSecret("geminiApiKey", geminiApiKey);
                            await this.storeSecret("openAiNativeApiKey", openAiNativeApiKey);
                            await this.updateGlobalState("azureApiVersion", azureApiVersion);
                            await this.updateGlobalState("openRouterModelId", openRouterModelId);
                            await this.updateGlobalState("openRouterModelInfo", openRouterModelInfo);
                            if (this.cline) {
                                this.cline.api = buildApiHandler(message.apiConfiguration);
                            }
                        }
                        await this.postStateToWebview();
                        break;
                    case "customInstructions":
                        await this.updateCustomInstructions(message.text);
                        break;
                    case "alwaysAllowReadOnly":
                        await this.updateGlobalState("alwaysAllowReadOnly", message.bool ?? undefined);
                        if (this.cline) {
                            this.cline.alwaysAllowReadOnly = message.bool ?? false;
                        }
                        await this.postStateToWebview();
                        break;
                    case "askResponse":
                        this.cline?.handleWebviewAskResponse(message.askResponse!, message.text, message.images);
                        break;
                    case "clearTask":
                        await this.clearTask();
                        await this.postStateToWebview();
                        break;
                    case "didShowAnnouncement":
                        await this.updateGlobalState("lastShownAnnouncementId", this.latestAnnouncementId);
                        await this.postStateToWebview();
                        break;
                    case "selectImages":
                        const images = await selectImages();
                        await this.postMessageToWebview({ type: "selectedImages", images });
                        break;
                    case "exportCurrentTask":
                        const currentTaskId = this.cline?.taskId;
                        if (currentTaskId) {
                            this.exportTaskWithId(currentTaskId);
                        }
                        break;
                    case "showTaskWithId":
                        this.showTaskWithId(message.text!);
                        break;
                    case "deleteTaskWithId":
                        this.deleteTaskWithId(message.text!);
                        break;
                    case "exportTaskWithId":
                        this.exportTaskWithId(message.text!);
                        break;
                    case "resetState":
                        await this.resetState();
                        break;
                    case "requestOllamaModels":
                        const ollamaModels = await this.getOllamaModels(message.text);
                        this.postMessageToWebview({ type: "ollamaModels", ollamaModels });
                        break;
                    case "requestLmStudioModels":
                        const lmStudioModels = await this.getLmStudioModels(message.text);
                        this.postMessageToWebview({ type: "lmStudioModels", lmStudioModels });
                        break;
                    case "refreshOpenRouterModels":
                        await this.refreshOpenRouterModels();
                        break;
                    case "openImage":
                        openImage(message.text!);
                        break;
                    case "openFile":
                        openFile(message.text!);
                        break;
                    case "openMention":
                        openMention(message.text);
                        break;
                    case "cancelTask":
                        if (this.cline) {
                            const { historyItem } = await this.getTaskWithId(this.cline.taskId);
                            this.cline.abortTask();
                            await pWaitFor(() => this.cline === undefined || this.cline.didFinishAborting, {
                                timeout: 3_000,
                            }).catch(() => {
                                console.error("Failed to abort task");
                            });
                            if (this.cline) {
                                this.cline.abandoned = true;
                            }
                            await this.initClineWithHistoryItem(historyItem);
                        }
                        break;
                }
            },
            null,
            this.disposables,
        );
    }

    async updateCustomInstructions(instructions?: string) {
        await this.updateGlobalState("customInstructions", instructions || undefined);
        if (this.cline) {
            this.cline.customInstructions = instructions || undefined;
        }
        await this.postStateToWebview();
    }

    async getOllamaModels(baseUrl?: string) {
        try {
            if (!baseUrl) {
                baseUrl = "http://localhost:11434";
            }
            if (!URL.canParse(baseUrl)) {
                return [];
            }
            const response = await axios.get(`${baseUrl}/api/tags`);
            const modelsArray = response.data?.models?.map((model: any) => model.name) || [];
            const models = [...new Set<string>(modelsArray)];
            return models;
        } catch (error) {
            return [];
        }
    }

    async getLmStudioModels(baseUrl?: string) {
        try {
            if (!baseUrl) {
                baseUrl = "http://localhost:1234";
            }
            if (!URL.canParse(baseUrl)) {
                return [];
            }
            const response = await axios.get(`${baseUrl}/v1/models`);
            const modelsArray = response.data?.data?.map((model: any) => model.id) || [];
            const models = [...new Set<string>(modelsArray)];
            return models;
        } catch (error) {
            return [];
        }
    }

    async handleOpenRouterCallback(code: string) {
        let apiKey: string;
        try {
            const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code });
            if (response.data && response.data.key) {
                apiKey = response.data.key;
            } else {
                throw new Error("Invalid response from OpenRouter API");
            }
        } catch (error) {
            console.error("Error exchanging code for API key:", error);
            throw error;
        }

        const openrouter: ApiProvider = "openrouter";
        await this.updateGlobalState("apiProvider", openrouter);
        await this.storeSecret("openRouterApiKey", apiKey);
        await this.postStateToWebview();
        if (this.cline) {
            this.cline.api = buildApiHandler({ apiProvider: openrouter, openRouterApiKey: apiKey });
        }
    }

    private async ensureCacheDirectoryExists(): Promise<string> {
        const cacheDir = path.join(this.context.globalStorageUri.fsPath, "cache");
        await fs.mkdir(cacheDir, { recursive: true });
        return cacheDir;
    }

    async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
        const openRouterModelsFilePath = path.join(
            await this.ensureCacheDirectoryExists(),
            GlobalFileNames.openRouterModels,
        );
        const fileExists = await fileExistsAtPath(openRouterModelsFilePath);
        if (fileExists) {
            const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8");
            return JSON.parse(fileContents);
        }
        return undefined;
    }

    async refreshOpenRouterModels() {
        const openRouterModelsFilePath = path.join(
            await this.ensureCacheDirectoryExists(),
            GlobalFileNames.openRouterModels,
        );

        let models: Record<string, ModelInfo> = {};
        try {
            const response = await axios.get("https://openrouter.ai/api/v1/models");
            if (response.data?.data) {
                const rawModels = response.data.data;
                const parsePrice = (price: any) => {
                    if (price) {
                        return parseFloat(price) * 1_000_000;
                    }
                    return undefined;
                };
                for (const rawModel of rawModels) {
                    const modelInfo: ModelInfo = {
                        maxTokens: rawModel.top_provider?.max_completion_tokens,
                        contextWindow: rawModel.context_length,
                        supportsImages: rawModel.architecture?.modality?.includes("image"),
                        supportsPromptCache: false,
                        inputPrice: parsePrice(rawModel.pricing?.prompt),
                        outputPrice: parsePrice(rawModel.pricing?.completion),
                        description: rawModel.description,
                    };

                    switch (rawModel.id) {
                        case "anthropic/claude-3.5-sonnet":
                        case "anthropic/claude-3.5-sonnet:beta":
                            modelInfo.supportsComputerUse = true;
                            modelInfo.supportsPromptCache = true;
                            modelInfo.cacheWritesPrice = 3.75;
                            modelInfo.cacheReadsPrice = 0.3;
                            break;
                        case "anthropic/claude-3.5-sonnet-20240620":
                        case "anthropic/claude-3.5-sonnet-20240620:beta":
                            modelInfo.supportsPromptCache = true;
                            modelInfo.cacheWritesPrice = 3.75;
                            modelInfo.cacheReadsPrice = 0.3;
                            break;
                        case "anthropic/claude-3-5-haiku":
                        case "anthropic/claude-3-5-haiku:beta":
                        case "anthropic/claude-3-5-haiku-20241022":
                        case "anthropic/claude-3-5-haiku-20241022:beta":
                        case "anthropic/claude-3.5-haiku":
                        case "anthropic/claude-3.5-haiku:beta":
                        case "anthropic/claude-3.5-haiku-20241022":
                        case "anthropic/claude-3.5-haiku-20241022:beta":
                            modelInfo.supportsPromptCache = true;
                            modelInfo.cacheWritesPrice = 1.25;
                            modelInfo.cacheReadsPrice = 0.1;
                            break;
                        case "anthropic/claude-3-opus":
                        case "anthropic/claude-3-opus:beta":
                            modelInfo.supportsPromptCache = true;
                            modelInfo.cacheWritesPrice = 18.75;
                            modelInfo.cacheReadsPrice = 1.5;
                            break;
                        case "anthropic/claude-3-haiku":
                        case "anthropic/claude-3-haiku:beta":
                            modelInfo.supportsPromptCache = true;
                            modelInfo.cacheWritesPrice = 0.3;
                            modelInfo.cacheReadsPrice = 0.03;
                            break;
                    }

                    models[rawModel.id] = modelInfo;
                }
            } else {
                console.error("Invalid response from OpenRouter API");
            }
            await fs.writeFile(openRouterModelsFilePath, JSON.stringify(models));
            console.log("OpenRouter models fetched and saved", models);
        } catch (error) {
            console.error("Error fetching OpenRouter models:", error);
        }

        await this.postMessageToWebview({ type: "openRouterModels", openRouterModels: models });
        return models;
    }

    async getTaskWithId(id: string): Promise<{
        historyItem: HistoryItem;
        taskDirPath: string;
        apiConversationHistoryFilePath: string;
        uiMessagesFilePath: string;
        apiConversationHistory: Anthropic.MessageParam[];
    }> {
        const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || [];
        const historyItem = history.find((item) => item.id === id);
        if (historyItem) {
            const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks", id);
            const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory);
            const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages);
            const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath);
            if (fileExists) {
                const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"));
                return {
                    historyItem,
                    taskDirPath,
                    apiConversationHistoryFilePath,
                    uiMessagesFilePath,
                    apiConversationHistory,
                };
            }
        }
        await this.deleteTaskFromState(id);
        throw new Error("Task not found");
    }

    async showTaskWithId(id: string) {
        if (id !== this.cline?.taskId) {
            const { historyItem } = await this.getTaskWithId(id);
            await this.initClineWithHistoryItem(historyItem);
        }
        await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" });
    }

    async exportTaskWithId(id: string) {
        const { historyItem, apiConversationHistory } = await this.getTaskWithId(id);
        await downloadTask(historyItem.ts, apiConversationHistory);
    }

    async deleteTaskWithId(id: string) {
        if (id === this.cline?.taskId) {
            await this.clearTask();
        }

        const { taskDirPath, apiConversationHistoryFilePath, uiMessagesFilePath } = await this.getTaskWithId(id);

        await this.deleteTaskFromState(id);

        const apiConversationHistoryFileExists = await fileExistsAtPath(apiConversationHistoryFilePath);
        if (apiConversationHistoryFileExists) {
            await fs.unlink(apiConversationHistoryFilePath);
        }
        const uiMessagesFileExists = await fileExistsAtPath(uiMessagesFilePath);
        if (uiMessagesFileExists) {
            await fs.unlink(uiMessagesFilePath);
        }
        const legacyMessagesFilePath = path.join(taskDirPath, "claude_messages.json");
        if (await fileExistsAtPath(legacyMessagesFilePath)) {
            await fs.unlink(legacyMessagesFilePath);
        }
        await fs.rmdir(taskDirPath);
    }

    async deleteTaskFromState(id: string) {
        const taskHistory = ((await this.getGlobalState("taskHistory")) as HistoryItem[] | undefined) || [];
        const updatedTaskHistory = taskHistory.filter((task) => task.id !== id);
        await this.updateGlobalState("taskHistory", updatedTaskHistory);

        await this.postStateToWebview();
    }

    async postStateToWebview() {
        const state = await this.getStateToPostToWebview();
        this.postMessageToWebview({ type: "state", state });
    }

    async getStateToPostToWebview() {
        const { apiConfiguration, lastShownAnnouncementId, customInstructions, alwaysAllowReadOnly, taskHistory } =
            await this.getState();
        return {
            version: this.context.extension?.packageJSON?.version ?? "",
            apiConfiguration,
            customInstructions,
            alwaysAllowReadOnly,
            uriScheme: jetbrains.env.uriScheme,
            clineMessages: this.cline?.clineMessages || [],
            taskHistory: (taskHistory || []).filter((item) => item.ts && item.task).sort((a, b) => b.ts - a.ts),
            shouldShowAnnouncement: lastShownAnnouncementId !== this.latestAnnouncementId,
        };
    }

    async clearTask() {
        this.cline?.abortTask();
        this.cline = undefined;
    }

    async getState() {
        const [
            storedApiProvider,
            apiModelId,
            apiKey,
            openRouterApiKey,
            awsAccessKey,
            awsSecretKey,
            awsSessionToken,
            awsRegion,
            awsUseCrossRegionInference,
            vertexProjectId,
            vertexRegion,
            openAiBaseUrl,
            openAiApiKey,
            openAiModelId,
            ollamaModelId,
            ollamaBaseUrl,
            lmStudioModelId,
            lmStudioBaseUrl,
            anthropicBaseUrl,
            geminiApiKey,
            openAiNativeApiKey,
            azureApiVersion,
            openRouterModelId,
            openRouterModelInfo,
            lastShownAnnouncementId,
            customInstructions,
            alwaysAllowReadOnly,
            taskHistory,
        ] = await Promise.all([
            this.getGlobalState("apiProvider") as Promise<ApiProvider | undefined>,
            this.getGlobalState("apiModelId") as Promise<string | undefined>,
            this.getSecret("apiKey") as Promise<string | undefined>,
            this.getSecret("openRouterApiKey") as Promise<string | undefined>,
            this.getSecret("awsAccessKey") as Promise<string | undefined>,
            this.getSecret("awsSecretKey") as Promise<string | undefined>,
            this.getSecret("awsSessionToken") as Promise<string | undefined>,
            this.getGlobalState("awsRegion") as Promise<string | undefined>,
            this.getGlobalState("awsUseCrossRegionInference") as Promise<boolean | undefined>,
            this.getGlobalState("vertexProjectId") as Promise<string | undefined>,
            this.getGlobalState("vertexRegion") as Promise<string | undefined>,
            this.getGlobalState("openAiBaseUrl") as Promise<string | undefined>,
            this.getSecret("openAiApiKey") as Promise<string | undefined>,
            this.getGlobalState("openAiModelId") as Promise<string | undefined>,
            this.getGlobalState("ollamaModelId") as Promise<string | undefined>,
            this.getGlobalState("ollamaBaseUrl") as Promise<string | undefined>,
            this.getGlobalState("lmStudioModelId") as Promise<string | undefined>,
            this.getGlobalState("lmStudioBaseUrl") as Promise<string | undefined>,
            this.getGlobalState("anthropicBaseUrl") as Promise<string | undefined>,
            this.getSecret("geminiApiKey") as Promise<string | undefined>,
            this.getSecret("openAiNativeApiKey") as Promise<string | undefined>,
            this.getGlobalState("azureApiVersion") as Promise<string | undefined>,
            this.getGlobalState("openRouterModelId") as Promise<string | undefined>,
            this.getGlobalState("openRouterModelInfo") as Promise<ModelInfo | undefined>,
            this.getGlobalState("lastShownAnnouncementId") as Promise<string | undefined>,
            this.getGlobalState("customInstructions") as Promise<string | undefined>,
            this.getGlobalState("alwaysAllowReadOnly") as Promise<boolean | undefined>,
            this.getGlobalState("taskHistory") as Promise<HistoryItem[] | undefined>,
        ]);

        let apiProvider: ApiProvider;
        if (storedApiProvider) {
            apiProvider = storedApiProvider;
        } else {
            if (apiKey) {
                apiProvider = "anthropic";
            } else {
                apiProvider = "openrouter";
            }
        }

        return {
            apiConfiguration: {
                apiProvider,
                apiModelId,
                apiKey,
                openRouterApiKey,
                awsAccessKey,
                awsSecretKey,
                awsSessionToken,
                awsRegion,
                awsUseCrossRegionInference,
                vertexProjectId,
                vertexRegion,
                openAiBaseUrl,
                openAiApiKey,
                openAiModelId,
                ollamaModelId,
                ollamaBaseUrl,
                lmStudioModelId,
                lmStudioBaseUrl,
                anthropicBaseUrl,
                geminiApiKey,
                openAiNativeApiKey,
                azureApiVersion,
                openRouterModelId,
                openRouterModelInfo,
            },
            lastShownAnnouncementId,
            customInstructions,
            alwaysAllowReadOnly: alwaysAllowReadOnly ?? false,
            taskHistory,
        };
    }

    async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
        const history = ((await this.getGlobalState("taskHistory")) as HistoryItem[]) || [];
        const existingItemIndex = history.findIndex((h) => h.id === item.id);
        if (existingItemIndex !== -1) {
            history[existingItemIndex] = item;
        } else {
            history.push(item);
        }
        await this.updateGlobalState("taskHistory", history);
        return history;
    }

    async updateGlobalState(key: GlobalStateKey, value: any) {
        await this.context.globalState.update(key, value);
    }

    async getGlobalState(key: GlobalStateKey) {
        return await this.context.globalState.get(key);
    }

    private async updateWorkspaceState(key: string, value: any) {
        await this.context.workspaceState.update(key, value);
    }

    private async getWorkspaceState(key: string) {
        return await this.context.workspaceState.get(key);
    }

    private async storeSecret(key: SecretKey, value?: string) {
        if (value) {
            await this.context.secrets.store(key, value);
        } else {
            await this.context.secrets.delete(key);
        }
    }

    private async getSecret(key: SecretKey) {
        return await this.context.secrets.get(key);
    }

    async resetState() {
        jetbrains.window.showInformationMessage("Resetting state...");
        for (const key of this.context.globalState.keys()) {
            await this.context.globalState.update(key, undefined);
        }
        const secretKeys: SecretKey[] = [
            "apiKey",
            "openRouterApiKey",
            "awsAccessKey",
            "awsSecretKey",
            "awsSessionToken",
            "openAiApiKey",
            "geminiApiKey",
            "openAiNativeApiKey",
        ];
        for (const key of secretKeys) {
            await this.storeSecret(key, undefined);
        }
        if (this.cline) {
            this.cline.abortTask();
            this.cline = undefined;
        }
        jetbrains.window.showInformationMessage("State reset");
        await this.postStateToWebview();
        await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" });
    }
}
