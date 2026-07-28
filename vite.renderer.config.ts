import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import {
  DEVELOPMENT_CONTENT_SECURITY_POLICY,
  PRODUCTION_CONTENT_SECURITY_POLICY,
} from "./app/shared/content-security-policy";

export default defineConfig(({ command }) => {
  const contentSecurityPolicy =
    command === "serve"
      ? DEVELOPMENT_CONTENT_SECURITY_POLICY
      : PRODUCTION_CONTENT_SECURITY_POLICY;
  return {
    root: resolve(__dirname, "app/renderer"),
    plugins: [
      {
        name: "netft-viewer-csp",
        enforce: "pre",
        transformIndexHtml(html) {
          if (!html.includes(PRODUCTION_CONTENT_SECURITY_POLICY)) {
            throw new Error("renderer CSP metadata is missing");
          }
          return html.replace(
            PRODUCTION_CONTENT_SECURITY_POLICY,
            contentSecurityPolicy,
          );
        },
      },
      react(),
    ],
    build: {
      outDir: resolve(__dirname, ".vite/renderer/main_window"),
      rollupOptions: {
        input: resolve(__dirname, "app/renderer/index.html"),
      },
    },
  };
});
