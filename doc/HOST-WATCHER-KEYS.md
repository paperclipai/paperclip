# Host watcher API keys

The board issues a `host_watcher` key through `POST /api/agents/:id/keys`. Each
service identity may have exactly one active API key. The service cannot create
or edit its own key or scope. Revoke the old key before issuing a replacement.

Every request must use that API key, match the key's company, and pass both the
HTTP scope guard and the ordinary route checks. A GET returns only the pinned
issue row, without expanded ancestors, related work, or documents. An agent run JWT, even with a
`host_watcher` claim, cannot use these operations. The target UUIDs and
assignee UUIDs are configured by the board at issuance; the example contract
fixtures live in `server/src/__tests__/host-watcher-key-routes.integration.test.ts`.

| `service` | Allowed routes and bodies | Row conditions |
| --- | --- | --- |
| `disk_guard` | `PATCH /api/issues/{issueId}` with exactly `{status:"todo",comment}` | Fixed issue in key's company, fixed assignee, nonterminal status, comment 1–4,000 chars. |
| `pr_923` | `GET /api/issues/{issueId}`; `POST /api/issues/{issueId}/comments` with exactly `{body}`; `PATCH /api/issues/{issueId}` with exactly `{status:"todo",comment}` | Fixed issue and assignee; PATCH only from `blocked`; writes reject `in_review` and terminal issues. Comment 1–16,000 chars. |
| `be_1198`, `fe_1042` | Same read/comment routes; PATCH body has `status:"in_progress"` | Same row conditions as `pr_923`. |
| `fleet_hourly` | `POST /api/issues/{issueId}/comments` with exactly `{body}`; `POST /api/companies/{companyId}/issues` with exactly `{title,description,status:"todo",priority:"high",assigneeAgentId,parentId}` | Comment goes only to the fixed parent in the fixed project. Create requires the fixed parent and assignee, a bounded `[watch][hourly] ` title and description, and no other open work order from that service identity. |

All watcher comments, including comments supplied with `PATCH`, are limited to
12 per service identity and pinned issue in a rolling hour. The check and insert
share an issue-row lock and transaction, so concurrent requests cannot exceed
the limit. Deleted comments still count; rotating the service's one active key
does not reset the window. Excess writes return HTTP 429 without changing the
issue status.
Watcher comments never act as execution review decisions, even if the service
agent is selected as the reviewer and the comment resembles an approval. Such
comments remain subject to the same quota.

The fleet order's `originKind` and `originId` are set by the server to
`host_watcher` and the service agent UUID. A partial unique index prevents two
visible open orders from the same service identity, including concurrent requests and
key rotation. The key can create another order after the prior order is closed or hidden by the board.

Any other method, path, query string, body field, target, assignee or company
is denied. The service cannot call an HTTP proxy or arbitrary control-plane
route. `GET /api/companies/{companyId}/events/ws` is denied at WebSocket
Upgrade for `host_watcher` and other nonstandard API key scopes because its
stream contains events from the whole company and bypasses HTTP middleware.
The separate `cron_service` scope used by the agent watchdog, quota
rewake and frontend deploy services remains a distinct contract.

Run the focused verification with:

```sh
pnpm exec vitest run server/src/__tests__/host-watcher-key-routes.integration.test.ts server/src/__tests__/agent-auth-middleware.test.ts
pnpm exec tsc --noEmit -p server/tsconfig.json
```
