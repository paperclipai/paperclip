---
name: compliance-operator
description: >
  Execute compliance evidence mapping workflows. Use when you are the Operator
  or QA agent in the Compliance Operator business. Covers: reading control
  frameworks, indexing evidence documents, mapping evidence to controls,
  applying uncertainty gates, writing structured draft reports, and writing
  telemetry traces.
---

# Compliance Operator Skill

This skill defines the domain workflow for the Compliance Operator business.
It is used by the **Operator Agent** (evidence mapping) and the **QA Agent** (verification).

---

## Workspace Layout

Every engagement has a workspace directory. Its path is in `PAPERCLIP_WORKSPACE_CWD`
or configured in the agent's `cwd`. The layout is:

```
workspace/
├── input/
│   ├── controls.json          ← control framework (required)
│   └── evidence/              ← all uploaded evidence documents
│       ├── access_policy.pdf
│       ├── incident_log.csv
│       └── ...
├── output/
│   ├── report-draft.json      ← Operator writes here; QA reads and annotates
│   └── trace.json             ← append one entry per run (never overwrite)
└── TASK.md                    ← task context written by COO (read this first)
```

---

## controls.json Format

```json
{
  "framework": "SOC 2 Type II",
  "controls": [
    {
      "id": "CC6.1",
      "title": "Logical and Physical Access Controls",
      "description": "The entity implements logical access security measures...",
      "expected_evidence_types": ["access policy", "user access review", "MFA config"]
    }
  ]
}
```

---

## report-draft.json Format (Operator writes, QA annotates)

```json
{
  "engagement_id": "<paperclip-issue-id>",
  "framework": "SOC 2 Type II",
  "generated_at": "<ISO8601>",
  "generated_by": "<operator-agent-id>",
  "controls": [
    {
      "id": "CC6.1",
      "title": "Logical and Physical Access Controls",
      "status": "SUPPORTED | PARTIAL | MISSING",
      "gate_decision": "proceed | verify | escalate",
      "confidence_score": 0.85,
      "evidence": [
        {
          "document": "access_policy.pdf",
          "section": "Section 4.2 – Access Provisioning",
          "excerpt": "All access requests must be approved by the system owner...",
          "date": "2025-11-15",
          "relevance": "Directly addresses access control requirement"
        }
      ],
      "gap_notes": "",
      "qa_review": null
    }
  ],
  "summary": {
    "total_controls": 0,
    "supported": 0,
    "partial": 0,
    "missing": 0,
    "escalated": 0
  }
}
```

`qa_review` is null when the Operator writes it. QA fills it in:

```json
"qa_review": {
  "reviewed_by": "<qa-agent-id>",
  "reviewed_at": "<ISO8601>",
  "decision": "confirmed | downgraded | escalated",
  "notes": "Evidence is from 2024; may be out of period for SOC 2 window."
}
```

---

## trace.json Format (append — never overwrite)

```json
[
  {
    "trace_id": "<uuid>",
    "run_id": "<PAPERCLIP_RUN_ID>",
    "issue_id": "<PAPERCLIP_TASK_ID>",
    "agent_role": "operator | qa | coo",
    "timestamp_start": "<ISO8601>",
    "timestamp_end": "<ISO8601>",
    "mechanism_applied": ["uncertainty_gated_execution"],
    "stats": {
      "controls_processed": 12,
      "proceed": 8,
      "verify": 3,
      "escalate": 1
    },
    "corrections_by_reviewer": 0
  }
]
```

Read the existing `output/trace.json` first (if it exists), then append your entry, then write the whole array back.

---

## Operator Workflow (step by step)

### Step 1 — Read task context
Read `TASK.md` and the Paperclip issue (`GET /api/issues/$PAPERCLIP_TASK_ID`) to understand scope.

### Step 2 — Load the control framework
Read `input/controls.json`. Extract all control IDs, titles, descriptions, and expected evidence types.

### Step 3 — Index evidence documents
Read all files in `input/evidence/`. For each document, note:
- filename
- document type (policy, log, screenshot, config, certificate, etc.)
- date (if visible)
- which controls it could plausibly support

### Step 4 — Map evidence to controls
For each control:
1. Search your evidence index for relevant passages
2. Extract the most relevant excerpt (verbatim, with source location)
3. Assign a `confidence_score` (0.0–1.0):
   - **0.9–1.0**: clear, direct, recent evidence; no ambiguity
   - **0.7–0.89**: good evidence but minor gaps (e.g., slightly old, indirect)
   - **0.4–0.69**: partial or ambiguous evidence
   - **0.0–0.39**: no usable evidence, or evidence clearly insufficient

### Step 5 — Apply the uncertainty gate (required)

For every control, apply this gate:

```
confidence >= 0.75 AND at least 1 evidence citation present
  → gate_decision = "proceed"
  → status = "SUPPORTED" (or "PARTIAL" if evidence is incomplete but still ≥0.75)

0.40 <= confidence < 0.75
  → gate_decision = "verify"
  → status = "PARTIAL"

confidence < 0.40 OR no evidence citations
  → gate_decision = "escalate"
  → status = "MISSING"
```

**This gate is mandatory. Do not skip it. Do not round up confidence scores.**

### Step 6 — Write output/report-draft.json
Write the full structured JSON. Populate `summary` counts.

### Step 7 — Write trace entry
Append one entry to `output/trace.json`.

### Step 8 — Update Paperclip
Post a comment on the issue with:
- total controls processed
- proceed / verify / escalate counts
- any notable patterns (e.g., "most evidence is from 2024; period coverage may be an issue")

If there are any `escalate` items: set issue status to `in_review` and assign to the QA Agent.
If all items are `proceed`: set issue status to `in_review` and assign to the QA Agent (still requires QA sign-off).

---

## QA Agent Workflow (step by step)

### Step 1 — Read the draft
Read `output/report-draft.json`. Focus on controls where `gate_decision` is `verify` or `escalate`.

### Step 2 — Re-verify each flagged control
For every control with `gate_decision != "proceed"`:
1. Re-read the cited source documents yourself (do not rely on Operator's excerpt alone)
2. Search for any additional evidence the Operator may have missed
3. Make an independent decision:
   - **confirmed**: Operator's assessment is correct, gate decision stands
   - **downgraded**: evidence is weaker than Operator rated; lower confidence
   - **escalated**: this needs human review; evidence is insufficient or contradictory

### Step 3 — Also spot-check `proceed` items
Pick 2–3 `proceed` controls at random. Re-read their citations. Flag any where you disagree.

### Step 4 — Fill in `qa_review` for each control you reviewed
Write your `qa_review` into the report-draft.json (in-place update).

### Step 5 — Write trace entry
Append one QA trace entry to `output/trace.json`.

### Step 6 — Update Paperclip
Post a comment with:
- QA verdict summary
- Any controls you downgraded or escalated
- Whether the draft is ready for human review

If any controls remain `escalate` after QA: create a Paperclip approval request for human review.
If all controls are resolved: set issue status to `in_review`, assign to the COO for human approval routing.

---

## Uncertainty Gate — Why It Exists

The uncertainty gate is the core alignment mechanism in this business.

Its purpose: **prevent confident-sounding outputs that lack supporting evidence.**

Customers rely on this output in real audits. A false `SUPPORTED` classification could cause an audit to fail. The gate makes the system's uncertainty visible rather than hiding it behind fluent language.

When in doubt: **escalate, don't proceed.** A correctly escalated item is a good outcome.
A falsely proceeded item is a mission failure.

---

## Evidence Quality Rules

- **Never manufacture evidence.** If no document supports a control, the status is MISSING.
- **Never paraphrase evidence into a different meaning.** Use verbatim excerpts.
- **Date matters.** Evidence older than 12 months should reduce confidence unless the control is timeless.
- **Indirect evidence reduces confidence.** A general security policy is weaker evidence than a specific access control procedure.
- **Multiple documents corroborate each other.** Two independent sources → higher confidence than one.
- **Screenshots and configs count.** They are often stronger than policy docs for technical controls.
