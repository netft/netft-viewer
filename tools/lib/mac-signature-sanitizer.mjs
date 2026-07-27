import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const removeMacCodeSignatures = async (root, platform) => {
  if (platform !== "darwin") {
    return;
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.name === "_CodeSignature") {
      await rm(path, { force: true, recursive: true });
      continue;
    }
    await removeMacCodeSignatures(path, platform);
  }
};
