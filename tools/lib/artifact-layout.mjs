import { join, resolve } from "node:path";

import { assertPlatformArchitecture } from "./platform.mjs";

const DEBIAN_ARCHITECTURES = new Map([
  ["x64", "amd64"],
  ["arm64", "arm64"],
]);

export const packageDirectoryPath = ({
  outDirectory,
  platform,
  architecture,
}) => {
  assertPlatformArchitecture(platform, architecture);
  return resolve(outDirectory, `Net F-T Viewer-${platform}-${architecture}`);
};

export const expectedArtifacts = ({
  outDirectory,
  platform,
  architecture,
  version,
}) => {
  assertPlatformArchitecture(platform, architecture);
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("artifact version must be non-empty");
  }
  const output = resolve(outDirectory);
  if (platform === "linux") {
    const debianArchitecture = DEBIAN_ARCHITECTURES.get(architecture);
    return [
      {
        kind: "deb",
        path: join(
          output,
          "make",
          "deb",
          architecture,
          `netft-viewer_${version}_${debianArchitecture}.deb`,
        ),
      },
      {
        kind: "tar",
        path: join(
          output,
          "make",
          `netft-viewer-${version}-linux-${architecture}.tar.gz`,
        ),
      },
    ];
  }
  if (platform === "win32") {
    return [
      {
        kind: "setup",
        path: join(
          output,
          "make",
          "squirrel.windows",
          architecture,
          "NetFTViewerSetup.exe",
        ),
      },
      {
        kind: "nupkg",
        path: join(
          output,
          "make",
          "squirrel.windows",
          architecture,
          `netft_viewer-${version}-full.nupkg`,
        ),
      },
      {
        kind: "zip",
        path: join(
          output,
          "make",
          "zip",
          "win32",
          architecture,
          `Net F-T Viewer-win32-${architecture}-${version}.zip`,
        ),
      },
    ];
  }
  return [
    {
      kind: "dmg",
      path: join(output, "make", "Net F-T Viewer.dmg"),
    },
    {
      kind: "zip",
      path: join(
        output,
        "make",
        "zip",
        "darwin",
        architecture,
        `Net F-T Viewer-darwin-${architecture}-${version}.zip`,
      ),
    },
  ];
};
