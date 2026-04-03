# Team Mode on Top of the Existing Company Model

## Summary

Implement a persisted company-level presentation mode, `organizationMode: "company" | "team"`, while keeping the existing internal company-scoped domain model, routes, and storage semantics intact.

The objective is to let Paperclip present itself as either:

- a company control plane, or
- a team control plane

without introducing a new top-level runtime abstraction, renaming existing APIs, or changing agent-role internals in this phase.

## Design decisions

### Keep `company` as the canonical internal container

The system remains company-scoped in:

- database structure
- REST routes
- shared API types
- permission checks
- activity and approval internals

That means this project intentionally keeps:

- `/companies`
- `companyId`
- `/agent-hires`
- `hire_agent`
- `approve_ceo_strategy`
- internal `ceo` role storage

This is deliberate. It minimizes merge conflicts with upstream and avoids a broad refactor that is not required to support the desired operator experience.

### Add one persisted presentation switch

Add `organizationMode` to the `companies` model with:

- allowed values: `"company" | "team"`
- default: `"company"`

This field is the only persisted switch required to choose the UI presentation mode.

### Make terminology presentation-only

Introduce a single shared terminology resolver in the UI so mode-aware copy does not spread as ad hoc `if` statements.

The resolver should cover at least:

- company -> team
- company goal -> team goal
- CEO -> Team Lead
- hire/new hire -> add teammate/new teammate
- org chart -> team chart
- board/operator approval copy -> operator approval copy
- CEO strategy -> team plan

Internal semantics remain unchanged even when labels change.

### Keep the root agent internally as `ceo`

In this phase:

- the first/root agent is still created with role `ceo`
- backend permission logic remains unchanged
- agent capability refactors are deferred

Team mode only changes how the operator sees that role, with `Team Lead` as the default label.

## Implementation shape

### Persistence and contracts

Update all company-related layers:

- `packages/db`
- `packages/shared`
- `server`
- portability import/export flows

The field must survive:

- company create/update/list/get
- export manifests
- import apply flows

### UI integration

Apply the terminology layer to the highest-traffic operator surfaces first:

- onboarding
- company settings
- company switcher and selection prompts
- dashboard empty states
- org views
- approval views
- new-agent flow
- selected agent detail copy where company-mode terms leak into operator-facing text

### Documentation and handoff

Materialize the task in:

- `docs/prd.md`
- `docs/plan.md`
- `docs/issues.md`

This file is the durable long-form reference for future Codex sessions and rebases.

## Deferred work

Out of scope for this implementation:

- new agent profile library
- replacing the “hire” interaction model structurally
- route aliases like `/teams`
- capability-model rewrite decoupling root privileges from `ceo`
- changing server-side error and event identifiers to team-neutral language
- full documentation rewrite across all product/spec docs

## Rebase strategy

To reduce upstream merge pain:

- keep `organizationMode` additive
- centralize UI copy in one helper
- avoid wide renames
- prefer narrow updates to top-level user-facing surfaces
- leave internal company-scoped semantics untouched

## Verification target

Run:

```text
pnpm -r typecheck
pnpm test:run
pnpm build
```

If verification exposes additional team/company copy leaks, treat them as targeted follow-up fixes rather than grounds for broad refactoring.
