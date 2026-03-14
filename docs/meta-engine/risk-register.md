# Risk Register

Status: Active
Version: 0.1
Last updated: 2026-03-14

---

## Project-Level Risks

### R01 — Mission Drift: Becomes a Normal Venture Studio

**Probability:** High (without active prevention)
**Impact:** Critical — invalidates the entire thesis

**Description:**
The system starts optimizing for fundable stories, revenue metrics, and exits rather than alignment-positive selection pressure.

**Warning signs:**
- Businesses launched without measuring alignment mechanism contribution
- Revenue reported without mechanism performance data
- Selection pressure metrics absent from reviews
- Human governors focus only on ARR

**Mitigations:**
- Doctrine enforces all 5 MVP business criteria
- Selection pressure is a first-class KPI (not in a footnote)
- Mechanism performance card required before any business is promoted
- Quarterly doctrine review by human governors

---

### R02 — Mission Drift: Becomes a Research Museum

**Probability:** Medium
**Impact:** High — produces elegant mechanisms that create no economic value

**Description:**
Research ingestion and mechanism design become the primary activity. Deployment velocity drops to near zero.

**Warning signs:**
- Mechanism registry grows faster than deployment count
- No customer revenue despite active R&D
- "This mechanism isn't ready yet" becomes a blocking phrase
- Eval harness exists but no production workflows use it

**Mitigations:**
- Translation layer is judged by deployment velocity, not mechanism quality alone
- Hard rule: any mechanism in the registry for >90 days without a deployment plan is flagged
- Monthly milestone: at least one mechanism must be live in production by end of Phase 1

---

### R03 — Mission Drift: Becomes a Generic Agent Company

**Probability:** High (natural gravity)
**Impact:** High — the automation works but the alignment thesis is unproven

**Description:**
Lots of automation is built, workflows run, revenue is generated — but no distinctive alignment mechanism is measurably responsible for the advantage.

**Warning signs:**
- Customers buy because it's fast, not because it's reliable
- Mechanism performance cards exist but show no delta vs baseline
- Marketing focuses on "AI-powered" rather than "verified" or "auditable"
- No mechanism has been reused across 2+ businesses

**Mitigations:**
- Every launched business must include at least one mechanism with a measurable effect (required by doctrine)
- Eval harness must show baseline vs mechanism delta before launch
- Mechanism reuse count is a tracked KPI

---

## Execution Risks

### R04 — Unconstrained Agent Action

**Probability:** Medium
**Impact:** High — agent takes irreversible action, damages customer trust or causes legal exposure

**Description:**
An agent bypasses or misunderstands the approval matrix and sends emails, modifies data, or takes external actions without authorization.

**Mitigations:**
- Approval matrix enforced at Policy Engine level (not just prompts)
- All T3 actions blocked at the infrastructure layer, not just the model layer
- Audit log captures all actions, including blocked attempts
- Initial deployments use allowlists (only permitted tools active)
- Human in the loop for all customer-facing delivery in Phase 1

---

### R05 — Hallucination in Compliance Output

**Probability:** High (without mitigation)
**Impact:** Critical — false compliance claim causes customer legal harm

**Description:**
Agent produces a compliance mapping claiming evidence supports a control when it does not. Customer relies on this in an audit. Audit fails.

**Mitigations:**
- Uncertainty-gated execution enforced on every claim (core mechanism)
- Citations required for every SUPPORTED classification
- Unsupported claim rate tracked in telemetry
- Human review required before customer delivery in Phase 1
- Clear customer disclosure: "AI-drafted, human-reviewed"

---

### R06 — Telemetry Not Collected

**Probability:** Medium
**Impact:** High — cannot prove the thesis, cannot improve the engine

**Description:**
Traces are incomplete, inconsistent, or never analyzed. The feedback loop never closes.

**Mitigations:**
- Trace schema defined before first workflow run
- Trace write is not optional — it is part of the task completion contract
- Weekly trace review as part of Phase 1 ops
- If trace is missing: task is considered incomplete

---

### R07 — Eval Suite Not Built First

**Probability:** Medium
**Impact:** Medium — cannot measure mechanism effect, drift goes undetected

**Mitigations:**
- Eval suite (20 test cases) is a Phase 1 prerequisite, not a Phase 2 task
- No mechanism is promoted to the registry without passing its eval suite
- Eval results are stored in the repo alongside the mechanism spec

---

### R08 — Paperclip Fork Diverges Too Far

**Probability:** Low-Medium
**Impact:** Medium — cannot merge upstream improvements, maintenance cost grows

**Description:**
Custom Meta-Engine additions make the Paperclip fork hard to maintain or sync with upstream changes.

**Mitigations:**
- Meta-Engine additions live under `meta-engine/` — a separate, clean namespace
- Core Paperclip files modified only when necessary
- Document every fork-specific change in `docs/meta-engine/fork-changes.md`
- Quarterly upstream sync review

---

### R09 — OpenClaw Scope Creep

**Probability:** Medium
**Impact:** Medium — agent takes broad actions in the real world before governance is solid

**Description:**
OpenClaw's browser and tool access is broader than needed for the MVP. An agent uses it to take actions outside the intended workflow scope.

**Mitigations:**
- OpenClaw configured with strict allowlists (only permitted URLs and tools)
- Browser profiles isolated per workflow
- All OpenClaw actions logged and reviewed during Phase 1
- Start with file-only access; add browser only when needed

---

### R10 — Customers Misunderstand AI Reliability Guarantees

**Probability:** High
**Impact:** High — reputational and legal risk

**Description:**
Customer assumes AI output is 100% accurate. Uses it directly without human review.

**Mitigations:**
- Every report includes explicit AI-draft disclaimer
- Report includes confidence scores and escalation list
- Customer onboarding includes: "All outputs require human review before use"
- Phase 1: human review before every delivery (no fully automated delivery)
- Consider: liability clause in customer agreement
