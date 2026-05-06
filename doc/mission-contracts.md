# Mission Contracts

Mission contracts are the control-plane handoff that turns a broad user request into explicit scope, acceptance criteria, and required evidence gates.

## Issue Document Convention

Store the contract as an issue document:

- key: `mission`
- title: `Mission Contract`
- format: `markdown`
- body: deterministic JSON formatted by `formatMissionContractDocumentBody`

Use `buildMissionContractIssueDocument(contract)` from `@paperclipai/shared` when creating or updating this document. Do not hand-assemble the key or body in agents.

## Schema

The v1 schema is exported as `missionContractSchema` from `@paperclipai/shared`.

```json
{
  "version": 1,
  "request": "Fix /trips false empty state after itinerary generation",
  "scope": ["route:/trips", "route:/launch", "issue:PC-639"],
  "acceptanceCriteria": [
    "/trips lists generated itineraries for ownerId and legacy userId trips",
    "production smoke evidence is attached before the parent issue is done"
  ],
  "requiredGates": ["implementation", "review", "qa", "release", "production_smoke"],
  "boardDecisions": [],
  "donePolicy": "all_required_gates_passed"
}
```

## Required Gates

`requiredGates` is a unique ordered list. Supported gates:

- `implementation`
- `review`
- `qa`
- `release`
- `production_smoke`

The default and only current `donePolicy` is `all_required_gates_passed`: a parent mission cannot honestly be considered complete until each required gate has linked evidence or an explicit board decision in the contract.

## Board Decisions

Use `boardDecisions` only for true product, security, privacy, spend, or business ambiguity. Each decision must be decision-ready with two to four options and may include `recommendedOptionId`. This keeps Paperclip aligned with the board MCQ rule and prevents agents from blocking on open-ended questions.
