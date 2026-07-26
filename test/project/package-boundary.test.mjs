import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { extractFile, listPackage } from "@electron/asar";

const verifyPackage =
  process.env.NETFT_VIEWER_VERIFY_PRODUCTION_PACKAGE === "true";

const packageDirectory = () => {
  if (process.platform === "linux") {
    return resolve(`out/Net F-T Viewer-linux-${process.arch}`);
  }
  if (process.platform === "darwin") {
    return resolve(
      `out/Net F-T Viewer-darwin-${process.arch}/Net F-T Viewer.app/Contents`,
    );
  }
  return resolve(`out/Net F-T Viewer-win32-${process.arch}`);
};

test(
  "production package excludes the E2E companion and executable hook",
  { skip: !verifyPackage },
  async () => {
    const packaged = packageDirectory();
    const resources =
      process.platform === "darwin"
        ? resolve(packaged, "Resources")
        : resolve(packaged, "resources");
    await assert.rejects(
      access(resolve(resources, "fake-companion.mjs"), constants.F_OK),
    );

    const archive = resolve(resources, "app.asar");
    const archivedFiles = listPackage(archive);
    assert.equal(
      archivedFiles.some((path) => path.includes("fake-companion")),
      false,
    );
    const packagedMain = extractFile(archive, ".vite/build/main.js").toString(
      "utf8",
    );
    const builtMain = await readFile(resolve(".vite/build/main.js"), "utf8");
    for (const forbidden of [
      "fake-companion.mjs",
      "NETFT_VIEWER_E2E_BUILD",
      "NETFT_VIEWER_E2E_CONTROL_FILE",
      "NETFT_VIEWER_E2E_CONTROL_TOKEN",
      "NETFT_VIEWER_E2E_FAILURE_SENTINEL",
    ]) {
      assert.equal(packagedMain.includes(forbidden), false);
      assert.equal(builtMain.includes(forbidden), false);
    }
  },
);
