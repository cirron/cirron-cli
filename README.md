# Cirron CLI

[![npm version](https://img.shields.io/npm/v/@cirron/cli.svg)](https://www.npmjs.com/package/@cirron/cli)
[![CI](https://github.com/cirron/cirron-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/cirron/cirron-cli/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@cirron/cli.svg)](https://nodejs.org/)

Official command line interface for [Cirron](https://cirron.com). Scaffold, compile, build, test, and profile machine learning models on your own machine, and connect to the Cirron platform when you want hosted registry, deployments, and remote runs.

The CLI is fully usable today without an account. Everything in the local workflow (init, compile, build, test, lint, validate, plan, traces, doctor) runs offline. Platform features (auth, registry push/pull, deploy, remote runs, logs) are being rolled out to users. The commands are already here, ready when access opens up.

License: Apache-2.0.

## Installation

Install globally with npm (requires Node.js 22.13 or newer):

```bash
npm install -g @cirron/cli
```

Verify the install:

```bash
cirron --version
```

A `curl` one-line installer and a Homebrew formula are coming. For now, npm is the supported distribution channel.

## Quick start

```bash
cirron init my-model --template pytorch   # scaffold a project
cd my-model
cirron test                               # run the local test suite
cirron compile                            # compile the model locally
cirron build                              # build a container image
```

Project commands look for a `cirron.yaml` in the current directory. `cirron.yml` and `cirron.json` are also accepted. Run any command with `--help` for its full option list, or see the docs at [docs.cirron.com/cli](https://docs.cirron.com/cli).

## Project layout and configuration

`cirron init` generates a working ML project. The exact files depend on the template; a PyTorch project looks like:

```
my-model/
├── cirron.yaml          # project manifest (the CLI looks for this)
├── train.py             # training entry point
├── serve.py             # serving entry point
├── requirements.txt     # Python dependencies
├── models/              # trained model files
├── artifacts/           # build and run artifacts
└── build/               # build output
```

After `cirron init` you can run the project directly (`python train.py`, then `python serve.py`) or drive it through the CLI (`cirron test`, `cirron compile`, `cirron build`).

Configuration resolves in three layers, each overriding the one before it: global config in `~/.cirron/config.json`, the project `cirron.yaml`, then command line flags. Manage global and CLI settings with `cirron config`.

A minimal `cirron.yaml`:

```yaml
name: iris-classifier
framework: sklearn
type: classification
version: "1.0.0"
description: Random-forest classifier on the Iris dataset
servingConfig:
  runtime: onnx
env:
  THRESHOLD: "0.6"
```

Generated manifests also include a `servingConfig` with `feature_order`, `input_schema`, and `output_schema` describing the model's serving contract.

### File exclusion (.cirronignore)

A `.cirronignore` file controls which files Cirron commands process, using the same glob syntax as `.dockerignore` and `.gitignore`, including `!` negation. Build folds these patterns into a temporary `.dockerignore`, test uses them when scanning data directories, and file operations skip them. Add one at the project root to keep large data files, model artifacts, caches, and temp files out of Cirron operations. See [docs.cirron.com/cli/utils/cirronignore](https://docs.cirron.com/cli/utils/cirronignore).

### Registry settings

Container image names follow `registry/organization/project:tag`. Configure the registry and org with environment variables:

```bash
export CIRRON_REGISTRY=localhost:5000
export CIRRON_ORG=mycompany
# image becomes: localhost:5000/mycompany/iris-classifier:latest
```

## Templates

`cirron init <name> --template <template>`:

| Template | What you get |
| --- | --- |
| `pytorch` | PyTorch inference project |
| `pytorch-train` | PyTorch training pipeline |
| `tensorflow` | TensorFlow / Keras inference project |
| `tensorflow-train` | TensorFlow training pipeline |
| `sklearn` | scikit-learn model project |
| `sklearn-pipeline` | scikit-learn full pipeline |
| `custom` | blank Python project |

Run `cirron init` with no template to choose interactively.

## Commands

Run `cirron <command> --help` for full flags, or browse [docs.cirron.com/cli](https://docs.cirron.com/cli).

### Project

| Command | Description |
| --- | --- |
| `cirron init [name]` | Scaffold a new project from a template |
| `cirron register` | Register an existing project with Cirron |
| `cirron validate` | Validate the project config, or every model in a workspace |
| `cirron status` | Show project status (`--remote` to include platform state) |
| `cirron info` | Model info, diagnostics, and hardware details |
| `cirron doctor` | Diagnose the local environment: extras, config, spool, connectivity |
| `cirron config` | Manage CLI, global, and project configuration |
| `cirron config hardware` | Detect, configure, and save hardware profiles |
| `cirron lint` | Project health checks: config, structure, dependencies, code |

### Model lifecycle

| Command | Description |
| --- | --- |
| `cirron compile` | Compile the model locally, with architecture targeting and validation |
| `cirron build` | Build a container image, with architecture templates and validation |
| `cirron test` | Run ML tests: env, requirements, unit, model, data, inference, pipeline |
| `cirron deploy` | Deploy the project to an environment, with rollback support |

### Planning

| Command | Description |
| --- | --- |
| `cirron plan compile` | Preview a compile: artifact paths, dependencies, resource estimates |
| `cirron plan build` | Preview a build: artifacts, model shape, resource usage |
| `cirron plan diff <planA> <planB>` | Compare two saved plans |
| `cirron plan save [type]` | Save plans to disk for later comparison and auditing |
| `cirron plan replay --plan <file>` | Execute a previously saved plan |

### Execution and jobs

| Command | Description |
| --- | --- |
| `cirron run pipeline [name]` | Trigger a pipeline run |
| `cirron run job` | Run a single-task job |
| `cirron run inference [deployment]` | Trigger batch inference |
| `cirron run sweep` | Trigger a hyperparameter sweep |
| `cirron run list` | List runs and jobs |
| `cirron run status <runId>` | Get run status |
| `cirron run cancel <runId>` | Cancel a run |
| `cirron run logs <runId>` | Stream run logs |

### Registry and sync

| Command | Description |
| --- | --- |
| `cirron push [resource] [name]` | Push artifacts (model, image, build, runtime) to the registry |
| `cirron pull [resource] [name]` | Pull artifacts from the registry |
| `cirron sync [path]` | Bidirectional state sync with conflict resolution |
| `cirron list <resource>` | List deployments, builds, models, images, registry, runs, pipelines |
| `cirron logs` | View deployment logs (`-f` to follow) |
| `cirron env` | Manage per-environment variables (`list`, `set`, `delete`) |

### Observability

| Command | Description |
| --- | --- |
| `cirron traces view` | Render the local scope tree as a text flamegraph |
| `cirron traces list` | List trace sessions in the local spool |
| `cirron traces export --format <fmt>` | Export traces to parquet, otel, csv, or json |
| `cirron traces clear` | Delete trace sessions and their snapshots |
| `cirron traces snapshots [spanId]` | List weight and gradient snapshots by span |
| `cirron traces snapshot <spanId> [tensor]` | Inspect a span's snapshots: stats, histogram, tensor preview |
| `cirron spool inspect` | Show spool file count, size, and timestamp range |
| `cirron spool flush` | Upload spool batches to the platform and delete on success |
| `cirron spool clear` | Delete all spool files |

### Auth (platform)

| Command | Description |
| --- | --- |
| `cirron auth login` | Authenticate with the Cirron platform |
| `cirron auth logout` | Sign out |
| `cirron auth status` | Show authentication status |
| `cirron auth refresh` | Refresh the auth token |

## Use cases

### Scaffold and iterate on a model locally

```bash
cirron init image-captioner --template pytorch --git
cd image-captioner
# edit train.py and serve.py
python train.py                # train and export the model
cirron test --model            # model loads and instantiates
cirron test --inference        # inference pipeline runs
cirron compile --validate      # compile with integrity checks
cirron build --validate        # build a container image
```

### Health check before committing

```bash
cirron validate                # config is well formed
cirron lint --fix              # structure, dependencies, code quality, auto-fix what it can
cirron doctor                  # local environment, extras, connectivity
```

### Preview and replay a build

```bash
cirron plan build --validate --save plan-a.json
# make some changes, then:
cirron plan build --validate --save plan-b.json
cirron plan diff plan-a.json plan-b.json --verbose
cirron plan replay --plan plan-a.json --dry-run
```

### Profile a training run

After running training with the Cirron SDK, the local spool holds trace sessions and snapshots:

```bash
cirron spool inspect
cirron traces list
cirron traces view --last 1 --min-wall 1ms
cirron traces snapshots --session <id>
cirron traces snapshot <spanId> --json
cirron traces export --format parquet --output traces/
```

### Multiple models in one repository

Add a root `cirron.yaml` with a `workspace:` key. The CLI then runs in monorepo mode from the repo root and can discover and validate every model. Running inside a model subdirectory still operates on that model alone (there is no upward search).

```yaml
workspace:
  name: ml-models
  models:
    - path: models/sentiment-rnn
    - path: models/news-classifier
    - path: models/*            # each immediate subdir that has a cirron.yaml
  defaults:                     # inherited by every model
    profiling:
      snapshots: stats
      flush_interval: 1.0
    env:
      ENVIRONMENT: production
```

```bash
cirron validate                       # validate every model
cirron validate --model sentiment-rnn # validate one (by name or path)
cirron validate --json                # machine-readable output
```

Inheritance rules: `env` is shallow-merged and the model's value wins on conflicts. `profiling` is replaced wholesale when the model defines its own block. Any other `defaults` key applies only when the model does not set it. See [docs.cirron.com/cli/monorepo](https://docs.cirron.com/cli/monorepo).

### Connect to the Cirron platform

Platform access is rolling out to users. These commands target `app.cirron.com` and need an account; the local workflow above does not.

```bash
cirron auth login
cirron register                       # link this project to Cirron
cirron push model image-captioner --tag v1.3.0 -m "Improved accuracy"
cirron pull model image-captioner --tag v1.2.0
cirron deploy --env production
cirron run pipeline train --config config.yaml --watch
cirron logs -f
```

## Development

```bash
npm install            # install dependencies
npm run build          # compile TypeScript to dist/
npm run build:watch    # watch mode compilation
npm run dev            # run with ts-node

npm test               # run the test suite (Vitest)
npm run test:watch     # watch mode
npm run test:coverage  # with coverage

npm run lint           # lint
npm run lint:fix       # lint and fix

npm link               # symlink `cirron` to this checkout for local testing
npm unlink -g cirron   # remove the symlink
```

Tests live in `tests/`. The CLI source is under `src/` (`src/commands/` for command handlers, `src/utils/` for shared utilities, `src/types/` for types), with project templates in `templates/`. See `CLAUDE.md` for contributor conventions.

## Contributing

Bug reports, feature requests, and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the rules we hold the line on, and the PR flow, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## Security

Do not file public issues for security vulnerabilities. Use GitHub's "Report a vulnerability" link or email `security@cirron.com`. See [SECURITY.md](SECURITY.md) for the full reporting flow, supported-versions policy, and disclosure expectations.

## Trademarks

The Cirron name, logo, and visual identity are trademarks of Cirron, Inc. and are not covered by the Apache 2.0 license that covers the source code. See [TRADEMARKS.md](TRADEMARKS.md) for what's allowed (compatibility statements, factual references) and what isn't (implying endorsement, redistributing under the Cirron name).

## Links

- Docs: [docs.cirron.com/cli](https://docs.cirron.com/cli)
- Platform: [app.cirron.com](https://app.cirron.com)
- Issues: [github.com/cirron/cirron-cli/issues](https://github.com/cirron/cirron-cli/issues)
- Discussions: [github.com/cirron/cirron-cli/discussions](https://github.com/cirron/cirron-cli/discussions)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security: [SECURITY.md](SECURITY.md)
