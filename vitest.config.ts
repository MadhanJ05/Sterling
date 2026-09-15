import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Each file starts its own in-process chain; running files in parallel makes the
    // measured gas and timing noisy and occasionally starves Ganache's JS fallback.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    reporters: process.env.CI ? ["default"] : ["default"],
  },
});
