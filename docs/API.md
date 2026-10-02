# API v1

Base URL for a default local installation: `http://127.0.0.1:8766`.
`/openapi.json` is the machine-readable contract. `/docs` is a local help page.
Every `/api/v1` request needs `Authorization: Bearer <key>`.

## Create an example project

PowerShell 7, using the generated local key without printing it:

```powershell
$konturKey = (Get-Content -LiteralPath ./data/api-token.txt -Raw).Trim()
$headers = @{ Authorization = "Bearer $konturKey" }
$body = Get-Content -LiteralPath ./examples/general-project.json -Raw
Invoke-RestMethod http://127.0.0.1:8766/api/v1/projects -Method Post `
  -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

Use a fresh installation, or choose a new ID if `community-garden` already exists. A duplicate ID returns 409; it does not overwrite the project. `type` is `software` or `general`.

## Change one gate

Read the project first, retain the returned `revision`, then send it in `If-Match`:

```powershell
$base = 'http://127.0.0.1:8766/api/v1/projects/community-garden'
$current = Invoke-RestMethod $base -Headers $headers
$writeHeaders = @{ Authorization = "Bearer $konturKey"; 'If-Match' = [string]$current.revision }
$patch = @{ status = 'done'; note = 'Accepted after checking the prepared beds.' }
Invoke-RestMethod "$base/gates/prepare" -Method Patch -Headers $writeHeaders `
  -ContentType 'application/json; charset=utf-8' -Body ($patch | ConvertTo-Json)
```

Only report `done` when acceptance is actually authorized in your workflow. This API records the statement; it cannot prove it. On 409, reread and reconcile the latest state. Never retry with a guessed or artificially increased revision.

## Routes

| Method and route | Meaning |
| --- | --- |
| `GET /health` | Process/database check; does not check observed projects |
| `GET /api/v1/types` | Supported project types |
| `GET /api/v1/projects` | Projects and derived statistics |
| `POST /api/v1/projects` | Create with `id`, `name`, `type`, optional roadmap |
| `GET /api/v1/projects/{id}` | Current snapshot and revision |
| `PUT /api/v1/projects/{id}` | Replace full body; requires current project `If-Match` |
| `PATCH /api/v1/projects/{id}/gates/{gateId}` | Change status/note and optional evidence/dates; requires project `If-Match` |
| `GET /api/v1/projects/{id}/history` | Last 100 project revisions |
| `GET /api/v1/projects/{id}/history/{revision}` | Historical project body |
| `GET /api/v1/projects/{id}/git` | Separate Git resource; 404 if absent |
| `PUT /api/v1/projects/{id}/git` | Write Git snapshot; requires Git `If-Match`, initially `0` |

A project PUT body consists of `name`, `type`, `description`, `archived`, `roadmap`. Do not include response fields `id`, `stats`, `revision` or outer `updatedAt`. Roadmap `updatedAt` is a separate supplied source timestamp. A gate PATCH requires `status` and `note`; optional fields are listed in OpenAPI.

## Roadmap semantics

Statuses: `planned`, `active`, `blocked`, `done`, `deferred`, `frozen`. Stable API names do not change with interface language.

- Blocks are `sections`; milestones are `gates`. IDs must be unique and may use ASCII letters, digits, `_`, `-`.
- Section dependencies point to sections; gate dependencies point to gates. Cycles and unknown references are rejected.
- At most one active gate is allowed, and it must match `currentGateId`. The next gate must be planned. Neither may have unresolved prerequisites.
- `activeGateIds` explicitly defines the counted plan. An empty plan has no percentage.
- `done` gates must have completed prerequisites. Paused blocks can block their children.
- `startedAt` and `publishedAt` accept `YYYY-MM-DD` or ISO 8601 with timezone. Publication cannot precede start. `completedAt` denotes reported acceptance and is distinct from publication.
- An inferred timeline start is marked in the UI and never written back into the API.

The API bounds actual request bodies to 2 MB, projects to 500 gates and Git snapshots to 500 refs / 2,000 commits. Source and evidence paths are text references; Kontur does not fetch or execute them.
