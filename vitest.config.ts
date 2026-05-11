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
      exclude: ["src/index.ts", "src/types/**", "src/commands/files/**"],
      // v0.1.0 coverage strategy:
      //
      // Global thresholds remain conservative because the still-untested code
      // (test/traces/spool/run/replay/info/compile/build) is platform-coupled
      // and pending its own mock-API rollout. The Boolean gate that actually
      // matters is the per-file thresholds below — these protect the
      // offline-capable surface plus the platform-coupled commands that have
      // been driven through their full happy/error/dry-run flows with the
      // shared mock-api helpers (push/pull/sync/deploy).
      thresholds: {
        lines: 35,
        statements: 35,
        functions: 42,
        branches: 25,
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
        "src/commands/env.ts": { lines: 80 },
        "src/commands/diagnostics.ts": { lines: 65 },
        "src/commands/lint.ts": { lines: 55 },
        "src/commands/doctor.ts": { lines: 45 },
        "src/commands/status.ts": { lines: 45 },
        "src/commands/register.ts": { lines: 50 },
        "src/commands/list.ts": { lines: 40 },
        "src/commands/init.ts": { lines: 40 },
        "src/commands/config.ts": { lines: 40 },
        "src/commands/push.ts": { lines: 80 },
        "src/commands/pull.ts": { lines: 85 },
        "src/commands/sync.ts": { lines: 80 },
        "src/commands/deploy.ts": { lines: 85 },
        "src/commands/spool.ts": { lines: 85 },
        "src/commands/replay.ts": { lines: 80 },
        "src/commands/run.ts": { lines: 80 },
      },
    },
  },
});
