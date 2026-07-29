import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("native and Electron builds use the recorded core snapshot", () => {
  const snapshotDocument = readFileSync("CORE_SNAPSHOT.md", "utf8");
  const snapshot = snapshotDocument.match(/\b[0-9a-f]{40}\b/)?.[0];
  assert.ok(snapshot);

  const cmake = readFileSync("CMakeLists.txt", "utf8");
  const main = readFileSync("app/main/main.ts", "utf8");
  assert.match(cmake, new RegExp(`"${snapshot}"`));
  assert.match(main, new RegExp(`expectedCoreSnapshot: "${snapshot}"`));
});
