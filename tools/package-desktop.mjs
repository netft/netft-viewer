import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { packageDirectoryPath } from "./lib/artifact-layout.mjs";
import {
  assertFreshPackageArguments,
  cleanTargetOutputs,
  macSignatureCommands,
  runPackagingLifecycle,
} from "./lib/packaging-lifecycle.mjs";
import { assertNativeTarget } from "./lib/platform.mjs";

const require = createRequire(import.meta.url);
const forgePackage = require.resolve("@electron-forge/cli/package.json");
const forgeCli = resolve(dirname(forgePackage), "dist/electron-forge.js");

const run = async (command, arguments_, options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      shell: false,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(`${command} exited with ${String(code ?? signal)}`),
        );
      }
    });
  });

const extractTarget = (arguments_) => {
  const remaining = [];
  let platform;
  let architecture;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--platform" || argument === "--arch") {
      if (index + 1 >= arguments_.length) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--platform") {
        platform = arguments_[index + 1];
      } else {
        architecture = arguments_[index + 1];
      }
      index += 1;
    } else if (argument.startsWith("--platform=")) {
      platform = argument.slice("--platform=".length);
    } else if (argument.startsWith("--arch=")) {
      architecture = argument.slice("--arch=".length);
    } else {
      remaining.push(argument);
    }
  }
  platform ??= process.platform;
  architecture ??= platform === "darwin" ? "universal" : process.arch;
  assertNativeTarget({
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
    targetPlatform: platform,
    targetArchitecture: architecture,
  });
  return { platform, architecture, remaining };
};

const nativeExecutable = (buildDirectory, platform) =>
  join(
    buildDirectory,
    "core",
    "companion",
    platform === "win32"
      ? "netft-viewer-companion.exe"
      : "netft-viewer-companion",
  );

const prepareNativeCompanion = async (platform, architecture) => {
  const buildDirectory = resolve(
    process.env.NETFT_VIEWER_CMAKE_BUILD_DIR ??
      join("build", "package", `${platform}-${architecture}`),
  );
  const configure = [
    "-S",
    ".",
    "-B",
    buildDirectory,
    "-G",
    "Ninja",
    "-DBUILD_TESTING=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_SKIP_RPATH=ON",
  ];
  if (platform === "darwin" && architecture === "universal") {
    configure.push("-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64");
  }
  if (platform === "win32") {
    configure.push("-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded");
  }
  await run("cmake", configure);
  await run("cmake", [
    "--build",
    buildDirectory,
    "--config",
    "Release",
    "--target",
    "netft-viewer-companion",
  ]);

  const executable = nativeExecutable(buildDirectory, platform);
  if (platform === "linux") {
    await run("patchelf", ["--remove-rpath", executable]);
  }
  await run(process.execPath, [
    "tools/check-native-artifact.mjs",
    platform,
    architecture,
    executable,
    buildDirectory,
  ]);
  await run(process.execPath, [
    "tools/copy-companion.mjs",
    buildDirectory,
    platform,
    architecture,
  ]);
};

const main = async () => {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "package" && command !== "make") {
    throw new Error(
      "usage: package-desktop.mjs <package|make> [Forge options]",
    );
  }
  const target = extractTarget(arguments_);
  assertFreshPackageArguments(target.remaining);
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const outDirectory = resolve("out");
  const packageDirectory = packageDirectoryPath({
    outDirectory,
    platform: target.platform,
    architecture: target.architecture,
  });
  await runPackagingLifecycle({
    clean: () =>
      cleanTargetOutputs({
        outDirectory,
        platform: target.platform,
        architecture: target.architecture,
        version: packageJson.version,
      }),
    prepare: () => prepareNativeCompanion(target.platform, target.architecture),
    forge: async () => {
      await run(
        process.execPath,
        [
          forgeCli,
          command,
          "--platform",
          target.platform,
          "--arch",
          target.architecture,
          ...target.remaining,
        ],
        {
          env: {
            ...process.env,
            NETFT_VIEWER_FORGE_PLATFORM: target.platform,
            NETFT_VIEWER_FORGE_ARCHITECTURE: target.architecture,
          },
        },
      );
      if (command === "make" && target.platform === "linux") {
        await run(process.execPath, [
          "tools/make-portable.mjs",
          packageDirectory,
        ]);
      }
    },
    verifyPackage: () =>
      run(process.execPath, [
        "tools/verify-package-layout.mjs",
        packageDirectory,
        target.platform,
        target.architecture,
      ]),
    verifySignature: async () => {
      if (
        target.platform !== "darwin" ||
        (process.env.NETFT_VIEWER_MACOS_SIGN_IDENTITY?.length ?? 0) === 0
      ) {
        return;
      }
      const application = join(packageDirectory, "Net F-T Viewer.app");
      for (const {
        command: signatureCommand,
        arguments: signatureArguments,
      } of macSignatureCommands(application)) {
        await run(signatureCommand, signatureArguments);
      }
    },
    verifyArtifacts: async () => {
      if (command === "make") {
        await run(process.execPath, [
          "tools/verify-package-artifacts.mjs",
          target.platform,
          target.architecture,
          outDirectory,
        ]);
      }
    },
  });
};

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
