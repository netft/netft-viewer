import process from "node:process";

import { verifyPackageLayout } from "./lib/package-layout.mjs";

const main = async () => {
  if (process.argv.length !== 5) {
    throw new Error(
      "usage: verify-package-layout.mjs <package-dir> <platform> <arch>",
    );
  }
  await verifyPackageLayout({
    packageDirectory: process.argv[2],
    platform: process.argv[3],
    architecture: process.argv[4],
    sensitiveValue: process.env.NETFT_VIEWER_FORBIDDEN_SENSOR_HOST,
  });
};

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
