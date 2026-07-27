import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const elf = (machine) => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
};

const pe = (machine) => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(0x2, 86);
  bytes.writeUInt16LE(0x10b, 88);
  return bytes;
};

test("platform and architecture validation accepts only supported native combinations", async () => {
  const { assertNativeTarget, assertPlatformArchitecture } =
    await import("../../tools/lib/platform.mjs");
  for (const [platform, architecture] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["darwin", "universal"],
  ]) {
    assert.doesNotThrow(() =>
      assertPlatformArchitecture(platform, architecture),
    );
  }
  for (const [platform, architecture] of [
    ["linux", "universal"],
    ["linux", "ia32"],
    ["win32", "universal"],
    ["win32", "arm64"],
    ["darwin", "ia32"],
    ["freebsd", "x64"],
  ]) {
    assert.throws(() => assertPlatformArchitecture(platform, architecture));
  }

  assert.doesNotThrow(() =>
    assertNativeTarget({
      hostPlatform: "linux",
      hostArchitecture: "arm64",
      targetPlatform: "linux",
      targetArchitecture: "arm64",
    }),
  );
  assert.doesNotThrow(() =>
    assertNativeTarget({
      hostPlatform: "darwin",
      hostArchitecture: "arm64",
      targetPlatform: "darwin",
      targetArchitecture: "universal",
    }),
  );
  assert.throws(() =>
    assertNativeTarget({
      hostPlatform: "linux",
      hostArchitecture: "x64",
      targetPlatform: "linux",
      targetArchitecture: "arm64",
    }),
  );
  assert.throws(() =>
    assertNativeTarget({
      hostPlatform: "darwin",
      hostArchitecture: "x64",
      targetPlatform: "darwin",
      targetArchitecture: "arm64",
    }),
  );
});

test("ELF and PE headers report actual architecture and reject malformed input", async () => {
  const { parseBinaryArchitecture } =
    await import("../../tools/lib/binary-inspection.mjs");

  assert.equal(parseBinaryArchitecture(elf(62), "linux"), "x64");
  assert.equal(parseBinaryArchitecture(elf(183), "linux"), "arm64");
  assert.equal(parseBinaryArchitecture(pe(0x8664), "win32"), "x64");
  assert.equal(parseBinaryArchitecture(pe(0xaa64), "win32"), "arm64");
  assert.equal(parseBinaryArchitecture(pe(0x14c), "win32"), "ia32");

  assert.throws(() => parseBinaryArchitecture(Buffer.alloc(8), "linux"));
  assert.throws(() => parseBinaryArchitecture(elf(3), "linux"));
  assert.throws(() => parseBinaryArchitecture(Buffer.from("not-pe"), "win32"));
  const truncatedPe = pe(0x8664).subarray(0, 66);
  assert.throws(() => parseBinaryArchitecture(truncatedPe, "win32"));
});

test("Windows setup verification accepts the I386 Squirrel bootstrapper, not a payload architecture", async (context) => {
  const { verifyWindowsSetupBootstrapper } =
    await import("../../tools/lib/artifact-verifier.mjs");
  const { verifyBinaryArchitecture } =
    await import("../../tools/lib/binary-inspection.mjs");
  const temporary = await mkdtemp(join(tmpdir(), "netft-setup-architecture-"));
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const setup = join(temporary, "setup.exe");
  await writeFile(setup, pe(0x14c));

  await verifyWindowsSetupBootstrapper(setup, "x64");
  await assert.rejects(
    verifyBinaryArchitecture(setup, "win32", "x64"),
    /architecture does not match target/,
  );
  await assert.rejects(
    verifyWindowsSetupBootstrapper(setup, "arm64"),
    /unsupported desktop target/,
  );

  const pe32PlusSetup = join(temporary, "pe32-plus-setup.exe");
  const dllSetup = join(temporary, "dll-setup.exe");
  const pe32Plus = pe(0x14c);
  const dll = pe(0x14c);
  pe32Plus.writeUInt16LE(0x20b, 88);
  dll.writeUInt16LE(0x2002, 86);
  await Promise.all([
    writeFile(pe32PlusSetup, pe32Plus),
    writeFile(dllSetup, dll),
  ]);
  await assert.rejects(
    verifyWindowsSetupBootstrapper(pe32PlusSetup, "x64"),
    /valid Squirrel PE32 bootstrapper/,
  );
  await assert.rejects(
    verifyWindowsSetupBootstrapper(dllSetup, "x64"),
    /valid Squirrel PE32 bootstrapper/,
  );
});

test("native dependency reports fail closed against platform allowlists", async () => {
  const { validateDependencyReport } =
    await import("../../tools/check-native-artifact.mjs");
  const context = {
    buildDirectory: "/checkout/build/package",
    sourceDirectory: "/checkout",
  };

  assert.doesNotThrow(() =>
    validateDependencyReport({
      ...context,
      platform: "linux",
      output: [
        "linux-vdso.so.1 (0x1)",
        "libpthread.so.0 => /lib/x86_64-linux-gnu/libpthread.so.0 (0x2)",
        "libstdc++.so.6 => /usr/lib/x86_64-linux-gnu/libstdc++.so.6 (0x3)",
        "libm.so.6 => /lib/x86_64-linux-gnu/libm.so.6 (0x4)",
        "libgcc_s.so.1 => /lib/x86_64-linux-gnu/libgcc_s.so.1 (0x5)",
        "libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x6)",
        "/lib64/ld-linux-x86-64.so.2 (0x7)",
      ].join("\n"),
    }),
  );
  for (const output of [
    "libcurl.so.4 => /usr/lib/libcurl.so.4 (0x1)",
    "libssl.so.3 => /usr/local/lib/libssl.so.3 (0x1)",
    "libc.so.6 => /checkout/toolchain/lib/libc.so.6 (0x1)",
    "libc.so.6 => not found",
    "this is not ldd output",
  ]) {
    assert.throws(() =>
      validateDependencyReport({ ...context, platform: "linux", output }),
    );
  }

  assert.doesNotThrow(() =>
    validateDependencyReport({
      ...context,
      platform: "win32",
      output: [
        "Image has the following dependencies:",
        "KERNEL32.dll",
        "WS2_32.dll",
        "api-ms-win-core-synch-l1-2-0.dll",
      ].join("\n"),
    }),
  );
  for (const dependency of [
    "libcurl.dll",
    "VCRUNTIME140.dll",
    "unknown-plugin.dll",
  ]) {
    assert.throws(() =>
      validateDependencyReport({
        ...context,
        platform: "win32",
        output: `Image has the following dependencies:\n${dependency}`,
      }),
    );
  }

  assert.doesNotThrow(() =>
    validateDependencyReport({
      ...context,
      platform: "darwin",
      output: [
        "/tmp/netft-viewer-companion:",
        "/usr/lib/libc++.1.dylib (compatibility version 1.0.0)",
        "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0)",
      ].join("\n"),
    }),
  );
  for (const dependency of [
    "/usr/local/lib/libcurl.dylib (compatibility version 1.0.0)",
    "/opt/homebrew/lib/libssl.dylib (compatibility version 1.0.0)",
    "@rpath/libnetft.dylib (compatibility version 1.0.0)",
    "/checkout/build/libnetft.dylib (compatibility version 1.0.0)",
  ]) {
    assert.throws(() =>
      validateDependencyReport({
        ...context,
        platform: "darwin",
        output: `/tmp/netft-viewer-companion:\n${dependency}`,
      }),
    );
  }
});

test("package scanning includes native companion bytes", async (context) => {
  const { scanTreeForForbiddenValue } =
    await import("../../tools/lib/package-layout.mjs");
  const temporary = await mkdtemp(join(tmpdir(), "netft-package-scan-"));
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const companion = join(
    temporary,
    "resources",
    "companion",
    "netft-viewer-companion",
  );
  await mkdir(join(temporary, "resources", "companion"), { recursive: true });
  const configuredValue = "configured-sensitive-value";
  await writeFile(
    companion,
    Buffer.concat([
      Buffer.alloc(4096, 0xa5),
      Buffer.from(configuredValue),
      Buffer.alloc(4096, 0x5a),
    ]),
  );

  await assert.rejects(
    scanTreeForForbiddenValue(temporary, configuredValue),
    /forbidden value/,
  );
});

test("artifact layouts cover every native maker output", async () => {
  const { expectedArtifacts } =
    await import("../../tools/lib/artifact-layout.mjs");
  assert.deepEqual(
    expectedArtifacts({
      outDirectory: "/out",
      platform: "linux",
      architecture: "x64",
      version: "0.1.0",
    }).map(({ kind }) => kind),
    ["deb", "tar"],
  );
  assert.deepEqual(
    expectedArtifacts({
      outDirectory: "/out",
      platform: "win32",
      architecture: "x64",
      version: "0.1.0",
    }).map(({ kind }) => kind),
    ["setup", "nupkg", "zip"],
  );
  assert.deepEqual(
    expectedArtifacts({
      outDirectory: "/out",
      platform: "darwin",
      architecture: "universal",
      version: "0.1.0",
    }).map(({ kind }) => kind),
    ["dmg", "zip"],
  );
});

test("production lifecycle rejects stale-package shortcuts and cleans only the selected target", async (context) => {
  const {
    assertFreshPackageArguments,
    cleanTargetOutputs,
    macSignatureCommands,
    runPackagingLifecycle,
  } = await import("../../tools/lib/packaging-lifecycle.mjs");
  for (const argument of [
    "--skip-package",
    "--skip-package=true",
    "--skipPackage",
    "--skipPackage=true",
  ]) {
    assert.throws(() => assertFreshPackageArguments([argument]));
  }
  assert.doesNotThrow(() => assertFreshPackageArguments(["--verbose"]));

  const temporary = await mkdtemp(join(tmpdir(), "netft-lifecycle-"));
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const selectedPackage = join(temporary, "Net F-T Viewer-linux-x64");
  const siblingPackage = join(temporary, "Net F-T Viewer-linux-arm64");
  const selectedMaker = join(temporary, "make", "deb", "x64");
  const siblingMaker = join(temporary, "make", "deb", "arm64");
  for (const directory of [
    selectedPackage,
    siblingPackage,
    selectedMaker,
    siblingMaker,
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "sentinel"), "present");
  }
  await cleanTargetOutputs({
    outDirectory: temporary,
    platform: "linux",
    architecture: "x64",
    version: "0.1.0",
  });
  await assert.rejects(access(selectedPackage));
  await assert.rejects(access(selectedMaker));
  await access(join(siblingPackage, "sentinel"));
  await access(join(siblingMaker, "sentinel"));

  const signatureCommands = macSignatureCommands(
    "/out/Net F-T Viewer-darwin-universal/Net F-T Viewer.app",
  );
  assert.deepEqual(
    signatureCommands.map(({ command }) => command),
    ["codesign", "codesign"],
  );
  assert.equal(
    signatureCommands.every(({ arguments: arguments_ }) =>
      arguments_.includes("--strict"),
    ),
    true,
  );
  assert.equal(
    signatureCommands.every(({ arguments: arguments_ }) =>
      arguments_.includes("--verbose=2"),
    ),
    true,
  );

  const phases = [];
  await runPackagingLifecycle({
    clean: async () => phases.push("clean"),
    prepare: async () => phases.push("prepare"),
    forge: async () => phases.push("forge"),
    verifyPackage: async () => phases.push("verify-package"),
    verifySignature: async () => phases.push("verify-signature"),
    verifyArtifacts: async () => phases.push("verify-artifacts"),
  });
  assert.deepEqual(phases, [
    "clean",
    "prepare",
    "forge",
    "verify-package",
    "verify-signature",
    "verify-artifacts",
  ]);
});
