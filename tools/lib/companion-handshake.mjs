import { spawn } from "node:child_process";

const MAXIMUM_OUTPUT_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;

const exactKeys = (value, expected) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
};

const assertEnvelope = (value, type, requestId) => {
  if (
    !exactKeys(value, [
      "protocol",
      "type",
      "requestId",
      "monotonicNs",
      "payload",
    ]) ||
    !exactKeys(value.protocol, ["major", "minor"]) ||
    value.protocol.major !== 1 ||
    value.protocol.minor !== 0 ||
    value.type !== type ||
    value.requestId !== requestId ||
    !/^(0|[1-9][0-9]*)$/.test(value.monotonicNs)
  ) {
    throw new Error(`companion returned an invalid ${type} envelope`);
  }
};

export const verifyCompanion = async (
  executable,
  { appVersion, coreSnapshot },
) => {
  if (
    typeof appVersion !== "string" ||
    appVersion.length === 0 ||
    !/^[0-9a-f]{40}$/.test(coreSnapshot)
  ) {
    throw new Error("expected companion identity is invalid");
  }

  const helloRequestId = "package-hello";
  const shutdownRequestId = "package-shutdown";
  const commands = [
    {
      protocol: { major: 1, minor: 0 },
      type: "hello",
      requestId: helloRequestId,
      monotonicNs: "0",
      payload: {},
    },
    {
      protocol: { major: 1, minor: 0 },
      type: "shutdown",
      requestId: shutdownRequestId,
      monotonicNs: "0",
      payload: {},
    },
  ];

  const output = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error === undefined) {
        resolvePromise(value);
      } else {
        child.kill();
        rejectPromise(error);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("companion handshake timed out")),
      HANDSHAKE_TIMEOUT_MS,
    );
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAXIMUM_OUTPUT_BYTES) {
        finish(new Error("companion handshake stdout exceeded byte limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAXIMUM_OUTPUT_BYTES) {
        finish(new Error("companion handshake stderr exceeded byte limit"));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            `companion handshake exited with ${String(code ?? signal)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(
      `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    );
  });

  const lines = output.trim().split("\n");
  if (lines.length !== 2) {
    throw new Error("companion handshake returned an unexpected frame count");
  }
  let hello;
  let shutdown;
  try {
    hello = JSON.parse(lines[0]);
    shutdown = JSON.parse(lines[1]);
  } catch {
    throw new Error("companion handshake returned invalid JSON");
  }

  assertEnvelope(hello, "hello", helloRequestId);
  if (
    !exactKeys(hello.payload, [
      "protocolMajor",
      "protocolMinor",
      "appVersion",
      "coreSnapshot",
    ]) ||
    hello.payload.protocolMajor !== 1 ||
    hello.payload.protocolMinor !== 0 ||
    hello.payload.appVersion !== appVersion ||
    hello.payload.coreSnapshot !== coreSnapshot
  ) {
    throw new Error("companion identity does not match the application");
  }

  assertEnvelope(shutdown, "command_result", shutdownRequestId);
  if (
    !exactKeys(shutdown.payload, ["commandType", "success"]) ||
    shutdown.payload.commandType !== "shutdown" ||
    shutdown.payload.success !== true
  ) {
    throw new Error("companion shutdown handshake is invalid");
  }

  return hello.payload;
};
