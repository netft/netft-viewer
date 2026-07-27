import { createWriteStream, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { verifyCompanion } from "./lib/companion-handshake.mjs";

const run = async (command, arguments_, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      ...options,
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(
            `${command} exited with ${String(code ?? signal)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      }
    });
  });

const rejectSymlinks = async (root) => {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = join(root, entry.name);
    const metadata = await lstat(candidate);
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      throw new Error("portable source must not contain symbolic links");
    }
    if (metadata.isDirectory()) {
      await rejectSymlinks(candidate);
    } else if (!metadata.isFile()) {
      throw new Error("portable source must contain only regular files");
    }
  }
};

const readIdentity = async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const snapshotDocument = await readFile("CORE_SNAPSHOT.md", "utf8");
  const coreSnapshot = snapshotDocument.match(/\b[0-9a-f]{40}\b/)?.[0];
  if (
    typeof packageJson.version !== "string" ||
    !/^[0-9a-f]{40}$/.test(coreSnapshot ?? "")
  ) {
    throw new Error("application companion identity is unavailable");
  }
  return { appVersion: packageJson.version, coreSnapshot };
};

const createArchive = async (source, output, prefix) => {
  const temporary = `${output}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  const tar = spawn(
    "tar",
    [
      "--sort=name",
      "--format=gnu",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mtime=@0",
      "--mode=u+rwX,go+rX,go-w",
      `--transform=s,^${basename(source)},${prefix},`,
      "--create",
      "--file=-",
      "--directory",
      dirname(source),
      basename(source),
    ],
    { shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  const gzip = spawn("gzip", ["-9", "-n"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const errors = [];
  tar.stderr.on("data", (chunk) => errors.push(chunk));
  gzip.stderr.on("data", (chunk) => errors.push(chunk));
  const tarExit = new Promise((resolvePromise, rejectPromise) => {
    tar.once("error", rejectPromise);
    tar.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`tar exited with ${String(code ?? signal)}`));
      }
    });
  });
  const gzipExit = new Promise((resolvePromise, rejectPromise) => {
    gzip.once("error", rejectPromise);
    gzip.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`gzip exited with ${String(code ?? signal)}`));
      }
    });
  });
  tar.stdout.pipe(gzip.stdin);
  try {
    await Promise.all([
      pipeline(gzip.stdout, createWriteStream(temporary, { mode: 0o644 })),
      tarExit,
      gzipExit,
    ]);
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    const detail = Buffer.concat(errors).toString("utf8").trim();
    throw new Error(
      `portable archive creation failed${detail.length > 0 ? `: ${detail}` : ""}`,
      { cause: error },
    );
  }
};

const smokeArchive = async (archive, prefix, identity) => {
  const temporary = await mkdtemp(join(tmpdir(), "netft-viewer-portable-"));
  try {
    await run("tar", ["-xzf", archive, "--directory", temporary]);
    await verifyCompanion(
      join(
        temporary,
        prefix,
        "resources",
        "companion",
        "netft-viewer-companion",
      ),
      identity,
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
};

export const makePortable = async (sourceArgument, outputArgument) => {
  if (process.platform !== "linux") {
    throw new Error("Linux portable archives must be created on Linux");
  }
  const source = resolve(sourceArgument);
  const sourceMetadata = await lstat(source);
  if (
    sourceMetadata.isSymbolicLink() ||
    !sourceMetadata.isDirectory() ||
    (await realpath(source)) !== source
  ) {
    throw new Error("portable source must be a real packaged directory");
  }
  const match = basename(source).match(/-linux-(x64|arm64)$/);
  if (
    match === null ||
    basename(source) !== `Net F-T Viewer-linux-${match[1]}`
  ) {
    throw new Error("portable source name does not identify a Linux package");
  }
  const identity = await readIdentity();
  const prefix = `netft-viewer-${identity.appVersion}-linux-${match[1]}`;
  const output = resolve(
    outputArgument ?? join("out", "make", `${prefix}.tar.gz`),
  );
  const sourceRelativeOutput = relative(source, output);
  if (
    sourceRelativeOutput === "" ||
    (!sourceRelativeOutput.startsWith("..") &&
      !sourceRelativeOutput.startsWith("/"))
  ) {
    throw new Error("portable output must be outside the packaged directory");
  }
  await rejectSymlinks(source);
  for (const required of [
    join(source, "resources", "app.asar"),
    join(source, "resources", "companion", "netft-viewer-companion"),
  ]) {
    const metadata = await lstat(required);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("portable package layout is incomplete");
    }
  }
  await mkdir(dirname(output), { recursive: true, mode: 0o755 });
  await createArchive(source, output, prefix);
  await smokeArchive(output, prefix, identity);
  return output;
};

const main = async () => {
  if (process.argv.length < 3 || process.argv.length > 4) {
    throw new Error(
      "usage: make-portable.mjs <packaged-linux-app-dir> [output.tar.gz]",
    );
  }
  const output = await makePortable(process.argv[2], process.argv[3]);
  process.stdout.write(`${output}\n`);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
