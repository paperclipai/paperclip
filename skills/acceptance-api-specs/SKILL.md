---
name: acceptance-api-specs
description: Use when authoring acceptance specs for HTTP API deliverables. One JSON spec file per issue at tests/<DLD-XXXX>.api.spec.json, consumed by the Paperclip verification worker's api-runner. Backend QA Agent owns this skill for every api deliverable_type issue.
---

# API Acceptance Specs

## When to use

You're the Backend QA Agent assigned an issue whose `deliverable_type` is `api`. Your job is to write a JSON spec file at `skills/acceptance-api-specs/tests/<DLD-XXXX>.api.spec.json` **before the engineer starts**. The verification worker reads this file, makes the HTTP request, and checks the response against the assertions you specify.

## Spec format

```json
{
  "method": "POST",
  "url": "https://paperclip.example.com/api/issues",
  "expectedStatus": [200, 201],
  "headers": {
    "authorization": "Bearer ..."
  },
  "body": {
    "title": "test issue",
    "priority": "normal"
  },
  "expectedResponseSchema": {
    "type": "object",
    "required": ["id", "identifier", "createdAt"],
    "properties": {
      "id": { "type": "string", "format": "uuid" },
      "identifier": { "type": "string", "pattern": "^[A-Z]+-[0-9]+$" },
      "createdAt": { "type": "string", "format": "date-time" }
    }
  },
  "notBody": ["ECONNREFUSED", "Internal server error"]
}
```

### Fields

| Field | Type | Required? | Purpose |
|---|---|---|---|
| `method` | string | yes | HTTP verb: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `url` | string | yes | Full https URL; must reference the deliverable target |
| `expectedStatus` | number or number[] | yes | Accepted HTTP status codes — at least one must be specified |
| `headers` | object | no | Request headers. Do NOT hardcode secrets — reference env vars in your narrative or open a board issue |
| `body` | any | no | Request body (JSON-serialized if set) |
| `expectedResponseSchema` | JSON Schema | no | ajv-compatible schema the response MUST conform to. If omitted, only `expectedStatus` is checked. |
| `notBody` | string[] | no | Substrings that must NOT appear in the response body — use for negative checks (error messages leaking, legacy data formats persisting, etc.) |

## Quality rules

Every spec MUST satisfy all of these or the `spec_quality` gate (Phase 4) will reject it:

1. **At least 3 assertions.** The combination of `expectedStatus`, `expectedResponseSchema` fields, and `notBody` entries must total ≥ 3. A spec with just `expectedStatus: 200` fails — any endpoint can return 200 for the wrong reason.

2. **At least one negative check.** Either a `notBody` entry OR a schema that rejects obviously-wrong shapes. The purpose is to catch the endpoint returning a 200 with a completely wrong body (e.g. an error envelope dressed up as success).

3. **Literal reference to the deliverable target.** The `url` field must contain the endpoint path from the issue's `verification_target`. Grep check.

4. **No trivially-satisfied schemas.** `{ "type": "object" }` with no `required` fields and no property constraints is rejected. The schema must actually constrain something.

## What this runner does NOT do

- **No state setup.** The runner does not seed test data, create users, or authenticate via Clerk. If your endpoint requires auth, either (a) the endpoint has a public test path, (b) the board configures a service token that the worker can inject, or (c) you're testing the wrong endpoint. Phase 4 will add auth context support.
- **No cleanup.** If your POST creates a row, the row persists. Spec authors should prefer idempotent `GET` endpoints when possible, or use `expectedStatus: [200, 409]` to tolerate re-runs.
- **No parallel requests.** One spec, one request, one assertion pass. For multi-step flows (create → read → delete), open an issue to split into three sub-issues.
- **No load testing, no performance assertion.** Separate concern. Phase 6+ roadmap.

## Reference example

```json
{
  "method": "GET",
  "url": "https://paperclip.example.com/api/health",
  "expectedStatus": 200,
  "expectedResponseSchema": {
    "type": "object",
    "required": ["status", "version", "deploymentMode"],
    "properties": {
      "status": { "type": "string", "enum": ["ok"] },
      "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
      "deploymentMode": { "type": "string", "enum": ["local_trusted", "authenticated"] }
    }
  },
  "notBody": ["ECONNREFUSED", "database not available"]
}
```

This spec has 5 assertions (status 200, 3 required-field schemas with type+pattern/enum, 2 notBody entries) and references the `/api/health` target.

## When verification fails

Do not loosen the spec to make the PR pass. See the root AGENTS.md for your response protocol — same rules as URL specs: spec is wrong → open a sub-issue; code is wrong → push back on the engineer.
