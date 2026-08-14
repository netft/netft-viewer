import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultMetadata = resolve("core/netft/UPSTREAM");

export const readCoreSnapshot = async (path = defaultMetadata) => {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  const commits = lines
    .filter((line) => line.startsWith("commit="))
    .map((line) => line.slice("commit=".length));
  if (commits.length !== 1 || !/^[0-9a-f]{40}$/.test(commits[0])) {
    throw new Error("core snapshot identity is invalid");
  }
  return commits[0];
};
