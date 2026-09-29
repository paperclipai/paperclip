# Fresh Runner first-time-user acceptance plan

Date: 2026-09-12. Baseline: c9021c6721f91e2c74bd9fee9d3fd41c999d17b7 (fresh worktree).

User: a first-time Paperclip operator who wants useful work from an agent without learning runner internals or manually managing task status.

Environment: isolated test-drive instance, disposable company and tasks, real API-backed Codex and Claude Code providers, local and Daytona execution. Onboarding/bootstrap fixtures are setup, not an onboarding acceptance result. Task submission and user follow-ups are performed through the production browser interface. No special completion-tool instructions are added to user prompts.

## Stories and acceptance

1. Get a concise useful response. Create an ordinary task asking for three practical onboarding tips. Expect a visible answer, a settled Done status, and no generic completion approval.
2. Refine finished work. Return to the completed task and request a shorter result. Expect one continuation, retained context, and automatic completion.
3. Answer a real clarification. Ask the agent to ask a preference before writing a short deliverable. Expect an understandable question, answer submission, one continuation, and the deliverable without status bookkeeping.
4. Stop and change direction. Stop a long-running disposable task, then give a different short request. Expect old work to stop and the new message to proceed without losing it or requiring another message.
5. Pause during startup. Pause a newly launched task, resume, and continue. Expect no execution behind the pause and no permanent startup hold.
6. Survive an interruption. Interrupt only the isolated test runner/controller during harmless ongoing work. Expect truthful recovery feedback and either automatic continuation or one actionable retry that preserves the conversation.
7. Use and revisit output. Ask for a small file, inspect its exposed artifact/file link, refresh and revisit. Expect usable persistent output and accurate status.

Run basic completion and follow-up on all four provider/environment combinations. Exercise clarification, stop/resume, startup cancellation, and interruption where setup permits, explicitly documenting gaps and how long each stuck state was observed. Do not call a blocked environment a successful run.

## Evidence and report

Keep the original prompt, browser actions, task/run identifiers, elapsed times, UI screenshots, and supporting read-only API evidence. Report observed surprises separately from diagnostic hypotheses. Each finding includes reproduction, expected/actual behavior, impact, screenshot, and a proposed general product rule for discussion. The initial phase excluded product fixes; the approved implementation phase below supersedes that limit.

Related PRs reviewed: #13314 (explicit completion reviews), #13316 (startup cancellation fence), #13261 (healthy native session lifetime), #13254 (remote stop continuation), #13239 (new messages after native stop), #13163 (remote restart recovery). Existing automated runner cases contain explicit tool/completion instructions; these user stories deliberately use ordinary language.

## Product-rule decisions

All eight rules were accepted by the user. Product implementation and a fresh live report are authorized, in this same fresh worktree.

1. **Crash recovery.** Recover automatically after verifying the old execution has stopped. Preserve completed work and queued messages. If an outcome remains uncertain, show a clear blocker and an actionable recovery path. Do not blindly replay actions whose outcomes are uncertain.
2. **Completion permissions.** Task-scoped delivery and completion work in every permission profile, without granting unrelated command, filesystem, or external-action authority. Explicit human reviews remain required.
3. **Delivered answers.** Preserve delivered answers. Recovery adds a distinct update or correction. Streaming drafts may change while unfinished.
4. **Task status.** A crash that prevents progress is Blocked. In Review requires a specific human decision, such as a real review or clarification.
5. **Composer.** Reconcile submission identity with durable server receipts automatically after navigation/reload. Only genuinely unresolved delivery needs user attention.
6. **Stop.** Stop the current response and keep the composer usable for a new direction. Pause future work is a separate explicit action. Ordinary cancellation has neutral feedback.
7. **Startup identity.** Bind provider identity before accepting events. Retry safe startup failures internally within a bounded budget; preserve integrity checks.
8. **Workspace contention.** Present routine scheduling contention as Waiting for workspace, with useful context, rather than cancellation/failure.

## Implementation and verification

Fix shared causes in submission persistence, execution lifecycle/projection, provider permission plumbing, event identity, and transcript identity. Add regression tests at the relevant boundaries, including negative authority/idempotency cases. Run targeted checks first, then the repository typecheck/test/build checks appropriate to the broad change. Rebuild and rerun the original natural-language journeys in the isolated app with local Codex and Claude Code and compatible Daytona environments. Retain before/after evidence, report remaining limits explicitly, and clean up disposable remote resources.

## Retest outcome

The implementation was exercised through the ordinary browser task flow with local Codex, local Claude Code, Codex in Daytona, and Claude Code in Daytona. Each completed a plain-language request and follow-up. The interrupted Codex task recovered from a deliberately killed local Codex runner without a Retry click, new message, or controller restart. A separate task proved Stop followed by a new completed request. A fresh clarification task proved real questions and one-answer continuation, including after reopening Done. The open task refreshed a newly delivered file automatically, and shared Daytona workspace contention displayed neutral waiting.

Additional fixes cover live artifact query invalidation, passive waiting on a direct user comment that reopens completed work, and draft text entered during an in-flight submission. The database restart path now verifies the owned PostgreSQL port and data directory before migration. This was prompted by an isolation incident: the QA server briefly connected to another development database and applied migrations 0273/0274 before the wrong company was noticed. No test task was created there; no rollback of another developer's work was attempted.

Historical ambiguous executions were retained, not force-replayed or manually marked successful. Their old task statuses were not backfilled. Automatic crash replacement was proven only for the narrowly verified local Codex case; remote crash recovery and Claude controller-restart recovery are not claimed. Simple Claude Daytona responses remained slow in this sample. The local acceptance report and selected evidence were delivered through artifact work products, with explicit limits and before/after observations. Disposable Daytona sandbox cleanup was completed.
