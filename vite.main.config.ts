import { defineConfig } from "vite";

export default defineConfig({
  define: {
    NETFT_VIEWER_E2E_BUILD: JSON.stringify(
      process.env.NETFT_VIEWER_E2E_BUILD === "true",
    ),
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      external: ["electron"],
    },
  },
});
