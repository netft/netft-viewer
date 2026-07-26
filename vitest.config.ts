import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/electron/**/*.test.{ts,tsx}",
      "test/renderer/**/*.test.{ts,tsx}",
    ],
  },
});
