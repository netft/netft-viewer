import {
  contextBridge,
  ipcRenderer as electronIpcRenderer,
  type IpcRendererEvent,
} from "electron";

import type {
  CommandResult,
  RendererEvent,
} from "../main/companion-supervisor";
import { IPC_CHANNELS } from "../main/ipc-handlers";
import type {
  PreferencesPatch,
  ViewerPreferences,
} from "../main/settings-store";

type RendererListener = (event: RendererEvent) => void;
type InternalListener = (event: IpcRendererEvent, value: RendererEvent) => void;

export interface IpcRendererLike {
  invoke(channel: string, ...arguments_: unknown[]): Promise<unknown>;
  on(channel: string, listener: InternalListener): IpcRendererLike;
  removeListener(channel: string, listener: InternalListener): IpcRendererLike;
}

export interface NetftApi {
  connect(sensorHost: string): Promise<CommandResult>;
  disconnect(): Promise<CommandResult>;
  setPaused(paused: boolean): Promise<CommandResult>;
  requestBias(): Promise<CommandResult>;
  startRecording(): Promise<CommandResult>;
  stopRecording(): Promise<CommandResult>;
  retryBackend(): Promise<CommandResult>;
  getPreferences(): Promise<ViewerPreferences>;
  updatePreferences(patch: PreferencesPatch): Promise<ViewerPreferences>;
  subscribe(listener: RendererListener): () => void;
}

export const createNetftApi = (ipcRenderer: IpcRendererLike): NetftApi => {
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

  const api: NetftApi = {
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
