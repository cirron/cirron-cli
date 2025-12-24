# CLI to Main App Integration - Gap Analysis

## Current State

**Authentication**: Working (90%)
- Device flow implemented in both CLI and app
- Minor response format mismatch in token refresh

**CLI API Client**: `src/utils/api.ts`
- Fully built, ready to call endpoints
- Uses JWT tokens from device flow auth

---

## API Routes to Create

All routes should go under `apps/app/app/api/cli/` in the main app and use CLI JWT auth (not Clerk).

### Auth Fixes (Existing Routes)

| Route | Issue |
|-------|-------|
| `app/api/cli/auth/refresh/route.ts` | Returns `accessToken` but CLI expects `access_token`. Add `refreshToken` to response. |

### Model Management (NEW)

| Route | Methods | CLI Method | Purpose |
|-------|---------|------------|---------|
| `/api/cli/models` | POST, GET | `createProject()` | Register model from cirron.json |
| `/api/cli/models/[id]` | GET, DELETE | - | Get/delete model |
| `/api/cli/models/[id]/deployments` | GET | `getDeployments()` | List model's deployments |
| `/api/cli/models/[id]/rollback` | POST | `rollbackDeployment()` | Rollback to previous |
| `/api/cli/models/[id]/logs/[env]` | GET | `getLogs()` | Get deployment logs |

### Deployments (NEW)

| Route | Methods | CLI Method | Purpose |
|-------|---------|------------|---------|
| `/api/cli/deployments` | POST | `createDeployment()` | Create deployment |
| `/api/cli/deployments/[id]` | GET | `getDeployment()` | Get deployment status |
| `/api/cli/deployments/[id]/start` | POST | `startDeployment()` | Start deployment |
| `/api/cli/deployments/[id]/files` | POST | `uploadFile()` | Upload files (FormData) |

### Builds & Training (NEW)

| Route | Methods | CLI Method | Purpose |
|-------|---------|------------|---------|
| `/api/cli/builds` | GET, POST | `getBuilds()`, `reportBuild()` | List/create BuildHistory |
| `/api/cli/builds/[id]` | GET | - | Get build details |
| `/api/cli/training-runs` | GET, POST | - | List/create TrainingRun |
| `/api/cli/training-runs/[id]` | GET | - | Get training status |

### Serving & Monitoring (NEW)

| Route | Methods | CLI Method | Purpose |
|-------|---------|------------|---------|
| `/api/cli/serving/endpoints` | GET | `getModelInstances()` | List ModelEndpoint |
| `/api/cli/serving/versions` | GET | `getDeploymentExecutions()` | List versions |
| `/api/cli/model-images` | GET | `getModelImages()` | List ModelImage |

---

## CLI Changes Needed

| File | Change |
|------|--------|
| `src/utils/api.ts` | Change `/projects` → `/api/cli/models` |
| `src/utils/api.ts` | Fix `refreshToken()` to handle current response format |
| `src/commands/auth.ts` | Handle HTTP 400 error responses from polling |

---

## Data Model Mapping

CLI "project" (cirron.json) → App **Model** entity

| CLI Field | Model Field |
|-----------|-------------|
| `name` | `Model.name` |
| `framework` | `Model.framework` |
| `modelType` | `Model.type` |
| `environments.production` | `Deployment` with `env: "production"` |

---

## Deferred

- Environment variables (until Environments entity is built)
- `/api/cli/registry/artifacts` (lower priority)

---

## Priority Order

1. Fix auth refresh response format
2. Create `/api/cli/models` (register model)
3. Create `/api/cli/deployments/*` (deploy workflow)
4. Create `/api/cli/builds/*` (build reporting)
5. Create serving/monitoring endpoints
