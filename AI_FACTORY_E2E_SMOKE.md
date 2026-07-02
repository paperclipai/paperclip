# AI Factory E2E Smoke Test

Proves the minimum AI-factory control loop end to end:

```
webhook intake → backlog issue (required deliverable + cost cap)
→ close blocked without deliverable
→ approved/merged work product → close passes
→ agent cannot waive the requirement
→ cost cap blocks further work once spend exceeds it
```

## Run it

Prerequisites: local dev stack running (`pnpm dev`), at least one signed-up
user in the instance.

```bash
cd server
pnpm exec tsx scripts/ai-factory-smoke.mjs
```

Expected output: `PASS` on every line, exit code 0. The script cleans up
after itself (revokes its temporary board API key, hides its smoke issues).

Overrides: `SMOKE_BASE_URL` (default `http://localhost:3100`),
`SMOKE_DB_URL` (default local embedded Postgres).

## What each step proves

| Step | Assertion | Enforced by |
|---|---|---|
| 1 | `POST /api/webhooks/intake/:companyId` with a GitHub issue payload returns 201 over real HTTP with a real board API key | [webhook-intake.ts](server/src/routes/webhook-intake.ts) |
| 2 | Created issue is `backlog` with `requiredWorkProductType: "pull_request"` (GitHub payloads default to requiring a PR; generic payloads only get what they ask for) | intake mapper |
| 2b | Redelivering the same webhook returns the existing issue, `deduplicated: true` | partial unique index on `(company_id, origin_kind, origin_id)` |
| 3 | Moving the issue to `done` without a matching work product throws 422 | `issueService.update` |
| 4–5 | After attaching a `pull_request` work product with status `merged`, the close succeeds | `requiredWorkProductBlockReason` |
| 6 | An agent actor clearing `requiredWorkProductType` is rejected with 403; only humans waive | `requiredWorkProductChangeBlockReason` |
| 7 | With `maxCostCents: 5` and 10¢ of `cost_events` recorded, `budgets.getInvocationBlock` blocks the next run with scope `issue` — the same gate every heartbeat run passes through | [budgets.ts](server/src/services/budgets.ts) |

## Hosted instance variant

Steps 1–2 can be verified against a hosted deployment with a real board API
key:

```bash
curl -X POST "https://<host>/api/webhooks/intake/<companyId>" \
  -H "Authorization: Bearer <board-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"issue": {"title": "Test", "body": "...", "html_url": "https://github.com/org/repo/issues/1"}}'
```

Steps 3–7 exercise service-layer enforcement, which is identical code on any
deployment.

## Scope notes

Steps 3–7 run at the service layer (the single choke point all routes,
plugins, and the heartbeat call); step 1 runs over real HTTP including auth.
No UI, no memory store, no sandbox — per the baseline verdict in
[AI_FACTORY_BASELINE.md](AI_FACTORY_BASELINE.md).
