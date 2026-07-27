import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

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
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error("unsupported Forge platform");
  }
  if (!["arm64", "x64", "universal"].includes(architecture)) {
    throw new Error("unsupported Forge architecture");
  }
  if (platform !== process.platform) {
    throw new Error(
      "desktop artifacts must be built on their native operating system",
    );
  }
  if (architecture === "universal" && platform !== "darwin") {
    throw new Error("universal artifacts are supported only on macOS");
  }
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
  await prepareNativeCompanion(target.platform, target.architecture);
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
      resolve(`out/Net F-T Viewer-linux-${target.architecture}`),
    ]);
  }
};

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
