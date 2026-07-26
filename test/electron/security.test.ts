import { EventEmitter } from "node:events";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import forgeConfig from "../../forge.config";
import {
  bindApplicationLifecycle,
  CONTENT_SECURITY_POLICY,
  createViewerWindow,
  installSessionSecurity,
  resolveCompanionExecutable,
  resolveRendererAssetUrl,
  type BrowserWindowLike,
  type ViewerSession,
} from "../../app/main/main";
import {
  IPC_CHANNELS,
  registerIpcHandlers,
  type IpcMainLike,
} from "../../app/main/ipc-handlers";
import { createNetftApi, type IpcRendererLike } from "../../app/preload";

class FakeWebContents extends EventEmitter {
  readonly mainFrame = { url: "file:///application/index.html" };
  readonly setWindowOpenHandler = vi.fn();
  readonly send = vi.fn();
}

class FakeBrowserWindow extends EventEmitter implements BrowserWindowLike {
  static lastOptions: Electron.BrowserWindowConstructorOptions | undefined;

  readonly webContents = new FakeWebContents();
  readonly show = vi.fn();
  readonly loadURL = vi.fn(async (url: string) => {
    this.webContents.mainFrame.url = url;
  });

  constructor(options: Electron.BrowserWindowConstructorOptions) {
    super();
    FakeBrowserWindow.lastOptions = options;
  }
}

const fakeSession = (): ViewerSession & {
  headersListener?: (
    details: unknown,
    callback: (response: { responseHeaders: Record<string, string[]> }) => void,
  ) => void;
} => {
  const session = {
    headersListener: undefined,
    webRequest: {
      onHeadersReceived: vi.fn((listener) => {
        session.headersListener = listener;
      }),
    },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  return session;
};

describe("Electron window security", () => {
  it("constructs the actual viewer window with an isolated sandbox", async () => {
    await createViewerWindow({
      BrowserWindow: FakeBrowserWindow,
      preloadPath: resolve("preload.js"),
      rendererUrl: "file:///application/index.html",
    });

    expect(FakeBrowserWindow.lastOptions?.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
    expect(
      isAbsolute(FakeBrowserWindow.lastOptions?.webPreferences?.preload ?? ""),
    ).toBe(true);
  });

  it("denies external navigation and every renderer-created window", async () => {
    const window = (await createViewerWindow({
      BrowserWindow: FakeBrowserWindow,
      preloadPath: resolve("preload.js"),
      rendererUrl: "file:///application/index.html",
    })) as FakeBrowserWindow;
    const navigation = {
      preventDefault: vi.fn(),
    };

    window.webContents.emit(
      "will-navigate",
      navigation,
      "https://example.invalid/",
    );
    const openHandler = window.webContents.setWindowOpenHandler.mock
      .calls[0]?.[0] as (details: { url: string }) => { action: string };

    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    expect(openHandler({ url: "file:///application/index.html" })).toEqual({
      action: "deny",
    });
  });

  it("rejects a remote-host file URL even when its path matches", async () => {
    const window = (await createViewerWindow({
      BrowserWindow: FakeBrowserWindow,
      preloadPath: resolve("preload.js"),
      rendererUrl: "file:///application/index.html",
    })) as FakeBrowserWindow;
    const navigation = { preventDefault: vi.fn() };

    window.webContents.emit(
      "will-navigate",
      navigation,
      "file://remote-host/application/index.html",
    );

    expect(navigation.preventDefault).toHaveBeenCalledOnce();
  });

  it("rejects a changed packaged-file fragment by explicit policy", async () => {
    const window = (await createViewerWindow({
      BrowserWindow: FakeBrowserWindow,
      preloadPath: resolve("preload.js"),
      rendererUrl: "file:///application/index.html",
    })) as FakeBrowserWindow;
    const navigation = { preventDefault: vi.fn() };

    window.webContents.emit(
      "will-navigate",
      navigation,
      "file:///application/index.html#unexpected",
    );

    expect(navigation.preventDefault).toHaveBeenCalledOnce();
  });

  it("shows the shell only after local renderer content is ready", async () => {
    const window = (await createViewerWindow({
      BrowserWindow: FakeBrowserWindow,
      preloadPath: resolve("preload.js"),
      rendererUrl: "file:///application/index.html",
    })) as FakeBrowserWindow;

    expect(window.show).not.toHaveBeenCalled();
    window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledOnce();
  });

  it("installs the restrictive CSP on the actual renderer session", () => {
    const session = fakeSession();
    installSessionSecurity(session);
    let responseHeaders: Record<string, string[]> | undefined;

    session.headersListener?.(
      { responseHeaders: { Existing: ["value"] } },
      (response) => {
        responseHeaders = response.responseHeaders;
      },
    );

    expect(responseHeaders?.["Content-Security-Policy"]).toEqual([
      CONTENT_SECURITY_POLICY,
    ]);
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:\/\/[^; ]+/);
  });

  it("configures ASAR integrity and disables Node execution through Forge", () => {
    const fusesPlugin = forgeConfig.plugins?.find(
      (plugin) => typeof plugin === "object" && plugin?.name === "fuses",
    ) as { fusesConfig?: Record<number | "version", boolean | string> };

    expect(fusesPlugin.fusesConfig).toMatchObject({
      0: false,
      2: false,
      3: false,
      4: true,
      5: true,
      version: "1",
    });
  });

  it("resolves companion executables from configured application directories", () => {
    const resourcesPath = resolve("packaged-resources");
    const appPath = resolve("development-app");

    expect(
      resolveCompanionExecutable({
        packaged: true,
        resourcesPath,
        appPath,
        platform: "win32",
      }),
    ).toBe(resolve(resourcesPath, "companion", "netft-viewer-companion.exe"));
    expect(
      resolveCompanionExecutable({
        packaged: false,
        resourcesPath,
        appPath,
        platform: "darwin",
      }),
    ).toBe(
      resolve(
        appPath,
        "build",
        "native",
        "core",
        "companion",
        "netft-viewer-companion",
      ),
    );
  });

  it("encodes the packaged renderer URL without string-built file paths", () => {
    const buildDirectory = resolve("path with spaces", ".vite", "build");

    expect(resolveRendererAssetUrl(buildDirectory, "main_window")).toBe(
      pathToFileURL(
        join(buildDirectory, "..", "renderer", "main_window", "index.html"),
      ).toString(),
    );
  });
});

describe("narrow renderer IPC", () => {
  it("registers only fixed channels and rejects a foreign frame", async () => {
    const handlers = new Map<string, Parameters<IpcMainLike["handle"]>[1]>();
    const ipcMain: IpcMainLike = {
      handle: vi.fn((channel, handler) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    };
    const trusted = new FakeWebContents();
    const commands = {
      command: vi.fn(),
      retry: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    registerIpcHandlers({
      ipcMain,
      trustedWebContents: trusted,
      supervisor: commands,
      selectRecordingPath: async () => ({
        targetPath: resolve("capture.csv"),
        overwrite: false,
      }),
    });

    expect(new Set(handlers.keys())).toEqual(
      new Set(
        Object.values(IPC_CHANNELS).filter(
          (channel) => channel !== IPC_CHANNELS.event,
        ),
      ),
    );
    await expect(
      Promise.resolve().then(() =>
        handlers.get(IPC_CHANNELS.disconnect)?.({
          sender: trusted,
          senderFrame: { url: trusted.mainFrame.url },
        }),
      ),
    ).rejects.toThrow();
    expect(commands.command).not.toHaveBeenCalled();
  });

  it("starts recording only with an absolute path selected by main", async () => {
    const handlers = new Map<string, Parameters<IpcMainLike["handle"]>[1]>();
    const trusted = new FakeWebContents();
    const supervisor = {
      command: vi.fn(async () => ({ success: true })),
      retry: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    registerIpcHandlers({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: vi.fn(),
      },
      trustedWebContents: trusted,
      supervisor,
      selectRecordingPath: async () => ({
        targetPath: resolve("capture.csv"),
        overwrite: false,
      }),
    });
    const event = { sender: trusted, senderFrame: trusted.mainFrame };

    await handlers.get(IPC_CHANNELS.startRecording)?.(event);

    expect(supervisor.command).toHaveBeenCalledWith("start_recording", {
      targetPath: resolve("capture.csv"),
      overwrite: false,
    });
  });

  it("exposes typed methods without raw IPC and removes subscriptions", async () => {
    const emitter = new EventEmitter();
    const ipcRenderer: IpcRendererLike = {
      invoke: vi.fn(async () => ({ success: true })),
      on: vi.fn((channel, listener) => {
        emitter.on(channel, listener);
        return ipcRenderer;
      }),
      removeListener: vi.fn((channel, listener) => {
        emitter.removeListener(channel, listener);
        return ipcRenderer;
      }),
    };
    const api = createNetftApi(ipcRenderer);
    const listener = vi.fn();

    const unsubscribe = api.subscribe(listener);
    emitter.emit(IPC_CHANNELS.event, {}, { type: "backend_disconnected" });
    unsubscribe();
    emitter.emit(IPC_CHANNELS.event, {}, { type: "backend_disconnected" });

    expect(listener).toHaveBeenCalledOnce();
    expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api.startRecording.length).toBe(0);
  });

  it("isolates a destroyed renderer and removes its supervisor subscription", () => {
    const trusted = new FakeWebContents();
    const unsubscribe = vi.fn();
    const supervisorListener: Array<(event: { type: string }) => void> = [];
    const supervisor = {
      command: vi.fn(),
      retry: vi.fn(),
      subscribe: vi.fn((listener) => {
        supervisorListener.push(listener);
        return unsubscribe;
      }),
    };
    const removeHandler = vi.fn();
    const cleanup = registerIpcHandlers({
      ipcMain: {
        handle: vi.fn(),
        removeHandler,
      },
      trustedWebContents: trusted,
      supervisor,
      selectRecordingPath: async () => undefined,
    });
    removeHandler.mockClear();
    cleanup();
    cleanup();
    trusted.send.mockImplementation(() => {
      throw new Error("renderer destroyed");
    });

    expect(() =>
      supervisorListener[0]?.({ type: "backend_disconnected" }),
    ).not.toThrow();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(removeHandler).toHaveBeenCalledTimes(
      Object.values(IPC_CHANNELS).length - 1,
    );
  });
});

describe("application lifecycle", () => {
  it("cleans renderer IPC when its web contents is destroyed", () => {
    const window = new FakeBrowserWindow({
      webPreferences: {},
    });
    const cleanupIpc = vi.fn();
    const app = Object.assign(new EventEmitter(), {
      quit: vi.fn<() => void>(),
    });

    bindApplicationLifecycle({
      app,
      window,
      platform: "linux",
      cleanupIpc,
      supervisor: { stop: vi.fn(async () => {}) },
      closeLogs: vi.fn(),
    });
    window.webContents.emit("destroyed");
    window.emit("closed");

    expect(cleanupIpc).toHaveBeenCalledOnce();
  });

  it("stops the backend on window-all-closed and applies platform quit policy", async () => {
    const window = new FakeBrowserWindow({
      webPreferences: {},
    });
    const app = Object.assign(new EventEmitter(), {
      quit: vi.fn<() => void>(),
    });
    const stop = vi.fn(async () => {});
    const closeLogs = vi.fn();

    bindApplicationLifecycle({
      app,
      window,
      platform: "linux",
      cleanupIpc: vi.fn(),
      supervisor: { stop },
      closeLogs,
    });
    app.emit("window-all-closed");
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    expect(stop).toHaveBeenCalledOnce();
    expect(closeLogs).toHaveBeenCalledOnce();
  });

  it("stops without quitting when the last macOS window closes", async () => {
    const window = new FakeBrowserWindow({
      webPreferences: {},
    });
    const app = Object.assign(new EventEmitter(), {
      quit: vi.fn<() => void>(),
    });
    const stop = vi.fn(async () => {});

    bindApplicationLifecycle({
      app,
      window,
      platform: "darwin",
      cleanupIpc: vi.fn(),
      supervisor: { stop },
      closeLogs: vi.fn(),
    });
    app.emit("window-all-closed");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());

    expect(app.quit).not.toHaveBeenCalled();
  });

  it("stops and cleans resources before an explicit application quit", async () => {
    const window = new FakeBrowserWindow({
      webPreferences: {},
    });
    const app = Object.assign(new EventEmitter(), {
      quit: vi.fn<() => void>(),
    });
    const cleanupIpc = vi.fn();
    const stop = vi.fn(async () => {});
    const closeLogs = vi.fn();
    const preventDefault = vi.fn();

    bindApplicationLifecycle({
      app,
      window,
      platform: "linux",
      cleanupIpc,
      supervisor: { stop },
      closeLogs,
    });
    app.emit("before-quit", { preventDefault });
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(cleanupIpc).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(closeLogs).toHaveBeenCalledOnce();
  });
});
