import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompanionSupervisor,
  type CompanionProcess,
  type ProcessSpawner,
} from "../../app/main/companion-supervisor";
import { LogStore } from "../../app/main/log-store";

const executablePath = resolve(
  "build/native/core/companion/netft-viewer-companion",
);
const appVersion = "test-version";
const coreSnapshot = "e424c401587052f03de9b94f76f1e86b78902105";

class FakeProcess extends EventEmitter implements CompanionProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  readonly commandTypes: string[] = [];

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

const helloFor = (requestId: string): string =>
  JSON.stringify({
    protocol: { major: 1, minor: 0 },
    type: "hello",
    requestId,
    monotonicNs: "1",
    payload: {
      protocolMajor: 1,
      protocolMinor: 0,
      appVersion,
      coreSnapshot,
    },
  });

const respondToHello = (
  process: FakeProcess,
  afterCommand?: (command: { requestId: string; type: string }) => void,
): void => {
  let input = "";
  process.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const command = JSON.parse(input.slice(0, newline)) as {
        requestId: string;
        type: string;
      };
      input = input.slice(newline + 1);
      process.commandTypes.push(command.type);
      if (command.type === "hello") {
        process.stdout.write(`${helloFor(command.requestId)}\n`);
      }
      afterCommand?.(command);
    }
  });
};

const supervisorWith = (
  spawnProcess: ProcessSpawner,
  overrides: Partial<ConstructorParameters<typeof CompanionSupervisor>[0]> = {},
): CompanionSupervisor =>
  new CompanionSupervisor({
    executablePath,
    expectedAppVersion: appVersion,
    expectedCoreSnapshot: coreSnapshot,
    spawnProcess,
    schedule: async () => {},
    requestTimeoutMs: 50,
    ...overrides,
  });

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("CompanionSupervisor", () => {
  it("stops after three consecutive start failures at the bounded delays", async () => {
    const delays: number[] = [];
    const spawnProcess = vi.fn<ProcessSpawner>(() => {
      throw new Error("start failed");
    });
    const supervisor = supervisorWith(spawnProcess, {
      schedule: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await supervisor.start();

    expect(supervisor.snapshot()).toMatchObject({
      state: "failed",
      startAttempts: 3,
    });
    expect(delays).toEqual([100, 500, 2_000]);
    expect(spawnProcess).toHaveBeenCalledTimes(3);
  });

  it("spawns one absolute configured executable without a shell", async () => {
    const process = new FakeProcess();
    respondToHello(process);
    const spawnProcess = vi.fn<ProcessSpawner>(() => process);
    const supervisor = supervisorWith(spawnProcess);

    await supervisor.start();

    expect(spawnProcess).toHaveBeenCalledWith(executablePath, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(supervisor.snapshot().state).toBe("running");
  });

  it("rejects a relative executable before invoking the process spawner", () => {
    const spawnProcess = vi.fn<ProcessSpawner>();

    expect(
      () =>
        new CompanionSupervisor({
          executablePath: "netft-viewer-companion",
          expectedAppVersion: appVersion,
          expectedCoreSnapshot: coreSnapshot,
          spawnProcess,
        }),
    ).toThrow();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("invalidates the session and only handshakes after an abnormal loss", async () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    respondToHello(first);
    respondToHello(second);
    const processes = [first, second];
    const spawnProcess = vi.fn<ProcessSpawner>(() => {
      const next = processes.shift();
      if (next === undefined) {
        throw new Error("unexpected spawn");
      }
      return next;
    });
    const supervisor = supervisorWith(spawnProcess);
    const events: Array<{ type: string }> = [];
    supervisor.subscribe((event) => events.push(event));
    await supervisor.start();

    first.exit(9);
    await vi.waitFor(() => {
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(supervisor.snapshot().state).toBe("running");
    });

    const commandTypes = [first, second].flatMap(
      (process) => process.commandTypes,
    );
    expect(commandTypes).toEqual(["hello", "hello"]);
    expect(events.some((event) => event.type === "backend_disconnected")).toBe(
      true,
    );
  });

  it("does not restart after a normal backend exit", async () => {
    const normal = new FakeProcess();
    respondToHello(normal);
    const spawnProcess = vi.fn<ProcessSpawner>(() => normal);
    const supervisor = supervisorWith(spawnProcess);
    await supervisor.start();

    normal.exit(0);
    await Promise.resolve();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("sends one shutdown command and does not restart during app shutdown", async () => {
    const process = new FakeProcess();
    respondToHello(process, (command) => {
      if (command.type !== "shutdown") {
        return;
      }
      process.stdout.write(
        `${JSON.stringify({
          protocol: { major: 1, minor: 0 },
          type: "command_result",
          requestId: command.requestId,
          monotonicNs: "2",
          payload: { commandType: "shutdown", success: true },
        })}\n`,
      );
      process.exit(0);
    });
    const spawnProcess = vi.fn<ProcessSpawner>(() => process);
    const supervisor = supervisorWith(spawnProcess);
    await supervisor.start();

    await supervisor.stop();

    expect(process.commandTypes).toEqual(["hello", "shutdown"]);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("does not spawn when app shutdown cancels a scheduled start", async () => {
    let release: (() => void) | undefined;
    const scheduled = new Promise<void>((resolveSchedule) => {
      release = resolveSchedule;
    });
    const spawnProcess = vi.fn<ProcessSpawner>();
    const supervisor = supervisorWith(spawnProcess, {
      schedule: async () => scheduled,
    });

    const starting = supervisor.start();
    await Promise.resolve();
    await supervisor.stop();
    release?.();
    await starting;

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("resets a depleted failure budget only on explicit retry", async () => {
    const process = new FakeProcess();
    respondToHello(process);
    let failures = 0;
    const spawnProcess = vi.fn<ProcessSpawner>(() => {
      failures += 1;
      if (failures <= 3) {
        throw new Error("start failed");
      }
      return process;
    });
    const supervisor = supervisorWith(spawnProcess);
    await supervisor.start();
    expect(supervisor.snapshot().state).toBe("failed");

    await supervisor.retry();

    expect(spawnProcess).toHaveBeenCalledTimes(4);
    expect(supervisor.snapshot()).toMatchObject({
      state: "running",
      startAttempts: 1,
    });
  });

  it("requires explicit retry after the start failure budget is depleted", async () => {
    const spawnProcess = vi.fn<ProcessSpawner>(() => {
      throw new Error("start failed");
    });
    const supervisor = supervisorWith(spawnProcess);
    await supervisor.start();

    await expect(supervisor.start()).rejects.toThrow();

    expect(spawnProcess).toHaveBeenCalledTimes(3);
    expect(supervisor.snapshot().state).toBe("failed");
  });

  it("terminates a backend that exceeds the one-MiB stdout frame limit", async () => {
    const process = new FakeProcess();
    respondToHello(process);
    const supervisor = supervisorWith(() => process);
    await supervisor.start();

    process.stdout.write(Buffer.alloc(1024 * 1024 + 1, "x"));

    await vi.waitFor(() => expect(process.kill).toHaveBeenCalled());
    expect(supervisor.snapshot().state).not.toBe("running");
  });

  it("rejects a command result with the wrong request correlation", async () => {
    vi.useFakeTimers();
    const process = new FakeProcess();
    respondToHello(process);
    const supervisor = supervisorWith(() => process, {
      requestTimeoutMs: 1_000,
    });
    await supervisor.start();

    const request = supervisor.command("disconnect", {});
    process.stdout.write(
      `${JSON.stringify({
        protocol: { major: 1, minor: 0 },
        type: "command_result",
        requestId: "unknown-request",
        monotonicNs: "2",
        payload: { commandType: "disconnect", success: true },
      })}\n`,
    );

    await expect(request).rejects.toThrow();
    expect(process.kill).toHaveBeenCalled();
  });

  it("times out an unanswered correlated command and terminates the backend", async () => {
    vi.useFakeTimers();
    const process = new FakeProcess();
    respondToHello(process);
    const supervisor = supervisorWith(() => process, {
      requestTimeoutMs: 1_000,
    });
    await supervisor.start();

    const request = supervisor.command("disconnect", {});
    const rejection = expect(request).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(process.kill).toHaveBeenCalled();
  });

  it("terminates the backend when command input becomes unwritable", async () => {
    const process = new FakeProcess();
    respondToHello(process);
    const supervisor = supervisorWith(() => process);
    await supervisor.start();
    process.stdin.write = vi.fn(
      (_chunk: unknown, callback: (error?: Error | null) => void): boolean => {
        callback(new Error("input closed"));
        return false;
      },
    ) as unknown as typeof process.stdin.write;

    await expect(supervisor.command("disconnect", {})).rejects.toThrow();

    expect(process.kill).toHaveBeenCalled();
  });

  it("does not let a stale child write callback terminate its replacement", async () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    respondToHello(first);
    respondToHello(second);
    const processes = [first, second];
    const supervisor = supervisorWith(() => {
      const next = processes.shift();
      if (next === undefined) {
        throw new Error("unexpected spawn");
      }
      return next;
    });
    await supervisor.start();
    let finishWrite: ((error?: Error | null) => void) | undefined;
    first.stdin.write = vi.fn(
      (_chunk: unknown, callback: (error?: Error | null) => void): boolean => {
        finishWrite = callback;
        return true;
      },
    ) as unknown as typeof first.stdin.write;
    const request = supervisor.command("disconnect", {});
    const rejection = expect(request).rejects.toThrow();

    first.exit(9);
    await vi.waitFor(() => expect(supervisor.snapshot().state).toBe("running"));
    finishWrite?.(new Error("stale write failure"));
    await rejection;

    expect(second.kill).not.toHaveBeenCalled();
    expect(supervisor.snapshot().state).toBe("running");
  });

  it("stops processing frames after the originating generation is invalidated", async () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    respondToHello(first);
    respondToHello(second);
    const processes = [first, second];
    const supervisor = supervisorWith(() => {
      const next = processes.shift();
      if (next === undefined) {
        throw new Error("unexpected spawn");
      }
      return next;
    });
    await supervisor.start();
    const received: string[] = [];
    supervisor.subscribe((event) => received.push(event.type));
    const unknownResponse = JSON.stringify({
      protocol: { major: 1, minor: 0 },
      type: "command_result",
      requestId: "unknown-request",
      monotonicNs: "2",
      payload: { commandType: "disconnect", success: true },
    });
    const staleEvent = JSON.stringify({
      protocol: { major: 1, minor: 0 },
      type: "connection_state",
      monotonicNs: "3",
      payload: {
        state: "streaming",
        paused: false,
        generation: "7",
        lastError: "",
      },
    });

    first.stdout.write(`${unknownResponse}\n${staleEvent}\n`);
    await vi.waitFor(() => expect(supervisor.snapshot().state).toBe("running"));

    expect(received).not.toContain("connection_state");
  });

  it("preserves UTF-8 characters split across stdout chunks", async () => {
    const process = new FakeProcess();
    respondToHello(process);
    const supervisor = supervisorWith(() => process);
    await supervisor.start();
    const received: string[] = [];
    supervisor.subscribe((event) => {
      if (event.type === "connection_state") {
        received.push(event.payload.lastError);
      }
    });
    const frame = Buffer.from(
      `${JSON.stringify({
        protocol: { major: 1, minor: 0 },
        type: "connection_state",
        monotonicNs: "2",
        payload: {
          state: "streaming",
          paused: false,
          generation: "1",
          lastError: "测",
        },
      })}\n`,
      "utf8",
    );
    const multibyte = frame.indexOf(Buffer.from("测", "utf8"));

    process.stdout.write(frame.subarray(0, multibyte + 1));
    process.stdout.write(frame.subarray(multibyte + 1));

    expect(received).toEqual(["测"]);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("isolates a throwing subscriber from the backend and other subscribers", async () => {
    const process = new FakeProcess();
    respondToHello(process);
    const supervisor = supervisorWith(() => process);
    await supervisor.start();
    const received: string[] = [];
    supervisor.subscribe(() => {
      throw new Error("renderer listener failed");
    });
    supervisor.subscribe((event) => received.push(event.type));

    process.stdout.write(
      `${JSON.stringify({
        protocol: { major: 1, minor: 0 },
        type: "connection_state",
        monotonicNs: "2",
        payload: {
          state: "streaming",
          paused: false,
          generation: "1",
          lastError: "",
        },
      })}\n`,
    );

    expect(received).toEqual(["connection_state"]);
    expect(process.kill).not.toHaveBeenCalled();
    expect(supervisor.snapshot().state).toBe("running");
  });

  it("rejects invalid UTF-8 instead of substituting replacement text", async () => {
    const process = new FakeProcess();
    respondToHello(process);
    const supervisor = supervisorWith(() => process);
    await supervisor.start();

    process.stdout.write(
      Buffer.concat([
        Buffer.from(
          '{"protocol":{"major":1,"minor":0},"type":"connection_state","monotonicNs":"2","payload":{"state":"streaming","paused":false,"generation":"1","lastError":"',
          "utf8",
        ),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}}\n', "utf8"),
      ]),
    );

    await vi.waitFor(() => expect(process.kill).toHaveBeenCalled());
  });
});

describe("LogStore", () => {
  it("keeps five bounded files and redacts sensitive stderr data", () => {
    const directory = mkdtempSync(join(tmpdir(), "netft-viewer-logs-"));
    temporaryDirectories.push(directory);
    const store = new LogStore(directory);
    const line = `${"x".repeat(65_000)} 10.20.30.40 ${process.env.HOME ?? ""}\n`;

    for (let index = 0; index < 180; index += 1) {
      store.append(line);
    }
    store.close();

    const files = readdirSync(directory).sort();
    expect(files).toHaveLength(5);
    const contents = files.map((file) =>
      readFileSync(join(directory, file), "utf8"),
    );
    expect(
      contents.every((content) => Buffer.byteLength(content) <= 2_097_152),
    ).toBe(true);
    expect(contents.join("")).not.toContain("10.20.30.40");
    if (process.env.HOME !== undefined) {
      expect(contents.join("")).not.toContain(process.env.HOME);
    }
  });

  it("rejects current and rotated symlink targets without following them", () => {
    const directory = mkdtempSync(join(tmpdir(), "netft-viewer-logs-"));
    temporaryDirectories.push(directory);
    const external = join(directory, "external.txt");
    writeFileSync(external, "preserve");
    symlinkSync(external, join(directory, "companion.log"));

    expect(() => new LogStore(directory)).toThrow();
    expect(readFileSync(external, "utf8")).toBe("preserve");

    rmSync(join(directory, "companion.log"));
    const store = new LogStore(directory, "companion.log", 65_536, 5);
    store.append("x".repeat(65_000));
    symlinkSync(external, join(directory, "companion.log.1"));
    expect(() => store.append("x".repeat(65_000))).toThrow();
    expect(readFileSync(external, "utf8")).toBe("preserve");
  });

  it("rejects non-regular current and rotated log targets", () => {
    const directory = mkdtempSync(join(tmpdir(), "netft-viewer-logs-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "companion.log");
    mkdirSync(target);

    expect(() => new LogStore(directory)).toThrow();

    rmSync(target, { recursive: true });
    const store = new LogStore(directory);
    mkdirSync(join(directory, "companion.log.1"));

    expect(() => store.append("diagnostic\n")).toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "enforces private POSIX directory and file permissions",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "netft-viewer-logs-"));
      temporaryDirectories.push(directory);
      chmodSync(directory, 0o777);
      const store = new LogStore(directory);
      store.append("diagnostic\n");

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
    },
  );
});
