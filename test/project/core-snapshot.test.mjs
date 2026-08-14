import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCoreSnapshot } from "../../tools/lib/core-snapshot.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

const withMetadata = async (contents, action) => {
  const directory = await mkdtemp(join(tmpdir(), "netft-core-metadata-"));
  const path = join(directory, "UPSTREAM");
  try {
    await writeFile(path, contents, "utf8");
    return await action(path);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

test("reads the unique validated commit from upstream metadata", async () => {
  const actual = await withMetadata(
    `repository=https://example.invalid/core\ntag=v1.2.3\ncommit=${commit}\npaths=include,src\n`,
    readCoreSnapshot,
  );
  assert.equal(actual, commit);
});

test("rejects missing, duplicate, and malformed snapshot identities", async () => {
  const invalid = [
    "repository=https://example.invalid/core\n",
    `commit=${commit}\ncommit=${commit}\n`,
    "commit=ABCDEF0123456789abcdef0123456789abcdef01\n",
  ];
  for (const contents of invalid) {
    await assert.rejects(
      withMetadata(contents, readCoreSnapshot),
      /core snapshot identity is invalid/,
    );
  }
});
