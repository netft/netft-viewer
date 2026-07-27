import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expectedArtifacts, packageDirectoryPath } from "./artifact-layout.mjs";

export const assertFreshPackageArguments = (arguments_) => {
  for (const argument of arguments_) {
    const option = argument.split("=", 1)[0].replaceAll("-", "").toLowerCase();
    if (option === "skippackage") {
      throw new Error(
        "packaging must build a fresh package; --skip-package is unsupported",
      );
    }
  }
};

export const cleanTargetOutputs = async ({
  outDirectory,
  platform,
  architecture,
  version,
}) => {
  const targets = new Set([
    packageDirectoryPath({ outDirectory, platform, architecture }),
    ...expectedArtifacts({
      outDirectory,
      platform,
      architecture,
      version,
    }).map(({ path }) => path),
  ]);
  const output = resolve(outDirectory);
  if (platform === "linux") {
    targets.add(join(output, "make", "deb", architecture));
  } else if (platform === "win32") {
    targets.add(join(output, "make", "squirrel.windows", architecture));
    targets.add(join(output, "make", "zip", "win32", architecture));
  } else {
    targets.add(join(output, "make", "zip", "darwin", architecture));
  }
  await Promise.all(
    [...targets].map((target) => rm(target, { force: true, recursive: true })),
  );
};

export const macSignatureCommands = (application) => {
  const companion = join(
    application,
    "Contents",
    "Resources",
    "companion",
    "netft-viewer-companion",
  );
  return [
    {
      command: "codesign",
      arguments: ["--verify", "--strict", "--verbose=2", companion],
    },
    {
      command: "codesign",
      arguments: ["--verify", "--deep", "--strict", "--verbose=2", application],
    },
  ];
};

export const runPackagingLifecycle = async ({
  clean,
  prepare,
  forge,
  verifyPackage,
  verifySignature,
  verifyArtifacts,
}) => {
  await clean();
  await prepare();
  await forge();
  await verifyPackage();
  await verifySignature();
  await verifyArtifacts();
};
