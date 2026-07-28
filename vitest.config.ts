import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/frontend",
      reporter: ["text", "lcov"],
      include: ["app/**/*.{ts,tsx}"],
      exclude: ["app/**/*.d.ts"],
    },
    include: [
      "test/electron/**/*.test.{ts,tsx}",
      "test/renderer/**/*.test.{ts,tsx}",
    ],
  },
});
