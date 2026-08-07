Test count: 216 → 556 tests (+340 tests across Rounds 2–8)
Coverage: 20.48% → 57.63% lines across all src/  (commands/ alone: 73%)

## Per-command coverage (latest)

| Command         | R1   | latest |
|-----------------|------|--------|
| logs.ts         | 42%  | 95%  |
| spool.ts        | 18%  | 91%  |
| pull.ts         | 12%  | 89%  |
| deploy.ts       | 13%  | 88%  |
| auth.ts         | 27%  | 88%  |
| hardware.ts     | 21%  | 85%  |
| traces.ts       | 4%   | 84%  |
| push.ts         | 5%   | 83%  |
| sync.ts         | 10%  | 83%  |
| replay.ts       | 4%   | 83%  |
| run.ts          | 10%  | 83%  |
| settings.ts     | 13%  | 83%  |
| config.ts       | 44%  | 85%  |
| doctor.presentation.ts | 29% | 100% |
| info.ts         | 3%   | 71%  |
| init.ts         | 46%  | 69%  |
| test.ts         | 4%   | 67%  |
| build.ts        | 6%   | 57%  |
| compile.ts      | 8%   | 54%  |
| plan.ts         | 16%  | 52%  |

## Mocking patterns established

- `tests/helpers/session.ts` — `createAuthenticatedSession` (HOME redirect + saved auth)
- `tests/helpers/project-fixture.ts` — `writeProjectConfig`, `writeFileAt`
- `tests/helpers/mock-api.ts` — payload factories + `stubProcessExit` / `exitCodeFromError`
- `vi.mock("node:child_process")` (execSync + a fake `EventEmitter` `spawn` child) — the
  canonical way around vitest's static ESM binding; used by build / compile / test / replay.
  Combine with `vi.spyOn(executionMod, …)` for the spawn-backed `executePythonScript` /
  `executePythonFile` / `executeScript` helpers in `src/utils/execution.ts`.
- `vi.stubGlobal("fetch", ...)` (spool, auth, api, contracts) and `vi.mock("open")` (auth device flow)
- For `auth` device flow: assign `process.stdin.{setRawMode,resume,pause,once}` directly
  (they're absent on a non-TTY stdin so `vi.spyOn` can't be used), and stub `setTimeout`.
- `vi.spyOn(ModelConfigManager.prototype, "loadModelConfig")` to skip the
  `require("./project-config")` codepath that fails under vitest's ESM transformer
- `vi.spyOn(sessionMod, "loadSessions")` + `vi.spyOn(safetensorsMod, …)` for traces
- `vi.spyOn(HardwareDetector, …)` / `vi.spyOn(settingsManager, …)` static stubs
- `vi.spyOn(PlanGenerator.prototype, "generatePlan")` + `PlanFormatter` / `PlanStorage` /
  `PlanDiffAnalyzer` stubs for plan tests
- `diagnostics.test.ts` stubs `CirronApi.prototype.verifyAuth` so the connectivity
  check doesn't make a real 10s network request.

## Known limitations

- `build.ts` / `compile.ts` / `plan.ts` still have large interactive branches and
  framework-specific script-gen variants uncovered (52–57%). `test.ts` at 67% — the
  remaining gaps are deep pipeline/endpoint script bodies and watch mode.
- A few deeply-nested interactive sub-prompts in `settings.ts` / `hardware.ts` remain.

## Per-file thresholds (vitest.config.ts)

- 95–100%: doctor.presentation
- 82–95%: push, pull, sync, deploy, spool, replay, run, logs, hardware, traces, settings, auth, config
- 50–71%: info, init, test, build, compile, plan
- Global: lines/statements 57, functions 61, branches 42

(Pre-existing unrelated lint warning: `tests/unit/utils/plan-formatter.test.ts:145` —
control-char regex; predates this work.)
