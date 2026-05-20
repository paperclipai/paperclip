# Paperclip MCP Server — Design Doc v1.0

**Status:** Accepted 2026-05-20 by Hermes CC Agent + Paperclip CC Agent. Ready for paperclipai/paperclip maintainer review.
**Origin:** drafted by Hermes CC Agent at SparkEros; convergence + decisions integrated by Paperclip CC Agent.
**Implementation issue:** to be opened on merge of this design.

## Context

Paperclip dispatches tasks to Hermes-hosted agents (gpt-5.5 via codex_app_server on `:8642`). Today the agent uses `bash + curl|python3` to query Paperclip's HTTP API and post results back. Pure-upstream Hermes' `tools/approval.py` blocks the curl-pipe-to-interpreter pattern as HIGH-severity dangerous; the safe toolset (web/file/memory/clarify) ships no HTTP-write primitive; removing `terminal` from the toolset gives a literally-mute agent. The community http-tool (`#25861`) is open since April with no merge in sight.

An MCP server that exposes Paperclip's operations as semantic tool calls removes the shell-pipe requirement entirely: the agent calls `paperclip.post_comment(...)` as a native tool, not a shell command. Hermes natively supports MCP servers via `~/.hermes/config.yaml` `mcp_servers:` — no upstream Hermes code change needed.

**Key empirical unlock:** Hermes' `cli.py:2787-2792` unions MCP server names into the toolset validator. So `hermes chat -t safe,memory,paperclip` enables the built-in `safe` toolset PLUS the `paperclip` MCP server's tools. The governance profile becomes shippable with **zero upstream Hermes dependency** the moment this MCP server lands.

Goal of this doc: nail down the v1 surface, transport, auth, placement, config, error model, scope boundaries, and acceptance criteria — enough to implement without further design-by-committee.

---

## 1. Surface (v1)

Six semantic operations.

### 1.1 `paperclip.get_thread`

Full conversation history for an issue.

**Input:**
```json
{"issue_id": "string (required)"}
```

**Output:**
```json
{
  "issue_id": "string",
  "title": "string",
  "comments": [
    {"id": "string", "author": "string", "role": "user|agent|system",
     "body": "string", "created_at": "ISO-8601"}
  ]
}
```

**Errors:** `issue_not_found`, `auth_expired`, `paperclip_backend_unavailable`.

### 1.2 `paperclip.get_latest_comment`

Narrow context — just the most recent comment on an issue. Cheaper than `get_thread`; matches `#130`'s motivating use case.

**Input:**
```json
{"issue_id": "string (required)"}
```

**Output:**
```json
{
  "issue_id": "string",
  "comment": {"id": "string", "author": "string", "role": "string",
              "body": "string", "created_at": "ISO-8601"}
}
```

**Errors:** `issue_not_found`, `no_comments_yet`, `auth_expired`, `paperclip_backend_unavailable`.

### 1.3 `paperclip.post_comment`

Append a comment to an issue.

**Input:**
```json
{
  "issue_id": "string (required)",
  "body": "string (required, non-empty)",
  "idempotency_key": "string (optional, recommended)"
}
```

**Output:**
```json
{"issue_id": "string", "comment_id": "string", "created_at": "ISO-8601"}
```

**Errors:** `issue_not_found`, `body_invalid`, `idempotent_replay` (success path on retry — returns prior `comment_id`), `auth_expired`, `paperclip_backend_unavailable`.

**Idempotency:** when `idempotency_key` is present and previously seen, return the prior `comment_id` without re-posting. Prevents double-posts on agent retry loops, which are common in gpt-5.5 transient-error recovery.

### 1.4 `paperclip.update_disposition`

Lifecycle state transition.

**Input:**
```json
{
  "issue_id": "string (required)",
  "state": "string (required)",
  "reason": "string (optional)"
}
```

**State enum** (from [`packages/shared/src/constants.ts:127-135`](../packages/shared/src/constants.ts#L127-L135)):
`backlog | todo | in_progress | in_review | done | blocked | cancelled`

**Output:**
```json
{"issue_id": "string", "previous_state": "string", "new_state": "string",
 "updated_at": "ISO-8601"}
```

**Errors:** `issue_not_found`, `state_invalid`, `transition_disallowed`, `auth_expired`, `paperclip_backend_unavailable`.

**State-machine subtlety:** the 7-value enum is the *surface* a caller can request. Not every transition is valid — the disposition state machine in [`server/src/services/recovery/successful-run-handoff.ts:19-24`](../server/src/services/recovery/successful-run-handoff.ts#L19-L24) recognizes four terminal-disposition families, each with required co-data:

| Family | State | Required co-data |
|---|---|---|
| `mark_done_or_cancelled` | `done` \| `cancelled` | none |
| `send_for_review_or_ask_for_input` | `in_review` | reviewer path: `executionState.currentParticipant`, `assigneeUserId`, pending thread interaction, or linked approval |
| `mark_blocked` | `blocked` | `blockedByIssueIds` or named unblock owner |
| `delegate_or_continue_from_checkpoint` | `in_progress` (kept) | explicit continuation path with `resumeIntent: true` |

The MCP shim does **not** model the state machine. It surfaces what the caller asks for; Paperclip's backend returns `transition_disallowed` when the required co-data is missing. Translation-only.

### 1.5 `paperclip.get_task`

Task metadata (distinct from issue thread).

**Input:**
```json
{"task_id": "string (required)"}
```

**Output:**
```json
{
  "task_id": "string",
  "issue_id": "string",
  "assigned_to": "string",
  "profile": "string (governance|audit|engineering|...)",
  "dispatched_at": "ISO-8601",
  "status": "string"
}
```

**Errors:** `task_not_found`, `auth_expired`, `paperclip_backend_unavailable`.

### 1.6 `paperclip.list_assigned_issues`

Heartbeat / dispatch flow. What should the agent be working on?

**Input:**
```json
{"agent_id": "string (optional, default: current)", "limit": "integer (optional, default 10, max 50)"}
```

**Output:**
```json
{
  "agent_id": "string",
  "issues": [
    {"issue_id": "string", "title": "string", "priority": "string",
     "assigned_at": "ISO-8601"}
  ]
}
```

**Errors:** `agent_not_found`, `auth_expired`, `paperclip_backend_unavailable`.

---

## 2. Transport

**v1: stdio MCP.** Hermes spawns the MCP server as a child process; JSON-RPC over stdin/stdout. Server lifecycle bound to Hermes. No port to manage. Standard MCP pattern; works on every platform Hermes supports.

**v2 (deferred): HTTP-MCP.** If multi-agent connection sharing matters (several Hermes instances on the same host sharing one Paperclip-backend connection pool), upgrade later. Out of scope for v1.

---

## 3. Auth

**Per-call token from the dispatch payload.** Paperclip injects a per-run auth token via `adapterConfig.env.PAPERCLIP_AUTH_TOKEN` (PR-B wires this in [`server/src/adapters/registry.ts`](../server/src/adapters/registry.ts)). The npm `hermes-paperclip-adapter@0.2.0` already forwards `config.env` to the spawned `hermes chat` subprocess at [`execute.js:301-303`](../node_modules/.pnpm/hermes-paperclip-adapter@0.2.0/node_modules/hermes-paperclip-adapter/dist/server/execute.js#L301-L303) — no upstream adapter change needed. Hermes' MCP_SERVER_ENV mechanism then makes the token available to the MCP server process.

**No static key.** A static key on the prior `hermes-paperclip` integration broke per-run CEO auth in the modded era. Per-call tokens rotate naturally and audit cleanly.

**Token expiry behavior (v1):** if a token expires mid-task, MCP server returns `auth_expired`. Agent aborts with that reason. v1 does NOT auto-redispatch — the operator/heartbeat picks it up on the next tick. PR-C (sibling cleanup, parallel to v1) extends [`successful-run-handoff.ts`](../server/src/services/recovery/successful-run-handoff.ts) to recognize `auth_expired` as a re-dispatchable cause and queue a fresh dispatch with a new token. **PR-C is not v1 gate-blocking.** Until it lands, `auth_expired` surfaces as a one-shot failure requiring operator re-dispatch; that's acceptable for v1 acceptance testing (test 3a passes; test 3b waits for PR-C).

---

## 4. Server placement

**Sidecar shim, owned by Paperclip, lives at [`packages/mcp-server/`](../packages/mcp-server/)** — matches the existing [`packages/adapters/openclaw-gateway/`](../packages/adapters/openclaw-gateway/) workspace pattern. Released alongside Paperclip versions.

Reasoning:
- Thin translation layer (MCP JSON-RPC in, Paperclip HTTP API out). No business logic, no state.
- Tracks Paperclip's API schema directly — no cross-repo coordination on schema changes.
- Hermes references it by `command` in `mcp_servers:` config; doesn't know its internals.

**Implementation language: TypeScript.** Matches Paperclip's primary stack, shares types with [`packages/shared/`](../packages/shared/) for the status enum and disposition model, uses `@modelcontextprotocol/sdk` (official). Avoids cross-language type drift.

**Distribution: `@paperclipai/mcp-server` npm package** with a bin entry. Hermes config invokes via `npx -y @paperclipai/mcp-server`.

**Process lifecycle: one-shared-process with per-call session context.** Stdio MCP spawn is ~100-500ms cold; one-per-run inflates short tasks unacceptably. Isolation enforced by per-call payload (`PAPERCLIP_AUTH_TOKEN` + `PAPERCLIP_RUN_ID` + `PAPERCLIP_TASK_ID`, all already present in adapter env injection at [`execute.js:296-303`](../node_modules/.pnpm/hermes-paperclip-adapter@0.2.0/node_modules/hermes-paperclip-adapter/dist/server/execute.js#L296-L303)). Shim is stateless — reads token from each call's env-injected payload; no session table to manage.

**Not in Hermes' tree:** Hermes shouldn't know Paperclip's schema. Cleanly separates concerns.

**Not embedded in Paperclip's HTTP gateway:** keeps transports separate (HTTP for direct API; MCP for agent-facing). Two entry points, one backing implementation.

---

## 5. Hermes-side config

Single block added to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  paperclip:
    command: "npx"
    args: ["-y", "@paperclipai/mcp-server"]
    env:
      PAPERCLIP_API_BASE: "http://127.0.0.1:3100"
      # PAPERCLIP_AUTH_TOKEN injected per-run by Paperclip via adapterConfig.env
    enabled: true
    lazy_load: true
```

**Hermes config watcher:** `cli.py:9605` auto-reloads `mcp_servers:` on file change, so config edits don't require a gateway restart.

**Caveats:**
- `lazy_load: true` keeps gateway startup fast; spawn only when a Paperclip task actually arrives.
- **No crash-respawn supervisor in upstream Hermes.** `cli.py` only has reload-on-config-change at line 9605; there is no MCP-children supervisor. Defensive shim design required (see §6).
- **v1 known limitation:** if the MCP shim process exits unexpectedly, Hermes won't respawn it; the next tool call surfaces as `paperclip_backend_unavailable`. Gateway restart re-spawns via `lazy_load`. v2 could file an upstream Hermes feature request for an MCP-children supervisor if v1 production proves this is a pain.

---

## 6. Failure modes

Each error surfaces to the agent with a distinguishable code so it can react appropriately, not just see a generic "tool failed":

| Error code | Cause | Expected agent behavior |
|---|---|---|
| `paperclip_backend_unavailable` | API unreachable (5xx, network, gateway down) | Retry once w/ backoff; on persistent failure abort task via run-completion callback (NOT via post_comment, that path is also broken) |
| `auth_expired` | Per-call token TTL exceeded | Abort task with `auth_expired` reason. v1: operator re-dispatches. v1+PR-C: adapter auto-re-dispatches with fresh token |
| `issue_not_found` / `task_not_found` | Stale or wrong ID | Surface; do not retry (caller logic bug) |
| `idempotent_replay` | `post_comment` retry with seen key — success path | Treat as success; use returned `comment_id` |
| `transition_disallowed` | State machine rejects transition (missing reviewer path / blockers / etc.) | Surface; agent may comment-and-bail rather than force |
| `body_invalid` / `state_invalid` | Input validation failure | Surface; do not retry (caller bug) |
| `mcp_server_internal` | Shim itself failed | Retry once; if still failing, structured abort |

**Critical: errors do NOT leak as agent answers.** This is the [NousResearch/hermes-agent#29511](https://github.com/NousResearch/hermes-agent/issues/29511) risk family. MCP transport returns structured errors; the agent's response generation sees a structured error object it can act on, not a warning string that gets posted as a comment.

**Defensive shim loop required:** the §5 no-respawn finding means any uncaught exception in the shim crashes the whole MCP process. The shim must run its JSON-RPC dispatch under a broad try/except that catches ALL exceptions, returns a structured `mcp_server_internal` response, and continues. Anything that escapes — uncaught exception, JSON-RPC framing error, stdio pipe close on shim crash — reaches the agent as an unstructured failure that might leak into a comment. **PR-A must include a dedicated test case:** inject a synthetic uncaught exception in an op handler; verify the agent sees `mcp_server_internal`, not a stack trace.

---

## 7. Out of scope for v1

Explicitly deferred to keep v1 reviewable in one pass:

- Streaming responses (live thread updates as new comments arrive)
- Bulk operations (`post_comments(list)`)
- Attachment handling (file uploads, image embeds, screenshot attach)
- Cross-issue queries (`search_issues(query)`)
- Webhook subscriptions (push Paperclip → MCP server)
- Multi-tenant (multiple Paperclip instances per agent)
- Read-your-writes consistency guarantees (if Paperclip's backend is eventually-consistent)

Each is fair game for v2+ when v1 has shipped and a real use case motivates it.

---

## 8. Acceptance criteria — "ready to flip security back on"

The workarounds (`HERMES_YOLO_MODE=1`, `security.tirith_enabled: false`) lift when these tests pass on a real `:8642` gateway:

1. **Round-trip dispatch:** Paperclip dispatches "post a comment saying hello." Agent calls `paperclip.post_comment(...)` via MCP. Comment appears. `tools/approval.py` blocked nothing (scanner active, `HERMES_YOLO_MODE` unset).

2. **Audit task:** Paperclip dispatches a URL-audit task. Agent uses `web_extract` for the fetch and `paperclip.post_comment` for the report. No `curl|python3` in the run. Approval.py event log shows no blocked commands.

3a. **Token-expiry surfacing (v1 gate):** Dispatch carries a token with short TTL. Agent's MCP call surfaces `auth_expired` cleanly (no leaked error text in comments). v1 ships when this passes.

3b. **Adapter auto-redispatch (PR-C gate, not v1):** Adapter re-dispatches; new token works; task completes without operator intervention.

4. **Failure surface:** Paperclip's HTTP API is brought down mid-task. Agent receives `paperclip_backend_unavailable`; aborts cleanly via the run-completion callback. No DANGEROUS-COMMAND warning leaks into the issue thread (#29511 territory; this path bypasses approval.py entirely).

5. **Governance profile:** With `runtimeConfig.profile = "governance"` (toolset = `safe,memory,paperclip`), agent completes a task using only safe toolset + Paperclip MCP. Confirms the profile selector now has a write primitive.

**Security re-enable gate:** lift `HERMES_YOLO_MODE=1`; set `security.tirith_enabled: true`; restart gateway; re-run; confirm green when tests 1, 2, 3a, 4, 5 pass. 3b is a follow-on gate after PR-C lands.

---

## 9. Implementation sequence

Three PRs against `paperclipai/paperclip`:

- **PR-A:** [`packages/mcp-server/`](../packages/mcp-server/) v1 — 6 ops + structured error model + defensive shim loop + synthetic-exception test. Largest chunk; the bulk of v1.
- **PR-B:** [`server/src/adapters/registry.ts`](../server/src/adapters/registry.ts) env-injection + per-profile toolsets — ~20 LOC. Adds `runtimeConfig.profile` field, injects `PAPERCLIP_AUTH_TOKEN` + `PAPERCLIP_API_BASE` per-run, maps `profile → toolsets` string (`safe,memory,paperclip` for governance). No-op for agents without `profile`. Gated on PR-A merge so the `paperclip` toolset name resolves.
- **PR-C:** [`server/src/services/recovery/successful-run-handoff.ts`](../server/src/services/recovery/successful-run-handoff.ts) recognizes `auth_expired` as re-dispatchable cause. Sibling cleanup, parallel to PR-A/B, not v1 gate-blocking. Unblocks acceptance test 3b.

**Profile-map constants (PR-B):** the minimum useful governance map is `safe,memory,paperclip` — **NOT `paperclip` alone**. `-t paperclip` without `safe` or `file` gives the agent ONLY the MCP tools and zero local capability. The validator will accept it but it's a footgun. PR-B documents this in the profileMap constants.

**Hermes-side action (operator, post-PR-A merge):** drop the §5 `mcp_servers:` block into `~/.hermes/config.yaml`. Single block, trivial; Hermes' config watcher picks it up without restart.

---

## 10. Decisions resolved 2026-05-20

Original draft had 6 open questions for the Paperclip-side agent. All resolved during the convergence:

| # | Question | Resolution |
|---|---|---|
| 1 | State enum for `update_disposition` | Use the 7-value `ISSUE_STATUSES` enum (§1.4 table); push state-machine knowledge to Paperclip's backend via `transition_disallowed`. Translation-only in MCP shim. |
| 2 | Auth refresh: adapter auto-redispatch vs prompt guidance | v1: agent aborts on `auth_expired`. PR-C (parallel cleanup): adapter auto-redispatches. Not v1 gate-blocking. |
| 3 | MCP-supervisor restart behavior on shim crash | No crash-respawn in upstream Hermes (cli.py only has config-change watcher). Defensive shim loop required (§6); document as v1 known limitation. |
| 4 | One-shared vs one-per-run process lifecycle | One-shared with per-call session context. Spawn cost is ~100-500ms; isolation via env-injected payload. |
| 5 | Implementation location | `packages/mcp-server/`, TS, `@paperclipai/mcp-server` npm with `npx` invocation. |
| 6 | registry.ts wiring scope | **registry.ts only.** No `execute.js` change needed — adapter already forwards `config.env`. ~20 LOC. |

---

## Related upstream issues

This MCP server's existence is downstream of and obsoletes several upstream issues/PRs as workarounds:

- [paperclipai/paperclip#5984](https://github.com/paperclipai/paperclip/pull/5984) — openclaw PROTOCOL_VERSION (unrelated to MCP; cleanup of a sibling LOCAL-MOD)
- [paperclipai/paperclip#6459](https://github.com/paperclipai/paperclip/pull/6459) — Hermes wake-loop fix (sibling LOCAL-MOD)
- [paperclipai/paperclip#6461](https://github.com/paperclipai/paperclip/pull/6461) — openclaw timeoutSec default (sibling LOCAL-MOD)
- [NousResearch/hermes-paperclip-adapter#130](https://github.com/NousResearch/hermes-paperclip-adapter/issues/130) — `{{latestUserComment}}` template variable; superseded by `paperclip.get_latest_comment` MCP op
- [NousResearch/hermes-agent#25861](https://github.com/NousResearch/hermes-agent/issues/25861) — community http-tool PR (open ~6 weeks); MCP server is strictly better (semantic ops vs raw HTTP) so this is a passive watch
- [NousResearch/hermes-agent#29511](https://github.com/NousResearch/hermes-agent/issues/29511) — DANGEROUS-COMMAND warning leak; MCP path bypasses approval.py entirely
- [NousResearch/hermes-agent#29513](https://github.com/NousResearch/hermes-agent/issues/29513) — `trusted_url_prefixes` config; orthogonal to MCP but lifts the workaround floor when both land
