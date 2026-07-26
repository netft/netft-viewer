import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  BrowserWindowConstructorOptions,
  OnHeadersReceivedListenerDetails,
} from "electron";

import { CompanionSupervisor } from "./companion-supervisor";
import { DialogService } from "./dialog-service";
import { registerIpcHandlers } from "./ipc-handlers";
import { LogStore } from "./log-store";
import { SettingsStore } from "./settings-store";

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
  once(event: "destroyed", listener: () => void): this;
  setWindowOpenHandler(
    handler: (details: { url: string }) => WindowOpenResult,
  ): void;
  send(channel: string, value: unknown): void;
}

export interface BrowserWindowLike {
  readonly webContents: ViewerWebContents;
  once(event: "ready-to-show", listener: () => void): this;
  once(event: "closed", listener: () => void): this;
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
      candidate.host === allowed.host &&
      candidate.hostname === allowed.hostname &&
      candidate.port === allowed.port &&
      candidate.pathname === allowed.pathname &&
      candidate.search === allowed.search &&
      candidate.hash === allowed.hash &&
      allowed.username.length === 0 &&
      allowed.password.length === 0 &&
      candidate.username === allowed.username &&
      candidate.password === allowed.password
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
  if (
    typeof NETFT_VIEWER_E2E_BUILD === "boolean" &&
    NETFT_VIEWER_E2E_BUILD &&
    options.packaged
  ) {
    return resolve(options.resourcesPath, "fake-companion.mjs");
  }
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

const RENDERER_SCHEME = "netft-viewer";
const RENDERER_HOST = "app";
const RENDERER_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export interface RendererProtocol {
  handle(
    scheme: string,
    handler: (request: Request) => Promise<Response>,
  ): void;
  registerSchemesAsPrivileged(
    customSchemes: {
      scheme: string;
      privileges: {
        corsEnabled: boolean;
        secure: boolean;
        standard: boolean;
        supportFetchAPI: boolean;
      };
    }[],
  ): void;
}

export const registerRendererScheme = (
  protocol: Pick<RendererProtocol, "registerSchemesAsPrivileged">,
): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: {
        corsEnabled: false,
        secure: true,
        standard: true,
        supportFetchAPI: true,
      },
    },
  ]);
};

export const installRendererProtocol = (
  protocol: Pick<RendererProtocol, "handle">,
  rendererRoot: string,
): void => {
  if (!isAbsolute(rendererRoot)) {
    throw new Error("renderer root must be absolute");
  }
  const trustedRoot = resolve(rendererRoot);
  protocol.handle(RENDERER_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== `${RENDERER_SCHEME}:` ||
        url.hostname !== RENDERER_HOST ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.port.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        return new Response(null, { status: 404 });
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes("\0")) {
        return new Response(null, { status: 404 });
      }
      const candidate = resolve(trustedRoot, `.${pathname}`);
      const child = relative(trustedRoot, candidate);
      const contentType = RENDERER_CONTENT_TYPES[extname(candidate)];
      if (
        child.length === 0 ||
        child.startsWith("..") ||
        isAbsolute(child) ||
        contentType === undefined
      ) {
        return new Response(null, { status: 404 });
      }
      return new Response(await readFile(candidate), {
        headers: {
          "Content-Type": contentType,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
};

export const resolveRendererAssetUrl = (): string =>
  `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;

interface QuitEvent {
  preventDefault(): void;
}

export interface ViewerApplication {
  on(event: "before-quit", listener: (event: QuitEvent) => void): unknown;
  on(event: "window-all-closed", listener: () => void): unknown;
  quit(): void;
}

export interface BindApplicationLifecycleOptions {
  app: ViewerApplication;
  window: BrowserWindowLike;
  platform: NodeJS.Platform;
  cleanupIpc: () => void;
  supervisor: Pick<CompanionSupervisor, "stop">;
  closeLogs: () => void;
}

export const bindApplicationLifecycle = (
  options: BindApplicationLifecycleOptions,
): void => {
  let rendererCleaned = false;
  let shutdownPromise: Promise<void> | undefined;
  let allowQuit = false;
  let quitRequested = false;

  const cleanupRenderer = (): void => {
    if (rendererCleaned) {
      return;
    }
    rendererCleaned = true;
    try {
      options.cleanupIpc();
    } catch {
      // Cleanup is best-effort and must not block backend shutdown.
    }
  };
  const shutdown = (): Promise<void> => {
    cleanupRenderer();
    shutdownPromise ??= Promise.resolve()
      .then(async () => options.supervisor.stop())
      .catch(() => {
        // Backend shutdown failure must not trap the application.
      })
      .finally(() => {
        try {
          options.closeLogs();
        } catch {
          // Log cleanup is best-effort during application teardown.
        }
      });
    return shutdownPromise;
  };
  const requestQuitAfterShutdown = (): void => {
    if (quitRequested) {
      return;
    }
    quitRequested = true;
    void shutdown().then(() => {
      allowQuit = true;
      options.app.quit();
    });
  };

  options.window.webContents.once("destroyed", cleanupRenderer);
  options.window.once("closed", cleanupRenderer);
  options.app.on("window-all-closed", () => {
    requestQuitAfterShutdown();
  });
  options.app.on("before-quit", (event) => {
    if (allowQuit) {
      return;
    }
    event.preventDefault();
    requestQuitAfterShutdown();
  });
};

const boot = async (): Promise<void> => {
  const { app, BrowserWindow, dialog, ipcMain, protocol, session } =
    await import("electron");
  registerRendererScheme(protocol);
  await app.whenReady();
  installSessionSecurity(session.defaultSession);
  const developmentRendererUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string" &&
    MAIN_WINDOW_VITE_DEV_SERVER_URL.length > 0
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : undefined;
  if (developmentRendererUrl === undefined) {
    installRendererProtocol(
      protocol,
      join(app.getAppPath(), ".vite", "renderer", MAIN_WINDOW_VITE_NAME),
    );
  }
  const rendererUrl = developmentRendererUrl ?? resolveRendererAssetUrl();
  const window = await createViewerWindow({
    BrowserWindow,
    preloadPath: join(__dirname, "preload.js"),
    rendererUrl,
  });
  const logs = new LogStore(app.getPath("logs"));
  const settings = new SettingsStore(app.getPath("userData"));
  const dialogs = new DialogService({ dialog });
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
    selectRecordingPath: async () => dialogs.selectRecordingPath(),
    confirmBias: async () => dialogs.confirmBias(),
    settings,
  });
  bindApplicationLifecycle({
    app,
    window,
    platform: process.platform,
    cleanupIpc,
    supervisor,
    closeLogs: () => logs.close(),
  });
  await supervisor.start();
};

if (process.versions.electron !== undefined) {
  void boot();
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const NETFT_VIEWER_E2E_BUILD: boolean;
