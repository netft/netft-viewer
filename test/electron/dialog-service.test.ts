import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DialogService,
  recordingFilename,
  type NativeDialog,
} from "../../app/main/dialog-service";
import {
  IPC_CHANNELS,
  registerIpcHandlers,
  type IpcMainLike,
} from "../../app/main/ipc-handlers";
import { DEFAULT_PREFERENCES } from "../../app/main/settings-store";

const temporaryDirectories: string[] = [];

const makeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "netft-viewer-dialog-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DialogService", () => {
  it("requires a fresh native confirmation for every completed Bias request", async () => {
    const showMessageBox = vi
      .fn<NativeDialog["showMessageBox"]>()
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 });
    const dialogs = new DialogService({
      dialog: {
        showMessageBox,
        showSaveDialog: vi.fn(),
      },
    });

    await expect(dialogs.confirmBias()).resolves.toBe(true);
    await expect(dialogs.confirmBias()).resolves.toBe(false);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(showMessageBox.mock.calls[0]?.[0]).not.toHaveProperty(
      "checkboxLabel",
    );
  });

  it("coalesces concurrent Bias confirmation requests", async () => {
    let finish: ((value: { response: number }) => void) | undefined;
    const showMessageBox = vi.fn(
      async () =>
        new Promise<{ response: number }>((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    const dialogs = new DialogService({
      dialog: {
        showMessageBox,
        showSaveDialog: vi.fn(),
      },
    });

    const first = dialogs.confirmBias();
    const second = dialogs.confirmBias();
    expect(showMessageBox).toHaveBeenCalledOnce();
    finish?.({ response: 1 });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("returns explicit overwrite authority only after native confirmation", async () => {
    const directory = makeDirectory();
    const targetPath = join(directory, "capture.csv");
    writeFileSync(targetPath, "existing", { mode: 0o600 });
    const showMessageBox = vi.fn(async () => ({ response: 1 }));
    const dialogs = new DialogService({
      dialog: {
        showMessageBox,
        showSaveDialog: vi.fn(async () => ({
          canceled: false,
          filePath: targetPath,
        })),
      },
      now: () => new Date("2026-07-27T01:02:03.000Z"),
    });

    await expect(dialogs.selectRecordingPath()).resolves.toEqual({
      targetPath: resolve(targetPath),
      overwrite: true,
    });
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it("sends no recording selection when overwrite is declined", async () => {
    const directory = makeDirectory();
    const targetPath = join(directory, "capture.csv");
    writeFileSync(targetPath, "existing");
    const dialogs = new DialogService({
      dialog: {
        showMessageBox: vi.fn(async () => ({ response: 0 })),
        showSaveDialog: vi.fn(async () => ({
          canceled: false,
          filePath: targetPath,
        })),
      },
    });

    await expect(dialogs.selectRecordingPath()).resolves.toBeUndefined();
  });

  it("rejects a symbolic-link recording target", async () => {
    const directory = makeDirectory();
    const regular = join(directory, "regular.csv");
    const link = join(directory, "capture.csv");
    writeFileSync(regular, "");
    symlinkSync(regular, link);
    const dialogs = new DialogService({
      dialog: {
        showMessageBox: vi.fn(),
        showSaveDialog: vi.fn(async () => ({
          canceled: false,
          filePath: link,
        })),
      },
    });

    await expect(dialogs.selectRecordingPath()).rejects.toThrow(
      /recording destination/,
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("proposes a portable timestamped CSV filename", async () => {
    const directory = makeDirectory();
    mkdirSync(join(directory, "captures"));
    const showSaveDialog = vi
      .fn<NativeDialog["showSaveDialog"]>()
      .mockResolvedValue({
        canceled: true,
        filePath: "",
      });
    const dialogs = new DialogService({
      dialog: {
        showMessageBox: vi.fn(),
        showSaveDialog,
      },
      now: () => new Date("2026-07-27T01:02:03.456Z"),
    });

    await dialogs.selectRecordingPath();

    const options = showSaveDialog.mock.calls[0]?.[0];
    expect(options?.defaultPath).toBe(
      recordingFilename(new Date("2026-07-27T01:02:03.456Z")),
    );
    expect(options?.defaultPath).toMatch(/^[A-Za-z0-9._-]+\.csv$/);
    expect(options?.filters).toEqual([{ name: "CSV", extensions: ["csv"] }]);
  });
});

describe("dialog-backed IPC actions", () => {
  const registeredHandlers = () => {
    const handlers = new Map<string, Parameters<IpcMainLike["handle"]>[1]>();
    const ipcMain: IpcMainLike = {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      removeHandler: vi.fn(),
    };
    let destroyed = false;
    const trusted = {
      mainFrame: { url: "file:///viewer/index.html" },
      isDestroyed: () => destroyed,
      send: vi.fn(),
    };
    return {
      destroy: () => {
        destroyed = true;
      },
      event: { sender: trusted, senderFrame: trusted.mainFrame },
      handlers,
      ipcMain,
      trusted,
    };
  };

  it("issues no Bias command when native confirmation is declined", async () => {
    const fixture = registeredHandlers();
    const supervisor = {
      command: vi.fn(async () => ({ success: true })),
      retry: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
    };
    registerIpcHandlers({
      ipcMain: fixture.ipcMain,
      trustedWebContents: fixture.trusted,
      supervisor,
      confirmBias: async () => false,
      selectRecordingPath: async () => undefined,
    });

    const result = await fixture.handlers.get(IPC_CHANNELS.requestBias)?.(
      fixture.event,
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "cancelled",
    });
    expect(supervisor.command).not.toHaveBeenCalled();
  });

  it("issues no Bias command when the requesting renderer closes during confirmation", async () => {
    const fixture = registeredHandlers();
    let finish: ((confirmed: boolean) => void) | undefined;
    const supervisor = {
      command: vi.fn(async () => ({ success: true })),
      retry: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
    };
    registerIpcHandlers({
      ipcMain: fixture.ipcMain,
      trustedWebContents: fixture.trusted,
      supervisor,
      confirmBias: async () =>
        new Promise<boolean>((resolvePromise) => {
          finish = resolvePromise;
        }),
      selectRecordingPath: async () => undefined,
    });

    const result = fixture.handlers.get(IPC_CHANNELS.requestBias)?.(
      fixture.event,
    );
    fixture.destroy();
    finish?.(true);

    await expect(result).resolves.toMatchObject({
      success: false,
      errorCode: "cancelled",
    });
    expect(supervisor.command).not.toHaveBeenCalled();
  });

  it("persists a host only after a successful correlated Connect result", async () => {
    const fixture = registeredHandlers();
    const command = vi
      .fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });
    const update = vi.fn(async () => DEFAULT_PREFERENCES);
    registerIpcHandlers({
      ipcMain: fixture.ipcMain,
      trustedWebContents: fixture.trusted,
      supervisor: {
        command,
        retry: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
      },
      selectRecordingPath: async () => undefined,
      settings: {
        snapshot: () => DEFAULT_PREFERENCES,
        update,
      },
    });
    const connect = fixture.handlers.get(IPC_CHANNELS.connect);

    await connect?.(fixture.event, "sensor.example");
    expect(update).not.toHaveBeenCalled();
    await connect?.(fixture.event, "sensor.example");
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({ sensorHost: "sensor.example" });
  });

  it("cancels Record before sending a companion command", async () => {
    const fixture = registeredHandlers();
    const supervisor = {
      command: vi.fn(async () => ({ success: true })),
      retry: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
    };
    registerIpcHandlers({
      ipcMain: fixture.ipcMain,
      trustedWebContents: fixture.trusted,
      supervisor,
      selectRecordingPath: async () => undefined,
    });

    await fixture.handlers.get(IPC_CHANNELS.startRecording)?.(fixture.event);

    expect(supervisor.command).not.toHaveBeenCalled();
  });
});
