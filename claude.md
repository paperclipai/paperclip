## Paperclip VPS credentials

- IP: `64.176.199.162`
- SSH: `root@64.176.199.162`
- Password: `bS%4nhouDq+gayS[`

## Notes

- Paperclip path: `/opt/paperclip`
- Docker Compose: `docker compose -f docker-compose.quickstart.yml`
- URL: http://64.176.199.162:3100
- Current deployed stack is running and healthy on `0.0.0.0:3100`
- Health check verified: `curl http://localhost:3100/api/health` returns `200 OK`

## Deployment progress

- The slow VPS rebuild issue was caused by rebuilding the UI on the VPS in the default `Dockerfile`
- Fast-build path is now available:
  - `Dockerfile.vps`
  - `docker-compose.vps.yml`
  - `docker-compose.vps-override.yml`
- Fast-build flow uses prebuilt `ui/dist` and skips the VPS UI build step
- **CI: merge vs deploy vs npm (three separate actions):** (1) Merge PR → `verify` + `policy` on the PR. (2) Ship the app → run **`deploy-vultr.yml`** when ready (`gh workflow run deploy-vultr.yml --repo Viraforge/paperclip --ref master`). (3) Publish npm canary/stable → run **`release.yml`** with workflow_dispatch (`channel` `canary` or `stable`); **not** triggered by merge. Canary also runs on a **nightly schedule** (02:00 UTC). Requires **`NPM_TOKEN`** in GitHub Environments `npm-canary` and `npm-stable`.
- **GHCR-based deploy (2026-03-18):** Docker image is now built on GitHub Actions and pushed to `ghcr.io/viraforge/paperclip:<sha>`. VPS only pulls and recreates. `Deploy Vultr` is now `workflow_dispatch` only — no longer triggers on push to master.
  - Image path: `ghcr.io/viraforge/paperclip:<github_sha>`
  - VPS reads image tag from `PAPERCLIP_SERVER_IMAGE` env var during compose commands
  - Current image pointer on VPS: `/opt/paperclip/current-image`
  - Rollback: `PAPERCLIP_SERVER_IMAGE=$(cat /opt/paperclip/current-image-prev) docker compose ... up -d --force-recreate --no-deps server`
- The production image now includes `openssh-client`
- OpenCode is now deployed through the Paperclip-native runtime path instead of the earlier manual wrapper
- The running container now uses:
 - `PAPERCLIP_OPENCODE_COMMAND=/paperclip/bin/opencode`
 - `/paperclip/bin/opencode -> /opt/paperclip-opencode/node_modules/.bin/opencode`
 - `OPENCODE_CONFIG_CONTENT` with `ZAI_API_KEY` and `MINIMAX_API_KEY` sourced from deployment env
- Live model discovery is verified in the running container:
 - `zai/glm-5`
 - `minimax/MiniMax-M2.5`
- A rebuild initially failed during Docker image export because the VPS root disk was at `99%`
- Recovery was:
 - prune unused Docker data
 - rebuild `paperclip-server`
 - recreate `paperclip-server-1`
- Current rebuilt image size is about `952MB`
- Verified in the running container:
  - `ssh -V`
  - `ssh-add`
  - `ssh-keyscan`

## Agent devtools in production image

Both `Dockerfile` and `Dockerfile.vps` now install the following in the production image for agent efficiency:
- `gh` — GitHub CLI, with the default `gh` entrypoints (`/usr/bin/gh` and `/paperclip/bin/gh`) wrapped to use an ephemeral `GH_CONFIG_DIR` so standard `gh` usage does not persist auth state in the shared `/paperclip` volume
- `ripgrep` — fast file search (`rg`); agents prefer this over `grep` fallback
- `fd-find` — fast file finder (`fd`, symlinked from `fdfind`)
- `procps` — provides `ps`, `top`, etc.
- `tree` — directory tree display
- `patch` — apply patch files

Operational rule for `gh` inside the production container:
- Never run `gh auth login`
- Token exclusivity is enforced by agent env binding: only the Senior Platform Engineer receives a GitHub token
- Expose the selected SPE-only GitHub secret as `GITHUB_TOKEN` or `GH_TOKEN` at runtime, even if the source secret is named differently (for example `GITHUB_TOKEN_VIRAFORGE`)
- The default `gh` entrypoints set a fresh temp `GH_CONFIG_DIR` for each invocation, reducing reusable auth state leakage during normal `gh` usage across Docker updates
- The relocated raw binary path is internal implementation detail and should not be invoked directly

## npm tool version pinning

All four agent CLI tools are pinned via Docker `ARG` in both `Dockerfile` and `Dockerfile.vps`:

| ARG | Current value |
|-----|---------------|
| `CLAUDE_CODE_VERSION` | `2.1.78` |
| `GEMINI_CLI_VERSION` | `0.34.0` |
| `CODEX_VERSION` | `0.115.0` |
| `OPENCODE_VERSION` | `1.3.3` |

These can be overridden at build time with `--build-arg`. The values were last updated 2026-03-18 to unblock the deploy pipeline after `@openai/codex@0.1.2504221644` (a non-existent beta version) caused `npm error notarget` failures since March 16.

## Docker build: plugin-sdk must be compiled before server

The server imports `@paperclipai/plugin-sdk` (workspace package at `packages/plugins/sdk/`). TypeScript's NodeNext module resolution requires `dist/` to exist before `tsc` runs on the server. Both Dockerfiles now do:

```
RUN pnpm --filter @paperclipai/plugin-sdk build && pnpm --filter @paperclipai/server build
```

The main `Dockerfile` also has `COPY packages/plugins/sdk/package.json packages/plugins/sdk/` in the `deps` stage. Omitting either step causes `TS2307: Cannot find module '@paperclipai/plugin-sdk'` and cascading TypeScript errors throughout the plugin system files.

## Plugin survival across deploys

- **Built-in plugins** (e.g. `paperclip-github` at `/app/packages/plugins/github-integration/`) are baked into the Docker image and survive container recreation.
- **Volume-installed plugins** (e.g. `paperclip-plugin-superpowers` at `/paperclip/.paperclip/plugins/`) are on the `paperclip-data` volume. They survive container recreation but their `dist/worker.js` may get wiped if the volume is recreated.
- **CLI tool extensions** (e.g. `pi-autoresearch` at `/paperclip/.pi/agent/extensions/`) are on the `paperclip-data` volume. They survive container recreation but not volume wipes. These are NOT in the Docker image — reinstall from source if lost.
- If a volume-installed plugin enters `error` state after a deploy, fix: `docker exec paperclip-server-1 npm install <package>@<version> --prefix /paperclip/.paperclip/plugins/<name>`, then `UPDATE plugins SET status = 'ready' WHERE id = '<id>'`, then restart the server.

## Superpowers plugin skills export

The superpowers plugin (obra/superpowers) stores 14 skills in `plugin_state` but adapters need them on the filesystem. After install or volume wipe, export skills:

```bash
# 1. Extract skills as JSON from DB
docker exec paperclip-db-1 psql -U paperclip paperclip -t -A -c "
  SELECT jsonb_agg(jsonb_build_object(
    'id', value_json->>'id', 'name', value_json->>'name',
    'description', value_json->>'description', 'category', value_json->>'category',
    'content', value_json->>'content'
  )) FROM plugin_state
  WHERE plugin_id = 'b42c55cb-a415-4247-9b27-91f28133f367'
  AND scope_kind = 'instance' AND state_key LIKE 'skill:%';
" > /tmp/superpowers-skills.json

# 2. Write skill files (run inside container as node user)
# Copy /tmp/superpowers-skills.json into container, then run a Node.js script
# that reads the JSON and writes SKILL.md files to:
#   /paperclip/.agents/skills/<id>/SKILL.md
#   /paperclip/.claude/skills/<id>/SKILL.md
#   /paperclip/.codex/skills/<id>/SKILL.md
```

## pi-autoresearch extension (Research Agent)

- **Agent**: Research Agent (`4e6ee9ed-5c9d-4e41-851c-00160d19c81d`), adapter `pi_local`, model `zai/glm-5`
- **Extension source**: https://github.com/davebcn87/pi-autoresearch
- **Extension path**: `/paperclip/.pi/agent/extensions/pi-autoresearch/index.ts`
- **Skill path**: `/paperclip/.pi/agent/skills/autoresearch-create/SKILL.md`
- **Framework doc**: `/paperclip/.pi/agent/pi_autoresearch_team_experiment_framework.md`
- **pi CLI**: baked into `Dockerfile.vps` via `PI_CODING_AGENT_VERSION` ARG (currently `0.61.1`)
- **Persistence**: volume-based (`/paperclip/.pi/`). Survives container recreation, NOT volume wipes.
- **Reinstall if lost**:
  ```bash
  docker exec paperclip-server-1 bash -c '
    cd /tmp && git clone --depth 1 https://github.com/davebcn87/pi-autoresearch.git &&
    mkdir -p /paperclip/.pi/agent/extensions /paperclip/.pi/agent/skills &&
    cp -r pi-autoresearch/extensions/pi-autoresearch /paperclip/.pi/agent/extensions/ &&
    cp -r pi-autoresearch/skills/autoresearch-create /paperclip/.pi/agent/skills/ &&
    rm -rf /tmp/pi-autoresearch
  '
  ```

## GitHub plugin (paperclip-github)

- Plugin ID: `0ec9cc46-eca5-48b0-aee9-61c4bdfceb9f`
- Package path in container: `/app/packages/plugins/github-integration`
- Status: `ready` (installed 2026-03-18)
- Webhook endpoint: `http://64.176.199.162:3100/api/plugins/0ec9cc46-eca5-48b0-aee9-61c4bdfceb9f/webhooks/github-events`
- Configured for repo: `Viraforge/paperclip`
- Default assignee: Senior Platform Engineer (`227d0125-9d34-4287-8ee8-39c4903f85b0`)
- GitHub token ref: `github-token` (secret_ref in agent env)
- Webhook secret: encrypted; test ping verified `status: success` in `plugin_webhook_deliveries`

## Known CI / PR workflow gotchas

- **CONFLICTING PRs silently block CI**: GitHub won't trigger `pull_request` workflows on a PR in `CONFLICTING` state. Always check `gh pr view <N> --json mergeable,mergeStateStatus` before wondering why CI hasn't run. Rebase to fix.
- **ai-review/verdict is automated**: The `ai-review.yml` workflow runs on every PR (`opened`, `synchronize`, `reopened`). It sends the diff to MiniMax M2.7 via OpenRouter, produces a verdict (`PASS`, `PASS_WITH_NOTES`, `FAIL`, `HIGH_RISK`), and posts the `ai-review/verdict` GitHub status. The existing `merge-automation.yml` then auto-merges when all checks pass. Manual posting is only needed as a fallback if the workflow fails:
  ```bash
  gh api repos/Viraforge/paperclip/statuses/<SHA> \
    -X POST -f state=success -f context="ai-review/verdict" \
    -f description="PASS – ..." -f target_url="<PR URL>"
  ```
  **Required secret**: `OPENROUTER_API_KEY` must be configured in GitHub Actions secrets.
- **Deploy Vultr is `workflow_dispatch` only**: `deploy-vultr.yml` no longer triggers on push to master (removed 2026-03-18). Deploy requires:
  ```bash
  gh workflow run deploy-vultr.yml --repo Viraforge/paperclip --ref master
  ```
- **Drift check fires whenever master is ahead of VPS**: `deploy-drift-check.yml` runs on a schedule and will fail any time master has commits that haven't been deployed. This is expected and intentional — it means you need to run `deploy-vultr.yml`. It is NOT a bug and should NOT be disabled.
- **Lockfile changes must go through `refresh-lockfile.yml`**: Never commit `pnpm-lock.yaml` manually in a PR — `pr-policy` will block it. The correct path when the lockfile is stale:
  1. Trigger the workflow: `gh workflow run refresh-lockfile.yml --repo Viraforge/paperclip --ref master`
  2. The workflow pushes the updated lockfile to branch `chore/refresh-lockfile` but **cannot create the PR** (GitHub Actions lacks PR creation permission in this repo).
  3. Open the PR manually: `gh pr create --repo Viraforge/paperclip --head chore/refresh-lockfile --base master --title "chore(lockfile): refresh pnpm-lock.yaml" --body "Auto-generated lockfile refresh."`
  4. `ai-review/verdict` is posted automatically by `ai-review.yml`. Once it passes along with `verify` + `policy`, merge. The `pr-policy` check has a built-in exception for the `chore/refresh-lockfile` branch.
- **npm package scope is `@paperclipai/`**: All packages use the upstream `@paperclipai/` scope and are marked `"private": true`. We do NOT publish to npm — packages are consumed only within the monorepo via pnpm workspace protocol. This alignment with upstream's scope eliminates merge conflicts on upgrades.

## Runtime auth state

- Codex auth was copied from VPS host root auth into the runtime user's persisted home at `/paperclip/.codex`
- Verified as runtime user: `codex login status` reports logged in
- Claude Code is installed globally in the container and authenticated for the runtime user
- Verified as runtime user:
  - `claude --version`
  - `claude auth status`
- Claude auth is persisted under `/paperclip/.claude`

## CTO agent status

- CTO agent adapter type: `codex_local`
- Prior failing CTO run showed OpenAI `401 Unauthorized: Missing bearer or basic authentication in header`
- A fresh end-to-end CTO heartbeat was invoked after the fixes and succeeded
- Verified successful CTO run:
  - Agent id: `cfd857ce-4110-4f51-b996-17b8eb02bc7b`
  - Run id: `aeeda432-c3ba-41e6-b980-e8e8f5a1783c`
  - Final status: `succeeded`
- Current CTO agent status is `idle`

## Operational notes

- New SSH sessions from external tooling may time out during banner exchange when the VPS is under heavy load, even while an already-open interactive SSH session still works
- The container image does not include the `ps` utility; `docker exec ... ps` failing is not itself an app failure
- URL: http://64.176.199.162:3100

## Production deployment policy (GitHub-only)

This is the enforced operating policy for production changes:

- No hot fixes directly on the VPS.
- No direct source edits under `/opt/paperclip` on the VPS.
- No manual `docker compose up/build` on production hosts for application updates.
- No emergency patching outside git history.
- Every production change must be:
  1. committed to GitHub,
  2. validated by required checks (`verify` + `policy`),
  3. merged to `master`,
  4. deployed through GitHub Actions workflows only.

### Allowed paths

- Standard deploy: merge to `master`, then run approved workflow path.
- Emergency deploy: use `workflow_dispatch` from a committed branch/commit in GitHub; still no VPS source edits.

### Explicitly forbidden commands on production for app changes

- `git reset --hard` against production source as a hot-fix mechanism
- `sed -i` / ad-hoc patching of tracked source files on VPS
- `docker compose -f docker-compose.quickstart.yml up --build` for production updates
- editing workflow files or server code directly on the server and restarting containers

### Compliance verification

- Drift monitor must remain enabled (`deploy-drift-check.yml`).
- Branch protection must keep `enforce_admins=true` and required checks `verify` + `policy`.
- If drift is detected, fix via GitHub PR + CI deploy, not by patching the VPS.

## Engineering responsibility model (current)

This is the active engineering lifecycle model across repositories.

### Role separation

- Developers author software:
  - Senior Codex Developer
  - Senior Claude Code Engineer
  - Senior Gemini Frontend Engineer
  - Founding Engineer
- AI Code Reviewer evaluates all PRs and assigns severity + verdict.
- Senior Platform Engineer executes GitHub operations (branch/PR/update/merge/pipeline actions).
- Release Manager controls deployment timing and release risk.
- CTO owns technical execution and weekly engineering metrics.

No single agent should create, approve, and deploy the same change end-to-end.

### Required software pipeline

Developer writes code
-> Platform Engineer opens/updates PR
-> AI Code Reviewer reviews
-> Developer addresses findings
-> Platform Engineer applies PR updates
-> AI Code Reviewer final verdict (`PASS`, `PASS WITH NOTES`, `BLOCK`)
-> Platform Engineer merges
-> Release Manager schedules release
-> Platform Engineer executes deploy workflow

### Review loop rule

Review feedback returns to the author agent directly.
The Platform Engineer is not a reviewer-developer communication relay.

Correct loop:

AI Code Reviewer comments
-> Author agent prepares fixes
-> Platform Engineer applies fixes to PR branch
-> AI Code Reviewer re-checks

### High-risk categories

Treat these as high-risk changes:

- Auth/authz logic
- Secrets/env handling
- CI/CD workflow changes
- Infrastructure config
- Database migrations
- Billing/payment logic
- Destructive operations

High-risk PRs require extra caution and may require human review.

### Alfred and non-engineering support roles

- Alfred provides systems/tooling/integration support only.
- Alfred does not author production code and does not approve merges.
- Compliance Attorney can request additional review on high-risk or regulated changes.

---

## Quality gates (delivery gate + QA gate + comment-required gate)

Server-side gates enforce code quality workflows for agent-authored issues. All run inline in the PATCH `/issues/:id` handler and return 422 when requirements aren't met.

### Three-layer design

1. **Instructions** — `AGENTS.md` (Code Delivery Protocol + QA Approval Protocol), CEO `HEARTBEAT.md`, root `AGENTS.md` (Definition of Done items 5–6)
2. **Workspace comment** — `buildWorkspaceReadyComment()` in `server/src/services/workspace-runtime.ts` reminds agents at workspace provisioning
3. **Hard gates** — `assertDeliveryGate()` and `assertQAGate()` in `server/src/routes/issues.ts` enforce at the API level

### Delivery gate (`assertDeliveryGate`)

| Transition | Requirement |
|------------|-------------|
| → `in_review` | At least one `issue_work_products` record of type `branch`, `commit`, or `pull_request` |
| → `done` | A `pull_request` work product with status `active`, `ready_for_review`, `approved`, or `merged` |

### QA gate (`assertQAGate`)

| Transition | Requirement |
|------------|-------------|
| → `done` | A comment matching `/\bqa[\s:]+pass(ed)?\b/i` from an authenticated author who is NOT the issue assignee |

**Self-QA prevention:** The assigned agent's own `QA: PASS` comments are ignored. A different agent or board user must approve.

### Comment-required gate (`assertAgentCommentRequired`)

Agents must include a comment when changing status or assignee. Returns 422 with gate `comment_required` if either field changes without a `comment` in the request body. Board users bypass this gate. Non-status/non-assignee updates (title, priority, etc.) do not require a comment.

### Transition gate (`assertAgentTransition`)

Agents follow a forward-only state machine. Terminal states (done, cancelled) cannot be exited by agents — only board users can reopen. Both reopen paths (PATCH handler implicit reopen and POST comments explicit reopen) are guarded.

| From | Allowed targets |
|------|----------------|
| backlog | todo, in_progress, cancelled |
| todo | in_progress, backlog, cancelled |
| in_progress | in_review, done, blocked, cancelled |
| in_review | in_progress, done, cancelled |
| blocked | in_progress, todo, cancelled |
| done | _(none — terminal)_ |
| cancelled | _(none — terminal)_ |

### Gate ordering

Transition gate fires first (cheapest check), then delivery gate, then QA gate, then comment-required gate. This ensures invalid moves are rejected before checking work products, QA approval, or comment presence.

### Escape hatches (all gates)

- **Non-code issues**: Issues without `executionWorkspaceId` skip delivery + QA gates (transition gate always applies)
- **Board actors**: Only `req.actor.type === "agent"` is gated — board users always bypass

### Observability

Rejected transitions are logged in the activity log:
- `issue.transition_blocked` — invalid agent state transition
- `issue.delivery_gate_blocked` — missing work products
- `issue.qa_gate_blocked` — missing QA approval
- `issue.comment_required_blocked` — status/assignee change without comment

### Work product URL verification (PR #124)

Agents must provide valid GitHub URLs when creating code delivery work products. This prevents fabricated work product records from bypassing the delivery gate.

| Work product type | URL requirement (agents only) |
|---|---|
| `pull_request` | **Required** — must match `https://github.com/{owner}/{repo}/pull/{number}`. `externalId` (PR number) also required. |
| `branch` | Optional — but if provided, must match `https://github.com/{owner}/{repo}/tree/{branch}` |
| `commit` | Optional — but if provided, must match `https://github.com/{owner}/{repo}/commit/{sha}` |

The delivery gate also verifies at gate time: `→ done` requires the PR work product to have a valid GitHub URL (not just a valid status).

Board users bypass all URL validation.

### Assignment policy gate (`assertAgentAssignmentPolicy`)

| Check | Enforcement |
|---|---|
| Ownership | Agent must be current assignee (control-plane roles bypass) |
| Dispatchability | Target agent must not be paused/error/terminated/pending_approval |
| Role matrix | `engineer→[qa]`, `devops→[qa]`, `qa→[engineer,devops]`, control-plane→any |
| Status consistency | Engineer→QA expects `in_review`; QA→engineer expects `in_progress` (logged, not blocked) |
| Same-role lateral | Blocked for non-control-plane actors |

**Gate ordering in PATCH `/issues/:id`:**
1. `assertCompanyAccess()` — company membership
2. Assignment detection (`assigneeWillChange`)
3. `assertCanAssignTasks()` — coarse "can this actor attempt assignment at all?"
4. `assertAgentAssignmentPolicy()` — contextual "is this specific assignment permitted?"
5. `assertAgentRunCheckoutOwnership()` — checkout lock
6. `assertAgentTransition()` — status state machine
7. `assertDeliveryGate()` — work product requirements
8. `assertQAGate()` — peer QA approval
9. `assertAgentCommentRequired()` — mandatory comment on status/assignee changes

**Escape hatches:**
- Board users bypass all agent-only gates
- Control-plane roles (CEO, CTO) bypass ownership and role matrix, but NOT dispatchability
- Agent returning issue to creator (agent→user, not agent→agent) bypasses assignment gates — this is safe because it only fires when `assigneeAgentId=null` and `assigneeUserId=createdByUserId`

**Activity log actions:**
- `issue.assignment_policy_blocked` — policy rejection with gate name and reason

**Server-only logging:**
- Status-role handoff inconsistencies logged at `warn` level via server logger (not issue activity feed)

### Key files

- `server/src/routes/issues.ts` — `assertAgentTransition()`, `assertDeliveryGate()`, `assertQAGate()`, `assertAgentAssignmentPolicy()`, `assertAgentCommentRequired()`, URL patterns, creation-time validation
- `server/src/utils/agent-dispatchability.ts` — `isDispatchableAgent()` shared predicate
- `server/src/__tests__/transition-gate.test.ts` — 12 transition gate tests
- `server/src/__tests__/delivery-gate.test.ts` — 10 delivery gate tests (including URL verification)
- `server/src/__tests__/qa-gate.test.ts` — 13 QA gate tests (including 3 self-QA prevention cases)
- `server/src/__tests__/assignment-policy-gate.test.ts` — 16 assignment policy tests
- `server/src/__tests__/comment-required-gate.test.ts` — 7 comment-required gate tests
- `server/src/__tests__/agent-dispatchability.test.ts` — 8 dispatchability predicate tests
- `server/src/__tests__/mention-agent-matching.test.ts` — 15 mention resolution tests
- `server/src/__tests__/work-product-verification.test.ts` — 11 work product URL verification tests
- `server/src/services/workspace-runtime.ts` — workspace ready comment
- `server/src/onboarding-assets/default/AGENTS.md` — Code Delivery Protocol + QA Approval Protocol + Assignment Policy
- `server/src/onboarding-assets/ceo/HEARTBEAT.md` — CEO delivery/QA enforcement guidance
- `AGENTS.md` — Definition of Done items 5–6
- `doc/plans/paperclip-enforceable-system-design-v3.md` — Architecture decision record

---

## Stale execution lock sweeper

Issues carry an `executionRunId` lock that prevents concurrent dispatch. Normally `releaseIssueExecutionAndPromote()` clears the lock when a heartbeat run finishes. If a run crashes or cleanup fails, the lock becomes stale — permanently blocking the issue from re-dispatch.

**`expireTerminatedRunLocks()`** in `server/src/services/heartbeat.ts` runs on every scheduler tick (~30s) via `server/src/index.ts`. It scans issues with a non-null `executionRunId`, checks if the referenced heartbeat run is in a terminal state (`succeeded`, `failed`, `cancelled`, `timed_out`) or missing from the database, and clears the lock (only if `checkoutRunId` is also null to avoid interfering with active checkouts).

Expired locks are logged at `warn` level. A summary is logged at `info` level when any locks are cleared in a sweep cycle.

**Manual override** (for emergencies before the sweeper catches it):
```sql
UPDATE issues SET execution_run_id = NULL WHERE identifier = 'DLD-XXXX';
```

---

## Unpicked assignment activation watchdog

`sweepUnpickedAssignments()` in `server/src/services/heartbeat.ts` runs on every scheduler tick (~30s) via `server/src/index.ts`. It detects issues assigned to an agent but never picked up (no `executionRunId`, no `executionLockedAt`, no `checkoutRunId`) past an 8-minute SLA window, and retriggers dispatch.

**Behavior:**
- Scans issues in `todo`, `in_progress`, or `in_review` status
- Checks `updatedAt` < now - 8 minutes (SLA window)
- Verifies assignee agent is dispatchable (not paused/error/terminated/pending_approval)
- Increments `activation_retrigger_count` and enqueues a wakeup with reason `unpicked_assignment_retrigger`
- Maximum 1 retrigger per assignment — after that, the issue stays stranded (requires manual intervention or reassignment)
- Counter resets to 0 when the assignee changes (via PATCH `/issues/:id`)
- Non-dispatchable agents are skipped with a `warn` log

**Key files:**
- `server/src/services/heartbeat.ts` — `sweepUnpickedAssignments()` implementation
- `server/src/index.ts` — scheduler wiring
- `server/src/routes/issues.ts` — `activationRetriggerCount` reset on assignee change
- `packages/db/src/schema/issues.ts` — `activationRetriggerCount` column
- `packages/db/src/migrations/0045_activation_retrigger.sql` — migration
- `server/src/__tests__/unpicked-assignment-sweep.test.ts` — 5 unit tests

---

## No-op PATCH short-circuit

The PATCH `/issues/:id` handler detects when all fields in the request body already match the existing issue values and there is no comment or reopen request. In that case it returns the existing issue immediately without writing to the database, logging activity, or triggering agent wakeups.

This prevents agents (especially the CEO) from polluting the activity log with redundant reassignment spam — e.g., re-sending `assigneeAgentId` every heartbeat cycle when the target agent is already assigned.

**Location:** `server/src/routes/issues.ts`, after `updateFields` destructuring (before gates).

---

## Auto-assign from @mention on `in_review` transition

When an agent transitions an issue to `in_review` and includes a comment with an `@mention` of another agent but **omits `assigneeAgentId`** from the PATCH body, the server auto-infers the assignment from the mentioned agent. This prevents the common pattern where agents `@mention` a QA agent for review handoff but forget to set `assigneeAgentId`, leaving the issue assigned to themselves and stalling the pipeline.

**Behavior:**
- Only fires for agent actors (board users bypass)
- Only fires on `status: "in_review"` transitions
- Only fires when `assigneeAgentId` is absent from the request body
- Picks the first mentioned agent that isn't the current actor
- The inferred `assigneeAgentId` flows through all normal gates (assignment policy, dispatchability, etc.)
- Logged at `info` level: `"auto-inferred assigneeAgentId from @mention in in_review transition"`

**Location:** `server/src/routes/issues.ts`, before `assigneeWillChange` computation.

---

## Capability-check bundled skill

Bundled skill at `skills/capability-check/SKILL.md` that directs agents to read ground-truth permissions from `GET /api/agents/me` (`access.canAssignTasks`, `access.grants`) every heartbeat, overriding stale session history that caused self-censoring.

**Problem solved:** Agents were refusing to use `tasks:assign` permission because their session history or corrections.md contained old "Missing permission" entries from before the permission was granted. They would post "blocked on tasks:assign" even though the server would accept the request.

**How it works:**
- Agents check `access.canAssignTasks` from the `/api/agents/me` response (already returned by `buildAgentAccessState()`)
- If `true`: must PATCH `assigneeAgentId` directly — no escalation, no workarounds
- If `false`: use @mention + escalation to manager
- Stale history override: any session-history entries about "tasks:assign denied/blocked/missing" are explicitly marked as potentially stale and must be verified against the live API

**Integration:** The paperclip skill's Step 1 (Identity) now references `access.canAssignTasks` and points to this skill for detailed handoff rules.

**Live permission injection (PR #138):** The server now computes `canAssignTasks` in `heartbeat.ts` before each adapter execution and injects it via two channels:
- **Environment variable:** `PAPERCLIP_CAN_ASSIGN_TASKS=true/false` — agents can check programmatically
- **Prompt section:** `context.paperclipPermissionNote` rendered as a `## Live Permissions (this heartbeat)` block in every heartbeat prompt — LLM sees it without needing an API call

This ensures permissions supersede stale session history because the LLM reads the prompt before any session memory. The env var and prompt note are injected by all three local adapters (claude-local, codex-local, cursor-local).

**Key files:**
- `server/src/services/heartbeat.ts` — computes access state, sets `context.paperclipPermissionNote` and `context.paperclipCanAssignTasks`
- `packages/adapters/claude-local/src/server/execute.ts` — reads permission note into prompt, injects env var
- `packages/adapters/codex-local/src/server/execute.ts` — same
- `packages/adapters/cursor-local/src/server/execute.ts` — same
- `skills/capability-check/SKILL.md` — the skill
- `skills/paperclip/SKILL.md` — Step 1 updated to reference capability checking

---

## Pipeline watchdog (observe-only)

External safety layer that detects dispatch anomalies, stranded assignments, and RTAA categorization drift. Runs every 15 minutes via GitHub Actions. Does **not** mutate state — observe and report only.

### What it checks

1. **Stranded assignments** — active issues assigned to paused/errored agents
2. **Dispatch anomalies** — actionable issues with no pickup evidence (`executionRunId`/`checkoutRunId`) past a 90-second grace window
3. **RTAA miscategorization** — ViraCue tasks that should be under the RTAA project but aren't

### Usage

```bash
# Manual trigger
gh workflow run pipeline-watchdog.yml --repo Viraforge/paperclip --ref master

# View latest report
gh run list --repo Viraforge/paperclip --workflow=pipeline-watchdog.yml --limit 1
# Download artifact from the run for the full markdown report
```

### GitHub secrets configured

| Secret | Value |
|---|---|
| `PAPERCLIP_BASE_URL` | `http://64.176.199.162:3100/api` |
| `PAPERCLIP_API_KEY` | Hermes agent API key |
| `PAPERCLIP_COMPANY_ID` | DLD Ent. company ID |
| `WATCHDOG_RTAA_PROJECT_ID` | RTAA project ID |
| `WATCHDOG_ROOT_ISSUES` | Comma-separated RTAA root issue IDs (9 entries) |

### Key files

- `scripts/pipeline-watchdog.mjs` — watchdog script (pure functions, no side effects)
- `.github/workflows/pipeline-watchdog.yml` — scheduled workflow (every 15 min + manual dispatch)
- `server/src/__tests__/pipeline-watchdog.test.ts` — unit tests
- `docs/deploy/pipeline-watchdog.md` — operational documentation

### Docker build speedup (PR #125)

The `docker.yml` workflow previously built `linux/amd64,linux/arm64` — the ARM64 cross-compilation via QEMU took ~20 minutes. The VPS is x86_64 only, so ARM64 was dropped. Build time: ~25 min → ~5 min.

---

## Automated AI review pipeline

Every PR to `master` is automatically reviewed by MiniMax M2.7 via OpenRouter. The `ai-review.yml` workflow posts `ai-review/verdict` as a GitHub commit status, which the existing `merge-automation.yml` consumes for auto-merge decisions.

### Flow

1. PR opened/updated → `ai-review.yml` triggers
2. Posts `pending` status on head SHA immediately
3. Fetches PR diff via `gh pr diff`
4. Sends diff + metadata to MiniMax M2.7 via OpenRouter (`scripts/ai-review.mjs`)
5. Parses structured verdict: `PASS`, `PASS_WITH_NOTES`, `FAIL`, or `HIGH_RISK`
6. Posts `ai-review/verdict` status (`success`/`failure`/`error`)
7. Posts PR comment with findings (only for non-PASS verdicts; cleans up old comments on re-push)
8. `merge-automation.yml` picks up the status and auto-merges if all checks pass

### Verdict rules

| Verdict | GitHub status | Merge eligible? |
|---------|--------------|-----------------|
| `PASS` | `success` | Yes |
| `PASS_WITH_NOTES` | `success` | Yes |
| `HIGH_RISK` | `success` | Yes (but requires human attention per merge-automation) |
| `FAIL` | `failure` | No |
| `ERROR` | `error` | No |

### Diff size guard

Diffs exceeding 100KB are truncated. If the original verdict would be `PASS`, it's upgraded to `PASS_WITH_NOTES` with a truncation note.

### GitHub secrets required

| Secret | Purpose |
|--------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key for MiniMax M2.7 inference |

### Key files

- `scripts/ai-review.mjs` — review script (pure functions, native fetch, no dependencies)
- `.github/workflows/ai-review.yml` — GHA workflow (triggered on PR events)
- `.github/workflows/merge-automation.yml` — consumes `ai-review/verdict` for auto-merge

### Manual fallback

If the workflow fails (e.g., OpenRouter outage), post the status manually:
```bash
gh api repos/Viraforge/paperclip/statuses/<SHA> \
  -X POST -f state=success -f context="ai-review/verdict" \
  -f description="PASS – manual review" -f target_url="<PR URL>"
```

---

## @mention wakeup for multi-word agent names (PR #131)

### The bug

`findMentionedAgents()` in `server/src/services/issues.ts` used a regex `/\B@([^\s@,!?.]+)/g` that stops at whitespace. Users write `@qa-agent` (kebab-case), but the matching compared against `agent.name.toLowerCase()` which gives `"qa agent"` (spaces). These never match, so **13 of 27 agents with multi-word names could never be woken via @mention**.

Previous fix attempts (commits `47449152`, `730a67bb`, `2735ef1f`) added HTML entity decoding (`normalizeAgentMentionToken`) but never addressed the kebab-vs-space mismatch.

### The fix

Wired the existing `normalizeAgentUrlKey()` from `@paperclipai/shared` (already used for URL slug generation) into `findMentionedAgents()` as a second-pass matcher:

```typescript
// Direct name match (handles single-word names like "CEO")
if (tokens.has(agent.name.toLowerCase())) { resolved.add(agent.id); continue; }
// Kebab-key match: @qa-agent resolves to "QA Agent" via normalizeAgentUrlKey
const agentKey = normalizeAgentUrlKey(agent.name);
if (agentKey && tokens.has(agentKey)) { resolved.add(agent.id); }
```

`normalizeAgentUrlKey` converts both `"QA Agent"` and `"qa-agent"` to `"qa-agent"` via `/[^a-z0-9]+/g` → hyphen replacement. This makes the token from the regex and the agent name converge to the same key.

### Production verification

Live-tested on production (2026-04-02): Comment `@release-manager` on DLD-1556 successfully triggered `issue_comment_mentioned` wakeup for the Release Manager agent within 24ms. Baseline was 0 prior mention wakeups.

### Key files

- `server/src/services/issues.ts` — `findMentionedAgents()` (the fix)
- `packages/shared/src/agent-url-key.ts` — `normalizeAgentUrlKey()` (shared utility)
- `server/src/__tests__/mention-agent-matching.test.ts` — 15 unit tests for mention resolution

### Mention syntax reference

| Syntax | Resolves to |
|---|---|
| `@ceo` | CEO (exact name match) |
| `@qa-agent` | QA Agent (kebab-key match) |
| `@senior-claude-code-engineer` | Senior Claude Code Engineer (kebab-key match) |
| `@release-manager` | Release Manager (kebab-key match) |
| `@nonexistent` | _(no match, silently ignored)_ |

---

## Adapter config field preservation (PR #131)

### The bug

Two gaps in the config persistence pipeline caused `dangerouslySkipPermissions` (and other operational fields) to be silently dropped from `claude_local` agents:

1. **UI adapter type change**: `AgentConfigForm.tsx` only preserved 4 hardcoded `crossAdapterFields` when adapter type changed. Fields like `dangerouslySkipPermissions`, `maxTurnsPerRun`, `command`, `extraArgs`, `workspaceStrategy`, `workspaceRuntime` were silently dropped.
2. **Server had no `claude_local` default backfill**: `applyCreateDefaultsByAdapterType()` applied `dangerouslyBypassApprovalsAndSandbox` for `codex_local` but did nothing for `claude_local`.

### The fix

**Server** (`server/src/routes/agents.ts`): Added `claude_local` block in `applyCreateDefaultsByAdapterType()` that sets `dangerouslySkipPermissions` to `DEFAULT_CLAUDE_LOCAL_SKIP_PERMISSIONS` (true) when the field is missing.

**UI** (`ui/src/components/AgentConfigForm.tsx`): Expanded `crossAdapterFields` from 4 to 10 fields:
```typescript
const crossAdapterFields = [
  "env", "cwd", "timeoutSec", "graceSec",
  "dangerouslySkipPermissions", "maxTurnsPerRun",
  "command", "extraArgs",
  "workspaceStrategy", "workspaceRuntime",
] as const;
```

---

## How to add credentials / secrets to Paperclip agents

This section documents the exact process for adding new API credentials as encrypted secrets and wiring them to specific agents. Follow this every time — do not improvise.

### Architecture overview

- Secrets are stored encrypted (AES-256-GCM) in the `company_secrets` + `company_secret_versions` tables.
- The master key lives at `/paperclip/instances/default/secrets/master.key` inside the `paperclip-server-1` container on the VPS.
- Agent `adapter_config.env` references secrets via `{ "type": "secret_ref", "secretId": "<uuid>", "version": "latest" }`. The server decrypts and injects values at heartbeat runtime. Agents never see the raw keys in config.
- Non-sensitive env values (e.g. email addresses) can use `{ "type": "plain", "value": "..." }`.
- **The production API runs in `authenticated` mode** — direct REST calls require a board session. The only reliable path for scripted changes is the DB directly, using the encryption script below.

### Step 1 — Test the credentials before storing anything

Always verify credentials work before touching the database.

**Porkbun** uses two separate fields: `apikey` (starts `pk1_`) and `secretapikey` (starts `sk1_`). Ping endpoint requires both:
```bash
curl -s -X POST https://api.porkbun.com/api/json/v3/ping \
  -H "Content-Type: application/json" \
  -d '{"apikey":"pk1_...","secretapikey":"sk1_..."}'
# Expect: {"status":"SUCCESS","yourIp":"..."}
```

**Cloudflare** credentials use an **API Token** with `Authorization: Bearer`:
```bash
curl -s "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer <token>"
# Expect: {"result":{"status":"active"},"success":true,...}
```

Do not proceed to Step 2 until both tests return success.

### Step 2 — Identify the right agents

**Query the live DB for agents:**
```bash
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  root@64.176.199.162 \
  'docker exec paperclip-db-1 psql -U paperclip paperclip \
    -c "SELECT id, name, role, adapter_type FROM agents WHERE company_id='"'"'<company_id>'"'"' ORDER BY name;"'
```

**Rule:** Only give credentials to agents whose job description requires them. Do not give infrastructure credentials to non-devops agents even if they're senior. Current mapping:

| Credential type | Agent(s) that should receive it |
|---|---|
| DNS / domain (Porkbun, Cloudflare) | Senior Platform Engineer (devops) |
| GitHub tokens | Senior Platform Engineer (devops) |
| Cloud provider keys (Vultr, AWS, etc.) | Senior Platform Engineer (devops) |
| LLM API keys | Agent-specific (whoever uses that model) |

If unsure, give access to the Senior Platform Engineer only and let them delegate via task assignment.

**Get current adapter_config to see existing env before modifying:**
```bash
docker exec paperclip-db-1 psql -U paperclip paperclip \
  -c "SELECT adapter_config FROM agents WHERE id='<agent_id>';"
```

### Step 3 — Get company ID

```bash
docker exec paperclip-db-1 psql -U paperclip paperclip \
  -c "SELECT id, name, issue_prefix FROM companies;"
```
Current company: `DLD Ent.` — `f6b6dbaa-8d6f-462a-bde7-3d277116b4fb` — prefix `DLD`

### Step 4 — Write and run the encryption + injection script

The script must run inside `paperclip-server-1` because that's the only container with access to the master key file. It uses only Node.js built-ins (no `pg` package — write SQL output to a file, then pipe it into psql).

**Template (`/tmp/gen-secrets.mjs`):**
```js
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const MASTER_KEY_PATH = "/paperclip/instances/default/secrets/master.key";
const COMPANY_ID = "<company_id>";
const AGENT_ID = "<agent_id>";

const secrets = [
  { name: "my-service-api-key", value: "actual_key_here", description: "What it is and why" },
  // add more...
];

function decodeMasterKey(raw) {
  const trimmed = raw.trim();
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try { const d = Buffer.from(trimmed, "base64"); if (d.length === 32) return d; } catch {}
  if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  return null;
}

function encryptValue(masterKey, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { scheme: "local_encrypted_v1", iv: iv.toString("base64"), tag: tag.toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
function pgEsc(str) { return str.replace(/'/g, "''"); }

const masterKey = decodeMasterKey(readFileSync(MASTER_KEY_PATH, "utf8"));
if (!masterKey) throw new Error("Could not decode master key");

const sql = [];
for (const s of secrets) {
  const mat = pgEsc(JSON.stringify(encryptValue(masterKey, s.value)));
  const hash = sha256Hex(s.value);
  sql.push(`
DO $blk$
DECLARE sid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM company_secrets WHERE company_id='${COMPANY_ID}' AND name='${s.name}') THEN
    INSERT INTO company_secrets (company_id, name, provider, description, latest_version)
      VALUES ('${COMPANY_ID}', '${s.name}', 'local_encrypted', '${pgEsc(s.description)}', 1)
      RETURNING id INTO sid;
    INSERT INTO company_secret_versions (secret_id, version, material, value_sha256)
      VALUES (sid, 1, '${mat}'::jsonb, '${hash}');
    RAISE NOTICE 'Created secret: ${s.name} -> %', sid;
  ELSE
    RAISE NOTICE 'Secret already exists: ${s.name}';
  END IF;
END $blk$;`);
}

// Patch agent env — add one jsonb_build_object entry per new key
sql.push(`
DO $blk$
DECLARE
  key_id uuid;
  cur_config jsonb;
  new_env jsonb;
BEGIN
  SELECT id INTO key_id FROM company_secrets WHERE company_id='${COMPANY_ID}' AND name='my-service-api-key';
  SELECT adapter_config INTO cur_config FROM agents WHERE id='${AGENT_ID}';
  new_env := COALESCE(cur_config->'env', '{}'::jsonb)
    || jsonb_build_object(
         'MY_SERVICE_API_KEY', jsonb_build_object('type','secret_ref','secretId',key_id,'version','latest')
       );
  UPDATE agents SET adapter_config = cur_config || jsonb_build_object('env', new_env), updated_at = now() WHERE id='${AGENT_ID}';
  RAISE NOTICE 'Patched agent env';
END $blk$;`);

console.log(sql.join("\n"));
```

**Run it:**
```bash
# 1. SCP script to VPS
scp -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  /tmp/gen-secrets.mjs root@64.176.199.162:/tmp/gen-secrets.mjs

# 2. Copy into container, generate SQL, pipe to psql
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  root@64.176.199.162 \
  'docker cp /tmp/gen-secrets.mjs paperclip-server-1:/tmp/gen-secrets.mjs && \
   docker exec paperclip-server-1 node /tmp/gen-secrets.mjs 2>&1 | \
   docker exec -i paperclip-db-1 psql -U paperclip paperclip 2>&1'
```

Expected output for each secret: `NOTICE: Created secret: <name> -> <uuid>`
Expected output for agent patch: `NOTICE: Patched agent env`

### Step 5 — Verify

```bash
# Check secrets were created
docker exec paperclip-db-1 psql -U paperclip paperclip \
  -c "SELECT name, provider, description, created_at FROM company_secrets WHERE company_id='<company_id>' ORDER BY created_at;"

# Check agent env has the new refs
docker exec paperclip-db-1 psql -U paperclip paperclip -t \
  -c "SELECT adapter_config FROM agents WHERE id='<agent_id>';" \
  | python3 -m json.tool | grep -A4 "MY_SERVICE"
```

### Step 6 — Clean up

Delete temp files from the VPS host and the container immediately after. They contain plaintext credentials:

```bash
ssh root@64.176.199.162 'rm -f /tmp/gen-secrets.mjs'
# Also remove the local temp file
rm -f /tmp/gen-secrets.mjs
```

### Common mistakes to avoid

| Mistake | Reality |
|---|---|
| Providing only one Porkbun field | Porkbun requires both `apikey` (`pk1_...`) AND `secretapikey` (`sk1_...`). They are different. |
| Importing `readFileSync` from `node:crypto` | `readFileSync` is in `node:fs`, not `node:crypto`. The script will fail silently if you mix them. |
| Running the script on the VPS host (not in container) | The master key is inside the `paperclip-server-1` container, not on the host. `docker exec` is required. |
| Using `pg` package inside the container script | `pg` is not in the container's global `node_modules`. Output SQL and pipe to psql instead. |
| Giving DNS credentials to all agents | Only the Senior Platform Engineer (devops role) needs DNS/infra credentials. |
| Calling `docker exec ... psql` with shell quoting containing `'` | Use `'"'"'` for embedded single quotes in SSH commands, or use psql's `-f` flag with a temp file. |

### Current secrets inventory

**Working (encrypted with current master key):**

| Secret name | What it's for | Agent(s) with access |
|---|---|---|
| `github-token` | GitHub PAT for `nydamon` (v6) | Senior Platform Engineer |
| `rtaa-vps-ssh-key` | SSH private key for RTAA VPS (v2) | Senior Platform Engineer |
| `cloudflare-api-key` | Cloudflare API Token (v3) | Senior Platform Engineer |
| `vultr-api-key` | Vultr cloud API (v2) | Senior Platform Engineer |
| `porkbun-api-key` | Porkbun domain API key `pk1_...` (v2) | Senior Platform Engineer |
| `porkbun-secret-api-key` | Porkbun secret key `sk1_...` (v2) | Senior Platform Engineer |
| `rtaa-clerk-secret-key` | RTAA Clerk secret key (v2) | Senior Platform Engineer |
| `rtaa-clerk-publishable-key` | RTAA Clerk publishable key (v2) | Senior Platform Engineer |
| `viracue-stripe-test-publishable-key` | Stripe test publishable key for Viracue | CEO, CTO |
| `viracue-stripe-test-secret-key` | Stripe test secret key for Viracue | CEO, CTO |
| `viracue-stripe-live-publishable-key` | Stripe live publishable key for Viracue | CEO, CTO |
| `viracue-stripe-live-secret-key` | Stripe live secret key for Viracue | CEO, CTO |
| `paperclip-vps-ssh-key` | SSH private key for Paperclip VPS 64.176.199.162 (v1) | Senior Platform Engineer |

**Undecryptable (encrypted with lost master key — need plaintext to re-encrypt):**

| Secret name | What it's for | Previously used by |
|---|---|---|
| `github-token-fine-grained` | GitHub fine-grained token | Senior Platform Engineer |
| `github-token-viraforge` | GitHub PAT for `viraforge-ai` | Senior Platform Engineer |
| `gws-service-account-key` | Google Workspace service account JSON key with domain-wide delegation (42 scopes, project `gam-project-2oeyh`) | Senior Platform Engineer |
| `gws-oauth2-refresh-token` | Google Workspace OAuth2 refresh token for `damon@prsecurelogistics.com` (backup / user-level access) | Senior Platform Engineer |
| `gws-client-secret` | Google Workspace GAM OAuth2 client secret (project `gam-project-2oeyh`) | Senior Platform Engineer |
| `connie-wallet-private-key` | Connie wallet EVM private key (board approval needed) | Treasury Operator |

`GWS_CLIENT_ID`, `GWS_ADMIN_EMAIL`, and `GWS_DOMAIN` are stored as plain env values in the Senior Platform Engineer's adapter config (not sensitive).

`CLOUDFLARE_TOKEN` is a `secret_ref` in the Senior Platform Engineer's adapter config (injected as a Bearer token; no email header needed).

### Google Workspace notes

- **Domain**: `prsecurelogistics.com` — Customer ID `C020xhdcu`
- **Admin account**: `damon@prsecurelogistics.com`
- **GCP project**: `gam-project-2oeyh` (org: `605932361549`)
- **Service account**: `gam-project-2oeyh@gam-project-2oeyh.iam.gserviceaccount.com`
- **DWD client ID**: `105258313935190441372`
- **Auth method**: `GWS_SERVICE_ACCOUNT_JSON` is the primary credential. It contains a full service account key with domain-wide delegation across 42 scopes (Gmail, Drive, Calendar, Admin Directory, Groups, Reports, Chat, Meet, Docs, Sheets, etc.). This is non-expiring and does not require user interaction.
- **Fallback**: `GWS_OAUTH2_REFRESH_TOKEN` + `GWS_CLIENT_SECRET` + `GWS_CLIENT_ID` provide user-level OAuth2 access as `damon@prsecurelogistics.com`. Use this if service account DWD is insufficient for a specific API.
- **Org policy overrides**: `constraints/iam.disableServiceAccountKeyCreation` and `constraints/iam.disableServiceAccountKeyUpload` are overridden at project level (`enforce: false`) to allow the service account key to exist.
- **GAM**: Installed locally at `~/bin/gam7/gam`. Config at `~/.gam/`. Useful for ad-hoc Workspace admin commands from the dev machine.

### GitHub account notes

- `GITHUB_TOKEN` — classic PAT for `nydamon` (nydamon@gmail.com). Scopes: `repo, workflow`. `nydamon` is an **admin** of the `viraforge` org. Use for workflow triggers and as fallback.
- `GITHUB_TOKEN_FG` — fine-grained PAT for `nydamon`. Has **zero org memberships visible** (fine-grained PATs are resource-scoped). Do NOT use for `viraforge` org operations — it will 401/403.
- `GITHUB_TOKEN_VIRAFORGE` — classic PAT for `viraforge-ai` user (nydamon+paperclip@gmail.com). `viraforge-ai` is a **confirmed member of the `viraforge` org**. Use this for all ViraForge org repo creation, pushes, and code operations.

### GitHub token routing (which token to use for what)

**Policy: GitHub tokens are held exclusively by the Senior Platform Engineer. No other agent receives any GitHub token. Engineers that need a Git push must create a subtask for the Senior Platform Engineer.**

When the board needs to push a branch manually (e.g. a branch with `.github/workflows/` files that needs `workflow` scope), use the board-level push procedure documented below — do NOT give the token to the requesting agent.

| Operation | Token to use | Why |
|---|---|---|
| Push any branch containing `.github/workflows/` | `GITHUB_TOKEN` | Only classic PAT has `workflow` scope — fine-grained PATs will always 401 |
| Create/push to repo in `viraforge` org | `GITHUB_TOKEN_VIRAFORGE` | viraforge-ai is org member, keeps commits under ViraForge identity |
| Create/push to personal `nydamon` repos | `GITHUB_TOKEN` | Classic PAT; do NOT use `GITHUB_TOKEN_FG` — fine-grained PAT has no org visibility |
| GitHub Actions workflow triggers | `GITHUB_TOKEN` | has `workflow` scope |
| Fallback if VIRAFORGE token fails | `GITHUB_TOKEN` | nydamon is org admin with `repo` scope |

### Board-level push procedure (for workflow-scoped pushes)

When an agent reports "PAT missing workflow scope", the board should push manually:

```bash
# 1. Find which workspace has the branch
docker exec paperclip-server-1 bash -c '
  find /paperclip/instances/default/workspaces -name HEAD -path "*/.git/HEAD" | while read h; do
    repo=$(dirname $(dirname $h))
    branch=$(git -C "$repo" branch --list <branch-name> 2>/dev/null)
    [ -n "$branch" ] && echo "FOUND: $repo"
  done
'

# 2. Push using the workflow-scoped token (via board decrypt script)
# Use the decrypt-and-push pattern from the gen-secrets playbook.
# ALWAYS restore the remote URL to https://github.com/... after the push.
```

**Root cause of recurring "workflow scope" errors:** Agents that have both `GITHUB_TOKEN` and `GITHUB_TOKEN_FG` in their env tend to pick `GITHUB_TOKEN_FG` (fine-grained, no workflow scope) when pushing, causing 403s on workflow file changes. The permanent fix is to never give `GITHUB_TOKEN_FG` to any agent — if an agent needs Git push access at all, give them only `GITHUB_TOKEN`.

### GitHub org: `viraforge`

- `nydamon` — org admin
- `viraforge-ai` — org member (added 2026-03-14)
- The correct org name is `viraforge` (not `viraforge-labs` — that org does not exist)

---

## Connie Wallet Custody Chain (Phase 1)

Imported March 2026. Do not rotate or revoke without board approval.

### Asset facts

| Field | Value |
|-------|-------|
| Address | `0xa2e4B81f2CD154A0857b280754507f369eD685ba` |
| Network | Base mainnet (chain ID `8453`) |
| Token | USDbC (`0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`) |
| Balance at import | ~`$10.08 USDbC` |
| Source | Connie VPS `/root/.automaton-research-home/.automaton/wallet.json` |
| Owner | DLD Ent. board |

### Paperclip secret

| Field | Value |
|-------|-------|
| Secret name | `connie-wallet-private-key` |
| Secret ID | `bf9909ac-eb5a-452e-8bdb-e2d39194070f` |
| Provider | `local_encrypted` (AES-256-GCM, master key in `paperclip-server-1`) |
| Company ID | `f6b6dbaa-8d6f-462a-bde7-3d277116b4fb` (DLD Ent.) |

### Agent binding policy

| Env key | Type | Authorized agents |
|---------|------|-------------------|
| `CONNIE_WALLET_PRIVATE_KEY` | `secret_ref` | Treasury Operator (`d6f1aff9-8a41-4225-8ff2-fabc07e3476d`) only |
| `CONNIE_WALLET_ADDRESS` | `plain` | Any agent referencing wallet publicly |
| `CONNIE_WALLET_CHAIN_ID` | `plain` | Any agent |
| `CONNIE_WALLET_NETWORK` | `plain` | Any agent |
| `CONNIE_WALLET_TOKEN_CONTRACT` | `plain` | Any agent |

Only the CEO role can add or remove `secret_ref` bindings via `PATCH /api/agents/:id/permissions`.

### Wallet helper code

- `server/src/wallet/connie-wallet.ts` — `getAddressFromKey`, `validateWalletEnv`, `signMessageWithEnvKey`
- `server/src/wallet/signer-service.ts` — `SignerService` interface + phase-1 env shim; phase-2 target

### Revocation procedure

To stop signing access without destroying the secret:

```bash
# Remove secret_ref from Treasury Operator env (patch via DB or CEO-auth API)
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip \
    -c \"UPDATE agents SET adapter_config = adapter_config #- '{env,CONNIE_WALLET_PRIVATE_KEY}', updated_at = now() \
         WHERE id = 'd6f1aff9-8a41-4225-8ff2-fabc07e3476d';\""

# Confirm the key is gone from the agent env
docker exec paperclip-db-1 psql -U paperclip paperclip -t \
  -c "SELECT adapter_config->'env' FROM agents WHERE id='d6f1aff9-8a41-4225-8ff2-fabc07e3476d';"
```

The encrypted secret record is preserved for recovery. Delete the `company_secrets` row only if compromise is confirmed.

### Key rotation procedure

1. Generate a new EVM wallet on a secure, air-gapped machine.
2. Fund from current address via a Base bridge or direct transfer.
3. Import new key as a new version of `connie-wallet-private-key` via the gen-secrets script.
4. Update `CONNIE_WALLET_ADDRESS` plain value on all agents.
5. Confirm new address is resolving correctly in heartbeat logs.
6. Remove old key version (retain record; delete sensitive material only).

### Phase-2 migration path

See `server/src/wallet/signer-service.ts` for the `SignerService` interface. Phase-2 removes `CONNIE_WALLET_PRIVATE_KEY` from agent env entirely; agents call the signer service endpoint and never see the raw key.
