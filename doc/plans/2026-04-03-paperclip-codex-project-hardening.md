# Paperclip Codex Project Hardening

Date: 2026-04-03

## Goal

Bring the stronger global Codex operating standard down into the Paperclip repo
without changing runtime product contracts. Focus on harness, context, prompt,
and agentic engineering surfaces that can be improved immediately and safely.

## Scoring

| Area | Baseline | Target |
|---|---:|---:|
| Harness | 6.5 | 8.0 |
| Context | 4.5 | 7.5 |
| Prompt | 5.5 | 7.5 |
| Agentic | 6.0 | 7.5 |

## 1. Harness Engineering

### Current strengths

- PR CI already enforces `typecheck`, `test:run`, and `build`.
- company boundary, approval boundary, and activity logging are implemented in real routes/services.
- release flows already keep rollback procedures and dry-run surfaces.

### Current gaps

- no repo-local Codex config surface
- no repo-managed handoff file
- no fail-fast local guard before full checks
- no repo-managed pre-commit hook entrypoint
- no explicit contract-sync gate for `db/shared/server/ui`

### Improve now

- add `.codex/config.toml`
- add `SESSION_HANDOFF.md`
- add `check:paperclip:fast` and `check:paperclip:full`
- add contract-sync and mutating-route guardrail scripts
- add `.githooks/pre-commit` and hook installer
- wire the fast gate into PR/release verification before the heavier steps

### Medium difficulty / high value

- add repo-owned route guardrail tests instead of pattern checks only
- turn current red test baseline into a tracked reliability project
- split fast and full operational checks further by task category

## 2. Context Engineering

### Current strengths

- `AGENTS.md` defines repo purpose, read-first docs, invariants, and done conditions.
- product/spec docs are already well separated by role.
- Paperclip skill docs already emphasize minimal context reconstruction during heartbeats.

### Current gaps

- no repo-local first-read bundle beyond `AGENTS.md`
- no task-type required read sets
- no written context budget
- no single place that explains when to read `server`, `ui`, `db`, `shared`, or docs

### Improve now

- add `doc/CODEX_OPERATING_GUIDE.md`
- define first-read bundle and task-type read sets
- define minimal context surface and context budget
- anchor active state in `SESSION_HANDOFF.md`

### Medium difficulty / high value

- add generated doc index or task-type navigation helpers
- add guardrails that detect overscoped context requests or stale handoff files

## 3. Prompt Engineering

### Current strengths

- PR template already requires a Thinking Path.
- contributor docs already ask for verification and risk framing.
- Paperclip skill and eval docs already encode several safety-critical behaviors.

### Current gaps

- no project-wide change request template for everyday work
- no standard `Goal / Scope / Constraints / Done-When / Verification / Rollback` shape
- no task-specific prompt templates for schema/API/UI/invariant/docs changes

### Improve now

- add prompt templates to `doc/CODEX_OPERATING_GUIDE.md`
- standardize request framing across change types
- make rollback and verification mandatory in the repo-local operating surface

### Medium difficulty / high value

- add prompt linting or example prompt fixtures for common Paperclip tasks
- connect prompt changes more directly to eval coverage

## 4. Agentic Engineering

### Current strengths

- core invariants already live in implementation, not just docs
- Paperclip skill rules cover checkout, `409`, approvals, and company boundaries
- eval scaffolding exists for prompt/skill behavior

### Current gaps

- no repo-local written policy for subagent eligibility, reader/checker defaults, and single-lane fallback evidence
- no shared reviewer/tester lane guidance for implementation work
- no repo-local checklist for invariant impact review

### Improve now

- add agentic workflow rules to `doc/CODEX_OPERATING_GUIDE.md`
- record lane evidence and baseline proof in `SESSION_HANDOFF.md`
- add fail-fast scripts that enforce route-level guardrail presence

### Medium difficulty / high value

- add stronger reviewer/tester lane automation
- add route or contract tests that specifically assert invariant coverage
- connect agentic workflow outcomes to repo-local eval fixtures

## Immediate Deliverables

1. `.codex/config.toml`
2. `SESSION_HANDOFF.md`
3. `doc/CODEX_OPERATING_GUIDE.md`
4. `scripts/check-paperclip-change-scope.mjs`
5. `scripts/check-paperclip-route-guardrails.mjs`
6. `.githooks/pre-commit`
7. `scripts/install-git-hooks.sh`
8. package/CI/template/docs additive updates

## Non-Goals

- no runtime API changes
- no DB schema changes
- no shared type or validator changes
- no UI contract changes
- no attempt to fix the pre-existing red `pnpm test:run` baseline in the same slice
