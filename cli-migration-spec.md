# Cirron CLI Beta Migration Spec

## Overview

Restructure the CLI command tree for beta launch. The goal is to consolidate commands without losing any existing logic — this is a structural migration, not a rewrite. All existing command handlers stay intact; we're changing how they're wired up and adding stubs for new commands.

---

## Current → Beta Command Map

### Commands That Stay Unchanged

| Command | Notes |
|---------|-------|
| `auth (login \| logout \| status \| refresh)` | No changes |
| `init [name]` | No changes |
| `compile [options]` | No changes |
| `build [options]` | No changes |
| `test [options]` | No changes |
| `lint [options]` | No changes |
| `deploy [options]` | No changes |
| `env (list \| set \| delete)` | No changes |
| `status` | No changes |
| `logs` | No changes |
| `list <resource>` | Add `runs` and `registry` as valid resource types |

### Commands Being Consolidated

| Current Command | Moves To | Migration |
|----------------|----------|-----------|
| `settings` | `config` | Merge all settings flags into config with scope flags (`--cli`, `--global`, `--project`) |
| `hardware` | `config hardware` | Becomes a subcommand of config. Existing `hardwareCommand` handler unchanged |
| `diagnostics` | `info --diagnostics` | Becomes a flag on info. Existing `diagnosticsCommand` handler unchanged |
| `replay` | `plan replay` | Moves under plan subcommand group. Existing `replayCommand` handler unchanged |

### Commands Being Removed (Beta)

| Command | Reason |
|---------|--------|
| `plan lint` | Defer post-beta — not core workflow |
| `plan test` | Defer post-beta — not core workflow |
| `plan compare` (top-level `--compare` flag) | Redundant with `plan diff` |

### New Commands (Stubs)

| Command | Purpose |
|---------|---------|
| `run` | Training runs, pipeline executions, job management |
| `push` | Push artifacts to registry (models, images, builds, runtimes) |
| `pull` | Pull artifacts from registry |
| `sync` | Bidirectional state sync with conflict resolution |

---

## Detailed Migration: `config` (Merging `settings`)

### Before

```
cirron config [options]      # CLI config only (API URL, timeout, retries)
cirron settings [options]    # User preferences and project behavior
```

### After

```
cirron config [options]
  Scopes:
    --cli                    # CLI configuration (API URL, timeout, retries)
    --global                 # User preferences across all projects
    --project                # Project-specific settings (default scope for --set)

  Operations:
    -l, --list               # List all config (across all scopes, or filtered by scope flag)
    -g, --get <key>          # Get value (walks resolution chain: project > global > cli)
    -s, --set <key=value>    # Set value (project scope default, override with --cli/--global)
    -d, --delete <key>       # Delete key (requires scope flag)
    --reset                  # Reset scope to defaults (requires scope flag)
    -e, --edit               # Interactive editor (scope selector if no scope flag passed)
    --explain <key>          # Show resolution chain for a key
    --export <file>          # Export config to file (requires scope flag)
    --import <file>          # Import config from file (requires scope flag)

  Subcommands:
    hardware [options]       # Hardware config (detect, configure, profiles)
```

### Handler Logic

- The existing `configCommand` handler covers `--list`, `--get`, `--set`, `--delete`, `--reset` for CLI scope
- The existing `settingsCommand` handler covers everything else (global, project, edit, export, import, explain, templates)
- Migration approach: Create a new unified `configCommand` that checks scope flags and delegates to the appropriate existing logic
  - No scope flag + `--list` → show all scopes
  - `--cli` + any operation → delegate to existing `configCommand` logic
  - `--global` or `--project` + any operation → delegate to existing `settingsCommand` logic
  - `--get` without scope → walk resolution chain (project > global > cli)
  - `--set` without scope → default to project scope
  - `-e, --edit` without scope → show scope selector prompt first
  - `--explain` → show full chain (reuse settings `--explain` logic)

### Storage (Unchanged)

- CLI config: `~/.cirron/config.json`
- Global settings: `~/.cirron/settings.json`
- Project settings: `./cirron.json` or `.cirron/settings.json`

---

## Detailed Migration: `config hardware`

### Before

```
cirron hardware [options]
```

### After

```
cirron config hardware [options]
  --detect                   # Detect current device hardware
  --configure                # Configure hardware interactively
  --list                     # List available hardware profiles
  --profile <name>           # Use specific hardware profile
  --save [filename]          # Save hardware config to file
  --from <path>              # Load hardware config from file
  --current                  # Use current device specifications
  --json                     # Output in JSON format
  --verbose                  # Show detailed information
```

### Handler Logic

- Wire `config hardware` directly to existing `hardwareCommand` — no changes to handler

---

## Detailed Migration: `info --diagnostics`

### Before

```
cirron info [options]
cirron diagnostics [options]
```

### After

```
cirron info [options]
  --update <type>            # Update specific information (metadata)
  --dry-run                  # Preview changes without applying them
  --diagnostics              # Run diagnostic checks on config and connectivity
  --hardware                 # Show hardware info (shortcut for config hardware --detect)
  --json                     # Output in JSON format
  --detailed                 # Show detailed information
```

### Handler Logic

- When `--diagnostics` is passed, delegate to existing `diagnosticsCommand`
- When `--hardware` is passed, delegate to existing `hardwareCommand` with `--detect` flag
- Otherwise, run existing `infoCommand`

---

## Detailed Migration: `plan` (Adding `replay`, Removing `lint`/`test`/`compare`)

### Before

```
cirron plan [options]
  --compare [planA] [planB]  # Compare two saved plans
  compile [options]
  build [options]
  lint [options]             # REMOVING
  test [options]             # REMOVING
  diff <planA> <planB>
  save [type]

cirron replay [options]      # MOVING HERE
```

### After

```
cirron plan [options]
  compile [options]          # Preview model compilation
  build [options]            # Preview build artifacts and resource usage
  diff <planA> <planB>       # Compare two plan files
  save [type]                # Save plans to disk
  replay [options]           # Execute saved plan from file
```

### Handler Logic

- Remove `planLintCommand`, `planTestCommand`, `planCompareCommand` from plan registration
- Move `replayCommand` under `plan replay` with same options:
  - `--plan <file>` (required)
  - `--validate`
  - `--dry-run`
  - `--verbose`
  - `--force`
- Remove top-level `--compare` action from plan command
- All existing handlers unchanged

---

## New Command: `run`

### Command Structure

```
cirron run <action> [options]
  pipeline [options]         # Trigger pipeline run
  job [options]              # Execute single-task job
  inference [options]        # Trigger batch inference
  sweep [options]            # Trigger hyperparameter sweep
  list [options]             # List all runs/jobs
  status <runId>             # Get run status
  cancel <runId>             # Cancel a running job
  logs <runId>               # Stream run logs
```

### Subcommand Signatures

```
cirron run pipeline <name/id>
  -c, --config <file>        # Pipeline config file (YAML/JSON)
  --gpu <type>               # GPU type override
  --priority <level>         # Job priority (low, normal, high, critical)
  --tag <tags>               # Comma-separated run tags
  --dry-run                  # Show what would execute without running
  --async                    # Don't wait for completion (default: true)
  --watch                    # Stream output and wait for completion

cirron run inference <deployment>
  -i, --input <path>         # Input data path (local or S3)
  -o, --output <path>        # Output path
  --model <name>             # Model name/version to use
  --batch-size <n>           # Batch size override
  --async                    # Don't wait for completion
  --watch                    # Stream output

cirron run sweep
  -c, --config <file>        # Sweep config file
  --trials <n>               # Number of trials
  --parallel <n>             # Max parallel trials
  --strategy <type>          # Search strategy (grid, random, bayesian)
  --async                    # Don't wait for completion
  --watch                    # Stream output

cirron run list
  --status <status>          # Filter by status (running, completed, failed, cancelled)
  --last <n>                 # Show last N runs
  --pipeline <name>          # Filter by pipeline
  --json                     # Output in JSON format

cirron run status <runId>
  --json                     # Output in JSON format
  --watch                    # Poll for updates

cirron run cancel <runId>
  --force                    # Force cancel without confirmation

cirron run logs <runId>
  -f, --follow               # Follow log output
  -n, --lines <number>       # Number of lines to show
```

### Handler Logic

- New file: `commands/run.ts`
- All subcommands are stubs for beta — implement `train` and `list` first, others follow
- `run list` should also be accessible via `cirron list runs`

---

## New Command: `push`

### Command Structure

```
cirron push [resource] [options]
  [resource]                 # What to push: model, image, build, runtime (default: auto-detect)
  -t, --tag <tag>            # Version tag (default: auto from config/git SHA)
  -m, --message <message>    # Push message/description
  --registry <url>           # Override registry URL
  --force                    # Overwrite existing version
  --dry-run                  # Show what would be pushed
  --json                     # Output in JSON format
```

### Handler Logic

- New file: `commands/push.ts`
- Auto-detect resource type from project context if not specified
- Versioning: semantic version from config, falls back to git SHA, falls back to timestamp
- Push to Cirron registry API
- Show progress with size, upload speed

---

## New Command: `pull`

### Command Structure

```
cirron pull <resource> [name] [options]
  <resource>                 # What to pull: model, image, build, runtime
  [name]                     # Resource name (e.g., sentiment-classifier)
  -t, --tag <tag>            # Version tag (default: latest)
  -o, --output <path>        # Output directory
  --registry <url>           # Override registry URL
  --force                    # Overwrite local files
  --json                     # Output in JSON format
```

### Handler Logic

- New file: `commands/pull.ts`
- Downloads from Cirron registry API
- Validates checksums after download
- Places artifacts in standard project locations based on resource type

---

## New Command: `sync`

### Command Structure

```
cirron sync [path] [options]
  [path]                     # Path to sync (default: entire project)
  --dry-run                  # Show what would change without writing
  --push-only                # Only push local changes
  --pull-only                # Only pull remote changes
  --conflicts <strategy>     # Conflict resolution: keep-both, local-wins, remote-wins, prompt (default: prompt)
  --force                    # Skip conflict resolution, use --push-only or --pull-only behavior
  --exclude <patterns>       # Comma-separated glob patterns to exclude
  --verbose                  # Show detailed sync information
  --json                     # Output in JSON format
```

### Handler Logic

- New file: `commands/sync.ts`
- Compute checksums on both ends
- Compare timestamps, versions, metadata
- Categorize: local-only, remote-only, changed-locally, changed-remotely
- Default to `--dry-run` on first sync (safety)
- Conflict handling per existing spec:
  - Backups on conflict
  - `.local` / `.remote` suffixes when keeping both
  - File-level resolution: skip, overwrite, keep-both, auto-rename

---

## Updated `list` Command

### Before

```
cirron list <resource>       # deployments, builds, models, images, registry
```

### After

```
cirron list <resource>       # deployments, builds, models, images, registry, runs, pipelines
```

### Handler Logic

- Add `runs` resource type → delegates to same logic as `cirron run list`
- Add `pipelines` resource type → lists available pipeline definitions

---

## Final Beta Command Tree

```
cirron
│
├── auth
│   ├── login                # Login to Cirron
│   ├── logout               # Logout
│   ├── status               # Show auth status
│   └── refresh              # Refresh token
│
├── init [name]              # Initialize new project
│
├── compile [options]        # Compile/validate model locally
│   ├── -a, --arch
│   ├── --index
│   ├── --validate
│   ├── --strict
│   └── -i, --interactive
│
├── build [options]          # Build container image
│   ├── -e, --env
│   ├── -w, --watch
│   ├── -t, --tag
│   ├── --clean
│   ├── --push               # Auto-push after build
│   ├── --analyze
│   ├── -a, --arch
│   ├── --index
│   ├── --validate
│   ├── --strict
│   ├── -f, --force
│   └── -i, --interactive
│
├── test [options]           # Run tests
│   ├── --env, --build, --requirements, --unit, --lint
│   ├── --model, --data, --inference
│   ├── -v, --val / -p, --path
│   ├── -e, --endpoint
│   ├── --pipeline
│   ├── -w, --watch
│   ├── --json, --strict
│   └── -i, --interactive
│
├── lint [options]           # Linting and code quality
│   ├── --config, --structure, --dependencies, --code, --all
│   ├── --fix
│   ├── --verbose, --json, --strict
│
├── run                      # Training runs and job management [NEW]
│   ├── train [options]
│   ├── inference [options]
│   ├── sweep [options]
│   ├── list [options]
│   ├── status <runId>
│   ├── cancel <runId>
│   └── logs <runId>
│
├── push [resource]          # Push to registry [NEW]
├── pull <resource> [name]   # Pull from registry [NEW]
├── sync [path]              # Bidirectional sync [NEW]
│
├── deploy [options]         # Deploy project
│   ├── -e, --env
│   ├── -f, --force
│   ├── --no-build
│   ├── --rollback
│   └── -m, --message
│
├── plan                     # Plan and compliance
│   ├── compile [options]
│   ├── build [options]
│   ├── diff <planA> <planB>
│   ├── save [type]
│   └── replay [options]     # Moved from top-level
│
├── list <resource>          # List resources (+ runs, pipelines)
│
├── info [options]           # Model info + diagnostics
│   ├── --update <type>
│   ├── --dry-run
│   ├── --diagnostics        # Absorbed from diagnostics command
│   ├── --hardware           # Quick hardware info
│   ├── --json
│   └── --detailed
│
├── config [options]         # Unified config (absorbed settings)
│   ├── --cli / --global / --project   # Scope flags
│   ├── -l, --list
│   ├── -g, --get <key>
│   ├── -s, --set <key=value>
│   ├── -d, --delete <key>
│   ├── --reset
│   ├── -e, --edit           # Interactive editor
│   ├── --explain <key>      # Resolution chain
│   ├── --export / --import <file>
│   └── hardware [options]   # Absorbed from hardware command
│
├── env                      # Environment variables
│   ├── list
│   ├── set <key> <value>
│   └── delete <key>
│
├── status [options]         # Project status
└── logs [options]           # Deployment logs
```

---

## Migration Checklist

### Phase 1: Structural Changes (No New Logic)

- [x] Create unified `config` command that delegates to existing `configCommand` and `settingsCommand` based on scope
- [x] Add `hardware` as subcommand of `config` → wire to existing `hardwareCommand`
- [x] Add `--diagnostics` flag to `info` → wire to existing `diagnosticsCommand`
- [x] Add `--hardware` flag to `info` → wire to existing `hardwareCommand` with `--detect`
- [x] Move `replay` under `plan replay` → wire to existing `replayCommand`
- [x] Remove `plan lint`, `plan test`, `plan --compare` from registration
- [x] Remove top-level `settings`, `hardware`, `diagnostics`, `replay` commands
- [x] Add `runs` and `pipelines` to `list` resource types
- [x] Update `--help` descriptions for all modified commands

#### Phase 1 Implementation Notes

Completed in branch `CIRRON-608`. Implementation plan: `.claude/plans/indexed-twirling-bubble.md`

Key implementation details:
- `config.ts` updated with scope-based routing (`--cli`, `--global`, `--project`) that delegates to existing `cliConfigHandler` and `settingsCommand`
- `hardware` wired as subcommand of `config` in `index.ts`
- `info` command action handler delegates to `diagnosticsCommand` when `--diagnostics` passed, `hardwareCommand` when `--hardware` passed
- `replay` moved under `plan replay` in `index.ts`
- `plan lint`, `plan test`, `plan --compare` removed from command registration
- Top-level `settings`, `hardware`, `diagnostics`, `replay` commands removed from `index.ts`
- `runs` and `pipelines` added to `list` with stub handlers

### Phase 2: New Command Stubs

- [x] Create `commands/run.ts` with subcommand structure (stubs returning "not yet implemented")
- [x] Create `commands/push.ts` (stub)
- [x] Create `commands/pull.ts` (stub)
- [x] Create `commands/sync.ts` (stub)
- [x] Wire all new commands into `index.ts`

### Phase 3: Implement New Commands

- [ ] `run train` — trigger training pipeline via API
- [ ] `run list` — list runs from API
- [ ] `run status` — get run status
- [ ] `run cancel` — cancel running job
- [ ] `run logs` — stream run logs
- [ ] `push` — push artifacts to registry
- [ ] `pull` — pull artifacts from registry
- [ ] `sync` — bidirectional sync with conflict resolution
- [ ] `run inference` — batch inference
- [ ] `run sweep` — hyperparameter sweep

### Phase 4: Cleanup

- [ ] Remove old command files if fully absorbed (settings.ts, hardware.ts, diagnostics.ts)
  - OR keep them as internal modules and just remove the top-level CLI registration
- [ ] Update any docs/README referencing old command names
- [ ] Update any CI scripts referencing old commands
- [ ] Add deprecation warnings if users try old command names (optional, nice UX)

---

## Notes

- **No handler logic changes in Phase 1.** Every existing command handler stays identical. We're only changing how Commander.js wires them.
- **Deprecation aliases** (optional): For a few releases, keep `cirron settings` and `cirron hardware` as hidden aliases that print a deprecation warning and delegate to the new location. Prevents breaking anyone's scripts.
- **The `connect` command** was mentioned but isn't specced here. If it's for connecting to a remote cluster or endpoint, it fits naturally as either `config --set cluster <url>` or `auth connect <cluster>`. Decide scope before implementing.
- **`promote`** is deferred post-beta. When implemented, it should be top-level: `cirron promote staging production`.
