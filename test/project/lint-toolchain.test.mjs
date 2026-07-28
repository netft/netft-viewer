import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("lint uses its isolated TypeScript 6 parser API", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/eslint/check-toolchain.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.lintTypeScript, "6.0.3");
  assert.equal(report.productTypeScript, "7.0.2");
  assert.match(report.lintTypeScriptPath, /tools[/\\]eslint/);
  assert.doesNotMatch(report.productTypeScriptPath, /tools[/\\]eslint/);
});
