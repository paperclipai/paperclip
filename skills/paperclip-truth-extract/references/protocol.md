# Truth Extraction Protocol — Full Pipeline

The 9-stage deterministic pipeline. Every stage must run in order. Skipping
stages produces lossy or unverifiable output.

## Stage 1 — Normalize the transcript

### Preferred JSON input

```json
[
  {
    "sentence": "The biggest pain point is trying to figure out how...",
    "startTime": "03:44",
    "endTime": "04:01",
    "speaker_name": "Andrea Field",
    "speaker_id": 0
  }
]
```

### Raw text input

```
[03:44] Andrea Field: The biggest pain point is...
```

### Plain-text fallback (no speaker, no timestamp)

```yaml
speaker_name: "UNKNOWN"
start_time: null
end_time: null
```

Assign deterministic line IDs anyway.

### Normalized utterance schema

```yaml
utterance:
  utterance_id: U000001
  speaker_id: 0
  speaker_name: Andrea Field
  start_time: "03:44"
  end_time: "04:01"
  text: "But I guess the biggest pain point is..."
  raw_index: 71
```

### Utterance ID rule

Sort by original transcript order. Assign IDs sequentially: `U000001`, `U000002`, …
Never use random IDs. Never re-order before assignment.

## Stage 2 — Segment into evidence spans

A **span** is a group of utterances expressing one connected idea.

### Merge adjacent utterances when:

- Same speaker continues one thought.
- A sentence is split across multiple transcript rows.
- A question/answer pair is required to understand the truth.
- Demo audio needs to be captured as a single demonstration.

### Do NOT merge when:

- Topic changes.
- Speaker changes to introduce a new claim.
- Banter shifts into business content.
- One idea becomes another idea.

### Span schema

```yaml
span:
  span_id: S000001
  utterance_ids:
    - U000071
    - U000072
  speaker_names:
    - Andrea Field
  start_time: "03:44"
  end_time: "04:03"
  text: "But I guess the biggest pain point..."
```

## Stage 3 — Extract truth atoms

Run the extraction prompt from `prompts.md` against each chunk (or the whole
transcript if ≤ 120 utterances).

### Temp atom IDs during extraction

Use temporary IDs (e.g., `temp_atom_id: tmp_042`) during generation. Do **not**
assign final `T000###` IDs during extraction — the model may process chunks out
of order.

### Final atom ID rule (after merge)

After merging all chunk outputs, sort atoms by:

1. First source utterance ID (ascending).
2. Source `start_time` (ascending).
3. `atom_type` (alphabetical).
4. `atom_text` (alphabetical).

Then assign final IDs: `T000001`, `T000002`, …

## Stage 4 — Classify by atom type

Apply the taxonomy from `schemas.md`. Every atom gets exactly one
`atom_type`. If an utterance produces multiple durable claims of different
types, create multiple atoms.

## Stage 5 — Score durability (0–5)

| Score | Meaning |
|-------|---------|
| 5 | Mission-critical. Forgetting it materially harms planning, proposal, or system design. |
| 4 | Strong durable truth. Important for strategy, implementation, or follow-up. |
| 3 | Useful truth. Should be retained but may not drive core strategy. |
| 2 | Contextual truth. Useful for tone or background, but not central. |
| 1 | Low-durability context or banter. |
| 0 | Noise, filler, greeting, incomplete fragment, or irrelevant aside. |

### Routing by score

| Score | List |
|-------|------|
| 3, 4, 5 | `truth_atoms` |
| 1, 2 | `context_atoms` |
| 0 | `noise_atoms` |

## Stage 6 — Score confidence (0.0–1.0)

| Score | Meaning |
|-------|---------|
| 1.00 | Exact explicit statement. |
| 0.85 | Strong direct statement with minor normalization. |
| 0.70 | Locally inferred from nearby evidence. |
| 0.50 | Ambiguous but plausible; flag for review. |
| < 0.50 | Do not include as a truth atom. Consider `open_question` instead. |

## Stage 7 — Produce the coverage ledger

**Every utterance must appear.** This prevents omissions.

```yaml
coverage_ledger:
  - utterance_id: U000001
    status: noise
    linked_atom_ids: []
    reason: greeting
  - utterance_id: U000071
    status: covered
    linked_atom_ids:
      - T000014
      - T000015
    reason: durable pain point and communication goal extracted
```

Allowed statuses: `covered`, `context`, `noise`, `duplicate`, `fragment`,
`unclear`. No utterance may be omitted.

## Stage 8 — Hallucination audit

Run the hallucination-audit prompt (`prompts.md`). Checks:

- Every atom has at least one source utterance.
- Every `evidence_quote` appears verbatim in the transcript.
- Every `speaker_name` matches the cited utterance.
- Every timestamp matches the cited utterance.
- No atom introduces outside facts.
- Inferred atoms are marked `evidence_mode: inferred`.
- Demo content is not mistaken for real commitment.
- Jokes are not promoted to business decisions.
- Repeated ideas are not double-counted unless they add new detail.

Apply the audit's `keep | revise | downgrade | remove` recommendations.

## Stage 9 — Omission audit

Run the omission-audit prompt (`prompts.md`). Look specifically for missed:

- Stated goals.
- Pain points.
- Capacity constraints.
- Business-model implications.
- Tool / capability claims.
- Compliance needs.
- Market / client-profile details.
- Proposed workflows.
- Proposed automations.
- Risks.
- Unresolved questions.
- Next steps.
- Timing references.
- Ownership references.

Any missed truth becomes a new atom or is marked intentionally excluded with a
reason.

## Chunking strategy (long transcripts)

For > ~120 utterances:

```yaml
chunking:
  chunk_size: 120 utterances
  overlap: 10 utterances
  chunk_boundary: utterance_id
  overlap_rule: >
    Output each atom only once, assigned to the earliest chunk where
    full evidence appears.
```

**Never ask one model call to extract everything from a long transcript.** Use
chunks, then merge with the merge prompt from `prompts.md`.

## Special-handling cases

### Fragmented utterances

Broken lines like:

```
"And really the goal is."
"So really we're looking at truly Fortune 100 quality..."
```

Merge the meaning but keep **all** source utterance IDs.

### Demo content

If a speaker plays or narrates a mock/demo:

```yaml
atom_type: demo_content
```

Unless the speaker explicitly says it is a real capability, current product, or
concrete plan. Demo content is a signal of aspiration or illustration, not a
commitment.

### Jokes and banter

Classify as `banter_context` or `noise` **unless** they affect:

- Relationship context.
- Trust.
- Risk.
- IP concern.
- Tone.
- Next steps.

### Repeated ideas

If repeated without adding detail: mark later utterances as `duplicate` in the
coverage ledger. If repeated with new detail: create a new atom with the new
detail and cite all relevant utterances.

### Speaker uncertainty ("we")

Do not over-identify the organization. If local context does not clearly bind
"we" to a group, write: `The speaker said "we"...` in the atom text. Do not
assume institutional commitment from pronoun use alone.

## Deterministic validation checklist

Before accepting the final ledger:

```yaml
validation:
  source_integrity:
    - transcript parsed successfully
    - all utterances have stable IDs
    - utterance order preserved
    - speaker names preserved
    - timestamps preserved when available

  atom_integrity:
    - every truth atom has evidence quote
    - every truth atom has source utterance ID
    - every truth atom has speaker attribution
    - every truth atom has durability score
    - every truth atom has confidence score
    - every truth atom has atom_type

  no_hallucination:
    - no atom without transcript evidence
    - no outside facts added
    - no unsupported business conclusions
    - inferred claims marked inferred

  coverage:
    - every utterance appears in coverage ledger
    - no unassigned utterances
    - noise has reason
    - fragments have reason

  completeness:
    - omission audit completed
    - hallucination audit completed
    - duplicate audit completed
    - final IDs reassigned deterministically
```

If any line fails, iterate — do not ship.

## Reference pseudocode

```python
def extract_transcript_truths(transcript):
    utterances = normalize_transcript(transcript)
    utterances = assign_utterance_ids(utterances)

    chunks = chunk_utterances(utterances, chunk_size=120, overlap=10)

    chunk_outputs = []
    for chunk in chunks:
        extraction = call_llm(
            system_prompt=TRUTH_EXTRACTION_SYSTEM_PROMPT,
            user_prompt=build_extraction_prompt(chunk),
            temperature=0,
        )
        validate_chunk_output(extraction)
        chunk_outputs.append(extraction)

    merged = call_llm(
        system_prompt=MERGE_SYSTEM_PROMPT,
        user_prompt=build_merge_prompt(chunk_outputs),
        temperature=0,
    )

    omissions = call_llm(
        system_prompt=OMISSION_AUDIT_SYSTEM_PROMPT,
        user_prompt=build_omission_prompt(utterances, merged),
        temperature=0,
    )
    merged = apply_valid_omissions(merged, omissions)

    hallucinations = call_llm(
        system_prompt=HALLUCINATION_AUDIT_SYSTEM_PROMPT,
        user_prompt=build_hallucination_prompt(utterances, merged),
        temperature=0,
    )
    merged = remove_or_revise_invalid_atoms(merged, hallucinations)

    merged = final_sort_and_assign_ids(merged)
    validate_final_output(merged, utterances)

    return {
        "json": merged,
        "yaml": render_yaml(merged),
        "markdown": render_markdown(merged),
    }
```
