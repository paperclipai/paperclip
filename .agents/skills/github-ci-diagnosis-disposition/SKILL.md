---
name: github-ci-diagnosis-disposition
description: >
  Close a GitHub CI or runner diagnosis issue without stranding infra work or
  fake wake paths. Use after read-only CI/log diagnosis when the fix is outside
  the diagnosing agent's code scope, or when disposition repair must not credit
  a handoff without durable follow-up.
metadata:
  author: ARTeMob eval
  version: "1.0"
  audit: "2026-11-02 ART-368 disposition pattern (ART-331 family)"
allowed-tools: Bash(gh:*) Bash(git:*) Bash(curl:*)
---

# GitHub CI Diagnosis Disposition

Finish **read-only CI or self-hosted runner diagnosis** with a durable owner and
a verifiable Paperclip disposition. The anti-pattern from audit 2026-11-02:
correct diagnosis marked `done` with no infra successor issue, plus
provider-error retry timers or prose monitors that are not task-bound.

This skill adds **process only**. It does not change product gates, overlays, or
ART-114 policy. It complements [Fix Failed Paperclip Run](../fix-failed-paperclip-run/SKILL.md)
(code repair) and the [Paperclip](../../skills/paperclip/SKILL.md) final-disposition rules.

## When to use

- The task scope is **diagnosis only** (logs, `gh` check inventory, root-cause write-up).
- The fix requires **infra, runners, secrets, or human operator** action outside your branch.
- You are about to set status `done`, `in_review`, or `blocked` on a diagnosis issue tied to GitHub CI.

## When not to use

- You will land the fix in the same PR on the same issue — use `github-pr-workflow` / `prcheckloop` instead.
- The failure is an application bug you can patch — use `fix-failed-paperclip-run`.
- You need to change workflow YAML without an explicit task — stop and escalate.

## Governance envelope (read first)

Before any closing PATCH, align with:

1. Company **Paperclip native workflow**: ordinary Git branches, PR audit trail, no fake admin blockers.
2. Repository **`skills/paperclip/SKILL.md`** — final-disposition checklist, verified PATCH writes, monitors only after `executionPolicy.monitor` persists `monitorNextCheckAt`.
3. **`doc/execution-semantics.md`** — bounded original-owner disposition repair; no handoff credited without durable source-state change or real follow-up owner.

If diagnosis and repair must split across issues, **successor first, then close diagnosis**.

---

## Checklist A — Infra successor before `done`

Complete every item before `PATCH {"status":"done"}` on the diagnosis issue.

| # | Gate | Pass criterion |
| --- | --- | --- |
| A1 | **Classify fix owner** | Root cause is infra/host/runner/quota/secrets/operator — not mergeable code on your branch. |
| A2 | **Create successor issue** | `POST /api/companies/{companyId}/issues` with `parentId` = diagnosis issue (or ART-331 family goal if directed). Title names the infra action and links the failing check or run id. |
| A3 | **Human or infra owner** | Successor has `responsibleUserId` **or** is in the infra project with an named human owner in the description — not an unassigned `todo` with no owner. |
| A4 | **Self-contained handoff** | Successor description includes: failing workflow/job names, PR or branch, head SHA, log object or `gh run view` id, and acceptance criteria for GREEN. |
| A5 | **Link evidence on diagnosis** | Diagnosis issue comment lists successor identifier and id; diagnosis `done` comment repeats the link. |
| A6 | **No blind reruns** | Diagnosis scope forbids rerunning CI to “see if it passes” unless the task explicitly authorizes it. |

**Canonical pattern (ART-368):** diagnosis `ART-368` (runner self-hosted read-only) should have spawned infra successor `ART-370` (repair localdev-light runners) **before** diagnosis closed. Closing without A2–A4 repeats the audit finding.

Optional: set `blockedByIssueIds` on the diagnosis issue only when the diagnosis task itself must wait on the successor — usually the diagnosis closes `done` once A2–A5 hold and the successor owns execution.

---

## Checklist B — RED / GREEN and exact runs

Record commands and outputs in the issue thread (redact secrets).

### RED (reproduce the failure signal)

Run on the **same head SHA** the diagnosis covers:

```bash
gh pr view "$PR_NUMBER" --json number,headRefOid,url,statusCheckRollup
HEAD_SHA=$(gh pr view "$PR_NUMBER" --json headRefOid -q .headRefOid)
gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/commits/${HEAD_SHA}/check-runs" \
  --jq '.check_runs[] | {name, conclusion, details_url, started_at}'
gh run list --branch "$(gh pr view "$PR_NUMBER" --json headRefName -q .headRefName)" --limit 10
```

RED passes when you can name:

- At least one check or workflow with `conclusion: failure` (or pending beyond task SLA) at `HEAD_SHA`.
- The primary failed job and **first** error line from `gh run view RUN_ID --log-failed` (or hosted log URL).

### GREEN (diagnosis complete without stranding work)

GREEN for **closing the diagnosis issue** requires **both**:

1. **Successor gate (Checklist A)** satisfied and verified via API:
   ```bash
   curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
     "$PAPERCLIP_API_URL/api/issues/$SUCCESSOR_ID" \
     | jq '{identifier, status, responsibleUserId, assigneeAgentId, parentId, title}'
   ```
2. **Diagnosis artifact**: comment or issue document with root cause, owner class (infra vs code), and explicit “out of scope for this issue” boundary.

GREEN is **not**: green CI on a later rerun unless the task scope included fixing CI; **not** a comment promising someone will fix runners later.

Pair with [`prcheckloop`](../prcheckloop/SKILL.md) only on the **successor** issue that owns the code or infra fix PR.

---

## Checklist C — Disposition repair regression guard

Use this when the diagnosis run hit **provider errors**, **deliberate wait**, or **disposition repair** scheduling — the ART-331 family bug is crediting handoff without code or without a live wake path.

| # | Guard | Fail if |
| --- | --- | --- |
| C1 | **No prose-only monitor** | Comment says “watch CI” or “timer will retry” but `monitorNextCheckAt` is null on GET issue. |
| C2 | **No unbound provider-error loop** | Run ended with provider quota/busy errors and no successor issue **and** no persisted monitor bound to this task's execution policy. |
| C3 | **Disposition repair honesty** | You claim repair completed but no durable source-state change and no successor/code PR exists — same as `unchanged_source_state_exhausted` escalation path. |
| C4 | **Verified close** | Use `scripts/paperclip-issue-update.sh` from the installed Paperclip skill; empty PATCH body = failed write. |
| C5 | **Regression oracle** | After product changes to recovery, run targeted tests: `pnpm --filter @paperclipai/server exec vitest run server/src/__tests__/heartbeat-retry-scheduling.test.ts -t disposition` and disposition repair cases in `server/src/services/recovery/` / `issue-disposition-repair` suites when touching related code. |

If C1–C3 fail, prefer `in_progress` with a real monitor **or** `blocked` with `blockedByIssueIds` pointing at the successor — never `done`.

Read [`references/art-368-audit-pattern.md`](references/art-368-audit-pattern.md) for the worked audit narrative.

---

## Closing PATCH template

Use one PATCH with status and comment (Paperclip skill rule):

```json
{
  "status": "done",
  "comment": "Diagnosis complete.\n\n- Root cause: …\n- Failing checks at HEAD_SHA: …\n- Out of scope here: infra/runner fix\n- Successor: ART-XXX (id …) owner …\n- RED evidence: gh run …\n- Disposition: no unbound timers; successor owns GREEN."
}
```

---

## Related skills

- [`check-pr`](../check-pr/SKILL.md) — review comments and check rollup on a fix PR (successor issue).
- [`diagnose-why-work-stopped`](../diagnose-why-work-stopped/SKILL.md) — entry to `fix-failed-paperclip-run` when work stalled mid-flight.
- [`prepare-paperclip-pr`](../prepare-paperclip-pr/SKILL.md) — ship skill/doc changes with template and green checks.
