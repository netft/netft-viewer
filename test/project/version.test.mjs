import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package and CMake versions match", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const cmake = readFileSync("CMakeLists.txt", "utf8");
  const match = cmake.match(/project\(netft_viewer VERSION ([0-9]+\.[0-9]+\.[0-9]+)/);
  assert.equal(match?.[1], pkg.version);
});
