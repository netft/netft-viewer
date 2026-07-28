import { describe, expect, it, vi } from "vitest";

import {
  buildApplicationMenuTemplate,
  DEFAULT_MENU_STATE,
  installApplicationMenu,
  type ApplicationMenuIpcMain,
  type MenuCommand,
} from "../../app/main/application-menu";
import { IPC_CHANNELS } from "../../app/shared/ipc-channels";
import type { WindowCommand } from "../../app/shared/window-command";

type MenuItem = Electron.MenuItemConstructorOptions;

const itemById = (
  items: readonly MenuItem[],
  id: string,
): MenuItem | undefined => {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }
    if (Array.isArray(item.submenu)) {
      const nested = itemById(item.submenu, id);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
};

const click = (item: MenuItem | undefined): void => {
  if (typeof item?.click !== "function") {
    throw new Error("menu item is not actionable");
  }
  item.click({} as Electron.MenuItem, {} as Electron.BaseWindow, {
    triggeredByAccelerator: false,
  });
};

describe("application menu", () => {
  it("maps current viewer state to native enabled and checked properties", () => {
    const template = buildApplicationMenuTemplate({
      platform: "linux",
      state: {
        ...DEFAULT_MENU_STATE,
        backendRunning: true,
        connection: "streaming",
        paused: true,
        recordingActive: true,
        plotMode: "panels",
        timeWindowSeconds: 30,
        visibleAxes: ["Fx", "Fz", "Ty"],
      },
      sendCommand: vi.fn(),
      performWindowCommand: vi.fn(),
    });

    expect(itemById(template, "start-recording")?.enabled).toBe(false);
    expect(itemById(template, "stop-recording")?.enabled).toBe(true);
    expect(itemById(template, "bias")?.enabled).toBe(false);
    expect(itemById(template, "plot-panels")?.checked).toBe(true);
    expect(itemById(template, "time-window-30")?.checked).toBe(true);
    expect(itemById(template, "axis-Fx")?.checked).toBe(true);
    expect(itemById(template, "axis-Fy")?.checked).toBe(false);
  });

  it("emits viewer commands and bounded window commands", () => {
    const commands: MenuCommand[] = [];
    const windowCommands: WindowCommand[] = [];
    const template = buildApplicationMenuTemplate({
      platform: "linux",
      state: {
        ...DEFAULT_MENU_STATE,
        backendRunning: true,
        hasSensorHost: true,
      },
      sendCommand: (command) => commands.push(command),
      performWindowCommand: (command) => windowCommands.push(command),
    });

    click(itemById(template, "connection"));
    click(itemById(template, "plot-panels"));
    click(itemById(template, "time-window-60"));
    click(itemById(template, "axis-Tz"));
    click(itemById(template, "documentation"));
    click(itemById(template, "report-issue"));
    click(itemById(template, "about-netft"));
    click(itemById(template, "toggle-full-screen"));

    expect(commands).toEqual([
      { type: "connect" },
      { type: "set-plot-mode", mode: "panels" },
      { type: "set-time-window", seconds: 60 },
      { type: "toggle-axis", axis: "Tz" },
    ]);
    expect(windowCommands).toEqual([
      { type: "open-external", target: "documentation" },
      { type: "open-external", target: "issues" },
      { type: "open-external", target: "organization" },
      { type: "toggle-full-screen" },
    ]);
  });

  it("keeps native window conventions platform-specific", () => {
    const mac = buildApplicationMenuTemplate({
      platform: "darwin",
      state: DEFAULT_MENU_STATE,
      sendCommand: vi.fn(),
      performWindowCommand: vi.fn(),
    });
    const linux = buildApplicationMenuTemplate({
      platform: "linux",
      state: DEFAULT_MENU_STATE,
      sendCommand: vi.fn(),
      performWindowCommand: vi.fn(),
    });

    const linuxFile = linux[0]?.submenu;
    const macFile = mac[1]?.submenu;
    expect(
      Array.isArray(linuxFile) ? typeof linuxFile[0]?.click : undefined,
    ).toBe("function");
    expect(Array.isArray(macFile) ? macFile[0]?.role : undefined).toBe("close");
    expect(mac.some((item) => item.role === "windowMenu")).toBe(true);
    expect(itemById(mac, "exit")).toBeUndefined();
    expect(itemById(mac, "about-netft")?.role).toBeUndefined();
    expect(typeof itemById(linux, "exit")?.click).toBe("function");
    expect(linux.some((item) => item.role === "windowMenu")).toBe(false);
  });

  it("accepts macOS state only from the viewer main frame and sends commands back to it", () => {
    const listeners = new Map<
      string,
      Parameters<ApplicationMenuIpcMain["on"]>[1]
    >();
    const installed: Array<MenuItem[] | null> = [];
    const frame = { url: "netft-viewer://app/index.html" };
    const webContents = {
      mainFrame: frame,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const cleanup = installApplicationMenu({
      ipcMain: {
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
          if (listeners.get(channel) === listener) {
            listeners.delete(channel);
          }
        },
      },
      menu: {
        buildFromTemplate: (template) => template,
        setApplicationMenu: (menu) => installed.push(menu),
      },
      performWindowCommand: vi.fn(),
      platform: "darwin",
      trustedWebContents: webContents,
    });

    listeners.get(IPC_CHANNELS.menuState)?.(
      { sender: {} as never, senderFrame: frame },
      { ...DEFAULT_MENU_STATE, backendRunning: true, hasSensorHost: true },
    );
    expect(installed).toHaveLength(1);

    listeners.get(IPC_CHANNELS.menuState)?.(
      { sender: webContents, senderFrame: frame },
      { ...DEFAULT_MENU_STATE, backendRunning: true, hasSensorHost: true },
    );
    expect(installed).toHaveLength(2);
    click(itemById(installed.at(-1) ?? [], "connection"));
    expect(webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.menuCommand, {
      type: "connect",
    });

    cleanup();
    expect(listeners.has(IPC_CHANNELS.menuState)).toBe(false);
  });

  it("removes the native menu without subscribing on Windows and Linux", () => {
    const listeners = new Map<
      string,
      Parameters<ApplicationMenuIpcMain["on"]>[1]
    >();
    const installed: Array<MenuItem[] | null> = [];
    const frame = { url: "netft-viewer://app/index.html" };
    const webContents = {
      mainFrame: frame,
      isDestroyed: () => false,
      send: vi.fn(),
    };

    const cleanup = installApplicationMenu({
      ipcMain: {
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
          if (listeners.get(channel) === listener) {
            listeners.delete(channel);
          }
        },
      },
      menu: {
        buildFromTemplate: (template) => template,
        setApplicationMenu: (menu) => installed.push(menu),
      },
      performWindowCommand: vi.fn(),
      platform: "linux",
      trustedWebContents: webContents,
    });

    expect(installed).toEqual([null]);
    expect(listeners.size).toBe(0);
    cleanup();
    expect(listeners.size).toBe(0);
  });
});
