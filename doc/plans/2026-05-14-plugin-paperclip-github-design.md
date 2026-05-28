# plugin-paperclip-github — Interface Design

Status: v0.1 LANDED (2026-05-14). Real code lives at
`packages/plugins/plugin-paperclip-github/`.
44/44 vitest tests passing, typecheck clean, esbuild bundle produced
(`dist/manifest.js` + `dist/worker.js`).
Owner: paperclip platform team
Reference plugin: `packages/plugins/plugin-llm-wiki/` (production pattern)
Reference SDK contract: `packages/plugins/sdk/src/define-plugin.ts`,
                         `packages/plugins/sdk/src/types.ts:582-922`

## What's actually built in v0.1

Six tools, all in code with refusal rules and audit logging:

| Tool | Caller | Source |
|------|--------|--------|
| `github_open_pr` | engineer agents | `src/tools/pr.ts` |
| `github_get_pr` | Merge Director | `src/tools/pr.ts` |
| `github_get_check_runs` | Build Verifier | `src/tools/checks.ts` |
| `github_create_check_run` | Build Verifier | `src/tools/checks.ts` |
| `github_enqueue_merge` | Merge Director | `src/tools/merge.ts` |
| `github_list_issues` | Delivery Lead | `src/tools/issues.ts` |

Cross-cutting infrastructure built:

- GitHub App authentication with token caching (`src/auth.ts`)
- Instance config + secret resolution (`src/config.ts`)
- Audit + refusal layer (`src/audit.ts` — `wrapTool` + `RefusalError`)
- Stable code identifiers for every refusal: `evidence_too_thin`,
  `missing_conclusion`, `merge_queue_disabled`, `pr_is_draft`,
  `pr_not_open`, `failing_checks`, `review_not_approved`,
  `tool_unhandled_error`

Below is the **original design intent** kept verbatim for reference; the
"What's intentionally NOT in v0.1" section near the end lists what was
deferred to a v0.2 follow-up.

---


## Problem

Today every paperclip codex agent that needs to do something on GitHub
(open a draft PR, request a review, check a PR's check status, enqueue a
merge) does it by **letting codex write `gh` shell commands**. That means:

1. **No typed contract.** The Merge Director cannot reliably read a check
   run's conclusion — it depends on the codex agent parsing `gh pr checks`
   text output.
2. **Auth is fragile.** All agents share whatever `GITHUB_TOKEN` env the
   shell has. No per-agent identity, no fine-grained scopes.
3. **Audit is shallow.** GitHub-side activity (PR opened, reviewer added,
   merge enqueued) does not write to paperclip's activity log unless the
   agent remembers to. Mostly it doesn't.
4. **Drift between intents and actions.** The compliance-first company
   has hard rules ("one issue → one PR", "no merge without evidence") but
   they live in AGENTS.md text, not in code that refuses bad calls.

`plugin-paperclip-github` solves all four by exposing a small set of
typed agent tools, wired to a GitHub App identity, with every call
mirrored to `ctx.activity.log()`.

## Architecture

```
codex agent (Workspace Director / Merge Director / Build Verifier …)
       │
       │  ctx.tools.invoke("github_open_pr", { ... })
       ▼
plugin-paperclip-github worker  (Node subprocess, JSON-RPC over stdio)
       │
       │  ctx.secrets.resolve("GITHUB_APP_COMPLIANCE_FIRST_KEY")
       │  ctx.secrets.resolve("GITHUB_APP_COMPLIANCE_FIRST_ID")
       │  @octokit/auth-app → installation token (10-min TTL)
       ▼
GitHub REST + GraphQL v4
       │
       └─ Webhook  ─→  paperclip POST /api/plugins/github/webhook
                       │  (Smee tunnel in dev, public ingress in prod)
                       └─ ctx.events.emit("github.pr.merged", { ... })
```

## Manifest skeleton

`packages/plugins/plugin-paperclip-github/src/manifest.ts`:

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-paperclip-github";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub",
  description: "Typed GitHub operations for agents (PRs, reviews, checks, merge queue) backed by a per-company GitHub App.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "secrets.read-ref",
    "activity.log.write",
    "api.routes.register",        // for the webhook receiver
    "events.subscribe",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
    "ui.page.register",            // for an admin App-install status panel
    "ui.sidebar.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  config: {
    schema: {
      appId:            { type: "secretRef", required: true },
      privateKeyPem:    { type: "secretRef", required: true },
      installationId:   { type: "secretRef", required: true },
      repo:             { type: "string", required: true,
                          description: "owner/name, e.g. djcowork-ai/djcowork2.0" },
      defaultBranch:    { type: "string", default: "main" },
      webhookSecret:    { type: "secretRef", required: false },
      mergeQueueEnabled: { type: "boolean", default: true }
    }
  },
  tools: [
    /* enumerated below, populated at runtime via ctx.tools.register */
  ]
};

export default manifest;
```

## Tool surface (the contract agents see)

Each tool is registered in `worker.ts` setup with
`ctx.tools.register(name, declaration, handler)`. Parameter schemas use
the plugin SDK's `ToolDeclaration["parametersSchema"]` shape (JSON Schema
subset). Every handler **must**:

1. Resolve secrets via `ctx.secrets.resolve()` (never cache plaintext).
2. Use the resolved installation token to call GitHub.
3. Call `ctx.activity.log({ companyId, message, entityType, entityId, metadata })`
   on success **and** on caught failure.
4. Return `ToolResult = { content: string; data?: unknown; error?: string }`.

### Workspace & branch

| Tool | Inputs | Output | Auditable as |
|------|--------|--------|--------------|
| `github_open_pr` | `{ issueId, branch, title, body, draft?: boolean, labels?: string[] }` | `{ prNumber, htmlUrl, headSha }` | `pr.opened` |
| `github_request_review` | `{ prNumber, codeowners?: boolean, users?: string[], teams?: string[] }` | `{ requestedUsers, requestedTeams }` | `pr.review_requested` |
| `github_add_labels` | `{ prNumber, labels: string[] }` | `{ labels }` | `pr.labeled` |
| `github_close_pr` | `{ prNumber, reason: "merged" \| "abandoned", commentBody?: string }` | `{ closedAt }` | `pr.closed` |

### Status / readiness (read-side, used by Merge Director)

| Tool | Inputs | Output | Notes |
|------|--------|--------|-------|
| `github_get_pr` | `{ prNumber }` | `{ state, draft, mergeable, mergeStateStatus, headSha, baseSha, requiredChecks, failingChecks, lastReviewState }` | Single GraphQL round-trip aggregating `pull_request.mergeable`, `mergeStateStatus`, latest commit's `statusCheckRollup`, and review decision. Replaces 3-4 separate `gh` calls. |
| `github_get_check_runs` | `{ prNumber, name?: string }` | `Array<{ name, conclusion, status, detailsUrl, startedAt, completedAt }>` | Used by Build Verifier to verify evidence. |
| `github_get_required_contexts` | `{ branch?: "main" }` | `string[]` | Reads repo ruleset, so Merge Director cannot drift from branch protection. |

### Merge

| Tool | Inputs | Output | Notes |
|------|--------|--------|-------|
| `github_enqueue_merge` | `{ prNumber }` | `{ queuedAt, position }` | Requires `mergeQueueEnabled=true`. Calls `POST /repos/{owner}/{repo}/pulls/{prNumber}/merge_queue` (GraphQL `enqueuePullRequest`). |
| `github_dequeue_merge` | `{ prNumber, reason: string }` | `{ dequeuedAt }` | For Merge Director rollback path. |
| `github_squash_merge` | `{ prNumber, commitTitle, commitMessage }` | `{ merged: true, sha }` | **Refuses if merge queue is enabled.** Path for emergencies / hotfixes only, gated by an `emergency` capability check. |

### Check runs (Build Verifier evidence chain)

| Tool | Inputs | Output |
|------|--------|--------|
| `github_create_check_run` | `{ name, headSha, status, conclusion?, summary, details?, externalId? }` | `{ id, htmlUrl }` |
| `github_update_check_run` | `{ id, status?, conclusion?, summary?, details? }` | `{ updated: true }` |
| `github_upload_check_artifact` | `{ checkRunId, name, mimeType, bytesBase64 }` | `{ url }` |

Build Verifier uses these to attach SHA-256 + binary size of the
`x86_64-pc-windows-gnullvm/release/djcowork.exe` to the corresponding PR
as a structured check run, replacing the current shell-based evidence
post.

### Issue intake (Delivery Lead replacement for `gh issue list`)

| Tool | Inputs | Output |
|------|--------|--------|
| `github_list_issues` | `{ labels?: string[], state?: "open"\|"closed", since?: ISO8601 }` | `Array<IssueSummary>` |
| `github_get_issue` | `{ issueNumber }` | `{ ...issue, formFields }` (parses Issue-Forms YAML body into typed fields) |
| `github_comment_issue` | `{ issueNumber, body }` | `{ commentId }` |
| `github_close_issue` | `{ issueNumber, reason, body? }` | `{ closedAt }` |

`github_get_issue` is the key here — it parses Issue Forms (PR 7 in the
hardening plan) into typed Delivery-Lead task input, eliminating the
free-form LLM parsing that's the current weak link.

### Repo introspection (for Audit Lead)

| Tool | Inputs | Output |
|------|--------|--------|
| `github_get_ruleset` | `{ rulesetId?: number, branch?: string }` | Full Repository Ruleset JSON |
| `github_validate_codeowners` | `{}` | `{ errors: Array<{ path, message }> }` |
| `github_get_branch_protection` | `{ branch: "main" }` | Branch protection JSON (fallback for repos still using legacy rules) |

## Webhook receiver

`api.routes.register` lets the plugin expose
`POST /api/plugins/paperclip-github/webhook`. On verified webhook
(HMAC-SHA256 against `webhookSecret`):

```typescript
ctx.events.emit("github.pr.merged",      { prNumber, sha, mergedBy, mergedAt });
ctx.events.emit("github.pr.opened",      { prNumber, author, branch });
ctx.events.emit("github.pr.review_submitted", { prNumber, state, reviewer });
ctx.events.emit("github.check_run.completed", { name, conclusion, prNumber });
ctx.events.emit("github.merge_queue.entry_failed", { prNumber, reason });
```

Other agents subscribe via `ctx.events.on("github.pr.merged", handler)` —
the Merge Director uses `github.merge_queue.entry_failed` to immediately
notify the responsible engineer agent, eliminating the current "I'll
notice when I next poll" gap.

## Secrets

The plugin reads three named refs from paperclip's secret store
(`GITHUB_APP_COMPLIANCE_FIRST_*`):

```typescript
const appId = await ctx.secrets.resolve(config.appId);
const privateKey = await ctx.secrets.resolve(config.privateKeyPem);
const installationId = await ctx.secrets.resolve(config.installationId);
```

Never logged. Never returned in a tool result. Token caching is the
worker's responsibility: cache one installation token per process,
refresh ≥1 minute before its expiry (`exp - 60s`), use
`@octokit/auth-app` which handles JWT minting.

## Activity logging contract

Every tool handler writes one entry on success:

```typescript
await ctx.activity.log({
  companyId,
  message: `github_open_pr: opened #${prNumber} (${branch})`,
  entityType: "github.pull_request",
  entityId: String(prNumber),
  metadata: { branch, headSha, draft, labels }
});
```

And one entry on caught failure with `metadata.error` populated. This
gives the audit-lead and the board a complete chronological view of
every GitHub-side action without requiring them to read GitHub's audit
log.

## Refusal rules (where the plugin enforces hard rules)

The plugin **refuses** a call when:

| Rule | Refusal |
|------|---------|
| Two PRs from same agent in last 5 min | "one issue, one PR" — return `error: "rate_limited_per_agent"` |
| `github_squash_merge` when ruleset has merge_queue=active | Force enqueue instead |
| `github_open_pr` without `issueId` in body | Reject with `error: "missing_issue_ref"` |
| `github_request_review` from the same agent that opened the PR (self-review) | Reject |
| `github_create_check_run` without `details` ≥ 200 chars | Reject — "no merge without evidence" |
| `github_enqueue_merge` when `failingChecks.length > 0` | Reject; Merge Director must wait |

These are the compliance company's AGENTS.md rules **moved from prose to
code**. Audit Lead reviewing the plugin source becomes the
source-of-truth for what the company actually enforces.

## What the plugin does NOT do

- **It is not a git plugin.** Branch creation, commits, worktree, push —
  all stay in the codex agent's shell (those don't need a typed contract).
  The plugin starts at "I have a branch pushed; now make GitHub aware."
- **It does not bypass the company hierarchy.** Engineer agents still
  cannot call `github_enqueue_merge`; that capability is restricted in
  paperclip's per-role capability matrix. The plugin only exposes the
  tool; the runtime decides which agent gets to call it.

## File layout (when implementation starts)

```
packages/plugins/plugin-paperclip-github/
├── package.json                 (paperclipPlugin entry, like plugin-llm-wiki)
├── src/
│   ├── manifest.ts
│   ├── worker.ts                (definePlugin + runWorker)
│   ├── auth.ts                  (App token caching)
│   ├── tools/
│   │   ├── pr.ts                (open/close/request-review/add-labels)
│   │   ├── status.ts            (get_pr / get_check_runs / required_contexts)
│   │   ├── merge.ts             (enqueue / dequeue / squash)
│   │   ├── checks.ts            (create / update / upload artifact)
│   │   ├── issues.ts            (list / get / comment / close — with Issue-Forms parser)
│   │   └── repo.ts              (ruleset / codeowners / branch-protection)
│   ├── webhook.ts               (HMAC verify + event fan-out)
│   ├── audit.ts                 (activity.log wrappers)
│   ├── refusals.ts              (hard-rule enforcement)
│   └── ui/                      (App-install status panel, optional v1)
└── tests/
    ├── manifest.test.ts
    ├── tools-pr.test.ts
    └── refusals.test.ts
```

## Dependencies

- `@octokit/rest` — REST
- `@octokit/graphql` — GraphQL for `mergeStateStatus`, `statusCheckRollup`
- `@octokit/auth-app` — App identity + installation token
- `@octokit/webhooks` — HMAC verification

All are pinned in `package.json` to the same major versions other paperclip
plugins use; verify against the workspace's `package.json` engines field
before adding.

## Acceptance criteria (when implementation lands)

1. plugin-paperclip-github installs cleanly into a fresh paperclip via
   `paperclipai plugin install <path>`.
2. All tools listed above are registered and pass round-trip tests with
   a fixture GitHub repo (`octokit-fixtures` style, no live calls in CI).
3. `ctx.activity.log` is written on every successful and failed call.
4. The Workspace Director, Merge Director, and Build Verifier AGENTS.md
   are updated to **require these tools** for their respective actions
   (i.e., replace "use gh CLI" guidance).
5. Webhook receiver is registered behind `api.routes.register` and
   verified end-to-end with a Smee channel.

## Out of scope for v0.1

- GitHub Projects v2 integration (Issues/Iteration fields). Add in v0.2.
- Discussions API. v0.2.
- Multi-repo support. Per-company means per-repo for v1.
- Auto-rebase / auto-merge fallback. The auto-merge workflow already
  exists in djcowork2.0; let it stay there.

## Risks

- **App rate limits.** A GitHub App with default installation token has
  5000 req/hr. At 27 agents × heartbeats × tool calls, we will not hit
  this in normal operation, but bulk migrations or the daily-blocked-sweep
  routine could. Mitigation: aggressive caching of `github_get_pr` and
  `github_get_check_runs` for the same `(prNumber, sha)` pair across the
  process.
- **Webhook reliability.** If the webhook path is misconfigured, the
  plugin silently degrades to polling. We must surface this as a UI
  warning, not let it fail open.
- **Secret rotation.** App private keys rotate quarterly per ops policy.
  The plugin's `onConfigChanged` must invalidate the in-memory token
  cache on private-key change.
