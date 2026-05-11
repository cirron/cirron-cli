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
      // v0.1.0 coverage strategy:
      //
      // Global thresholds are intentionally low because most untested code is
      // platform-coupled (push/pull/sync/deploy/test/traces/spool) and will be
      // covered as we add backend-mocking utilities post-launch. The Boolean
      // gate that actually matters is the per-file thresholds below — these
      // protect the offline-capable surface that ships in v0.1.0 and the
      // graceful-error layer that wraps the platform-coupled commands.
      thresholds: {
        lines: 7,
        statements: 7,
        functions: 12,
        branches: 5,
        "src/utils/api-errors.ts": {
          lines: 90,
          functions: 90,
          branches: 80,
        },
        "src/utils/config.ts": {
          lines: 80,
          functions: 90,
        },
        "src/utils/ignore.ts": {
          lines: 80,
          functions: 75,
        },
        "src/utils/project-config.ts": {
          lines: 90,
          functions: 90,
        },
        "src/utils/version.ts": {
          lines: 80,
        },
        "src/utils/plan-diff.ts": {
          lines: 65,
          functions: 80,
        },
        "src/utils/plan-formatter.ts": {
          lines: 60,
          functions: 80,
        },
      },
    },
  },
});
