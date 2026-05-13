---
name: clause-extraction-presets
description: Library of 13 standard clause-extraction queries any specialist or workflow can reuse. Each preset has a regex that matches a column/topic name, a strict output format, and a precision-engineered prompt. Used by `tabular-review` and by any specialist that needs to pull a specific clause type from a document.
tools: [read]
inputs:
  - topic_or_column_title: string
outputs:
  - matched_preset: object?
  - prompt: string
  - format: text | bulleted_list | date | yes_no | number
---

# Clause Extraction Presets

A precision-engineered library of 13 named extractors. Each one is a tightly scoped prompt + output format. Specialists call this skill to avoid re-inventing extraction prompts.

## The 13 presets

### 1. Parties
- **Matches:** `/\bpart(y|ies)\b/i`
- **Format:** `bulleted_list`
- **Prompt:** List all parties to this agreement. For each party, state their full legal name, entity type, and defined role. One party per bullet. No additional commentary. Example: `• ABC Corp, a Delaware corporation ("Company")`.

### 2. Governing Law
- **Matches:** `/\bgoverning law\b|\bjurisdiction\b/i`
- **Format:** `text`
- **Prompt:** State only the governing law of this agreement using the short-form jurisdiction name (e.g., "New York Law", "English Law"). No other text.

### 3. Effective Date
- **Matches:** `/\beffective date\b/i`
- **Format:** `date`
- **Prompt:** State only the effective date in `DD Mon YYYY` format. If not explicitly stated, return "Not specified".

### 4. Term
- **Matches:** `/\bterm\b|\bduration\b/i`
- **Format:** `text`
- **Prompt:** State only the duration in concise form (e.g., "3 years", "24 months", "perpetual"). No other text.

### 5. Termination
- **Matches:** `/\bterminat(e|ion|ing)\b/i`
- **Format:** `text`
- **Prompt:** Extract the termination provisions. State who may terminate, the trigger events, required notice period, any cure period, and the key consequences of termination. Be concise.

### 6. Change of Control
- **Matches:** `/\bchange of control\b/i`
- **Format:** `text`
- **Prompt:** Identify any change of control provisions. Summarize the trigger events, consequences, consent requirements, and any related termination or acceleration rights. Be concise.

### 7. Confidentiality
- **Matches:** `/\bconfidential(ity)?\b|\bnon-?disclosure\b/i`
- **Format:** `text`
- **Prompt:** Summarize the confidentiality obligations: scope of confidential information, permitted disclosures, use restrictions, duration, and key carve-outs.

### 8. Assignment
- **Matches:** `/\bassign(ment|ability)?\b/i`
- **Format:** `yes_no`
- **Prompt:** Is assignment of this agreement permitted without the other party's consent?

### 9. Payment & Fees
- **Matches:** `/\bpayment\b|\bfees?\b/i`
- **Format:** `text`
- **Prompt:** State the key payment obligations concisely: amount, timing, and currency. Note any late payment consequences.

### 10. Amendment
- **Matches:** `/\bamendment\b|\bvariation\b/i`
- **Format:** `text`
- **Prompt:** Summarize the amendment provisions: how amendments may be made, who must consent, and any formality requirements.

### 11. Indemnity
- **Matches:** `/\bindemni(ty|ties|fication)\b/i`
- **Format:** `text`
- **Prompt:** Summarize the indemnity provisions: who indemnifies whom, the scope of indemnified losses, any liability caps or exclusions, and key claims procedures.

### 12. Warranties
- **Matches:** `/\bwarrant(y|ies|ing)\b|\brepresentations?\b/i`
- **Format:** `text`
- **Prompt:** Identify and describe the key representations and warranties. Highlight any non-standard warranties.

### 13. Force Majeure
- **Matches:** `/\bforce majeure\b/i`
- **Format:** `yes_no`
- **Prompt:** Does this agreement contain a force majeure clause?

## Procedure (when invoked)

1. Trim and normalize the input topic/title.
2. Run each preset's regex; return the first match.
3. If no match, return null — the caller falls back to a generic prompt.

## Output schema

```yaml
matched_preset:
  name: <preset name>
  format: <format>
prompt: <verbatim prompt>
format: <format>
```

## Hard rules

- Never modify a preset's prompt or format on the fly. Variations create non-comparable cells across a tabular review.
- New presets are added by editing this skill, not by improvising. Promotion of a custom prompt to a preset is a deliberate decision.

## Reference implementation

Lifted from [willchen96/mike](https://github.com/willchen96/mike) `frontend/src/app/components/tabular/columnPresets.ts`. The 13 presets and their prompts are reproduced verbatim with attribution; the format names align with Odysseus's column-format enum.
