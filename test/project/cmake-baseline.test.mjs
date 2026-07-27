import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("dependency configuration supports CMake 3.21.3", () => {
  const buildDir = mkdtempSync(join(tmpdir(), "netft-viewer-cmake-"));

  try {
    const pixi = spawnSync("pixi", ["--version"], { encoding: "utf8" });
    const command = pixi.status === 0 ? "pixi" : "cmake";
    const cmakeArguments =
      pixi.status === 0
        ? [
            "exec",
            "--spec",
            "cmake=3.21.3",
            "--spec",
            "ninja",
            "cmake",
            "-G",
            "Ninja",
            "-S",
            resolve("test/project/fixtures/cmake-baseline"),
            "-B",
            buildDir,
            `-DNETFT_VIEWER_SOURCE_DIR=${resolve(".")}`,
          ]
        : [
            "-G",
            "Ninja",
            "-S",
            resolve("test/project/fixtures/cmake-baseline"),
            "-B",
            buildDir,
            `-DNETFT_VIEWER_SOURCE_DIR=${resolve(".")}`,
          ];
    const result = spawnSync(command, cmakeArguments, {
      encoding: "utf8",
      timeout: 120_000,
    });

    assert.equal(
      result.status,
      0,
      [result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  } finally {
    rmSync(buildDir, { force: true, recursive: true });
  }
});

test("the shipped JSON dependency uses an immutable full commit identity", () => {
  const dependencies = readFileSync(
    resolve("cmake/Dependencies.cmake"),
    "utf8",
  );
  const declaration = dependencies.match(
    /FetchContent_Declare\(nlohmann_json[^)]*?GIT_REPOSITORY\s+\S+[^)]*?GIT_TAG\s+(\S+)[^)]*?\)/s,
  );

  assert.ok(declaration);
  assert.match(declaration[1], /^[0-9a-f]{40}$/);
});
