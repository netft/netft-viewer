import { defineConfig } from "vite";

import { readCoreSnapshot } from "./tools/lib/core-snapshot.mjs";

export default defineConfig(async () => {
  const coreSnapshot = await readCoreSnapshot();
  return {
    define: {
      NETFT_VIEWER_CORE_SNAPSHOT: JSON.stringify(coreSnapshot),
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
  };
});
