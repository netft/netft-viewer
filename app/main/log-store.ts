import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const RETAINED_LOG_FILES = 5;
const MAX_ENTRY_BYTES = 64 * 1024;

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redact = (input: string): string => {
  let value = input
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-host]");
  for (const home of [process.env.HOME, process.env.USERPROFILE]) {
    if (home !== undefined && home.length > 0) {
      value = value.replace(
        new RegExp(escapeRegularExpression(home), "g"),
        "[redacted-home]",
      );
    }
  }
  return value;
};

const boundedEntry = (input: string): Buffer => {
  const sanitized = Buffer.from(redact(input), "utf8");
  if (sanitized.byteLength <= MAX_ENTRY_BYTES) {
    return sanitized;
  }
  const suffix = Buffer.from("\n[entry truncated]\n", "utf8");
  return Buffer.concat([
    sanitized.subarray(0, MAX_ENTRY_BYTES - suffix.byteLength),
    suffix,
  ]);
};

const lstatIfPresent = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const requireRegularFileOrMissing = (path: string): Stats | undefined => {
  const metadata = lstatIfPresent(path);
  if (
    metadata !== undefined &&
    (metadata.isSymbolicLink() || !metadata.isFile())
  ) {
    throw new Error(`refusing unsafe log target: ${basename(path)}`);
  }
  return metadata;
};

export class LogStore {
  readonly path: string;

  private currentBytes: number;

  constructor(
    directory: string,
    filename = "companion.log",
    private readonly maximumBytes = MAX_LOG_BYTES,
    private readonly retainedFiles = RETAINED_LOG_FILES,
  ) {
    if (
      basename(filename) !== filename ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/.test(filename)
    ) {
      throw new Error("invalid log filename");
    }
    if (maximumBytes < MAX_ENTRY_BYTES || retainedFiles < 1) {
      throw new Error("invalid log retention limits");
    }
    const resolvedDirectory = resolve(directory);
    mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
    const directoryMetadata = lstatSync(resolvedDirectory);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new Error("refusing unsafe log directory");
    }
    if (process.platform !== "win32") {
      chmodSync(resolvedDirectory, 0o700);
    }
    this.path = join(resolvedDirectory, filename);
    this.validateTargets();
    this.currentBytes = requireRegularFileOrMissing(this.path)?.size ?? 0;
  }

  append(input: string | Buffer): void {
    const entry = boundedEntry(
      typeof input === "string" ? input : input.toString("utf8"),
    );
    this.validateTargets();
    if (this.currentBytes + entry.byteLength > this.maximumBytes) {
      this.rotate();
    }
    const noFollow =
      process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    const descriptor = openSync(
      this.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow,
      0o600,
    );
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new Error("refusing non-regular log target");
      }
      if (process.platform !== "win32") {
        fchmodSync(descriptor, 0o600);
      }
      writeSync(descriptor, entry);
    } finally {
      closeSync(descriptor);
    }
    this.currentBytes += entry.byteLength;
  }

  close(): void {
    // Writes are synchronous so there is no buffered state to flush here.
  }

  private rotatedPath(index: number): string {
    return join(
      resolve(this.path, ".."),
      `${basename(this.path)}.${index.toString()}`,
    );
  }

  private rotate(): void {
    this.validateTargets();
    const oldest = this.rotatedPath(this.retainedFiles - 1);
    if (lstatIfPresent(oldest) !== undefined) {
      unlinkSync(oldest);
    }
    for (let index = this.retainedFiles - 2; index >= 1; index -= 1) {
      const source = this.rotatedPath(index);
      if (lstatIfPresent(source) !== undefined) {
        renameSync(source, this.rotatedPath(index + 1));
      }
    }
    if (lstatIfPresent(this.path) !== undefined) {
      renameSync(this.path, this.rotatedPath(1));
    }
    this.currentBytes = 0;
  }

  private validateTargets(): void {
    requireRegularFileOrMissing(this.path);
    for (let index = 1; index < this.retainedFiles; index += 1) {
      requireRegularFileOrMissing(this.rotatedPath(index));
    }
  }
}
