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
- Current state: foundational metadata, ownership, filters, visibility primitives, structured handoffs, explicit workflow-state modeling, and the first operator controls in `IssueProperties` are now in place; `Resume` now records the existing `resumed` workflow state instead of clearing context, and the current control set has focused summary/history verification; remaining gap is broader control coverage plus the rest of the operational views

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
- [ ] Reassign owner cleanly
- [x] Mark waiting
- [x] Mark blocked on upstream
- [ ] Escalate
- [x] Resume
- [ ] Close loop / resolve handoff
- [x] Verify control actions update summaries/state correctly

### 4. Ownership and operational views
- [ ] View/filter for work owned by Main
- [ ] View/filter for work owned by Ork
- [ ] View/filter for work owned by Stitch
- [ ] View/filter for work owned by Personal OS
- [ ] View/filter for needs-human-attention
- [ ] View/filter for blocked/stalled work
- [ ] View/filter for recent handoffs

### 5. Task history / orchestration context
- [ ] Durable history for meaningful handoffs and state changes
- [ ] Clear latest meaningful actor/update display
- [ ] Avoid transcript-noise creep in summaries
- [ ] Verify history remains high-signal and compact

### 6. OpenClaw integration glue and delegation rules
- [ ] Define how Main creates/updates Paperclip tasks
- [ ] Define how Ork/Stitch/Personal OS publish structured handoffs
- [ ] Define identity mapping between OpenClaw agents and Paperclip ownership fields
- [ ] Define when work stays in chat vs becomes a tracked Paperclip task
- [ ] Define how task status sync should work
- [ ] Define specialty-based routing rules across Main, Ork, Stitch, and Personal OS
- [ ] Ensure Personal OS defers product/build implementation work to Main/Ork/Stitch instead of owning it directly
- [ ] Ensure Main remains the coordination surface while Ork owns engineering execution and Stitch owns design/product-specialist work
- [ ] Define delegation triggers and handoff rules so cross-agent routing happens predictably instead of ad hoc
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
- Finish the remaining operator controls: reassign owner cleanly, escalate, close loop / resolve handoff
- Then ownership and operational views for blocked/stalled/recent-handoff work
- After that, verify history remains high-signal and compact under more real multi-agent usage

## Current blockers
- No hard blocker right now
- Main remaining gap is the rest of the control actions plus operational views and broader history verification on top of the workflow-state foundation

## Update rule for Ork
When meaningful progress lands, Ork should update this checklist with:
- what is complete
- what is in progress
- any blocker
- next recommended slice

Do not mark the feature done just because code exists. It is done when the orchestration workflow is actually usable.
