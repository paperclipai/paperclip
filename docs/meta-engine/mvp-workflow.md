# MVP Workflow Spec: AI Compliance Operator

Status: Working spec
Version: 0.1
Last updated: 2026-03-14

---

## 1. Why This Workflow

The Compliance Operator is the best first wedge because:

- Reliability and auditability are **directly monetizable** (not just nice-to-have)
- Buyers understand why they pay: compliance failures cost tens or hundreds of thousands
- The alignment mechanism (uncertainty gating) is **legible to buyers**
- Every claim needs evidence → natural structure for confidence scoring
- Audit trails are a feature, not overhead
- Recurring demand; not a one-time engagement

---

## 2. Business Description

An autonomous AI agent that:

1. Ingests company policies, control frameworks, and evidence documents
2. Maps available evidence to each control
3. Identifies gaps (missing or weak evidence)
4. Produces a draft audit-ready report with citations
5. Escalates low-confidence sections to a human reviewer

**Customers:** Companies preparing for SOC 2, ISO 27001, HIPAA, PCI-DSS, or internal audit reviews.

**Value prop:** Reduces compliance audit prep from weeks to days, with a traceable evidence trail.

---

## 3. Scope (MVP)

### In scope
- Document ingestion (PDF, DOCX, markdown, plain text)
- Control framework ingestion (structured list of controls)
- Evidence-to-control mapping
- Gap detection (missing or insufficient evidence)
- Draft report generation with citations per claim
- Uncertainty-gated routing (PROCEED / VERIFY / ESCALATE)
- Full trace logging per run
- Human review interface (Paperclip approval + comment)

### Out of scope (Phase 1)
- Continuous monitoring
- Real-time compliance dashboards
- Direct SaaS integrations (e.g., pull from Jira, GitHub, AWS Config)
- Automated remediation
- Multi-framework support (start with one framework)

---

## 4. Workflow Steps

### Step 1: Intake
- Customer provides:
  - Control framework (e.g., SOC 2 Type II control list)
  - Evidence package (folder of docs)
- System validates: formats readable, framework recognized

### Step 2: Control Extraction
- Agent reads control framework
- Extracts structured list:
  - Control ID
  - Control description
  - Expected evidence types

### Step 3: Evidence Indexing
- Agent reads all evidence documents
- Indexes by: document type, relevant controls, date range, owner

### Step 4: Evidence-to-Control Mapping
- For each control:
  - Search indexed evidence
  - Find supporting passages
  - Record: source document, page/section, confidence score
  - Classify: SUPPORTED / PARTIAL / MISSING

### Step 5: Gap Detection
- Flag controls where:
  - No evidence found: GAP
  - Evidence is weak or outdated: PARTIAL
  - Evidence is ambiguous: UNCERTAIN

### Step 6: Uncertainty Gate Applied
- For each claim in the mapping:
  - `confidence >= 0.75`: PROCEED
  - `0.4 <= confidence < 0.75`: VERIFY (route to QA Agent)
  - `confidence < 0.4` or no citation: ESCALATE to human

### Step 7: QA Agent Review (for VERIFY items)
- QA Agent re-reads source documents
- Validates or corrects the mapping
- Either promotes to PROCEED or downgrades to ESCALATE

### Step 8: Draft Report Generation
- Produces structured report:
  - Executive summary
  - Control-by-control status
  - Evidence citations (document, section, date)
  - Gap list with recommended remediation
  - Escalation list (items needing human review)

### Step 9: Human Review
- Report appears in Paperclip as a task requiring approval
- Human reviewer reads draft + escalated items
- Approves, rejects sections, or adds comments
- Corrections stored in trace

### Step 10: Final Report Delivery
- Human-approved report delivered to customer
- Full trace archived

---

## 5. Alignment Mechanism: Uncertainty-Gated Execution

### Why this mechanism first

- Naturally fits the workflow (every claim needs a citation)
- Immediately measurable (before/after error rate, escalation quality)
- Legible to customers (they see the confidence scores and citations)
- Creates trust faster than capability alone

### Implementation spec

Every claim produced by the Operator Agent must include:

```json
{
  "claim_text": "...",
  "control_id": "CC6.1",
  "supporting_evidence": [
    {
      "document": "access_policy_v3.pdf",
      "section": "Section 4.2",
      "excerpt": "...",
      "date": "2025-11-15"
    }
  ],
  "confidence_score": 0.82,
  "gate_decision": "proceed"
}
```

Gate logic:
```
if confidence_score >= 0.75 and len(supporting_evidence) >= 1:
    gate_decision = "proceed"
elif confidence_score >= 0.40:
    gate_decision = "verify"
else:
    gate_decision = "escalate"
```

All claims with `gate_decision != "proceed"` are flagged in the report and queued for review.

### What we measure

| Metric | Baseline (no mechanism) | With mechanism |
|--------|------------------------|----------------|
| Unsupported claim rate | ? | Target: <5% |
| Human correction rate | ? | Target: <10% |
| Escalation justification rate | N/A | Target: >80% of escalations are valid |
| Reviewer time per report | ? | Target: 30% reduction |

Baseline is captured from first 10 pilot runs without the mechanism enforced. Then mechanism is enabled and delta measured.

---

## 6. Evaluation Suite (20 test cases)

The eval suite must be built before production use.

### Test case structure

```json
{
  "test_id": "tc_001",
  "control_framework": "soc2_type2_sample.json",
  "evidence_docs": ["..."],
  "expected_mapping": {
    "CC6.1": "SUPPORTED",
    "CC6.2": "PARTIAL",
    "CC6.3": "MISSING"
  },
  "expected_escalations": ["CC6.2"],
  "acceptable_error_rate": 0.05
}
```

### Test categories

| Category | Count | Purpose |
|----------|-------|---------|
| Well-evidenced controls | 5 | System should PROCEED with high confidence |
| Partial evidence | 5 | System should VERIFY |
| Missing evidence | 4 | System should ESCALATE |
| Ambiguous evidence | 3 | System should VERIFY or ESCALATE |
| Tricky edge cases | 3 | Outdated docs, conflicting evidence, wrong format |

---

## 7. Tech Stack (MVP)

| Component | Technology |
|-----------|-----------|
| Governance | Paperclip (this repo) |
| Agent runtime | Claude Code or claude_local adapter |
| Execution | OpenClaw (browser / file access) |
| Document parsing | Unstructured, PyMuPDF, or equivalent |
| Storage | Paperclip DB (issues, activity log) + file store |
| Telemetry | Custom trace store (meta-engine/telemetry) |
| Report format | Markdown → PDF |

---

## 8. Paperclip Configuration

### Company
- Name: `Compliance Operator (MVP)`
- Goal: `Produce reliable compliance audit drafts with uncertainty-gated evidence mapping`

### Agents
| Name | Role | Adapter | Wakeup |
|------|------|---------|--------|
| COO | Task coordination | claude_local | on_assignment |
| Operator | Compliance workflow execution | claude_local | on_assignment |
| QA | Verifier review | claude_local | on_assignment |

### Issues / Tasks
Each customer engagement = one Paperclip issue.

Subtasks:
- [ ] Ingest documents
- [ ] Extract controls
- [ ] Map evidence
- [ ] Apply uncertainty gate
- [ ] QA review (if triggered)
- [ ] Generate draft
- [ ] Human approval
- [ ] Deliver report

### Approvals
- Draft report delivery: requires human approval
- Any escalated claim: requires human comment before proceeding

---

## 9. Success Criteria (MVP)

Within 6–9 months:

| Metric | Minimum | Target |
|--------|---------|--------|
| ARR | $50k | $500k |
| Unsupported claim rate | <15% | <5% |
| Human correction rate | <20% | <10% |
| Escalation accuracy | >60% | >80% |
| Reports completed per week | 1 | 10 |
| Human hours per report | <4h | <1h |

---

## 10. What This Proves for the Meta-Engine

If this workflow succeeds:

1. The alignment mechanism (uncertainty gating) produces measurable economic advantage
2. Autonomous operation is feasible within the Paperclip governance shell
3. The substrate (policy engine + telemetry + eval harness) is reusable for the second business
4. Real-world data improves mechanism calibration
5. Customers prefer reliable, auditable outputs → first evidence of alignment-positive selection pressure
