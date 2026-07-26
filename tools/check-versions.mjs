import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cmake = readFileSync("CMakeLists.txt", "utf8");
const version = cmake.match(/project\(netft_viewer VERSION ([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
if (version !== pkg.version) {
  throw new Error(`version mismatch: package=${pkg.version} cmake=${version ?? "missing"}`);
}
