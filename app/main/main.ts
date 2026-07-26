import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  BrowserWindowConstructorOptions,
  OnHeadersReceivedListenerDetails,
} from "electron";

import { CompanionSupervisor } from "./companion-supervisor";
import { registerIpcHandlers } from "./ipc-handlers";
import { LogStore } from "./log-store";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

interface NavigationEvent {
  preventDefault(): void;
}

interface WindowOpenResult {
  action: "deny";
}

export interface ViewerWebContents {
  readonly mainFrame: { url: string };
  on(
    event: "will-navigate",
    listener: (event: NavigationEvent, url: string) => void,
  ): this;
  on(
    event: "will-attach-webview",
    listener: (event: NavigationEvent) => void,
  ): this;
  setWindowOpenHandler(
    handler: (details: { url: string }) => WindowOpenResult,
  ): void;
  send(channel: string, value: unknown): void;
}

export interface BrowserWindowLike {
  readonly webContents: ViewerWebContents;
  once(event: "ready-to-show", listener: () => void): this;
  show(): void;
  loadURL(url: string): Promise<void>;
}

type BrowserWindowConstructor = new (
  options: BrowserWindowConstructorOptions,
) => BrowserWindowLike;

export interface CreateViewerWindowOptions {
  BrowserWindow: BrowserWindowConstructor;
  preloadPath: string;
  rendererUrl: string;
}

export interface ViewerSession {
  webRequest: {
    onHeadersReceived(
      listener: (
        details: OnHeadersReceivedListenerDetails,
        callback: (response: {
          cancel?: boolean;
          responseHeaders?: Record<string, string[]>;
        }) => void,
      ) => void,
    ): void;
  };
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: unknown,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: unknown,
    ) => boolean,
  ): void;
}

const equivalentRendererLocation = (
  candidateValue: string,
  allowedValue: string,
): boolean => {
  try {
    const candidate = new URL(candidateValue);
    const allowed = new URL(allowedValue);
    return (
      candidate.protocol === allowed.protocol &&
      candidate.origin === allowed.origin &&
      candidate.pathname === allowed.pathname &&
      candidate.search === allowed.search &&
      candidate.username.length === 0 &&
      candidate.password.length === 0
    );
  } catch {
    return false;
  }
};

export const createViewerWindow = async (
  options: CreateViewerWindowOptions,
): Promise<BrowserWindowLike> => {
  if (!isAbsolute(options.preloadPath)) {
    throw new Error("invalid preload path");
  }
  const window = new options.BrowserWindow({
    width: 1_440,
    height: 900,
    minWidth: 1_024,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: resolve(options.preloadPath),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!equivalentRendererLocation(url, options.rendererUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => {
    window.show();
  });
  await window.loadURL(options.rendererUrl);
  return window;
};

export const installSessionSecurity = (session: ViewerSession): void => {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
      },
    });
  });
};

export interface CompanionPathOptions {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
}

export const resolveCompanionExecutable = (
  options: CompanionPathOptions,
): string => {
  const platform = options.platform ?? process.platform;
  const executable =
    platform === "win32"
      ? "netft-viewer-companion.exe"
      : "netft-viewer-companion";
  return options.packaged
    ? resolve(options.resourcesPath, "companion", executable)
    : resolve(
        options.appPath,
        "build",
        "native",
        "core",
        "companion",
        executable,
      );
};

export const resolveRendererAssetUrl = (
  buildDirectory: string,
  rendererName: string,
): string =>
  pathToFileURL(
    join(buildDirectory, "..", "renderer", rendererName, "index.html"),
  ).toString();

const boot = async (): Promise<void> => {
  const { app, BrowserWindow, dialog, ipcMain, session } =
    await import("electron");
  await app.whenReady();
  installSessionSecurity(session.defaultSession);
  const rendererUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string" &&
    MAIN_WINDOW_VITE_DEV_SERVER_URL.length > 0
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : resolveRendererAssetUrl(__dirname, MAIN_WINDOW_VITE_NAME);
  const window = await createViewerWindow({
    BrowserWindow,
    preloadPath: join(__dirname, "preload.js"),
    rendererUrl,
  });
  const logs = new LogStore(app.getPath("logs"));
  const supervisor = new CompanionSupervisor({
    executablePath: resolveCompanionExecutable({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    expectedAppVersion: app.getVersion(),
    expectedCoreSnapshot: "e424c401587052f03de9b94f76f1e86b78902105",
    logStore: logs,
  });
  const cleanupIpc = registerIpcHandlers({
    ipcMain,
    trustedWebContents: window.webContents,
    supervisor,
    selectRecordingPath: async () => {
      const result = await dialog.showSaveDialog({
        defaultPath: "netft-recording.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (result.canceled || result.filePath.length === 0) {
        return undefined;
      }
      return {
        targetPath: result.filePath,
        overwrite: existsSync(result.filePath),
      };
    },
    confirmBias: async () => {
      const result = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Cancel", "Apply Bias"],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
        message: "Apply sensor bias only under a safe and stable load.",
      });
      return result.response === 1;
    },
  });
  await supervisor.start();
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    quitting = true;
    cleanupIpc();
    void supervisor.stop().finally(() => {
      logs.close();
      app.quit();
    });
  });
};

if (process.versions.electron !== undefined) {
  void boot();
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
