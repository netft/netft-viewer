import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  outputDir: "test-results/playwright",
  reporter: [["line"]],
  use: {
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
});
