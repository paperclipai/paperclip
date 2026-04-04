# Selected Live Strict Candidate Checklist

## Purpose

Define which live publish runs are eligible for strict rollout and how the decision is split between `Publisher` and `Editor-in-Chief`.

## Publisher Proposal Checklist

`Publisher` may propose a run for live strict only when all of the following are true:

- `publishMode=publish`
- `lane=publish`
- `publishReadyGateCanary=true`
- merged `publish_ready` preflight is already `pass`
- no unresolved publish-boundary anomalies on the same issue lineage
- target slug is explicit and readable
- public verify contract mode is `strict`
- no active stop reason exists for the same article path

## Editor-in-Chief Approval Checklist

`Editor-in-Chief` may approve the proposal only when all of the following are true:

- opening is clear enough for a general reader
- ending carries a usable decision
- title promise and body structure align
- visual output is either genuinely good or safely represented by structured fallback
- research grounding artifacts are complete
- the article does not rely on unresolved uncertainty as if it were fact

## Hard Blocks

Do not select a run for live strict when any of these are true:

- notebook reference missing
- uncertainty ledger missing
- duplicate visual assets unresolved
- title/body drift still present
- public verify contract not present
- publish boundary still running in compat-only assumptions

## Decision Record

Every selected live strict run should leave a short record with:

- proposer: `Publisher`
- approver: `Editor-in-Chief`
- why this run is suitable
- which preflight artifacts were checked
- whether visuals use real images or structured fallback

## Operational Rule

If the proposal record is missing, the run stays `compat`.
