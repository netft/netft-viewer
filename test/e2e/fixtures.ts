import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rm, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

interface ControlEndpoint {
  pid: number;
  port: number;
  token: string;
}

interface FakeState {
  acceptedSequences: number[];
  biasCount: number;
  connected: boolean;
  paused: boolean;
  recording: boolean;
}

class FakeCompanionControl {
  constructor(
    private readonly controlFile: string,
    private readonly token: string,
  ) {}

  async endpoint(previousPid?: number): Promise<ControlEndpoint> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      try {
        const parsed = JSON.parse(
          await readFile(this.controlFile, "utf8"),
        ) as ControlEndpoint;
        if (
          Number.isInteger(parsed.pid) &&
          Number.isInteger(parsed.port) &&
          parsed.port > 0 &&
          parsed.port <= 65_535 &&
          parsed.token === this.token &&
          parsed.pid !== previousPid
        ) {
          return parsed;
        }
      } catch {
        // The companion writes the rendezvous file after binding localhost.
      }
      if (Date.now() >= deadline) {
        throw new Error("fake companion control endpoint timeout");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }

  async request<Result>(
    action: string,
    payload: Record<string, unknown> = {},
    previousPid?: number,
  ): Promise<Result> {
    const endpoint = await this.endpoint(previousPid);
    const id = randomUUID();
    return new Promise<Result>((resolvePromise, rejectPromise) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: endpoint.port,
      });
      const timeout = setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error("fake companion control response timeout"));
      }, 5_000);
      let buffer = "";
      const finish = (error?: Error, result?: Result) => {
        clearTimeout(timeout);
        socket.destroy();
        if (error === undefined) {
          resolvePromise(result as Result);
        } else {
          rejectPromise(error);
        }
      };
      socket.setEncoding("utf8");
      socket.once("error", (error) => finish(error));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 64 * 1024) {
          finish(new Error("oversized fake companion control response"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as {
            id: string;
            ok: boolean;
            result: Result;
          };
          if (response.id !== id || !response.ok) {
            throw new Error("invalid fake companion control response");
          }
          finish(undefined, response.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({ action, id, token: this.token, ...payload })}\n`,
        );
      });
    });
  }

  emitSample(sequence: number): Promise<null> {
    return this.request("emit_sample", { sequence });
  }

  state(): Promise<FakeState> {
    return this.request("state");
  }

  triggerRecordingError(): Promise<{ partialPath: string }> {
    return this.request("recording_error");
  }

  exit(): Promise<null> {
    return this.request("exit");
  }

  failRestarts(): Promise<null> {
    return this.request("fail_restarts");
  }
}

interface DialogPlan {
  messageResponses?: number[];
  saveResponses?: { canceled: boolean; filePath: string }[];
}

export interface ViewerFixture {
  app: ElectronApplication;
  consoleErrors: string[];
  fakeCompanion: FakeCompanionControl;
  failureSentinel: string;
  page: Page;
  pageErrors: string[];
  tempDirectory: string;
  clearFailureSentinel(): Promise<void>;
  setDialogs(plan: DialogPlan): Promise<void>;
}

const packagedExecutable = (): string => {
  if (process.platform === "linux") {
    return resolve(`out/e2e/Net F-T Viewer-linux-${process.arch}/netft-viewer`);
  }
  if (process.platform === "darwin") {
    return resolve(
      `out/e2e/Net F-T Viewer-darwin-${process.arch}/Net F-T Viewer.app/Contents/MacOS/netft-viewer`,
    );
  }
  return resolve(
    `out/e2e/Net F-T Viewer-win32-${process.arch}/netft-viewer.exe`,
  );
};

export const test = base.extend<{ viewer: ViewerFixture }>({
  viewer: async ({}, use) => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "netft-viewer-e2e-"));
    const userData = join(tempDirectory, "user-data");
    const controlFile = join(tempDirectory, "control.json");
    const failureSentinel = join(tempDirectory, "fail-restarts");
    const token = randomBytes(32).toString("hex");
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    let app: ElectronApplication | undefined;
    try {
      app = await electron.launch({
        executablePath: packagedExecutable(),
        args: [`--user-data-dir=${userData}`],
        env: {
          ...process.env,
          NETFT_VIEWER_E2E_CONTROL_FILE: controlFile,
          NETFT_VIEWER_E2E_CONTROL_TOKEN: token,
          NETFT_VIEWER_E2E_FAILURE_SENTINEL: failureSentinel,
        },
      });
      const attachedPages = new WeakSet<Page>();
      const attachDiagnostics = (candidate: Page): void => {
        if (attachedPages.has(candidate)) {
          return;
        }
        attachedPages.add(candidate);
        candidate.on("console", (message) => {
          if (message.type() === "error") {
            consoleErrors.push(message.text());
          }
        });
        candidate.on("pageerror", (error) => pageErrors.push(String(error)));
      };
      app.on("window", attachDiagnostics);
      for (const candidate of app.windows()) {
        attachDiagnostics(candidate);
      }
      const page = await app.firstWindow();
      attachDiagnostics(page);
      const fakeCompanion = new FakeCompanionControl(controlFile, token);
      await fakeCompanion.endpoint();
      await use({
        app,
        consoleErrors,
        fakeCompanion,
        failureSentinel,
        page,
        pageErrors,
        tempDirectory,
        clearFailureSentinel: async () => {
          await unlink(failureSentinel).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") {
                throw error;
              }
            },
          );
        },
        setDialogs: async (plan) => {
          await app?.evaluate(async ({ dialog }, serializedPlan) => {
            const messages = [...(serializedPlan.messageResponses ?? [])];
            const saves = [...(serializedPlan.saveResponses ?? [])];
            dialog.showMessageBox = async () => ({
              response: messages.shift() ?? 0,
              checkboxChecked: false,
            });
            dialog.showSaveDialog = async () =>
              saves.shift() ?? { canceled: true, filePath: "" };
          }, plan);
        },
      });
    } finally {
      await app?.close().catch(() => undefined);
      await rm(tempDirectory, { force: true, recursive: true });
    }
  },
});

export { expect };
