---
type: Verification Evidence
title: Phase 4 skillless Codex driver verification
description: Package-only evidence for the direct Codex app-server driver, skillless context boundary, semantic completion, recovery, and replay.
tags: [native-runner, phase-4, codex, app-server, skillless, evidence]
status: stable
generated: { by: openai/gpt-5, at: 2026-08-08T00:00:00Z }
---

# Scope

This evidence covers the direct Codex app-server driver and package-local mock
core. It does not import or change Paperclip server, UI, database, CLI, or
production control-plane behavior.

# Required checks

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/drivers/codex/codex-app-server-driver.test.ts
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
pnpm --filter @paperclipai/paperclip-runner record:phase4
pnpm --filter @paperclipai/paperclip-runner verify
```

# Acceptance mapping

- Common driver conformance covers create, resume, read, turn, steer,
  interrupt, usage, reconciliation, stable identities, and exactly one result.
- The exact real-session context records the Codex/app-server version, model,
  provider, working directory, sandbox, approval policy, base instructions,
  instruction sources and policy, environment key names, tools, input kinds,
  and complete compact envelope.
- Automatic skill, app, and collaboration instructions are disabled. The
  instruction-source list is empty, and the model receives no Paperclip API
  instruction, bearer credential, unrelated skill, or inherited secret.
- Semantic finish and block tools normalize to one validated canonical result.
  An identical duplicate is idempotent; a changed duplicate is rejected.
- Steering and interruption retain the same driver and provider session.
- Resume and reconciliation retain the persisted run, normalized session,
  driver session, provider session, turn, item, and source cursor identities.
- Unsupported capabilities emit explicit redacted diagnostics without
  driver-specific mock-core branches.
- All live events pass the existing Phase 1 validator/reducer. Replaying them
  produces the same snapshot.
- The package boundary rejects imports from Paperclip core packages.
- The authenticated isolation proof targets each readable host
  `auth.json`/`config.toml` file plus an unrelated secret, not the whole
  Codex-home directory. The trace records Codex's injected memories root while
  proving the credential files remain unreadable and unwritable.
- The recorder requires an accepted `done` result before reading outputs and
  turns an absent `hello.txt` or `isolation-ok.txt` into a named diagnostic.

# Recorded outputs

- [Validated real Codex trace](phase-04-codex-trace.json)
- [Driver reference](../../docs/phase-04-skillless-codex-driver.md)
- [Hands-on tutorial](../../docs/tutorials/phase-04-skillless-codex.md)

The trace normalizes its temporary working directory, both readable Codex
credential/config paths, and writable Codex state root. It contains no
credential values. This phase changes no browser surface, so a browser
screenshot is not applicable.

# Local verification result

- Codex CLI/app-server: `0.132.0`.
- Real model/provider: `gpt-5.5` / `openai`.
- Focused recorder regressions: 3 passed, covering a warmed memories directory,
  non-`done` output gating, and missing-file diagnostics.
- Focused driver tests: 7 passed.
- Full TypeScript suite: 73 passed.
- Full Rust suite: 39 passed (37 unit and 2 process-supervisor tests).
- Existing browser suite: 9 passed with the rootless Linux library path.
- The real safe task created `hello.txt` with exactly `hello from phase 4`.
- The refreshed warmed-environment trace contains 374 canonical events and all
  nine assertions pass: exactly one terminal result, accepted proposal,
  live/replay parity, stable run/session identity, contiguous source sequence,
  stable item identity, skillless context, unrelated-skill absence, and
  credential absence. The recorder separately verifies the exact safe-file
  content.
- Real steering and interruption commands preserved the session identity and
  ended with exactly one result and terminal event.
- TypeScript, Rust, and browser builds and typechecks passed. Golden, parity,
  token, package-boundary, documentation-link, and OKF checks passed.
- The complete package `verify` path passed through `verify:rootless`.

# Failures found and fixed

- The first real session returned an app-server `400` because the strict JSON
  Schema used `const` without its required `type`. The finish and block schemas
  now use `type: "string"` with `const`, and tests lock the provider shape.
- The first sandboxed launch could not write Codex's local SQLite state. The
  real-session proof uses the normal signed-in Codex environment; deterministic
  conformance remains fully package-local and does not need that state.
- The installed Codex home contained an unrelated invalid skill. The driver
  explicitly disables automatic skill instructions and verifies the returned
  instruction-source list is empty instead of relying on the host setup.
- The normal package verifier reached Playwright but the host lacked
  `libatk-1.0.so.0`. The supported rootless verifier supplied private browser
  libraries, then completed the same `verify` path with all nine browser tests.
- The original recorder required the whole `~/.codex` directory to be
  unreadable. Codex 0.132.0 injects `~/.codex/memories` as a legacy writable
  root after warm-up, making that directory check unsatisfiable while leaving
  `auth.json` and `config.toml` protected. The proof now checks credential files
  directly and the refreshed trace records the injected root.
- A valid `blocked` result previously fell through to unconditional output
  reads and surfaced an unhandled `ENOENT`. The recorder now validates the
  decision/disposition first and guards each expected output with a clear
  filename-specific diagnostic.

# Review state

- Security context/credential review: pending.
- CTO semantic-completion contract review: pending.
- QA hands-on tutorial run: pending.
- Human checkpoint: pending.
