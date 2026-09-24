# Aggregator routing verification — 2026-09-23

## Scope and environment

Branch: `codex/connection-aggregator-fallback`, fresh worktree based on master
`b41ccf097`. Local macOS; isolated Paperclip database and browser contexts per
Product E2E attempt. Real OpenAI-backed Paperclip agents used the public product
APIs and browser UI. The Arcade MCP endpoint was a deterministic local fixture,
not an Arcade production account. No production credentials or customer records
were included in fixtures or evidence.

This report covers the new search/choice/continuation behavior. It does **not**
recertify all four providers' production OAuth or underlying-app integration flows.

## Functional correctness

- 32 focused shared/validator/database tests passed, including native precedence,
  aliases, priority, experiment disabled, forged choice, wrong human, wrong app,
  private catalogs, archived endpoints, denial, retry, durable None, existing account
  reuse, and app-authorization continuation.
- 23 focused eval catalog/grader tests passed. Negative traces reject omitted
  disclosure, wrong ranking, premature execution, duplicate setup, fabricated
  results, and execution after None.
- Shared, server, UI, CLI, runner and E2E harness TypeScript checks passed.
- Production UI and Storybook builds passed. Token gates and `git diff --check`
  passed. No repository-wide test suite was run.

| Browser + real-agent case | Observed result | Evidence campaign |
|---|---|---|
| Native Jira, primary Codex | Passed: native card, no provider chooser; decline remained durable | `local-2026-09-23T16-26-56-470Z` |
| HubSpot, choose None, Codex Mini | Passed: ranked disclosure, restart/reload, saved decline, no connection or execution | `local-2026-09-23T16-14-57-848Z` |
| HubSpot, choose Arcade, primary Codex | Passed: restart/reload, second provider selected, existing connection reused, exactly one gateway call, independently generated contact verification code delivered | `local-2026-09-23T16-25-21-770Z` |
| HubSpot, choose Arcade, Codex Mini | Passed after clarifying search-before-installed-tool guidance; same saved-choice, restart, reuse, call-count and delivered-marker assertions | `local-2026-09-23T16-31-03-488Z` |

Inspectable evidence lives under `tests/runner-e2e/results/<campaign>/`, including
`result.json`, `evidence-manifest.json`, screenshots, traces, run ledger, saved
interactions and captured fixture calls. Attempts were run from the working tree;
the recorded base revision and harness digest must accompany the evidence. They
must not be described as testing a later immutable commit.

## Defects found and corrected

1. An agent searched for “HubSpot recent contacts”; exact-only service lookup missed
   the route. Matching now accepts one unambiguous whole service phrase, with tests
   for aliases, partial names and multiple services.
2. An agent dropped optional question help text. Required external-service and
   app-authorization disclosure now lives in the question prompt itself. Search
   instructions include the exact native question payload shape.
3. The E2E harness used the retired task-thread selector. New cases accept the
   current thread root. Another race read comments before the final response was
   materialized; the success case now waits for the actual response marker before
   grading. The independent call-count and saved-choice assertions were retained.
4. Mini treated an installed service tool as satisfying a new connect request and
   bypassed search. The provider-neutral execution guidance now explicitly requires
   search before any service tool for such requests, even when already installed.
   The previously failing Mini case then passed without weakening its assertions.

## UX readiness

The review stories use the production question form and provider setup. Manual
browser walkthroughs covered provider choice, Arcade's Access → Connect flow,
URL/configuration fields, disabled Connect before valid input, None, and existing
account copy. Desktop and narrow layouts were inspected. No setup permissions or
test wizard was introduced; those remain on the regular Permissions screen.

Review: `http://localhost:6138/?path=/story/apps-connections-provider-choice--choose-provider`.
Additional stories: `only-one-provider`, `narrow-choice`, `decline`,
`second-provider`, and `existing-account` under the same group.

## Acceptance limits

- The reviewed support index is finite and dated, not live catalog coverage of
  every app. Actual account/gateway capability and app authorization must be checked
  after choice; unknown support stays unverified.
- Existing broad tool permissions remain effective. Provider selection validates
  newly requested fallback routes; it is not a new invocation permission gate for
  tools already installed. Mini twice used an installed HubSpot action without
  searching or asking first (`local-2026-09-23T16-18-03-049Z` and
  `local-2026-09-23T16-28-16-092Z`). Those eval failures are retained. Guidance was
  clarified to require search even when a service tool is already installed; the
  subsequent targeted run passed. One passing rerun does not establish a statistical
  reliability rate or change the underlying permission boundary.
- Explicit provider queries now preserve app-specific context through the direct
  request and existing-account screens, with focused regressions. These additions
  were made during PR review, after the browser campaigns listed above.
- Live production-provider walkthroughs and broader model/profile reliability
  remain acceptance work. Fixture success must not be substituted for that proof.

## PR review follow-up — 2026-09-24

Rebased on master `b0155a681`. Review identified and corrected stable display names
for indexed-only apps, explicit provider selection, app disclosure on account reuse,
fixture closure when evidence export fails, and per-app/per-provider verification
dates. CI also exposed two old tests that needed the expanded input schema and an
enabled aggregator experiment. Those expectations were updated without weakening
production validation. The unrelated workspace preview startup failed readiness
on its first CI run; the subsequent head reruns that check without changing it.
