# CLI to Main App Integration - Gap Analysis

## UPDATE 1/6

### API Implementation Status - COMPLETE

All CLI API endpoints have been implemented in `apps/app/app/api/cli/`. The endpoints are live and tested.

### Implemented Endpoints

#### Auth
| Route | Methods | Status |
|-------|---------|--------|
| `/api/cli/auth/device` | POST | Existing |
| `/api/cli/auth/token` | POST | Existing |
| `/api/cli/auth/refresh` | POST | Fixed (snake_case response) |
| `/api/cli/auth/authorize` | GET, POST | Existing |

#### Models
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/cli/models` | GET, POST | List/create models |
| `/api/cli/models/[id]` | GET, DELETE | Get/delete model (accepts ID or name) |
| `/api/cli/models/[id]/deployments` | GET | List model deployments |
| `/api/cli/models/[id]/rollback` | POST | Rollback to previous deployment |
| `/api/cli/models/[id]/logs/[env]` | GET | Get deployment logs |

#### Deployments
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/cli/deployments` | GET, POST | List/create deployments |
| `/api/cli/deployments/[id]` | GET | Get deployment status |
| `/api/cli/deployments/[id]/start` | POST | Start deployment |
| `/api/cli/deployments/endpoints` | GET | List serving endpoints (ModelEndpoint) |
| `/api/cli/deployments/versions` | GET | List deployment executions |

#### Builds
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/cli/builds` | GET, POST | List/report builds |
| `/api/cli/builds/[id]` | GET | Get build details |

#### Pipelines (replaces training-runs)
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/cli/pipelines` | GET, POST | List/create pipelines |
| `/api/cli/pipelines/[id]` | GET, DELETE | Get/delete pipeline |
| `/api/cli/pipelines/[id]/executions` | GET, POST | List/trigger executions |

#### Images
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/cli/images/models` | GET | List model images |

### Structure Changes from Original Plan

1. **training-runs → pipelines**: Training runs are now under `/api/cli/pipelines/[id]/executions`
2. **serving moved under deployments**: `/api/cli/serving/*` → `/api/cli/deployments/endpoints` and `/api/cli/deployments/versions`
3. **model-images renamed**: `/api/cli/model-images` → `/api/cli/images/models` (for future runtime image support)

### PR #321 Fixes Implemented

| Fix | File | Description |
|-----|------|-------------|
| #2 | `models/[id]/route.ts` | Check for active deployments before model deletion (409 Conflict) |
| #4 | `models/[id]/rollback/route.ts` | Wrapped rollback in `db.$transaction()` for atomicity |
| #5 | `pipelines/[id]/route.ts` | Check for active executions before pipeline deletion (409 Conflict) |
| #6 | `auth/refresh/route.ts` | Explicit null check for `claims.exp` before `getTimeRemaining()` |
| #8 | `pipelines/route.ts` | Validate `body.definition` is object or valid JSON string |
| #9 | `pipelines/[id]/executions/route.ts` | Wrapped execution creation in `db.$transaction()` |
| #12 | `deployments/[id]/route.ts` | Changed `ROLLED_BACK` status mapping from "failed" to "rolled_back" |

### TODOs Added (Future Work)

- **Token Revocation** (PR #1): Need token blacklist table to invalidate old refresh tokens during rotation
- **Error Type Handling** (PR #10): `validateCLIToken` should throw specific error types instead of string matching
- **DB Field Typo** (PR #13): `hourlyCoSusd` → `hourlyCostUsd` requires database migration
- **Remove "Project" references**: need to remove any project references in the CLI. No longer implementing that in the app

### Terminology Clarification

- CLI "project" (cirron.json) = App "Model" entity
- The API accepts both `id` and `name` parameters for model lookups
- Example: `GET /api/cli/models?name=my-model` or `GET /api/cli/models/[id]` both work

### CLI Path Updates Required

Update `src/utils/api.ts` to use new endpoint paths:

| Current Path | New Path | Method |
|--------------|----------|--------|
| `/projects` | `/api/cli/models` | `createProject()` |
| `/projects/${name}/deployments` | `/api/cli/models/${id}/deployments` | `getDeployments()` |
| `/projects/${name}/rollback` | `/api/cli/models/${id}/rollback` | `rollbackDeployment()` |
| `/projects/${name}/logs/${env}` | `/api/cli/models/${id}/logs/${env}` | `getLogs()` |
| `/deployments` | `/api/cli/deployments` | `createDeployment()` |
| `/deployments/${id}` | `/api/cli/deployments/${id}` | `getDeployment()` |
| `/deployments/${id}/start` | `/api/cli/deployments/${id}/start` | `startDeployment()` |
| `/builds` | `/api/cli/builds` | `reportBuild()` |
| `/api/builds` | `/api/cli/builds` | `getBuilds()` |
| `/api/serving/endpoints` | `/api/cli/deployments/endpoints` | `getModelInstances()` |
| `/api/serving/versions` | `/api/cli/deployments/versions` | `getDeploymentExecutions()` |
| `/api/model-images` | `/api/cli/images/models` | `getModelImages()` |
| `/api/training-runs` | `/api/cli/pipelines` | - |
| `/api/training-runs/${id}` | `/api/cli/pipelines/${id}/executions` | - |

**Note:** Model endpoints accept both `id` and `name` parameters. The API will first try to find by ID, then by name.

### Auth Refresh Response Format (FIXED)

The API refresh endpoint now returns snake_case keys matching CLI expectations:

```typescript
// Response format:
{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
}
```

No changes needed to `refreshToken()` in `api.ts` - it already expects this format.

### Auth Polling Error Handling

Update `src/commands/auth.ts` to handle HTTP 400 responses with specific error codes:

```typescript
// In pollDeviceAuthorization(), handle these error responses:
switch (response.error) {
  case 'authorization_pending':
    // Continue polling - user hasn't authorized yet
    break;
  case 'expired_token':
    // Stop polling, show: "Device code has expired. Please try again."
    break;
  case 'invalid_request':
    // Stop polling, show: response.errorDescription
    break;
}
```

### apps/api Enhancement Opportunities (Future)

The dedicated API app (`apps/api/` on port 3002) could be enhanced for CLI-specific operations:

1. **CLI Webhooks** (`/webhooks/cli`):
   - Build status callbacks from CI/CD
   - Training completion notifications
   - Deployment health check callbacks

2. **CLI Background Jobs** (cron):
   - Expired CLI token cleanup
   - Stale build/deployment cleanup
   - CLI telemetry aggregation

3. **CLI Registry** (`/registry`):
   - Container image metadata
   - Artifact management
   - Model version tracking

---

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
