# EMA-1 Corrective Wake and Disposition Audit

## Provenance

| Field | Value |
|---|---|
| Date | 2026-07-19 |
| Instance | `email-clean-20260719` |
| Company | `Email` (`15f8fb0a-065d-4e2b-9d24-a49d986dcaf8`, prefix `EMA`) |
| Subject issue | `EMA-1` (`61847d4b-ef94-4782-a5c6-a176fb763fac`) |
| Derived issue | `EMA-2` (`97ea21c8-1d34-45d9-b12f-9b720d10c8f8`) |
| Agent | `Email Operations Lead` (`38c74e59-59e3-4d39-b3ad-6dd94288ab95`, `opencode_local`, model `openrouter/deepseek/deepseek-chat`) |
| Code ref | `upstream/master = f12bb27bcd1b36148090d6922a85bf1611d327e0` (read-only `git show`) |
| Source | Kimi K3 live-instance audit. No code modified. |

**Verdict (one line):** every mechanism observed is native upstream behavior working exactly as designed; the loop was caused by the agent never recording a valid issue disposition, amplified by an unrelated OpenCode auxiliary-model failure.

---

## 1. Observed Behavior (Live Evidence)

Timeline reconstructed from the live API (`/api/issues/...`, `/api/issues/{id}/runs`, `/api/issues/{id}/comments`):

| Time (UTC) | Event |
|---|---|
| 18:38:59 | EMA-1 created ("Hire your first engineer and create a hiring plan", originKind `manual`, requestDepth 0) and assigned. Assignment wake fires. |
| 18:38:59 - 18:39:34 | Run 1 **succeeds** (35s). Agent drafts a hiring plan, saves `plan.md`, ends with: "Let me know if you'd like to review or modify it." **No status transition.** |
| 18:39:34+ | System posts "Paperclip needs a disposition before this issue can continue." and queues a corrective wake (`invocationSource: automation`). |
| 18:39:34 - 18:53:37 | **45 runs in 15 minutes**, alternating succeed (~25-35s) / fail (~7s), all `automation` after the first `assignment`. Each success re-drafts the plan and again omits the disposition; each success triggers a new corrective wake. |
| 18:42:00 | 10 issue-linked runs inside 1h -> productivity-review service fires `high_churn` -> creates **EMA-2** "Review productivity for EMA-1" (originKind `issue_productivity_review`, priority high, parent EMA-1, requestDepth 1). |
| 18:53:30 | System still posting disposition requests; `successfulRunHandoff.state = required`, `correctiveRunId 7fa8fde7`, live run `8316f477` holding the execution lock. |

Key live records:

- `EMA-1.successfulRunHandoff.detectedProgressSummary`: *"Next action noted: Let me create a hiring plan for the first engineer role following the specified format:"* - the server correctly detected the run ended mid-work with no disposition.
- `EMA-1.productivityReview.trigger`: **`high_churn`** (not no-comment streak). EMA-2's evidence block: "10 runs/5 assignee-run comments in 1h... Total sampled issue-linked runs: 10; cost events total: 2 cents."
- Run comments show the agent produced a competent hiring plan **five separate times**, each time ending conversationally instead of transitioning the issue.
- One succeeded-run comment exposes the amplifier: *"The issue appears to be with the configured OpenCode model (`openai/gpt-5.1-codex-mini`) being unavailable. Available models include deepseek/deepseek-chat..."*
- Agent config: `runtimeConfig.heartbeat.enabled = false` (timer off; wakes were assignment + automation only), `dangerouslySkipPermissions: true`, managed instructions bundle, **no `paperclipSkillSync.desiredSkills`**. Usage samples confirm the primary model was billed correctly: `openrouter/deepseek/deepseek-chat`, biller `openrouter`, ~$0.003-0.007/run, `freshSession: true` on every sampled run.

## 2. Q1 - Is This Expected Upstream Behavior?

**Yes, all three observed mechanisms are native upstream safety nets.** Nothing is branch-specific; the fork's 11 commits touch none of these files.

| Mechanism | Upstream source |
|---|---|
| Successful-run handoff detection + corrective wake + system comments | `server/src/services/recovery/service.ts`, `server/src/services/recovery/successful-run-handoff.ts` |
| Productivity-review sub-task | `server/src/services/productivity-review.ts` (origin kind `RECOVERY_ORIGIN_KINDS.issueProductivityReview`, `server/src/services/recovery/origins.ts`) |
| Amber UI notice ("A run finished successfully, but this task is still open in `in_progress` with no clear owner for the next action.") | `ui/src/components/IssueBlockedNotice.tsx` (~line 537), driven by the issue's `successfulRunHandoff` state |

This is the control plane doing its job: it detected a missing disposition, attempted a bounded automated correction, escalated to a human-visible review when the pattern became pathological, and told the operator exactly how to resolve it.

## 3. Q2 - Exact Condition That Triggers the Corrective Wake

From `successful-run-handoff.ts` and `recovery/service.ts`:

1. A run finishes with status `succeeded` while its issue remains in a non-terminal state **without a valid disposition**.
2. Valid dispositions (enumerated in the exhausted-handoff notice): `done`/`cancelled`; `in_review` with an owner; `blocked` with first-class blockers (a blocker owner); delegated follow-up work; or an explicit continuation path. The missing-disposition label here was the default `clear_next_step`.
3. The server then: posts the system comment "Paperclip needs a disposition before this issue can continue.", marks `successfulRunHandoff.required = true`, and enqueues a corrective wake with `wakeReason = finish_successful_run_handoff` (`FINISH_SUCCESSFUL_RUN_HANDOFF_REASON`).
4. Bound: `DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1` **per source run**. When a corrective run itself completes without a disposition, the handoff is exhausted and the server posts the escalation notice ("Paperclip exhausted the bounded corrective handoff..."), with the prescribed manager action: "choose and record a valid issue disposition without copying transcript content."

**Why 45 runs despite the bound:** the bound resets with each new source run. The observed cycle was self-perpetuating:

```text
run succeeds (no disposition)
  -> corrective wake
  -> corrective run FAILS fast (~7s, OpenCode auxiliary-model error)
  -> failure retry / next wake
  -> run SUCCEEDS, re-drafts plan, STILL no disposition
  -> NEW source run => handoff counter restarts at attempt 1
  -> repeat
```

The productivity-review trigger was the loop's exhaust, not its cause: >= 10 issue-linked runs within a rolling 1h window (`DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY = 10`; sibling thresholds: 30/6h, no-comment streak 10, long-active 6h). Creation is rate-limited (`maxCreationsPerWindow = 1` per 24h), which is why exactly one EMA-2 exists.

## 4. Q3 - Why the Agent Did Not Move EMA-1 to Review or Done

Evidence points to agent execution behavior, not a server defect:

1. **Conversational termination.** Every sampled comment ends as a chat message ("Let me know if you'd like to review or modify it.") rather than an API mutation. The Paperclip operating procedure (`skills/paperclip/SKILL.md`, embedded in the managed instructions bundle) requires the final-disposition checklist: deliver work, then set `done` / `in_review` / `blocked`. The model (`deepseek-chat` via OpenRouter) performed the work but consistently skipped the disposition step.
2. **Fresh session every run.** Usage samples show `freshSession: true`, `sessionReused: false` on all sampled runs, so each corrective run re-entered with no memory of the prior attempt and simply re-did the task (five hiring-plan drafts) instead of closing it.
3. **Auxiliary-model failures killed the corrective runs.** The alternating ~7s failures coincide with OpenCode reporting its configured auxiliary model `openai/gpt-5.1-codex-mini` as unavailable (no OpenAI credentials are configured; only OpenRouter is). With no `opencode.json` present, this is OpenCode's internal default small/title model; the adapter validates only the primary model (`ensureOpenCodeModelConfiguredAndAvailable`, `packages/adapters/opencode-local/src/server/models.ts`), so the aux-model failure surfaces as a run failure. (Evidence boundary: `~/.local/share/opencode/auth.json` was not inspected, by credential-handling policy.)

## 5. Q4 - Responsible Layer

| Candidate | Responsible? | Evidence |
|---|---|---|
| Server workflow / recovery engine | **No - behaved as designed** | Detection, bounded wake, escalation, and review creation all match upstream code and produced accurate notices. |
| Onboarding prompt (EMA-1 text) | **No** | The task description was clear and the agent completed the substantive work. |
| Adapter configuration (primary model) | **No** | `openrouter/deepseek/deepseek-chat` was applied and billed correctly on every successful run. |
| OpenCode CLI environment | **Contributing cause** | Unavailable default aux model `openai/gpt-5.1-codex-mini` -> the fast alternating run failures that kept the loop alive. |
| Agent execution behavior (model + instructions adherence) | **Primary cause** | Disposition step skipped on every successful run; work repeated from scratch each fresh session. |

## 6. Q5 - Is the Productivity-Review Sub-task Native Upstream?

**Yes, native upstream.** `server/src/services/productivity-review.ts` builds `Review productivity for <identifier>` issues with origin kind `issue_productivity_review`, full evidence (trigger reasons, run/comment windows, cost, usage samples), and a "Manager Decision" footer offering exactly four resolutions: close as productive, snooze, request decomposition/reroute, or stop the source work. Code creates the review issue with `status: "todo"`; EMA-2 is observed `blocked`, consistent with the recovery-owner blocking path while the source issue lacks a disposition. It is assigned to the same agent with `requestDepth = 1` (bounded by `clampIssueRequestDepth`). The fork contributed nothing here.

## 7. Q6 - Smallest Upstream-Compatible Fix (Configuration Only, No Code)

Ordered by effect:

1. **Break the loop now: record a valid disposition on EMA-1.** Move EMA-1 to `in_review` with the board as reviewer (the drafted hiring plan is already in comments), or `done` if accepted. This is the server's own prescribed manager action and immediately clears `successfulRunHandoff.required`, stopping corrective wakes.
2. **Resolve EMA-2 via its Manager Decision** (close as productive with a note, or snooze) once EMA-1 has a disposition. Do not delete it; it is the audit trail of this incident.
3. **Fix the OpenCode auxiliary model** so corrective runs stop failing: set OpenCode's small/title model to an OpenRouter-available model (OpenCode config `small_model`, e.g. an `openrouter/...` identifier), or provider-disable it. Root cause of every ~7s failed run.
4. **Harden the agent's disposition behavior:** attach an explicit operating skill via `adapterConfig.paperclipSkillSync.desiredSkills` (catalog id format `paperclipai/bundled/paperclip-operations/<slug>`; relevant slugs observed: `issue-triage`, `task-planning`) and/or add one line to the agent's instructions: every run must end with a status transition (`in_review` at minimum), never with a question.
5. **Consider model tier for the CEO.** Per the model-routing policy, the CEO role is exactly where a stronger model is justified; `deepseek-chat` is appropriate for triage/routine roles but followed the operating procedure poorly here.
6. **Set budgets** (company budget is currently `0` = no hard stop). A per-agent monthly budget would have converted this runaway into an automatic pause - the platform's intended last line of defense.

## Recommended Next Action

**Set a valid disposition on EMA-1 manually - move it to `in_review` with `local-board` as reviewer.** One board action; it clears the handoff requirement, stops the corrective-wake loop immediately, preserves all evidence, and matches the resolution path printed by the recovery system itself. Then apply items 2-4 before the next wake.
