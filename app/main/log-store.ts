import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
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
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = resolve(directory, filename);
    this.currentBytes = existsSync(this.path) ? statSync(this.path).size : 0;
  }

  append(input: string | Buffer): void {
    const entry = boundedEntry(
      typeof input === "string" ? input : input.toString("utf8"),
    );
    if (this.currentBytes + entry.byteLength > this.maximumBytes) {
      this.rotate();
    }
    appendFileSync(this.path, entry, { mode: 0o600 });
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
    const oldest = this.rotatedPath(this.retainedFiles - 1);
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }
    for (let index = this.retainedFiles - 2; index >= 1; index -= 1) {
      const source = this.rotatedPath(index);
      if (existsSync(source)) {
        renameSync(source, this.rotatedPath(index + 1));
      }
    }
    if (existsSync(this.path)) {
      renameSync(this.path, this.rotatedPath(1));
    }
    this.currentBytes = 0;
  }
}
