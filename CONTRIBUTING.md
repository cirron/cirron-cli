# Contributing to `cirron-cli`

Thanks for your interest in contributing. We welcome contributions of all kinds: bug reports, feature requests, doc improvements, and code.

This document covers the dev setup, the rules we hold the line on, and the PR flow.

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). Please be respectful in all interactions.

## How can I contribute?

### Reporting bugs

Before opening a bug report, search the [issue tracker](https://github.com/cirron/cirron-cli/issues) to see if it has already been reported. If not, open a new issue using the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include:

- A clear, descriptive title.
- The smallest `cirron ...` command sequence that triggers it, plus the relevant `cirron.yaml` if a project is involved.
- Your environment: `cirron --version`, the output of `cirron doctor`, `node -v`, how you installed the CLI (`npm install -g @cirron/cli` vs. a local `npm link` checkout), and your OS and hardware.
- The full CLI output / stack trace. If a command exits with an error code, see [`CLI-ERROR-CODES.md`](CLI-ERROR-CODES.md).

### Suggesting enhancements

Feature requests go in the issue tracker too, via the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md). Describe the specific problem it solves, sketch the command or flag if you have one in mind, and (most importantly) say whether the feature belongs in the CLI or on the platform. See [The standalone/platform line](#the-standaloneplatform-line) below.

### Pull requests

1. **Fork** the repository and create a branch from `main`.
2. **Set up** your local environment (see [Getting set up](#getting-set-up) below).
3. **Commit** with clear, concise messages. Imperative mood (`Add foo`, not `Added foo`); first line under 72 chars; reference issues with `Closes #N` in the body.
4. **Test**: `npm run build`, `npm test`, and `npm run lint` must all pass locally before you push.
5. **Submit** a PR against `main` using the [PR template](.github/pull_request_template.md). Fill out every section, especially **New dependencies**.

For small fixes (typos, doc clarifications, obvious one-line bugs), feel free to skip the issue and go straight to a PR. For non-trivial changes, open an issue first; it saves rework if the design needs iteration.

A maintainer will triage within a week. Review velocity beyond triage depends on scope and current load.

## Releases

Releases are automated with [`auto`](https://intuit.github.io/auto/). Merging to `main` triggers the release workflow (`.github/workflows/release.yml`), which runs `npx auto shipit`: it picks the semver bump from the merged PRs' labels (`major` / `minor` / `patch`, or `skip-release` to skip), updates `CHANGELOG.md`, bumps the version in `package.json`, creates the `vX.Y.Z` git tag and GitHub release, and publishes to npm.

**Do not hand-edit the version in `package.json`.** `auto` owns it. Contributors should not apply release labels either. Just state in the PR body whether the change is a breaking change, a feature, or a fix (the PR template has a line for this). A maintainer applies the `major` / `minor` / `patch` / `skip-release` label during review so the right bump is cut.

## Getting set up

The CLI is a TypeScript project and requires Node.js 20.19 or newer.

```bash
git clone https://github.com/cirron/cirron-cli
cd cirron-cli

npm install            # install dependencies
npm run build          # compile TypeScript to dist/
```

For local end-to-end testing, symlink the `cirron` binary to your checkout:

```bash
npm link               # `cirron` now points at this checkout
cirron --version
npm unlink -g cirron   # remove the symlink when done
```

Before you push:

```bash
npm run build          # tsc must succeed
npm test               # Vitest unit tests
npm run lint           # ultracite / biome (use `npm run lint:fix` to autofix)
```

CI runs the same three. They must pass.

## What this CLI is (and isn't)

`cirron-cli` is a **local-first ML project lifecycle tool**. It scaffolds projects (`cirron init`), compiles and containerizes models (`cirron compile`, `cirron build`), runs ML-specific tests (`cirron test`), checks project health (`cirron lint`, `cirron validate`, `cirron doctor`), previews and replays operations (`cirron plan ...`), and inspects local profiling output produced by the Cirron SDK (`cirron traces ...`, `cirron spool ...`). When you authenticate, the same CLI talks to the Cirron platform for hosted registry, deployments, remote runs, and logs.

It is **not** a model framework, a training orchestrator, or a dashboard.

### The standalone/platform line

**The CLI works standalone. The platform makes it powerful.** This is the same relationship as `git` to GitHub. The local workflow is portable, the collaboration is where the value is.

When proposing a new feature, ask: *is this useful on a disconnected laptop with no Cirron account, or does it only pay off across many runs / many users / with platform-managed metadata?*

- **Belongs in the CLI**: anything that scaffolds, builds, tests, validates, or inspects a project and its local artifacts — `init`, `compile`, `build`, `test`, `lint`, `validate`, `doctor`, `plan`, and the `traces` / `spool` readers and exporters.
- **Belongs on the platform**: the dashboard, query engine, cross-run aggregation, cost attribution, the hosted registry, remote run orchestration, team visibility / access control. The CLI just *talks to* these (`auth`, `push`/`pull`/`sync`, `deploy`, `run`, `logs`).

If a proposal blurs this line ("let's add a local run history database," "let's ship a local web dashboard"), expect pushback. The CLI's locally-useful surface is **scaffold + build + inspect + export**, never visualize + analyze + collaborate.

This isn't a marketing rule, it's a customer rule. Users will explicitly ask "what happens if we stop using Cirron?" The answer must always be "your project is plain files (`cirron.yaml`, your code, `requirements.txt`) and your outputs are in standard formats in your local cache (`./.cirron/`). The directory is portable."

## What's public API

Treat these as stable surface and don't change them casually:

1. **The command surface and flags** in `src/commands/**` — command names, subcommands, and documented options. Removing or renaming a command or flag is a breaking change.
2. **The `cirron.yaml` config schema**, including the `workspace:` monorepo block. See `CLAUDE.md` for the schema details.
3. **The `.cirronignore` semantics** — glob patterns and `!` negation, as used by `build`, `test`, and file operations (`src/utils/ignore.ts`).
4. **The local spool / snapshot layout** the `cirron traces` and `cirron spool` commands read (`./.cirron/spool/*.json`, `./.cirron/snapshots/<span_id>/<tensor>.safetensors`) — this is shared with the Cirron SDK.

Breaking changes to any of these need a version bump and a migration note in the PR.

## Dependency policy

Adding any new dependency (runtime or dev) requires justification in the PR description.

### Rules

1. **Justify it.** What does it enable? Why can't we vendor or reimplement?
2. **Pin a lower bound, not an upper bound.** Use the existing `^X.Y.Z` convention in `package.json`. Avoid hard `<` constraints unless there's a known incompatibility; they cause downstream resolver pain.
3. **Keep runtime deps lean.** The CLI ships its `dependencies` to every user. Anything only needed for builds, tests, or tooling goes in `devDependencies`.
4. **License.** MIT, BSD, Apache-2.0, MPL-2.0, ISC only. No GPL / LGPL / AGPL or commercial-restricted licenses in runtime deps.
5. **Supply-chain hygiene.** Prefer packages with active maintenance (commit in last 12 months), multiple maintainers, and meaningful download volume. Flag anything that doesn't meet that bar in the PR. We may still accept it, but want to make the tradeoff consciously.
6. **Document it in the PR.** The PR template has a "New dependencies" section. List each new dep as `name version (runtime/dev): reason`. Example:
   ```
   - cli-table3 ^0.6.5 (runtime): table rendering for `cirron list` output.
   - vitest ^4.1.5 (dev): test runner.
   ```

## Style guidelines

- **Code style.** We use `ultracite` / `biome` for lint and format (`npm run lint`, `npm run lint:fix`) and TypeScript strict mode. Run lint and `npm run build` before submitting. CI will fail otherwise.
- **No emojis in logging.** This is a production CLI. Use standard log levels, not emoji decoration. The only acceptable emoji is 💡 for tips in documentation. (See `CLAUDE.md`.)
- **Interactive prompts.** All Inquirer prompts use `loop: false` to avoid infinite-carousel behavior, and every interactive feature has a graceful non-interactive fallback. Follow the command and `InteractiveManager` patterns already in the codebase (`CLAUDE.md` has the details).
- **Comments.** Write the *why*, not the *what*. If a comment just restates the code, delete it. Keep one-line comments where the code's intent isn't obvious from naming.
- **Errors.** Surface failures clearly and use the project's error-code conventions (`CLI-ERROR-CODES.md`); don't swallow errors silently.
- **Documentation.** If you change user-facing behavior or the command surface, update `README.md` and `CLAUDE.md` in the same PR. The user-facing CLI docs live in the application repo under `apps/docs/` (`docs.cirron.com/cli`) — keep them in sync.

## Reporting security issues

Do *not* file a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the full reporting flow, supported-versions policy, and disclosure expectations. The short version: use GitHub's "Report a vulnerability" link, or email `security@cirron.com`.

## Legal notice

By contributing to this project, you agree that your contributions will be licensed under the project's [LICENSE](LICENSE) (Apache 2.0). You certify that you have the right to submit this work and that it does not violate any third-party rights.

## Inbound license and relicensing

Contributions are licensed inbound under [Apache 2.0](LICENSE) per Apache 2.0 §5 (Submission of Contributions). By submitting a contribution you acknowledge that Cirron, Inc. may relicense the project (including your contribution) under a different license at its discretion. If you cannot agree to this, do not submit contributions to this project.

## Trademarks

The Cirron name, logo, and visual identity are trademarks of Cirron, Inc. and are not covered by the Apache 2.0 license that covers the source code. See [TRADEMARKS.md](TRADEMARKS.md) for what's allowed (compatibility statements, factual references) and what isn't (implying endorsement, redistributing under the Cirron name).

## Governance

Merge access to `main` and release branches is restricted to active members of the Cirron organization. External contributors land changes through PRs reviewed and merged by a maintainer. Anyone can open an issue proposing a non-trivial change; the decision to accept or decline rests with the core team.

## Questions

For anything that doesn't fit an issue or PR (design discussions, "is this the right approach," etc.), open a [GitHub Discussion](https://github.com/cirron/cirron-cli/discussions) or reach out at `dx@cirron.com`.
