import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const loadSanitizer = async () =>
  import("../../tools/lib/mac-signature-sanitizer.mjs").catch(() => ({}));

test("macOS package preparation removes only nested code signature directories", async (context) => {
  const temporary = await mkdtemp(
    join(tmpdir(), "netft-viewer-mac-signatures-"),
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const signature = join(
    temporary,
    "Electron.app",
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "_CodeSignature",
  );
  const unrelated = join(
    temporary,
    "Electron.app",
    "Contents",
    "Resources",
    "CodeResources",
  );
  await mkdir(signature, { recursive: true });
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(signature, "CodeResources"), "stale signature");
  await writeFile(join(unrelated, "keep.txt"), "application resource");

  const { removeMacCodeSignatures } = await loadSanitizer();
  assert.equal(typeof removeMacCodeSignatures, "function");
  await removeMacCodeSignatures(temporary, "darwin");

  await assert.rejects(readFile(join(signature, "CodeResources")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(join(unrelated, "keep.txt"), "utf8"),
    "application resource",
  );
});

test("package preparation leaves non-macOS inputs unchanged", async (context) => {
  const temporary = await mkdtemp(
    join(tmpdir(), "netft-viewer-non-mac-signatures-"),
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const signature = join(temporary, "bundle", "_CodeSignature");
  await mkdir(signature, { recursive: true });
  await writeFile(join(signature, "CodeResources"), "keep on other platforms");

  const { removeMacCodeSignatures } = await loadSanitizer();
  assert.equal(typeof removeMacCodeSignatures, "function");
  await removeMacCodeSignatures(temporary, "linux");

  assert.equal(
    await readFile(join(signature, "CodeResources"), "utf8"),
    "keep on other platforms",
  );
});
