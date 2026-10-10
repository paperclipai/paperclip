# ADR-PAPERCLIP-001: Paperclip ADR Governance Framework

- Status: Proposed
- Date: 2026-07-21
- Owners: @haykel1977 (Quantum Engineering), Paperclip Core Team
- Related tasks/PRs: Cross-repo audit 2026-07-21 (gap identified: zero ADR governance), ADR-GOV-106 (Quantum reference)

## Context

Paperclip operates as the control plane agent for a multi-repo core banking ecosystem (CBS-BIS, Quantum). As of 2026-07-21, Paperclip has **zero** Architecture Decision Records. All architectural decisions are implicit, tribal-knowledge-only, or buried in Slack threads and commit messages. This creates several concrete failure modes:

1. **Decision archaeology**: When an incident occurs (e.g., the self-approval gate risk found in the orchestration audit), there is no traceable record of *why* a particular approach was chosen over alternatives. New agents (Codex, OpenHands, Claude) joining the orchestration cannot distinguish between deliberate design choices and accidental defaults.
2. **Regression risk**: Without immutable records, agents may unknowingly re-introduce patterns that were previously evaluated and rejected. The Quantum repo solved this with ADR-GOV-106 (MADR v3 adoption). Paperclip lacks equivalent grounding.
3. **Audit deficiency**: DORA Art. 9 requires traceability of operational decisions. SOC 2 Type II preparation (target 2026) demands documented change rationale. A zero-ADR posture fails both requirements.
4. **Cross-repo incoherence**: Quantum has ~40 ADRs. Paperclip has none. This asymmetry means governance decisions that span both repos (ownership boundaries, gate pipelines, memory federation) have no Paperclip-side record.

This ADR establishes the ADR governance framework itself — the meta-ADR that makes all future ADRs possible and enforceable within Paperclip.

## Options considered

1. **Option A: Adopt MADR v3 (Markdown Architectural Decision Records) with file-based storage in `docs/adr/`.** MADR v3 is a lightweight, widely-adopted standard. The Quantum repo already uses it (ADR-GOV-106), ensuring cross-repo consistency. Files are immutable once accepted; amendments produce new `ADR-XXXX-bis.md` files. Each ADR has a strict frontmatter schema (status, date, owners, related tasks). This is the format used by Martin Fowler's team, the AWS Well-Architected framework, and the CNCF.

2. **Option B: Use Confluence/wiki-based decision records.** Centralised in a wiki with search and linking. Lower friction for non-technical stakeholders.

3. **Option C: Inline ADRs in code comments and README sections.** Co-located with implementation, zero infrastructure overhead.

## Decision

**Adopt Option A: MADR v3 with file-based storage in `docs/adr/`.**

Rationale:

- **Cross-repo consistency**: Quantum already uses MADR v3 (ADR-GOV-106). Paperclip adopting the same format means agents moving between repos encounter identical governance structures. The `dispatch` skill and `paperclip` skill can reference ADRs with a uniform path convention.
- **Immutability by design**: MADR files in `docs/adr/` are append-only. Once an ADR reaches `Accepted` status, it is never modified. Corrections and supersessions produce `ADR-XXXX-bis.md` (or `-ter`, etc.) files that reference the original. This matches Martin Fowler's ADR immutability principle and ensures audit traceability.
- **Git-native**: ADRs live in the repo. They are version-controlled, diffable, and PR-reviewable. Governance changes (new ADRs) go through the same PR pipeline as code changes, with mandatory ADR review before merge.
- **Machine-parseable**: The frontmatter schema (Status, Date, Owners, Related tasks/PRs) enables programmatic queries. The `check-compliance` skill can verify ADR presence for governance-related changes. The `pr-report` skill can extract ADR references from PR descriptions.
- **Agent-discoverable**: Agents walking the repo (`skills/` auto-discovery pattern) can find `docs/adr/` and load relevant decisions. No external system dependency.

Concrete conventions:
- File naming: `ADR-PAPERCLIP-{NNN}.md` (e.g., `ADR-PAPERCLIP-001.md`)
- Amendment naming: `ADR-PAPERCLIP-{NNN}-bis.md`, `-ter.md`, etc.
- Storage path: `docs/adr/` at repo root
- Status lifecycle: `Proposed` → `Accepted` → (optionally) `Superseded by ADR-PAPERCLIP-XXX-bis`
- No `Deprecated` or `Rejected` statuses — these are implicit (never-accepted ADRs remain `Proposed` and are never merged, or are superseded)
- Review gate: Any PR that modifies governance-related files (`.github/`, `docs/governance/`, agent configs) must reference at least one ADR in its description. If no ADR exists, the PR must include a new one.

## Consequences

- Positive outcomes:
  - Paperclip gains auditable, immutable decision records aligned with DORA and SOC 2 requirements
  - Cross-repo ADR format consistency (Quantum + Paperclip both MADR v3)
  - Agents can programmatically discover and reason about architectural decisions
  - Governance PRs have clear review criteria (ADR presence, status correctness)
  - Incident post-mortems can reference ADRs to understand original intent

- Negative tradeoffs:
  - Initial overhead: creating ADRs for decisions already made (backfill sprint needed)
  - Non-technical stakeholders may find Markdown less accessible than Confluence (mitigated by PR review process)
  - File proliferation over time (mitigated by supersession consolidation)

- Risks:
  - ADRs become stale if not maintained during reviews (mitigated by compliance skill checks)
  - Over-engineering the ADR process for minor decisions (mitigated by allowing lightweight "Rationale" sections in code for trivial choices)

## Validation and rollback

- **Validation**: After adoption, run `check-compliance` skill against a governance PR to verify ADR presence enforcement. Verify cross-repo path conventions match Quantum (`docs/adr/` in both repos).
- **Rollback**: If the process proves too heavy, downgrade to "ADRs are recommended but not required" by superseding this ADR with a lighter version. The files themselves remain as historical records.

## Follow-up actions

1. Backfill ADRs for 5 major existing decisions (ownership boundaries, gate pipeline, memory architecture, identity format, API contracts) — covered by ADR-PAPERCLIP-002 through 005
2. Add `docs/adr/` to `.github/CODEOWNERS` with `@haykel1977` as required reviewer
3. Update `check-compliance` skill to verify ADR presence on governance PRs
4. Add ADR template file: `docs/adr/TEMPLATE.md`
5. Document ADR process in `docs/governance/README.md`
