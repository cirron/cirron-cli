# v0.1.1 (Mon Aug 03 2026)

#### 🐛 Bug Fix

- Normalize API responses and tighten contract tests [#84](https://github.com/cirron/cirron-cli/pull/84) ([@dlynch42](https://github.com/dlynch42) [@dependabot[bot]](https://github.com/dependabot[bot]))

#### Authors: 2

- [@dependabot[bot]](https://github.com/dependabot[bot])
- Devin Lynch ([@dlynch42](https://github.com/dlynch42))

---

# Changelog

# v0.1.0 (Tue May 13 2026)

First official release of `@cirron/cli`.

#### Notable user-visible changes
- **Minimum Node version is 20.19** (or 22.12+). The shipped CLI `require()`s ESM-only
  dependencies (`chalk@5`, `ora@9`, etc.) that only resolve on those versions; Node 18 cannot
  run `cirron`.
- All package bundles are published with **npm provenance attestation** via npm trusted
  publishing (OIDC, no long-lived NPM token).

#### 🚀 Enhancement

- Basic **monorepo support**: top-level `cirron.yaml` `workspace:` block, model discovery via
  paths and globs, shallow inheritance for `env` / `profiling` / other `defaults`, and
  `cirron validate` with per-model validation, `--model` filtering, and `--json` output. [#59](https://github.com/cirron/cirron-cli/pull/59) ([@dlynch42](https://github.com/dlynch42))
- **SDK configuration + diagnostics** (`cirron doctor`): TOML resolver, virtual-env discovery,
  Python `dist-info` / `METADATA` parsing, and a doctor command that surfaces extras, config,
  spool, and connectivity issues. [#58](https://github.com/cirron/cirron-cli/pull/58) ([@dlynch42](https://github.com/dlynch42))
- **Trace viewing and session interaction** (`cirron traces`): refactored spool utilities and
  new `traces` subcommands for rendering, listing, exporting (parquet / otel / csv / json),
  and inspecting snapshots and tensor previews. [#57](https://github.com/cirron/cirron-cli/pull/57) ([@dlynch42](https://github.com/dlynch42))
- **Local spool management** (`cirron spool`): inspect spool file count / size / timestamps,
  and flush spool batches to the platform with retries and gzip. [#56](https://github.com/cirron/cirron-cli/pull/56) ([@dlynch42](https://github.com/dlynch42))
- **Unified project config loader** for `cirron.yaml` / `cirron.yml` / `cirron.json`. [#55](https://github.com/cirron/cirron-cli/pull/55) ([@dlynch42](https://github.com/dlynch42))
- **Model metadata + `cirron register`** to register an existing project with Cirron. [#53](https://github.com/cirron/cirron-cli/pull/53) ([@dlynch42](https://github.com/dlynch42))
- **Unified command tree** plus the `push`, `pull`, `sync`, and `run` commands. [#52](https://github.com/cirron/cirron-cli/pull/52) ([@dlynch42](https://github.com/dlynch42)) [#51](https://github.com/cirron/cirron-cli/pull/51) ([@dlynch42](https://github.com/dlynch42)) [#50](https://github.com/cirron/cirron-cli/pull/50) ([@dlynch42](https://github.com/dlynch42)) [#49](https://github.com/cirron/cirron-cli/pull/49) ([@dlynch42](https://github.com/dlynch42)) [#48](https://github.com/cirron/cirron-cli/pull/48) ([@dlynch42](https://github.com/dlynch42))
- **`list` command** for resource management (deployments, builds, models, images, registry,
  runs, pipelines). [#38](https://github.com/cirron/cirron-cli/pull/38) ([@dlynch42](https://github.com/dlynch42))
- **Diagnostics command** for configuration and connectivity checks. [#31](https://github.com/cirron/cirron-cli/pull/31) ([@dlynch42](https://github.com/dlynch42))
- **YAML support** for project config. [#30](https://github.com/cirron/cirron-cli/pull/30) ([@dlynch42](https://github.com/dlynch42))
- **Device-flow auth + JWT** (`cirron auth login`). [#29](https://github.com/cirron/cirron-cli/pull/29) ([@dlynch42](https://github.com/dlynch42))
- **Settings command** for CLI preferences. [#28](https://github.com/cirron/cirron-cli/pull/28) ([@dlynch42](https://github.com/dlynch42))
- **Interactive mode** for step-by-step prompting on `build`, `compile`, `test`, `plan`. [#27](https://github.com/cirron/cirron-cli/pull/27) ([@dlynch42](https://github.com/dlynch42))
- **Hardware detection and configuration**. [#26](https://github.com/cirron/cirron-cli/pull/26) ([@dlynch42](https://github.com/dlynch42))
- **`plan` / `replay` commands**: preview compile and build plans, save, diff, and replay. [#24](https://github.com/cirron/cirron-cli/pull/24) ([@dlynch42](https://github.com/dlynch42))
- **`lint` command** for project health checks across config, structure, dependencies, code. [#22](https://github.com/cirron/cirron-cli/pull/22) ([@dlynch42](https://github.com/dlynch42))
- **Metadata extraction and update**. [#21](https://github.com/cirron/cirron-cli/pull/21) ([@dlynch42](https://github.com/dlynch42))
- **`info` command** to display model metadata. [#20](https://github.com/cirron/cirron-cli/pull/20) ([@dlynch42](https://github.com/dlynch42))
- **`.cirronignore` support** for file exclusion (glob patterns with `!` negation, integrated
  into build / test / file operations). [#19](https://github.com/cirron/cirron-cli/pull/19) ([@dlynch42](https://github.com/dlynch42))
- **ML model compilation** (`cirron compile`) with architecture targeting and validation. [#18](https://github.com/cirron/cirron-cli/pull/18) ([@dlynch42](https://github.com/dlynch42))
- **Test command options**: env, requirements, unit, model, data, inference, pipeline. [#11](https://github.com/cirron/cirron-cli/pull/11) ([@dlynch42](https://github.com/dlynch42))
- **`--force` on `build`** for error bypass. [#25](https://github.com/cirron/cirron-cli/pull/25) ([@dlynch42](https://github.com/dlynch42))

#### 🐛 Bug Fix

- Replace `list` inquirer prompt type with `select` for a consistent CLI experience. [#54](https://github.com/cirron/cirron-cli/pull/54) ([@dlynch42](https://github.com/dlynch42))

#### 🤖 CI/CD

- Migrate to `auto`-driven release tooling and revamp CI workflows: replace the commented
  workflow stubs and custom `scripts/release.js` with `auto shipit` (semver from PR labels,
  `CHANGELOG.md`, `vX.Y.Z` tag, GitHub release, npm publish with provenance), add per-PR
  `verify` (lint / build / test on Node 20 and 22) and a global-install smoke test, port the
  PR-size labeler, and seed `.autorc` / category labels. [#64](https://github.com/cirron/cirron-cli/pull/64) ([@dlynch42](https://github.com/dlynch42))
- Promote `release` to `main` for the first official release. [#65](https://github.com/cirron/cirron-cli/pull/65) ([@dlynch42](https://github.com/dlynch42))

#### 🏠 Internal

- Migrate test runner from Jest to Vitest, switch from ESLint to Biome / ultracite, and rename
  the package to the scoped form `@cirron/cli`. [#60](https://github.com/cirron/cirron-cli/pull/60) ([@dlynch42](https://github.com/dlynch42))
- Refactor CLI for improved error handling and async execution. [#23](https://github.com/cirron/cirron-cli/pull/23) ([@dlynch42](https://github.com/dlynch42))
- Upgrade dependencies and refactor the build process. [#47](https://github.com/cirron/cirron-cli/pull/47) ([@dlynch42](https://github.com/dlynch42))

#### Authors: 1

- Devin Lynch ([@dlynch42](https://github.com/dlynch42))

---
