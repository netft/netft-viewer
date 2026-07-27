import { realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { verifyCompanion } from "./lib/companion-handshake.mjs";

const runCapture = async (command, arguments_) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
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

const normalizedForComparison = (value, platform) =>
  platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;

export const validateDependencyReport = ({
  platform,
  output,
  buildDirectory,
  sourceDirectory = process.cwd(),
}) => {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error("unsupported dependency report platform");
  }
  if (platform === "linux" && /\bnot found\b/i.test(output)) {
    throw new Error("native artifact has an unresolved Linux dependency");
  }
  const normalizedOutput = normalizedForComparison(output, platform);
  const normalizedBuild = normalizedForComparison(
    resolve(buildDirectory),
    platform,
  );
  const normalizedSource = normalizedForComparison(
    resolve(sourceDirectory),
    platform,
  );
  if (
    normalizedOutput.includes(normalizedBuild) ||
    normalizedOutput.includes(normalizedSource)
  ) {
    throw new Error(
      "native artifact depends on a checkout or CMake build-tree library",
    );
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

const verifyMacArchitecture = (output, architecture) => {
  const hasX64 = /\bx86_64\b/.test(output);
  const hasArm64 = /\barm64\b/.test(output);
  if (
    (architecture === "universal" && !(hasX64 && hasArm64)) ||
    (architecture === "x64" && !hasX64) ||
    (architecture === "arm64" && !hasArm64)
  ) {
    throw new Error(
      "macOS companion does not contain the requested architecture",
    );
  }
};

export const checkNativeArtifact = async ({
  platform,
  architecture,
  executable,
  buildDirectory,
  verifySignature = false,
}) => {
  const binary = resolve(executable);
  const build = resolve(buildDirectory);
  const metadata = await lstat(binary);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (await realpath(binary)) !== binary
  ) {
    throw new Error("native artifact must be a real regular file");
  }
  const relativeBinary = relative(build, binary);
  if (
    relativeBinary === "" ||
    relativeBinary.startsWith("..") ||
    isAbsolute(relativeBinary)
  ) {
    throw new Error(
      "native artifact is outside the declared CMake build directory",
    );
  }

  let dependencyOutput;
  if (platform === "linux") {
    dependencyOutput = await runCapture("ldd", [binary]);
  } else if (platform === "win32") {
    dependencyOutput = await runCapture("dumpbin", ["/dependents", binary]);
  } else if (platform === "darwin") {
    dependencyOutput = await runCapture("otool", ["-L", binary]);
    verifyMacArchitecture(
      await runCapture("lipo", ["-info", binary]),
      architecture,
    );
    if (verifySignature) {
      await runCapture("codesign", ["--verify", "--deep", "--strict", binary]);
    }
  } else {
    throw new Error("unsupported native artifact platform");
  }
  validateDependencyReport({
    platform,
    output: dependencyOutput,
    buildDirectory: build,
  });
  await verifyCompanion(binary, await readIdentity());
};

const main = async () => {
  if (process.argv.length !== 6) {
    throw new Error(
      "usage: check-native-artifact.mjs <platform> <arch> <binary> <cmake-build-dir>",
    );
  }
  const [, , platform, architecture, executable, buildDirectory] = process.argv;
  await checkNativeArtifact({
    platform,
    architecture,
    executable,
    buildDirectory,
    verifySignature:
      platform === "darwin" &&
      process.env.NETFT_VIEWER_MACOS_SIGNING_ENABLED === "true",
  });
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
