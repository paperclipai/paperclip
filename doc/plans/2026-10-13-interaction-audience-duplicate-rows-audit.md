# Interaction audience duplicate-row audit — 2026-10-13

## Scope and decision

Collapse the five-row `it.each` in
`server/src/services/issue-thread-interaction-resolution.test.ts` into one test.
Four expanded test invocations and six net test lines are removed.

## Retained coverage

Each former row only supplied an interaction-kind name to the test title.
The callback accepted no row argument. Every invocation supplied the same
`agent` actor and the same fresh `interaction()` fixture to
`evaluateIssueThreadInteractionResolverAudience`, then checked the same
`allowed: true`, `effectiveResolverPolicy: "anyone"`, and `reason: "allow_anyone"`
result. The retained test preserves that entire assertion.

The evaluator's input contract has no interaction-kind property, and its
implementation evaluates actor identity, creator/run attribution, addressee,
resolver policy, and additional restrictions. The removed names could never
select different behavior. The fixture creates a plain object; neither the
test nor the evaluator mutates shared state or performs external operations.
This file has no per-row hooks or mocks.

Keep the separate two-row `not_creator` test: its rows supply different creator
agent and source-run values and exercise independent exclusion conditions.
All other audience, governance, and attention assertions remain unchanged.

## Validation and limits

Static review confirmed identical inputs and assertions and no row-specific
side effects. Supervisor validation passed the complete owner suite: **12/12**
in 1.23 seconds. No production files changed. This is a small reduction in
redundant test invocations; no measured CI saving is claimed.

## Authorship

OpenAI `gpt-6.1-sol` audit worker, supervised as part of the test-removal campaign.
