---
name: browser-go-no-go
description: Run a deterministic Paperclip Browser GO/NO-GO review for UI-visible work. Use when QA must launch the isolated browser context, exercise user journeys, capture screenshot/DOM evidence, classify each journey pass/fail/quarantined, and emit a machine-readable verdict record for Security or release handoff.
key: paperclipai/bundled/quality/browser-go-no-go
recommendedForRoles:
  - qa
  - engineer
  - security
tags:
  - qa
  - browser
  - go-no-go
  - evidence
  - verdict
---

# Browser GO/NO-GO

Use this skill when a Paperclip issue needs a browser-grounded release or handoff verdict. The result is a machine-readable JSON record backed by evidence a reviewer can inspect.

## Inputs

Before launching the browser, identify:

- QA issue identifier and the feature or bugfix under review.
- App base URL and environment name.
- User journeys to exercise, each with observable pass criteria.
- Required viewport(s). Default to `1440x1000` desktop unless the issue names mobile or responsive behavior.
- QA test credentials or an explicit note that the environment is local-trusted.

## Launch The Isolated Browser

Use the isolated QA browser context provided by the workspace. For Paperclip app checks, prefer:

```bash
node scripts/qa-browser-bridge.mjs --base-url <app-url> --port <free-local-port>
```

Then use the bridge endpoints from localhost only:

- `GET /health` to confirm the base URL, profile directory, screenshot directory, and current page.
- `POST /auth/sign-up-or-in` only with QA test credentials or local-trusted auth.
- `POST /navigate`, `POST /click`, `POST /type`, `POST /waitFor`, `POST /extract`, and `POST /screenshot` for the journey.

If the issue has an execution workspace with runtime controls, use that workspace's browser/runtime instructions instead of starting an unmanaged server.

## Drive Journeys

For each journey:

1. Navigate to the starting URL and wait for a deterministic signal.
2. Perform one user action at a time.
3. After each meaningful transition, wait for a selector, URL pattern, or load state that proves the UI reached the expected state.
4. Capture a screenshot and extract DOM/text evidence from the primary region under test.
5. Record console warnings/errors and non-2xx network responses when the available browser tooling exposes them.

Use deterministic waits only. Do not use sleeps, timeout padding, or "wait and see" loops. Retry a journey at most once when the failure plausibly comes from environment startup or navigation timing, and record the retry.

## Verdict Rules

Classify each journey independently:

- `pass`: all must-pass assertions are visible to a human and backed by evidence.
- `fail`: a user-visible assertion fails, the journey cannot be completed, or the UI shows an unexpected error. Every `fail` must include the screenshot and DOM/text evidence that justify the NO-GO.
- `quarantined`: evidence indicates a flaky or environment-limited journey that should not silently veto a real GO. Quarantine requires a `quarantine.reason`, `quarantine.owner`, and `quarantine.followUpIssueId` or equivalent tracked follow-up.

Set the overall verdict:

- `go`: all required journeys pass.
- `no-go`: any required journey fails.
- `advisory-go`: required journeys pass, but at least one non-required journey is quarantined.
- `advisory-no-go`: a required journey is quarantined and no owner explicitly waives it.

Never convert a real product failure into quarantine. Quarantine is only for documented test flake, environment instability, unavailable seed data, or an intentionally advisory journey.

## Verdict Record

Write a JSON record that conforms to `references/verdict-schema.json`. Use `references/verdict-example.json` as a complete shape example.

Required top-level fields:

- `schemaVersion`
- `qaIssueId`
- `featureIssueIds`
- `environment`
- `browserContext`
- `journeys`
- `overallVerdict`
- `approver`
- `generatedAt`

Evidence entries must point to durable issue attachments, work products, or workspace files. Local scratch paths are not enough unless the issue work product metadata exposes them as workspace files.

## Handoff

Post the outcome to the QA issue with:

- Overall verdict and whether it is binding or advisory.
- Journey table with `pass`, `fail`, or `quarantined`.
- Links to the JSON verdict record and evidence files.
- Any NO-GO reproduction steps.
- Any quarantine owner and follow-up issue.

For Security handoff, attach or link the JSON record directly. Security should not need to parse prose comments to determine GO/NO-GO status.

