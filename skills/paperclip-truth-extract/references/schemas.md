# Schemas, Taxonomy, and Output Contracts

## Truth atom schema

```yaml
truth_atom:
  atom_id: T000001          # assigned only after final merge + sort
  atom_text: ""             # one durable idea, normalized for clarity
  atom_type: ""             # see taxonomy below
  durability_score: 0       # 0–5
  confidence_score: 0.0     # 0.0–1.0
  evidence_mode: direct     # direct | inferred
  speaker_name: ""
  speaker_id: null
  start_time: ""
  end_time: ""
  source_utterance_ids: []  # at least one
  evidence_quote: ""        # verbatim from transcript
  planning_relevance: ""    # why this truth would hurt if forgotten
  notes: ""
```

## Atom-type taxonomy (fixed — do not invent new types)

| Type | Description |
|------|-------------|
| `relationship_context` | Relationship, history, trust, prior collaboration. |
| `participant_role` | Who does what, owns what, or is responsible for what. |
| `business_goal` | Strategic objective, desired business outcome, growth aim. |
| `pain_point` | Problem, burden, friction, bottleneck, unmet need. |
| `constraint` | Limitation, timing issue, budget issue, ownership issue, capacity issue. |
| `workflow` | Process, sequence, handoff, operational pattern. |
| `capability` | Existing or proposed ability, tool, system, automation, service. |
| `product_concept` | Feature, product idea, app idea, experience concept. |
| `client_market` | Client type, target market, account size, geography, segment. |
| `compliance` | Legal, regulatory, audit, Department of Labor, document rules. |
| `communication_strategy` | Messaging, education, personalization, benefits communication. |
| `sales_enablement` | Demo, proposal, prospecting, pitch, seminar follow-up, closing support. |
| `data_personalization` | Profile building, API data, employee attributes, personalization logic. |
| `risk` | IP risk, delivery risk, privacy risk, scope risk, operational risk. |
| `pricing_budget` | Cost model, budget, spend threshold, purchase constraint, retainer idea. |
| `timing` | Date, schedule, next meeting, launch timing, seminar timing. |
| `decision` | A decision made or implied as accepted in the meeting. |
| `next_step` | Future action someone committed to or proposed. |
| `open_question` | Unanswered question or unresolved issue. |
| `demo_content` | Content spoken by a product demo, mock walkthrough, or example experience. |
| `banter_context` | Low-durability social context that may affect tone but not planning. |

## Durability scale

| Score | Meaning |
|-------|---------|
| 5 | Mission-critical. Forgetting materially harms planning, proposal, or design. |
| 4 | Strong durable truth. Important for strategy, implementation, or follow-up. |
| 3 | Useful truth. Retain. May not drive core strategy. |
| 2 | Contextual. Useful for tone or background. |
| 1 | Low-durability context or banter. |
| 0 | Noise, filler, greeting, fragment, irrelevant aside. |

## Confidence scale

| Score | Meaning |
|-------|---------|
| 1.00 | Exact explicit statement. |
| 0.85 | Strong direct statement with minor normalization. |
| 0.70 | Locally inferred from nearby evidence. |
| 0.50 | Ambiguous but plausible; flag for review. |
| < 0.50 | Do not include as truth atom — consider `open_question`. |

## Coverage-ledger statuses

`covered`, `context`, `noise`, `duplicate`, `fragment`, `unclear`.

Every utterance must appear with exactly one status and a `reason`.

## Canonical JSON output contract

```json
{
  "transcript_id": "string",
  "extraction_version": "truth_atom_extractor_v1",
  "source": {
    "file_name": "string",
    "utterance_count": 0,
    "speaker_count": 0
  },
  "participants": [
    {
      "speaker_id": 0,
      "speaker_name": "string",
      "observed_role": "string",
      "evidence_utterance_ids": []
    }
  ],
  "truth_atoms": [
    {
      "atom_id": "T000001",
      "atom_text": "string",
      "atom_type": "pain_point",
      "durability_score": 5,
      "confidence_score": 0.95,
      "evidence_mode": "direct",
      "speaker_name": "string",
      "speaker_id": 0,
      "start_time": "string",
      "end_time": "string",
      "source_utterance_ids": ["U000001"],
      "evidence_quote": "string",
      "planning_relevance": "string",
      "notes": "string"
    }
  ],
  "context_atoms": [],
  "noise_atoms": [],
  "open_questions": [],
  "risks": [],
  "coverage_ledger": []
}
```

## YAML output contract

```yaml
transcript_id: ""
extraction_version: truth_atom_extractor_v1

source:
  file_name: ""
  utterance_count: 0
  speaker_count: 0

participants:
  - speaker_id: 0
    speaker_name: ""
    observed_role: ""
    evidence_utterance_ids: []

truth_atoms:
  - atom_id: T000001
    atom_text: ""
    atom_type: pain_point
    durability_score: 5
    confidence_score: 0.95
    evidence_mode: direct
    speaker_name: ""
    speaker_id: 0
    start_time: ""
    end_time: ""
    source_utterance_ids: []
    evidence_quote: ""
    planning_relevance: ""
    notes: ""

context_atoms: []
noise_atoms: []
open_questions: []
risks: []
coverage_ledger: []
```

## Markdown export template

```markdown
# Transcript Truth Extraction

## Run metadata

- Transcript ID:
- Extraction version:
- Total truth atoms:
- Total context atoms:
- Total noise atoms:

## Executive truth summary

### Highest-durability truths
1. ...
2. ...
3. ...

## Truth atoms

### T000001 — [atom_type]

**Truth:** ...

**Durability:** 5  **Confidence:** 0.95  **Evidence mode:** direct

**Source:**
- Speaker:
- Time:
- Utterances:
- Quote:

> ...

**Planning relevance:** ...

---

## Context atoms
...

## Noise atoms
...

## Open questions
...

## Risks
...

## Coverage report
- Total utterances:
- Covered:
- Context:
- Noise:
- Duplicate:
- Fragment:
- Unclear:
```
