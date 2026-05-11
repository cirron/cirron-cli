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
      // Coverage strategy:
      //
      // Per-file thresholds are the real gate. The command surface that has
      // been driven through its full happy/error/dry-run flows with the
      // shared mock-api helpers is held to 65–90%. build/compile/test still
      // shell out heavily (python/docker) so they sit lower until a deeper
      // child_process mocking layer lands.
      thresholds: {
        lines: 48,
        statements: 48,
        functions: 52,
        branches: 38,
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
        "src/commands/init.ts": { lines: 65 },
        "src/commands/config.ts": { lines: 40 },
        "src/commands/logs.ts": { lines: 90 },
        "src/commands/hardware.ts": { lines: 80 },
        "src/commands/settings.ts": { lines: 55 },
        "src/commands/auth.ts": { lines: 50 },
        "src/commands/plan.ts": { lines: 48 },
        "src/commands/push.ts": { lines: 80 },
        "src/commands/pull.ts": { lines: 85 },
        "src/commands/sync.ts": { lines: 80 },
        "src/commands/deploy.ts": { lines: 85 },
        "src/commands/spool.ts": { lines: 85 },
        "src/commands/replay.ts": { lines: 80 },
        "src/commands/run.ts": { lines: 80 },
        "src/commands/traces.ts": { lines: 65 },
        "src/commands/info.ts": { lines: 65 },
        "src/commands/compile.ts": { lines: 35 },
        "src/commands/test.ts": { lines: 22 },
        "src/commands/build.ts": { lines: 10 },
      },
    },
  },
});
