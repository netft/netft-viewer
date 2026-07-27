import { constants } from "node:fs";
import { realpathSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { verifyCompanion } from "./lib/companion-handshake.mjs";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "ia32", "universal", "x64"]);

const usage = () => {
  throw new Error(
    "usage: copy-companion.mjs <cmake-build-dir> <platform> <arch> [--staging-root <directory>]",
  );
};

const parseArguments = (arguments_) => {
  if (arguments_.length < 3) {
    usage();
  }
  const [buildDirectory, platform, architecture, ...rest] = arguments_;
  let stagingRoot = "build/packaging/companion";
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== "--staging-root" || index + 1 >= rest.length) {
      usage();
    }
    stagingRoot = rest[index + 1];
    index += 1;
  }
  if (
    !SUPPORTED_PLATFORMS.has(platform) ||
    !SUPPORTED_ARCHITECTURES.has(architecture)
  ) {
    throw new Error("unsupported Forge platform or architecture");
  }
  return {
    buildDirectory: resolve(buildDirectory),
    platform,
    architecture,
    stagingRoot: resolve(stagingRoot),
  };
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

const requireRealDirectory = async (directory, label) => {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  if ((await realpath(directory)) !== directory) {
    throw new Error(`${label} must not traverse symbolic links`);
  }
};

const findCompanion = async (buildDirectory, platform) => {
  await requireRealDirectory(buildDirectory, "CMake build directory");
  const executable =
    platform === "win32"
      ? "netft-viewer-companion.exe"
      : "netft-viewer-companion";
  const candidates = [
    join(buildDirectory, "core", "companion", executable),
    join(buildDirectory, "core", "companion", "Release", executable),
    join(buildDirectory, "Release", executable),
  ];
  const matches = [];
  for (const candidate of candidates) {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("native companion must be a regular non-symlink file");
      }
      if ((await realpath(candidate)) !== candidate) {
        throw new Error("native companion path must not traverse symlinks");
      }
      matches.push(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "native companion was not found in the CMake build directory"
        : "multiple native companion candidates were found",
    );
  }
  if (platform !== "win32") {
    await access(matches[0], constants.X_OK);
  }
  return matches[0];
};

const safeStage = async (source, destination, platform) => {
  const destinationDirectory = dirname(destination);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
  const directoryMetadata = await lstat(destinationDirectory);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    (await realpath(destinationDirectory)) !== destinationDirectory
  ) {
    throw new Error("companion staging directory is unsafe");
  }
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("existing companion staging target is unsafe");
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const temporary = join(
    destinationDirectory,
    `.${basename(destination)}.${process.pid}.tmp`,
  );
  await rm(temporary, { force: true });
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (platform !== "win32") {
      await chmod(temporary, 0o755);
    }
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const stageCompanion = async (options) => {
  const identity = await readIdentity();
  const source = await findCompanion(options.buildDirectory, options.platform);
  await verifyCompanion(source, identity);

  const executable =
    options.platform === "win32"
      ? "netft-viewer-companion.exe"
      : "netft-viewer-companion";
  const destination = join(
    options.stagingRoot,
    `${options.platform}-${options.architecture}`,
    "companion",
    executable,
  );
  await safeStage(source, destination, options.platform);
  await verifyCompanion(destination, identity);
  return destination;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const destination = await stageCompanion(options);
  process.stdout.write(`${destination}\n`);
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
