# ADR-PAPERCLIP-002: Agent Identity & Cross-Repo Federation

- Status: Proposed
- Date: 2026-07-21
- Owners: @haykel1977 (Quantum Engineering), Paperclip Core Team
- Related tasks/PRs: ADR-AGENT-INGEST-001 (Quantum reference), Cross-repo audit 2026-07-21, Agent registration deduplication effort

## Context

Paperclip fetches GitHub metadata (PRs, commits, checks, reviews) from multiple repositories: `haykel1977/Core-Banking-Factory-BIS` (CBS-BIS) and the Quantum orchestration layer. It also coordinates agent sessions across Codex, OpenHands, Claude Code, and Opencode/Cline.

The current state is **fragmented**:

1. **Duplicate registrations**: The same logical agent (e.g., a Codex instance) can register with different identifiers across repos. CBS-BIS may track it as `codex-local-abc123` while Quantum references it as `agent-1@quantum`. Paperclip, ingesting from both, creates two separate agent records — breaking session continuity and audit trails.
2. **Inconsistent session tracking**: When a Codex session in CBS-BIS hands off to a Claude review session, there is no standardised way to correlate them. The `handover` convention in AGENTS.md is documentation-only; Paperclip cannot programmatically link the sessions.
3. **No workspace provenance**: Paperclip cannot distinguish whether an agent action originated from a local workspace, a CI runner, or a remote execution backend. This matters for the consent gate pipeline — a local dev action has different trust characteristics than a CI-automated one.
4. **Cross-tenant identity leak risk**: Without a structured identity format, ad-hoc string concatenation for agent IDs risks accidental cross-tenant data association. If `tenant_id` is not embedded in the identity, a query for "all actions by Codex" could span tenants.

The root cause is that **no standardised agent identity format exists across the ecosystem**. Each repo invented its own convention. Paperclip, as the cross-repo control plane, needs to federate these into a unified view without imposing identity changes on individual repos (which would break their internal conventions).

## Options considered

1. **Option A: Paperclip Agent Identity Format (PAIF)** — `{repo_scope}/{agent_id}@{workspace_hash}`. Paperclip defines a canonical identity format that wraps (not replaces) each repo's native agent identifier. The format encodes provenance (`repo_scope`), identity (`agent_id`), and workspace context (`workspace_hash`). PAIF is propagated through A2A (Agent-to-Agent) protocol headers and stored in Paperclip's Postgres with a composite UNIQUE constraint on `(repo_scope, agent_id)`. Individual repos continue using their native identifiers internally; Paperclip translates at ingestion time.

2. **Option B: Centralised UUID-based identity service.** A separate identity microservice generates and assigns globally unique UUIDs to agents. All repos register with this service to obtain an identity.

3. **Option C: Use GitHub App installation tokens as identity.** Tie agent identity to the GitHub App installation that authorized the agent session. No additional identity layer.

## Decision

**Adopt Option A: PAIF — `{repo_scope}/{agent_id}@{workspace_hash}`.**

Rationale:

- **Non-breaking adoption**: PAIF is a Paperclip-side abstraction. Repos do not need to change their internal agent identifiers. CBS-BIS can keep using `agent-1`, Quantum can keep using `agent-1@quantum`. Paperclip wraps these into PAIF at the ingestion boundary. This is critical because CBS-BIS and Quantum are in active production; identity format changes would require coordinated migrations across all repos and agents.
- **Provenance by construction**: The `repo_scope` component (e.g., `cbs-bis`, `quantum`) makes it impossible to accidentally confuse agents from different repos. The `workspace_hash` (a truncated SHA-256 of the workspace root path + git HEAD) ties identity to a specific code state, enabling reproducibility verification.
- **A2A protocol alignment**: The A2A v1.0 specification supports custom headers in agent-to-agent messages. PAIF maps naturally to an `X-Agent-Identity` header. This means handover between agents (e.g., Codex → Claude) carries identity information in-band, not via separate reconciliation.
- **Database design**: Paperclip's Postgres stores agent records with `UNIQUE(repo_scope, agent_id)`. The `workspace_hash` is a versioning dimension (same agent, different workspace state = different session, same identity). This supports the memory federation model (ADR-PAPERCLIP-003) where per-agent, per-workspace memory isolation is required.
- **Audit traceability**: Every agent action logged in Paperclip includes the full PAIF. During incident investigation, operators can reconstruct the exact agent, repo, and workspace state for any action. This satisfies DORA traceability requirements.

Concrete format:
```
PAIF = {repo_scope}/{agent_id}@{workspace_hash}

Examples:
  cbs-bis/agent-1@a3f2b1c           # Codex in CBS-BIS repo
  quantum/agent-3@d7e4f9a            # Claude in Quantum repo
  paperclip/agent-4@b2c8e1d          # Opencode in Paperclip itself
```

Database schema addition (Paperclip Postgres):
```sql
CREATE TABLE agent_identities (
    paif            TEXT PRIMARY KEY,
    repo_scope      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    workspace_hash  TEXT NOT NULL,
    native_id       TEXT NOT NULL,           -- repo's original identifier
    agent_type      TEXT NOT NULL,           -- codex, openhands, claude, opencode
    llm_primary     TEXT,                    -- e.g., "deepseek-coder-v3"
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(repo_scope, agent_id)
);
```

## Consequences

- Positive outcomes:
  - Deduplicated agent records across repos without changing repo-internal conventions
  - Full provenance traceability (repo + agent + workspace state) in every audit log
  - A2A handover carries identity in-band via `X-Agent-Identity` header
  - Memory federation (ADR-PAPERCLIP-003) has a stable identity key for per-agent isolation
  - Incident response can reconstruct exact agent context from PAIF alone

- Negative tradeoffs:
  - Translation layer at ingestion boundary adds complexity (mitigated by well-defined mapping table)
  - `workspace_hash` requires computation at session start (trivial: SHA-256 of path + HEAD)
  - Two identity systems coexist: native repo IDs and PAIF (inherent to the federated approach)

- Risks:
  - Hash collisions in `workspace_hash` (mitigated by 7-char truncated SHA-256, collision probability < 10^-9 at current scale)
  - Stale PAIF entries if agents are decommissioned without cleanup (mitigated by `last_seen_at` TTL in compliance checks)

## Validation and rollback

- **Validation**: Verify that PAIF generation produces unique entries for agents across CBS-BIS and Quantum by running ingestion against test fixtures. Check that `UNIQUE(repo_scope, agent_id)` constraint prevents duplicate registrations.
- **Rollback**: If PAIF proves problematic, supersede this ADR and fall back to repo-native identifiers with a `repo_scope` prefix (simpler, less information). The PAIF table schema is additive — no existing data is modified.

## Follow-up actions

1. Implement PAIF generation in the Paperclip ingestion pipeline
2. Add `X-Agent-Identity` header to A2A protocol adapter
3. Create migration for `agent_identities` table
4. Update `agent-governance` skill to reference PAIF
5. Backfill existing agent records with generated PAIFs
6. Update `paperclip` skill to use PAIF in task assignment and status queries
