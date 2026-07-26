import { isAbsolute } from "node:path";
import { z } from "zod";

import type {
  CommandResult,
  CompanionCommandType,
  CompanionSupervisor,
  RendererEvent,
} from "./companion-supervisor";

export const IPC_CHANNELS = {
  connect: "netft:connect",
  disconnect: "netft:disconnect",
  setPaused: "netft:set-paused",
  requestBias: "netft:request-bias",
  startRecording: "netft:start-recording",
  stopRecording: "netft:stop-recording",
  retryBackend: "netft:retry-backend",
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
}

const sensorHostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((value) => {
    if (/^[0-9.]+$/.test(value)) {
      const parts = value.split(".");
      return (
        parts.length === 4 &&
        parts.every(
          (part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255,
        )
      );
    }
    return value
      .split(".")
      .every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      );
  });

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
  const trusted = (
    handler: (...arguments_: unknown[]) => unknown,
  ): IpcHandler => {
    return (event, ...arguments_) => {
      if (
        event.sender !== options.trustedWebContents ||
        event.senderFrame === null ||
        event.senderFrame !== options.trustedWebContents.mainFrame
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

  register(IPC_CHANNELS.connect, (sensorHost) =>
    options.supervisor.command("connect", {
      sensorHost: sensorHostSchema.parse(sensorHost),
    }),
  );
  register(IPC_CHANNELS.disconnect, (...arguments_) => {
    requireNoArguments(arguments_);
    return options.supervisor.command("disconnect", {});
  });
  register(IPC_CHANNELS.setPaused, (paused, ...extra) => {
    requireNoArguments(extra);
    return options.supervisor.command("set_paused", {
      paused: z.boolean().parse(paused),
    });
  });
  register(IPC_CHANNELS.requestBias, async (...arguments_) => {
    requireNoArguments(arguments_);
    if (options.confirmBias === undefined || !(await options.confirmBias())) {
      return canceledResult();
    }
    return options.supervisor.command("bias", {});
  });
  register(IPC_CHANNELS.startRecording, async (...arguments_) => {
    requireNoArguments(arguments_);
    const selection = await options.selectRecordingPath();
    if (selection === undefined) {
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
  register(IPC_CHANNELS.stopRecording, (...arguments_) => {
    requireNoArguments(arguments_);
    return options.supervisor.command("stop_recording", {});
  });
  register(IPC_CHANNELS.retryBackend, async (...arguments_) => {
    requireNoArguments(arguments_);
    await options.supervisor.retry();
    return { success: true } satisfies CommandResult;
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
