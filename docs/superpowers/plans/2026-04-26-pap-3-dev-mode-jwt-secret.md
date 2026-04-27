# PAP-3: Auto-provision PAPERCLIP_AGENT_JWT_SECRET in `pnpm dev`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `pnpm dev` boots without `PAPERCLIP_AGENT_JWT_SECRET` (or `BETTER_AUTH_SECRET`) set in the environment, auto-generate an ephemeral random secret and set it on `process.env` so local-adapter agents can authenticate to the API. Update the boot banner to reflect the ephemeral status.

**Architecture:** A small pure helper (`ensureDevAgentJwtSecret`) reads the two env-var names that `agent-auth-jwt.ts` accepts. If either is set, it's a no-op. If neither is set, it generates a 32-byte base64-url secret, writes it to `process.env.PAPERCLIP_AGENT_JWT_SECRET`, and returns a status object. The dev-runner script calls this helper at startup BEFORE forking the server child, so the spawned server inherits the secret. The boot banner shows one of three states: `set (env)`, `set (.env file)` — out of scope for main clones (see PAP-5), or `ephemeral (generated this session)`.

**Tech Stack:** Node `crypto.randomBytes` for entropy, no new dependencies. Uses Vitest for tests, `tsx`-based dev-runner for the boot wiring.

**Scope clarification:**

After investigation, the three root causes listed in PAP-3 collapse to one:

1. ❌ "Auto-injection requires a stored agent key as a base — there's none after UI onboarding" — wrong; `/api/agents/{id}/keys` is for OAuth client keys, unrelated to local-adapter run JWTs.
2. ❌ "Auto-injection path has a bug" — wrong; `claude-local/src/server/execute.ts:244-245` injects `PAPERCLIP_API_KEY=authToken` correctly when `authToken` is non-null.
3. ✅ **Real cause**: `createLocalAgentJwt()` in `server/src/agent-auth-jwt.ts:68-70` returns `null` when `jwtConfig()` finds neither `PAPERCLIP_AGENT_JWT_SECRET` nor `BETTER_AUTH_SECRET` set in env. `pnpm dev` doesn't set either; the CLI's `paperclipai onboard` command does.

The fix is at the dev-runner boot, NOT in onboarding (UI or otherwise) and NOT in the JWT mechanism itself.

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `server/src/dev-jwt-bootstrap.ts` | Pure helper: `ensureDevAgentJwtSecret(env, options)` — generates + sets secret if missing, returns status |
| Create | `server/src/dev-jwt-bootstrap.test.ts` | Unit tests for the helper |
| Modify | `scripts/dev-runner.ts` | Call `ensureDevAgentJwtSecret(process.env)` at boot, before forking the server child |
| Modify | `server/src/startup-banner.ts` | Update the "Agent JWT" line to reflect ephemeral status (if banner code is small; otherwise leave for follow-up) |

The helper lives in `server/src/` (not `scripts/`) because the same logic might be useful from `server/src/index.ts` directly, and `server/src/` is where exportable utilities live in this repo. `scripts/dev-runner.ts` imports from `../server/src/` already (e.g., `bootstrapDevRunnerWorktreeEnv`).

---

## Background — required reading

- `server/src/agent-auth-jwt.ts:28-38` — `jwtConfig()` returns `null` when both env vars are empty. This is the gate.
- `server/src/agent-auth-jwt.ts:68-93` — `createLocalAgentJwt()` short-circuits to `null` when `jwtConfig()` returns null.
- `server/src/services/heartbeat.ts:5302-5316` — heartbeat calls `createLocalAgentJwt`; logs `"local agent jwt secret missing or invalid"` warning when null. (Verified this warning in dev server log during PAP-1.)
- `packages/adapters/claude-local/src/server/execute.ts:144-146,244-245` — confirms PAPERCLIP_API_KEY is injected from authToken when non-null.
- `cli/src/index.ts` (and compiled `cli/dist/index.js:8835`) — the CLI generates and persists the secret during `onboard`. This plan does NOT modify CLI behavior; only the dev-runner path.

---

## Task 1: Create the bootstrap helper with failing tests (TDD red)

**Files:**
- Create: `server/src/dev-jwt-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/dev-jwt-bootstrap.test.ts
import { describe, it, expect } from "vitest";
import { ensureDevAgentJwtSecret } from "./dev-jwt-bootstrap.js";

describe("ensureDevAgentJwtSecret", () => {
  it("is a no-op when PAPERCLIP_AGENT_JWT_SECRET is already set", () => {
    const env: Record<string, string | undefined> = {
      PAPERCLIP_AGENT_JWT_SECRET: "preexisting-secret",
    };
    const result = ensureDevAgentJwtSecret(env);
    expect(result.action).toBe("noop");
    expect(result.source).toBe("PAPERCLIP_AGENT_JWT_SECRET");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBe("preexisting-secret");
  });

  it("is a no-op when BETTER_AUTH_SECRET is already set", () => {
    const env: Record<string, string | undefined> = {
      BETTER_AUTH_SECRET: "preexisting-better-auth-secret",
    };
    const result = ensureDevAgentJwtSecret(env);
    expect(result.action).toBe("noop");
    expect(result.source).toBe("BETTER_AUTH_SECRET");
    expect(env.BETTER_AUTH_SECRET).toBe("preexisting-better-auth-secret");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
  });

  it("generates and sets PAPERCLIP_AGENT_JWT_SECRET when both are unset", () => {
    const env: Record<string, string | undefined> = {};
    const result = ensureDevAgentJwtSecret(env);
    expect(result.action).toBe("generated");
    expect(result.source).toBe("PAPERCLIP_AGENT_JWT_SECRET");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.secret).toBe(env.PAPERCLIP_AGENT_JWT_SECRET);
  });

  it("treats whitespace-only existing values as unset", () => {
    const env: Record<string, string | undefined> = {
      PAPERCLIP_AGENT_JWT_SECRET: "   ",
      BETTER_AUTH_SECRET: "",
    };
    const result = ensureDevAgentJwtSecret(env);
    expect(result.action).toBe("generated");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("generates different secrets across calls", () => {
    const env1: Record<string, string | undefined> = {};
    const env2: Record<string, string | undefined> = {};
    const r1 = ensureDevAgentJwtSecret(env1);
    const r2 = ensureDevAgentJwtSecret(env2);
    expect(r1.secret).not.toBe(r2.secret);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from repo root:

```bash
pnpm --filter @paperclipai/server exec vitest run src/dev-jwt-bootstrap.test.ts
```

Expected: FAIL with `Cannot find module './dev-jwt-bootstrap.js'`.

If the package's vitest config requires a different invocation (e.g. `tsx`-based test runner), match how other server tests run — check `server/package.json` scripts. Other server tests run via `vitest run` after a workspace-link preflight; if needed, run the full suite scoped to this file with `pnpm --filter @paperclipai/server test -- src/dev-jwt-bootstrap.test.ts`.

---

## Task 2: Implement the helper (TDD green)

**Files:**
- Create: `server/src/dev-jwt-bootstrap.ts`

- [ ] **Step 1: Write the helper**

```typescript
// server/src/dev-jwt-bootstrap.ts
import { randomBytes } from "node:crypto";

export type DevAgentJwtSecretSource =
  | "PAPERCLIP_AGENT_JWT_SECRET"
  | "BETTER_AUTH_SECRET";

export type EnsureDevAgentJwtSecretResult =
  | { action: "noop"; source: DevAgentJwtSecretSource; secret: string }
  | { action: "generated"; source: "PAPERCLIP_AGENT_JWT_SECRET"; secret: string };

/**
 * Ensure the local agent JWT signing secret is set in `env`.
 *
 * Reads the two env-var names that `server/src/agent-auth-jwt.ts:jwtConfig()`
 * accepts. If either is set with a non-whitespace value, returns "noop". If
 * both are empty/missing, generates a 32-byte cryptographically-random secret,
 * writes it to `env.PAPERCLIP_AGENT_JWT_SECRET`, and returns "generated".
 *
 * Intended for `pnpm dev` boot — gives contributors a working out-of-the-box
 * setup without requiring `paperclipai onboard` first. Production deployments
 * should always set the secret explicitly via the CLI's onboard flow.
 */
export function ensureDevAgentJwtSecret(
  env: Record<string, string | undefined>,
): EnsureDevAgentJwtSecretResult {
  const existingPaperclip = env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (existingPaperclip && existingPaperclip.length > 0) {
    return {
      action: "noop",
      source: "PAPERCLIP_AGENT_JWT_SECRET",
      secret: existingPaperclip,
    };
  }
  const existingBetterAuth = env.BETTER_AUTH_SECRET?.trim();
  if (existingBetterAuth && existingBetterAuth.length > 0) {
    return {
      action: "noop",
      source: "BETTER_AUTH_SECRET",
      secret: existingBetterAuth,
    };
  }
  const generated = randomBytes(32).toString("base64url");
  env.PAPERCLIP_AGENT_JWT_SECRET = generated;
  return {
    action: "generated",
    source: "PAPERCLIP_AGENT_JWT_SECRET",
    secret: generated,
  };
}
```

- [ ] **Step 2: Run test to verify it passes**

```bash
pnpm --filter @paperclipai/server exec vitest run src/dev-jwt-bootstrap.test.ts
```

Expected: PASS — all 5 tests green.

- [ ] **Step 3: Run typecheck on the package**

```bash
pnpm --filter @paperclipai/server typecheck
```

Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add server/src/dev-jwt-bootstrap.ts server/src/dev-jwt-bootstrap.test.ts
git commit -m "feat(PAP-3): add ensureDevAgentJwtSecret helper

Pure helper used by pnpm dev to auto-provision an ephemeral
PAPERCLIP_AGENT_JWT_SECRET when neither it nor BETTER_AUTH_SECRET
is set. Returns a status object so callers can report which path
was taken in their boot banner.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Wire the helper into `pnpm dev` boot

**Files:**
- Modify: `scripts/dev-runner.ts`

- [ ] **Step 1: Add import for the helper**

Find the existing import block at the top of `scripts/dev-runner.ts` (verify by reading the first ~30 lines). It already imports from `../server/src/dev-runner-worktree.ts`. Add a sibling import:

```typescript
// Add near the existing dev-runner-worktree import (around line 11-12):
import { ensureDevAgentJwtSecret } from "../server/src/dev-jwt-bootstrap.ts";
```

Match the existing extension convention (the file uses `.ts` extensions in import paths for tsx — check the existing line to be sure).

- [ ] **Step 2: Call the helper after the worktree-env bootstrap, before the server child spawns**

Find the existing `bootstrapDevRunnerWorktreeEnv(repoRoot, process.env)` call (around line 24). Add a call to `ensureDevAgentJwtSecret(process.env)` IMMEDIATELY AFTER it. The order matters: worktree env-file is loaded first (so a configured value in `.paperclip/.env` wins), then the auto-provision fills any remaining gap.

```typescript
// existing:
const worktreeEnvBootstrap = bootstrapDevRunnerWorktreeEnv(repoRoot, process.env);

// add:
const devJwtBootstrap = ensureDevAgentJwtSecret(process.env);
```

- [ ] **Step 3: Log the action so the contributor knows what happened**

Right after the helper call, add a one-line log:

```typescript
if (devJwtBootstrap.action === "generated") {
  console.log(
    "[paperclip] Generated ephemeral PAPERCLIP_AGENT_JWT_SECRET for this dev session " +
      "(not persisted; regenerated on next boot — set the env var or run `paperclipai onboard` for a stable secret).",
  );
}
```

Keep the format consistent with other `[paperclip]` log lines in dev-runner (search for `console.log(\"[paperclip]` to confirm).

- [ ] **Step 4: Manual verification — start the dev server**

If a dev server is already running on `:4500` from earlier work, kill it cleanly first:

```bash
pnpm dev:stop
```

Wait for the listener to clear (`lsof -i:4500 -P -n` returns empty), then start fresh:

```bash
PORT=4500 pnpm dev
```

Watch the boot output. You should see:

```
[paperclip] Generated ephemeral PAPERCLIP_AGENT_JWT_SECRET for this dev session (not persisted; ...)
```

…before the server's own boot banner prints.

- [ ] **Step 5: Confirm the secret is set in the spawned server's env**

Find the dev server's PID and inspect its env (macOS: `ps eww`). The expected output should include `PAPERCLIP_AGENT_JWT_SECRET=<value>` (don't print the value to a shared terminal — just confirm it's present).

```bash
DEV_PID=$(lsof -ti:4500 | head -1)
ps eww $DEV_PID | tr ' ' '\n' | grep -c '^PAPERCLIP_AGENT_JWT_SECRET='
```

Expected: `1`.

- [ ] **Step 6: Confirm a heartbeat now succeeds at the auth layer**

Reuse the test issue + COO from PAP-1 if the data is still there, or create a fresh test issue. Trigger a heartbeat (briefly flip `wakeOnDemand: true`):

```bash
AID="<COO-agent-id>"
curl -X PATCH "http://127.0.0.1:4500/api/agents/$AID" -H "Content-Type: application/json" \
  -d '{"runtimeConfig":{"heartbeat":{"enabled":false,"cooldownSec":300,"intervalSec":300,"wakeOnDemand":true,"maxConcurrentRuns":5}}}'
curl -X POST "http://127.0.0.1:4500/api/agents/$AID/heartbeat/invoke" -H "Content-Type: application/json"
```

Then watch the run log (`~/.paperclip/instances/default/data/run-logs/<companyId>/<agentId>/<runId>.ndjson`). Expected: NO "local agent jwt secret missing or invalid" warning, AND the agent's bash `curl ... /api/agents/me/inbox-lite` calls return inbox data instead of `{"error":"Agent authentication required"}`.

If the inbox calls still fail, the secret is set but the API auth is rejecting the JWT for some other reason (e.g., audience mismatch, expiry). Investigate by running `curl` against `/api/agents/me` with the JWT manually as `Authorization: Bearer ...`. The `verifyLocalAgentJwt` function in `agent-auth-jwt.ts:95-141` enumerates the rejection conditions.

After test passes, lock the heartbeat back down:

```bash
curl -X PATCH "http://127.0.0.1:4500/api/agents/$AID" -H "Content-Type: application/json" \
  -d '{"runtimeConfig":{"heartbeat":{"enabled":false,"cooldownSec":300,"intervalSec":300,"wakeOnDemand":false,"maxConcurrentRuns":5}}}'
```

- [ ] **Step 7: Commit the wiring**

```bash
git add scripts/dev-runner.ts
git commit -m "feat(PAP-3): auto-provision agent JWT secret in pnpm dev

Calls ensureDevAgentJwtSecret(process.env) after worktree env load
so contributors running pnpm dev get a working out-of-the-box
heartbeat-auth path. Logs a single line when generated so the
ephemeral status is visible without grep.

Closes paperclipai/paperclip#4543

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Update boot banner (only if low-friction)

**Files:**
- Modify: `server/src/startup-banner.ts` (only if the change is mechanical — see condition below)

The boot banner currently prints `Agent JWT: missing (run \`pnpm paperclipai onboard\`)` even though, after Task 3, an ephemeral secret IS set. The banner check needs to recognize the ephemeral case and label it accordingly.

- [ ] **Step 1: Read the banner code to find the JWT line**

```bash
grep -nE "Agent JWT|PAPERCLIP_AGENT_JWT_SECRET|BETTER_AUTH_SECRET" server/src/startup-banner.ts
```

If the JWT-status logic is contained to a small block (≤ 30 lines) and only checks env presence, modify it to surface "ephemeral (this session)" when the secret is present in env but `.paperclip/.env` (worktree) doesn't contain it.

If the logic is spread across many call sites or coupled to other config-presence checks, **DEFER this task** — file a follow-up ticket and stop here. The fix is correct without the banner update; it just leaves a slightly misleading status line.

- [ ] **Step 2 (conditional): apply the banner update**

Only if Step 1 found the change is small. The exact code depends on the banner's current structure, which I can't predict without reading it. The logic should be:

```
if (PAPERCLIP_AGENT_JWT_SECRET set in env AND not in worktree env file) {
  show "Agent JWT: ephemeral (this session)"
} else if (set in env from worktree file) {
  show "Agent JWT: set (from .paperclip/.env)"
} else if (BETTER_AUTH_SECRET set) {
  show "Agent JWT: set (BETTER_AUTH_SECRET)"
} else {
  // unreachable after Task 3, but keep the existing "missing" branch as a safety
  show "Agent JWT: missing (run `pnpm paperclipai onboard`)"
}
```

- [ ] **Step 3 (conditional): commit**

```bash
git add server/src/startup-banner.ts
git commit -m "feat(PAP-3): surface ephemeral JWT secret status in boot banner

Co-Authored-By: Claude <noreply@anthropic.com>"
```

If you deferred this task, file a follow-up GitHub issue describing the work and skip directly to the self-review section below.

---

## Self-Review Checklist

1. **Spec coverage:** the ticket asks for a fix to "first-run heartbeat fails: Agent authentication required." After this plan lands:
   - `pnpm dev` boot auto-provisions the missing secret ✅
   - First heartbeat after auto-provision succeeds at auth ✅ (Task 3 Step 6 verifies)
   - "no agent keys" framing in the ticket title is acknowledged as a misdirection in the plan's scope-clarification section, not by adding key-creation logic ✅

2. **Placeholder scan:** all task steps include either runnable code or specific commands. Task 4 has a conditional "skip if too complex" path with explicit criteria, which is acceptable per the plan's explicit gate.

3. **Type consistency:** `EnsureDevAgentJwtSecretResult` is a discriminated union; both `noop` and `generated` variants have a `secret` field for callers that want it. `source` field is constrained to the two env-var names. Helper signature matches between test and impl.

---

## Out of scope

- **CLI `paperclipai onboard` flow** is unchanged — it already generates and persists the secret correctly. The fix is only for the contributor `pnpm dev` path.
- **`.paperclip/.env` persistence in main clones** — orthogonal issue tracked by PAP-5 (`pnpm dev` ignores .env in main clones). Once that's fixed, contributors who want a stable secret can put it in `.paperclip/.env` and Task 3's auto-generate becomes a fallback.
- **UI onboarding** — the ticket title implied UI onboarding should provision keys; investigation showed run-JWTs are server-wide, not per-company, so UI onboarding is the wrong layer.
- **Production deployments** — these always set `BETTER_AUTH_SECRET` or `PAPERCLIP_AGENT_JWT_SECRET` explicitly per the CLI flow. Auto-generation is dev-only.

---

## Commit policy

Three commits expected:

1. `feat(PAP-3): add ensureDevAgentJwtSecret helper` — pure helper + 5 tests
2. `feat(PAP-3): auto-provision agent JWT secret in pnpm dev` — wiring + console log + closes #4543
3. `feat(PAP-3): surface ephemeral JWT secret status in boot banner` — only if Task 4 is low-friction; otherwise skipped

PR title: `feat: auto-provision agent JWT secret in pnpm dev (#4543)`
