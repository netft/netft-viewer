#!/usr/bin/env node

import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const APP_VERSION = "0.1.0";
const CORE_SNAPSHOT = "f2c24fe22372dc8b2383bc08320ab1c5fe06ac21";
const MAXIMUM_CONTROL_BYTES = 64 * 1024;
const controlFile = process.env.NETFT_VIEWER_E2E_CONTROL_FILE;
const controlToken = process.env.NETFT_VIEWER_E2E_CONTROL_TOKEN;
const failureSentinel = process.env.NETFT_VIEWER_E2E_FAILURE_SENTINEL;

if (
  !controlFile ||
  !controlToken ||
  controlToken.length < 32 ||
  !failureSentinel
) {
  process.exit(78);
}
if (existsSync(failureSentinel)) {
  process.exit(70);
}

let monotonic = 1n;
let connectionGeneration = 0n;
let connected = false;
let paused = false;
let recording = false;
let recordingTarget = "";
let partialPath = "";
let acceptedSequences = [];
let biasCount = 0;
let shuttingDown = false;

const envelope = (type, payload, requestId) => ({
  protocol: { major: 1, minor: 0 },
  type,
  ...(requestId === undefined ? {} : { requestId }),
  monotonicNs: (monotonic++).toString(),
  payload,
});

const emit = (type, payload, requestId) => {
  process.stdout.write(
    `${JSON.stringify(envelope(type, payload, requestId))}\n`,
  );
};

const commandResult = (commandType, requestId, success = true) => {
  emit(
    "command_result",
    success
      ? { commandType, success: true }
      : {
          commandType,
          success: false,
          errorCode: "invalid_state",
          errorMessage: "Command is unavailable in the current state",
        },
    requestId,
  );
};

const configuration = {
  productName: "E2E Net F/T",
  countsPerForceUnit: 1_000_000,
  countsPerTorqueUnit: 1_000_000,
  forceUnit: "N",
  torqueUnit: "N-mm",
  source: "sensor",
  revision: "1",
};

const emitConnection = (state = connected ? "streaming" : "disconnected") => {
  emit("connection_state", {
    state,
    paused,
    generation: connectionGeneration.toString(),
    lastError: "",
  });
};

const emitHealth = () => {
  emit("health", {
    state: connected ? "streaming" : "stopped",
    faultCode: "none",
    sensorHost: connected ? "192.168.1.1" : "",
    rdtPort: 49152,
    ...(connected ? { sensorConfiguration: configuration } : {}),
    lastRdtSequence: null,
    lastFtSequence: null,
    lastStatus: 0,
    receiveRateHz: connected ? 1000 : 0,
    deliveryRateHz: connected ? 500 : 0,
    receivedCount: "0",
    deliveredCount: "0",
    rateLimitedCount: "0",
    deviceErrorCount: "0",
    warningCount: "0",
    lostCount: "0",
    duplicateCount: "0",
    outOfOrderCount: "0",
    malformedCount: "0",
    reconnectCount: "0",
    timeoutCount: "0",
    callbackErrorCount: "0",
    ftStallCount: "0",
    ftBackwardCount: "0",
    ftRestartCount: "0",
    calibrationChangeCount: "0",
    lastRecordAgeNs: null,
    lastError: "",
    lastFtProgress: "",
  });
};

const emitRecordingState = (state, lastError = "") => {
  emit("recording_state", {
    state,
    partialPath,
    lastError,
  });
};

const emitRecordingProgress = () => {
  const count = acceptedSequences.length.toString();
  emit("recording_progress", {
    acceptedSamples: count,
    writtenSamples: count,
    bytesWritten:
      partialPath.length > 0 && existsSync(partialPath)
        ? String(Buffer.byteLength(acceptedSequences.join(",")))
        : "0",
    queueSize: "0",
    queueCapacity: "65536",
  });
};

const emitSample = (sequence) => {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !connected) {
    throw new Error("invalid sample sequence");
  }
  const hostTimeNs = (
    1_000_000_000n +
    BigInt(sequence) * 1_000_000n
  ).toString();
  const raw = [1, -2, 3, 4, -5, 6].map((value) => value * sequence);
  const force = [sequence + 0.1, sequence + 0.2, sequence + 0.3];
  const torque = [sequence + 0.4, sequence + 0.5, sequence + 0.6];
  if (!paused) {
    emit("live_wrench", {
      hostTimeNs,
      sampleMonotonicNs: hostTimeNs,
      rdtSequence: sequence,
      ftSequence: sequence + 1000,
      status: 0,
      raw,
      force,
      torque,
      forceUnit: "N",
      torqueUnit: "N-mm",
      configurationRevision: "1",
    });
    emit("plot_batch", {
      axes: ["Fx", "Fy", "Fz", "Tx", "Ty", "Tz"].map((axis, index) => ({
        axis,
        points: [{ hostTimeNs, value: [...force, ...torque][index] }],
      })),
    });
    if (recording) {
      acceptedSequences.push(sequence);
      appendFileSync(
        partialPath,
        `${sequence},${hostTimeNs},${raw.join(",")},${[...force, ...torque].join(",")}\n`,
        { encoding: "utf8" },
      );
      emitRecordingProgress();
    }
  }
};

const handleCompanionCommand = (line) => {
  const request = JSON.parse(line);
  const requestId = request.requestId;
  const type = request.type;
  if (typeof requestId !== "string" || typeof type !== "string") {
    throw new Error("invalid companion request");
  }
  switch (type) {
    case "hello":
      emit(
        "hello",
        {
          protocolMajor: 1,
          protocolMinor: 0,
          appVersion: APP_VERSION,
          coreSnapshot: CORE_SNAPSHOT,
        },
        requestId,
      );
      return;
    case "connect":
      connectionGeneration += 1n;
      connected = true;
      paused = false;
      emitConnection("connecting");
      emit("configuration_changed", configuration);
      emitHealth();
      emitConnection();
      commandResult(type, requestId);
      return;
    case "disconnect":
      connected = false;
      paused = false;
      recording = false;
      emitConnection("disconnecting");
      emitConnection("disconnected");
      emitHealth();
      commandResult(type, requestId);
      return;
    case "set_paused": {
      if (!connected || typeof request.payload?.paused !== "boolean") {
        commandResult(type, requestId, false);
        return;
      }
      paused = request.payload.paused;
      emitConnection();
      if (recording) {
        emitRecordingState(paused ? "paused" : "recording");
      }
      commandResult(type, requestId);
      return;
    }
    case "bias":
      if (connected && !paused) {
        biasCount += 1;
        commandResult(type, requestId);
      } else {
        commandResult(type, requestId, false);
      }
      return;
    case "start_recording":
      if (
        !connected ||
        paused ||
        typeof request.payload?.targetPath !== "string"
      ) {
        commandResult(type, requestId, false);
        return;
      }
      recordingTarget = request.payload.targetPath;
      partialPath = `${recordingTarget}.partial`;
      acceptedSequences = [];
      writeFileSync(
        partialPath,
        "sequence,host_time_ns,raw_fx,raw_fy,raw_fz,raw_tx,raw_ty,raw_tz,fx,fy,fz,tx,ty,tz\n",
        { encoding: "utf8", flag: "wx" },
      );
      emitRecordingState("starting");
      recording = true;
      emitRecordingState("recording");
      emitRecordingProgress();
      commandResult(type, requestId);
      return;
    case "stop_recording":
      if (recording) {
        emitRecordingState("stopping");
        recording = false;
        renameSync(partialPath, recordingTarget);
        partialPath = "";
        emitRecordingState("idle");
        emitRecordingProgress();
      }
      commandResult(type, requestId);
      return;
    case "shutdown":
      shuttingDown = true;
      commandResult(type, requestId);
      controlServer.close(() => process.exit(0));
      return;
    default:
      commandResult(type, requestId, false);
  }
};

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  if (Buffer.byteLength(stdinBuffer) > 1024 * 1024) {
    process.exit(65);
  }
  for (;;) {
    const newline = stdinBuffer.indexOf("\n");
    if (newline < 0) {
      break;
    }
    const line = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    try {
      handleCompanionCommand(line);
    } catch {
      process.exit(65);
    }
  }
});

const controlResponse = (socket, id, ok, result) => {
  socket.write(`${JSON.stringify({ id, ok, result })}\n`);
};

const controlServer = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(5_000, () => socket.destroy());
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAXIMUM_CONTROL_BYTES) {
      socket.destroy();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let request;
      try {
        request = JSON.parse(line);
        if (
          request.token !== controlToken ||
          typeof request.id !== "string" ||
          typeof request.action !== "string"
        ) {
          throw new Error("unauthorized control request");
        }
        switch (request.action) {
          case "state":
            controlResponse(socket, request.id, true, {
              acceptedSequences,
              biasCount,
              connected,
              paused,
              recording,
            });
            break;
          case "emit_sample":
            emitSample(request.sequence);
            controlResponse(socket, request.id, true, null);
            break;
          case "recording_error": {
            const message = "fixture recorder failure";
            recording = false;
            emitRecordingState("error", message);
            emit("error", {
              operation: "recording",
              message,
              errorCode: "fixture_recording_error",
              sequence: "1",
              droppedBefore: "0",
            });
            controlResponse(socket, request.id, true, { partialPath });
            break;
          }
          case "exit":
            controlResponse(socket, request.id, true, null);
            setTimeout(() => process.exit(71), 10);
            break;
          case "fail_restarts":
            writeFileSync(failureSentinel, "armed\n", {
              encoding: "utf8",
              flag: "wx",
              mode: 0o600,
            });
            controlResponse(socket, request.id, true, null);
            setTimeout(() => process.exit(72), 10);
            break;
          default:
            throw new Error("unknown control action");
        }
      } catch (error) {
        controlResponse(
          socket,
          typeof request?.id === "string" ? request.id : "",
          false,
          error instanceof Error ? error.message : "control error",
        );
      }
    }
  });
});

controlServer.listen(0, "127.0.0.1", () => {
  const address = controlServer.address();
  if (address === null || typeof address === "string") {
    process.exit(74);
  }
  writeFileSync(
    controlFile,
    JSON.stringify({
      pid: process.pid,
      port: address.port,
      token: controlToken,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
});

process.on("SIGTERM", () => {
  if (!shuttingDown) {
    process.exit(0);
  }
});
