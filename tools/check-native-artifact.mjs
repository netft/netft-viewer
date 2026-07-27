import { realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { verifyBinaryArchitecture } from "./lib/binary-inspection.mjs";
import { verifyCompanion } from "./lib/companion-handshake.mjs";
import { assertPlatformArchitecture } from "./lib/platform.mjs";

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

const LINUX_SYSTEM_LIBRARY =
  /^(?:ld-(?:linux|musl)[^/]*\.so(?:\.[0-9]+)*|lib(?:c|dl|gcc_s|m|pthread|rt|stdc\+\+)\.so(?:\.[0-9]+)*)$/;
const WINDOWS_SYSTEM_LIBRARIES = new Set([
  "advapi32.dll",
  "bcrypt.dll",
  "crypt32.dll",
  "iphlpapi.dll",
  "kernel32.dll",
  "ntdll.dll",
  "ole32.dll",
  "oleaut32.dll",
  "shell32.dll",
  "shlwapi.dll",
  "user32.dll",
  "ws2_32.dll",
]);

const validateLinuxDependencies = (output) => {
  let dependencyCount = 0;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (/^linux-vdso\.so\.1\s+\(0x[0-9a-f]+\)$/i.test(line)) {
      dependencyCount += 1;
      continue;
    }
    const directLoader = line.match(/^(\/\S+)\s+\(0x[0-9a-f]+\)$/i);
    if (directLoader !== null) {
      const name = directLoader[1].split("/").at(-1);
      if (
        !/^\/(?:lib|lib64|usr\/lib|usr\/lib64)\//.test(directLoader[1]) ||
        !LINUX_SYSTEM_LIBRARY.test(name)
      ) {
        throw new Error("native artifact has a non-system Linux dependency");
      }
      dependencyCount += 1;
      continue;
    }
    const resolved = line.match(/^(\S+)\s+=>\s+(\S+)\s+\(0x[0-9a-f]+\)$/i);
    if (
      resolved === null ||
      !LINUX_SYSTEM_LIBRARY.test(resolved[1]) ||
      !/^\/(?:lib|lib64|usr\/lib|usr\/lib64)\//.test(resolved[2])
    ) {
      throw new Error("native artifact has an unknown Linux dependency");
    }
    dependencyCount += 1;
  }
  if (dependencyCount === 0) {
    throw new Error("ldd did not report any validated dependencies");
  }
};

const validateWindowsDependencies = (output) => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let index = 0;

  if (
    /^Microsoft \(R\) COFF\/PE Dumper Version \d+(?:\.\d+)+$/i.test(
      lines[index] ?? "",
    )
  ) {
    index += 1;
    if (
      !/^Copyright \(C\) Microsoft Corporation\.\s+All rights reserved\.$/i.test(
        lines[index] ?? "",
      )
    ) {
      throw new Error("dumpbin reported an unknown Windows prologue");
    }
    index += 1;
  }
  if (!/^Dump of file .+$/i.test(lines[index] ?? "")) {
    throw new Error("dumpbin reported an unknown Windows prologue");
  }
  index += 1;
  if (!/^File Type: (?:DLL|EXECUTABLE IMAGE)$/i.test(lines[index] ?? "")) {
    throw new Error("dumpbin reported an unknown Windows image type");
  }
  index += 1;
  if (!/^Image has the following dependencies:$/i.test(lines[index] ?? "")) {
    throw new Error("dumpbin did not report a Windows dependency section");
  }
  index += 1;

  let dependencyCount = 0;
  while (index < lines.length && !/^Summary$/i.test(lines[index])) {
    const dependency = lines[index].match(/^([A-Za-z0-9_.-]+\.dll)$/i)?.[1];
    if (dependency === undefined) {
      throw new Error("dumpbin reported a malformed Windows dependency");
    }
    const normalizedDependency = dependency.toLowerCase();
    if (
      !WINDOWS_SYSTEM_LIBRARIES.has(normalizedDependency) &&
      !normalizedDependency.startsWith("api-ms-win-") &&
      !normalizedDependency.startsWith("ext-ms-win-")
    ) {
      throw new Error(`native artifact has an unknown Windows dependency`);
    }
    dependencyCount += 1;
    index += 1;
  }
  if (dependencyCount === 0) {
    throw new Error("dumpbin did not report any dependencies");
  }
  if (!/^Summary$/i.test(lines[index] ?? "")) {
    throw new Error("dumpbin did not report a Windows summary");
  }
  index += 1;

  let summaryCount = 0;
  for (; index < lines.length; index += 1) {
    if (!/^[0-9a-f]+\s+\S+$/i.test(lines[index])) {
      throw new Error("dumpbin reported a malformed Windows summary");
    }
    summaryCount += 1;
  }
  if (summaryCount === 0) {
    throw new Error("dumpbin did not report a Windows image summary");
  }
};

const validateMacDependencies = (output) => {
  let dependencyCount = 0;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.endsWith(":")) {
      continue;
    }
    const dependency = line.match(/^(\S+)\s+\(compatibility version /)?.[1];
    if (
      dependency === undefined ||
      (!dependency.startsWith("/usr/lib/") &&
        !dependency.startsWith("/System/Library/"))
    ) {
      throw new Error("native artifact has a non-system macOS dependency");
    }
    dependencyCount += 1;
  }
  if (dependencyCount === 0) {
    throw new Error("otool did not report any validated dependencies");
  }
};

export const validateDependencyReport = ({ platform, output }) => {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error("unsupported dependency report platform");
  }
  if (platform === "linux") {
    if (/\bnot found\b/i.test(output)) {
      throw new Error("native artifact has an unresolved Linux dependency");
    }
    validateLinuxDependencies(output);
  } else if (platform === "win32") {
    validateWindowsDependencies(output);
  } else {
    validateMacDependencies(output);
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

export const checkNativeArtifact = async ({
  platform,
  architecture,
  executable,
  buildDirectory,
}) => {
  assertPlatformArchitecture(platform, architecture);
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
  } else {
    throw new Error("unsupported native artifact platform");
  }
  validateDependencyReport({
    platform,
    output: dependencyOutput,
    buildDirectory: build,
  });
  await verifyBinaryArchitecture(binary, platform, architecture);
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
