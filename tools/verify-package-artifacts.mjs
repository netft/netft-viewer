import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { verifyPackageArtifacts } from "./lib/artifact-verifier.mjs";

const main = async () => {
  if (process.argv.length < 4 || process.argv.length > 5) {
    throw new Error(
      "usage: verify-package-artifacts.mjs <platform> <arch> [out-dir]",
    );
  }
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  await verifyPackageArtifacts({
    platform: process.argv[2],
    architecture: process.argv[3],
    outDirectory: process.argv[4] ?? "out",
    version: packageJson.version,
    sensitiveValue: process.env.NETFT_VIEWER_FORBIDDEN_SENSOR_HOST,
  });
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
