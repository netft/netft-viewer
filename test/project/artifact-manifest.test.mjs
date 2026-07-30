import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeArtifactManifest } from "../../tools/write-artifact-manifest.mjs";

test("artifact manifest derives native package paths from version and target", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "netft-artifact-manifest-"));
  context.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });
  const packageJson = join(temporary, "package.json");
  const output = join(temporary, "github-output");

  await writeFile(packageJson, JSON.stringify({ version: "9.8.7" }));
  const paths = await writeArtifactManifest({
    platform: "linux",
    architecture: "arm64",
    outDirectory: "out",
    packageJson,
    githubOutput: output,
  });

  assert.deepEqual(paths, [
    "out/make/deb/arm64/netft-viewer_9.8.7_arm64.deb",
    "out/make/netft-viewer-9.8.7-linux-arm64.tar.gz",
  ]);
  assert.match(
    await readFile(output, "utf8"),
    /artifact_paths<<NETFT_VIEWER_ARTIFACT_PATHS[\s\S]*9\.8\.7/,
  );

  await writeFile(packageJson, JSON.stringify({ version: "9.8.8" }));
  const changed = await writeArtifactManifest({
    platform: "win32",
    architecture: "x64",
    outDirectory: "out",
    packageJson,
    githubOutput: output,
  });
  assert.equal(
    changed.every(
      (path) => path.includes("9.8.8") || path.endsWith("Setup.exe"),
    ),
    true,
  );
});
