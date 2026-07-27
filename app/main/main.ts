import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import {
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

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
export const MAXIMUM_RENDERER_ASSET_FILES = 256;
export const MAXIMUM_RENDERER_ASSET_BYTES = 8 * 1024 * 1024;
export const MAXIMUM_RENDERER_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_RENDERER_DIRECTORY_ENTRIES = 512;

interface RendererAsset {
  body: Buffer;
  contentType: string;
}

export type RendererAssetSnapshot = ReadonlyMap<string, RendererAsset>;

const escapesDirectory = (relativePath: string): boolean =>
  relativePath.length === 0 ||
  relativePath === ".." ||
  relativePath.startsWith(`..${sep}`) ||
  isAbsolute(relativePath);

const rendererUrlPath = (relativePath: string): string =>
  `/${relativePath.split(sep).join("/")}`;

const isSameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const openWithoutFollowing = async (path: string): Promise<FileHandle> => {
  try {
    return await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP") {
      throw error;
    }
    // Some non-POSIX hosts do not implement O_NOFOLLOW. The same-handle
    // identity checks below remain authoritative on those platforms.
    return open(path, constants.O_RDONLY);
  }
};

const openRendererAsset = async (
  candidate: string,
  realRoot: string,
): Promise<{ body: Buffer; relativePath: string }> => {
  const handle = await openWithoutFollowing(candidate);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new Error("renderer assets must be regular files");
    }
    if (openedMetadata.size > MAXIMUM_RENDERER_ASSET_BYTES) {
      throw new Error("renderer asset byte limit exceeded");
    }

    const pathMetadata = await lstat(candidate);
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      !isSameFile(openedMetadata, pathMetadata)
    ) {
      throw new Error("renderer asset changed while opening");
    }
    const openedRealPath = await realpath(candidate);
    const relativePath = relative(realRoot, openedRealPath);
    if (escapesDirectory(relativePath)) {
      throw new Error("renderer asset escapes real root");
    }
    const realMetadata = await lstat(openedRealPath);
    if (
      realMetadata.isSymbolicLink() ||
      !realMetadata.isFile() ||
      !isSameFile(openedMetadata, realMetadata)
    ) {
      throw new Error("renderer asset identity mismatch");
    }

    const body = await handle.readFile();
    if (body.byteLength > MAXIMUM_RENDERER_ASSET_BYTES) {
      throw new Error("renderer asset byte limit exceeded");
    }
    return { body, relativePath };
  } finally {
    await handle.close();
  }
};

type RendererAssetReader = (
  candidate: string,
  realCandidate: string,
  realRoot: string,
) => Promise<{ body: Buffer; relativePath: string }>;

const readImmutableArchiveAsset: RendererAssetReader = async (
  _candidate,
  realCandidate,
  realRoot,
) => {
  const metadata = await lstat(realCandidate);
  if (!metadata.isFile()) {
    throw new Error("renderer assets must be regular files");
  }
  if (metadata.size > MAXIMUM_RENDERER_ASSET_BYTES) {
    throw new Error("renderer asset byte limit exceeded");
  }
  const relativePath = relative(realRoot, realCandidate);
  if (escapesDirectory(relativePath)) {
    throw new Error("renderer asset escapes real root");
  }
  const body = await readFile(realCandidate);
  if (body.byteLength > MAXIMUM_RENDERER_ASSET_BYTES) {
    throw new Error("renderer asset byte limit exceeded");
  }
  return { body, relativePath };
};

const buildRendererSnapshot = async (
  rendererRoot: string,
  readAsset: RendererAssetReader,
): Promise<RendererAssetSnapshot> => {
  if (!isAbsolute(rendererRoot)) {
    throw new Error("renderer root must be absolute");
  }
  const trustedRoot = resolve(rendererRoot);
  const rootMetadata = await lstat(trustedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("unsafe renderer root");
  }
  const realRoot = await realpath(trustedRoot);
  const assets = new Map<string, RendererAsset>();
  let entryCount = 0;
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAXIMUM_RENDERER_DIRECTORY_ENTRIES) {
        throw new Error("renderer directory entry limit exceeded");
      }
      const candidate = resolve(directory, entry.name);
      const lexicalChild = relative(trustedRoot, candidate);
      if (escapesDirectory(lexicalChild)) {
        throw new Error("renderer asset escapes configured root");
      }
      const lexicalMetadata = await lstat(candidate);
      if (entry.isSymbolicLink() || lexicalMetadata.isSymbolicLink()) {
        throw new Error("renderer assets must not contain symbolic links");
      }
      const realCandidate = await realpath(candidate);
      const realChild = relative(realRoot, realCandidate);
      if (escapesDirectory(realChild)) {
        throw new Error("renderer asset escapes real root");
      }
      const realMetadata = await lstat(realCandidate);
      if (realMetadata.isDirectory()) {
        await visit(realCandidate);
        continue;
      }
      if (!realMetadata.isFile()) {
        throw new Error("renderer assets must be regular files");
      }
      const contentType = RENDERER_CONTENT_TYPES[extname(realCandidate)];
      if (contentType === undefined) {
        continue;
      }
      if (assets.size >= MAXIMUM_RENDERER_ASSET_FILES) {
        throw new Error("renderer asset file limit exceeded");
      }
      const { body, relativePath } = await readAsset(
        candidate,
        realCandidate,
        realRoot,
      );
      totalBytes += body.byteLength;
      if (totalBytes > MAXIMUM_RENDERER_SNAPSHOT_BYTES) {
        throw new Error("renderer snapshot byte limit exceeded");
      }
      assets.set(rendererUrlPath(relativePath), {
        body: Buffer.from(body),
        contentType,
      });
    }
  };

  await visit(realRoot);
  if (!assets.has("/index.html")) {
    throw new Error("renderer entry asset is missing");
  }
  return assets;
};

export const buildRendererAssetSnapshot = async (
  rendererRoot: string,
): Promise<RendererAssetSnapshot> =>
  buildRendererSnapshot(rendererRoot, async (candidate, _realCandidate, root) =>
    openRendererAsset(candidate, root),
  );

const buildPackagedRendererAssetSnapshot = async (
  applicationArchive: string,
  rendererRoot: string,
): Promise<RendererAssetSnapshot> => {
  const archive = resolve(applicationArchive);
  const root = resolve(rendererRoot);
  if (
    extname(archive) !== ".asar" ||
    escapesDirectory(relative(archive, root))
  ) {
    throw new Error("packaged renderer must reside in the application ASAR");
  }
  // Electron's ASAR entries have virtual metadata that cannot be matched to a
  // FileHandle inode. This path is restricted to the immutable application
  // archive; Forge also enables ASAR integrity and OnlyLoadAppFromAsar fuses.
  return buildRendererSnapshot(root, readImmutableArchiveAsset);
};

const canonicalRendererRequestPath = (url: URL): string | undefined => {
  const pathname = decodeURIComponent(url.pathname);
  if (
    pathname.includes("\0") ||
    pathname.includes("\\") ||
    !pathname.startsWith("/") ||
    posix.normalize(pathname) !== pathname
  ) {
    return undefined;
  }
  return pathname;
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
  snapshot: RendererAssetSnapshot,
): void => {
  const assets = new Map<string, RendererAsset>();
  for (const [path, asset] of snapshot) {
    assets.set(path, {
      body: Buffer.from(asset.body),
      contentType: asset.contentType,
    });
  }
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
      const pathname = canonicalRendererRequestPath(url);
      if (pathname === undefined) {
        return new Response(null, { status: 404 });
      }
      const asset = assets.get(pathname);
      if (asset === undefined) {
        return new Response(null, { status: 404 });
      }
      return new Response(Buffer.from(asset.body), {
        headers: {
          "Content-Type": asset.contentType,
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
      await buildPackagedRendererAssetSnapshot(
        app.getAppPath(),
        join(app.getAppPath(), ".vite", "renderer", MAIN_WINDOW_VITE_NAME),
      ),
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
