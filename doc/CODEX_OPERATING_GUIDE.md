# Paperclip Codex Operating Guide

This guide defines the repo-local operating surface for Codex work in Paperclip.
It is intentionally narrower than the product docs. Use it to decide what to read,
how much context to carry, which prompt shape to use, and how to split work safely.

## 1. First-Read Bundle

Start with the minimum bundle below before non-trivial work:

1. `AGENTS.md`
2. `README.md`
3. `SESSION_HANDOFF.md`
4. `doc/GOAL.md`
5. `doc/PRODUCT.md`
6. `doc/SPEC-implementation.md`
7. `doc/DEVELOPING.md`
8. `doc/DATABASE.md`

Then narrow further by task type.

## 2. Task-Type Read Sets

### Harness / Config / Docs Work

Read:

1. `AGENTS.md`
2. `SESSION_HANDOFF.md`
3. `doc/CODEX_OPERATING_GUIDE.md`
4. only the specific workflow/config/script files being changed

Focus on:

- repo-local Codex surface
- verification commands
- rollback path
- CI and hook entrypoints

### Schema / DB Work

Read:

1. first-read bundle
2. `packages/db/src/schema/**` touched area
3. `packages/db/src/schema/index.ts`
4. affected migrations
5. any matching shared/server/ui contract surface

Focus on:

- company scoping
- migration/export completeness
- downstream contract sync

### API / Contract Work

Read:

1. first-read bundle
2. touched route/service files in `server/`
3. touched validators/types/constants in `packages/shared/`
4. any affected UI callers in `ui/src/api` and page/component consumers

Focus on:

- company boundary checks
- approval boundary
- consistent HTTP semantics
- activity logging for mutations

### UI Work

Read:

1. first-read bundle
2. touched UI page/component/api files
3. matching server route or shared contract surface
4. `ui/src` local design patterns only as needed

Focus on:

- company selection context
- visible failure states
- contract alignment with server/shared

### Prompt / Skill / Evals Work

Read:

1. first-read bundle
2. `skills/paperclip/SKILL.md`
3. relevant `skills/**/references/*`
4. `evals/README.md`
5. relevant prompt/eval files only

Focus on:

- checkout discipline
- `409` handling
- approval behavior
- company boundary
- minimizing repeated hot-path instruction surface

### Docs / Spec Work

Read:

1. first-read bundle
2. exact doc file(s) being updated
3. the nearest source-of-truth implementation files when a behavior claim is involved

Focus on:

- additive updates
- drift reduction
- no speculative product claims

## 3. Minimal Context Surface

Default to the smallest context that can safely support the task.

Rules:

- Do not load whole directories when a few files answer the question.
- Prefer current implementation files over older plan docs unless you are explicitly updating a plan.
- Prefer one task-type read set plus the touched files, not every doc in the repo.
- For follow-up edits, refresh only the touched surface and any contract neighbors.
- Use `SESSION_HANDOFF.md` to carry active state instead of re-reading broad unrelated history.

## 4. Context Budget

Use this repo-local budget unless real evidence requires more:

- start with the first-read bundle
- add only one task-type read set
- add only touched implementation files and their direct contract neighbors
- stop expanding once the task is decision-complete

Signs you are over-reading:

- you are pulling in long-horizon docs without touching their surface
- you are reading both `server`, `ui`, `db`, and `shared` when only one layer is changing
- you are reading multiple old plans to answer a present implementation question

## 5. Request Templates

Use the following structure for all non-trivial work:

```md
Goal:

Scope:

Constraints:

Done-When:

Verification:

Rollback:
```

### Schema Change Template

```md
Goal:
Update the Paperclip data model for [specific capability].

Scope:
- touched schema files
- schema export
- migrations
- directly affected shared/server/ui contract layers only

Constraints:
- preserve company scoping
- do not break control-plane invariants
- do not modify unrelated schema or migrations

Done-When:
- schema compiles
- exports are updated
- migration status is explicit
- impacted contract layers are synced

Verification:
- pnpm db:generate (if schema changed)
- pnpm -r typecheck
- pnpm test:run
- pnpm build

Rollback:
- git restore changed schema/export/migration files
- remove generated migration files in reverse order if they were created in this slice
```

### API / Contract Change Template

```md
Goal:
Adjust a Paperclip route or shared contract for [specific behavior].

Scope:
- touched shared/server files
- directly affected ui callers if any

Constraints:
- company boundary checks must remain explicit
- approval boundary must remain explicit where relevant
- mutating routes must keep activity logging
- no unrelated endpoint cleanup

Done-When:
- route behavior and shared contracts match
- affected UI callers compile
- error semantics stay explicit

Verification:
- pnpm run check:paperclip:fast
- pnpm -r typecheck
- pnpm test:run
- pnpm build

Rollback:
- git restore changed shared/server/ui files
```

### UI Change Template

```md
Goal:
Update a Paperclip UI surface for [specific user-facing behavior].

Scope:
- touched ui files
- directly affected shared/server contract files only if needed

Constraints:
- keep company selection context correct
- surface failures clearly
- preserve existing product contract

Done-When:
- UI behavior matches the request
- API callers stay aligned
- build remains green

Verification:
- pnpm run check:paperclip:fast
- pnpm -r typecheck
- pnpm build
- targeted UI proof if applicable

Rollback:
- git restore changed ui/shared/server files
```

### Control-Plane Invariant Change Template

```md
Goal:
Adjust behavior touching a control-plane invariant.

Scope:
- only the files required for the invariant change
- direct contract and test coverage only

Constraints:
- explicitly review:
  - single-assignee task model
  - atomic checkout semantics
  - approval gates
  - budget hard-stop auto-pause
  - activity logging for mutations

Done-When:
- the invariant impact is documented
- affected routes/services/tests are aligned
- no silent weakening of company or approval boundaries

Verification:
- pnpm run check:paperclip:fast
- pnpm -r typecheck
- pnpm test:run
- pnpm build

Rollback:
- git restore changed files
- revert any generated artifacts in reverse order
```

### Docs / Spec Change Template

```md
Goal:
Reduce drift in Paperclip docs for [specific topic].

Scope:
- exact docs being updated
- nearest implementation source of truth only

Constraints:
- additive update preferred
- do not rewrite strategic docs wholesale
- do not claim behavior without file-backed evidence

Done-When:
- doc claims match current repo truth
- related commands and verification steps are current

Verification:
- review touched implementation files against the new wording
- run the smallest relevant commands if the doc references them

Rollback:
- git restore changed doc files
```

## 6. Agentic Workflow

Default workflow:

- main lane owns scope lock, implementation, integration, and final answer
- reader lane gathers file-backed facts
- checker lane validates commands/tests/CI impact

Prefer `main + reader/checker` when:

- the task is non-trivial and non-destructive
- there is independent read-only analysis
- verification can run in parallel with implementation

Split reviewer/tester lane when:

- the writer should not be the only final judge
- there is meaningful proof work that does not share a write scope
- CI or runtime behavior needs separate checking

Use single-lane fallback only when:

- the task is trivial
- the task is risky or destructive
- the immediate next step is blocked on tightly coupled local reasoning
- the write scope would overlap in the same file
- runtime limits prevent safe spawning

When single-lane fallback is used, record:

- why the task was still non-trivial
- why helper lanes were skipped
- what proof replaced the checker lane

## 7. Invariant Impact Review

Before shipping changes that touch core control-plane behavior, explicitly ask:

1. Does this weaken company boundary enforcement?
2. Does this bypass or blur approval boundaries?
3. Does any mutating path lose `activity_log` coverage?
4. Does checkout behavior still fail safely with `409` and explicit ownership rules?
5. Could this interfere with budget hard-stop auto-pause?
6. If contracts changed, were `db/shared/server/ui` touched in the right places?

## 8. Verification Matrix

### If `packages/db/src/schema/**` changed

- confirm `packages/db/src/schema/index.ts`
- confirm migration/generate status
- run:
  - `pnpm db:generate` when needed
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

### If `packages/shared/src/**` changed

- confirm corresponding `server/src/**` or `ui/src/**` changes in the same slice
- run:
  - `pnpm run check:paperclip:fast`
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

### If a mutating route changed

- confirm `assertCompanyAccess`
- confirm approval checks where applicable
- confirm `logActivity`
- for issue checkout flows, confirm `409` handling and run-id enforcement
- run:
  - `pnpm run check:paperclip:fast`
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

### If only docs/config/skills changed

- run the smallest relevant commands first
- at minimum:
  - `pnpm run check:paperclip:fast`
  - then `typecheck/test/build` only if the touched surface justifies it or the handoff claims full proof

## 9. Rollback Standard

Every non-trivial report should name:

- changed files
- exact verification command(s)
- a concrete `git restore ...` path
- any special order for generated migration/build/config artifacts
