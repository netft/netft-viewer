import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("snapshot records the exact upstream commit", () => {
  const text = readFileSync("CORE_SNAPSHOT.md", "utf8");
  assert.match(text, /f2c24fe22372dc8b2383bc08320ab1c5fe06ac21/);
});
