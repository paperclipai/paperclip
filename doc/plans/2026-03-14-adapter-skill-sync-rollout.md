# 2026-03-14 Adapter Skill Sync Rollout

Status: Proposed
Date: 2026-03-14
Audience: Product and engineering
Related:
- `doc/plans/2026-03-14-skills-ui-product-plan.md`
- `doc/plans/2026-03-13-company-import-export-v2.md`
- `docs/companies/companies-spec.md`

## 1. Purpose

This document defines the rollout plan for adapter-wide skill support in Paperclip.

The goal is not just “show a skills tab.” The goal is:

- every adapter has a deliberate skill-sync truth model
- the UI tells the truth for that adapter
- Paperclip stores desired skill state consistently even when the adapter cannot fully reconcile it
- unsupported adapters degrade clearly and safely

## 2. Current Adapter Matrix

Paperclip currently has these adapters:

- `claude_local`
- `codex_local`
- `cursor_local`
- `gemini_local`
- `opencode_local`
- `pi_local`
- `openclaw_gateway`

The current skill API supports:

- `unsupported`
- `persistent`
- `ephemeral`

Current implementation state:

- `codex_local`: implemented, `persistent`
- `claude_local`: implemented, `ephemeral`
- `cursor_local`: not yet implemented, but technically suited to `persistent`
- `gemini_local`: not yet implemented, but technically suited to `persistent`
- `pi_local`: not yet implemented, but technically suited to `persistent`
- `opencode_local`: not yet implemented; likely `persistent`, but with special handling because it currently injects into Claude’s shared skills home
- `openclaw_gateway`: not yet implemented; blocked on gateway protocol support, so `unsupported` for now

## 3. Product Principles

1. Desired skills live in Paperclip for every adapter.
2. Adapters may expose different truth models, and the UI must reflect that honestly.
3. Persistent adapters should read and reconcile actual installed state.
4. Ephemeral adapters should report effective runtime state, not pretend they own a persistent install.
5. Shared-home adapters need stronger safeguards than isolated-home adapters.
6. Gateway or cloud adapters must not fake local filesystem sync.

## 4. Adapter Classification

### 4.1 Persistent local-home adapters

These adapters have a stable local skills directory that Paperclip can read and manage.

Candidates:

- `codex_local`
- `cursor_local`
- `gemini_local`
- `pi_local`
- `opencode_local` with caveats

Expected UX:

- show actual installed skills
- show managed vs external skills
- support `sync`
- support stale removal
- preserve unknown external skills

### 4.2 Ephemeral mount adapters

These adapters do not have a meaningful Paperclip-owned persistent install state.

Current adapter:

- `claude_local`

Expected UX:

- show desired Paperclip skills
- show any discoverable external dirs if available
- say “mounted on next run” instead of “installed”
- do not imply a persistent adapter-owned install state

### 4.3 Unsupported / remote adapters

These adapters cannot support skill sync without new external capabilities.

Current adapter:

- `openclaw_gateway`

Expected UX:

- company skill library still works
- agent attachment UI still works at the desired-state level
- actual adapter state is `unsupported`
- sync button is disabled or replaced with explanatory text

## 5. Per-Adapter Plan

### 5.1 Codex Local

Target mode:

- `persistent`

Current state:

- already implemented

Requirements to finish:

- keep as reference implementation
- tighten tests around external custom skills and stale removal
- ensure imported company skills can be attached and synced without manual path work

Success criteria:

- list installed managed and external skills
- sync desired skills into `CODEX_HOME/skills`
- preserve external user-managed skills

### 5.2 Claude Local

Target mode:

- `ephemeral`

Current state:

- already implemented

Requirements to finish:

- polish status language in UI
- clearly distinguish “desired” from “mounted on next run”
- optionally surface configured external skill dirs if Claude exposes them

Success criteria:

- desired skills stored in Paperclip
- selected skills mounted per run
- no misleading “installed” language

### 5.3 Cursor Local

Target mode:

- `persistent`

Technical basis:

- runtime already injects Paperclip skills into `~/.cursor/skills`

Implementation work:

1. Add `listSkills` for Cursor.
2. Add `syncSkills` for Cursor.
3. Reuse the same managed-symlink pattern as Codex.
4. Distinguish:
   - managed Paperclip skills
   - external skills already present
   - missing desired skills
   - stale managed skills

Testing:

- unit tests for discovery
- unit tests for sync and stale removal
- verify shared auth/session setup is not disturbed

Success criteria:

- Cursor agents show real installed state
- syncing from the agent Skills tab works

### 5.4 Gemini Local

Target mode:

- `persistent`

Technical basis:

- runtime already injects Paperclip skills into `~/.gemini/skills`

Implementation work:

1. Add `listSkills` for Gemini.
2. Add `syncSkills` for Gemini.
3. Reuse managed-symlink conventions from Codex/Cursor.
4. Verify auth remains untouched while skills are reconciled.

Potential caveat:

- if Gemini treats that skills directory as shared user state, the UI should warn before removing stale managed skills

Success criteria:

- Gemini agents can reconcile desired vs actual skill state

### 5.5 Pi Local

Target mode:

- `persistent`

Technical basis:

- runtime already injects Paperclip skills into `~/.pi/agent/skills`

Implementation work:

1. Add `listSkills` for Pi.
2. Add `syncSkills` for Pi.
3. Reuse managed-symlink helpers.
4. Verify session-file behavior remains independent from skill sync.

Success criteria:

- Pi agents expose actual installed skill state
- Paperclip can sync desired skills into Pi’s persistent home

### 5.6 OpenCode Local

Target mode:

- `persistent`

Special case:

- OpenCode currently injects Paperclip skills into `~/.claude/skills`

This is product-risky because:

- it shares state with Claude
- Paperclip may accidentally imply the skills belong only to OpenCode when the home is shared

Plan:

Phase 1:

- implement `listSkills` and `syncSkills`
- treat it as `persistent`
- explicitly label the home as shared in UI copy
- only remove stale managed Paperclip skills that are clearly marked as Paperclip-managed

Phase 2:

- investigate whether OpenCode supports its own isolated skills home
- if yes, migrate to an adapter-specific home and remove the shared-home caveat

Success criteria:

- OpenCode agents show real state
- shared-home risk is visible and bounded

### 5.7 OpenClaw Gateway

Target mode:

- `unsupported` until gateway protocol support exists

Required external work:

- gateway API to list installed/available skills
- gateway API to install/remove or otherwise reconcile skills
- gateway metadata for whether state is persistent or ephemeral

Until then:

- Paperclip stores desired skills only
- UI shows unsupported actual state
- no fake sync implementation

Future target:

- likely a fourth truth model eventually, such as remote-managed persistent state
- for now, keep the current API and treat gateway as unsupported

## 6. API Plan

## 6.1 Keep the current minimal adapter API

Near-term adapter contract remains:

- `listSkills(ctx)`
- `syncSkills(ctx, desiredSkills)`

This is enough for all local adapters.

## 6.2 Optional extension points

Add only if needed after the first broad rollout:

- `skillHomeLabel`
- `sharedHome: boolean`
- `supportsExternalDiscovery: boolean`
- `supportsDestructiveSync: boolean`

These should be optional metadata additions to the snapshot, not required new adapter methods.

## 7. UI Plan

The company-level skill library can stay adapter-neutral.

The agent-level Skills tab must become adapter-aware by copy and status:

- `persistent`: installed / missing / stale / external
- `ephemeral`: mounted on next run / external / desired only
- `unsupported`: desired only, adapter cannot report actual state

Additional UI requirement for shared-home adapters:

- show a small warning that the adapter uses a shared user skills home
- avoid destructive wording unless Paperclip can prove a skill is Paperclip-managed

## 8. Rollout Phases

### Phase 1: Finish the local filesystem family

Ship:

- `cursor_local`
- `gemini_local`
- `pi_local`

Rationale:

- these are the closest to Codex in architecture
- they already inject into stable local skill homes

### Phase 2: OpenCode shared-home support

Ship:

- `opencode_local`

Rationale:

- technically feasible now
- needs slightly more careful product language because of the shared Claude skills home

### Phase 3: Gateway support decision

Decide:

- keep `openclaw_gateway` unsupported for V1
- or extend the gateway protocol for remote skill management

My recommendation:

- do not block V1 on gateway support
- keep it explicitly unsupported until the remote protocol exists

## 9. Definition Of Done

Adapter-wide skill support is ready when all are true:

1. Every adapter has an explicit truth model:
   - `persistent`
   - `ephemeral`
   - `unsupported`
2. The UI copy matches that truth model.
3. All local persistent adapters implement:
   - `listSkills`
   - `syncSkills`
4. Tests cover:
   - desired-state storage
   - actual-state discovery
   - managed vs external distinctions
   - stale managed-skill cleanup where supported
5. `openclaw_gateway` is either:
   - explicitly unsupported with clean UX
   - or backed by a real remote skill API

## 10. Recommendation

The recommended immediate order is:

1. `cursor_local`
2. `gemini_local`
3. `pi_local`
4. `opencode_local`
5. defer `openclaw_gateway`

That gets Paperclip from “skills work for Codex and Claude” to “skills work for the whole local-adapter family,” which is the meaningful V1 milestone.
