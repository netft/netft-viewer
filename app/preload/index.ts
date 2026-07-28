import {
  contextBridge,
  ipcRenderer as electronIpcRenderer,
  type IpcRendererEvent,
} from "electron";

import type {
  CommandResult,
  RendererEvent,
} from "../main/companion-supervisor";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type {
  PreferencesPatch,
  ViewerPreferences,
} from "../main/settings-store";
import {
  MenuCommandSchema,
  MenuStateSchema,
  type MenuCommand,
  type MenuState,
} from "../shared/menu-contract";
import {
  normalizeViewerPlatform,
  WindowCommandSchema,
  WindowStateSchema,
  type ViewerPlatform,
  type WindowCommand,
  type WindowState,
} from "../shared/window-command";

type RendererListener = (event: RendererEvent) => void;
type InternalListener = (event: IpcRendererEvent, value: RendererEvent) => void;
type MenuCommandListener = (command: MenuCommand) => void;
type WindowStateListener = (state: WindowState) => void;
type InternalMenuListener = (event: IpcRendererEvent, value: unknown) => void;

export interface IpcRendererLike {
  invoke(channel: string, ...arguments_: unknown[]): Promise<unknown>;
  send(channel: string, ...arguments_: unknown[]): void;
  on(
    channel: string,
    listener: InternalListener | InternalMenuListener,
  ): IpcRendererLike;
  removeListener(
    channel: string,
    listener: InternalListener | InternalMenuListener,
  ): IpcRendererLike;
}

export interface NetftApi {
  readonly platform: ViewerPlatform;
  connect(sensorHost: string): Promise<CommandResult>;
  disconnect(): Promise<CommandResult>;
  setPaused(paused: boolean): Promise<CommandResult>;
  requestBias(): Promise<CommandResult>;
  startRecording(): Promise<CommandResult>;
  stopRecording(): Promise<CommandResult>;
  retryBackend(): Promise<CommandResult>;
  getPreferences(): Promise<ViewerPreferences>;
  updatePreferences(patch: PreferencesPatch): Promise<ViewerPreferences>;
  publishMenuState(state: MenuState): void;
  performWindowCommand(command: WindowCommand): Promise<void>;
  subscribeMenuCommands(listener: MenuCommandListener): () => void;
  subscribeWindowState(listener: WindowStateListener): () => void;
  subscribe(listener: RendererListener): () => void;
}

export const createNetftApi = (
  ipcRenderer: IpcRendererLike,
  platform: NodeJS.Platform = process.platform,
): NetftApi => {
  const listeners = new Set<RendererListener>();
  const receive: InternalListener = (_event, value) => {
    for (const listener of listeners) {
      listener(value);
    }
  };
  const invoke = async (
    channel: string,
    ...arguments_: unknown[]
  ): Promise<CommandResult> =>
    (await ipcRenderer.invoke(channel, ...arguments_)) as CommandResult;
  const menuListeners = new Set<MenuCommandListener>();
  const windowStateListeners = new Set<WindowStateListener>();
  const receiveMenuCommand: InternalMenuListener = (_event, value) => {
    const parsed = MenuCommandSchema.safeParse(value);
    if (!parsed.success) {
      return;
    }
    for (const listener of menuListeners) {
      listener(parsed.data);
    }
  };
  const receiveWindowState: InternalMenuListener = (_event, value) => {
    const parsed = WindowStateSchema.safeParse(value);
    if (!parsed.success) {
      return;
    }
    for (const listener of windowStateListeners) {
      listener(parsed.data);
    }
  };

  const api: NetftApi = {
    platform: normalizeViewerPlatform(platform),
    connect: (sensorHost) => invoke(IPC_CHANNELS.connect, sensorHost),
    disconnect: () => invoke(IPC_CHANNELS.disconnect),
    setPaused: (paused) => invoke(IPC_CHANNELS.setPaused, paused),
    requestBias: () => invoke(IPC_CHANNELS.requestBias),
    startRecording: () => invoke(IPC_CHANNELS.startRecording),
    stopRecording: () => invoke(IPC_CHANNELS.stopRecording),
    retryBackend: () => invoke(IPC_CHANNELS.retryBackend),
    getPreferences: async () =>
      (await ipcRenderer.invoke(
        IPC_CHANNELS.getPreferences,
      )) as ViewerPreferences,
    updatePreferences: async (patch) =>
      (await ipcRenderer.invoke(
        IPC_CHANNELS.updatePreferences,
        patch,
      )) as ViewerPreferences,
    publishMenuState: (state) => {
      const parsed = MenuStateSchema.parse(state);
      ipcRenderer.send(IPC_CHANNELS.menuState, parsed);
    },
    performWindowCommand: async (command) => {
      const parsed = WindowCommandSchema.parse(command);
      await ipcRenderer.invoke(IPC_CHANNELS.windowCommand, parsed);
    },
    subscribeMenuCommands: (listener) => {
      if (menuListeners.size === 0) {
        ipcRenderer.on(IPC_CHANNELS.menuCommand, receiveMenuCommand);
      }
      menuListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        menuListeners.delete(listener);
        if (menuListeners.size === 0) {
          ipcRenderer.removeListener(
            IPC_CHANNELS.menuCommand,
            receiveMenuCommand,
          );
        }
      };
    },
    subscribeWindowState: (listener) => {
      if (windowStateListeners.size === 0) {
        ipcRenderer.on(IPC_CHANNELS.windowState, receiveWindowState);
      }
      windowStateListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        windowStateListeners.delete(listener);
        if (windowStateListeners.size === 0) {
          ipcRenderer.removeListener(
            IPC_CHANNELS.windowState,
            receiveWindowState,
          );
        }
      };
    },
    subscribe: (listener) => {
      if (listeners.size === 0) {
        ipcRenderer.on(IPC_CHANNELS.event, receive);
      }
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          ipcRenderer.removeListener(IPC_CHANNELS.event, receive);
        }
      };
    },
  };
  return Object.freeze(api);
};

contextBridge.exposeInMainWorld("netft", createNetftApi(electronIpcRenderer));
