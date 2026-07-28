import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  registerWindowCommandHandler,
  registerWindowStateBridge,
  type WindowCommandIpcMain,
} from "../../app/main/window-command-handler";
import { IPC_CHANNELS } from "../../app/shared/ipc-channels";

interface Fixture {
  cleanup: () => void;
  event: {
    sender: {
      mainFrame: { url: string };
      isDestroyed: () => boolean;
    };
    senderFrame: { url: string } | null;
  };
  handler: (event: Fixture["event"], command: unknown) => Promise<void> | void;
  openExternal: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  setFullScreen: ReturnType<typeof vi.fn>;
}

const createFixture = (fullScreen = false): Fixture => {
  const handlers = new Map<
    string,
    Parameters<WindowCommandIpcMain["handle"]>[1]
  >();
  const frame = { url: "netft-viewer://app/index.html" };
  const webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
  };
  const openExternal = vi.fn(async () => {});
  const quit = vi.fn();
  const setFullScreen = vi.fn();
  const cleanup = registerWindowCommandHandler({
    app: { quit },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    openExternal,
    trustedWebContents: webContents,
    window: {
      isFullScreen: () => fullScreen,
      setFullScreen,
    },
  });
  const handler = handlers.get(IPC_CHANNELS.windowCommand);
  if (handler === undefined) {
    throw new Error("window command handler was not registered");
  }
  return {
    cleanup,
    event: { sender: webContents, senderFrame: frame },
    handler,
    openExternal,
    quit,
    setFullScreen,
  };
};

describe("window command handler", () => {
  it("performs only the closed command union", async () => {
    const fixture = createFixture();

    await fixture.handler(fixture.event, { type: "toggle-full-screen" });
    await fixture.handler(fixture.event, {
      type: "open-external",
      target: "documentation",
    });
    await fixture.handler(fixture.event, {
      type: "open-external",
      target: "issues",
    });
    await fixture.handler(fixture.event, {
      type: "open-external",
      target: "organization",
    });
    await fixture.handler(fixture.event, { type: "quit" });

    expect(fixture.setFullScreen).toHaveBeenCalledWith(true);
    expect(fixture.openExternal.mock.calls.map(([url]) => url)).toEqual([
      "https://github.com/netft/netft-viewer#readme",
      "https://github.com/netft/netft-viewer/issues/new/choose",
      "https://github.com/netft",
    ]);
    expect(fixture.quit).toHaveBeenCalledOnce();
  });

  it("uses the latest full-screen state", async () => {
    const fixture = createFixture(true);

    await fixture.handler(fixture.event, { type: "toggle-full-screen" });

    expect(fixture.setFullScreen).toHaveBeenCalledWith(false);
  });

  it("rejects invalid commands and untrusted senders", async () => {
    const fixture = createFixture();

    await expect(
      fixture.handler(fixture.event, {
        type: "open-external",
        target: "https://example.invalid",
      }),
    ).rejects.toThrow();
    await expect(
      fixture.handler(
        {
          sender: {
            mainFrame: fixture.event.sender.mainFrame,
            isDestroyed: () => false,
          },
          senderFrame: fixture.event.senderFrame,
        },
        { type: "quit" },
      ),
    ).rejects.toThrow("untrusted IPC sender");

    expect(fixture.openExternal).not.toHaveBeenCalled();
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("removes its handler exactly once", () => {
    const fixture = createFixture();

    fixture.cleanup();
    fixture.cleanup();

    expect(() =>
      fixture.handler(fixture.event, { type: "quit" }),
    ).not.toThrow();
  });

  it("publishes native full-screen and focus transitions and removes its listeners", () => {
    let fullScreen = false;
    let focused = true;
    const window = Object.assign(new EventEmitter(), {
      isFullScreen: () => fullScreen,
      isFocused: () => focused,
    });
    const send = vi.fn();
    const cleanup = registerWindowStateBridge({
      trustedWebContents: {
        mainFrame: { url: "netft-viewer://app/index.html" },
        isDestroyed: () => false,
        send,
      },
      window,
    });

    fullScreen = true;
    window.emit("enter-full-screen");
    fullScreen = false;
    window.emit("leave-full-screen");
    focused = false;
    window.emit("blur");
    focused = true;
    window.emit("focus");
    cleanup();
    window.emit("enter-full-screen");

    expect(send.mock.calls.map(([, state]) => state)).toEqual([
      { fullScreen: true, focused: true },
      { fullScreen: false, focused: true },
      { fullScreen: false, focused: false },
      { fullScreen: false, focused: true },
    ]);
  });
});
