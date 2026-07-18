# 00 — Foundational Principles

**Status:** Constitutional  
**Origin:** Evidence from Paperclip Operational Audit Sprints 1–4  
**Confidence:** High (recurring patterns across 30+ audit documents)  

---

## Enduring Principles

These principles emerged from recurring architectural patterns, repeated design decisions, and explicit evidence across the Paperclip codebase, operational tooling, and governance layers. They are not philosophical speculations. They are what the system already does, made explicit.

---

### 1. Technology Changes. Principles Endure.

**Evidence:** The Paperclip control plane has survived adapter swaps (Claude Code → Codex → Hermes via external plugin), schema migrations (72+ migrations), and migration from built-in to external-only adapter loading. The principles of company-scoped isolation, atomic checkout, and auditability have remained constant across all these changes.

**Principle:** Implementations are disposable. The ideas that govern them are not. Every architectural decision should be reversible without violating a foundational principle.

---

### 2. Evidence Over Assertion

**Evidence:** The audit charter (`00_AUDIT_CHARTER.md`) mandated: "Every conclusion in this audit references specific files. When uncertain, the audit explicitly states: 'Unknown from current evidence.'" This standard produced 30+ audit documents with file-path citations for every claim.

**Principle:** A claim without evidence is not knowledge. It is a hypothesis. Hypotheses are acceptable only when labeled as such. The burden of proof rests on the claimant.

---

### 3. Governance Over Autonomy

**Evidence:** Paperclip enforces budget hard-stops that auto-pause agents when spending limits are crossed (`budgets.ts` `pauseAndCancelScopeForBudget`). Adapters connect agent runtimes, but the control plane decides when, where, and with what context agents execute (`SYSTEM_MENTAL_MODEL.md` §5). The QSL bridge preserves human review decisions across syncs (`qsl-review.ts`), preventing automated systems from overwriting human judgment.

**Principle:** Autonomy is a delegated privilege, not a right. It is granted by governance mechanisms and can be revoked by them. Systems that operate without oversight are not autonomous; they are ungoverned.

---

### 4. Institutional Knowledge Outlives Tools

**Evidence:** The governance checkpoint recorder (`governance_checkpoint.py`) creates hash-chained institutional memory snapshots. The QSL review service preserves review state across rescans. The activity log is append-only and company-scoped. These mechanisms treat operational data as durable institutional memory, not disposable logs.

**Principle:** The organization must retain its understanding even when the tools that produced it are replaced. Exportable, verifiable, and hash-linked records are not optional features. They are the organizational equivalent of an immune system.

---

### 5. Humility Over Certainty

**Evidence:** The audit session logs (`SESSION_LOG_2026-07-14.md`, `SESSION_LOG_2026-07-15_SPRINT4.md`) explicitly catalog unknowns, contradictions, and unsupported claims. Every audit document ends with an "Architectural Contradictions" section. The open questions list (`01C_OPEN_QUESTIONS.md`) contains 20 items deliberately left unanswered.

**Principle:** Declared ignorance is preferable to false confidence. A system that admits what it does not know is more trustworthy than one that silently assumes. Every important conclusion must carry a confidence level, and unknowns must be tracked as first-class artifacts.

---

### 6. Human Authority Over AI Authority

**Evidence:** Paperclip's governance model requires board approval for hires (`approve_ceo_strategy`), budget overrides (`budget_override_required`), and execution stages (`execution_review`). Agents cannot bypass approval gates (`SPEC-implementation.md` §7.10). Human comments on closed issues implicitly reopen work; agent comments do not (`shouldImplicitlyMoveCommentedIssueToTodo`). The QSL bridge never overwrites a human review decision.

**Principle:** AI may organize, recommend, and execute within delegated boundaries. AI may never possess governance authority. The final decision on mission, values, ethics, and risk acceptance belongs to humans.

---

### 7. Transparency Over Mystery

**Evidence:** Every mutation in Paperclip writes to `activity_log` with actor attribution, run linkage, and redaction support (`activity_log` schema). Heartbeat runs stream logs in real time. Budget incidents are visible in the UI. The QSL bridge exposes debug endpoints. The audit itself is a public, file-referenced record.

**Principle:** Operators must be able to understand why a system behaved as it did. Opaque failures are failures of governance, not just engineering.

---

### 8. Recoverability Over Convenience

**Evidence:** The recovery service (`recovery/service.ts`) reconciles orphaned runs, stranded issues, and stale assignments on startup. Heartbeat runs use bounded transient retries (4 attempts with escalating delays). Checkpoint recorder produces deterministic reconstruction snapshots. The system could auto-reassign stuck work but does not, preserving ownership and accountability (`SYSTEM_MENTAL_MODEL.md` §9.6).

**Principle:** The ability to recover from failure is more important than the elimination of failure. Convenience that sacrifices recoverability or auditability is not an improvement. It is a deferred liability.

---

### 9. Security Through Discipline

**Evidence:** Agent API keys are hashed at rest. Secrets are resolved at runtime, not at config-save time. Company scoping is enforced in every route and service. Plugin capabilities are explicitly declared and validated (`OPERATION_CAPABILITIES`). Cross-company access is blocked by `assertCompanyAccess()`.

**Principle:** Security is not a feature. It is a discipline expressed in every layer: schema, service, route, and operation. A single unscoped query is a constitutional violation, not merely a bug.

---

### 10. Continuous Learning

**Evidence:** The audit process itself produces session logs, open questions, and contradictions that feed forward into the next sprint. The governance checkpoint recorder captures "lessons learned" as a first-class field. The routine system (`routines.ts`) enables recurring introspection. The extension decision matrix tracks proven and unsupported mechanisms.

**Principle:** A system that does not learn from its operation is static. Learning requires deliberate observation, honest recording, and structured feedback into governance. This is not a technical feature. It is an organizational habit.

---

### 11. Long-Term Stewardship

**Evidence:** The Constitution is explicitly written to endure. The audit charter prohibits redesign recommendations in favor of understanding what exists. The system mental model asks: "If someone removed every implementation detail and kept only the concepts, what would remain?" The answer is eight enduring concepts that transcend any technology stack.

**Principle:** Current operators are temporary stewards of systems that will outlast them. Decisions must be made with the understanding that future contributors will inherit them without the original context. Optimize for clarity, consistency, and long-term stability, not short-term velocity.

---

## Emerging Constitutional Principles

The following principles are supported by strong evidence but originated primarily from discussion and synthesis rather than explicit implementation. They are marked as emerging and subject to further evidence before full constitutional status.

### E1. Comments and Questions Are First-Class Institutional Artifacts
**Evidence:** The audit methodology treats open questions, contradictions, and session logs as primary deliverables. Paperclip's `issue_comments` and `thread_interactions` are the sole communication model. Recovery issues serve as visible artifacts of failure.
**Status:** Emerging. Supported by implementation evidence but elevated to constitutional significance through audit practice.

### E2. Non-Reassignment Is Accountability
**Evidence:** Paperclip's recovery system retries once, then creates a recovery issue or escalates to a human. It does not silently reassign work. This is an explicit product decision, not a missing feature.
**Status:** Emerging. The principle is clear in the current system but its generalization to all organizational recovery is not yet proven.

### E3. Thin Core, Rich Edges
**Evidence:** Paperclip's V1 spec explicitly defers plugins, knowledge, and marketplace to post-V1. The philosophy is implemented in the adapter and plugin systems, where the core has zero knowledge of specific adapters.
**Status:** Emerging. Well-supported in the current system but not yet tested across other QuantumShield Labs systems.

---

*End of Foundational Principles*
