# Unified Google Workspace connector

## Finish line

One connection, OAuth consent, credential grant and action profile for the nine
existing Google services. Google controls granular consent; only actually granted
actions are discoverable and executable. No new scopes, Gmail sends, Chat
membership or unread-state access. Existing product connections remain compatible.

## Scope and rollout

- App branch merged with `origin/master` at `6dc32b57f`.
- App delivery branch: `codex/unified-google-workspace`.
- Companion Cloud broker branch: `codex/google-workspace-connector`.
- Reuse normal setup, vault, policies, refresh and audit paths.
- Keep the temporary Connections-page hold. No production deployment, Console
  changes, reviewer-stack upgrade or unpinning as part of this implementation.
- Sign-in tokens are never reused as resource tokens; id.paperclip.ing never
  stores resource tokens; no connections hub on the ID service.

## Acceptance

- Full and partial consent, exact requested scope union, one saved connection.
- Namespaced tools route to fixed service endpoints; unknown tools fail closed.
- Declined/revoked scopes block cached agent and board calls.
- Reconnect preserves narrower local action policies and credential ownership.
- Existing scopes, individual profiles and the Sheets robot method survive.
- Deterministic checks plus local browser setup inspection. Real Google OAuth
  remains a separate release gate until an enrolled test client is available.

## Current state

Implementation complete in the app and broker. Focused app setup, vault, gateway,
all-service routing and consent tests pass. Broker integration tests (32), its
full suite (2,871 passed; 77 skipped), app build, workspace typecheck, brand asset
validation and token gates pass.
The production setup components were checked in a background browser using
simulated Storybook data: one profile, personal access and OAuth method switching.
Full regression checks and PR review are in progress. No live Google proof yet.
