import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  MAXIMUM_LINE_BYTES,
  type CompanionEvent,
  parseCompanionEventLine,
} from "./protocol";
import type { LogStore } from "./log-store";

const START_DELAYS_MS = [100, 500, 2_000] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export type CompanionCommandType =
  | "connect"
  | "disconnect"
  | "set_paused"
  | "bias"
  | "start_recording"
  | "stop_recording";

export interface CommandResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export type RendererEvent =
  | CompanionEvent
  | {
      type: "backend_disconnected";
      monotonicNs: string;
      payload: {
        restartPending: boolean;
      };
    }
  | {
      type: "backend_state";
      monotonicNs: string;
      payload: CompanionSupervisorSnapshot;
    };

export interface CompanionProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOptions {
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
}

export type ProcessSpawner = (
  executable: string,
  arguments_: string[],
  options: SpawnOptions,
) => CompanionProcess;

export interface CompanionSupervisorOptions {
  executablePath: string;
  expectedAppVersion: string;
  expectedCoreSnapshot: string;
  spawnProcess?: ProcessSpawner;
  schedule?: (milliseconds: number) => Promise<void>;
  requestTimeoutMs?: number;
  logStore?: Pick<LogStore, "append">;
}

export interface CompanionSupervisorSnapshot {
  state: "stopped" | "starting" | "running" | "stopping" | "failed";
  startAttempts: number;
  lastError?: string;
}

interface PendingRequest {
  expectedType: "hello" | "command_result";
  commandType: "hello" | CompanionCommandType | "shutdown";
  resolve: (event: CompanionEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProcessListeners {
  stdout: (chunk: Buffer | string) => void;
  stderr: (chunk: Buffer | string) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

class BoundedLineFramer {
  private chunks: Buffer[] = [];
  private byteLength = 0;

  push(input: Buffer | string): string[] {
    let pending = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
    const lines: string[] = [];
    while (pending.byteLength > 0) {
      const newline = pending.indexOf(0x0a);
      const part = newline < 0 ? pending : pending.subarray(0, newline);
      if (this.byteLength + part.byteLength > MAXIMUM_LINE_BYTES) {
        this.reset();
        throw new Error("companion stdout frame exceeds byte limit");
      }
      if (part.byteLength > 0) {
        this.chunks.push(part);
        this.byteLength += part.byteLength;
      }
      if (newline < 0) {
        return lines;
      }
      lines.push(Buffer.concat(this.chunks, this.byteLength).toString("utf8"));
      this.reset();
      pending = pending.subarray(newline + 1);
    }
    return lines;
  }

  private reset(): void {
    this.chunks = [];
    this.byteLength = 0;
  }
}

const defaultSpawner: ProcessSpawner = (executable, arguments_, options) =>
  spawn(executable, arguments_, options) as CompanionProcess;

const defaultSchedule = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
};

const monotonicNanoseconds = (): string => process.hrtime.bigint().toString();

const errorFrom = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

export class CompanionSupervisor {
  private readonly options: Required<
    Pick<
      CompanionSupervisorOptions,
      "spawnProcess" | "schedule" | "requestTimeoutMs"
    >
  > &
    Omit<
      CompanionSupervisorOptions,
      "spawnProcess" | "schedule" | "requestTimeoutMs"
    >;
  private readonly subscribers = new Set<(event: RendererEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private process: CompanionProcess | undefined;
  private listeners: ProcessListeners | undefined;
  private snapshotValue: CompanionSupervisorSnapshot = {
    state: "stopped",
    startAttempts: 0,
  };
  private cycle: Promise<void> | undefined;
  private suppressRestart = false;

  constructor(options: CompanionSupervisorOptions) {
    if (!isAbsolute(options.executablePath)) {
      throw new Error("companion executable path must be absolute");
    }
    if (
      !/^[0-9a-f]{40}$/.test(options.expectedCoreSnapshot) ||
      options.expectedAppVersion.length === 0
    ) {
      throw new Error("invalid expected companion identity");
    }
    this.options = {
      ...options,
      spawnProcess: options.spawnProcess ?? defaultSpawner,
      schedule: options.schedule ?? defaultSchedule,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  snapshot(): Readonly<CompanionSupervisorSnapshot> {
    return { ...this.snapshotValue };
  }

  subscribe(listener: (event: RendererEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.snapshotValue.state === "running") {
      return;
    }
    if (this.snapshotValue.state === "failed") {
      throw new Error("explicit backend retry is required");
    }
    this.suppressRestart = false;
    await this.runStartCycle(false);
  }

  async retry(): Promise<void> {
    if (
      this.snapshotValue.state !== "failed" &&
      this.snapshotValue.state !== "stopped"
    ) {
      throw new Error("backend retry is unavailable");
    }
    this.suppressRestart = false;
    await this.runStartCycle(true);
  }

  async command(
    type: CompanionCommandType,
    payload: Record<string, unknown>,
  ): Promise<CommandResult> {
    if (this.snapshotValue.state !== "running" || this.process === undefined) {
      throw new Error("backend is not running");
    }
    const event = await this.sendRequest(type, payload, "command_result");
    if (event.type !== "command_result" || event.payload.commandType !== type) {
      throw new Error("command result does not match request");
    }
    return {
      success: event.payload.success,
      ...(event.payload.errorCode === undefined
        ? {}
        : { errorCode: event.payload.errorCode }),
      ...(event.payload.errorMessage === undefined
        ? {}
        : { errorMessage: event.payload.errorMessage }),
    };
  }

  async stop(): Promise<void> {
    this.suppressRestart = true;
    const child = this.process;
    if (child === undefined) {
      this.updateSnapshot({ state: "stopped", startAttempts: 0 });
      return;
    }
    this.updateSnapshot({
      ...this.snapshotValue,
      state: "stopping",
    });
    try {
      await this.sendRequest("shutdown", {}, "command_result");
      child.stdin.end();
    } catch {
      child.kill();
    }
  }

  private async runStartCycle(resetBudget: boolean): Promise<void> {
    if (this.cycle !== undefined) {
      return this.cycle;
    }
    if (resetBudget) {
      this.updateSnapshot({ state: "starting", startAttempts: 0 });
    }
    this.cycle = this.startAttempts();
    try {
      await this.cycle;
    } finally {
      this.cycle = undefined;
    }
  }

  private async startAttempts(): Promise<void> {
    let lastError = new Error("companion did not start");
    for (const delay of START_DELAYS_MS) {
      if (this.suppressRestart) {
        this.updateSnapshot({ state: "stopped", startAttempts: 0 });
        return;
      }
      const attempt = this.snapshotValue.startAttempts + 1;
      this.updateSnapshot({ state: "starting", startAttempts: attempt });
      await this.options.schedule(delay);
      if (this.suppressRestart) {
        this.updateSnapshot({ state: "stopped", startAttempts: 0 });
        return;
      }
      try {
        await this.spawnAndHandshake();
        this.updateSnapshot({ state: "running", startAttempts: attempt });
        return;
      } catch (error) {
        lastError = errorFrom(error);
        this.disposeCurrentProcess(true);
      }
    }
    this.updateSnapshot({
      state: "failed",
      startAttempts: START_DELAYS_MS.length,
      lastError: lastError.message,
    });
  }

  private async spawnAndHandshake(): Promise<void> {
    const child = this.options.spawnProcess(this.options.executablePath, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this.attach(child);
    const event = await this.sendRequest("hello", {}, "hello");
    if (
      event.type !== "hello" ||
      event.payload.protocolMajor !== 1 ||
      event.payload.appVersion !== this.options.expectedAppVersion ||
      event.payload.coreSnapshot !== this.options.expectedCoreSnapshot
    ) {
      throw new Error("companion identity mismatch");
    }
  }

  private sendRequest(
    type: "hello" | CompanionCommandType | "shutdown",
    payload: Record<string, unknown>,
    expectedType: "hello" | "command_result",
  ): Promise<CompanionEvent> {
    const child = this.process;
    if (child === undefined) {
      return Promise.reject(new Error("backend process is unavailable"));
    }
    const requestId = randomUUID();
    return new Promise<CompanionEvent>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rejectPromise(new Error("companion request timed out"));
        this.failProcess(new Error("companion request timed out"));
      }, this.options.requestTimeoutMs);
      this.pending.set(requestId, {
        expectedType,
        commandType: type,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      const frame = JSON.stringify({
        protocol: { major: 1, minor: 0 },
        type,
        requestId,
        monotonicNs: monotonicNanoseconds(),
        payload,
      });
      child.stdin.write(`${frame}\n`, (error) => {
        if (error !== null && error !== undefined) {
          const writeError = errorFrom(error);
          const pending = this.pending.get(requestId);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            this.pending.delete(requestId);
            pending.reject(writeError);
          }
          this.failProcess(writeError);
        }
      });
    });
  }

  private attach(child: CompanionProcess): void {
    const framer = new BoundedLineFramer();
    const listeners: ProcessListeners = {
      stdout: (chunk) => {
        try {
          for (const line of framer.push(chunk)) {
            this.receive(parseCompanionEventLine(line));
          }
        } catch (error) {
          this.failProcess(errorFrom(error));
        }
      },
      stderr: (chunk) => {
        try {
          this.options.logStore?.append(chunk);
        } catch {
          // Diagnostic logging must never destabilize process supervision.
        }
      },
      error: (error) => {
        this.handleTermination(child, error, false);
      },
      exit: (code) => {
        this.handleTermination(
          child,
          new Error(`companion exited with code ${String(code)}`),
          code === 0,
        );
      },
    };
    this.listeners = listeners;
    child.stdout.on("data", listeners.stdout);
    child.stderr.on("data", listeners.stderr);
    child.once("error", listeners.error);
    child.once("exit", listeners.exit);
  }

  private receive(event: CompanionEvent): void {
    if (event.type === "hello" || event.type === "command_result") {
      if (!("requestId" in event) || typeof event.requestId !== "string") {
        this.failProcess(new Error("uncorrelated companion response"));
        return;
      }
      const pending = this.pending.get(event.requestId);
      if (
        pending === undefined ||
        pending.expectedType !== event.type ||
        (event.type === "command_result" &&
          event.payload.commandType !== pending.commandType)
      ) {
        this.failProcess(new Error("uncorrelated companion response"));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(event.requestId);
      pending.resolve(event);
      return;
    }
    this.emit(event);
  }

  private failProcess(error: Error): void {
    const child = this.process;
    if (child === undefined) {
      return;
    }
    child.kill();
    this.handleTermination(child, error, false);
  }

  private handleTermination(
    child: CompanionProcess,
    error: Error,
    normalExit: boolean,
  ): void {
    if (this.process !== child) {
      return;
    }
    this.rejectPending(error);
    this.disposeCurrentProcess(false);
    this.emit({
      type: "backend_disconnected",
      monotonicNs: monotonicNanoseconds(),
      payload: {
        restartPending: !normalExit && !this.suppressRestart,
      },
    });
    if (normalExit || this.suppressRestart) {
      this.updateSnapshot({ state: "stopped", startAttempts: 0 });
      return;
    }
    if (this.cycle === undefined) {
      this.updateSnapshot({ state: "starting", startAttempts: 0 });
      void this.runStartCycle(true);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private disposeCurrentProcess(kill: boolean): void {
    const child = this.process;
    const listeners = this.listeners;
    this.process = undefined;
    this.listeners = undefined;
    if (child === undefined || listeners === undefined) {
      return;
    }
    child.stdout.removeListener("data", listeners.stdout);
    child.stderr.removeListener("data", listeners.stderr);
    child.removeListener("error", listeners.error);
    child.removeListener("exit", listeners.exit);
    if (kill) {
      child.kill();
    }
  }

  private updateSnapshot(snapshot: CompanionSupervisorSnapshot): void {
    this.snapshotValue = snapshot;
    this.emit({
      type: "backend_state",
      monotonicNs: monotonicNanoseconds(),
      payload: { ...snapshot },
    });
  }

  private emit(event: RendererEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
