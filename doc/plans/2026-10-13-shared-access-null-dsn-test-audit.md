# Shared access null DSN test consolidation

Date: 2026-10-13. Baseline commit: `9b4d0cd872ca1fc897f320cb181fc060f0bd5bf1`.

## Scope and keeper map

Only `packages/shared/src/validators/access.test.ts` changes for this consolidation. Retire `authSessionSchema > accepts a null sentryDsn` after moving its output assertion into `authSessionSchema > parses a session where user has a real name`.

Both cases used exactly the same input:

```ts
{
  session: { id: "s1", userId: "u1" },
  user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
  sentryDsn: null,
}
```

The keeper retains successful parsing and the exact real name, and now also asserts `result.success && result.data.sentryDsn` is `null`. Rejection or transformation of the null DSN remains detectable through the same schema call and input.

The missing-DSN rejection case and real-DSN acceptance/value case remain unchanged. Name/email normalization, malformed-email rejection and all four optional Sentry-environment rows remain unchanged. No production code changed; no runtime behavior changed.

## Exact reduction

- Retire **1 `it` declaration** and its **10-line block**, including the separating blank line.
- Add **1 assertion line** to the existing keeper: **1 added / 10 removed**, or **9 net test lines removed**.
- Access file: **185 lines before / 176 after**; **20 cases before / 19 after**. Its two `describe` declarations and its test-file isolation unit remain.
- These are case and source-line reductions. No CI time saving was measured or claimed.

## Reproducible verification

Commands ran from `/private/tmp/paperclip-test-audit-pr-stack`, using the root Vitest project configuration and the package-shared project. Both commands ran complete files without a test-name filter.

Baseline:

```sh
node_modules/.bin/vitest run --project @paperclipai/shared packages/shared/src/telemetry/client.test.ts packages/shared/src/telemetry/client-contract.test.ts packages/shared/src/validators/access.test.ts
```

Result: **3 files passed, 53 cases passed**, zero failed/skipped/todo; Vitest duration **214 ms** (start 08:15:17). Access contributed 20 cases.

Candidate, after the access and telemetry consolidations:

```sh
node_modules/.bin/vitest run --project @paperclipai/shared packages/shared/src/telemetry/client.test.ts packages/shared/src/validators/access.test.ts
```

Result: **2 files passed, 44 cases passed**, zero failed/skipped/todo; Vitest duration **214 ms** (start 08:15:50). Access contributes 19 surviving cases, and telemetry contributes 25.

Both runs emitted the existing Vite native-config warning about `__dirname`; neither run failed. `git diff --check` passes. No production mutation experiment was run. Repo-wide typecheck, tests, build and CI were not run for this focused consolidation; this receipt does not claim PR readiness.
