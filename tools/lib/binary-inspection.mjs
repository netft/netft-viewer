import { open } from "node:fs/promises";
import { spawn } from "node:child_process";

import { assertPlatformArchitecture } from "./platform.mjs";

const HEADER_BYTES = 4096;
const TOOL_OUTPUT_BYTES = 64 * 1024;

const runCapture = async (command, arguments_) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`${command} timed out`));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > TOOL_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (bytes > TOOL_OUTPUT_BYTES) {
        rejectPromise(new Error(`${command} output exceeded byte limit`));
      } else if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
      } else {
        rejectPromise(
          new Error(
            `${command} exited with ${String(code ?? signal)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      }
    });
  });

export const parseBinaryArchitecture = (header, platform) => {
  if (platform === "linux") {
    if (
      header.length < 20 ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      ![1, 2].includes(header[5])
    ) {
      throw new Error("native companion is not a supported 64-bit ELF file");
    }
    const machine =
      header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
    if (machine === 62) {
      return "x64";
    }
    if (machine === 183) {
      return "arm64";
    }
    throw new Error("native companion has an unsupported ELF architecture");
  }
  if (platform === "win32") {
    if (header.length < 64 || header.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("native companion is not a PE file");
    }
    const peOffset = header.readUInt32LE(0x3c);
    if (
      peOffset > header.length - 6 ||
      header.toString("binary", peOffset, peOffset + 4) !== "PE\0\0"
    ) {
      throw new Error("native companion has a malformed PE header");
    }
    const machine = header.readUInt16LE(peOffset + 4);
    if (machine === 0x8664) {
      return "x64";
    }
    if (machine === 0xaa64) {
      return "arm64";
    }
    throw new Error("native companion has an unsupported PE architecture");
  }
  throw new Error("binary header parsing supports only ELF and PE files");
};

const readHeader = async (path) => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

export const readBinaryArchitecture = async (path, platform) =>
  parseBinaryArchitecture(await readHeader(path), platform);

const parseLipoArchitectures = (output) => {
  const architectures = new Set();
  if (/\bx86_64\b/.test(output)) {
    architectures.add("x64");
  }
  if (/\barm64\b/.test(output)) {
    architectures.add("arm64");
  }
  if (architectures.size === 0) {
    throw new Error("lipo did not report a supported architecture");
  }
  return architectures;
};

export const verifyBinaryArchitecture = async (
  path,
  platform,
  expectedArchitecture,
) => {
  assertPlatformArchitecture(platform, expectedArchitecture);
  if (platform === "darwin") {
    const architectures = parseLipoArchitectures(
      await runCapture("lipo", ["-info", path]),
    );
    const matches =
      expectedArchitecture === "universal"
        ? architectures.has("x64") &&
          architectures.has("arm64") &&
          architectures.size === 2
        : architectures.size === 1 && architectures.has(expectedArchitecture);
    if (!matches) {
      throw new Error("native companion architecture does not match target");
    }
    return;
  }
  if ((await readBinaryArchitecture(path, platform)) !== expectedArchitecture) {
    throw new Error("native companion architecture does not match target");
  }
};
