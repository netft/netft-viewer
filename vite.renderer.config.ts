import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "app/renderer"),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, ".vite/renderer/main_window"),
    rollupOptions: {
      input: resolve(__dirname, "app/renderer/index.html"),
    },
  },
});
