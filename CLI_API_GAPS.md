# CLI to Main App Integration - Gap Analysis

## UPDATE 1/7

### API Implementation Status - COMPLETE

All CLI API endpoints have been implemented in `apps/app/app/api/cli/`. The endpoints are live and tested.

### CLI API Methods (src/utils/api.ts)

| CLI Method | Endpoint | HTTP Method | Purpose |
|------------|----------|-------------|---------|
| `verifyAuth()` | `/api/cli/status` | GET | Verify authentication status |
| `requestDeviceCode()` | `/api/cli/auth/device` | POST | Request device code for auth |
| `pollDeviceAuthorization()` | `/api/cli/auth/device` | GET | Poll for device authorization |
| `refreshToken()` | `/api/cli/auth/refresh` | POST | Refresh access token |
| `validateAuth()` | `/api/cli/status` | GET | Validate auth token |
| `createProject()` | `/api/cli/models` | POST | Register model from CLI |
| `createDeployment()` | `/api/cli/deployments` | POST | Create a deployment |
| `getDeployment()` | `/api/cli/deployments/[id]` | GET | Get deployment status |
| `getDeployments()` | `/api/cli/models/[id]/deployments` | GET | List model deployments |
| `rollbackDeployment()` | `/api/cli/models/[id]/rollback` | POST | Rollback deployment |
| `reportBuild()` | `/api/cli/builds` | POST | Report build status |
| `getLogs()` | `/api/cli/models/[id]/logs/[env]` | GET | Get deployment logs |
| `getEnvironmentVariables()` | `/api/cli/models/[id]/env/[env]` | GET | Get env variables |
| `setEnvironmentVariable()` | `/api/cli/models/[id]/env/[env]` | PUT | Set env variable |
| `deleteEnvironmentVariable()` | `/api/cli/models/[id]/env/[env]/[key]` | DELETE | Delete env variable |
| `getBuilds()` | `/api/cli/builds` | GET | List builds |
| `getModelInstances()` | `/api/cli/models` | GET | List models |
| `getModelImages()` | `/api/cli/images/models` | GET | List model images |
| `getRegistryArtifacts()` | `/api/cli/registry/artifacts` | GET | List registry artifacts |
| `getDeploymentExecutions()` | `/api/cli/deployments/versions` | GET | List deployment versions |

### Implemented API Endpoints

#### Auth
| Route | Methods | Status |
|-------|---------|--------|
| `/api/cli/auth/device` | GET, POST | Existing |
| `/api/cli/auth/token` | POST | Existing |
| `/api/cli/auth/refresh` | POST | Fixed (snake_case response) |
| `/api/cli/auth/authorize` | GET, POST | Existing |
| `/api/cli/status` | GET | Auth verification |

#### Models
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/cli/models` | GET, POST | List/create models |
| `/api/cli/models/[id]` | GET, DELETE | Get/delete model (accepts ID or name) |
| `/api/cli/models/[id]/deployments` | GET | List model deployments |
| `/api/cli/models/[id]/rollback` | POST | Rollback to previous deployment |
| `/api/cli/models/[id]/logs/[env]` | GET | Get deployment logs |
| `/api/cli/models/[id]/env/[env]` | GET, PUT | Get/set environment variables |
| `/api/cli/models/[id]/env/[env]/[key]` | DELETE | Delete environment variable |

#### Deployments
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/cli/deployments` | GET, POST | List/create deployments |
| `/api/cli/deployments/[id]` | GET | Get deployment status |
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

#### Registry
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/cli/registry/artifacts` | GET | List registry artifacts |

### Structure Changes from Original Plan

1. **training-runs → pipelines**: Training runs are now under `/api/cli/pipelines/[id]/executions`
2. **serving moved under deployments**: `/api/cli/serving/*` → `/api/cli/deployments/versions`
3. **model-images renamed**: `/api/cli/model-images` → `/api/cli/images/models` (for future runtime image support)
4. **Removed startDeployment**: Deployment start is now handled server-side on creation
5. **Removed uploadFile**: File uploads are no longer supported via CLI

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

### CLI Path Updates - COMPLETE

All `src/utils/api.ts` endpoints have been updated to use `/api/cli/` paths:

| Method | Endpoint |
|--------|----------|
| `createProject()` | `/api/cli/models` |
| `getDeployments()` | `/api/cli/models/${id}/deployments` |
| `rollbackDeployment()` | `/api/cli/models/${id}/rollback` |
| `getLogs()` | `/api/cli/models/${id}/logs/${env}` |
| `getEnvironmentVariables()` | `/api/cli/models/${id}/env/${env}` |
| `setEnvironmentVariable()` | `/api/cli/models/${id}/env/${env}` |
| `deleteEnvironmentVariable()` | `/api/cli/models/${id}/env/${env}/${key}` |
| `createDeployment()` | `/api/cli/deployments` |
| `getDeployment()` | `/api/cli/deployments/${id}` |
| `getDeploymentExecutions()` | `/api/cli/deployments/versions` |
| `reportBuild()` | `/api/cli/builds` |
| `getBuilds()` | `/api/cli/builds` |
| `getModelInstances()` | `/api/cli/models` |
| `getModelImages()` | `/api/cli/images/models` |
| `getRegistryArtifacts()` | `/api/cli/registry/artifacts` |

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
| `/api/cli/deployments/versions` | GET | `getDeploymentExecutions()` | List deployment versions |

### Builds & Training (NEW)

| Route | Methods | CLI Method | Purpose |
|-------|---------|------------|---------|
| `/api/cli/builds` | GET, POST | `getBuilds()`, `reportBuild()` | List/create BuildHistory |
| `/api/cli/builds/[id]` | GET | - | Get build details |
| `/api/cli/training-runs` | GET, POST | - | List/create TrainingRun |
| `/api/cli/training-runs/[id]` | GET | - | Get training status |

### Images & Registry (NEW)

| Route | Methods | CLI Method | Purpose |
|-------|---------|------------|---------|
| `/api/cli/images/models` | GET | `getModelImages()` | List model images |
| `/api/cli/registry/artifacts` | GET | `getRegistryArtifacts()` | List registry artifacts |

---

## CLI Changes - COMPLETE

All CLI changes have been implemented:

- All API endpoints updated to use `/api/cli/` prefix
- `refreshToken()` works with snake_case response format
- Removed `startDeployment()` method (handled server-side)
- Removed `uploadFile()` method (no longer supported)

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
