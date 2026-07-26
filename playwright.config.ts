import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const evidenceDirectory = resolve(
  ".superpowers/sdd/2026-07-26-netft-viewer-implementation-plan/concepts/e2e",
);

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  outputDir: resolve(evidenceDirectory, "playwright-results"),
  reporter: [["line"]],
  use: {
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
});
