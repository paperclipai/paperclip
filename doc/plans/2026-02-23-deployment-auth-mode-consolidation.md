# Deployment/Auth Mode Consolidation Plan

Status: Proposal  
Owner: Server + CLI + UI  
Date: 2026-02-23

## Goal

Keep Paperclip low-friction while making the mode model simpler and safer:

1. `local_trusted` remains the default and easiest path.
2. one authenticated runtime mode supports both private-network local use and public cloud use.
3. onboarding/configure/doctor stay primarily interactive and flagless.
4. Board identity is represented by a real user row in the database, with explicit role/membership integration points.

## Product Constraints (From Review)

1. `onboard` default flow is interactive (no flags required).
2. first mode choice defaults to `local_trusted`, with clear UX copy.
3. authenticated flow gives guidance for private vs public exposure.
4. `doctor` should also be flagless by default (read config and evaluate the selected mode/profile).
5. do not add backward-compatibility alias layers for abandoned mode names.
6. plan must explicitly cover how users/Board are represented in DB and how that affects task assignment and permissions.

## Current Implementation Audit (As Of 2026-02-23)

## Runtime/Auth

- Runtime deployment modes are currently `local_trusted | cloud_hosted` (`packages/shared/src/constants.ts`).
- `local_trusted` actor is currently synthetic:
  - `req.actor = { type: "board", userId: "local-board", source: "local_implicit" }` (`server/src/middleware/auth.ts`).
  - this is not a real auth user row by default.
- `cloud_hosted` uses Better Auth sessions and `authUsers` rows (`server/src/auth/better-auth.ts`, `packages/db/src/schema/auth.ts`).

## Bootstrap/Admin

- `cloud_hosted` requires `BETTER_AUTH_SECRET` and reports bootstrap status from `instance_user_roles` (`server/src/index.ts`, `server/src/routes/health.ts`).
- bootstrap invite acceptance promotes the signed-in user to `instance_admin` (`server/src/routes/access.ts`, `server/src/services/access.ts`).

## Membership/Assignment Integration

- User task assignment requires active `company_memberships` entry for that user (`server/src/services/issues.ts`).
- Local implicit board identity is not automatically a real membership principal; this is a gap for “board as assignable user” semantics.

## Proposed Runtime Model

## Modes

1. `local_trusted`
- no login required
- localhost/loopback only
- optimized for single-operator local setup

2. `authenticated`
- login required for human actions
- same auth stack for both private and public deployments

## Exposure Policy (Within `authenticated`)

1. `private`
- private-network deployments (LAN, VPN, Tailscale)
- low-friction URL handling (`auto` base URL)
- strict host allow policy for private targets

2. `public`
- internet-facing deployments
- explicit public base URL required
- stricter deployment checks in doctor

This is one authenticated mode with two safety policies, not two different auth systems.

## UX Contract

## Onboard (Primary Path: Interactive)

Default command remains:

```sh
pnpm paperclipai onboard
```

Interactive server step:

1. ask mode with default selection `local_trusted`
2. copy for options:
- `local_trusted`: "Easiest for local setup (no login, localhost-only)"
- `authenticated`: "Login required; use for private network or public hosting"
3. if `authenticated`, ask exposure:
- `private`: "Private network access (for example Tailscale), lower setup friction"
- `public`: "Internet-facing deployment, stricter security requirements"
4. only if `authenticated + public`, ask for explicit public URL

Flags are optional power-user overrides, not required for normal setup.

## Configure

Default command remains interactive:

```sh
pnpm paperclipai configure --section server
```

Same mode/exposure questions and defaults as onboarding.

## Doctor

Default command remains flagless:

```sh
pnpm paperclipai doctor
```

Doctor reads configured mode/exposure and applies relevant checks.
Optional flags may exist for override/testing, but are not required for normal operation.

## Board/User Data Model Integration (Required)

## Requirement

Board must be a real DB user principal so user-centric features (task assignment, membership, audit identity) work consistently.

## Target Behavior

1. `local_trusted`
- seed/ensure a deterministic local board user row in `authUsers` during setup/startup.
- actor middleware uses that real user id instead of synthetic-only identity.
- ensure:
  - `instance_user_roles` includes `instance_admin` for this user.
  - company membership can be created/maintained for this user where needed.

2. `authenticated`
- Better Auth sign-up creates user row.
- bootstrap/admin flow promotes that real user to `instance_admin`.
- first company creation flow should ensure creator membership is active.

## Why This Matters

- `assigneeUserId` validation checks company membership.
- without a real board user + membership path, assigning tasks to board user is inconsistent.

## Configuration Contract (Target)

- `server.mode`: `local_trusted | authenticated`
- `server.exposure`: `private | public` (required when mode is `authenticated`)
- `auth.baseUrlMode`: `auto | explicit`
- `auth.publicBaseUrl`: required when `authenticated + public`

No compatibility aliases for discarded naming variants.

## No Backward-Compatibility Layer

This change is a clean cut:

- remove use of old split terminology in code and prompts.
- config schema uses only canonical fields/values above.
- existing dev instances can rerun onboarding or update config once.

## Implementation Phases

## Phase 1: Shared Schema + Config Surface

- `packages/shared/src/constants.ts`: define canonical mode/exposure constants.
- `packages/shared/src/config-schema.ts`: add mode/exposure/auth URL fields.
- `server/src/config.ts` and CLI config types: consume canonical fields only.

## Phase 2: CLI Interactive UX

- `cli/src/prompts/server.ts`: implement defaulted mode prompt and authenticated exposure guidance copy.
- `cli/src/commands/onboard.ts`: keep interactive-first flow; optional overrides only.
- `cli/src/commands/configure.ts`: same behavior for server section.
- `cli/src/commands/doctor.ts`: mode-aware checks from config, flagless default flow.

## Phase 3: Runtime/Auth Policy

- `server/src/index.ts`: enforce mode-specific startup constraints.
- `server/src/auth/better-auth.ts`: implement `auto` vs `explicit` base URL behavior.
- host/origin trust helper for `authenticated + private`.

## Phase 4: Board Principal Integration

- add ensure-board-user startup/setup step:
  - real local board user row
  - instance admin role row
- ensure first-company creation path grants creator membership.
- remove synthetic-only assumptions where they break user assignment/membership semantics.

## Phase 5: UI + Docs

- update UI labels/help text around mode and exposure guidance.
- update docs:
  - `doc/DEPLOYMENT-MODES.md`
  - `doc/DEVELOPING.md`
  - `doc/CLI.md`
  - `doc/SPEC-implementation.md`

## Test Plan

- config schema tests for canonical mode/exposure/auth fields.
- CLI prompt tests for default interactive selections and copy.
- doctor tests by mode/exposure.
- runtime tests:
  - authenticated/private works without explicit URL
  - authenticated/public requires explicit URL
  - private host policy rejects untrusted hosts
- Board principal tests:
  - local_trusted board user exists as real DB user
  - board can be assigned tasks via `assigneeUserId` after membership setup
  - creator membership behavior for authenticated flows

## Acceptance Criteria

1. `pnpm paperclipai onboard` is interactive-first and defaults to `local_trusted`.
2. authenticated mode is one runtime mode with `private/public` exposure guidance.
3. `pnpm paperclipai doctor` works flagless with mode-aware checks.
4. no extra compatibility aliases for dropped naming variants.
5. Board identity is represented by real DB user/role/membership integration points, enabling consistent task assignment and permission behavior.

## Verification Gate

Before merge:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```
