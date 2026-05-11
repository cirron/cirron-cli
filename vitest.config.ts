import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      include: ["src/**/*.ts"],
      // CLI entry wiring is exercised by the integration test, not unit-tested.
      // Template file generators are validated by init.test.ts via file presence.
      // Type-only files have nothing to cover.
      exclude: [
        "src/index.ts",
        "src/types/**",
        "src/commands/files/**",
      ],
      thresholds: {
        lines: 50,
        statements: 50,
        functions: 45,
        branches: 40,
      },
    },
  },
});
