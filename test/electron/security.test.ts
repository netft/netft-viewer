import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const filesystemHooks = vi.hoisted(() => ({
  afterOpen: undefined as ((path: string) => Promise<void> | void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...arguments_: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...arguments_);
      try {
        await filesystemHooks.afterOpen?.(String(arguments_[0]));
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
  };
});

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
import rendererViteConfig from "../../vite.renderer.config";
import {
  bindApplicationLifecycle,
  buildRendererAssetSnapshot,
  CONTENT_SECURITY_POLICY,
  createViewerWindow,
  installRendererProtocol,
  installSessionSecurity,
  MAXIMUM_RENDERER_ASSET_BYTES,
  registerRendererScheme,
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

  it("installs the restrictive production CSP on header and document", async () => {
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
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/\bws(?:s)?:/);
    expect(CONTENT_SECURITY_POLICY).not.toContain("localhost");
    const html = await readFile(resolve("app/renderer/index.html"), "utf8");
    const metaPolicy = html.match(
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
    )?.[1];
    expect(metaPolicy).toBe(CONTENT_SECURITY_POLICY);
  });

  it("allows loopback HMR websockets only in the development header and document", async () => {
    const session = fakeSession();
    (
      installSessionSecurity as (
        target: ViewerSession,
        development: boolean,
      ) => void
    )(session, true);
    let responseHeaders: Record<string, string[]> | undefined;
    session.headersListener?.({ responseHeaders: {} }, (response) => {
      responseHeaders = response.responseHeaders;
    });
    const developmentPolicy =
      responseHeaders?.["Content-Security-Policy"]?.[0] ?? "";
    expect(developmentPolicy).toContain("ws://127.0.0.1:*");
    expect(developmentPolicy).toContain("ws://localhost:*");
    expect(CONTENT_SECURITY_POLICY).not.toContain("ws://");

    expect(typeof rendererViteConfig).toBe("function");
    if (typeof rendererViteConfig !== "function") {
      return;
    }
    const config = rendererViteConfig({
      command: "serve",
      mode: "development",
      isPreview: false,
      isSsrBuild: false,
    });
    const plugins = (Array.isArray(config.plugins)
      ? config.plugins.flat()
      : []) as unknown as Array<{
      name?: string;
      transformIndexHtml?: (
        html: string,
        context: never,
      ) => Promise<string | { html: string }> | string | { html: string };
    }>;
    const cspPlugin = plugins.find(
      (plugin) => plugin.name === "netft-viewer-csp",
    );
    expect(cspPlugin).toBeDefined();
    if (
      cspPlugin === undefined ||
      typeof cspPlugin.transformIndexHtml !== "function"
    ) {
      return;
    }
    const html = await readFile(resolve("app/renderer/index.html"), "utf8");
    const transformed = await cspPlugin.transformIndexHtml(html, {} as never);
    const output =
      typeof transformed === "string" ? transformed : transformed.html;
    const metaPolicy = output.match(
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
    )?.[1];
    expect(metaPolicy).toBe(developmentPolicy);
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

  it("uses a fixed local renderer origin for packaged assets", () => {
    expect(resolveRendererAssetUrl()).toBe("netft-viewer://app/index.html");
  });

  it("registers a secure standard renderer scheme before use", () => {
    const protocol = {
      registerSchemesAsPrivileged: vi.fn(),
    };

    registerRendererScheme(protocol);

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: "netft-viewer",
        privileges: {
          corsEnabled: false,
          secure: true,
          standard: true,
          supportFetchAPI: true,
        },
      },
    ]);
  });

  it("serves only allowlisted renderer files below the fixed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "netft-renderer-protocol-"));
    const outside = await mkdtemp(join(tmpdir(), "netft-renderer-outside-"));
    await writeFile(join(root, "index.html"), "<main></main>", "utf8");
    await writeFile(join(root, "asset.js"), "export {};", "utf8");
    await writeFile(join(root, "data.json"), "{}", "utf8");
    await writeFile(join(outside, "outside.js"), "export const escaped = 1;");
    const snapshot = await buildRendererAssetSnapshot(root);
    let handler: ((request: Request) => Promise<Response>) | undefined;
    installRendererProtocol(
      {
        handle: vi.fn((_scheme, registered) => {
          handler = registered;
        }),
      },
      snapshot,
    );

    const index = await handler?.(new Request("netft-viewer://app/index.html"));
    expect(index?.status).toBe(200);
    expect(await index?.text()).toBe("<main></main>");
    expect(index?.headers.get("content-type")).toBe("text/html; charset=utf-8");

    for (const url of [
      "netft-viewer://foreign/index.html",
      "netft-viewer://app/data.json",
      "netft-viewer://app/%2e%2e%2foutside.js",
      "netft-viewer://app/missing.js",
    ]) {
      expect((await handler?.(new Request(url)))?.status).toBe(404);
    }

    await unlink(join(root, "asset.js"));
    await symlink(join(outside, "outside.js"), join(root, "asset.js"));
    const snapshotted = await handler?.(
      new Request("netft-viewer://app/asset.js"),
    );
    expect(snapshotted?.status).toBe(200);
    expect(await snapshotted?.text()).toBe("export {};");

    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  });

  it("rejects symlinked and broken renderer assets during snapshot", async () => {
    const outside = await mkdtemp(join(tmpdir(), "netft-renderer-outside-"));
    await writeFile(join(outside, "outside.js"), "export {};");
    for (const target of [
      join(outside, "outside.js"),
      join(outside, "missing.js"),
    ]) {
      const root = await mkdtemp(join(tmpdir(), "netft-renderer-protocol-"));
      await writeFile(join(root, "index.html"), "<main></main>", "utf8");
      await symlink(target, join(root, "asset.js"));
      await expect(buildRendererAssetSnapshot(root)).rejects.toThrow();
      await rm(root, { force: true, recursive: true });
    }
    await rm(outside, { force: true, recursive: true });
  });

  it("never follows a renderer path replaced after its handle opens", async () => {
    const root = await mkdtemp(join(tmpdir(), "netft-renderer-protocol-"));
    const outside = await mkdtemp(join(tmpdir(), "netft-renderer-outside-"));
    const assetPath = join(root, "asset.js");
    await writeFile(join(root, "index.html"), "<main></main>", "utf8");
    await writeFile(assetPath, "export const trusted = true;", "utf8");
    await writeFile(
      join(outside, "outside.js"),
      "export const escaped = true;",
      "utf8",
    );
    let replaced = false;
    filesystemHooks.afterOpen = async (path) => {
      if (path === assetPath) {
        await unlink(assetPath);
        await symlink(join(outside, "outside.js"), assetPath);
        replaced = true;
      }
    };

    try {
      await expect(buildRendererAssetSnapshot(root)).rejects.toThrow(
        "renderer asset changed while opening",
      );
      expect(replaced).toBe(true);
    } finally {
      filesystemHooks.afterOpen = undefined;
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects a renderer asset above the fixed per-file byte limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "netft-renderer-protocol-"));
    await writeFile(join(root, "index.html"), "<main></main>", "utf8");
    await writeFile(
      join(root, "oversized.js"),
      Buffer.alloc(MAXIMUM_RENDERER_ASSET_BYTES + 1),
    );
    await expect(buildRendererAssetSnapshot(root)).rejects.toThrow();
    await rm(root, { force: true, recursive: true });
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

  it("stops and quits when the last macOS window closes", async () => {
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
      platform: "darwin",
      cleanupIpc: vi.fn(),
      supervisor: { stop },
      closeLogs,
    });
    app.emit("window-all-closed");
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    expect(stop).toHaveBeenCalledOnce();
    expect(closeLogs).toHaveBeenCalledOnce();
  });

  it("coalesces overlapping last-window and explicit quit signals", async () => {
    const window = new FakeBrowserWindow({
      webPreferences: {},
    });
    let finishStop: (() => void) | undefined;
    const stop = vi.fn(
      async () =>
        new Promise<void>((resolveStop) => {
          finishStop = resolveStop;
        }),
    );
    const cleanupIpc = vi.fn();
    const closeLogs = vi.fn();
    const repeatedQuitPreventDefault = vi.fn();
    const app = Object.assign(new EventEmitter(), {
      quit: vi.fn<() => void>(),
    });
    app.quit.mockImplementation(() => {
      app.emit("before-quit", {
        preventDefault: repeatedQuitPreventDefault,
      });
    });
    const overlappingQuitPreventDefault = vi.fn();

    bindApplicationLifecycle({
      app,
      window,
      platform: "darwin",
      cleanupIpc,
      supervisor: { stop },
      closeLogs,
    });
    app.emit("window-all-closed");
    app.emit("window-all-closed");
    app.emit("before-quit", {
      preventDefault: overlappingQuitPreventDefault,
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    finishStop?.();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    expect(overlappingQuitPreventDefault).toHaveBeenCalledOnce();
    expect(repeatedQuitPreventDefault).not.toHaveBeenCalled();
    expect(cleanupIpc).toHaveBeenCalledOnce();
    expect(closeLogs).toHaveBeenCalledOnce();
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
