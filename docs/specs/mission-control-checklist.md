# Paperclip Mission Control Checklist

> Source of truth for the mission-control feature on branch `feat/mission-control-customization-lane`.

## Goal
Lock the full Paperclip mission-control feature into an explicit tracked checklist so Ork can update it until the feature is complete and ready for real use.

## Definition of done
This feature is only done when:
- Paperclip can represent multi-agent ownership, collaboration, handoffs, waiting/blocking, and human-attention cleanly
- Main/Ork/Stitch/Personal OS orchestration can map into Paperclip without relying on transcript archaeology
- OpenClaw agents actually delegate by specialty instead of loosely overlapping, for example Personal OS routes product/build implementation work to Main/Ork/Stitch rather than trying to own it
- Telegram-visible summaries can emerge from structured state instead of manual retelling
- the implementation is verified well enough to start using on real tracked work

## Current status snapshot
- Branch: `feat/mission-control-customization-lane`
- Implementation owner: `ork`
- Product/orchestration owner: `main`
- Current state: foundational metadata, ownership, filters, visibility primitives, structured handoffs, explicit workflow-state modeling, the first operator controls in `IssueProperties`, and the first operational inbox views are now in place; `Resume` now records the existing `resumed` workflow state instead of clearing context, `Resolve handoff` now clears active handoff state through the same issue update surface and keeps handoff/history wording legible, `Reassign owner` now promotes the active handoff target through the same owner/mission-control plumbing so ownership stays clean, `Escalate` now raises `needsHumanAttention` through the same minimal mission-control payload while preserving any existing workflow state, `Inbox` now exposes practical operational view chips for the broader operator queue, Main/Ork/Stitch/Personal OS owner slices when those agents exist, needs-human, blocked/waiting, and recent handoffs by reusing the existing issue filter/view plumbing, the operator queue now stays high-signal in mixed inbox batches by limiting that view to mission-control ownership/attention/handoff/workflow lanes instead of every open issue, the latest handoff-summary lane now treats structured `issue.handoff_updated` activity as the durable handoff/history source instead of letting reviewer/approver churn masquerade as mission-control handoffs, the latest activity-summary lane now ignores generic `issue.comment_added` churn so neither run-linked transcript comments nor plain manual operational comments overwrite fresher mission-control workflow-state updates, realistic mixed mission-control run coverage now verifies that structured handoffs remain durable while `needsHumanAttention` escalations summarize as a compact high-signal activity instead of falling back to generic task-detail wording, and the dedicated OpenClaw integration spec now also defines the first durable specialty-routing policy: `Main` stays the coordination surface, `Ork` owns engineering execution, `Stitch` owns design/product-specialist execution, `Personal OS` is restricted to personal/admin support, and delegation triggers/handoff defaults are explicit on the existing mission-control issue surface

## Checklist

### 0. Foundation already landed
- [x] Mission-control metadata support on issues
- [x] `ownerAgentId` support on issues
- [x] collaborator agent support
- [x] `needsHumanAttention` support
- [x] source-of-truth / blocker / next-step issue metadata editing
- [x] owner + attention filtering
- [x] compact issue activity/handoff summaries
- [x] dependency install + targeted tests/typechecks passing for landed slices

### 1. Structured handoffs
- [x] Define first-class handoff shape in shared types/schema
- [x] Persist handoff data cleanly in DB/storage path
- [x] Support handoff create/update/read through server/API
- [x] Render handoff information in useful UI surfaces
- [x] Ensure handoffs include: from, to, reason, requested next step, unblock condition, timestamp, issue context
- [x] Add tests/typechecks for handoff shape and usage

### 2. Task/control-plane state model
- [x] Decide and implement orchestration-specific states or equivalent conventions
- [x] Support waiting-on-human
- [x] Support blocked-on-upstream
- [x] Support handed-off / resumed flows
- [x] Make state transitions legible in UI/API
- [x] Add verification for state transitions

### 3. Operator control actions
- [x] Reassign owner cleanly
- [x] Mark waiting
- [x] Mark blocked on upstream
- [x] Escalate
- [x] Resume
- [x] Close loop / resolve handoff
- [x] Verify control actions update summaries/state correctly

### 4. Ownership and operational views
- [x] View/filter for work owned by Main
- [x] View/filter for work owned by Ork
- [x] View/filter for work owned by Stitch
- [x] View/filter for work owned by Personal OS
- [x] View/filter for needs-human-attention
- [x] View/filter for blocked/stalled work
- [x] View/filter for recent handoffs
- [x] Validate the operator queue against mixed Main/Ork/Stitch/Personal OS workflow fixtures so generic open-issue noise stays out

### 5. Task history / orchestration context
- [x] Durable history for meaningful handoffs and state changes
- [x] Clear latest meaningful actor/update display
- [x] Avoid transcript-noise creep in summaries
- [x] Verify history remains high-signal and compact

### 6. OpenClaw integration glue and delegation rules
- [x] Define how Main creates/updates Paperclip tasks
- [x] Define how Ork/Stitch/Personal OS publish structured handoffs
- [x] Define identity mapping between OpenClaw agents and Paperclip ownership fields
- [x] Define when work stays in chat vs becomes a tracked Paperclip task
- [x] Define how task status sync should work
- [x] Define specialty-based routing rules across Main, Ork, Stitch, and Personal OS
- [x] Ensure Personal OS defers product/build implementation work to Main/Ork/Stitch instead of owning it directly
- [x] Ensure Main remains the coordination surface while Ork owns engineering execution and Stitch owns design/product-specialist work
- [x] Define delegation triggers and handoff rules so cross-agent routing happens predictably instead of ad hoc
- [ ] Verify delegation behavior with at least one real cross-agent scenario

### 7. Telegram emergence and behavior
- [ ] Map Paperclip structured state to Telegram summary output
- [ ] Define which events surface automatically
- [ ] Define blocker/approval/milestone emergence rules
- [ ] Keep low-level chatter suppressed by default
- [ ] Verify summary mode vs transparent mode behavior

### 8. Real-use readiness
- [ ] Run end-to-end test of Main -> Ork handoff through Paperclip
- [ ] Run cross-agent scenario involving at least one specialist handoff
- [ ] Run a needs-human-attention scenario
- [ ] Run a blocked/resume scenario
- [ ] Confirm the feature is usable for real tracked work
- [ ] Decide whether to open PR / merge / continue iteration

## Current recommended next slice
- Verify the routing policy with at least one real cross-agent scenario, preferably one where `Personal OS` surfaces work that must be rerouted through `Main` to `Ork` or `Stitch`

## Current blockers
- No hard blocker for the docs/spec slice that just landed
- Repo-wide `pnpm -r typecheck` is currently blocked by an unrelated duplicate DB migration number (`0057_gentle_mission_control.sql` and `0057_tidy_join_requests.sql`)
- Broader verification hit an unrelated existing ordering-sensitive failure in `server/src/__tests__/issues-service.test.ts` (`wakes parents only when all direct children are terminal` expects a different `childIssueIds` order)
- Main remaining gap is real-use OpenClaw integration validation on top of the now-specified identity, structured-update boundary, status-sync contract, and specialty-routing/delegation policy

## Update rule for Ork
When meaningful progress lands, Ork should update this checklist with:
- what is complete
- what is in progress
- any blocker
- next recommended slice

Do not mark the feature done just because code exists. It is done when the orchestration workflow is actually usable.
