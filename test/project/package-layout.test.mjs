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
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const packageDirectory = process.env.NETFT_VIEWER_PACKAGE_DIR;
const packageTestOptions = { skip: packageDirectory === undefined };
const packageArchitecture =
  process.env.NETFT_VIEWER_PACKAGE_ARCHITECTURE ?? process.arch;
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const expectedSnapshot = (await readFile("CORE_SNAPSHOT.md", "utf8")).match(
  /\b[0-9a-f]{40}\b/,
)?.[0];
assert.notEqual(expectedSnapshot, undefined);

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

const writeNativeFakeCompanion = async (
  path,
  { appVersion = packageJson.version, snapshot = expectedSnapshot } = {},
) => {
  await mkdir(dirname(path), { recursive: true });
  const source = `${path}.c`;
  await writeFile(
    source,
    `#include <stdio.h>
#include <string.h>
int main(void) {
  char line[4096];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    if (strstr(line, "\\"type\\":\\"hello\\"") != NULL) {
      fputs("{\\"protocol\\":{\\"major\\":1,\\"minor\\":0},\\"type\\":\\"hello\\",\\"requestId\\":\\"package-hello\\",\\"monotonicNs\\":\\"1\\",\\"payload\\":{\\"protocolMajor\\":1,\\"protocolMinor\\":0,\\"appVersion\\":\\"${appVersion}\\",\\"coreSnapshot\\":\\"${snapshot}\\"}}\\n", stdout);
      fflush(stdout);
    } else if (strstr(line, "\\"type\\":\\"shutdown\\"") != NULL) {
      fputs("{\\"protocol\\":{\\"major\\":1,\\"minor\\":0},\\"type\\":\\"command_result\\",\\"requestId\\":\\"package-shutdown\\",\\"monotonicNs\\":\\"2\\",\\"payload\\":{\\"commandType\\":\\"shutdown\\",\\"success\\":true}}\\n", stdout);
      fflush(stdout);
      return 0;
    }
  }
  return 1;
}
`,
  );
  const compiled = spawnSync("cc", ["-O2", source, "-o", path], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(compiled.status, 0, compiled.stderr);
};

const runNodeTool = (arguments_, options = {}) =>
  spawnSync(process.execPath, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    ...options,
  });

test("distributed legal resources are regular, complete, and byte-identical", async (context) => {
  const { distributedNoticeFiles, verifyDistributedNotices } =
    await import("../../tools/lib/package-layout.mjs");
  const temporary = await mkdtemp(join(tmpdir(), "netft-viewer-notices-"));
  context.after(() => rm(temporary, { force: true, recursive: true }));

  for (const relativePath of distributedNoticeFiles) {
    const target = join(temporary, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(relativePath));
  }
  await verifyDistributedNotices(temporary);

  await writeFile(join(temporary, distributedNoticeFiles[0]), "different\n");
  await assert.rejects(verifyDistributedNotices(temporary));
  await writeFile(
    join(temporary, distributedNoticeFiles[0]),
    await readFile(distributedNoticeFiles[0]),
  );
  await rm(join(temporary, distributedNoticeFiles.at(-1)));
  await assert.rejects(verifyDistributedNotices(temporary));
});

test(
  "packaged application keeps the executable companion outside asar and the renderer inside",
  packageTestOptions,
  async () => {
    const { verifyPackageLayout } =
      await import("../../tools/lib/package-layout.mjs");
    await verifyPackageLayout({
      packageDirectory,
      platform: process.platform,
      architecture: packageArchitecture,
    });
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
    await writeNativeFakeCompanion(executable);

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
    await writeNativeFakeCompanion(
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

    const architectureBuild = join(temporary, "architecture");
    await writeNativeFakeCompanion(
      join(architectureBuild, "core", "companion", "netft-viewer-companion"),
    );
    const wrongArchitecture = runNodeTool([
      "tools/copy-companion.mjs",
      architectureBuild,
      process.platform,
      process.arch === "x64" ? "arm64" : "x64",
      "--staging-root",
      stagingRoot,
    ]);
    assert.notEqual(wrongArchitecture.status, 0);
    assert.match(wrongArchitecture.stderr, /architecture/);

    const symlinkBuild = join(temporary, "symlink");
    const outside = join(temporary, "outside-companion");
    await writeNativeFakeCompanion(outside);
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

test(
  "make-portable rejects every output inside the packaged source without creating a temporary archive",
  { skip: process.platform !== "linux" },
  async (context) => {
    const temporary = await mkdtemp(
      join(tmpdir(), "netft-viewer-containment-"),
    );
    context.after(() => rm(temporary, { force: true, recursive: true }));
    const application = join(temporary, "Net F-T Viewer-linux-x64");
    await writeFakeCompanion(
      join(application, "resources", "companion", "netft-viewer-companion"),
    );
    await writeFile(join(application, "resources", "app.asar"), "archive\n");
    const misleadingChild = join(application, "..evil");
    const output = join(misleadingChild, "escape.tar.gz");

    const result = runNodeTool([
      "tools/make-portable.mjs",
      application,
      output,
    ]);

    assert.notEqual(result.status, 0);
    await assert.rejects(access(output, constants.F_OK));
    await assert.rejects(
      access(`${output}.${result.pid ?? process.pid}.tmp`, constants.F_OK),
    );
    const childEntries = await readdir(misleadingChild).catch((error) => {
      assert.equal(error.code, "ENOENT");
      return [];
    });
    assert.deepEqual(childEntries, []);
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
    const { verifyPackageLayout } =
      await import("../../tools/lib/package-layout.mjs");
    await verifyPackageLayout({
      packageDirectory,
      platform: process.platform,
      architecture: packageArchitecture,
      sensitiveValue: process.env.NETFT_VIEWER_FORBIDDEN_SENSOR_HOST,
    });
  },
);
