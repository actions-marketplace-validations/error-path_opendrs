import { defineConfig } from "vitest/config";
import { SLOW_TEST_FILES } from "./vitest.slow.config.js";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], exclude: SLOW_TEST_FILES, testTimeout: 30_000 },
});
