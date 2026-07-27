import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import { extractFile, listPackage } from "@electron/asar";

const packageDirectory = process.env.NETFT_VIEWER_PACKAGE_DIR;
const packageTestOptions = { skip: packageDirectory === undefined };
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const expectedSnapshot = (await readFile("CORE_SNAPSHOT.md", "utf8")).match(
  /\b[0-9a-f]{40}\b/,
)?.[0];
assert.notEqual(expectedSnapshot, undefined);

const packagedLayout = () => {
  const root = resolve(packageDirectory);
  if (process.platform === "darwin") {
    const appName = basename(root).endsWith(".app")
      ? root
      : join(root, "Net F-T Viewer.app");
    const contents = join(appName, "Contents");
    return {
      root,
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
    resources: join(root, "resources"),
    companion: join(
      root,
      "resources",
      "companion",
      process.platform === "win32"
        ? "netft-viewer-companion.exe"
        : "netft-viewer-companion",
    ),
  };
};

const runCompanionHandshake = async (executable) => {
  const requestId = "package-layout";
  const input = [
    {
      protocol: { major: 1, minor: 0 },
      type: "hello",
      requestId,
      monotonicNs: "0",
      payload: {},
    },
    {
      protocol: { major: 1, minor: 0 },
      type: "shutdown",
      requestId: "package-layout-shutdown",
      monotonicNs: "0",
      payload: {},
    },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("packaged companion handshake timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(
          new Error(
            `packaged companion exited with ${String(code ?? signal)}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      const frames = Buffer.concat(stdout)
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      resolvePromise(frames);
    });
    child.stdin.end(`${input}\n`);
  });
};

const collectFiles = async (root) => {
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
      } else {
        files.push(candidate);
      }
    }
  };
  await visit(root);
  return files;
};

const writeFakeCompanion = async (
  path,
  { appVersion = packageJson.version, snapshot = expectedSnapshot } = {},
) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `#!/usr/bin/env node
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "hello") {
    process.stdout.write(JSON.stringify({
      protocol: { major: 1, minor: 0 },
      type: "hello",
      requestId: command.requestId,
      monotonicNs: "1",
      payload: {
        protocolMajor: 1,
        protocolMinor: 0,
        appVersion: ${JSON.stringify(appVersion)},
        coreSnapshot: ${JSON.stringify(snapshot)}
      }
    }) + "\\n");
  } else if (command.type === "shutdown") {
    process.stdout.write(JSON.stringify({
      protocol: { major: 1, minor: 0 },
      type: "command_result",
      requestId: command.requestId,
      monotonicNs: "2",
      payload: { commandType: "shutdown", success: true }
    }) + "\\n");
    process.exit(0);
  }
});
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
};

const runNodeTool = (arguments_, options = {}) =>
  spawnSync(process.execPath, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    ...options,
  });

test(
  "packaged application keeps the executable companion outside asar and the renderer inside",
  packageTestOptions,
  async () => {
    const layout = packagedLayout();
    const archive = join(layout.resources, "app.asar");
    const archiveFiles = listPackage(archive);
    const metadata = await lstat(layout.companion);

    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.isFile(), true);
    if (process.platform !== "win32") {
      await access(layout.companion, constants.X_OK);
    }
    assert.equal(
      archiveFiles.some((path) =>
        path.startsWith("/.vite/renderer/main_window/"),
      ),
      true,
    );
    assert.equal(
      archiveFiles.some((path) => path.includes("netft-viewer-companion")),
      false,
    );

    const frames = await runCompanionHandshake(layout.companion);
    assert.equal(frames[0]?.type, "hello");
    assert.equal(frames[0]?.requestId, "package-layout");
    assert.equal(frames[0]?.payload?.protocolMajor, 1);
    assert.equal(frames[0]?.payload?.protocolMinor, 0);
    assert.equal(frames[0]?.payload?.appVersion, packageJson.version);
    assert.equal(frames[0]?.payload?.coreSnapshot, expectedSnapshot);
  },
);

test(
  "copy-companion stages only a matching executable and preserves executable mode",
  { skip: process.platform === "win32" },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), "netft-viewer-copy-"));
    context.after(() => rm(temporary, { force: true, recursive: true }));
    const buildDirectory = join(temporary, "cmake");
    const stagingRoot = join(temporary, "stage");
    const executable = join(
      buildDirectory,
      "core",
      "companion",
      "netft-viewer-companion",
    );
    await writeFakeCompanion(executable);

    const result = runNodeTool([
      "tools/copy-companion.mjs",
      buildDirectory,
      process.platform,
      process.arch,
      "--staging-root",
      stagingRoot,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const staged = join(
      stagingRoot,
      `${process.platform}-${process.arch}`,
      "companion",
      "netft-viewer-companion",
    );
    const metadata = await lstat(staged);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    await access(staged, constants.X_OK);
    const frames = await runCompanionHandshake(staged);
    assert.equal(frames[0]?.payload?.appVersion, packageJson.version);
    assert.equal(frames[0]?.payload?.coreSnapshot, expectedSnapshot);
  },
);

test(
  "copy-companion rejects symlinked and identity-mismatched native inputs",
  { skip: process.platform === "win32" },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), "netft-viewer-reject-"));
    context.after(() => rm(temporary, { force: true, recursive: true }));
    const stagingRoot = join(temporary, "stage");

    const wrongBuild = join(temporary, "wrong");
    await writeFakeCompanion(
      join(wrongBuild, "core", "companion", "netft-viewer-companion"),
      { appVersion: "99.0.0" },
    );
    const wrong = runNodeTool([
      "tools/copy-companion.mjs",
      wrongBuild,
      process.platform,
      process.arch,
      "--staging-root",
      stagingRoot,
    ]);
    assert.notEqual(wrong.status, 0);

    const symlinkBuild = join(temporary, "symlink");
    const outside = join(temporary, "outside-companion");
    await writeFakeCompanion(outside);
    const symlinked = join(
      symlinkBuild,
      "core",
      "companion",
      "netft-viewer-companion",
    );
    await mkdir(dirname(symlinked), { recursive: true });
    await symlink(outside, symlinked);
    const linked = runNodeTool([
      "tools/copy-companion.mjs",
      symlinkBuild,
      process.platform,
      process.arch,
      "--staging-root",
      stagingRoot,
    ]);
    assert.notEqual(linked.status, 0);
  },
);

test(
  "packaging tool CLIs execute through paths that require URL normalization",
  { skip: process.platform === "win32" },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), "netft viewer cli-"));
    context.after(() => rm(temporary, { force: true, recursive: true }));
    const linkedTool = join(temporary, "copy companion.mjs");
    await symlink(resolve("tools/copy-companion.mjs"), linkedTool);

    const result = runNodeTool([linkedTool]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage:/);
  },
);

test(
  "make-portable archives an existing Linux package reproducibly and smokes the extracted companion",
  { skip: process.platform !== "linux" },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), "netft-viewer-portable-"));
    context.after(() => rm(temporary, { force: true, recursive: true }));
    const application = join(temporary, "Net F-T Viewer-linux-x64");
    const companion = join(
      application,
      "resources",
      "companion",
      "netft-viewer-companion",
    );
    await writeFakeCompanion(companion);
    await writeFile(join(application, "Net F-T Viewer"), "launcher\n", {
      mode: 0o755,
    });
    await writeFile(join(application, "resources", "app.asar"), "archive\n");
    const first = join(temporary, "first.tar.gz");
    const second = join(temporary, "second.tar.gz");

    for (const output of [first, second]) {
      const result = runNodeTool([
        "tools/make-portable.mjs",
        application,
        output,
      ]);
      assert.equal(result.status, 0, result.stderr);
    }
    const firstHash = createHash("sha256")
      .update(await readFile(first))
      .digest("hex");
    const secondHash = createHash("sha256")
      .update(await readFile(second))
      .digest("hex");
    assert.equal(firstHash, secondHash);

    const listing = spawnSync("tar", ["-tzf", first], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(listing.status, 0, listing.stderr);
    const entries = listing.stdout.trim().split("\n");
    assert.equal(
      entries.every((entry) =>
        entry.startsWith(`netft-viewer-${packageJson.version}-linux-x64/`),
      ),
      true,
    );
    assert.equal(
      entries.some((entry) =>
        entry.endsWith("/resources/companion/netft-viewer-companion"),
      ),
      true,
    );

    const unsafeApplication = join(temporary, "unsafe,source-linux-x64");
    await rename(application, unsafeApplication);
    const unsafe = runNodeTool([
      "tools/make-portable.mjs",
      unsafeApplication,
      join(temporary, "unsafe.tar.gz"),
    ]);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /source name/);
  },
);

test("native dependency reports reject unresolved and build-tree libraries", async () => {
  const { validateDependencyReport } =
    await import("../../tools/check-native-artifact.mjs");
  const buildDirectory = resolve("build/package");

  assert.doesNotThrow(() =>
    validateDependencyReport({
      platform: "linux",
      output:
        "libpthread.so.0 => /lib/x86_64-linux-gnu/libpthread.so.0 (0x1)\nlinux-vdso.so.1 (0x2)",
      buildDirectory,
    }),
  );
  assert.throws(() =>
    validateDependencyReport({
      platform: "linux",
      output: "libcurl.so => not found",
      buildDirectory,
    }),
  );
  assert.throws(() =>
    validateDependencyReport({
      platform: "linux",
      output: `libssl.so => ${resolve(".pixi/envs/default/lib/libssl.so")}`,
      buildDirectory,
    }),
  );
  assert.throws(() =>
    validateDependencyReport({
      platform: "darwin",
      output: `${join(buildDirectory, "libnetft.dylib")}\n/usr/lib/libc++.1.dylib`,
      buildDirectory,
    }),
  );
  assert.throws(() =>
    validateDependencyReport({
      platform: "win32",
      output: `Image has the following dependencies:\n${join(buildDirectory, "netft.dll")}`,
      buildDirectory,
    }),
  );
});

test(
  "production package excludes test hooks, project sources, source maps, and a configured sensitive host",
  packageTestOptions,
  async () => {
    const layout = packagedLayout();
    const archive = join(layout.resources, "app.asar");
    const archiveFiles = listPackage(archive);
    const forbiddenArchiveSegments = [
      "/app/",
      "/core/",
      "/test/",
      "/tools/",
      "/.superpowers/",
    ];

    assert.equal(
      archiveFiles.some(
        (path) =>
          forbiddenArchiveSegments.some((segment) =>
            path.startsWith(segment),
          ) || /\.(?:map|ts|tsx|cpp|cc|cxx|h|hpp)$/.test(path),
      ),
      false,
    );
    assert.equal(
      archiveFiles.some((path) => path.includes("fake-companion")),
      false,
    );

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
      assert.equal(mainBundle.includes(forbidden), false);
    }

    const sensitiveHost = process.env.NETFT_VIEWER_FORBIDDEN_SENSOR_HOST;
    if (sensitiveHost !== undefined && sensitiveHost.length > 0) {
      for (const path of archiveFiles.filter((path) =>
        /\.(?:html|js|json|css)$/.test(path),
      )) {
        assert.equal(
          extractFile(archive, path.replace(/^\/+/, "")).includes(
            sensitiveHost,
          ),
          false,
          `${path} contains the configured sensitive host`,
        );
      }
      for (const path of await collectFiles(layout.resources)) {
        const relativePath = relative(layout.resources, path);
        if (
          relativePath === "app.asar" ||
          relativePath.split(sep).includes("companion")
        ) {
          continue;
        }
        const metadata = await lstat(path);
        if (metadata.size <= 4 * 1024 * 1024) {
          assert.equal(
            (await readFile(path)).includes(sensitiveHost),
            false,
            `${relativePath} contains the configured sensitive host`,
          );
        }
      }
    }

    assert.equal(await realpath(layout.companion), resolve(layout.companion));
  },
);
