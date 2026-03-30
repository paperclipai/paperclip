# Claude/Codex Promotion and OpenClaw Legacy Plan

## Overview

Paperclip should clearly promote two supported day-one agent paths:

1. `claude_local`
2. `codex_local`

Generic remote HTTP remains available as an advanced/manual integration path,
but it is no longer part of the primary product story. OpenClaw remains legacy
until it can be removed safely.

## Goals

1. Make the Paperclip product story reflect `Claude + Codex` as the promoted
   paths.
2. Keep the generic `http` adapter available without presenting it as a
   first-class onboarding recommendation.
3. Keep existing `openclaw_gateway` agents readable and editable long enough to
   migrate them.
4. Delete OpenClaw-specific docs, routes, packages, smoke tests, and tests once
   the replacement path is settled.

## Non-Goals

1. Shipping a dedicated Hermes adapter right now.
2. Auto-migrating existing OpenClaw agents without operator review.
3. Reworking every remote-agent workflow before OpenClaw cleanup lands.

## Key Decisions

1. `claude_local` and `codex_local` are the only promoted agent paths.
2. The generic `http` adapter remains supported only for advanced/manual remote
   integrations.
3. `openclaw_gateway` is treated as a legacy adapter during the transition.
4. Hermes work is deferred until the Hermes API server is actually deployed on
   the host and ready to integrate.

## Execution Phases

### Phase 1: Story and Defaults

Update the repo so the visible product story matches the intended stack.

Scope:

- Rewrite README and adapter docs around Claude and Codex as the primary paths.
- Keep generic `http` available in advanced/manual configuration only.
- Mark OpenClaw labels as legacy instead of presenting them as current.
- Remove Hermes-specific copy from promoted UI, onboarding, and skill guidance.

Success criteria:

- No primary new-agent path recommends OpenClaw.
- README no longer frames Hermes as a primary Paperclip path.
- Existing OpenClaw agents still render cleanly in the UI.

### Phase 1.5: Backend Generalization

Close the gap between the simplified Claude/Codex story and the still
OpenClaw-shaped runtime surfaces.

Scope:

- Generalize the invite/bootstrap path so remote-agent onboarding is not tied to
  `/companies/:companyId/openclaw/invite-prompt`.
- Update `skills/paperclip/SKILL.md` so agents do not treat OpenClaw as the
  normal remote-agent flow.
- Keep generic `http` onboarding text adapter-agnostic.
- Define replacement remote-agent smoke coverage before removing OpenClaw smoke
  scripts.
- Decide whether any additional Docker/runtime install path is needed for future
  remote integrations.

Success criteria:

- Remote-agent onboarding is adapter-agnostic.
- Paperclip skills no longer teach OpenClaw as the normal remote-agent path.
- The repo clearly distinguishes promoted paths from advanced/manual ones.

### Phase 2: Legacy Removal

Remove OpenClaw-specific runtime and onboarding infrastructure.

Scope:

- Delete OpenClaw invite/onboarding docs and replace them with migration notes.
- Remove OpenClaw-specific server invite flows and helper logic.
- Remove `packages/adapters/openclaw-gateway`.
- Remove OpenClaw smoke scripts, fixtures, and tests.
- Remove OpenClaw-specific adapter registry entries and constants.

Success criteria:

- No code path can create or execute `openclaw_gateway`.
- No docs instruct operators to onboard OpenClaw.
- Test suite and build pass without the OpenClaw package.

### Deferred: Future Hermes Work

Hermes is not part of the current promoted scope. If Hermes becomes relevant
again later:

- do not build `hermes_remote` until the Hermes API server is actually deployed
  on the host
- verify the live auth and protocol shape against the deployed host, not just
  docs
- decide then whether Paperclip should talk to Hermes directly or through an
  operator-managed bridge

## File Inventory

### First-Wave Files

- `README.md`
- `docs/adapters/overview.md`
- `ui/src/components/NewAgentDialog.tsx`
- `ui/src/components/OnboardingWizard.tsx`
- `ui/src/components/AgentConfigForm.tsx`
- `ui/src/components/AgentProperties.tsx`
- `ui/src/components/agent-config-primitives.tsx`
- `ui/src/pages/NewAgent.tsx`
- `ui/src/pages/Agents.tsx`
- `ui/src/pages/InviteLanding.tsx`

### Legacy Removal Targets

- `doc/OPENCLAW_ONBOARDING.md`
- `docs/guides/openclaw-docker-setup.md`
- `server/src/routes/access.ts`
- `server/src/routes/agents.ts`
- `server/src/adapters/registry.ts`
- `ui/src/adapters/openclaw-gateway/*`
- `packages/adapters/openclaw-gateway/*`
- `scripts/smoke/openclaw-*`
- `docker/openclaw-smoke/*`
- OpenClaw-specific tests under `server/src/__tests__`

### Wave 1.5 Targets

- `server/src/routes/access.ts`
- `skills/paperclip/SKILL.md`
- `scripts/smoke/openclaw-*`
- `Dockerfile`

## Verified Wave 1.5 Gaps

1. The invite prompt endpoint is OpenClaw-specific:
   `/api/companies/{companyId}/openclaw/invite-prompt`.
2. The OpenClaw join path includes WebSocket-specific config, device signing,
   and `sessionKeyStrategy`, which are not covered by generic `http`.
3. Non-local adapters do not get Paperclip JWTs automatically; remote adapter
   auth must still be designed explicitly when needed.
4. `skills/paperclip/SKILL.md` still needs to keep OpenClaw isolated as a
   legacy-only flow.
5. Four OpenClaw smoke scripts still define the current remote-agent regression
   coverage.
6. The runtime/Docker story currently installs local CLIs but has no future
   remote-runtime install path.

## Verification

Before considering Phase 1 complete:

1. `http` remains available through advanced/manual flows.
2. Hermes no longer appears in promoted onboarding or skill copy.
3. OpenClaw is no longer recommended anywhere in README or primary docs.
4. Existing `openclaw_gateway` agents still show a clear legacy label.
