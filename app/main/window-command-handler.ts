import { IPC_CHANNELS } from "../shared/ipc-channels";
import {
  EXTERNAL_TARGETS,
  WindowCommandSchema,
  type WindowCommand,
} from "../shared/window-command";

interface TrustedFrame {
  readonly url: string;
}

interface TrustedWebContents {
  readonly mainFrame: TrustedFrame;
  isDestroyed?(): boolean;
  send?(channel: string, value: unknown): void;
}

interface WindowCommandEvent {
  readonly sender: TrustedWebContents;
  readonly senderFrame: TrustedFrame | null;
}

type WindowCommandHandler = (
  event: WindowCommandEvent,
  command: unknown,
) => Promise<void>;

export interface WindowCommandIpcMain {
  handle(channel: string, listener: WindowCommandHandler): void;
  removeHandler(channel: string): void;
}

export interface RegisterWindowCommandHandlerOptions {
  app: { quit(): void };
  ipcMain: WindowCommandIpcMain;
  openExternal(url: string): Promise<unknown>;
  trustedWebContents: TrustedWebContents;
  window: {
    isFullScreen(): boolean;
    setFullScreen(fullScreen: boolean): void;
  };
}

type WindowCommandOperations = Omit<
  RegisterWindowCommandHandlerOptions,
  "ipcMain" | "trustedWebContents"
>;

export const executeWindowCommand = async (
  command: WindowCommand,
  options: WindowCommandOperations,
): Promise<void> => {
  switch (command.type) {
    case "quit":
      options.app.quit();
      return;
    case "toggle-full-screen":
      options.window.setFullScreen(!options.window.isFullScreen());
      return;
    case "open-external":
      await options.openExternal(EXTERNAL_TARGETS[command.target]);
  }
};

export const registerWindowCommandHandler = (
  options: RegisterWindowCommandHandlerOptions,
): (() => void) => {
  const handle: WindowCommandHandler = async (event, value) => {
    if (
      event.sender !== options.trustedWebContents ||
      event.senderFrame === null ||
      event.senderFrame !== options.trustedWebContents.mainFrame ||
      options.trustedWebContents.isDestroyed?.() === true
    ) {
      throw new Error("untrusted IPC sender");
    }

    const command = WindowCommandSchema.parse(value);
    await executeWindowCommand(command, options);
  };

  options.ipcMain.removeHandler(IPC_CHANNELS.windowCommand);
  options.ipcMain.handle(IPC_CHANNELS.windowCommand, handle);

  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    options.ipcMain.removeHandler(IPC_CHANNELS.windowCommand);
  };
};

interface WindowStateSource {
  isFocused(): boolean;
  isFullScreen(): boolean;
  on(
    event: "blur" | "enter-full-screen" | "focus" | "leave-full-screen",
    listener: () => void,
  ): this;
  removeListener(
    event: "blur" | "enter-full-screen" | "focus" | "leave-full-screen",
    listener: () => void,
  ): this;
}

export interface RegisterWindowStateBridgeOptions {
  trustedWebContents: TrustedWebContents;
  window: WindowStateSource;
}

export const registerWindowStateBridge = (
  options: RegisterWindowStateBridgeOptions,
): (() => void) => {
  const publish = (): void => {
    if (options.trustedWebContents.isDestroyed?.() === true) {
      return;
    }
    try {
      options.trustedWebContents.send?.(IPC_CHANNELS.windowState, {
        focused: options.window.isFocused(),
        fullScreen: options.window.isFullScreen(),
      });
    } catch {
      // Native window events can race renderer teardown.
    }
  };
  const entered = (): void => publish();
  const left = (): void => publish();
  const focused = (): void => publish();
  const blurred = (): void => publish();
  options.window.on("enter-full-screen", entered);
  options.window.on("leave-full-screen", left);
  options.window.on("focus", focused);
  options.window.on("blur", blurred);

  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    options.window.removeListener("enter-full-screen", entered);
    options.window.removeListener("leave-full-screen", left);
    options.window.removeListener("focus", focused);
    options.window.removeListener("blur", blurred);
  };
};
