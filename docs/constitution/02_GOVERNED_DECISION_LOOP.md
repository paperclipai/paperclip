# 02 — Governed Decision Loop

**Status:** Constitutional  
**Origin:** Evidence from Paperclip Operational Audit methodology, issue execution policy, thread interactions, QSL review system, and governance checkpoint recorder  
**Confidence:** High (recurring structured decision patterns across approval gates, recovery escalation, budget incidents, and audit methodology)  

---

## The Canonical Lifecycle

```
Observe
  ↓
Collect Evidence
  ↓
Analyze
  ↓
Confidence
  ↓
Unknown Detection
  ↓
Question Generation
  ↓
Human Clarification
  ↓
Decision
  ↓
Explanation
  ↓
Lessons
  ↓
Institutional Memory
  ↓
Future Guidance
```

This is the canonical decision loop for QuantumShield Labs. It is not a recommendation. It is a description of the structure that already exists in the systems audited, made explicit so future systems can implement it faithfully.

---

## 1. Observe

**Definition:** The deliberate act of noticing something that requires attention.

**Evidence from Paperclip:**
- Heartbeat scheduler observes agent status every 30 seconds (`heartbeat.ts`).
- Recovery service observes stranded issues on startup (`recovery/service.ts`).
- Runtime guardian observes backup freshness, orphan count, and stale entities (`runtime_guardian.py`).
- QSL bridge observes new findings during sync (`syncFindings()`).
- Audit process observes code, schema, and runtime behavior.

**Principle:** Observation must be intentional. Passive monitoring is not observation. Observation requires a question: "What is the current state of X?"

---

## 2. Collect Evidence

**Definition:** The gathering of verifiable, specific facts related to the observation.

**Evidence from Paperclip:**
- Audit charter: "Every conclusion references specific files."
- Activity log: every mutation captured with actor, action, entity, and details.
- Heartbeat runs: `heartbeatRuns` table with `status`, `contextSnapshot`, `startedAt`, `completedAt`.
- Cost events: `costEvents` table with `provider`, `model`, `costCents`, `occurredAt`.
- QSL bridge: `issues.json`, `state.json`, `approvals.jsonl` as external evidence.

**Principle:** Evidence must be specific and verifiable. A screenshot is evidence. A feeling is not. Evidence must carry provenance: who collected it, when, and from what source.

---

## 3. Analyze

**Definition:** The organization of evidence into coherent understanding: patterns, relationships, causes, and effects.

**Evidence from Paperclip:**
- Issue graph liveness analysis (`reconcileIssueGraphLiveness`): identifies dependency deadlocks and stranded blockers.
- Budget evaluation (`evaluateCostEvent`): compares observed spend against policy thresholds.
- Liveness continuation analysis (`decideRunLivenessContinuation`): filters preconditions to determine if a retry is warranted.
- Audit analysis: cross-referencing schema, routes, services, and UI to form system understanding.

**Principle:** Analysis is the bridge from evidence to knowledge. It must be systematic, not heroic. It should be reviewable by another analyst starting from the same evidence.

---

## 4. Confidence

**Definition:** The explicit estimation of how much the analysis should be trusted.

**Evidence from Paperclip Audit:**
- Every audit finding carries a confidence level: "High" (verified by source code), "Medium" (inferred from schema and path), "Low" (speculative, needs further evidence).
- The audit session logs explicitly separate "highest-confidence findings" from "unsupported claims."
- The extension decision matrix uses explicit checkmarks (✅) vs. crosses (❌) for capability support.

**Principle:** Confidence is not a feeling. It is a structured estimate based on evidence quality, source reliability, and analytical rigor. Every conclusion must carry a confidence level. Every low-confidence conclusion must be labeled as such.

**Confidence Levels (QuantumShield Labs Standard):**

| Level | Meaning | Evidence Requirement |
|-------|---------|-------------------|
| **Certain** | Verified by direct inspection of source code or runtime behavior | File path, line number, function name, exact behavior observed |
| **High** | Strong inference from multiple corroborating sources | Schema + service + route + at least one test or UI reference |
| **Medium** | Reasonable inference from partial evidence | Schema or service level, but no verification of runtime behavior |
| **Low** | Speculative, plausible but unverified | Pattern match, naming convention, or architectural assumption |
| **Unknown** | Cannot be determined from current evidence | Explicitly labeled as such; no guess permitted |

---

## 5. Unknown Detection

**Definition:** The explicit identification of what is not known, what cannot be determined, and what assumptions are being made.

**Evidence from Paperclip:**
- `01C_OPEN_QUESTIONS.md`: 20 explicitly unanswered questions.
- Sprint 3 session log: "7 questions remaining."
- Sprint 4 session log: "7 remaining unknowns."
- Every audit document's "Architectural Contradictions" section identifies gaps between expected and actual behavior.
- The unknown detection step in `decideRunLivenessContinuation`: if preconditions cannot be verified, the continuation is skipped.

**Principle:** Unknowns are first-class artifacts. They are tracked, prioritized, and revisited. A system that does not track its unknowns is hiding its ignorance. Hidden ignorance is a source of risk.

**QuantumShield Labs Rule:** For every analysis, produce at least one unknown. If you cannot find an unknown, you have not looked hard enough.

---

## 6. Question Generation

**Definition:** The transformation of unknowns into specific, answerable questions.

**Evidence from Paperclip:**
- Audit charter: questions are numbered and categorized by evidence gap.
- Thread interactions: `request_confirmation` is a structured question from agent to human.
- Escalation issues: recovery service creates explicit issues asking for human decision when automation is exhausted.
- QSL review: findings in `pending_review` state are explicit questions to the board.

**Principle:** An unknown is a category. A question is a request. Questions must be specific enough that a future analyst can determine whether it has been answered. "What is the upstream sync state?" is a question. "Should we use webhooks?" is not.

**QuantumShield Labs Rule:** Every question must have an owner, a timestamp, and a link to the evidence that prompted it.

---

## 7. Human Clarification

**Definition:** The point in the loop where human judgment is required to resolve ambiguity, answer questions, or make decisions that exceed delegated authority.

**Evidence from Paperclip:**
- `issueExecutionPolicy` defines explicit `approval` and `review` stages where humans must act.
- `request_confirmation` thread interactions require human accept/reject/respond.
- Budget incidents create `approval(type: budget_override_required)` requiring board action.
- Recovery escalations create explicit issues for human review when all automated paths are exhausted.
- The audit process itself requires human clarification on scope, methodology, and prioritization.

**Principle:** Human clarification is not a failure of automation. It is a design feature. The decision of what to automate and what to reserve for humans is itself a governance decision, not a technical one.

**QuantumShield Labs Rule:** The loop must never proceed past a governance gate without explicit human action or a documented delegation of authority.

---

## 8. Decision

**Definition:** The selection of a specific course of action, recorded with rationale and authority.

**Evidence from Paperclip:**
- `issueExecutionPolicy` stages: `approve`, `request_changes`, `address_changes`, `resubmit`.
- QSL review decisions: `approved`, `denied`, `accepted_risk`, `suppressed`, `escalated`.
- Budget incident resolution: `raise_budget_and_resume` or `dismiss`.
- Watchdog decisions: `snooze`, `continue`, `dismiss`.
- Governance checkpoint recorder: `operator_notes` field captures human decision context.

**Principle:** A decision is not an opinion. It is a commitment to action with defined authority, rationale, and reversibility. Decisions must be recorded.

---

## 9. Explanation

**Definition:** The articulation of why the decision was made, what alternatives were considered, and what evidence supported it.

**Evidence from Paperclip:**
- Activity log entries include `details` JSON with full context.
- Thread interactions record `previous_state` and `previous_decision` in history.
- Audit documents explain the reasoning behind every finding with file references.
- The system mental model asks: "If someone removed every implementation detail and kept only the concepts, what would remain?" This is an explanation of the architecture.

**Principle:** An unexplained decision is not governance. It is authority. Authority without explanation is not transparent. Explanation must be accessible to a future operator who does not have the original context.

---

## 10. Lessons

**Definition:** The extraction of generalizable insights from a specific decision and its outcomes.

**Evidence from Paperclip:**
- The audit session logs catalog "major discoveries" and "architectural insights" as lessons.
- The extension decision matrix identifies proven vs. unsupported mechanisms as lessons about the system's capabilities.
- The governance checkpoint recorder's `operator_notes` field captures lessons learned.
- The architectural contradictions section in every audit document is a lesson about where the system diverges from its intended design.

**Principle:** A lesson is not a complaint. It is a structured observation about cause and effect that can guide future decisions. Lessons must be extracted, not assumed. They must be recorded, not remembered.

---

## 11. Institutional Memory

**Definition:** The durable preservation of the decision, explanation, and lessons in a retrievable and verifiable form.

**Evidence from Paperclip:**
- `activity_log` table: append-only, company-scoped, immutable.
- `governance_checkpoint.py` hash-chained checkpoints with `integrity_hash`.
- `qsl_findings.reviewHistory`: JSONB array preserving every review decision.
- Audit document tree: 30+ documents with explicit evidence and confidence levels.
- `budget_incidents` table: preserved lifecycle with resolution paths.

**Principle:** Memory is not storage. Memory is retrievable understanding. A database is storage. A documented, cross-referenced, and explained record is memory. The goal is not to store everything. The goal is to preserve what matters in a form that future operators can trust and use.

---

## 12. Future Guidance

**Definition:** The application of institutional memory to improve future observations, analyses, and decisions.

**Evidence from Paperclip:**
- The audit charter's methodology was refined across sprints based on lessons from previous sprints.
- The extension decision matrix informs the "Recommended Scope for Next Design Sprint."
- The governance checkpoint index allows trend analysis and health trajectory tracking.
- The `continuationPolicy` on thread interactions (`wake_assignee`, `wake_assignee_on_accept`) is future guidance encoded in the system.

**Principle:** Memory that does not guide future action is nostalgia. The purpose of institutional memory is to make the organization wiser over time. This requires explicit feedback loops, not passive accumulation.

---

## First-Class Artifacts

In the QuantumShield Labs decision loop, the following are first-class artifacts with the same status as code, designs, and deployments:

| Artifact | Form | Example |
|----------|------|---------|
| **Evidence** | File references, logs, schema excerpts | `server/src/services/heartbeat.ts` lines 152–155 |
| **Analysis** | Cross-referenced documents with confidence levels | `SYSTEM_MENTAL_MODEL.md` |
| **Unknown** | Numbered questions with evidence gaps | `01C_OPEN_QUESTIONS.md` Q1–Q20 |
| **Question** | Specific, answerable, owned, timestamped | "What is the upstream sync state?" |
| **Comment** | Structured communication with actor attribution | `issue_comments` with `authorAgentId` or `authorUserId` |
| **Contradiction** | Documented divergence between expected and actual behavior | Architectural Contradictions sections |
| **Decision** | Recorded with rationale, authority, and alternatives | `budget_incidents` resolution with `action` and `notes` |
| **Explanation** | Why the decision was made, with evidence | Activity log `details` JSON |
| **Lesson** | Generalizable insight from specific experience | "In-memory quota protection resets on server restart" |
| **Checkpoint** | Hash-verified snapshot of institutional state | `GCP-{uuid}` with `chain_id` and `integrity_hash` |

---

## Distinguishing Categories

Every artifact in the decision loop must be labeled with one of the following categories:

| Category | Definition | Example |
|----------|-----------|---------|
| **Evidence** | Observable, verifiable fact | "`heartbeat.ts` line 2007 defines a sliding-window failure rate limiter." |
| **Inference** | Logical conclusion drawn from evidence | "The quota protection resets on server restart because it is in-memory." |
| **Opinion** | Judgment not fully supported by evidence | "The recovery service should consolidate owner candidate ranking." (This is an opinion unless backed by evidence of harm.) |
| **Policy** | A rule decided by governance | "Every mutation must write to `activity_log`." |
| **Authority** | The legitimate source of a decision | "The board approves CEO strategy via `approve_ceo_strategy` approval gate." |
| **Unknown** | A gap that cannot be filled from current evidence | "Whether the runtime guardian runs on a schedule is unknown." |

**QuantumShield Labs Rule:** Never present inference as evidence. Never present opinion as policy. Never present authority as justification without explanation.

---

*End of Governed Decision Loop*
