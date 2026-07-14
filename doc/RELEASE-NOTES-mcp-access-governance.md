# Release Notes — MCP Access Governance (v1)

Draft. Source issue: [PAP-10397](/PAP/issues/PAP-10397). Parent: [PAP-10341](/PAP/issues/PAP-10341).

Status: ready for CTO review. Final voice/copy pass pending sign-off.

## TL;DR

Paperclip now governs every MCP tool call an agent makes. Operators install managed connections, define profiles and policies, approve high-risk actions, and read an append-only audit log. Default-deny on unknown tools; quarantine on schema drift; approval required by default for writes; trust rules to lift human-in-the-loop on safe repeats.

## Why this exists

Agents that can call arbitrary MCP tools can also leak data, modify accounts, or run destructive operations the operator never approved. Previous Paperclip releases relied on the agent's runtime trusting whatever MCP server it was pointed at. That is the wrong default for production. MCP Access Governance moves the trust boundary to Paperclip itself: every call is selected, evaluated, audited, and (when needed) gated on a human.

## What's new for operators

- **Tools & Access UI** — A new settings surface (`/<prefix>/companies/<companyId>/tools`) covering Applications, Connections, Profiles, Policies, Runtime slots, Audit, and bundled Examples. Built for board users and CloudOps.
- **Managed connections** — Two transports: `remote_http` (preferred, hosted SaaS MCP) and `local_stdio` (approved-template-only, gated by deployment trust). Operators never paste raw stdio commands; templates ship in the build.
- **Catalog with risk classification** — Every discovered tool gets a `read` / `write` / `destructive` risk level inferred from MCP annotations. Destructive tools and unexpected new write tools are auto-quarantined.
- **Profiles + bindings** — Named bundles of include/exclude entries over the catalog, bound to a `company`, `agent`, `project`, `routine`, or `issue`. Narrowest binding wins.
- **Policies** — `allow`, `block`, `require_approval`, `rate_limit`, and `trust_rule`. Deny beats allow. Policies stack with profiles and run in priority order.
- **Approval flow** — High-risk calls open an action request with signed arguments and an expiry. Human approver decides; agent resumes on approval, fails cleanly on rejection or expiry.
- **Trust rules** — Promote an approval into a scoped allow rule tied to the canonical argument hash and the catalog schema hash. When schemas drift, trust rules stop applying and the gateway falls back to approval. Revocations are first-class and audited.
- **Audit ledger** — Append-only call event log with decision, matched policy IDs, reason code, redaction plan, latency, and outcome. Per-run timelines available via `…/runs/:runId/decisions`.
- **Runtime supervisor** — Stdio runtime slots have a real lifecycle (`starting`, `running`, `idle`, `failed`), idle eviction, restart suppression on storms, and a board health endpoint with alert recommendations.
- **Bundled examples** — `safe-read-only-todo-kv` installs an application, a connection against a synthetic local fixture, and a read-only profile in one call. A bundled smoke check exercises read / denied write / audit visibility, so operators can confirm the gateway is healthy without an upstream MCP dependency.

## What's new for agents

- Agents speak MCP only to the Paperclip gateway. The gateway returns the agent's effective tool list, validates each call against profile + policies, and records the result.
- When a call resolves to `require_approval`, the agent's call blocks until a human decides. The agent does not see *why* a call was denied — that detail is in the audit log for the operator. This is deliberate: agents must not learn to route around denials.
- Tool call arguments and results are subject to a redaction plan recorded on each call event.

## Default posture

- **Unknown tool**: deny.
- **Catalog drift** (new write or destructive tool seen on a refresh): quarantine.
- **Write tool, no policy match, no trust rule**: requires approval if the profile's default-action allows writes; otherwise denied.
- **Destructive tool**: denied until an operator explicitly un-quarantines it.
- **Local stdio in `authenticated/public`**: fails closed unless `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` is set on a designated trusted worker.
- **Agent-supplied stdio commands**: rejected. Always.

## Upgrade and migration

This release introduces new tables (`tool_applications`, `tool_connections`, `tool_catalog_entries`, `tool_profiles`, `tool_profile_entries`, `tool_profile_bindings`, `tool_policies`, `tool_runtime_slots`, `tool_gateway_sessions`, `tool_invocations`, `tool_action_requests`, `tool_call_events`, `tool_rate_limit_counters`, `tool_access_audit_events`) and supporting migrations through `0098_tool_gateway_sessions.sql`. No data migration is required for existing companies — the tool access stack is opt-in and inert until an operator installs the first connection or example.

Upgrade steps for existing deployments:

1. Apply DB migrations as usual (`pnpm paperclipai migrate`).
2. Confirm the Tools & Access tab appears in the UI for board users.
3. From **Examples**, install `safe-read-only-todo-kv` and run the bundled smoke. Expect `ok: true` across all three checks (`allow_read_tool`, `deny_write_tool`, `audit_written`).
4. For each existing agent runtime that previously called MCP servers directly: replace direct MCP wiring with a managed connection. Until you do, those agents have no governed tool access on this release.
5. If you run `authenticated/public`, decide whether you want a trusted runtime worker for local stdio. If yes, set `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` on that worker and only that worker. If no, leave it unset — `remote_http` connections continue to work.

There is no downgrade path that preserves audit history. If you must roll back, archive any installed connections first so future audits do not surface orphan IDs.

## Known limitations

(See [MCP-ACCESS-GOVERNANCE.md#known-limitations](./MCP-ACCESS-GOVERNANCE.md#known-limitations) for the canonical list. The deltas worth calling out in the release note:)

- Audit-write failure counter is not durable yet. The `mcp_runtime_audit_write_failures` alert is recommended but not wired to a durable counter; treat any DB write error in audit paths as a control-plane incident in the meantime.
- No CLI surface for tool access in v1. Use the UI or REST API.
- No bulk catalog review — each quarantined entry is reviewed one at a time.
- Trust rules match exact argument shapes only. Pattern-based trust rules are post-v1.
- Rate limits are per-policy, not cross-policy aggregates.
- Action request expiry is fixed by policy; approvers cannot extend from the UI.
- Endpoint mode (Paperclip's own `/mcp` surface) is not subject to the profile/policy stack.
- Local stdio runtime slots do not migrate across workers; capacity is per-worker, not per-cluster.

## Verification commands

After upgrading, run these to confirm the stack is healthy:

```sh
# Sanity-check runtime health
curl -fsS -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/runtime-health" | jq '{status, alerts}'

# Install the bundled example + run the smoke
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/examples/safe-read-only-todo-kv/install" \
  -d '{}' | jq .

curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/examples/safe-read-only-todo-kv/smoke" \
  -d '{}' | jq '{ok, checks: [.checks[] | {name, ok, decision, reasonCode}]}'
```

Expected: `runtime-health.status` is `"ok"` (no firing alerts on a clean install); `smoke.ok` is `true` with three green checks (`allow_read_tool`, `deny_write_tool`, `audit_written`).

## Documentation

- Operator guide: [doc/MCP-ACCESS-GOVERNANCE.md](./MCP-ACCESS-GOVERNANCE.md)
- Runtime runbook: [doc/MCP-RUNTIME-OPERATIONS.md](./MCP-RUNTIME-OPERATIONS.md)
- Demo script: [doc/MCP-DEMO-SCRIPT.md](./MCP-DEMO-SCRIPT.md)
- Deployment modes (auth/exposure/bind): [doc/DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md)

## Acknowledgements

Built across Phase 2–8 of the MCP Access Governance program. Implementation phases: [PAP-10385](/PAP/issues/PAP-10385), [PAP-10386](/PAP/issues/PAP-10386), [PAP-10387](/PAP/issues/PAP-10387), [PAP-10388](/PAP/issues/PAP-10388), [PAP-10389](/PAP/issues/PAP-10389), [PAP-10390](/PAP/issues/PAP-10390). Phase 9 readiness rollup: [PAP-10392](/PAP/issues/PAP-10392).
