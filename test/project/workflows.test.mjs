import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const workflowPath = (name) =>
  new URL(`../../.github/workflows/${name}`, import.meta.url);

const loadWorkflow = async (name) =>
  parse(await readFile(workflowPath(name), "utf8"), { uniqueKeys: true });

const actionSteps = (workflow) =>
  Object.values(workflow.jobs).flatMap((job) =>
    Array.isArray(job.steps) ? job.steps.filter((step) => "uses" in step) : [],
  );

const matrixTargets = (job) =>
  new Set(
    job.strategy.matrix.include.map(
      ({ platform, architecture, runner }) =>
        `${platform}/${architecture}/${runner}`,
    ),
  );

const expectedNativeTargets = new Set([
  "linux/x64/ubuntu-24.04",
  "linux/arm64/ubuntu-24.04-arm",
  "win32/x64/windows-2025",
  "darwin/x64/macos-15-intel",
  "darwin/arm64/macos-15",
]);

test("CI assigns every native platform and architecture to a matching hosted runner", async () => {
  const workflow = await loadWorkflow("ci.yml");
  const nativeJob = workflow.jobs.native;

  assert.deepEqual(matrixTargets(nativeJob), expectedNativeTargets);
  assert.equal(nativeJob["runs-on"], "${{ matrix.runner }}");
  assert.equal(nativeJob.strategy["fail-fast"], false);
  assert.ok(nativeJob["timeout-minutes"] > 0);
});

test("CI separates static checks, native tests, and packaged Linux E2E", async () => {
  const workflow = await loadWorkflow("ci.yml");

  assert.equal(workflow.jobs.quality["runs-on"], "ubuntu-24.04");
  assert.equal(workflow.jobs.e2e["runs-on"], "ubuntu-24.04");
  assert.equal(workflow.jobs.e2e.env.NETFT_VIEWER_E2E_BUILD, "true");

  const qualitySteps = new Set(
    workflow.jobs.quality.steps.map(({ id }) => id).filter(Boolean),
  );
  const nativeSteps = new Set(
    workflow.jobs.native.steps.map(({ id }) => id).filter(Boolean),
  );
  const e2eSteps = new Set(
    workflow.jobs.e2e.steps.map(({ id }) => id).filter(Boolean),
  );

  assert.deepEqual(
    qualitySteps,
    new Set([
      "checkout",
      "node",
      "pnpm",
      "clang-format",
      "install",
      "format",
      "lint",
      "typecheck",
      "project",
      "unit",
    ]),
  );
  assert.ok(nativeSteps.has("native-test"));
  assert.ok(nativeSteps.has("companion-test"));
  assert.ok(e2eSteps.has("packaged-e2e"));
  assert.ok(e2eSteps.has("e2e-failure-artifacts"));
});

test("CI stops the PowerShell native build at the first failed command", async () => {
  const workflow = await loadWorkflow("ci.yml");
  const nativeTest = workflow.jobs.native.steps.find(
    ({ id }) => id === "native-test",
  );

  assert.match(nativeTest.run, /\$ErrorActionPreference\s*=\s*"Stop"/);
  assert.match(
    nativeTest.run,
    /\$PSNativeCommandUseErrorActionPreference\s*=\s*\$true/,
  );
});

test("CI installs the repository clang-format version before checking native sources", async () => {
  const workflow = await loadWorkflow("ci.yml");
  const versions = JSON.parse(
    await readFile(
      new URL("../../tools/tool-versions.json", import.meta.url),
      "utf8",
    ),
  );
  const pixi = await readFile(
    new URL("../../pixi.toml", import.meta.url),
    "utf8",
  );
  const qualityStepIds = workflow.jobs.quality.steps.map(({ id }) => id);
  const steps = new Map(
    workflow.jobs.quality.steps.map((step) => [step.id, step]),
  );

  assert.equal(versions.clangFormat, "22.1.8");
  assert.match(pixi, /clang-format = "==22\.1\.8"/);
  assert.ok(
    qualityStepIds.indexOf("clang-format") < qualityStepIds.indexOf("format"),
  );
  assert.match(steps.get("clang-format").run, /tools\/tool-versions\.json/);
  assert.match(
    steps.get("clang-format").run,
    /python -m pip install[\s\S]*clang-format==\$CLANG_FORMAT_VERSION/,
  );
  assert.match(steps.get("clang-format").run, /clang-format --version/);
  assert.match(steps.get("format").run, /clang-format --dry-run --Werror/);
});

test("CI runs the native suite with address and undefined behavior sanitizers", async () => {
  const workflow = await loadWorkflow("ci.yml");
  const sanitizer = workflow.jobs.sanitizers;

  assert.equal(sanitizer["runs-on"], "ubuntu-24.04");
  assert.ok(sanitizer["timeout-minutes"] > 0);
  const steps = new Map(sanitizer.steps.map((step) => [step.id, step]));
  assert.match(steps.get("sanitizer-test").run, /NETFT_VIEWER_SANITIZERS=ON/);
  assert.match(steps.get("sanitizer-test").run, /\bctest\b/);
  assert.equal(steps.get("sanitizer-test").env.CC, "clang");
  assert.equal(steps.get("sanitizer-test").env.CXX, "clang++");
  assert.match(steps.get("sanitizer-test").env.ASAN_OPTIONS, /detect_leaks=1/);
  assert.match(
    steps.get("sanitizer-test").env.UBSAN_OPTIONS,
    /halt_on_error=1/,
  );
});

test("CI uses least privilege, bounded concurrency, Node 24, and immutable dependency installs", async () => {
  const workflow = await loadWorkflow("ci.yml");

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.ok(workflow.concurrency.group);
  assert.equal(workflow.on.pull_request_target, undefined);

  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job["timeout-minutes"] > 0);
    const checkout = job.steps.find(({ id }) => id === "checkout");
    assert.equal(checkout.uses, "actions/checkout@v7");
    const install = job.steps.find(({ id }) => id === "install");
    if (install !== undefined) {
      assert.match(install.run, /\bpnpm install --frozen-lockfile\b/);
    }
    const node = job.steps.find(({ id }) => id === "node");
    if (node !== undefined) {
      assert.equal(node.uses, "actions/setup-node@v6");
      assert.equal(node.with["node-version"], 24);
      assert.equal(node.with.cache, "pnpm");
      assert.equal(node.with["cache-dependency-path"], "pnpm-lock.yaml");
    }
  }
});

test("CodeQL scans C++ and JavaScript/TypeScript with an explicit C++ build", async () => {
  const workflow = await loadWorkflow("codeql.yml");
  const analyze = workflow.jobs.analyze;
  const languages = new Set(
    analyze.strategy.matrix.include.map(({ language }) => language),
  );

  assert.deepEqual(languages, new Set(["c-cpp", "javascript-typescript"]));
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "security-events": "write",
  });
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.ok(analyze["timeout-minutes"] > 0);

  const steps = new Map(analyze.steps.map((step) => [step.id, step]));
  assert.equal(steps.get("checkout").uses, "actions/checkout@v7");
  assert.equal(steps.get("codeql-init").uses, "github/codeql-action/init@v4");
  assert.equal(
    steps.get("codeql-analyze").uses,
    "github/codeql-action/analyze@v4",
  );
  assert.equal(steps.get("cpp-build").if, "matrix.language == 'c-cpp'");
});

test("coverage uploads independent native and frontend reports without percentage gates", async () => {
  const workflow = await loadWorkflow("coverage.yml");

  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(
    new Set(Object.keys(workflow.jobs)),
    new Set(["native", "frontend"]),
  );

  for (const [jobName, flag] of [
    ["native", "native"],
    ["frontend", "frontend"],
  ]) {
    const job = workflow.jobs[jobName];
    const steps = new Map(job.steps.map((step) => [step.id, step]));
    const upload = steps.get("upload");
    assert.equal(upload.uses, "codecov/codecov-action@v7");
    assert.equal(upload.with.flags, flag);
    assert.equal(upload.with["fail_ci_if_error"], true);
    assert.equal(upload.with.disable_search, true);
    assert.ok(upload.with.files);
    assert.ok(job["timeout-minutes"] > 0);
  }
  const frontendSteps = new Map(
    workflow.jobs.frontend.steps.map((step) => [step.id, step]),
  );
  assert.match(
    frontendSteps.get("coverage").run,
    /test -s coverage\/frontend\/lcov\.info/,
  );
});

test("project coverage commands generate native XML and frontend LCOV reports", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );

  assert.match(
    packageJson.scripts["test:coverage:native"],
    /coverage\/native\/coverage\.xml/,
  );
  assert.match(
    packageJson.scripts["test:coverage:frontend"],
    /vitest run --coverage/,
  );
  assert.equal(packageJson.devDependencies["@vitest/coverage-v8"], "4.1.10");
});

test("package workflow builds and verifies artifacts on native runners", async () => {
  const workflow = await loadWorkflow("package.yml");
  const packageJob = workflow.jobs.package;

  assert.deepEqual(
    matrixTargets(packageJob),
    new Set([
      "linux/x64/ubuntu-24.04",
      "linux/arm64/ubuntu-24.04-arm",
      "win32/x64/windows-2025",
      "darwin/universal/macos-15",
    ]),
  );
  assert.equal(packageJob["runs-on"], "${{ matrix.runner }}");
  assert.equal(packageJob.strategy["fail-fast"], false);

  const steps = new Map(packageJob.steps.map((step) => [step.id, step]));
  assert.ok(steps.has("make"));
  assert.match(
    steps.get("make").run,
    /pnpm run make --platform "\$\{\{ matrix\.platform \}\}"/,
  );
  assert.equal(steps.get("make").run.includes("make -- --platform"), false);
  assert.ok(steps.has("verify-artifacts"));
  assert.equal(
    steps.get("upload").with.path,
    "${{ steps.artifact-manifest.outputs.artifact_paths }}",
  );
  assert.equal(steps.get("upload").uses, "actions/upload-artifact@v7");
  assert.equal(steps.get("upload").with["if-no-files-found"], "error");
  assert.equal(JSON.stringify(workflow).includes("0.1.0"), false);
});

test("macOS signing is isolated to protected tag jobs and temporary keychains", async () => {
  const workflow = await loadWorkflow("package.yml");
  const unsigned = workflow.jobs.package;
  const signed = workflow.jobs["signed-macos"];

  assert.equal(JSON.stringify(unsigned).includes("secrets."), false);
  assert.match(signed.if, /refs\/tags\/v/);
  assert.match(signed.if, /vars\.MACOS_SIGNING_ENABLED == 'true'/);
  assert.equal(signed.environment, "release");
  const steps = new Map(signed.steps.map((step) => [step.id, step]));
  assert.ok(steps.has("signing-preflight"));
  assert.equal(
    steps.get("signing-preflight").run.includes("enabled=false"),
    false,
  );
  assert.ok(steps.has("import-certificate"));
  assert.match(steps.get("import-certificate").run, /security import/);
  assert.match(steps.get("import-certificate").run, /security create-keychain/);
  assert.ok(steps.has("toolchain"));
  assert.match(
    steps.get("make").run,
    /pnpm run make --platform darwin --arch universal/,
  );
  assert.equal(steps.get("cleanup-keychain").if.includes("always()"), true);
  assert.match(steps.get("cleanup-keychain").run, /security delete-keychain/);
  assert.equal(
    steps.get("upload").with.path,
    "${{ steps.artifact-manifest.outputs.artifact_paths }}",
  );
});

test("all JavaScript actions use the selected Node 24-compatible major versions", async () => {
  const workflows = await Promise.all(
    ["ci.yml", "codeql.yml", "coverage.yml", "package.yml"].map(loadWorkflow),
  );
  const allowed = new Map([
    ["actions/checkout", "v7"],
    ["actions/setup-node", "v6"],
    ["actions/upload-artifact", "v7"],
    ["github/codeql-action/init", "v4"],
    ["github/codeql-action/analyze", "v4"],
    ["codecov/codecov-action", "v7"],
  ]);

  for (const workflow of workflows) {
    for (const { uses } of actionSteps(workflow)) {
      const [action, version] = uses.split("@");
      assert.equal(
        version,
        allowed.get(action),
        `unexpected action reference ${uses}`,
      );
    }
  }
});
