import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";

const defaultMetadata = resolve("core/netft/UPSTREAM");

export const readCoreSnapshot = async (path = defaultMetadata) => {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  const commits = lines
    .filter((line) => line.startsWith("commit="))
    .map((line) => line.slice("commit=".length));
  if (commits.length !== 1 || !/^[0-9a-f]{40}$/.test(commits[0])) {
    throw new Error("core snapshot identity is invalid");
  }
  if (path === defaultMetadata) await verifyCoreSnapshot(path);
  return commits[0];
};

// A commit string identifies the upstream revision; this additionally detects
// edited, missing or added selected files before packaging a companion.
export const verifyCoreSnapshot = async (metadataPath = defaultMetadata) => {
  const root = dirname(resolve(metadataPath));
  const metadata = Object.fromEntries(
    (await readFile(metadataPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("=")),
  );
  if (
    metadata.repository !== "https://github.com/netft/netft-cpp.git" ||
    !/^[0-9a-f]{40}$/.test(metadata.commit) ||
    !(metadata.tag === "unreleased" || /^v\d+\.\d+\.\d+$/.test(metadata.tag))
  ) {
    throw new Error("core snapshot identity is invalid");
  }
  const paths = ["UPSTREAM"];
  const visit = async (name) => {
    const path = resolve(root, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error("core snapshot contains a symbolic link");
    if (stat.isDirectory()) {
      for (const child of await readdir(path)) await visit(`${name}/${child}`);
    } else if (stat.isFile())
      paths.push(relative(root, path).replaceAll("\\", "/"));
    else throw new Error("core snapshot contains an unsupported file");
  };
  for (const name of metadata.paths?.split(",") ?? []) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.startsWith("/") ||
      name.split("/").includes("..")
    ) {
      throw new Error("core snapshot path is invalid");
    }
    await visit(name);
  }
  const records = await Promise.all(
    paths.sort().map(
      async (name) =>
        `${createHash("sha256")
          .update(await readFile(resolve(root, name)))
          .digest("hex")}  ${name}\n`,
    ),
  );
  if (
    (await readFile(resolve(root, "SNAPSHOT.sha256"), "utf8")) !==
    records.join("")
  ) {
    throw new Error("core snapshot checksum mismatch");
  }
};
