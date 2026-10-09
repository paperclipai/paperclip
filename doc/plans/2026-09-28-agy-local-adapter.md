# AGY local adapter plan

Date: 2026-09-28
Status: Approved for implementation by the user
Owner: Product/review — Codex; implementation — local `agy` CLI

## Goal

Add a built-in `agy_local` adapter so Paperclip can run the locally installed
AGY CLI (Google Antigravity account-backed CLI) on the assigned workspace,
using its authenticated local account and canonical model IDs such as
`gemini-3.8-flash-high`.

The official Paperclip PR #7710 is a design reference, not a branch to merge:
its base is substantially behind this fork and its merge conflicts span shared
release files. Port the feature to the current adapter/runtime contracts.

## Product decisions

- Adapter key and package: `agy_local` / `@paperclipai/adapter-agy-local`.
- Default command: `agy`; allow an explicit command override.
- Authentication: use the AGY CLI's existing local login/session. Do not add
  Gemini Studio API-key fields, store credentials, or claim that an environment
  check proves model access.
- Model values sent to AGY must be canonical CLI IDs. Include the user's
  verified `gemini-3.8-flash-high` model and permit custom IDs so the adapter
  does not freeze its catalog to a possibly stale list.
- Preserve Paperclip workspace containment, runtime environment, cancellation,
  timeout, logging, skill selection, and session resume behavior.
- Treat AGY output and workspace content as untrusted. Never place credentials
  in prompts/logs. Do not silently fall back to another provider or engine.
- No schema or migration changes.

## Scope

1. Create the adapter package with shared metadata and configuration guidance;
   server execution, parsing, environment preflight and session codec; UI config
   construction and transcript parsing; CLI event formatting.
2. Register it as a built-in in the server, UI, and CLI registries and keep the
   adapter type/contracts, workspace dependency manifests, and release package
   manifest synchronized.
3. Add focused tests for config/model argument construction, structured output
   parsing, session persistence/resume and unknown-session recovery, environment
   checks, registry visibility, and CLI/UI formatting.
4. Document AGY installation and authentication prerequisites, including that
   environment preflight checks the executable/runtime only and a real run is
   needed to prove account/model access.

## Non-goals

- Do not merge or cherry-pick PR #7710 wholesale.
- Do not create an AGY API key or ask users to paste Google credentials.
- Do not add AGY as an ACP/native Paperclip Runner provider.
- Do not change existing Gemini CLI behavior or agent configuration.
- Do not run a surprise live model generation as part of the environment test.

## Acceptance criteria

- `agy_local` appears in server and UI adapter discovery and can be selected
  when creating/editing an agent; `paperclipai run --watch` formats its events.
- The configured canonical model reaches `agy` unchanged; the default model
  selection follows AGY's documented/default behavior.
- Runs receive the Paperclip wake prompt and assigned workspace, preserve and
  resume the AGY conversation across heartbeats, and recover cleanly when AGY
  reports an unknown/stale session.
- Cancellation and configured timeout/grace are enforced through Paperclip's
  execution-target helpers, including remote targets where supported.
- Environment tests are structured and side-effect free; they check AGY
  availability and clearly distinguish that from successful login/model access.
- Targeted adapter tests and typechecks pass. No generated migration, secret,
  API key, or unrelated file is introduced.

## Review checklist (PO/reviewer)

- Verify the exact AGY command flags and stream format against the installed
  local CLI; reject flags that are unsupported by that version.
- Verify every child process uses the execution-target abstraction and that
  stdout/stderr are redacted before logging.
- Verify session state is opaque, serialized safely, and cleared only for a
  confirmed AGY unknown-session response.
- Verify model identifiers are actual CLI IDs rather than display labels.
- Verify UI guidance does not imply environment preflight authenticates AGY.
- Inspect all registry/manifest changes and the final diff for accidental
  changes outside the adapter feature.
- Run the narrow package/server/UI/CLI checks that cover the change and report
  any unrun checks.

## Implementation sequence

1. Create an isolated feature branch and implement the package from current
   adapters/contracts, using the installed AGY CLI behavior as the source of
   truth.
2. Register and document the adapter across consumers.
3. Run focused tests/typechecks; fix issues found by the independent review.
4. Review the complete diff against this plan and report the resulting branch
   and verification. Do not commit or publish a PR unless asked.
