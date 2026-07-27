import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { expectedArtifacts, packageDirectoryPath } from "./artifact-layout.mjs";
import { readBinaryArchitecture } from "./binary-inspection.mjs";
import { verifyPackageLayout } from "./package-layout.mjs";
import { assertNativeTarget } from "./platform.mjs";

const MAXIMUM_ENTRIES = 8192;
const MAXIMUM_TOOL_OUTPUT = 4 * 1024 * 1024;

const runCapture = async (command, arguments_) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAXIMUM_TOOL_OUTPUT) {
        child.kill();
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (outputBytes > MAXIMUM_TOOL_OUTPUT) {
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

const requireRegularArtifact = async (path) => {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (await realpath(path)) !== resolve(path)
  ) {
    throw new Error(`artifact must be a real regular file: ${basename(path)}`);
  }
};

const safeArchiveEntries = async (archive) => {
  const output = await runCapture("tar", ["-tf", archive]);
  const entries = output.split(/\r?\n/).filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.length > MAXIMUM_ENTRIES) {
    throw new Error("archive has an invalid entry count");
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error("archive contains an unsafe path");
    }
  }
};

const findPackagedApplication = async (root, platform) => {
  let visited = 0;
  let found;
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAXIMUM_ENTRIES) {
        throw new Error("extracted artifact entry limit exceeded");
      }
      const candidate = join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        continue;
      }
      if (metadata.isDirectory()) {
        await visit(candidate);
      } else if (
        metadata.isFile() &&
        entry.name === "app.asar" &&
        basename(directory).toLowerCase() === "resources"
      ) {
        if (found !== undefined) {
          throw new Error("artifact contains multiple packaged applications");
        }
        found =
          platform === "darwin"
            ? dirname(dirname(directory))
            : dirname(directory);
      }
    }
  };
  await visit(root);
  if (found === undefined) {
    throw new Error("artifact does not contain a packaged application");
  }
  return found;
};

const verifyExtracted = async ({
  root,
  platform,
  architecture,
  sensitiveValue,
}) => {
  const application = await findPackagedApplication(root, platform);
  await verifyPackageLayout({
    packageDirectory: application,
    platform,
    architecture,
    sensitiveValue,
  });
};

const extractTarArchive = async (archive, destination) => {
  await safeArchiveEntries(archive);
  await runCapture("tar", ["-xf", archive, "-C", destination]);
};

export const verifyWindowsSetupArchitecture = async (
  executable,
  architecture,
) => {
  if ((await readBinaryArchitecture(executable, "win32")) !== architecture) {
    throw new Error("Windows setup architecture does not match target");
  }
};

export const verifyPackageArtifacts = async ({
  outDirectory = "out",
  platform = process.platform,
  architecture = platform === "darwin" ? "universal" : process.arch,
  version,
  sensitiveValue,
}) => {
  assertNativeTarget({
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
    targetPlatform: platform,
    targetArchitecture: architecture,
  });
  const artifacts = expectedArtifacts({
    outDirectory,
    platform,
    architecture,
    version,
  });
  await Promise.all(artifacts.map(({ path }) => requireRegularArtifact(path)));

  const temporary = await mkdtemp(join(tmpdir(), "netft-artifacts-"));
  try {
    if (platform === "linux") {
      const deb = artifacts.find(({ kind }) => kind === "deb").path;
      const tar = artifacts.find(({ kind }) => kind === "tar").path;
      const debRoot = join(temporary, "deb");
      const tarRoot = join(temporary, "tar");
      await Promise.all([
        mkdir(debRoot, { recursive: true }),
        mkdir(tarRoot, { recursive: true }),
      ]);
      await runCapture("dpkg-deb", ["-x", deb, debRoot]);
      await extractTarArchive(tar, tarRoot);
      await verifyExtracted({
        root: debRoot,
        platform,
        architecture,
        sensitiveValue,
      });
      await verifyExtracted({
        root: tarRoot,
        platform,
        architecture,
        sensitiveValue,
      });
    } else if (platform === "win32") {
      const setup = artifacts.find(({ kind }) => kind === "setup").path;
      await verifyWindowsSetupArchitecture(setup, architecture);
      for (const kind of ["nupkg", "zip"]) {
        const root = join(temporary, kind);
        await mkdir(root, { recursive: true });
        const archive = artifacts.find(
          ({ kind: artifactKind }) => artifactKind === kind,
        ).path;
        await extractTarArchive(archive, root);
        await verifyExtracted({
          root,
          platform,
          architecture,
          sensitiveValue,
        });
      }
    } else {
      const zipRoot = join(temporary, "zip");
      await mkdir(zipRoot, { recursive: true });
      const zip = artifacts.find(({ kind }) => kind === "zip").path;
      await safeArchiveEntries(zip);
      await runCapture("ditto", ["-x", "-k", zip, zipRoot]);
      await verifyExtracted({
        root: zipRoot,
        platform,
        architecture,
        sensitiveValue,
      });

      const mount = join(temporary, "dmg");
      await mkdir(mount, { recursive: true });
      const dmg = artifacts.find(({ kind }) => kind === "dmg").path;
      let attached = false;
      try {
        await runCapture("hdiutil", [
          "attach",
          "-readonly",
          "-nobrowse",
          "-mountpoint",
          mount,
          dmg,
        ]);
        attached = true;
        await verifyExtracted({
          root: mount,
          platform,
          architecture,
          sensitiveValue,
        });
      } finally {
        if (attached) {
          await runCapture("hdiutil", ["detach", mount]);
        }
      }
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }

  const packaged = packageDirectoryPath({
    outDirectory,
    platform,
    architecture,
  });
  await verifyPackageLayout({
    packageDirectory: packaged,
    platform,
    architecture,
    sensitiveValue,
  });
  return artifacts;
};
