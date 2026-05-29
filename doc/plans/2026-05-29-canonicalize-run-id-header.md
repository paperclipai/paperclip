# Plan: Canonicalize `X-Valadrien-Os-Run-Id` Across All Callers

**Status:** Deferred (compat shim shipped in PR #1)
**Owner:** Platform / Adapter Authoring
**Created:** 2026-05-29

## Context

The rebrand codemod stamped three different spellings of the heartbeat run-id
header into the tree:

| Spelling                  | Lowercase (Node's normalized form) | Where it lives                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Valadrien-Os-Run-Id`   | `x-valadrien-os-run-id`            | **Canonical**. `server/src/middleware/auth.ts`, `packages/adapter-utils/src/execution-target.ts`, `cli/src/client/http.ts`, sandbox-callback-bridge tests, the plugin proxy header allowlist, and (as of `fix(rebrand): unblock failing CI lanes`) every prose doc, skill, eval prompt, onboarding-asset, and script. |
| `X-ValadrienOs-Run-Id`    | `x-valadrienos-run-id`             | Codemod artifact. Still present in `tests/e2e/signoff-policy.spec.ts`, `server/src/adapters/registry.ts` (docstring sent to LLMs), `packages/adapters/{gemini-local,grok-local,openclaw-gateway}/src/server/execute.ts` (docstrings), `packages/mcp-server/src/{client,tools.test}.ts`, `packages/plugins/sandbox-providers/cloudflare/src/{bridge-client,plugin.test}.ts`, `scripts/smoke/terminal-bench-loop-skill-smoke.mjs`, `server/src/__tests__/adapter-registry.test.ts`. |
| `X-ValAdrien OS-Run-Id`   | (invalid — contains a literal space) | **Already removed** in the same fix. This was an invalid HTTP header token. |

The auth middleware was reading **only** the canonical `x-valadrien-os-run-id`
spelling before PR #1, which silently broke every caller that sent the
`X-ValadrienOs-Run-Id` form. That manifested as `401 Agent run id required`
in the signoff e2e suite for five consecutive CI runs.

`fix(rebrand): unblock failing CI lanes` (commit `2b28b3e0`) shipped a
**compat shim**: `server/src/middleware/auth.ts` and the plugin proxy header
allowlist now accept both spellings. This plan tracks removing that shim by
aligning every caller on the canonical kebab-case spelling.

## Goal

One spelling everywhere — `X-Valadrien-Os-Run-Id` in source/literal form,
`x-valadrien-os-run-id` in any lookup. Delete the compat shim. Add a lint or
test that guards against the `X-ValadrienOs-Run-Id` form re-appearing.

## Scope

### 1. Source rewrites (TS / TSX)

Rewrite every literal `"X-ValadrienOs-Run-Id"` / `"x-valadrienos-run-id"` to
`"X-Valadrien-Os-Run-Id"` / `"x-valadrien-os-run-id"` in:

- `tests/e2e/signoff-policy.spec.ts` (4 occurrences)
- `server/src/adapters/registry.ts` (LLM-facing docstring — line 479)
- `packages/adapters/gemini-local/src/server/execute.ts` (LLM-facing docstring — line 95)
- `packages/adapters/grok-local/src/server/execute.ts` (LLM-facing docstring — line 79)
- `packages/adapters/openclaw-gateway/src/server/execute.ts` (LLM-facing docstring — line 415)
- `packages/mcp-server/src/client.ts` (line 92) + `packages/mcp-server/src/tools.test.ts` (line 50)
- `packages/plugins/sandbox-providers/cloudflare/src/bridge-client.ts` (line 57) + `packages/plugins/sandbox-providers/cloudflare/src/plugin.test.ts` (line 137)
- `scripts/smoke/terminal-bench-loop-skill-smoke.mjs` (line 113)
- `server/src/__tests__/adapter-registry.test.ts` (line 350)

### 2. Remove compat shim

Once all callers are aligned and CI stays green for at least one PR cycle:

```ts
// server/src/middleware/auth.ts
- const runIdHeader =
-   req.header("x-valadrien-os-run-id") ??
-   req.header("x-valadrienos-run-id");
+ const runIdHeader = req.header("x-valadrien-os-run-id");
```

```ts
// server/src/routes/plugins.ts (sanitizePluginRequestHeaders allowlist)
- "x-valadrien-os-run-id",
- "x-valadrienos-run-id",
+ "x-valadrien-os-run-id",
```

### 3. Guardrail

Add a lightweight grep test to `server/src/__tests__/` (or a check in the
existing `policy` lane) that fails if anything outside this plan doc
introduces the `X-ValadrienOs-Run-Id` / `x-valadrienos-run-id` spelling:

```ts
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";

describe("rebrand drift guards", () => {
  test("no caller uses the non-canonical X-ValadrienOs-Run-Id spelling", () => {
    const out = execSync(
      "rg -l 'X-ValadrienOs-Run-Id|x-valadrienos-run-id' " +
        "--glob '!doc/plans/**' --glob '!CHANGELOG.md' || true",
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("");
  });
});
```

## Non-Goals

- Renaming the actual env var (`VALADRIEN_OS_RUN_ID`) or the LLM-facing
  shell variable (`$VALADRIEN_OS_RUN_ID`) — those are already canonical.
- Changing the wire semantics. The compat shim only adds an alternate
  recognized spelling; it never changes how runs are matched, scoped, or
  audited.
- Touching `paperclip_*` legacy strings — those are handled in the existing
  `2b7eb069` / `744341e5` follow-up commits.

## Acceptance

- `rg "X-ValadrienOs-Run-Id|x-valadrienos-run-id"` returns only this plan
  doc and CHANGELOG references.
- All existing tests still pass with the compat shim removed.
- The guardrail test exists and runs in the `policy` lane.
- A short note in `Architecture.md` (or `docs/api/overview.md`) calls out
  the canonical spelling.

## Open Questions

- Should the canonical form lowercase the `Os` segment for symmetry with
  `Run-Id` (i.e. `X-Valadrien-OS-Run-Id`)? HTTP header tokens are
  case-insensitive, so the wire effect is identical. Sticking with
  `X-Valadrien-Os-Run-Id` to match the existing canonical usage and the
  product capitalization (`ValAdrien OS` is the display name; the header
  segment treats it as a single token).
