import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    dir: "test/",
    globals: true,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
