import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cmake = readFileSync("CMakeLists.txt", "utf8");
const version = cmake.match(
  /project\(netft_viewer VERSION ([0-9]+\.[0-9]+\.[0-9]+)/,
)?.[1];
const pixi = readFileSync("pixi.toml", "utf8");
const pixiVersion = pixi.match(/^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1];
const changelog = readFileSync("CHANGELOG.md", "utf8");
const changelogVersion = changelog.match(
  /^## \[([0-9]+\.[0-9]+\.[0-9]+)\] - \d{4}-\d{2}-\d{2}$/m,
)?.[1];
const releaseTag = process.env.RELEASE_TAG;

if (
  version !== pkg.version ||
  pixiVersion !== pkg.version ||
  changelogVersion !== pkg.version
) {
  throw new Error(
    `version mismatch: package=${pkg.version} cmake=${version ?? "missing"} pixi=${pixiVersion ?? "missing"} changelog=${changelogVersion ?? "missing"}`,
  );
}
if (releaseTag !== undefined && releaseTag !== `v${pkg.version}`) {
  throw new Error(
    `release tag mismatch: expected=v${pkg.version} actual=${releaseTag}`,
  );
}
