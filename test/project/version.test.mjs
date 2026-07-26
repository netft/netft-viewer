import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package and CMake versions match", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const cmake = readFileSync("CMakeLists.txt", "utf8");
  const match = cmake.match(/project\(netft_viewer VERSION ([0-9]+\.[0-9]+\.[0-9]+)/);
  assert.equal(match?.[1], pkg.version);
});

test("CMake requires portable C++17", () => {
  const cmake = readFileSync("CMakeLists.txt", "utf8");
  assert.match(cmake, /set\(CMAKE_CXX_STANDARD 17\)/);
  assert.match(cmake, /set\(CMAKE_CXX_STANDARD_REQUIRED ON\)/);
  assert.match(cmake, /set\(CMAKE_CXX_EXTENSIONS OFF\)/);
});
