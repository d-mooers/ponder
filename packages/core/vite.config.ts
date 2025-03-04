import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@ponder/common": path.resolve(__dirname, "../common/src"),
      "@ponder/utils": path.resolve(__dirname, "../utils/src"),
    },
  },
  test: {
    globalSetup: ["src/_test/globalSetup.ts"],
    setupFiles: ["src/_test/setup.ts"],
    poolOptions: {
      threads: {
        maxThreads: 4,
      },
    },
    sequence: { hooks: "stack" },
  },
});
