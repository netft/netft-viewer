import { constants, createReadStream } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { extractFile, listPackage } from "@electron/asar";

import { verifyBinaryArchitecture } from "./binary-inspection.mjs";
import { verifyCompanion } from "./companion-handshake.mjs";
import { assertPlatformArchitecture } from "./platform.mjs";

const MAXIMUM_SCAN_FILES = 4096;
const MAXIMUM_SCAN_FILE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_SCAN_TOTAL_BYTES = 1024 * 1024 * 1024;

export const readApplicationIdentity = async () => {
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

const fileContains = async (path, needle) => {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  let overlap = Buffer.alloc(0);
  for await (const chunk of stream) {
    const candidate = Buffer.concat([overlap, chunk]);
    if (candidate.includes(needle)) {
      return true;
    }
    overlap =
      needle.length <= 1
        ? Buffer.alloc(0)
        : candidate.subarray(
            Math.max(0, candidate.length - (needle.length - 1)),
          );
  }
  return false;
};

export const scanTreeForForbiddenValue = async (rootArgument, value) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("forbidden package value must be non-empty");
  }
  const root = resolve(rootArgument);
  const needle = Buffer.from(value, "utf8");
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        continue;
      }
      if (metadata.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("package scan accepts only regular files");
      }
      fileCount += 1;
      totalBytes += metadata.size;
      if (
        fileCount > MAXIMUM_SCAN_FILES ||
        metadata.size > MAXIMUM_SCAN_FILE_BYTES ||
        totalBytes > MAXIMUM_SCAN_TOTAL_BYTES
      ) {
        throw new Error("package scan limit exceeded");
      }
      if (await fileContains(candidate, needle)) {
        const displayPath = relative(root, candidate).split(sep).join("/");
        throw new Error(`package contains forbidden value in ${displayPath}`);
      }
    }
  };
  await visit(root);
};

export const resolvePackageLayout = (
  packageDirectory,
  platform,
  architecture,
) => {
  assertPlatformArchitecture(platform, architecture);
  const root = resolve(packageDirectory);
  if (platform === "darwin") {
    const application = basename(root).endsWith(".app")
      ? root
      : join(root, "Net F-T Viewer.app");
    const contents = join(application, "Contents");
    return {
      root,
      application,
      resources: join(contents, "Resources"),
      companion: join(
        contents,
        "Resources",
        "companion",
        "netft-viewer-companion",
      ),
    };
  }
  return {
    root,
    application: root,
    resources: join(root, "resources"),
    companion: join(
      root,
      "resources",
      "companion",
      platform === "win32"
        ? "netft-viewer-companion.exe"
        : "netft-viewer-companion",
    ),
  };
};

export const verifyPackageLayout = async ({
  packageDirectory,
  platform,
  architecture,
  sensitiveValue,
}) => {
  const layout = resolvePackageLayout(packageDirectory, platform, architecture);
  const archive = join(layout.resources, "app.asar");
  const archiveFiles = listPackage(archive);
  const companionMetadata = await lstat(layout.companion);
  if (
    companionMetadata.isSymbolicLink() ||
    !companionMetadata.isFile() ||
    (await realpath(layout.companion)) !== resolve(layout.companion)
  ) {
    throw new Error("packaged companion must be a real regular file");
  }
  if (platform !== "win32") {
    await access(layout.companion, constants.X_OK);
  }
  if (
    !archiveFiles.some((path) =>
      path.startsWith("/.vite/renderer/main_window/"),
    ) ||
    archiveFiles.some((path) => path.includes("netft-viewer-companion"))
  ) {
    throw new Error("renderer or companion is on the wrong ASAR boundary");
  }
  const forbiddenArchiveSegments = [
    "/app/",
    "/core/",
    "/test/",
    "/tools/",
    "/.superpowers/",
  ];
  if (
    archiveFiles.some(
      (path) =>
        forbiddenArchiveSegments.some((segment) => path.startsWith(segment)) ||
        /\.(?:map|ts|tsx|cpp|cc|cxx|h|hpp)$/.test(path),
    ) ||
    archiveFiles.some((path) => path.includes("fake-companion"))
  ) {
    throw new Error("production ASAR contains source or test resources");
  }
  const mainBundle = extractFile(archive, ".vite/build/main.js").toString(
    "utf8",
  );
  for (const forbidden of [
    "NETFT_VIEWER_E2E_BUILD",
    "NETFT_VIEWER_E2E_CONTROL_FILE",
    "NETFT_VIEWER_E2E_CONTROL_TOKEN",
    "NETFT_VIEWER_E2E_FAILURE_SENTINEL",
    "fake-companion.mjs",
  ]) {
    if (mainBundle.includes(forbidden)) {
      throw new Error("production main bundle contains an E2E hook");
    }
  }
  await verifyBinaryArchitecture(layout.companion, platform, architecture);
  await verifyCompanion(layout.companion, await readApplicationIdentity());
  if (sensitiveValue !== undefined && sensitiveValue.length > 0) {
    await scanTreeForForbiddenValue(layout.application, sensitiveValue);
  }
  return layout;
};
