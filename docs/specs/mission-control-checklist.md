# Paperclip Mission Control Checklist

> Source of truth for the mission-control feature on branch `feat/mission-control-customization-lane`.

## Goal
Lock the full Paperclip mission-control feature into an explicit tracked checklist so Ork can update it until the feature is complete and ready for real use.

## Definition of done
This feature is only done when:
- Paperclip can represent multi-agent ownership, collaboration, handoffs, waiting/blocking, and human-attention cleanly
- Main/Ork/Stitch/Personal OS orchestration can map into Paperclip without relying on transcript archaeology
- Telegram-visible summaries can emerge from structured state instead of manual retelling
- the implementation is verified well enough to start using on real tracked work

## Current status snapshot
- Branch: `feat/mission-control-customization-lane`
- Implementation owner: `ork`
- Product/orchestration owner: `main`
- Current state: foundational metadata, ownership, filters, visibility primitives, and structured handoffs are now in place; next slice is task/control-plane state modeling

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
- [ ] Decide and implement orchestration-specific states or equivalent conventions
- [ ] Support waiting-on-human
- [ ] Support blocked-on-upstream
- [ ] Support handed-off / resumed flows
- [ ] Make state transitions legible in UI/API
- [ ] Add verification for state transitions

### 3. Operator control actions
- [ ] Reassign owner cleanly
- [ ] Mark waiting
- [ ] Escalate
- [ ] Resume
- [ ] Close loop / resolve handoff
- [ ] Verify control actions update summaries/state correctly

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

### 6. OpenClaw integration glue
- [ ] Define how Main creates/updates Paperclip tasks
- [ ] Define how Ork/Stitch/Personal OS publish structured handoffs
- [ ] Define identity mapping between OpenClaw agents and Paperclip ownership fields
- [ ] Define when work stays in chat vs becomes a tracked Paperclip task
- [ ] Define how task status sync should work

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
- Task/control-plane state model for waiting-on-human, blocked-on-upstream, handed-off, and resumed flows
- Then operator actions that drive those states cleanly

## Current blockers
- No hard blocker right now
- Main remaining gap is workflow/state modeling rather than raw metadata plumbing

## Update rule for Ork
When meaningful progress lands, Ork should update this checklist with:
- what is complete
- what is in progress
- any blocker
- next recommended slice

Do not mark the feature done just because code exists. It is done when the orchestration workflow is actually usable.
