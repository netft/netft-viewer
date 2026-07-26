import { isAbsolute } from "node:path";
import { z } from "zod";

import type {
  CommandResult,
  CompanionCommandType,
  CompanionSupervisor,
  RendererEvent,
} from "./companion-supervisor";
import type {
  PreferencesPatch,
  SettingsStore,
  ViewerPreferences,
} from "./settings-store";
import { SensorHostSchema } from "./settings-store";

export const IPC_CHANNELS = {
  connect: "netft:connect",
  disconnect: "netft:disconnect",
  setPaused: "netft:set-paused",
  requestBias: "netft:request-bias",
  startRecording: "netft:start-recording",
  stopRecording: "netft:stop-recording",
  retryBackend: "netft:retry-backend",
  getPreferences: "netft:get-preferences",
  updatePreferences: "netft:update-preferences",
  event: "netft:event",
} as const;

type IpcHandler = (
  event: IpcInvokeEventLike,
  ...arguments_: unknown[]
) => unknown;

export interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
}

export interface FrameLike {
  readonly url: string;
}

export interface WebContentsLike {
  readonly mainFrame: FrameLike;
  isDestroyed?(): boolean;
  send?(channel: string, event: RendererEvent): void;
}

export interface IpcInvokeEventLike {
  readonly sender: WebContentsLike;
  readonly senderFrame: FrameLike | null;
}

export interface SupervisorCommands {
  command(
    type: CompanionCommandType,
    payload: Record<string, unknown>,
  ): Promise<CommandResult>;
  retry(): Promise<void>;
  subscribe(listener: (event: RendererEvent) => void): () => void;
}

export interface RecordingSelection {
  targetPath: string;
  overwrite: boolean;
}

export interface RegisterIpcHandlersOptions {
  ipcMain: IpcMainLike;
  trustedWebContents: WebContentsLike;
  supervisor: SupervisorCommands | CompanionSupervisor;
  selectRecordingPath: () => Promise<RecordingSelection | undefined>;
  confirmBias?: () => Promise<boolean>;
  settings?: Pick<SettingsStore, "snapshot" | "update">;
}

const canceledResult = (): CommandResult => ({
  success: false,
  errorCode: "cancelled",
  errorMessage: "Operation cancelled",
});

const requireNoArguments = (arguments_: unknown[]): void => {
  if (arguments_.length !== 0) {
    throw new Error("unexpected IPC arguments");
  }
};

export const registerIpcHandlers = (
  options: RegisterIpcHandlersOptions,
): (() => void) => {
  const registered: string[] = [];
  const pending = new Map<string, Promise<unknown>>();
  const trusted = (
    handler: (...arguments_: unknown[]) => unknown,
  ): IpcHandler => {
    return (event, ...arguments_) => {
      if (
        event.sender !== options.trustedWebContents ||
        event.senderFrame === null ||
        event.senderFrame !== options.trustedWebContents.mainFrame ||
        options.trustedWebContents.isDestroyed?.() === true
      ) {
        throw new Error("untrusted IPC sender");
      }
      return handler(...arguments_);
    };
  };
  const register = (
    channel: string,
    handler: (...arguments_: unknown[]) => unknown,
  ): void => {
    options.ipcMain.removeHandler(channel);
    options.ipcMain.handle(channel, trusted(handler));
    registered.push(channel);
  };
  const deduplicated = <Result>(
    key: string,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const existing = pending.get(key);
    if (existing !== undefined) {
      return existing as Promise<Result>;
    }
    const request = operation().finally(() => {
      if (pending.get(key) === request) {
        pending.delete(key);
      }
    });
    pending.set(key, request);
    return request;
  };
  const emitSettingsError = (operation: "read" | "write"): void => {
    try {
      options.trustedWebContents.send?.(IPC_CHANNELS.event, {
        type: "settings_error",
        monotonicNs: process.hrtime.bigint().toString(),
        payload: {
          operation,
          errorCode: "settings_unavailable",
        },
      });
    } catch {
      // A settings warning must not outlive its renderer.
    }
  };

  register(IPC_CHANNELS.connect, (sensorHost) => {
    const validatedHost = SensorHostSchema.parse(sensorHost);
    return deduplicated(IPC_CHANNELS.connect, async () => {
      const result = await options.supervisor.command("connect", {
        sensorHost: validatedHost,
      });
      if (result.success && options.settings !== undefined) {
        try {
          await options.settings.update({ sensorHost: validatedHost });
        } catch {
          emitSettingsError("write");
        }
      }
      return result;
    });
  });
  register(IPC_CHANNELS.disconnect, (...arguments_) => {
    requireNoArguments(arguments_);
    return deduplicated(IPC_CHANNELS.disconnect, async () =>
      options.supervisor.command("disconnect", {}),
    );
  });
  register(IPC_CHANNELS.setPaused, (paused, ...extra) => {
    requireNoArguments(extra);
    const validatedPaused = z.boolean().parse(paused);
    return deduplicated(IPC_CHANNELS.setPaused, async () =>
      options.supervisor.command("set_paused", {
        paused: validatedPaused,
      }),
    );
  });
  register(IPC_CHANNELS.requestBias, async (...arguments_) => {
    requireNoArguments(arguments_);
    return deduplicated(IPC_CHANNELS.requestBias, async () => {
      if (options.confirmBias === undefined || !(await options.confirmBias())) {
        return canceledResult();
      }
      if (options.trustedWebContents.isDestroyed?.() === true) {
        return canceledResult();
      }
      return options.supervisor.command("bias", {});
    });
  });
  register(IPC_CHANNELS.startRecording, async (...arguments_) => {
    requireNoArguments(arguments_);
    return deduplicated(IPC_CHANNELS.startRecording, async () => {
      const selection = await options.selectRecordingPath();
      if (selection === undefined) {
        return canceledResult();
      }
      if (options.trustedWebContents.isDestroyed?.() === true) {
        return canceledResult();
      }
      if (
        !isAbsolute(selection.targetPath) ||
        !selection.targetPath.toLowerCase().endsWith(".csv")
      ) {
        throw new Error("invalid recording destination");
      }
      return options.supervisor.command("start_recording", {
        targetPath: selection.targetPath,
        overwrite: selection.overwrite,
      });
    });
  });
  register(IPC_CHANNELS.stopRecording, (...arguments_) => {
    requireNoArguments(arguments_);
    return deduplicated(IPC_CHANNELS.stopRecording, async () =>
      options.supervisor.command("stop_recording", {}),
    );
  });
  register(IPC_CHANNELS.retryBackend, async (...arguments_) => {
    requireNoArguments(arguments_);
    return deduplicated(IPC_CHANNELS.retryBackend, async () => {
      await options.supervisor.retry();
      return { success: true } satisfies CommandResult;
    });
  });
  register(IPC_CHANNELS.getPreferences, (...arguments_) => {
    requireNoArguments(arguments_);
    if (options.settings === undefined) {
      emitSettingsError("read");
      throw new Error("settings unavailable");
    }
    return options.settings.snapshot();
  });
  register(IPC_CHANNELS.updatePreferences, (patch, ...extra) => {
    requireNoArguments(extra);
    if (options.settings === undefined) {
      emitSettingsError("write");
      throw new Error("settings unavailable");
    }
    return options.settings.update(patch as PreferencesPatch).catch(() => {
      emitSettingsError("write");
      throw new Error("settings unavailable");
    }) satisfies Promise<ViewerPreferences>;
  });

  const unsubscribe = options.supervisor.subscribe((event) => {
    try {
      if (options.trustedWebContents.isDestroyed?.() === true) {
        return;
      }
      options.trustedWebContents.send?.(IPC_CHANNELS.event, event);
    } catch {
      // Renderer teardown must not propagate into backend supervision.
    }
  });
  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    unsubscribe();
    for (const channel of registered) {
      options.ipcMain.removeHandler(channel);
    }
  };
};
