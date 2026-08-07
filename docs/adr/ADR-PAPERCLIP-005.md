# ADR-PAPERCLIP-005: Ownership Boundaries & API Contract

- Status: Proposed
- Date: 2026-07-21
- Owners: @haykel1977 (Quantum Engineering), Paperclip Core Team
- Related tasks/PRs: ADR-PAPERCLIP-QUANTUM-OWNERSHIP-001 (GOV-107 CBS-BIS reference), DR8 paperclip-quantum-repartition, Cross-repo audit 2026-07-21

## Context

The Paperclip/Quantum/CBS-BIS ecosystem has **fuzzy ownership boundaries** that caused concrete problems during the cross-repo audit on 2026-07-21:

1. **Duplication**: Both Paperclip and Quantum implement agent task dispatch logic. Quantum's `dispatch` skill routes tasks to agents; Paperclip's task assignment system also routes tasks. The two systems are not coordinated, leading to duplicate assignments and conflicting priority signals.
2. **No-man's-land during incidents**: When a gate evaluation fails (e.g., a T3 gate times out), it is unclear whether Paperclip (the gate pipeline owner) or Quantum (the orchestration owner) is responsible for investigation and resolution. The CBS-BIS `check-compliance` skill checks for ADR presence but cannot determine which repo owns a particular cross-cutting concern.
3. **API contract drift**: Paperclip exposes a REST API for task management. Quantum's `paperclip` skill calls this API. But the API has no formal contract (no OpenAPI spec, no versioning policy). When Paperclip adds a new field to the task response, Quantum breaks silently.
4. **Scope creep**: CBS-BIS agent governance rules (in `AGENTS.md`) define consent gates, merge policies, and verification requirements. Paperclip implements these as gate pipelines. Quantum enforces them as CI checks. The three layers are not aligned — a gate that Paperclip approves may be blocked by a Quantum CI check, or vice versa.
5. **Incident ownership ambiguity**: During the self-approval gate audit, the finding was filed in the Quantum repo (as a security issue), but the fix requires changes in Paperclip (gate pipeline) and CBS-BIS (consent gate definitions). No single repo "owns" the issue.

The root cause is that **the boundary between Paperclip, Quantum, and CBS-BIS was never formally defined**. Each repo evolved independently, and cross-cutting concerns (gate pipelines, agent dispatch, memory, governance) were implemented ad-hoc in whichever repo had the most immediate need.

## Options considered

1. **Option A: Formalise the boundary table from ADR-PAPERCLIP-QUANTUM-OWNERSHIP-001 (GOV-107) and codify as API contracts.** Each cross-repo interaction is documented with: (a) the owning repo, (b) the API contract (OpenAPI spec), (c) the SLA (response time, availability), (d) the version compatibility policy. The boundary table becomes the single source of truth for "who owns what." API contracts are enforced in CI (schema validation on every PR).

2. **Option B: Merge Paperclip into Quantum.** Eliminate the boundary by unifying the two repos. All code in one place.

3. **Option C: Define boundaries informally in documentation only.** Write a README section describing responsibilities. No enforcement.

## Decision

**Adopt Option A: Formalised boundary table + API contracts.**

Rationale:

- **Non-breaking**: Merging repos (Option B) is a massive migration that would disrupt all active development and agent configurations. Informal documentation (Option C) is what already exists and has proven insufficient. The boundary table + API contracts approach is the minimal intervention that fixes the concrete problems.
- **Clear ownership**: The boundary table assigns each cross-cutting concern to exactly one repo as "API owner." The owner is responsible for the API contract, SLA, and version compatibility. Other repos are "API consumers" and can depend on the contract.
- **API contract enforcement**: Each cross-repo API is documented as an OpenAPI 3.1 spec stored in the owning repo's `docs/api/` directory. CI validates that implementation matches the spec. Consumers (other repos) validate that their calls conform to the spec. This prevents silent breakage when fields are added or changed.
- **Version compatibility policy**: Semantic versioning for API contracts. Breaking changes (removing/renaming fields) require a major version bump and a 30-day deprecation window. Non-breaking changes (adding optional fields) are minor version bumps. Consumers pin to a major version.
- **Incident ownership**: The boundary table maps every cross-cutting concern to an owner repo. During incidents, the on-call operator checks the table to determine who investigates. This eliminates the no-man's-land problem.
- **Cross-repo CI checks**: Each repo's CI validates that its API calls to other repos conform to the published contracts. If Paperclip changes its task API response schema, Quantum's CI catches the incompatibility before merge.

Concrete boundary table:

| Concern | API Owner | Consumers | Contract Location | SLA |
|---------|-----------|-----------|-------------------|-----|
| Task assignment & status | Paperclip | Quantum, CBS-BIS | `paperclip/docs/api/tasks.yaml` | 99.9% availability, <500ms p95 |
| Gate pipeline execution | Paperclip | Quantum | `paperclip/docs/api/gates.yaml` | 99.9% availability, <2s p95 |
| Agent identity (PAIF) | Paperclip | Quantum, CBS-BIS | `paperclip/docs/api/identity.yaml` | 99.9% availability, <100ms p95 |
| Orchestration dispatch | Quantum | Paperclip, CBS-BIS | `quantum/docs/api/dispatch.yaml` | 99.9% availability, <1s p95 |
| CI/CD pipeline status | Quantum | Paperclip | `quantum/docs/api/ci.yaml` | 99.5% availability, <5s p95 |
| Code review & approval | Quantum | Paperclip, CBS-BIS | `quantum/docs/api/review.yaml` | 99.9% availability, <2s p95 |
| Domain rules (consent gates, merge policy) | CBS-BIS | Paperclip, Quantum | `cbs-bis/docs/api/governance.yaml` | Read-only, eventual consistency |
| Memory federation (SSOT) | Each repo | Paperclip | Local `memory/` (no API) | N/A |
| Memory semantic search | Paperclip | All | `paperclip/docs/api/memory.yaml` | 99.5% availability, <3s p95 |
| Compliance checks | CBS-BIS | Paperclip, Quantum | `cbs-bis/docs/api/compliance.yaml` | Read-only, <10s p95 |

API contract format (example: `paperclip/docs/api/tasks.yaml`):
```yaml
openapi: "3.1.0"
info:
  title: Paperclip Task API
  version: "1.0.0"
  description: Task assignment and status management for the CBS-BIS agent ecosystem
paths:
  /api/v1/tasks:
    get:
      summary: List tasks for an agent
      parameters:
        - name: agent_paif
          in: query
          required: true
          schema:
            type: string
            pattern: "^[a-z-]+/[a-z0-9-]+@[a-f0-9]{7}$"
      responses:
        "200":
          description: Task list
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Task"
components:
  schemas:
    Task:
      type: object
      required: [id, status, assigned_paif, created_at]
      properties:
        id:
          type: string
        status:
          type: string
          enum: [pending, in_progress, blocked, completed, failed]
        assigned_paif:
          type: string
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
        metadata:
          type: object
          additionalProperties: true
```

Version compatibility policy:
- **Major version** (breaking): Remove or rename fields. 30-day deprecation window. Both old and new versions served simultaneously during deprecation.
- **Minor version** (non-breaking): Add optional fields. Backward-compatible. Consumers can ignore unknown fields.
- **Patch version** (fix): Documentation, description changes. No schema changes.
- **Consumer pinning**: Each consuming repo pins to a major version in its dependency configuration. CI verifies compatibility.

## Consequences

- Positive outcomes:
  - Clear ownership for every cross-cutting concern — eliminates no-man's-land during incidents
  - API contracts enforced in CI — prevents silent breakage when schemas change
  - Version compatibility policy gives consumers predictable upgrade paths
  - Boundary table is the single source of truth for repo responsibilities
  - DORA traceability: every cross-repo interaction has a documented contract, owner, and SLA

- Negative tradeoffs:
  - Contract maintenance overhead: every API change requires spec update + CI validation
  - Coordination cost for breaking changes: 30-day deprecation window requires planning
  - Overhead for simple repos: small repos may find full OpenAPI specs excessive (mitigated by allowing simplified YAML specs for read-only APIs)
  - Boundary table may become stale if not maintained (mitigated by `check-compliance` skill verifying presence)

- Risks:
  - Contract drift if CI enforcement is not strict (mitigated by making contract validation a required CI check)
  - Over-rotation on process: too much ceremony for small changes (mitigated by allowing "fast-track" contract updates for non-breaking changes via automated minor version bump)
  - Boundary disputes between repos (mitigated by `@haykel1977` as final arbiter during current dev/test posture)

## Validation and rollback

- **Validation**:
  1. CI check: Verify that each repo's CI runs OpenAPI spec validation against its published contracts
  2. Consumer test: Verify that Quantum's `paperclip` skill calls Paperclip's task API and handles the response according to the published spec
  3. Boundary table completeness: Verify that every cross-repo interaction documented in `AGENTS.md` and `docs/SSOT/` has a corresponding entry in the boundary table
  4. Version compatibility: Simulate a breaking change in Paperclip's task API, verify that Quantum's CI catches the incompatibility before merge

- **Rollback**: If API contracts prove too heavy, supersede this ADR and fall back to informal documentation with a lighter "compatibility checklist" (no formal OpenAPI spec, but a checklist of field changes that require cross-repo notification). The boundary table itself remains valuable regardless of contract format.

## Follow-up actions

1. Create `docs/api/` directories in each repo with OpenAPI specs
2. Add OpenAPI validation CI step to each repo's pipeline
3. Document the boundary table in `docs/architecture/boundaries.md` (cross-linked from all repos)
4. Implement version compatibility check in `dispatch` skill (verify consumer pins match provider version)
5. Create incident runbook section: "How to determine repo ownership for an issue"
6. Review boundary table quarterly (add to `check-compliance` skill schedule)
7. Train agents (via skill loading) to reference boundary table when scoping tasks
