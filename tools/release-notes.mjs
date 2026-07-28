import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const releaseNotes = (changelog, version) => {
  const escaped = version.replaceAll(".", String.raw`\.`);
  const heading = new RegExp(
    String.raw`^## \[${escaped}\] - \d{4}-\d{2}-\d{2}\s*$`,
    "m",
  );
  const match = heading.exec(changelog);
  if (match === null) {
    throw new Error(`CHANGELOG.md has no dated ${version} release`);
  }
  const bodyStart = match.index + match[0].length;
  const remainder = changelog.slice(bodyStart);
  const nextHeading = remainder.search(/^## /m);
  const body =
    nextHeading === -1
      ? remainder.trim()
      : remainder.slice(0, nextHeading).trim();
  if (body.length === 0) {
    throw new Error(`CHANGELOG.md has no notes for ${version}`);
  }
  return `${body}\n`;
};

const main = async () => {
  const [version, output] = process.argv.slice(2);
  if (
    version === undefined ||
    output === undefined ||
    process.argv.length !== 4
  ) {
    throw new Error("usage: release-notes.mjs <version> <output>");
  }
  const changelog = await readFile("CHANGELOG.md", "utf8");
  await writeFile(output, releaseNotes(changelog, version));
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
