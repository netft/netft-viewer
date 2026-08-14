import assert from "node:assert/strict";
import { readFile, readlink, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "linux") {
  throw new Error("the installed application smoke test requires Linux");
}

const executable = process.argv[2];
if (executable === undefined || !isAbsolute(executable)) {
  throw new Error(
    "usage: production-backend-smoke.mjs <absolute-packaged-executable>",
  );
}

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const childPids = async (pid) => {
  try {
    const value = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return value.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

const descendants = async (rootPid) => {
  const pending = [rootPid];
  const found = [];
  while (pending.length > 0) {
    const pid = pending.pop();
    for (const childPid of await childPids(pid)) {
      found.push(childPid);
      pending.push(childPid);
    }
  }
  return found;
};

const executableName = async (pid) => {
  try {
    return basename(await readlink(`/proc/${pid}/exe`));
  } catch {
    return undefined;
  }
};

const temporary = await mkdtemp(join(tmpdir(), "netft-viewer-smoke-"));
const stderr = [];
const application = spawn(executable, [], {
  detached: true,
  env: {
    ...process.env,
    XDG_CACHE_HOME: join(temporary, "cache"),
    XDG_CONFIG_HOME: join(temporary, "config"),
  },
  shell: false,
  stdio: ["ignore", "ignore", "pipe"],
});
application.stderr.on("data", (chunk) => {
  if (stderr.reduce((size, value) => size + value.byteLength, 0) < 64 * 1024) {
    stderr.push(chunk);
  }
});

let failure;
try {
  await Promise.race([
    delay(5_000),
    new Promise((_, rejectPromise) => {
      application.once("error", rejectPromise);
      application.once("exit", (code, signal) =>
        rejectPromise(
          new Error(
            `packaged application exited before backend verification: ${String(code ?? signal)}`,
          ),
        ),
      );
    }),
  ]);
  const running = [];
  for (const pid of await descendants(application.pid)) {
    if ((await executableName(pid)) === "netft-viewer-companion") {
      running.push(pid);
    }
  }
  assert.equal(
    running.length,
    1,
    `expected one running packaged backend, found ${running.length}: ${Buffer.concat(stderr).toString("utf8")}`,
  );
} catch (error) {
  failure = error;
} finally {
  if (application.exitCode === null && application.signalCode === null) {
    try {
      process.kill(-application.pid, "SIGTERM");
    } catch {}
    await Promise.race([
      new Promise((resolvePromise) => application.once("exit", resolvePromise)),
      delay(2_000),
    ]);
  }
  if (application.exitCode === null && application.signalCode === null) {
    try {
      process.kill(-application.pid, "SIGKILL");
    } catch {}
  }
  await rm(temporary, { force: true, recursive: true });
}

if (failure !== undefined) {
  throw failure;
}
