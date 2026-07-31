import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { releaseNotes } from "../../tools/release-notes.mjs";

const fakeGh = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const valueAfter = (name) => args[args.indexOf(name) + 1];
let state = load();

const respond = (status, body, exitStatus = status >= 400 ? 1 : 0) => {
  const reason = status === 200 ? "OK" : status === 404 ? "Not Found" : "Error";
  process.stdout.write(
    \`HTTP/2.0 \${status} \${reason}\\r\\nContent-Type: application/json\\r\\n\\r\\n\${JSON.stringify(body)}\\n\`,
  );
  process.exit(exitStatus);
};
const failApi = (scope) => {
  if (state.apiFailure?.scope !== scope) return false;
  if (state.apiFailure.status === null) {
    process.stderr.write("transport failure\\n");
    process.exit(state.apiFailure.exitStatus);
  }
  respond(
    state.apiFailure.status,
    { message: "api failure" },
    state.apiFailure.exitStatus,
  );
};
const releaseBody = () => ({
  assets: Object.keys(state.assets).sort().map((name) => ({ name })),
  body: state.body,
  draft: state.draft,
  name: state.title,
  tag_name: state.tag,
});

if (args[0] === "api") {
  const endpoint = args.at(-1);
  if (endpoint === "repos/netft/netft-viewer") {
    failApi("repository");
    respond(200, { full_name: "netft/netft-viewer" });
  }
  if (endpoint === "repos/netft/netft-viewer/releases/tags/v0.1.0") {
    failApi("release");
    if (!state.exists) respond(404, { message: "Not Found" });
    respond(200, releaseBody());
  }
  process.exit(92);
}
if (args[0] !== "release") process.exit(90);
if (args[1] === "create") {
  if (state.exists || !args.includes("--draft")) process.exit(2);
  state.exists = true;
  state.draft = true;
  state.tag = args[2];
  state.title = valueAfter("--title");
  state.body = fs.readFileSync(valueAfter("--notes-file"), "utf8");
  state.mutations.create += 1;
  save(state);
} else if (args[1] === "download") {
  if (!state.exists) process.exit(3);
  const name = valueAfter("--pattern");
  const directory = valueAfter("--dir");
  if (!(name in state.assets)) process.exit(4);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), Buffer.from(state.assets[name], "base64"));
} else if (args[1] === "upload") {
  if (!state.exists || !state.draft) process.exit(5);
  const file = args[3];
  const name = path.basename(file);
  if (name in state.assets) process.exit(6);
  state.assets[name] = fs.readFileSync(file).toString("base64");
  state.mutations.upload += 1;
  save(state);
} else if (args[1] === "edit") {
  if (!state.exists || !state.draft || !args.includes("--draft=false")) process.exit(7);
  if (!state.postPublishStuck) state.draft = false;
  state.mutations.publish += 1;
  save(state);
} else {
  process.exit(91);
}
`;

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "netft-viewer-release-"));
  const bin = join(directory, "bin");
  const assets = join(directory, "assets");
  await mkdir(bin);
  await mkdir(assets);
  const gh = join(bin, "gh");
  const state = join(directory, "state.json");
  const notes = join(directory, "notes.md");
  await writeFile(gh, fakeGh);
  await chmod(gh, 0o755);
  await writeFile(
    state,
    JSON.stringify({
      assets: {},
      apiFailure: null,
      body: "",
      draft: false,
      exists: false,
      mutations: { create: 0, publish: 0, upload: 0 },
      postPublishStuck: false,
      tag: "",
      title: "",
    }),
  );
  await writeFile(notes, "fixture");
  await writeFile(join(assets, "netft-viewer-linux-x64.tar.gz"), "artifact");
  await writeFile(join(assets, "SHA256SUMS"), "checksum");
  await writeFile(join(assets, "netft-viewer-0.1.0.spdx.json"), "{}");
  return { assets, bin, directory, notes, state };
};

const runPublisher = (fixture, mode, extraEnv = {}) =>
  spawnSync(
    "bash",
    [
      ".github/scripts/publish_release.sh",
      mode,
      "v0.1.0",
      fixture.assets,
      fixture.notes,
    ],
    {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_STATE: fixture.state,
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "netft/netft-viewer",
        PATH: `${fixture.bin}:${process.env.PATH}`,
        ...extraEnv,
      },
    },
  );

test("release notes exclude changelog link definitions", () => {
  const changelog = `# Changelog

## [0.1.0] - 2026-07-31

### Added

- First release.

[Unreleased]: https://example.invalid/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/releases/tag/v0.1.0
`;

  assert.equal(
    releaseNotes(changelog, "0.1.0"),
    "### Added\n\n- First release.\n",
  );
});

test("draft staging uploads, downloads, and byte-verifies assets idempotently", async () => {
  const files = await fixture();
  const first = runPublisher(files, "stage");
  assert.equal(first.status, 0, first.stderr);
  const firstState = JSON.parse(await readFile(files.state, "utf8"));
  assert.equal(firstState.draft, true);
  assert.deepEqual(firstState.mutations, {
    create: 1,
    publish: 0,
    upload: 3,
  });

  const second = runPublisher(files, "stage");
  assert.equal(second.status, 0, second.stderr);
  const secondState = JSON.parse(await readFile(files.state, "utf8"));
  assert.deepEqual(secondState.mutations, firstState.mutations);

  await writeFile(join(files.assets, "SHA256SUMS"), "different");
  const conflict = runPublisher(files, "stage");
  assert.notEqual(conflict.status, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.state, "utf8")).mutations,
    firstState.mutations,
  );
});

test("published releases remain byte-identical and immutable", async () => {
  const files = await fixture();
  assert.equal(runPublisher(files, "stage").status, 0);
  const publish = runPublisher(files, "publish");
  assert.equal(publish.status, 0, publish.stderr);
  const published = JSON.parse(await readFile(files.state, "utf8"));
  assert.equal(published.draft, false);
  assert.deepEqual(published.mutations, {
    create: 1,
    publish: 1,
    upload: 3,
  });

  assert.equal(runPublisher(files, "publish").status, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.state, "utf8")).mutations,
    published.mutations,
  );

  await writeFile(join(files.assets, "unexpected.bin"), "new");
  const mutation = runPublisher(files, "stage");
  assert.notEqual(mutation.status, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.state, "utf8")).mutations,
    published.mutations,
  );
});

test("publisher rejects untrusted tags and missing credentials before gh access", async () => {
  const files = await fixture();
  const tag = spawnSync(
    "bash",
    [
      ".github/scripts/publish_release.sh",
      "stage",
      "v0.1.0/../../bad",
      files.assets,
      files.notes,
    ],
    {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_STATE: files.state,
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "netft/netft-viewer",
        PATH: `${files.bin}:${process.env.PATH}`,
      },
    },
  );
  assert.notEqual(tag.status, 0);

  const token = runPublisher(files, "stage", { GH_TOKEN: "" });
  assert.notEqual(token.status, 0);
  assert.equal(
    JSON.parse(await readFile(files.state, "utf8")).mutations.create,
    0,
  );
});

test("publisher creates only after an authenticated release lookup returns 404", async () => {
  for (const apiFailure of [
    { exitStatus: 7, scope: "repository", status: 401 },
    { exitStatus: 22, scope: "release", status: null },
    { exitStatus: 9, scope: "release", status: 500 },
  ]) {
    const files = await fixture();
    const state = JSON.parse(await readFile(files.state, "utf8"));
    state.apiFailure = apiFailure;
    await writeFile(files.state, JSON.stringify(state));

    const result = runPublisher(files, "stage");
    assert.equal(result.status, apiFailure.exitStatus);
    const after = JSON.parse(await readFile(files.state, "utf8"));
    assert.equal(after.mutations.create, 0);
    await rm(files.directory, { force: true, recursive: true });
  }
});

test("publisher rejects changed draft identity and confirms publication state", async () => {
  const files = await fixture();
  assert.equal(runPublisher(files, "stage").status, 0);
  const state = JSON.parse(await readFile(files.state, "utf8"));
  state.title = "changed";
  await writeFile(files.state, JSON.stringify(state));
  const changed = runPublisher(files, "stage");
  assert.notEqual(changed.status, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.state, "utf8")).mutations,
    state.mutations,
  );

  state.title = "Net F/T Viewer v0.1.0";
  state.postPublishStuck = true;
  await writeFile(files.state, JSON.stringify(state));
  const publish = runPublisher(files, "publish");
  assert.notEqual(publish.status, 0);
  assert.equal(JSON.parse(await readFile(files.state, "utf8")).draft, true);
  await rm(files.directory, { force: true, recursive: true });
});

test("publisher rejects excessive asset counts and byte sizes before gh access", async () => {
  const countFixture = await fixture();
  for (let index = 0; index < 62; index += 1) {
    await writeFile(join(countFixture.assets, `extra-${index}.bin`), "x");
  }
  assert.notEqual(runPublisher(countFixture, "stage").status, 0);
  assert.equal(
    JSON.parse(await readFile(countFixture.state, "utf8")).mutations.create,
    0,
  );
  await rm(countFixture.directory, { force: true, recursive: true });

  const fileFixture = await fixture();
  await truncate(
    join(fileFixture.assets, "netft-viewer-linux-x64.tar.gz"),
    2 * 1024 * 1024 * 1024 + 1,
  );
  assert.notEqual(runPublisher(fileFixture, "stage").status, 0);
  assert.equal(
    JSON.parse(await readFile(fileFixture.state, "utf8")).mutations.create,
    0,
  );
  await rm(fileFixture.directory, { force: true, recursive: true });

  const totalFixture = await fixture();
  for (let index = 0; index < 4; index += 1) {
    const asset = join(totalFixture.assets, `large-${index}.bin`);
    await writeFile(asset, "");
    await truncate(asset, 2 * 1024 * 1024 * 1024);
  }
  assert.notEqual(runPublisher(totalFixture, "stage").status, 0);
  assert.equal(
    JSON.parse(await readFile(totalFixture.state, "utf8")).mutations.create,
    0,
  );
  await rm(totalFixture.directory, { force: true, recursive: true });
});

test("hardware entry point fails before invoking build tools when host is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "netft-viewer-hardware-"));
  const marker = join(directory, "invoked");
  const cmake = join(directory, "cmake");
  await writeFile(
    cmake,
    `#!/usr/bin/env bash\nprintf invoked > "${marker}"\nexit 0\n`,
  );
  await chmod(cmake, 0o755);

  const result = spawnSync("bash", ["tools/hardware-test.sh"], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 64);
  await assert.rejects(readFile(marker));
});
