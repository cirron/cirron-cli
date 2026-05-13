# Changelog

# v0.1.0 (Tue May 13 2026)

First official release of `@cirron/cli`. This is the first release published under the scoped package name.

#### 🚀 Enhancement

- Basic monorepo support: top-level `cirron.yaml` `workspace:` block, model discovery via paths
  and globs, shallow inheritance for `env` / `profiling` / other `defaults`, and `cirron validate`
  with per-model validation, `--model` filtering, and `--json` output. [#59](https://github.com/cirron/cirron-cli/pull/59) ([@dlynch42](https://github.com/dlynch42))

#### 🤖 CI/CD

- Migrate to `auto`-driven release tooling and revamp CI workflows: replace the commented
  workflow stubs and custom `scripts/release.js` with `auto shipit` (semver from PR labels,
  `CHANGELOG.md`, `vX.Y.Z` tag, GitHub release, npm publish with provenance), add per-PR
  `verify` (lint / build / test on Node 20 and 22) and a global-install smoke test, port the
  PR-size labeler, and seed `.autorc` / category labels. [#64](https://github.com/cirron/cirron-cli/pull/64) ([@dlynch42](https://github.com/dlynch42))
- Promote `release` to `main` for the first official release. [#65](https://github.com/cirron/cirron-cli/pull/65) ([@dlynch42](https://github.com/dlynch42))

#### Notable user-visible changes

- **Install command is now `npm install -g @cirron/cli`** (scoped). The old unscoped name is
  retired; existing global installs should be removed (`npm rm -g cirron`) before installing
  the scoped name.
- **Minimum Node version is 20.19** (or 22.12+). The shipped CLI `require()`s ESM-only
  dependencies (`chalk@5`, `ora@9`, etc.) that only resolve on those versions; Node 18 cannot
  run `cirron`.
- New `workspace:` configuration and per-model commands for monorepos (see `cirron validate`).
- All package bundles published with **npm provenance attestation** (npm trusted publishing
  via OIDC, no long-lived NPM token).

#### Authors: 1

- Devin Lynch ([@dlynch42](https://github.com/dlynch42))

---
