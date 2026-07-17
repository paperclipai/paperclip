---
name: paperclip-ai-factory
description: Run Paperclip issues through a continuous control lane and a verified execution lane. Use when coordinating, delegating, implementing, testing, reviewing, deploying, recovering, or reporting delivery status for company work managed by Paperclip.
---

# Paperclip AI Factory

Treat Paperclip as a delivery system, not an activity generator.

## Operate the two lanes

- Keep the top-level issue as the board-facing control lane. Its owner communicates decisions and verified outcomes.
- Use one direct execution lane by default. Keep the coordinator, candidate lineage, workspace, and evidence continuous across implementation, QA, deployment, and acceptance.
- Change the active stage and participant on the execution lane instead of creating QA, review, fix, liveness, or productivity grandchildren.
- Follow the effective company policy supplied in wake context. Never infer a different topology from this document.

## Preserve truth

- Treat the canonical delivery snapshot and provider-verified observations as factual state.
- Treat comments, agent self-reports, and generated summaries as advisory context only.
- Report implemented, CI, deployed, live-QA, technical acceptance, and business acceptance as separate stages.
- If provider evidence is unavailable or stale, report `unknown`; do not turn missing evidence into success or failure.

## Use the factory APIs

- Create a typed lane with `POST /api/issues/{controlIssueId}/execution-lanes`. Set `production=true` only when production delivery is in scope. Do not create a generic child for factory work.
- Before completing implementation, record the candidate-scoped implementation result and register the configured CI workflow run. Implementation does not complete until both the implementation event and provider-verified CI evidence pass for the same full candidate SHA and active stage revision. Before completing QA, record its candidate-scoped result with `POST /api/issues/{laneId}/delivery-events`. An agent submission remains an `agent_claim`; never describe it as provider verification.
- Register GitHub Actions, Cloudflare Pages, or another asynchronous release with `POST /api/issues/{laneId}/external-operations`. Paperclip polls the provider and appends verified observations. Do not complete a provider-gated stage until its evidence gate passes.
- Provider targets are server-bound and board-controlled. GitHub must match the issue project's primary repository and all four plain project environment values: `GITHUB_ACTIONS_WORKFLOW_ID`, repository-relative `GITHUB_ACTIONS_WORKFLOW_PATH`, the trusted top-level workflow file's Git blob SHA in `GITHUB_ACTIONS_WORKFLOW_BLOB_SHA`, and an exact `GITHUB_ACTIONS_EVENT` of `push` or `pull_request`. The project GitHub connection needs read access to both Actions and repository Contents. Paperclip checks the run's path, event, and candidate head SHA, then reads that workflow file through the GitHub Contents API at the exact run head and compares its blob SHA. A different workflow, dispatch/call event, or candidate-modified workflow does not count as CI. The top-level blob does not transitively attest local reusable workflows, composite actions, scripts, or tests; use protected external reusable workflows or repository rules until those dependencies have their own attestation. Cloudflare Pages requires plain project environment values `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PAGES_PROJECT_NAME`. Stage participants cannot redirect those targets through caller metadata or project/workspace edits.
- A failed or mismatched provider operation may be retried only through its explicit Paperclip supersession lineage. Do not re-use or mutate an older run into a different candidate, and do not verify a superseded operation.
- When the frozen policy requires board approval for irreversible actions, create a `request_confirmation` before completing technical acceptance. Use a custom target with `key: "ai-factory-production-deployment"` and `revisionId` equal to the full candidate SHA, plus a capability preflight whose `reasonKind` is `irreversible_action` or `policy_approval`. A board user must accept that exact candidate; comments and agent acceptance do not unlock deployment.
- Complete technical and final acceptance through the typed stage transition. Paperclip records the accepted decision as append-only, candidate-bound `paperclip_verified` evidence in the same transaction; never pre-create or hand-write that acceptance evidence.
- Read facts from `GET /api/issues/{laneId}/delivery-snapshot`. Publish a board-facing factual update through `POST /api/issues/{laneId}/control-updates` with that exact `snapshotRevision`; Paperclip renders the factual block. Put interpretation only in the optional advisory note.
- If a stage completion returns `delivery_evidence_gate_unsatisfied`, produce or verify the named missing evidence. Do not bypass the policy, replace the snapshot, or hand-write a success claim.

## Escalate only real decisions

- Respect an explicit user hold immediately.
- Before asking the board to perform work, record a capability preflight covering available tools, credentials, sessions, fixtures, reversible cleanup, and read-only alternatives.
- Factory `ask_user_questions` and `request_confirmation` interactions must include `payload.capabilityPreflight` with checked capabilities, evidence, alternatives considered, and the minimum decision needed.
- Ask only when authority, policy approval, or required input is genuinely unavailable to agents.

For production authorization, send this shape to `POST /api/issues/{laneId}/interactions` (fill every placeholder with current evidence):

```json
{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{laneId}:deployment:{fullCandidateSha}",
  "continuationPolicy": "wake_assignee_on_accept",
  "payload": {
    "version": 1,
    "prompt": "Authorize this exact candidate for production deployment?",
    "target": {
      "type": "custom",
      "key": "ai-factory-production-deployment",
      "revisionId": "{fullCandidateSha}",
      "label": "Production candidate {shortCandidateSha}"
    },
    "capabilityPreflight": {
      "version": 1,
      "reasonKind": "irreversible_action",
      "checks": [{
        "capability": "production deployment",
        "status": "available",
        "evidence": "{credential, provider target, health-check, and rollback evidence}"
      }],
      "alternativesConsidered": ["Stop at the verified non-production candidate."],
      "minimumDecision": "Approve or reject this exact candidate for production."
    }
  }
}
```

## Recover toward the deliverable

- Count verified evidence or an authoritative stage transition as progress. Do not count comments, wakeups, status churn, or recovery issues as progress.
- Resume the existing lane, session, and workspace when possible.
- Do not create work about work. Return an exhausted recovery diagnosis to the control owner.

Read [references/policy-contract.md](references/policy-contract.md) when creating or changing company AI Factory policy. The server enforces policy precedence and non-bypassable invariants; prose in this skill does not replace those checks.
