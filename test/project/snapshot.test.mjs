import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("snapshot records the exact upstream commit", () => {
  const text = readFileSync("CORE_SNAPSHOT.md", "utf8");
  assert.match(text, /e424c401587052f03de9b94f76f1e86b78902105/);
});
