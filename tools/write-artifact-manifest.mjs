import { realpathSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { relative } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { expectedArtifacts } from "./lib/artifact-layout.mjs";

const OUTPUT_DELIMITER = "NETFT_VIEWER_ARTIFACT_PATHS";

const portableRelativePath = (path) =>
  relative(process.cwd(), path).replaceAll("\\", "/");

export const writeArtifactManifest = async ({
  platform,
  architecture,
  outDirectory = "out",
  packageJson = "package.json",
  githubOutput = process.env.GITHUB_OUTPUT,
}) => {
  if (typeof githubOutput !== "string" || githubOutput.length === 0) {
    throw new Error("GITHUB_OUTPUT must identify the workflow output file");
  }

  const metadata = JSON.parse(await readFile(packageJson, "utf8"));
  const paths = expectedArtifacts({
    outDirectory,
    platform,
    architecture,
    version: metadata.version,
  }).map(({ path }) => portableRelativePath(path));

  if (paths.some((path) => path === OUTPUT_DELIMITER)) {
    throw new Error(
      "artifact path conflicts with the workflow output delimiter",
    );
  }

  await appendFile(
    githubOutput,
    `artifact_paths<<${OUTPUT_DELIMITER}\n${paths.join("\n")}\n${OUTPUT_DELIMITER}\n`,
  );
  return paths;
};

const main = async () => {
  if (process.argv.length < 4 || process.argv.length > 5) {
    throw new Error(
      "usage: write-artifact-manifest.mjs <platform> <arch> [out-dir]",
    );
  }
  await writeArtifactManifest({
    platform: process.argv[2],
    architecture: process.argv[3],
    outDirectory: process.argv[4] ?? "out",
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
