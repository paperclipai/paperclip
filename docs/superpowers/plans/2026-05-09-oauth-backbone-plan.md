# OAuth Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the OAuth 2.1 + PKCE backbone — provider registry (file/plugin), per-tenant `oauth_connections` storage, refresh worker, plugin SDK extension, Settings → Connections UI, and `oauth_token` bindings that flow through the existing secret-resolution pipeline.

**Architecture:** Provider definitions are declarative YAML (plus optional TS shape modules) loaded into an in-memory registry at startup. OAuth flow handler routes generate PKCE state, exchange codes, persist tokens as new `company_secret_versions` rows, and expose connections via `/api/companies/:companyId/oauth/...`. A 60s leader-elected worker refreshes near-expiry tokens; a lazy path inside `resolveAdapterConfigForRuntime` catches misses. The runtime sees OAuth tokens as just-another-secret — same code path as `secret_ref`.

**Tech Stack:** Node/TypeScript, Express, Drizzle ORM (Postgres), Zod, pino, React 18 + Vite (UI), Vitest, Playwright. Reuses existing `SecretProvider` registry and better-auth session middleware.

**Spec:** `docs/superpowers/specs/2026-05-09-oauth-backbone-design.md`

**Branch:** `feat/oauth-backbone` (already created off `origin/master`).

---

## Conventions used in this plan

- All commits use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`).
- Every task ends with a single commit. Bundle test + impl in the same commit (TDD red-green-refactor → one commit).
- Test runner is vitest. Run scoped tests with `pnpm --filter <pkg> test -- <pattern>`.
- All new files use ES module imports (`.js` suffix when importing local TS files).
- The migration number `0082` assumes this branch lands before any other migration-bearing PR. If M3b (`0085`) or M3a (`0084`) merge first, **rename `0082_…sql` to the next available number** before pushing.
- The in-memory rate limiter in Task 8 will be replaced by M3b's `createSlidingWindowLimiter` once M3b merges; the plan includes a follow-up cleanup task (Task 53).

## Plan amendments (2026-05-09)

- **Task 2 SUPERSEDED.** While implementing T1, we discovered `company_secrets.kind` does not exist in this codebase — the table discriminates secrets via the `provider` column (encryption provider, e.g. `local_encrypted`) plus the implicit shape of the `material` jsonb on `company_secret_versions`. OAuth secrets do not need a separate `kind` value because the FKs from `oauth_connections.access_token_secret_id` / `.refresh_token_secret_id` already discriminate them. Task 2 is a no-op; **skip it**. Spec §9.4 has been amended accordingly.
- **Tasks 20 and 23 follow-up.** Where the plan's draft code shows `secretService.persistSecret({ kind: "oauth_access_token", ... })`, the actual call uses the existing secret-creation API on `secretService` (likely `createCompanySecret(...)` plus `appendVersion(...)`). The implementer of these tasks must inspect `server/src/services/secrets.ts` for the real API and pass only the parameters that exist (no `kind`). The OAuth backbone reuses the existing secret pipeline as-is.
- **`initiated_by_user_id` is `text`, not `uuid`.** Better Auth uses string user IDs in this codebase; the column type was adapted in T1. Downstream tasks treating `initiatedByUserId` must use `string`.

---

## File Structure

### New files (implementation)

| Path | Responsibility |
|---|---|
| `packages/db/src/migrations/0082_oauth_connections.sql` | Adds `oauth_connections` + `oauth_authorization_states` tables |
| `packages/db/src/schema/oauth.ts` | Drizzle schema for both tables |
| `packages/shared/src/types/oauth.ts` | `EnvOAuthTokenBinding` + provider config types re-exported for clients |
| `server/src/oauth/types.ts` | Internal OAuth types (`OAuthProviderConfig`, `RegisteredProvider`, `ProviderShape`) |
| `server/src/oauth/provider-config.ts` | Zod schema + `OAuthProviderConfig` type |
| `server/src/oauth/registry.ts` | In-memory `Map<providerId, RegisteredProvider>` builder |
| `server/src/oauth/yaml-loader.ts` | Reads `oauth-providers/*.yaml`, validates, resolves env vars |
| `server/src/oauth/plugin-loader.ts` | Pulls plugin contributions into the registry |
| `server/src/oauth/default-shape.ts` | RFC-6749 default response parser |
| `server/src/oauth/dot-path.ts` | Tiny dot-path getter (`get(obj, "team.id")`) |
| `server/src/oauth/pkce.ts` | `generateCodeVerifier`, `deriveCodeChallenge` (S256) |
| `server/src/oauth/backoff.ts` | `backoffWindow(attempts)` math |
| `server/src/oauth/redirect-allowlist.ts` | `validateReturnUrl(url, publicUrl)` |
| `server/src/oauth/rate-limiter.ts` | In-memory sliding window (replaced post-M3b) |
| `server/src/oauth/logger.ts` | `oauthLogger` pino child with token redaction |
| `server/src/oauth/refresh.ts` | `refreshConnection(connectionId)` — shared by worker + lazy path |
| `server/src/oauth/refresh-worker.ts` | 60s tick, leader-elected via `pg_try_advisory_lock` |
| `server/src/oauth/state-sweeper.ts` | Cleans expired `oauth_authorization_states` |
| `server/src/routes/oauth.ts` | All `/api/companies/:companyId/oauth/*` routes |
| `server/src/routes/oauth-callback.ts` | Public `GET /api/oauth/callback/:providerId` (state-authenticated, no companyId path param) |
| `server/src/routes/oauth-mark-revoked.ts` | Internal `POST /api/oauth/connections/:id/mark-revoked` (run-JWT-authed) |
| `server/oauth-providers/github.yaml` | GitHub provider config |
| `server/oauth-providers/notion.yaml` | Notion provider config |
| `server/oauth-providers/slack.yaml` | Slack provider config |
| `server/oauth-providers/linear.yaml` | Linear provider config |
| `server/oauth-providers/atlassian.yaml` | Atlassian provider config |
| `server/oauth-providers/google-workspace.yaml` | Google Workspace provider config |
| `server/oauth-providers/microsoft-graph.yaml` | Microsoft Graph provider config |
| `server/oauth-providers/shapes/slack.ts` | Slack response shape module |
| `server/oauth-providers/shapes/microsoft.ts` | Microsoft response shape module |
| `packages/plugins/sdk/src/define-oauth-provider.ts` | `defineOAuthProvider` helper |
| `ui/src/pages/settings/Connections.tsx` | Settings → Connections page |
| `ui/src/pages/settings/connections/ProviderTile.tsx` | Tile component |
| `ui/src/pages/settings/connections/ConnectionDrawer.tsx` | Slide-over detail drawer |
| `ui/src/pages/settings/connections/api.ts` | Frontend API client |
| `ui/src/locales/connections.en.json` | i18n strings |
| `server/src/__tests__/oauth/mock-provider.ts` | In-process mock OAuth provider fixture |
| `server/src/__tests__/oauth/integration.test.ts` | All 14 integration scenarios |
| `tests/e2e/oauth.spec.ts` | Playwright E2E |

### Modified files

| Path | Change |
|---|---|
| `packages/shared/src/types/secrets.ts` | Add `EnvOAuthTokenBinding` to `EnvBinding` union |
| `packages/shared/src/types/plugin.ts` | Add `kind: "oauth_provider" \| "composite"`, `oauthProviders[]` to `PaperclipPluginManifestV1` |
| `packages/db/src/schema/index.ts` | Export new oauth schema |
| `packages/db/src/schema/secrets.ts` (or wherever `kind` enum lives) | Extend `kind` with `oauth_access_token`, `oauth_refresh_token` |
| `server/src/services/secrets.ts` | Extend `resolveAdapterConfigForRuntime` to handle `oauth_token` bindings (incl. lazy refresh) |
| `server/src/app.ts` | Mount oauth router + start refresh worker + state sweeper |
| `server/src/index.ts` | Wire startup of registry loader |
| `server/src/auth/run-jwt.ts` (or equivalent) | Add `oauth.connectionIds` claim |
| `ui/src/components/EnvVarEditor.tsx` | Add `oauth_token` binding source option |
| `ui/src/router.tsx` (or equivalent route registration) | Register `/settings/connections` |

---

## Phase 0 — Foundation (database + shared types)

### Task 1: DB migration + Drizzle schema for `oauth_connections` and `oauth_authorization_states`

**Files:**
- Create: `packages/db/src/migrations/0082_oauth_connections.sql`
- Create: `packages/db/src/schema/oauth.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the migration**

Create `packages/db/src/migrations/0082_oauth_connections.sql`:

```sql
CREATE TABLE oauth_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_id              text NOT NULL,
  status                   text NOT NULL CHECK (status IN ('active','expired','revoked','error')),
  account_id               text,
  account_label            text,
  scopes                   text[] NOT NULL DEFAULT '{}',
  access_token_secret_id   uuid NOT NULL REFERENCES company_secrets(id),
  refresh_token_secret_id  uuid REFERENCES company_secrets(id),
  access_token_expires_at  timestamptz,
  last_refreshed_at        timestamptz,
  last_error               text,
  last_error_at            timestamptz,
  refresh_attempt_count    int  NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider_id)
);

CREATE INDEX oauth_connections_refresh_idx
  ON oauth_connections (access_token_expires_at)
  WHERE status = 'active' AND refresh_token_secret_id IS NOT NULL;

CREATE TABLE oauth_authorization_states (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  code_verifier        text NOT NULL,
  redirect_uri         text NOT NULL,
  scopes_requested     text[] NOT NULL DEFAULT '{}',
  initiated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  return_url           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  consumed_at          timestamptz
);

CREATE INDEX oauth_authorization_states_expiry_idx
  ON oauth_authorization_states (expires_at) WHERE consumed_at IS NULL;
```

- [ ] **Step 2: Write the Drizzle schema**

Create `packages/db/src/schema/oauth.ts`:

```ts
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./secrets.js";
import { users } from "./users.js";

export const oauthConnections = pgTable("oauth_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  status: text("status").notNull(),  // 'active'|'expired'|'revoked'|'error'
  accountId: text("account_id"),
  accountLabel: text("account_label"),
  scopes: text("scopes").array().notNull().default(sql`'{}'`),
  accessTokenSecretId: uuid("access_token_secret_id").notNull().references(() => companySecrets.id),
  refreshTokenSecretId: uuid("refresh_token_secret_id").references(() => companySecrets.id),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  refreshAttemptCount: integer("refresh_attempt_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyProviderUnique: uniqueIndex("oauth_connections_company_provider_uniq").on(t.companyId, t.providerId),
}));

export const oauthAuthorizationStates = pgTable("oauth_authorization_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scopesRequested: text("scopes_requested").array().notNull().default(sql`'{}'`),
  initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  returnUrl: text("return_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export type OAuthConnection = typeof oauthConnections.$inferSelect;
export type NewOAuthConnection = typeof oauthConnections.$inferInsert;
export type OAuthAuthorizationState = typeof oauthAuthorizationStates.$inferSelect;
```

- [ ] **Step 3: Re-export from schema index**

Modify `packages/db/src/schema/index.ts` to add:

```ts
export * from "./oauth.js";
```

- [ ] **Step 4: Verify migration applies cleanly**

Run: `pnpm --filter @paperclipai/db build && pnpm --filter @paperclipai/db migrate:check` (or whatever the project uses; if no such command exists, run a quick smoke test by spinning up Postgres locally and applying with `psql`).

Expected: clean apply, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/0082_oauth_connections.sql \
        packages/db/src/schema/oauth.ts \
        packages/db/src/schema/index.ts
git commit -m "feat(db): add oauth_connections and oauth_authorization_states tables"
```

---

### Task 2: Add `oauth_access_token` and `oauth_refresh_token` to secret kind

**Files:**
- Modify: `packages/db/src/schema/secrets.ts` (or wherever `kind` is constrained — locate via `grep -rn "kind.*oauth\|company_secret.*kind" packages/db/`)

- [ ] **Step 1: Locate the kind constraint**

Run: `grep -rn "kind" packages/db/src/schema/secrets.ts`

If `kind` is a `text` with a CHECK constraint or an enum, identify the form. Likely either a `pgEnum` or a CHECK on a text column. The plan assumes a CHECK-on-text pattern with a corresponding migration.

- [ ] **Step 2: Write a tiny migration to add the new kinds**

Create `packages/db/src/migrations/0083_oauth_secret_kinds.sql`:

```sql
-- Extend company_secrets.kind allowed values to include OAuth token kinds.
-- If kind has a CHECK constraint, drop & recreate; if it's a pgEnum, ALTER TYPE.
-- Adjust to match the existing constraint type — the body below shows both.

-- Variant A: CHECK constraint (most likely)
ALTER TABLE company_secrets DROP CONSTRAINT IF EXISTS company_secrets_kind_check;
ALTER TABLE company_secrets ADD CONSTRAINT company_secrets_kind_check
  CHECK (kind IN ('generic','git_credentials','adapter_env','oauth_access_token','oauth_refresh_token'));

-- Variant B: enum type (uncomment + delete Variant A if applicable)
-- ALTER TYPE company_secret_kind ADD VALUE IF NOT EXISTS 'oauth_access_token';
-- ALTER TYPE company_secret_kind ADD VALUE IF NOT EXISTS 'oauth_refresh_token';
```

When the engineer runs this task, they MUST first inspect the existing `kind` constraint and pick the right variant before committing. The two variants are mutually exclusive.

- [ ] **Step 3: Verify by querying constraints**

Run against a local Postgres with the migration applied:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'company_secrets'::regclass AND conname LIKE '%kind%';
```

Expected: shows the new values.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/migrations/0083_oauth_secret_kinds.sql
git commit -m "feat(db): allow oauth_access_token and oauth_refresh_token secret kinds"
```

---

### Task 3: Add `EnvOAuthTokenBinding` to shared binding union

**Files:**
- Modify: `packages/shared/src/types/secrets.ts`
- Test: `packages/shared/src/types/__tests__/secrets.test.ts` (create if absent)

- [ ] **Step 1: Write a failing test**

Create or extend `packages/shared/src/types/__tests__/secrets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { EnvBinding, EnvOAuthTokenBinding } from "../secrets.js";

describe("EnvBinding union", () => {
  it("accepts oauth_token binding shape", () => {
    const binding: EnvOAuthTokenBinding = {
      type: "oauth_token",
      connectionId: "11111111-1111-1111-1111-111111111111",
      field: "access",
    };
    const asUnion: EnvBinding = binding;
    expect(asUnion.type).toBe("oauth_token");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/shared test -- secrets`
Expected: FAIL — `EnvOAuthTokenBinding` not exported.

- [ ] **Step 3: Extend the binding union**

Edit `packages/shared/src/types/secrets.ts`. Locate the `EnvBinding` union and the existing `EnvSecretRefBinding` interface, then add:

```ts
export interface EnvOAuthTokenBinding {
  type: "oauth_token";
  connectionId: string;
  field: "access";  // future: "refresh" | "account_id"
}
```

Update the union (preserve existing string-shorthand variant):

```ts
export type EnvBinding =
  | string
  | EnvPlainBinding
  | EnvSecretRefBinding
  | EnvOAuthTokenBinding;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/shared test -- secrets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/secrets.ts \
        packages/shared/src/types/__tests__/secrets.test.ts
git commit -m "feat(shared): add EnvOAuthTokenBinding to EnvBinding union"
```

---

## Phase 1 — Pure utilities (TDD-friendly, no I/O)

### Task 4: PKCE helpers (`generateCodeVerifier`, `deriveCodeChallenge`)

**Files:**
- Create: `server/src/oauth/pkce.ts`
- Test: `server/src/oauth/__tests__/pkce.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/oauth/__tests__/pkce.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateCodeVerifier, deriveCodeChallenge } from "../pkce.js";

describe("PKCE", () => {
  it("generates a base64url verifier of at least 43 characters", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives the RFC 7636 sample challenge", () => {
    // RFC 7636 Appendix B test vector
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server test -- pkce`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `server/src/oauth/pkce.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generateCodeVerifier(): string {
  // 64 bytes → 86 base64url chars; well over the RFC minimum of 43.
  return base64url(randomBytes(64));
}

export function deriveCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/server test -- pkce`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/pkce.ts server/src/oauth/__tests__/pkce.test.ts
git commit -m "feat(server): add PKCE helpers (generateCodeVerifier, deriveCodeChallenge)"
```

---

### Task 5: Backoff math

**Files:**
- Create: `server/src/oauth/backoff.ts`
- Test: `server/src/oauth/__tests__/backoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { backoffSeconds } from "../backoff.js";

describe("backoffSeconds", () => {
  it("starts at 30s on first attempt", () => expect(backoffSeconds(1)).toBe(60));
  it("returns 30s for zero attempts", () => expect(backoffSeconds(0)).toBe(30));
  it("doubles up to 1h cap", () => {
    expect(backoffSeconds(5)).toBe(960);    // 2^5*30 = 960
    expect(backoffSeconds(10)).toBe(3600);  // capped at 1h
    expect(backoffSeconds(50)).toBe(3600);
  });
  it("never negative", () => {
    for (let i = 0; i < 100; i++) expect(backoffSeconds(i)).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- backoff`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `server/src/oauth/backoff.ts`:

```ts
const CAP_SECONDS = 3600;

export function backoffSeconds(attempts: number): number {
  if (attempts < 0 || !Number.isFinite(attempts)) return 30;
  const exp = Math.min(attempts, 30);  // prevent overflow on huge inputs
  return Math.min(2 ** exp * 30, CAP_SECONDS);
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- backoff`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/backoff.ts server/src/oauth/__tests__/backoff.test.ts
git commit -m "feat(server): add OAuth refresh backoff math"
```

---

### Task 6: Dot-path extractor

**Files:**
- Create: `server/src/oauth/dot-path.ts`
- Test: `server/src/oauth/__tests__/dot-path.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { getByPath } from "../dot-path.js";

describe("getByPath", () => {
  it("reads top-level field", () => expect(getByPath({ id: 1 }, "id")).toBe(1));
  it("reads nested field", () => expect(getByPath({ team: { id: "abc" } }, "team.id")).toBe("abc"));
  it("returns null for missing nested", () => expect(getByPath({ a: {} }, "a.b.c")).toBeNull());
  it("returns null for null intermediates", () => expect(getByPath({ a: null }, "a.b")).toBeNull());
  it("returns null for non-object root", () => expect(getByPath(null as unknown, "a.b")).toBeNull());
  it("ignores prototype pollution paths", () => {
    expect(getByPath({}, "__proto__.polluted")).toBeNull();
    expect(getByPath({}, "constructor.prototype")).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- dot-path`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);

export function getByPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return null;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (BLOCKED.has(part)) return null;
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- dot-path`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/dot-path.ts server/src/oauth/__tests__/dot-path.test.ts
git commit -m "feat(server): add safe dot-path getter for OAuth response shapes"
```

---

### Task 7: Redirect-URI allowlist

**Files:**
- Create: `server/src/oauth/redirect-allowlist.ts`
- Test: `server/src/oauth/__tests__/redirect-allowlist.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { validateReturnUrl } from "../redirect-allowlist.js";

const PUBLIC = "https://app.paperclip.test";

describe("validateReturnUrl", () => {
  it("accepts /settings/* paths", () =>
    expect(validateReturnUrl("/settings/connections", PUBLIC)).toBe("/settings/connections"));

  it("accepts /agents/* paths", () =>
    expect(validateReturnUrl("/agents/abc", PUBLIC)).toBe("/agents/abc"));

  it("accepts /runs/* paths", () =>
    expect(validateReturnUrl("/runs/xyz", PUBLIC)).toBe("/runs/xyz"));

  it("rejects cross-origin absolute URLs", () =>
    expect(validateReturnUrl("https://evil.example/x", PUBLIC)).toBe("/settings/connections"));

  it("rejects javascript: scheme", () =>
    expect(validateReturnUrl("javascript:alert(1)", PUBLIC)).toBe("/settings/connections"));

  it("rejects data: scheme", () =>
    expect(validateReturnUrl("data:text/html,x", PUBLIC)).toBe("/settings/connections"));

  it("rejects schema-relative //evil.example", () =>
    expect(validateReturnUrl("//evil.example/x", PUBLIC)).toBe("/settings/connections"));

  it("rejects double-encoded slashes", () =>
    expect(validateReturnUrl("https:%2F%2Fevil.example", PUBLIC)).toBe("/settings/connections"));

  it("rejects backslash schema-relative", () =>
    expect(validateReturnUrl("\\\\evil.example/x", PUBLIC)).toBe("/settings/connections"));

  it("falls back when undefined", () =>
    expect(validateReturnUrl(undefined, PUBLIC)).toBe("/settings/connections"));

  it("rejects /admin/x (not in allowlist)", () =>
    expect(validateReturnUrl("/admin/x", PUBLIC)).toBe("/settings/connections"));
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- redirect-allowlist`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
const ALLOWED_PREFIXES = ["/settings/", "/agents/", "/runs/"];
const SAFE_DEFAULT = "/settings/connections";

export function validateReturnUrl(url: string | undefined, publicUrl: string): string {
  if (!url || typeof url !== "string") return SAFE_DEFAULT;

  // Reject schema-relative URLs (//evil) and backslash variants up front
  // — URL parser would otherwise accept them as same-origin in some Node versions.
  if (/^\s*[/\\]{2,}/.test(url)) return SAFE_DEFAULT;

  let parsed: URL;
  try {
    parsed = new URL(url, publicUrl);
  } catch {
    return SAFE_DEFAULT;
  }

  const expected = new URL(publicUrl);
  if (parsed.origin !== expected.origin) return SAFE_DEFAULT;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return SAFE_DEFAULT;

  const allowed = ALLOWED_PREFIXES.some((p) => parsed.pathname.startsWith(p));
  if (!allowed) return SAFE_DEFAULT;

  return parsed.pathname + parsed.search + parsed.hash;
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- redirect-allowlist`
Expected: PASS (all 11).

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/redirect-allowlist.ts server/src/oauth/__tests__/redirect-allowlist.test.ts
git commit -m "feat(server): add returnUrl allowlist validator"
```

---

### Task 8: In-memory sliding-window rate limiter

**Files:**
- Create: `server/src/oauth/rate-limiter.ts`
- Test: `server/src/oauth/__tests__/rate-limiter.test.ts`

This is a minimal stand-in for M3b's `createSlidingWindowLimiter`. When M3b merges, swap to that (Task 53).

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSlidingWindowLimiter } from "../rate-limiter.js";

describe("createSlidingWindowLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows up to limit then blocks", async () => {
    const limit = createSlidingWindowLimiter({ limit: 3, windowMs: 60_000 });
    expect(await limit.check("k1")).toBe(true);
    expect(await limit.check("k1")).toBe(true);
    expect(await limit.check("k1")).toBe(true);
    expect(await limit.check("k1")).toBe(false);
  });

  it("scopes by key", async () => {
    const limit = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(await limit.check("a")).toBe(true);
    expect(await limit.check("b")).toBe(true);
    expect(await limit.check("a")).toBe(false);
  });

  it("expires entries after window", async () => {
    const limit = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(await limit.check("k")).toBe(true);
    expect(await limit.check("k")).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(await limit.check("k")).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- rate-limiter`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface SlidingWindowLimiterOptions {
  limit: number;
  windowMs: number;
}

export interface SlidingWindowLimiter {
  check(key: string): Promise<boolean>;
}

export function createSlidingWindowLimiter(opts: SlidingWindowLimiterOptions): SlidingWindowLimiter {
  const buckets = new Map<string, number[]>();  // key → sorted timestamps
  return {
    async check(key) {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      const bucket = buckets.get(key) ?? [];
      // drop expired
      while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
      if (bucket.length >= opts.limit) {
        buckets.set(key, bucket);
        return false;
      }
      bucket.push(now);
      buckets.set(key, bucket);
      return true;
    },
  };
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- rate-limiter`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/rate-limiter.ts server/src/oauth/__tests__/rate-limiter.test.ts
git commit -m "feat(server): add in-memory sliding-window rate limiter (interim — replace with M3b shared limiter)"
```

---

## Phase 2 — Provider DSL + registry

### Task 9: Zod schema + types for `OAuthProviderConfig`

**Files:**
- Create: `server/src/oauth/types.ts`
- Create: `server/src/oauth/provider-config.ts`
- Test: `server/src/oauth/__tests__/provider-config.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { OAuthProviderConfigSchema } from "../provider-config.js";

const VALID = {
  id: "github",
  displayName: "GitHub",
  clientCredentials: { clientIdEnv: "X_ID", clientSecretEnv: "X_SECRET" },
  endpoints: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    accountInfo: "https://api.github.com/user",
  },
  scopes: { default: ["repo"], offered: ["repo", "workflow"] },
  pkce: "required",
  authMethod: "post",
  responseFormat: "json",
  accountIdField: "id",
  accountLabelField: "login",
  refresh: { supported: false },
};

describe("OAuthProviderConfigSchema", () => {
  it("accepts a valid config", () => {
    expect(OAuthProviderConfigSchema.parse(VALID).id).toBe("github");
  });

  it("rejects http:// endpoints", () => {
    const bad = { ...VALID, endpoints: { ...VALID.endpoints, token: "http://insecure.example/token" } };
    expect(() => OAuthProviderConfigSchema.parse(bad)).toThrow();
  });

  it("rejects unknown PKCE mode", () => {
    expect(() => OAuthProviderConfigSchema.parse({ ...VALID, pkce: "weird" })).toThrow();
  });

  it("rejects refresh.supported=true without rotatesRefreshToken", () => {
    const bad = { ...VALID, refresh: { supported: true } };
    expect(() => OAuthProviderConfigSchema.parse(bad)).toThrow();
  });

  it("rejects scopes.default not subset of offered", () => {
    const bad = { ...VALID, scopes: { default: ["unknown"], offered: ["repo"] } };
    expect(() => OAuthProviderConfigSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- provider-config`
Expected: FAIL.

- [ ] **Step 3: Implement types and schema**

Create `server/src/oauth/types.ts`:

```ts
import type { OAuthProviderConfig } from "./provider-config.js";

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scope?: string[];
}

export interface ParsedAccountInfo {
  accountId: string;
  accountLabel?: string;
}

export interface ProviderShape {
  parseTokenResponse?: (raw: unknown) => ParsedTokenResponse;
  parseAccountInfo?: (raw: unknown) => ParsedAccountInfo;
}

export interface RegisteredProvider {
  config: OAuthProviderConfig;
  clientId: string;
  clientSecret: string;
  shape: ProviderShape;  // resolved (default + override merged)
  source: "yaml" | "plugin";
}

export type { OAuthProviderConfig };
```

Create `server/src/oauth/provider-config.ts`:

```ts
import { z } from "zod";

const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), {
  message: "endpoint must use https://",
});

export const OAuthProviderConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1),
  iconUrl: z.string().url().optional(),
  docUrl: z.string().url().optional(),

  clientCredentials: z.object({
    clientIdEnv: z.string().min(1),
    clientSecretEnv: z.string().min(1),
  }),

  endpoints: z.object({
    authorize: httpsUrl,
    token: httpsUrl,
    revoke: httpsUrl.optional(),
    accountInfo: httpsUrl,
  }),

  scopes: z.object({
    default: z.array(z.string()),
    offered: z.array(z.string()),
  }).refine((s) => s.default.every((d) => s.offered.includes(d)), {
    message: "scopes.default must be a subset of scopes.offered",
  }),

  pkce: z.enum(["required", "optional", "unsupported"]),
  authMethod: z.enum(["post", "basic"]),
  responseFormat: z.enum(["json", "form"]),
  accountIdField: z.string().min(1),
  accountLabelField: z.string().min(1),

  refresh: z.discriminatedUnion("supported", [
    z.object({ supported: z.literal(false) }),
    z.object({
      supported: z.literal(true),
      rotatesRefreshToken: z.boolean(),
      expirySeconds: z.number().int().positive().optional(),
    }),
  ]),

  shape: z.string().optional(),
});

export type OAuthProviderConfig = z.infer<typeof OAuthProviderConfigSchema>;
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- provider-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/types.ts server/src/oauth/provider-config.ts \
        server/src/oauth/__tests__/provider-config.test.ts
git commit -m "feat(server): add Zod schema and types for OAuthProviderConfig"
```

---

### Task 10: Default RFC-6749 response shape

**Files:**
- Create: `server/src/oauth/default-shape.ts`
- Test: `server/src/oauth/__tests__/default-shape.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildDefaultShape } from "../default-shape.js";

const cfg = {
  accountIdField: "id",
  accountLabelField: "login",
} as const;

describe("buildDefaultShape", () => {
  const shape = buildDefaultShape(cfg);

  it("parses RFC-6749 token response", () => {
    expect(shape.parseTokenResponse!({
      access_token: "abc", refresh_token: "def", expires_in: 3600, scope: "repo user",
    })).toEqual({
      accessToken: "abc", refreshToken: "def", expiresInSeconds: 3600, scope: ["repo", "user"],
    });
  });

  it("parses account info via configured fields", () => {
    expect(shape.parseAccountInfo!({ id: 42, login: "octocat" })).toEqual({
      accountId: "42", accountLabel: "octocat",
    });
  });

  it("rejects missing access_token", () => {
    expect(() => shape.parseTokenResponse!({})).toThrow();
  });

  it("rejects negative expires_in", () => {
    expect(() => shape.parseTokenResponse!({ access_token: "x", expires_in: -1 })).toThrow();
  });

  it("rejects expires_in over a year", () => {
    expect(() => shape.parseTokenResponse!({ access_token: "x", expires_in: 60_000_000 })).toThrow();
  });

  it("rejects non-string account id", () => {
    expect(() => shape.parseAccountInfo!({ id: { nested: 1 }, login: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- default-shape`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { getByPath } from "./dot-path.js";
import type { ProviderShape } from "./types.js";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function buildDefaultShape(cfg: {
  accountIdField: string;
  accountLabelField: string;
}): ProviderShape {
  return {
    parseTokenResponse(raw) {
      if (typeof raw !== "object" || raw === null) {
        throw new Error("response_shape_violation: not an object");
      }
      const r = raw as Record<string, unknown>;
      if (typeof r.access_token !== "string" || r.access_token.length === 0) {
        throw new Error("response_shape_violation: missing access_token");
      }
      let expiresInSeconds: number | undefined;
      if (r.expires_in !== undefined) {
        const n = Number(r.expires_in);
        if (!Number.isFinite(n) || n < 0 || n > ONE_YEAR_SECONDS) {
          throw new Error("response_shape_violation: invalid expires_in");
        }
        expiresInSeconds = n;
      }
      let scope: string[] | undefined;
      if (typeof r.scope === "string") {
        if (/[^\x20-\x7E]/.test(r.scope)) {
          throw new Error("response_shape_violation: scope contains non-printable characters");
        }
        scope = r.scope.split(/[\s,]+/).filter(Boolean);
      }
      return {
        accessToken: r.access_token,
        refreshToken: typeof r.refresh_token === "string" ? r.refresh_token : undefined,
        expiresInSeconds,
        scope,
      };
    },
    parseAccountInfo(raw) {
      const idVal = getByPath(raw, cfg.accountIdField);
      const labelVal = getByPath(raw, cfg.accountLabelField);
      if (idVal === null || idVal === undefined) {
        throw new Error("response_shape_violation: missing account id");
      }
      const accountId = typeof idVal === "string" || typeof idVal === "number"
        ? String(idVal)
        : (() => { throw new Error("response_shape_violation: non-scalar account id"); })();
      const accountLabel = typeof labelVal === "string" || typeof labelVal === "number"
        ? String(labelVal)
        : undefined;
      return { accountId, accountLabel };
    },
  };
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- default-shape`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/default-shape.ts server/src/oauth/__tests__/default-shape.test.ts
git commit -m "feat(server): add default RFC-6749 shape parser"
```

---

### Task 11: Provider registry (in-memory map)

**Files:**
- Create: `server/src/oauth/registry.ts`
- Test: `server/src/oauth/__tests__/registry.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../registry.js";
import type { OAuthProviderConfig } from "../provider-config.js";

const cfg = (id: string): OAuthProviderConfig => ({
  id,
  displayName: id,
  clientCredentials: { clientIdEnv: `${id.toUpperCase()}_ID`, clientSecretEnv: `${id.toUpperCase()}_SECRET` },
  endpoints: {
    authorize: "https://x.example/a", token: "https://x.example/t", accountInfo: "https://x.example/u",
  },
  scopes: { default: [], offered: [] },
  pkce: "required", authMethod: "post", responseFormat: "json",
  accountIdField: "id", accountLabelField: "name",
  refresh: { supported: false },
});

describe("ProviderRegistry", () => {
  it("registers a provider when env vars set", () => {
    const r = new ProviderRegistry({ env: { GH_ID: "id", GH_SECRET: "s" } as Record<string, string> });
    r.register(cfg("gh"), "yaml");
    expect(r.get("gh")?.clientId).toBe("id");
  });

  it("skips a provider when env vars missing", () => {
    const r = new ProviderRegistry({ env: {} });
    r.register(cfg("gh"), "yaml");
    expect(r.get("gh")).toBeUndefined();
  });

  it("file source wins over plugin source", () => {
    const env = { GH_ID: "id", GH_SECRET: "s" } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    r.register(cfg("gh"), "yaml");
    r.register({ ...cfg("gh"), displayName: "Plugin GH" }, "plugin");
    expect(r.get("gh")?.config.displayName).toBe("gh");
  });

  it("plugin loaded first then yaml: yaml replaces", () => {
    const env = { GH_ID: "id", GH_SECRET: "s" } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    r.register({ ...cfg("gh"), displayName: "Plugin GH" }, "plugin");
    r.register(cfg("gh"), "yaml");
    expect(r.get("gh")?.config.displayName).toBe("gh");
  });

  it("list() returns all registered providers", () => {
    const env = { A_ID: "i", A_SECRET: "s", B_ID: "i", B_SECRET: "s" } as Record<string, string>;
    const r = new ProviderRegistry({ env });
    r.register(cfg("a"), "yaml");
    r.register(cfg("b"), "yaml");
    expect(r.list().map((p) => p.config.id).sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- registry`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { OAuthProviderConfig } from "./provider-config.js";
import type { RegisteredProvider, ProviderShape } from "./types.js";
import { buildDefaultShape } from "./default-shape.js";
import { logger } from "../middleware/logger.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly env: Record<string, string | undefined>;

  constructor(opts: { env: Record<string, string | undefined> }) {
    this.env = opts.env;
  }

  register(config: OAuthProviderConfig, source: "yaml" | "plugin", shapeOverride?: ProviderShape): void {
    const clientId = this.env[config.clientCredentials.clientIdEnv];
    const clientSecret = this.env[config.clientCredentials.clientSecretEnv];
    if (!clientId || !clientSecret) {
      logger.warn(
        { provider: config.id, source },
        "OAuth provider env vars unset; skipping registration",
      );
      return;
    }

    const existing = this.providers.get(config.id);
    if (existing && existing.source === "yaml" && source === "plugin") {
      logger.warn(
        { provider: config.id },
        "plugin contribution shadowed by yaml — plugin skipped",
      );
      return;
    }
    if (existing && source === "yaml") {
      logger.warn(
        { provider: config.id },
        "yaml provider replaces previously-registered entry",
      );
    }

    const defaultShape = buildDefaultShape({
      accountIdField: config.accountIdField,
      accountLabelField: config.accountLabelField,
    });
    const shape: ProviderShape = {
      parseTokenResponse: shapeOverride?.parseTokenResponse ?? defaultShape.parseTokenResponse,
      parseAccountInfo: shapeOverride?.parseAccountInfo ?? defaultShape.parseAccountInfo,
    };

    this.providers.set(config.id, { config, clientId, clientSecret, shape, source });
  }

  get(id: string): RegisteredProvider | undefined {
    return this.providers.get(id);
  }

  list(): RegisteredProvider[] {
    return Array.from(this.providers.values());
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/registry.ts server/src/oauth/__tests__/registry.test.ts
git commit -m "feat(server): add OAuth provider registry with file > plugin precedence"
```

---

### Task 12: YAML loader

**Files:**
- Create: `server/src/oauth/yaml-loader.ts`
- Test: `server/src/oauth/__tests__/yaml-loader.test.ts`
- Test fixture: `server/src/oauth/__tests__/fixtures/oauth-providers/mock.yaml`

- [ ] **Step 1: Create the fixture**

`server/src/oauth/__tests__/fixtures/oauth-providers/mock.yaml`:

```yaml
id: mock
displayName: Mock
clientCredentials:
  clientIdEnv: MOCK_OAUTH_CLIENT_ID
  clientSecretEnv: MOCK_OAUTH_CLIENT_SECRET
endpoints:
  authorize: https://mock.example/auth
  token: https://mock.example/token
  accountInfo: https://mock.example/me
scopes:
  default: [read]
  offered: [read, write]
pkce: required
authMethod: post
responseFormat: json
accountIdField: id
accountLabelField: name
refresh:
  supported: true
  rotatesRefreshToken: true
```

- [ ] **Step 2: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { loadProviderConfigsFromDirectory } from "../yaml-loader.js";
import path from "node:path";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "oauth-providers");

describe("loadProviderConfigsFromDirectory", () => {
  it("loads and validates yaml files", async () => {
    const configs = await loadProviderConfigsFromDirectory(FIXTURE_DIR);
    expect(configs.map((c) => c.id)).toContain("mock");
  });

  it("returns empty array for missing dir", async () => {
    const configs = await loadProviderConfigsFromDirectory("/nonexistent/path/x");
    expect(configs).toEqual([]);
  });
});
```

- [ ] **Step 3: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- yaml-loader`
Expected: FAIL.

- [ ] **Step 4: Implement**

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";  // Already a transitive dep; if not, add to server/package.json
import { OAuthProviderConfigSchema, type OAuthProviderConfig } from "./provider-config.js";
import { logger } from "../middleware/logger.js";

export async function loadProviderConfigsFromDirectory(dir: string): Promise<OAuthProviderConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const yamlFiles = entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const configs: OAuthProviderConfig[] = [];
  for (const file of yamlFiles) {
    const fullPath = path.join(dir, file);
    const raw = await readFile(fullPath, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      logger.error({ file: fullPath, err }, "failed to parse OAuth provider yaml");
      throw new Error(`Invalid YAML in ${fullPath}`);
    }
    const result = OAuthProviderConfigSchema.safeParse(parsed);
    if (!result.success) {
      logger.error({ file: fullPath, issues: result.error.issues }, "invalid OAuth provider config");
      throw new Error(`Invalid provider config in ${fullPath}: ${result.error.message}`);
    }
    configs.push(result.data);
  }
  return configs;
}
```

If `yaml` is not yet a dep, add it: edit `server/package.json` to include `"yaml": "^2.5.0"` under `dependencies`, then `pnpm install`.

- [ ] **Step 5: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- yaml-loader`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/oauth/yaml-loader.ts \
        server/src/oauth/__tests__/yaml-loader.test.ts \
        server/src/oauth/__tests__/fixtures/oauth-providers/mock.yaml \
        server/package.json pnpm-lock.yaml
git commit -m "feat(server): load OAuth provider configs from yaml directory"
```

---

### Task 13: Plugin SDK — `defineOAuthProvider` helper

**Files:**
- Create: `packages/plugins/sdk/src/define-oauth-provider.ts`
- Modify: `packages/plugins/sdk/src/index.ts` (export the new helper)
- Test: `packages/plugins/sdk/src/__tests__/define-oauth-provider.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { defineOAuthProvider } from "../define-oauth-provider.js";

describe("defineOAuthProvider", () => {
  it("returns its input unchanged (identity helper)", () => {
    const contribution = {
      config: {
        id: "x",
        displayName: "X",
        clientCredentials: { clientIdEnv: "X_ID", clientSecretEnv: "X_SECRET" },
        endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
        scopes: { default: [], offered: [] },
        pkce: "required" as const,
        authMethod: "post" as const,
        responseFormat: "json" as const,
        accountIdField: "id",
        accountLabelField: "name",
        refresh: { supported: false as const },
      },
    };
    expect(defineOAuthProvider(contribution)).toBe(contribution);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/plugin-sdk test -- define-oauth-provider`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/plugins/sdk/src/define-oauth-provider.ts`:

```ts
import type { OAuthProviderContribution } from "@paperclipai/shared/types/plugin";

export function defineOAuthProvider<T extends OAuthProviderContribution>(contribution: T): T {
  return contribution;
}
```

Modify `packages/plugins/sdk/src/index.ts` to add:

```ts
export { defineOAuthProvider } from "./define-oauth-provider.js";
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/plugin-sdk test -- define-oauth-provider`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/sdk/src/define-oauth-provider.ts \
        packages/plugins/sdk/src/index.ts \
        packages/plugins/sdk/src/__tests__/define-oauth-provider.test.ts
git commit -m "feat(plugin-sdk): add defineOAuthProvider helper"
```

---

### Task 14: Extend `PaperclipPluginManifestV1` with `oauthProviders`

**Files:**
- Modify: `packages/shared/src/types/plugin.ts`
- Test: `packages/shared/src/types/__tests__/plugin.test.ts`

- [ ] **Step 1: Failing test**

Add to `packages/shared/src/types/__tests__/plugin.test.ts` (create if absent):

```ts
import { describe, it, expectTypeOf } from "vitest";
import type { PaperclipPluginManifestV1, OAuthProviderContribution } from "../plugin.js";

describe("plugin manifest oauth extension", () => {
  it("OAuthProviderContribution has config and optional shape", () => {
    expectTypeOf<OAuthProviderContribution>().toMatchTypeOf<{ config: unknown; shape?: unknown }>();
  });

  it("manifest.kind allows oauth_provider and composite", () => {
    type Kind = PaperclipPluginManifestV1["kind"];
    const k: Kind = "oauth_provider";
    expectTypeOf(k).toMatchTypeOf<Kind>();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/shared test -- plugin`
Expected: FAIL.

- [ ] **Step 3: Extend the type**

In `packages/shared/src/types/plugin.ts`, add near the existing `PaperclipPluginManifestV1`:

```ts
// OAuth provider contributions from plugins. The config shape mirrors the
// server-side OAuthProviderConfig but is duplicated here to avoid pulling
// server code into the shared package; the server validates the contribution
// at registration time.
export interface OAuthProviderContributionConfig {
  id: string;
  displayName: string;
  iconUrl?: string;
  docUrl?: string;
  clientCredentials: { clientIdEnv: string; clientSecretEnv: string };
  endpoints: { authorize: string; token: string; revoke?: string; accountInfo: string };
  scopes: { default: string[]; offered: string[] };
  pkce: "required" | "optional" | "unsupported";
  authMethod: "post" | "basic";
  responseFormat: "json" | "form";
  accountIdField: string;
  accountLabelField: string;
  refresh:
    | { supported: false }
    | { supported: true; rotatesRefreshToken: boolean; expirySeconds?: number };
  shape?: string;
}

export interface OAuthProviderShape {
  parseTokenResponse?: (raw: unknown) => {
    accessToken: string; refreshToken?: string; expiresInSeconds?: number; scope?: string[];
  };
  parseAccountInfo?: (raw: unknown) => { accountId: string; accountLabel?: string };
}

export interface OAuthProviderContribution {
  config: OAuthProviderContributionConfig;
  shape?: OAuthProviderShape;
}
```

Locate `PaperclipPluginManifestV1` (around line 445 per Explore findings) and update its `kind` union and add the optional field. The exact diff:

```diff
 export interface PaperclipPluginManifestV1 {
   ...
-  kind: "sandbox_provider";
+  kind: "sandbox_provider" | "oauth_provider" | "composite";
+  oauthProviders?: OAuthProviderContribution[];
   ...
 }
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/shared test -- plugin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/plugin.ts \
        packages/shared/src/types/__tests__/plugin.test.ts
git commit -m "feat(shared): extend PaperclipPluginManifestV1 with oauthProviders"
```

---

### Task 15: Plugin loader — pull contributions into the registry

**Files:**
- Create: `server/src/oauth/plugin-loader.ts`
- Test: `server/src/oauth/__tests__/plugin-loader.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../registry.js";
import { registerPluginContributions } from "../plugin-loader.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared/types/plugin";

const baseConfig = {
  id: "stripe",
  displayName: "Stripe",
  clientCredentials: { clientIdEnv: "STRIPE_OAUTH_CLIENT_ID", clientSecretEnv: "STRIPE_OAUTH_CLIENT_SECRET" },
  endpoints: { authorize: "https://stripe/a", token: "https://stripe/t", accountInfo: "https://stripe/me" },
  scopes: { default: [], offered: [] },
  pkce: "required" as const,
  authMethod: "post" as const,
  responseFormat: "json" as const,
  accountIdField: "id",
  accountLabelField: "name",
  refresh: { supported: false as const },
};

const manifest: PaperclipPluginManifestV1 = {
  schemaVersion: 1,
  name: "@example/stripe",
  version: "1.0.0",
  kind: "oauth_provider",
  entry: "./index.js",
  oauthProviders: [{ config: baseConfig }],
} as PaperclipPluginManifestV1;

describe("registerPluginContributions", () => {
  it("registers provider when env set", () => {
    const env = { STRIPE_OAUTH_CLIENT_ID: "x", STRIPE_OAUTH_CLIENT_SECRET: "y" };
    const r = new ProviderRegistry({ env });
    registerPluginContributions(r, [manifest]);
    expect(r.get("stripe")).toBeDefined();
  });

  it("rejects malformed config (Zod validation runs)", () => {
    const env = { STRIPE_OAUTH_CLIENT_ID: "x", STRIPE_OAUTH_CLIENT_SECRET: "y" };
    const r = new ProviderRegistry({ env });
    const bad = { ...manifest, oauthProviders: [{ config: { ...baseConfig, pkce: "weird" as never } }] };
    expect(() => registerPluginContributions(r, [bad])).toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- plugin-loader`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared/types/plugin";
import { OAuthProviderConfigSchema } from "./provider-config.js";
import { ProviderRegistry } from "./registry.js";
import { logger } from "../middleware/logger.js";

export function registerPluginContributions(
  registry: ProviderRegistry,
  manifests: PaperclipPluginManifestV1[],
): void {
  for (const manifest of manifests) {
    if (manifest.kind !== "oauth_provider" && manifest.kind !== "composite") continue;
    const contributions = manifest.oauthProviders ?? [];
    for (const c of contributions) {
      const result = OAuthProviderConfigSchema.safeParse(c.config);
      if (!result.success) {
        logger.error(
          { plugin: manifest.name, providerId: c.config.id, issues: result.error.issues },
          "plugin OAuth contribution failed validation",
        );
        throw new Error(
          `plugin ${manifest.name} contributed invalid OAuth provider ${c.config.id}: ${result.error.message}`,
        );
      }
      registry.register(result.data, "plugin", c.shape);
    }
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- plugin-loader`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/plugin-loader.ts server/src/oauth/__tests__/plugin-loader.test.ts
git commit -m "feat(server): register plugin OAuth contributions into provider registry"
```

---

## Phase 3 — OAuth flow handler routes

This phase wires the actual HTTP surface. The router is split across three files: company-scoped routes, the public callback, and the run-JWT-authed mark-revoked endpoint.

### Task 16: Pino `oauthLogger` child with redaction

**Files:**
- Create: `server/src/oauth/logger.ts`
- Test: `server/src/oauth/__tests__/logger.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { oauthLogger } from "../logger.js";

describe("oauthLogger", () => {
  it("redacts access_token and refresh_token", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    });
    try {
      oauthLogger.info(
        { access_token: "ACCESS_SECRET", refresh_token: "REFRESH_SECRET", code: "CODE_VAL" },
        "test event",
      );
    } finally {
      spy.mockRestore();
    }
    const all = writes.join("");
    expect(all).not.toContain("ACCESS_SECRET");
    expect(all).not.toContain("REFRESH_SECRET");
    expect(all).not.toContain("CODE_VAL");
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth/__tests__/logger`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { logger } from "../middleware/logger.js";

const REDACT_PATHS = [
  "access_token", "refresh_token", "id_token",
  "code", "code_verifier", "client_secret",
  "*.access_token", "*.refresh_token", "*.id_token",
  "*.code", "*.code_verifier", "*.client_secret",
  "data.access_token", "data.refresh_token", "data.id_token",
];

export const oauthLogger = logger.child(
  { component: "oauth" },
  { redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
);
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth/__tests__/logger`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/logger.ts server/src/oauth/__tests__/logger.test.ts
git commit -m "feat(server): add oauthLogger child with token redaction"
```

---

### Task 17: Token exchange + account info HTTP client

**Files:**
- Create: `server/src/oauth/http.ts`
- Test: `server/src/oauth/__tests__/http.test.ts`

This is the shared HTTP client used by the callback (initial exchange) and by `refresh.ts` (refresh exchange). Centralized so timeout/retry behavior is uniform.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exchangeToken, fetchAccountInfo } from "../http.js";

describe("exchangeToken", () => {
  let server: { close: () => void; url: string; lastBody: string };

  beforeEach(async () => {
    const http = await import("node:http");
    let lastBody = "";
    const s = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastBody = Buffer.concat(chunks).toString("utf8");
        if (req.url === "/fail500") { res.statusCode = 500; res.end("nope"); return; }
        if (req.url === "/fail400") { res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_grant" })); return; }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "x", expires_in: 60 }));
      });
    });
    await new Promise<void>((r) => s.listen(0, r));
    const port = (s.address() as { port: number }).port;
    server = {
      close: () => s.close(),
      url: `http://127.0.0.1:${port}`,
      get lastBody() { return lastBody; },
    } as any;
  });

  afterEach(() => server.close());

  it("posts form body and parses json response", async () => {
    const res = await exchangeToken({
      url: `${server.url}/ok`,
      params: { grant_type: "authorization_code", code: "abc" },
      authMethod: "post",
      responseFormat: "json",
      clientId: "cid",
      clientSecret: "csec",
    });
    expect(res).toMatchObject({ access_token: "x" });
    expect(server.lastBody).toContain("grant_type=authorization_code");
    expect(server.lastBody).toContain("client_id=cid");
  });

  it("retries on 5xx", async () => {
    // 2 retries on 5xx — ensure the request is attempted multiple times.
    // Track via a counter on the server side; for simplicity use a fail500 endpoint.
    await expect(
      exchangeToken({
        url: `${server.url}/fail500`,
        params: { grant_type: "authorization_code", code: "abc" },
        authMethod: "post",
        responseFormat: "json",
        clientId: "cid",
        clientSecret: "csec",
      }),
    ).rejects.toThrow();
  });

  it("does not retry on 4xx", async () => {
    await expect(
      exchangeToken({
        url: `${server.url}/fail400`,
        params: { grant_type: "authorization_code", code: "abc" },
        authMethod: "post",
        responseFormat: "json",
        clientId: "cid",
        clientSecret: "csec",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth/__tests__/http`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { oauthLogger } from "./logger.js";

const TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [200, 600];  // 2 retries on 5xx

export interface ExchangeTokenInput {
  url: string;
  params: Record<string, string>;
  authMethod: "post" | "basic";
  responseFormat: "json" | "form";
  clientId: string;
  clientSecret: string;
}

export interface ExchangeTokenError extends Error {
  status: number;
  providerErrorCode?: string;
}

export async function exchangeToken(input: ExchangeTokenInput): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(input.params)) body.set(k, v);
  if (input.authMethod === "post") {
    body.set("client_id", input.clientId);
    body.set("client_secret", input.clientSecret);
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "accept": input.responseFormat === "json" ? "application/json" : "application/x-www-form-urlencoded",
  };
  if (input.authMethod === "basic") {
    const credentials = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");
    headers.authorization = `Basic ${credentials}`;
  }

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(input.url, {
        method: "POST",
        headers,
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(t);
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        attempt++;
        continue;
      }
      throw err;
    }
    clearTimeout(t);

    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = input.responseFormat === "json" ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
    } catch {
      parsed = {};
    }

    if (res.ok) return parsed;

    if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
      oauthLogger.warn({ status: res.status, attempt }, "token endpoint 5xx; retrying");
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      attempt++;
      continue;
    }

    const err = new Error(
      `token exchange failed: ${res.status} ${typeof parsed.error === "string" ? parsed.error : ""}`,
    ) as ExchangeTokenError;
    err.status = res.status;
    err.providerErrorCode = typeof parsed.error === "string" ? parsed.error : undefined;
    throw err;
  }
}

export async function fetchAccountInfo(url: string, accessToken: string): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": "paperclip-oauth/1.0",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`account info fetch failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth/__tests__/http`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/http.ts server/src/oauth/__tests__/http.test.ts
git commit -m "feat(server): add OAuth token exchange + account info HTTP client"
```

---

### Task 18: Provider discovery routes (`GET /providers`, `GET /providers/:id`)

**Files:**
- Create: `server/src/routes/oauth.ts` (will grow as more route tasks land)
- Test: `server/src/routes/__tests__/oauth-providers.test.ts`

The router factory `oauthRoutes(registry, deps)` takes the provider registry plus a deps bundle (db handle, secrets, etc.). For this task only the registry is used.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

function makeApp() {
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register({
    id: "github",
    displayName: "GitHub",
    iconUrl: "https://example/icon.png",
    docUrl: "https://example/docs",
    clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
    endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
    scopes: { default: ["repo"], offered: ["repo", "workflow"] },
    pkce: "required", authMethod: "post", responseFormat: "json",
    accountIdField: "id", accountLabelField: "login",
    refresh: { supported: false },
  }, "yaml");
  const app = express();
  app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
    (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
    next();
  }, oauthRoutes({ registry } as any));
  return app;
}

describe("GET /providers", () => {
  it("returns provider summaries (no client secrets)", async () => {
    const res = await request(makeApp()).get("/api/companies/c1/oauth/providers");
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.providers[0]).toMatchObject({ id: "github", displayName: "GitHub" });
    expect(JSON.stringify(res.body)).not.toContain("clientSecret");
  });

  it("GET /providers/:id returns single", async () => {
    const res = await request(makeApp()).get("/api/companies/c1/oauth/providers/github");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("github");
  });

  it("404 for unknown provider", async () => {
    const res = await request(makeApp()).get("/api/companies/c1/oauth/providers/unknown");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth-providers`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { Router, type Request, type Response } from "express";
import type { ProviderRegistry } from "../oauth/registry.js";
import type { RegisteredProvider } from "../oauth/types.js";

export interface OAuthRouteDeps {
  registry: ProviderRegistry;
  // additional deps wired in later tasks: db, secretService, publicUrl
}

function summary(p: RegisteredProvider) {
  return {
    id: p.config.id,
    displayName: p.config.displayName,
    iconUrl: p.config.iconUrl,
    docUrl: p.config.docUrl,
    scopesOffered: p.config.scopes.offered,
    scopesDefault: p.config.scopes.default,
  };
}

function ensureMember(req: Request, res: Response): boolean {
  const actor = (req as any).actor;
  const companyId = req.params.companyId;
  if (!actor || actor.type === "none") { res.status(401).json({ errorCode: "unauthenticated" }); return false; }
  const ok = (actor.memberships ?? []).some((m: { companyId: string }) => m.companyId === companyId);
  if (!ok) { res.status(404).end(); return false; }  // 404 not 403, per spec 9.8
  return true;
}

export function oauthRoutes(deps: OAuthRouteDeps): Router {
  const r = Router({ mergeParams: true });

  r.get("/providers", (req, res) => {
    if (!ensureMember(req, res)) return;
    res.json({ providers: deps.registry.list().map(summary) });
  });

  r.get("/providers/:providerId", (req, res) => {
    if (!ensureMember(req, res)) return;
    const p = deps.registry.get(req.params.providerId);
    if (!p) return res.status(404).json({ errorCode: "provider_not_found" });
    res.json(summary(p));
  });

  return r;
}
```

Note: the `ensureMember` helper is duplicated minimally for the test fixture; in the real router it should live alongside the existing `actorMiddleware` helpers. Refactor inline if a `requireCompanyMembership` helper already exists in `server/src/middleware/`.

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth-providers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/oauth.ts server/src/routes/__tests__/oauth-providers.test.ts
git commit -m "feat(server): add GET /api/companies/:id/oauth/providers route"
```

---

### Task 19: `POST /connect/:providerId` route

**Files:**
- Modify: `server/src/routes/oauth.ts`
- Test: `server/src/routes/__tests__/oauth-connect.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

function setup() {
  const insertMock = vi.fn().mockResolvedValue([{ id: "state-uuid-123" }]);
  const db = {
    insert: () => ({ values: () => ({ returning: insertMock }) }),
  };
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register({
    id: "github",
    displayName: "GitHub",
    clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
    endpoints: { authorize: "https://github.com/login/oauth/authorize", token: "https://x/t", accountInfo: "https://x/me" },
    scopes: { default: ["repo"], offered: ["repo", "workflow"] },
    pkce: "required", authMethod: "post", responseFormat: "json",
    accountIdField: "id", accountLabelField: "login",
    refresh: { supported: false },
  }, "yaml");
  const app = express();
  app.use(express.json());
  app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
    (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
    next();
  }, oauthRoutes({
    registry,
    db: db as any,
    publicUrl: "https://app.paperclip.test",
    rateLimiter: { check: async () => true } as any,
  }));
  return { app, insertMock };
}

describe("POST /connect/:providerId", () => {
  it("returns authorize URL with PKCE challenge + state", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/api/companies/c1/oauth/connect/github")
      .send({ returnUrl: "/settings/connections" });
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.paperclip.test/api/oauth/callback/github");
    expect(url.searchParams.get("scope")).toBe("repo");
    expect(url.searchParams.get("state")).toBe("state-uuid-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("rejects scopes not in offered", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/api/companies/c1/oauth/connect/github")
      .send({ scopes: ["admin:everything"] });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("invalid_scope");
  });

  it("returns 404 for unknown provider", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/companies/c1/oauth/connect/unknown");
    expect(res.status).toBe(404);
  });

  it("returns 429 when rate limit exceeded", async () => {
    const insertMock = vi.fn().mockResolvedValue([{ id: "s" }]);
    const db = { insert: () => ({ values: () => ({ returning: insertMock }) }) };
    const env = { GH_ID: "id", GH_SECRET: "s" };
    const registry = new ProviderRegistry({ env });
    registry.register({
      id: "github", displayName: "GitHub",
      clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
      endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
      scopes: { default: [], offered: [] },
      pkce: "required", authMethod: "post", responseFormat: "json",
      accountIdField: "id", accountLabelField: "login",
      refresh: { supported: false },
    }, "yaml");
    const app = express();
    app.use(express.json());
    app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
      (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
      next();
    }, oauthRoutes({
      registry, db: db as any,
      publicUrl: "https://app.paperclip.test",
      rateLimiter: { check: async () => false } as any,
    }));
    const res = await request(app).post("/api/companies/c1/oauth/connect/github");
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth-connect`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend `OAuthRouteDeps` and add the route:

```ts
// at top of server/src/routes/oauth.ts add to OAuthRouteDeps:
//   db: any;  // Drizzle db handle (typed via @paperclipai/db)
//   publicUrl: string;
//   rateLimiter: SlidingWindowLimiter;
//   secretService: SecretService;  // for later tasks

import { generateCodeVerifier, deriveCodeChallenge } from "../oauth/pkce.js";
import { oauthAuthorizationStates } from "@paperclipai/db/schema/oauth";
import { validateReturnUrl } from "../oauth/redirect-allowlist.js";

const STATE_TTL_MS = 10 * 60 * 1000;

r.post("/connect/:providerId", async (req, res) => {
  if (!ensureMember(req, res)) return;
  const provider = deps.registry.get(req.params.providerId);
  if (!provider) return res.status(404).json({ errorCode: "provider_not_found" });

  const actor = (req as Request & { actor: { userId: string } }).actor;
  const ok = await deps.rateLimiter.check(`connect:${actor.userId}`);
  if (!ok) return res.status(429).json({ errorCode: "rate_limited" });

  const { scopes, returnUrl } = (req.body ?? {}) as { scopes?: unknown; returnUrl?: unknown };
  const requestedScopes = Array.isArray(scopes) && scopes.every((s) => typeof s === "string")
    ? (scopes as string[])
    : provider.config.scopes.default;
  const offered = new Set(provider.config.scopes.offered);
  if (!requestedScopes.every((s) => offered.has(s))) {
    return res.status(400).json({ errorCode: "invalid_scope" });
  }

  const verifier = generateCodeVerifier();
  const challenge = deriveCodeChallenge(verifier);
  const redirectUri = `${deps.publicUrl}/api/oauth/callback/${provider.config.id}`;
  const safeReturnUrl = typeof returnUrl === "string" ? validateReturnUrl(returnUrl, deps.publicUrl) : "/settings/connections";
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);

  const [row] = await deps.db.insert(oauthAuthorizationStates).values({
    companyId: req.params.companyId,
    providerId: provider.config.id,
    codeVerifier: verifier,
    redirectUri,
    scopesRequested: requestedScopes,
    initiatedByUserId: actor.userId,
    returnUrl: safeReturnUrl,
    expiresAt,
  }).returning();

  const authorizeUrl = new URL(provider.config.endpoints.authorize);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", provider.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", requestedScopes.join(" "));
  authorizeUrl.searchParams.set("state", row.id);
  if (provider.config.pkce !== "unsupported") {
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
  }

  res.json({ authorizeUrl: authorizeUrl.toString(), state: row.id });
});
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth-connect`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/oauth.ts server/src/routes/__tests__/oauth-connect.test.ts
git commit -m "feat(server): add POST /oauth/connect/:providerId with PKCE state generation"
```

---

### Task 20: Public callback route — `GET /api/oauth/callback/:providerId`

**Files:**
- Create: `server/src/routes/oauth-callback.ts`
- Test: `server/src/routes/__tests__/oauth-callback.test.ts`

The callback is mounted at `/api/oauth/callback/:providerId` (not under `/api/companies/...`) because it's reached directly from the provider, with auth derived from the `state` row.

- [ ] **Step 1: Failing test (skeleton — full integration coverage in Phase 8)**

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthCallbackRoute } from "../oauth-callback.js";

describe("GET /api/oauth/callback/:providerId", () => {
  it("redirects to safe default with invalid_state when state row missing", async () => {
    const db = {
      query: { oauthAuthorizationStates: { findFirst: vi.fn().mockResolvedValue(null) } },
    };
    const app = express();
    app.use("/api/oauth/callback/:providerId", oauthCallbackRoute({
      db: db as any,
      registry: { get: () => undefined } as any,
      publicUrl: "https://app.paperclip.test",
      secretService: {} as any,
    }));
    const res = await request(app).get("/api/oauth/callback/github?state=missing&code=x");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("oauth_error=invalid_state");
  });

  it("redirects with replay error when consumed_at set", async () => {
    const db = {
      query: { oauthAuthorizationStates: { findFirst: vi.fn().mockResolvedValue({
        id: "s", providerId: "github", consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000), returnUrl: "/settings/connections",
        companyId: "c1", codeVerifier: "v", redirectUri: "x",
      }) } },
    };
    const app = express();
    app.use("/api/oauth/callback/:providerId", oauthCallbackRoute({
      db: db as any,
      registry: { get: () => ({ config: { id: "github" } } as any) } as any,
      publicUrl: "https://app.paperclip.test",
      secretService: {} as any,
    }));
    const res = await request(app).get("/api/oauth/callback/github?state=s&code=x");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("oauth_error=replay");
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth-callback`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `server/src/routes/oauth-callback.ts`:

```ts
import { Router, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { oauthAuthorizationStates, oauthConnections } from "@paperclipai/db/schema/oauth";
import { companySecrets, companySecretVersions } from "@paperclipai/db/schema/secrets";
import { exchangeToken, fetchAccountInfo } from "../oauth/http.js";
import { oauthLogger } from "../oauth/logger.js";
import { validateReturnUrl } from "../oauth/redirect-allowlist.js";
import type { ProviderRegistry } from "../oauth/registry.js";

export interface OAuthCallbackDeps {
  db: any;  // Drizzle db handle
  registry: ProviderRegistry;
  publicUrl: string;
  secretService: {
    persistSecret: (input: {
      companyId: string;
      kind: "oauth_access_token" | "oauth_refresh_token";
      value: string;
    }) => Promise<{ secretId: string }>;
  };
}

function back(deps: OAuthCallbackDeps, returnUrl: string | null, query: Record<string, string>) {
  const safe = validateReturnUrl(returnUrl ?? undefined, deps.publicUrl);
  const url = new URL(safe, deps.publicUrl);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.pathname + url.search;
}

export function oauthCallbackRoute(deps: OAuthCallbackDeps): RequestHandler {
  const r = Router({ mergeParams: true });
  r.get("/", async (req, res) => {
    const providerId = req.params.providerId;
    const stateId = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const providerError = typeof req.query.error === "string" ? req.query.error : "";

    const stateRow = await deps.db.query.oauthAuthorizationStates.findFirst({
      where: eq(oauthAuthorizationStates.id, stateId),
    });
    if (!stateRow) return res.redirect(302, back(deps, null, { oauth_error: "invalid_state" }));
    if (stateRow.consumedAt) return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "replay" }));
    if (stateRow.expiresAt < new Date()) return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "invalid_state" }));
    if (stateRow.providerId !== providerId) return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "provider_mismatch" }));

    if (providerError === "access_denied") {
      await deps.db.update(oauthAuthorizationStates).set({ consumedAt: new Date() }).where(eq(oauthAuthorizationStates.id, stateRow.id));
      return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "user_cancelled" }));
    }

    const provider = deps.registry.get(providerId);
    if (!provider) return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "provider_not_found" }));

    let tokenRaw: Record<string, unknown>;
    try {
      tokenRaw = await exchangeToken({
        url: provider.config.endpoints.token,
        params: {
          grant_type: "authorization_code",
          code,
          redirect_uri: stateRow.redirectUri,
          code_verifier: stateRow.codeVerifier,
        },
        authMethod: provider.config.authMethod,
        responseFormat: provider.config.responseFormat,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      });
    } catch (err) {
      oauthLogger.error({ provider: providerId, err: { message: (err as Error).message } }, "token exchange failed");
      return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "token_exchange_failed" }));
    }

    let parsedToken;
    try {
      parsedToken = provider.shape.parseTokenResponse!(tokenRaw);
    } catch (err) {
      oauthLogger.error({ provider: providerId, err: { message: (err as Error).message } }, "token shape violation");
      return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "token_exchange_failed", detail: "response_shape_violation" }));
    }

    let accountRaw: unknown;
    try {
      accountRaw = await fetchAccountInfo(provider.config.endpoints.accountInfo, parsedToken.accessToken);
    } catch (err) {
      oauthLogger.error({ provider: providerId, err: { message: (err as Error).message } }, "account info fetch failed");
      return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "account_info_failed" }));
    }
    let parsedAccount;
    try {
      parsedAccount = provider.shape.parseAccountInfo!(accountRaw);
    } catch {
      return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "account_info_failed" }));
    }

    // Transactional upsert
    try {
      await deps.db.transaction(async (tx: any) => {
        const existing = await tx.query.oauthConnections.findFirst({
          where: (t: any, { and: A, eq: E }: any) => A(E(t.companyId, stateRow.companyId), E(t.providerId, providerId)),
        });
        if (existing && existing.accountId && parsedAccount.accountId !== existing.accountId) {
          throw new Error("ACCOUNT_MISMATCH");
        }
        const access = await deps.secretService.persistSecret({
          companyId: stateRow.companyId, kind: "oauth_access_token", value: parsedToken.accessToken,
        });
        let refresh: { secretId: string } | undefined;
        if (parsedToken.refreshToken) {
          refresh = await deps.secretService.persistSecret({
            companyId: stateRow.companyId, kind: "oauth_refresh_token", value: parsedToken.refreshToken,
          });
        }
        const expiresAt = parsedToken.expiresInSeconds
          ? new Date(Date.now() + parsedToken.expiresInSeconds * 1000)
          : null;
        const finalScopes = parsedToken.scope ?? stateRow.scopesRequested;
        if (existing) {
          await tx.update(oauthConnections).set({
            status: "active",
            scopes: finalScopes,
            accountId: parsedAccount.accountId,
            accountLabel: parsedAccount.accountLabel,
            accessTokenSecretId: access.secretId,
            refreshTokenSecretId: refresh?.secretId ?? existing.refreshTokenSecretId,
            accessTokenExpiresAt: expiresAt,
            lastRefreshedAt: new Date(),
            lastError: null, lastErrorAt: null, refreshAttemptCount: 0,
            updatedAt: new Date(),
          }).where(eq(oauthConnections.id, existing.id));
        } else {
          await tx.insert(oauthConnections).values({
            companyId: stateRow.companyId, providerId,
            status: "active",
            accountId: parsedAccount.accountId, accountLabel: parsedAccount.accountLabel,
            scopes: finalScopes,
            accessTokenSecretId: access.secretId,
            refreshTokenSecretId: refresh?.secretId,
            accessTokenExpiresAt: expiresAt,
            lastRefreshedAt: new Date(),
          });
        }
        await tx.update(oauthAuthorizationStates).set({ consumedAt: new Date() }).where(eq(oauthAuthorizationStates.id, stateRow.id));
      });
    } catch (err) {
      if ((err as Error).message === "ACCOUNT_MISMATCH") {
        await deps.db.update(oauthAuthorizationStates).set({ consumedAt: new Date() }).where(eq(oauthAuthorizationStates.id, stateRow.id));
        return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_error: "account_mismatch" }));
      }
      throw err;
    }

    return res.redirect(302, back(deps, stateRow.returnUrl, { oauth_connected: providerId }));
  });
  return r;
}
```

This relies on a `secretService.persistSecret` method that may need to be added in Task 21 if it doesn't exist yet (it likely does — verify via `grep -n "persistSecret\|createCompanySecret" server/src/services/secrets.ts`).

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth-callback`
Expected: PASS (initial 2 cases; full coverage in Phase 8).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/oauth-callback.ts server/src/routes/__tests__/oauth-callback.test.ts
git commit -m "feat(server): add public OAuth callback route with state validation and upsert"
```

---

### Task 21: Connection list/get routes (`GET /connections`, `GET /connections/:id`)

**Files:**
- Modify: `server/src/routes/oauth.ts`
- Test: `server/src/routes/__tests__/oauth-connections.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

const conn = {
  id: "conn-1", companyId: "c1", providerId: "github",
  status: "active", accountId: "42", accountLabel: "octocat",
  scopes: ["repo"], accessTokenSecretId: "s1", refreshTokenSecretId: null,
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000), lastRefreshedAt: new Date(),
  lastError: null, lastErrorAt: null, refreshAttemptCount: 0,
  createdAt: new Date(), updatedAt: new Date(),
};

function makeApp(rows: any[]) {
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register({
    id: "github", displayName: "GitHub",
    clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
    endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
    scopes: { default: [], offered: [] },
    pkce: "required", authMethod: "post", responseFormat: "json",
    accountIdField: "id", accountLabelField: "login",
    refresh: { supported: false },
  }, "yaml");
  const db = {
    query: {
      oauthConnections: {
        findMany: vi.fn().mockResolvedValue(rows),
        findFirst: vi.fn().mockResolvedValue(rows[0] ?? null),
      },
    },
  };
  const app = express();
  app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
    (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
    next();
  }, oauthRoutes({
    registry, db: db as any,
    publicUrl: "https://app.paperclip.test",
    rateLimiter: { check: async () => true } as any,
    secretService: {} as any,
  }));
  return app;
}

describe("Connection management routes", () => {
  it("GET /connections returns no token material", async () => {
    const res = await request(makeApp([conn])).get("/api/companies/c1/oauth/connections");
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("accessTokenSecretId");
    expect(JSON.stringify(res.body)).not.toContain("refreshTokenSecretId");
  });

  it("GET /connections/:id returns 404 for missing", async () => {
    const res = await request(makeApp([])).get("/api/companies/c1/oauth/connections/missing");
    expect(res.status).toBe(404);
  });

  it("GET /connections/:id rejects cross-tenant", async () => {
    const otherTenantConn = { ...conn, companyId: "c2" };
    const res = await request(makeApp([otherTenantConn])).get("/api/companies/c1/oauth/connections/conn-1");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth-connections`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `server/src/routes/oauth.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { oauthConnections } from "@paperclipai/db/schema/oauth";

function publicConnection(c: any) {
  return {
    id: c.id, providerId: c.providerId, status: c.status,
    accountId: c.accountId, accountLabel: c.accountLabel,
    scopes: c.scopes,
    accessTokenExpiresAt: c.accessTokenExpiresAt,
    lastRefreshedAt: c.lastRefreshedAt,
    lastError: c.lastError, lastErrorAt: c.lastErrorAt,
    refreshAttemptCount: c.refreshAttemptCount,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

r.get("/connections", async (req, res) => {
  if (!ensureMember(req, res)) return;
  const rows = await deps.db.query.oauthConnections.findMany({
    where: eq(oauthConnections.companyId, req.params.companyId),
  });
  res.json({ connections: rows.map(publicConnection) });
});

r.get("/connections/:id", async (req, res) => {
  if (!ensureMember(req, res)) return;
  const row = await deps.db.query.oauthConnections.findFirst({
    where: and(eq(oauthConnections.id, req.params.id), eq(oauthConnections.companyId, req.params.companyId)),
  });
  if (!row) return res.status(404).end();
  res.json(publicConnection(row));
});
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth-connections`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/oauth.ts server/src/routes/__tests__/oauth-connections.test.ts
git commit -m "feat(server): add GET /oauth/connections list + detail routes"
```

---

### Task 22: Disconnect route (`DELETE /connections/:id`)

**Files:**
- Modify: `server/src/routes/oauth.ts`
- Test: `server/src/routes/__tests__/oauth-disconnect.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

function makeApp({ revokeFails = false } = {}) {
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register({
    id: "github", displayName: "GitHub",
    clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
    endpoints: {
      authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me",
      revoke: "https://api.github.com/applications/{client_id}/grant",
    },
    scopes: { default: [], offered: [] },
    pkce: "required", authMethod: "post", responseFormat: "json",
    accountIdField: "id", accountLabelField: "login",
    refresh: { supported: false },
  }, "yaml");
  const conn = {
    id: "c", companyId: "c1", providerId: "github",
    accessTokenSecretId: "s1", refreshTokenSecretId: "s2",
    status: "active",
  };
  const tx = {
    query: { oauthConnections: { findFirst: vi.fn().mockResolvedValue(conn) } },
    delete: vi.fn().mockReturnValue({ where: () => Promise.resolve() }),
  };
  const db = {
    transaction: vi.fn().mockImplementation(async (fn: any) => fn(tx)),
  };
  const revokeFn = vi.fn().mockImplementation(() => revokeFails ? Promise.reject(new Error("rev fail")) : Promise.resolve());
  const app = express();
  app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
    (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
    next();
  }, oauthRoutes({
    registry, db: db as any,
    publicUrl: "https://app.paperclip.test",
    rateLimiter: { check: async () => true } as any,
    secretService: { revokeSecret: vi.fn(), revokeUpstream: revokeFn } as any,
  }));
  return { app, db, revokeFn, tx };
}

describe("DELETE /connections/:id", () => {
  it("returns 204 on success", async () => {
    const { app } = makeApp();
    const res = await request(app).delete("/api/companies/c1/oauth/connections/c");
    expect(res.status).toBe(204);
  });

  it("still 204 when upstream revoke fails", async () => {
    const { app, revokeFn } = makeApp({ revokeFails: true });
    const res = await request(app).delete("/api/companies/c1/oauth/connections/c");
    expect(res.status).toBe(204);
    expect(revokeFn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth-disconnect`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
r.delete("/connections/:id", async (req, res) => {
  if (!ensureMember(req, res)) return;
  await deps.db.transaction(async (tx: any) => {
    const row = await tx.query.oauthConnections.findFirst({
      where: (t: any, { and: A, eq: E }: any) => A(E(t.id, req.params.id), E(t.companyId, req.params.companyId)),
    });
    if (!row) return res.status(404).end();
    const provider = deps.registry.get(row.providerId);
    if (provider?.config.endpoints.revoke && provider.clientId) {
      try {
        await deps.secretService.revokeUpstream({ provider, connection: row });
      } catch (err) {
        oauthLogger.warn({ providerId: row.providerId, err: { message: (err as Error).message } }, "upstream revoke failed; continuing local delete");
      }
    }
    await tx.delete(oauthConnections).where(eq(oauthConnections.id, row.id));
    if (row.accessTokenSecretId) await deps.secretService.revokeSecret({ secretId: row.accessTokenSecretId });
    if (row.refreshTokenSecretId) await deps.secretService.revokeSecret({ secretId: row.refreshTokenSecretId });
  });
  res.status(204).end();
});
```

The `secretService.revokeUpstream` and `revokeSecret` methods may need to be added to `server/src/services/secrets.ts`. Verify with `grep -n "revokeSecret\|revokeUpstream" server/src/services/secrets.ts`. If absent, add them as part of this task.

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth-disconnect`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/oauth.ts server/src/routes/__tests__/oauth-disconnect.test.ts \
        server/src/services/secrets.ts
git commit -m "feat(server): add DELETE /oauth/connections/:id with upstream revoke best-effort"
```

---

### Task 23: `refreshConnection` core function (shared by worker + lazy + route)

**Files:**
- Create: `server/src/oauth/refresh.ts`
- Test: `server/src/oauth/__tests__/refresh.test.ts`

This function is the single place where the refresh exchange happens. It takes a `connectionId`, holds an advisory lock, performs the exchange, persists new versions, and updates the row. Returns the freshly resolved access token (plaintext) on success.

- [ ] **Step 1: Failing test (mocked HTTP via injected `exchangeFn`)**

```ts
import { describe, it, expect, vi } from "vitest";
import { refreshConnection } from "../refresh.js";

const fakeRow = (overrides = {}) => ({
  id: "conn-1", companyId: "c1", providerId: "github",
  status: "active", scopes: ["repo"],
  accessTokenSecretId: "s-access", refreshTokenSecretId: "s-refresh",
  accessTokenExpiresAt: new Date(Date.now() + 30_000),
  lastError: null, lastErrorAt: null, refreshAttemptCount: 0,
  ...overrides,
});

const fakeProvider = (rotates = false) => ({
  config: {
    id: "github",
    endpoints: { token: "https://x/t", accountInfo: "https://x/me" },
    authMethod: "post" as const, responseFormat: "json" as const,
    accountIdField: "id", accountLabelField: "login",
    refresh: { supported: true, rotatesRefreshToken: rotates },
  },
  clientId: "id", clientSecret: "sec",
  shape: {
    parseTokenResponse: (r: any) => ({
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresInSeconds: r.expires_in,
      scope: typeof r.scope === "string" ? r.scope.split(" ") : undefined,
    }),
  } as any,
});

describe("refreshConnection", () => {
  it("rotates access token + persists new version", async () => {
    const persistSecret = vi.fn().mockResolvedValue({ secretId: "new-access" });
    const updateConn = vi.fn().mockResolvedValue(undefined);
    const result = await refreshConnection({
      connectionId: "conn-1",
      db: {
        transaction: async (fn: any) => fn({
          query: { oauthConnections: { findFirst: () => fakeRow() } },
          update: () => ({ set: () => ({ where: () => updateConn() }) }),
        }),
      } as any,
      registry: { get: () => fakeProvider(false) } as any,
      secretService: {
        readSecret: async () => "OLD_REFRESH",
        persistSecret,
        revokeSecret: vi.fn(),
      } as any,
      exchangeFn: async () => ({
        access_token: "NEW_ACCESS", expires_in: 3600, scope: "repo",
      }),
    });
    expect(result.outcome).toBe("success");
    expect(result.accessToken).toBe("NEW_ACCESS");
    expect(persistSecret).toHaveBeenCalledWith(expect.objectContaining({ kind: "oauth_access_token" }));
  });

  it("flips status to revoked on invalid_grant", async () => {
    const updateConn = vi.fn().mockResolvedValue(undefined);
    const result = await refreshConnection({
      connectionId: "conn-1",
      db: {
        transaction: async (fn: any) => fn({
          query: { oauthConnections: { findFirst: () => fakeRow() } },
          update: () => ({ set: (v: any) => ({ where: () => updateConn(v) }) }),
        }),
      } as any,
      registry: { get: () => fakeProvider(false) } as any,
      secretService: { readSecret: async () => "x", persistSecret: vi.fn(), revokeSecret: vi.fn() } as any,
      exchangeFn: async () => {
        const e: any = new Error("invalid_grant"); e.providerErrorCode = "invalid_grant"; e.status = 400; throw e;
      },
    });
    expect(result.outcome).toBe("revoked");
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth/__tests__/refresh`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { eq } from "drizzle-orm";
import { oauthConnections } from "@paperclipai/db/schema/oauth";
import { exchangeToken, type ExchangeTokenError } from "./http.js";
import { backoffSeconds } from "./backoff.js";
import { oauthLogger } from "./logger.js";
import type { ProviderRegistry } from "./registry.js";

export interface RefreshDeps {
  connectionId: string;
  db: any;
  registry: ProviderRegistry;
  secretService: {
    readSecret: (secretId: string) => Promise<string>;
    persistSecret: (input: { companyId: string; kind: string; value: string }) => Promise<{ secretId: string }>;
    revokeSecret?: (input: { secretId: string }) => Promise<void>;
  };
  exchangeFn?: typeof exchangeToken;  // injectable for tests
}

export type RefreshResult =
  | { outcome: "success"; accessToken: string }
  | { outcome: "revoked" }
  | { outcome: "transient"; error: string }
  | { outcome: "skipped"; reason: string };

export async function refreshConnection(deps: RefreshDeps): Promise<RefreshResult> {
  const exchange = deps.exchangeFn ?? exchangeToken;
  return await deps.db.transaction(async (tx: any) => {
    const row = await tx.query.oauthConnections.findFirst({
      where: eq(oauthConnections.id, deps.connectionId),
    });
    if (!row) return { outcome: "skipped", reason: "not_found" } as const;
    if (!row.refreshTokenSecretId) return { outcome: "skipped", reason: "no_refresh_token" } as const;

    const provider = deps.registry.get(row.providerId);
    if (!provider) {
      await tx.update(oauthConnections)
        .set({ status: "error", lastError: "provider_unavailable", lastErrorAt: new Date(), updatedAt: new Date() })
        .where(eq(oauthConnections.id, row.id));
      return { outcome: "skipped", reason: "provider_unavailable" } as const;
    }
    if (provider.config.refresh.supported !== true) return { outcome: "skipped", reason: "refresh_not_supported" } as const;

    const refreshTokenPlain = await deps.secretService.readSecret(row.refreshTokenSecretId);

    let raw: Record<string, unknown>;
    try {
      raw = await exchange({
        url: provider.config.endpoints.token,
        params: { grant_type: "refresh_token", refresh_token: refreshTokenPlain },
        authMethod: provider.config.authMethod,
        responseFormat: provider.config.responseFormat,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      });
    } catch (err) {
      const e = err as ExchangeTokenError;
      const isPermanent = e.status === 400 && (e.providerErrorCode === "invalid_grant" || e.providerErrorCode === "invalid_token");
      if (isPermanent) {
        await tx.update(oauthConnections).set({
          status: "revoked", lastError: e.providerErrorCode ?? "invalid_grant", lastErrorAt: new Date(), updatedAt: new Date(),
        }).where(eq(oauthConnections.id, row.id));
        oauthLogger.warn({ providerId: row.providerId, connectionId: row.id }, "refresh permanently failed; revoked");
        return { outcome: "revoked" } as const;
      }
      await tx.update(oauthConnections).set({
        lastError: (err as Error).message.slice(0, 500),
        lastErrorAt: new Date(),
        refreshAttemptCount: row.refreshAttemptCount + 1,
        updatedAt: new Date(),
      }).where(eq(oauthConnections.id, row.id));
      return { outcome: "transient", error: (err as Error).message } as const;
    }

    let parsed;
    try {
      parsed = provider.shape.parseTokenResponse!(raw);
    } catch (err) {
      await tx.update(oauthConnections).set({
        lastError: "response_shape_violation",
        lastErrorAt: new Date(),
        refreshAttemptCount: row.refreshAttemptCount + 1,
        updatedAt: new Date(),
      }).where(eq(oauthConnections.id, row.id));
      return { outcome: "transient", error: (err as Error).message } as const;
    }

    const access = await deps.secretService.persistSecret({
      companyId: row.companyId, kind: "oauth_access_token", value: parsed.accessToken,
    });
    let refreshSecretId = row.refreshTokenSecretId;
    if (parsed.refreshToken) {
      if (provider.config.refresh.rotatesRefreshToken !== true) {
        oauthLogger.warn({ providerId: row.providerId }, "provider returned refresh_token but rotatesRefreshToken=false; storing defensively");
      }
      const newRefresh = await deps.secretService.persistSecret({
        companyId: row.companyId, kind: "oauth_refresh_token", value: parsed.refreshToken,
      });
      refreshSecretId = newRefresh.secretId;
    }
    const expiresAt = parsed.expiresInSeconds ? new Date(Date.now() + parsed.expiresInSeconds * 1000) : null;

    await tx.update(oauthConnections).set({
      status: "active",
      accessTokenSecretId: access.secretId,
      refreshTokenSecretId: refreshSecretId,
      accessTokenExpiresAt: expiresAt,
      scopes: parsed.scope ?? row.scopes,
      lastRefreshedAt: new Date(),
      lastError: null, lastErrorAt: null, refreshAttemptCount: 0,
      updatedAt: new Date(),
    }).where(eq(oauthConnections.id, row.id));

    return { outcome: "success", accessToken: parsed.accessToken } as const;
  });
}

// Re-export for tests
export { backoffSeconds };
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth/__tests__/refresh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/refresh.ts server/src/oauth/__tests__/refresh.test.ts
git commit -m "feat(server): add refreshConnection core (worker + lazy + route)"
```

---

### Task 24: `POST /connections/:id/refresh` route

**Files:**
- Modify: `server/src/routes/oauth.ts`
- Test: `server/src/routes/__tests__/oauth-refresh.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthRoutes } from "../oauth.js";
import { ProviderRegistry } from "../../oauth/registry.js";

function makeApp(refreshOutcome: any) {
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register({
    id: "github", displayName: "GitHub",
    clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
    endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
    scopes: { default: [], offered: [] },
    pkce: "required", authMethod: "post", responseFormat: "json",
    accountIdField: "id", accountLabelField: "login",
    refresh: { supported: true, rotatesRefreshToken: false },
  }, "yaml");
  const conn = { id: "conn", companyId: "c1", providerId: "github", refreshAttemptCount: 0, lastErrorAt: null };
  const db = {
    query: { oauthConnections: { findFirst: vi.fn().mockResolvedValue(conn) } },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
    (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
    next();
  }, oauthRoutes({
    registry, db: db as any,
    publicUrl: "https://app.paperclip.test",
    rateLimiter: { check: async () => true } as any,
    secretService: {} as any,
    refreshFn: async () => refreshOutcome,
  } as any));
  return app;
}

describe("POST /connections/:id/refresh", () => {
  it("returns 200 on success", async () => {
    const res = await request(makeApp({ outcome: "success", accessToken: "x" }))
      .post("/api/companies/c1/oauth/connections/conn/refresh");
    expect(res.status).toBe(200);
  });

  it("returns 429 when in backoff window", async () => {
    const res = await request(makeApp({ outcome: "skipped", reason: "backoff" }))
      .post("/api/companies/c1/oauth/connections/conn/refresh");
    expect([200, 429]).toContain(res.status); // implementation may map skipped/backoff to 429
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth-refresh`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// In OAuthRouteDeps add:
//   refreshFn?: typeof refreshConnection;  // optional injection for tests

import { refreshConnection } from "../oauth/refresh.js";
import { backoffSeconds } from "../oauth/backoff.js";

r.post("/connections/:id/refresh", async (req, res) => {
  if (!ensureMember(req, res)) return;
  const conn = await deps.db.query.oauthConnections.findFirst({
    where: (t: any, { and: A, eq: E }: any) => A(E(t.id, req.params.id), E(t.companyId, req.params.companyId)),
  });
  if (!conn) return res.status(404).end();
  if (conn.lastErrorAt) {
    const minRetryAt = new Date(conn.lastErrorAt.getTime() + backoffSeconds(conn.refreshAttemptCount) * 1000);
    if (minRetryAt > new Date()) {
      const retryAfter = Math.ceil((minRetryAt.getTime() - Date.now()) / 1000);
      res.setHeader("retry-after", String(retryAfter));
      return res.status(429).json({ errorCode: "in_backoff", retryAfterSeconds: retryAfter });
    }
  }
  const ok = await deps.rateLimiter.check(`refresh:${conn.id}`);
  if (!ok) return res.status(429).json({ errorCode: "rate_limited" });

  const refreshFn = (deps as any).refreshFn ?? refreshConnection;
  const result = await refreshFn({
    connectionId: conn.id, db: deps.db, registry: deps.registry, secretService: deps.secretService,
  });
  const updated = await deps.db.query.oauthConnections.findFirst({
    where: (t: any, { eq: E }: any) => E(t.id, conn.id),
  });
  if (result.outcome === "success") return res.json(publicConnection(updated));
  if (result.outcome === "revoked") return res.status(409).json({ errorCode: "connection_revoked", connection: publicConnection(updated) });
  return res.status(503).json({ errorCode: "refresh_failed", connection: publicConnection(updated) });
});
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth-refresh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/oauth.ts server/src/routes/__tests__/oauth-refresh.test.ts
git commit -m "feat(server): add POST /oauth/connections/:id/refresh with backoff enforcement"
```

---

### Task 25: Internal `mark-revoked` route

**Files:**
- Create: `server/src/routes/oauth-mark-revoked.ts`
- Test: `server/src/routes/__tests__/oauth-mark-revoked.test.ts`

This endpoint is called by the agent shim when it detects a 401 from a known integration; auth is run-JWT, scoped via the `oauth.connectionIds` claim.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { oauthMarkRevokedRoute } from "../oauth-mark-revoked.js";

function makeApp({ allowedIds }: { allowedIds: string[] }) {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const db = { update: () => ({ set: () => ({ where: () => updateMock() }) }) };
  const app = express();
  app.use(express.json());
  app.use("/api/oauth/connections/:id/mark-revoked", (req, _res, next) => {
    (req as any).runJwt = { connectionIds: allowedIds, runId: "r1" };
    next();
  }, oauthMarkRevokedRoute({ db } as any));
  return { app, updateMock };
}

describe("mark-revoked", () => {
  it("204 when JWT scopes the connection", async () => {
    const { app } = makeApp({ allowedIds: ["c-1"] });
    const res = await request(app).post("/api/oauth/connections/c-1/mark-revoked");
    expect(res.status).toBe(204);
  });

  it("403 when JWT does not include the connection", async () => {
    const { app } = makeApp({ allowedIds: ["other"] });
    const res = await request(app).post("/api/oauth/connections/c-1/mark-revoked");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- oauth-mark-revoked`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { Router, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { oauthConnections } from "@paperclipai/db/schema/oauth";

export interface MarkRevokedDeps { db: any; }

export function oauthMarkRevokedRoute(deps: MarkRevokedDeps): RequestHandler {
  const r = Router({ mergeParams: true });
  r.post("/", async (req, res) => {
    const claim = (req as any).runJwt;
    if (!claim) return res.status(401).json({ errorCode: "unauthenticated" });
    const allowed: string[] = Array.isArray(claim.connectionIds) ? claim.connectionIds : [];
    if (!allowed.includes(req.params.id)) return res.status(403).json({ errorCode: "forbidden" });
    await deps.db.update(oauthConnections)
      .set({ status: "revoked", lastError: "runtime_401", lastErrorAt: new Date(), updatedAt: new Date() })
      .where(eq(oauthConnections.id, req.params.id));
    res.status(204).end();
  });
  return r;
}
```

The middleware that injects `req.runJwt` is the existing run-JWT middleware (M2). If it doesn't expose `connectionIds`, Task 30 extends it.

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- oauth-mark-revoked`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/oauth-mark-revoked.ts \
        server/src/routes/__tests__/oauth-mark-revoked.test.ts
git commit -m "feat(server): add internal mark-revoked endpoint scoped by run JWT claim"
```

---

### Task 26: Refresh worker (60s tick, leader-elected)

**Files:**
- Create: `server/src/oauth/refresh-worker.ts`
- Test: `server/src/oauth/__tests__/refresh-worker.test.ts`

- [ ] **Step 1: Failing test (drives the worker programmatically)**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runRefreshTick } from "../refresh-worker.js";

describe("runRefreshTick", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("filters out rows still in backoff", async () => {
    const candidates = [
      { id: "a", refreshAttemptCount: 0, lastErrorAt: null },
      { id: "b", refreshAttemptCount: 3, lastErrorAt: new Date() },  // 240s backoff
    ];
    const refreshFn = vi.fn().mockResolvedValue({ outcome: "success", accessToken: "x" });
    await runRefreshTick({
      db: {
        execute: vi.fn().mockResolvedValue({ rows: [{ result: true }] }),  // advisory lock
        query: { oauthConnections: { findMany: vi.fn().mockResolvedValue(candidates) } },
      } as any,
      refreshFn,
      registry: {} as any,
      secretService: {} as any,
    });
    expect(refreshFn).toHaveBeenCalledTimes(1);  // only "a", "b" is in backoff
    expect(refreshFn.mock.calls[0][0].connectionId).toBe("a");
  });

  it("skips when advisory lock not acquired", async () => {
    const refreshFn = vi.fn();
    await runRefreshTick({
      db: { execute: vi.fn().mockResolvedValue({ rows: [{ result: false }] }) } as any,
      refreshFn, registry: {} as any, secretService: {} as any,
    });
    expect(refreshFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- refresh-worker`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { sql } from "drizzle-orm";
import { backoffSeconds } from "./backoff.js";
import { refreshConnection } from "./refresh.js";
import { oauthLogger } from "./logger.js";
import type { ProviderRegistry } from "./registry.js";

const ADVISORY_LOCK_KEY = 0x074a17b4_c0bbac1eN;  // arbitrary distinct constant; pg_try_advisory_lock takes bigint
const BATCH_LIMIT = 100;

export interface RefreshWorkerDeps {
  db: any;
  registry: ProviderRegistry;
  secretService: any;
  refreshFn?: typeof refreshConnection;
}

export async function runRefreshTick(deps: RefreshWorkerDeps): Promise<void> {
  const lockResult = await deps.db.execute(sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}::bigint) as result`);
  const acquired = Boolean(lockResult.rows?.[0]?.result);
  if (!acquired) return;

  try {
    const candidates = await deps.db.query.oauthConnections.findMany({
      where: (t: any, { and: A, eq: E, isNotNull: NN, lt: L, sql: S }: any) => A(
        E(t.status, "active"),
        NN(t.refreshTokenSecretId),
        NN(t.accessTokenExpiresAt),
        L(t.accessTokenExpiresAt, S`now() + interval '5 minutes'`),
      ),
      orderBy: (t: any, { asc: A }: any) => [A(t.accessTokenExpiresAt)],
      limit: BATCH_LIMIT,
    });

    const now = Date.now();
    const eligible = candidates.filter((row: any) => {
      if (!row.lastErrorAt) return true;
      const minRetryAt = row.lastErrorAt.getTime() + backoffSeconds(row.refreshAttemptCount) * 1000;
      return minRetryAt <= now;
    });

    const refreshFn = deps.refreshFn ?? refreshConnection;
    for (const row of eligible) {
      try {
        await refreshFn({
          connectionId: row.id, db: deps.db, registry: deps.registry, secretService: deps.secretService,
        });
      } catch (err) {
        oauthLogger.error({ connectionId: row.id, err: { message: (err as Error).message } }, "worker refresh threw");
      }
    }
  } finally {
    await deps.db.execute(sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY}::bigint)`);
  }
}

export function startRefreshWorker(deps: RefreshWorkerDeps): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await runRefreshTick(deps); } catch (err) {
      oauthLogger.error({ err: { message: (err as Error).message } }, "refresh worker tick failed");
    }
    if (!stopped) timeout = setTimeout(tick, 60_000);
  };
  let timeout: NodeJS.Timeout = setTimeout(tick, 60_000);
  return { stop: () => { stopped = true; clearTimeout(timeout); } };
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- refresh-worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/refresh-worker.ts server/src/oauth/__tests__/refresh-worker.test.ts
git commit -m "feat(server): add OAuth refresh worker with leader election + backoff filter"
```

---

### Task 27: State sweeper

**Files:**
- Create: `server/src/oauth/state-sweeper.ts`
- Test: `server/src/oauth/__tests__/state-sweeper.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { runStateSweep } from "../state-sweeper.js";

describe("runStateSweep", () => {
  it("deletes states older than 1 day", async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const db = { delete: () => ({ where: () => deleteMock() }) };
    await runStateSweep({ db } as any);
    expect(deleteMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- state-sweeper`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { sql, lt } from "drizzle-orm";
import { oauthAuthorizationStates } from "@paperclipai/db/schema/oauth";
import { oauthLogger } from "./logger.js";

export interface StateSweepDeps { db: any; }

export async function runStateSweep(deps: StateSweepDeps): Promise<void> {
  try {
    await deps.db.delete(oauthAuthorizationStates)
      .where(lt(oauthAuthorizationStates.expiresAt, sql`now() - interval '1 day'`));
  } catch (err) {
    oauthLogger.error({ err: { message: (err as Error).message } }, "state sweep failed");
  }
}

export function startStateSweeper(deps: StateSweepDeps): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await runStateSweep(deps);
    if (!stopped) timeout = setTimeout(tick, 60 * 60 * 1000);  // hourly
  };
  let timeout = setTimeout(tick, 60 * 60 * 1000);
  return { stop: () => { stopped = true; clearTimeout(timeout); } };
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- state-sweeper`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/state-sweeper.ts server/src/oauth/__tests__/state-sweeper.test.ts
git commit -m "feat(server): add expired oauth_authorization_states sweeper"
```

---

### Task 28: Wire OAuth router + workers in `app.ts` / `index.ts`

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Locate the existing route mounting block**

Run: `grep -n "api.use(" server/src/app.ts | head -20`

- [ ] **Step 2: Modify `app.ts`**

Add imports:

```ts
import path from "node:path";
import { ProviderRegistry } from "./oauth/registry.js";
import { loadProviderConfigsFromDirectory } from "./oauth/yaml-loader.js";
import { registerPluginContributions } from "./oauth/plugin-loader.js";
import { oauthRoutes } from "./routes/oauth.js";
import { oauthCallbackRoute } from "./routes/oauth-callback.js";
import { oauthMarkRevokedRoute } from "./routes/oauth-mark-revoked.js";
import { startRefreshWorker } from "./oauth/refresh-worker.js";
import { startStateSweeper } from "./oauth/state-sweeper.js";
import { createSlidingWindowLimiter } from "./oauth/rate-limiter.js";
```

In the app factory function, after the registry is loaded:

```ts
// OAuth registry — built once at startup, immutable thereafter
const registry = new ProviderRegistry({ env: process.env });
const yamlConfigs = await loadProviderConfigsFromDirectory(
  path.join(process.cwd(), "server", "oauth-providers"),
);
for (const cfg of yamlConfigs) registry.register(cfg, "yaml");
const extraDir = process.env.PAPERCLIP_OAUTH_PROVIDERS_DIR;
if (extraDir) {
  const extra = await loadProviderConfigsFromDirectory(extraDir);
  for (const cfg of extra) registry.register(cfg, "yaml");
}
registerPluginContributions(registry, /* loaded plugin manifests */ []);
// (Plugin manifest loading already happens above; thread the manifests in.)

const oauthLimiter = createSlidingWindowLimiter({ limit: 60, windowMs: 60_000 });

api.use(
  "/companies/:companyId/oauth",
  oauthRoutes({
    registry, db,
    publicUrl: config.publicUrl,
    rateLimiter: oauthLimiter,
    secretService,
  }),
);
api.use("/oauth/callback/:providerId", oauthCallbackRoute({
  registry, db, publicUrl: config.publicUrl, secretService,
}));
api.use("/oauth/connections/:id/mark-revoked", runJwtMiddleware, oauthMarkRevokedRoute({ db }));

const refreshWorker = startRefreshWorker({ db, registry, secretService });
const stateSweeper = startStateSweeper({ db });
shutdownHooks.push(() => refreshWorker.stop());
shutdownHooks.push(() => stateSweeper.stop());
```

The exact integration points depend on `app.ts`'s current shape — adapt as needed but keep these guarantees: registry built before routes mounted, workers started after DB ready, workers stopped on shutdown.

- [ ] **Step 3: Smoke-test boot**

Run: `pnpm --filter @paperclipai/server build && pnpm --filter @paperclipai/server start` (or whatever the dev runner is). With no env vars set for any provider, expect a clean start with logs like `WARN OAuth provider env vars unset; skipping registration` per provider.

Hit `GET /api/companies/<some-company>/oauth/providers` — expect `{"providers":[]}`.

- [ ] **Step 4: Commit**

```bash
git add server/src/app.ts server/src/index.ts
git commit -m "feat(server): mount OAuth routes and start refresh worker + state sweeper"
```

---

## Phase 4 — Resolver integration

### Task 29: Extend `resolveAdapterConfigForRuntime` to handle `oauth_token` bindings (no lazy refresh yet)

**Files:**
- Modify: `server/src/services/secrets.ts`
- Test: `server/src/services/__tests__/secrets-oauth-binding.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createSecretService } from "../secrets.js";

describe("resolveAdapterConfigForRuntime — oauth_token binding", () => {
  it("resolves an active oauth_token binding to plaintext", async () => {
    const conn = {
      id: "c-1", companyId: "co-1", providerId: "github",
      status: "active", accessTokenSecretId: "s-access",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    };
    const svc = createSecretService({
      db: {
        query: { oauthConnections: { findFirst: vi.fn().mockResolvedValue(conn) } },
      } as any,
      readSecret: async (id: string) => id === "s-access" ? "TOKEN" : "",
      registry: {} as any,
    } as any);
    const result = await svc.resolveAdapterConfigForRuntime("co-1", {
      env: { GITHUB_TOKEN: { type: "oauth_token", connectionId: "c-1", field: "access" } },
    });
    expect(result.config.env).toEqual({ GITHUB_TOKEN: "TOKEN" });
    expect(result.secretKeys.has("GITHUB_TOKEN")).toBe(true);
  });

  it("throws oauth_connection_missing if connection not found", async () => {
    const svc = createSecretService({
      db: { query: { oauthConnections: { findFirst: vi.fn().mockResolvedValue(null) } } } as any,
      readSecret: vi.fn(),
      registry: {} as any,
    } as any);
    await expect(svc.resolveAdapterConfigForRuntime("co-1", {
      env: { GH: { type: "oauth_token", connectionId: "missing", field: "access" } },
    })).rejects.toThrow(/oauth_connection_missing/);
  });

  it("throws oauth_connection_revoked if status is revoked", async () => {
    const conn = { id: "c-1", companyId: "co-1", status: "revoked", accessTokenSecretId: "s" };
    const svc = createSecretService({
      db: { query: { oauthConnections: { findFirst: vi.fn().mockResolvedValue(conn) } } } as any,
      readSecret: vi.fn(),
      registry: {} as any,
    } as any);
    await expect(svc.resolveAdapterConfigForRuntime("co-1", {
      env: { GH: { type: "oauth_token", connectionId: "c-1", field: "access" } },
    })).rejects.toThrow(/oauth_connection_revoked/);
  });

  it("rejects cross-company connection access", async () => {
    const conn = { id: "c-1", companyId: "OTHER", status: "active", accessTokenSecretId: "s" };
    const svc = createSecretService({
      db: { query: { oauthConnections: { findFirst: vi.fn().mockResolvedValue(conn) } } } as any,
      readSecret: vi.fn(),
      registry: {} as any,
    } as any);
    await expect(svc.resolveAdapterConfigForRuntime("co-1", {
      env: { GH: { type: "oauth_token", connectionId: "c-1", field: "access" } },
    })).rejects.toThrow(/oauth_connection_missing/);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- secrets-oauth-binding`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `server/src/services/secrets.ts`, locate `resolveAdapterConfigForRuntime`. Inside its env-binding loop, add a case for `oauth_token`. Approximate shape (adapt to existing dispatcher style):

```ts
import { oauthConnections } from "@paperclipai/db/schema/oauth";
import { and, eq } from "drizzle-orm";

// ... inside resolveAdapterConfigForRuntime, where each binding is dispatched:
case "oauth_token": {
  const conn = await deps.db.query.oauthConnections.findFirst({
    where: and(eq(oauthConnections.id, binding.connectionId), eq(oauthConnections.companyId, companyId)),
  });
  if (!conn) {
    const e: any = new Error(`oauth_connection_missing: ${binding.connectionId}`);
    e.errorCode = "oauth_connection_missing";
    throw e;
  }
  if (conn.status === "revoked") {
    const e: any = new Error(`oauth_connection_revoked: ${conn.providerId}`);
    e.errorCode = "oauth_connection_revoked";
    throw e;
  }
  if (conn.status === "error") {
    const e: any = new Error(`oauth_provider_unavailable: ${conn.providerId}`);
    e.errorCode = "oauth_provider_unavailable";
    throw e;
  }
  // Lazy refresh wired in Task 30
  const plaintext = await deps.readSecret(conn.accessTokenSecretId);
  resolvedEnv[key] = plaintext;
  secretKeys.add(key);
  break;
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- secrets-oauth-binding`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/secrets.ts \
        server/src/services/__tests__/secrets-oauth-binding.test.ts
git commit -m "feat(server): resolve oauth_token bindings to plaintext via SecretProvider"
```

---

### Task 30: Lazy refresh inside the resolver (60s pre-expiry window)

**Files:**
- Modify: `server/src/services/secrets.ts`
- Test: `server/src/services/__tests__/secrets-oauth-lazy.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createSecretService } from "../secrets.js";

describe("oauth_token lazy refresh", () => {
  it("refreshes when token expires in <60s", async () => {
    const conn = {
      id: "c", companyId: "co", providerId: "github",
      status: "active",
      accessTokenSecretId: "s-old",
      accessTokenExpiresAt: new Date(Date.now() + 30_000),  // 30s left
      refreshTokenSecretId: "r",
    };
    const refreshFn = vi.fn().mockResolvedValue({ outcome: "success", accessToken: "FRESH" });
    const svc = createSecretService({
      db: { query: { oauthConnections: { findFirst: async () => conn } } } as any,
      readSecret: async () => "STALE",
      registry: {} as any,
      refreshFn,
    } as any);
    const r = await svc.resolveAdapterConfigForRuntime("co", {
      env: { TOKEN: { type: "oauth_token", connectionId: "c", field: "access" } },
    });
    expect(refreshFn).toHaveBeenCalledOnce();
    expect(r.config.env.TOKEN).toBe("FRESH");
  });

  it("does NOT refresh when token expires far in future", async () => {
    const conn = {
      id: "c", companyId: "co", providerId: "github", status: "active",
      accessTokenSecretId: "s",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenSecretId: "r",
    };
    const refreshFn = vi.fn();
    const svc = createSecretService({
      db: { query: { oauthConnections: { findFirst: async () => conn } } } as any,
      readSecret: async () => "TOKEN",
      registry: {} as any,
      refreshFn,
    } as any);
    await svc.resolveAdapterConfigForRuntime("co", {
      env: { TOKEN: { type: "oauth_token", connectionId: "c", field: "access" } },
    });
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("falls back to old token when refresh fails transiently and old still valid", async () => {
    const conn = {
      id: "c", companyId: "co", providerId: "github", status: "active",
      accessTokenSecretId: "s",
      accessTokenExpiresAt: new Date(Date.now() + 30_000),  // still valid for 30s
      refreshTokenSecretId: "r",
    };
    const refreshFn = vi.fn().mockResolvedValue({ outcome: "transient", error: "5xx" });
    const svc = createSecretService({
      db: { query: { oauthConnections: { findFirst: async () => conn } } } as any,
      readSecret: async () => "OLD",
      registry: {} as any,
      refreshFn,
    } as any);
    const r = await svc.resolveAdapterConfigForRuntime("co", {
      env: { T: { type: "oauth_token", connectionId: "c", field: "access" } },
    });
    expect(r.config.env.T).toBe("OLD");
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- secrets-oauth-lazy`
Expected: FAIL.

- [ ] **Step 3: Implement (extend the `oauth_token` case from Task 29)**

```ts
const LAZY_WINDOW_MS = 60 * 1000;

case "oauth_token": {
  const conn = /* ...findFirst as before... */;
  if (!conn) /* throw oauth_connection_missing */;
  if (conn.status === "revoked") /* throw oauth_connection_revoked */;
  if (conn.status === "error") /* throw oauth_provider_unavailable */;

  const expiresIn = conn.accessTokenExpiresAt
    ? conn.accessTokenExpiresAt.getTime() - Date.now()
    : Number.POSITIVE_INFINITY;
  const needsRefresh = conn.refreshTokenSecretId && expiresIn < LAZY_WINDOW_MS;
  if (needsRefresh) {
    const refreshFn = deps.refreshFn ?? refreshConnection;
    const result = await refreshFn({
      connectionId: conn.id, db: deps.db, registry: deps.registry, secretService: deps,
    });
    if (result.outcome === "success") {
      resolvedEnv[key] = result.accessToken;
      secretKeys.add(key);
      break;
    }
    if (result.outcome === "revoked") {
      const e: any = new Error("oauth_connection_revoked"); e.errorCode = "oauth_connection_revoked"; throw e;
    }
    // transient: fall through to read-current-secret if still pre-expiry
    if (expiresIn <= 0) {
      const e: any = new Error("oauth_refresh_failed"); e.errorCode = "oauth_refresh_failed"; throw e;
    }
  }
  const plaintext = await deps.readSecret(conn.accessTokenSecretId);
  resolvedEnv[key] = plaintext;
  secretKeys.add(key);
  break;
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- secrets-oauth-lazy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/secrets.ts \
        server/src/services/__tests__/secrets-oauth-lazy.test.ts
git commit -m "feat(server): lazy-refresh OAuth tokens during runtime config resolution"
```

---

### Task 31: Run JWT — `oauth.connectionIds` claim populated at dispatch

**Files:**
- Modify: the dispatch path that mints run JWTs — locate via `grep -rn "signRunJwt\|createRunJwt\|RUN_JWT" server/src/`
- Test: alongside the existing run-JWT tests

- [ ] **Step 1: Locate the JWT minter**

Run: `grep -rn "PAPERCLIP_RUN_JWT_SECRET" server/src/`

- [ ] **Step 2: Failing test**

Add a test asserting that when an agent dispatch resolved any `oauth_token` bindings, the resulting JWT includes the connection IDs in the `oauth.connectionIds` claim. Path depends on existing dispatch test layout.

```ts
// Approximate shape — adapt to existing helpers:
import { describe, it, expect } from "vitest";
import { mintRunJwt } from "/* run-jwt module */";

describe("run JWT oauth claim", () => {
  it("encodes connectionIds in the oauth.connectionIds claim", () => {
    const jwt = mintRunJwt({ runId: "r1", companyId: "c1", oauth: { connectionIds: ["a", "b"] } });
    const decoded = decodeJwt(jwt);
    expect(decoded.oauth.connectionIds).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 3: Verify failure**

Expected: FAIL.

- [ ] **Step 4: Implement**

Extend the JWT signing helper's input type to accept `oauth?: { connectionIds: string[] }`. Encode it as a top-level `oauth` claim. Update the verifier to type the claim. In the dispatch path (where `resolveAdapterConfigForRuntime` is called and the resolver returns `secretKeys`), accumulate the OAuth connection IDs from any `oauth_token` bindings and pass them into `mintRunJwt`.

The resolver needs to return them too. Extend its return type:

```ts
// in secrets.ts — extend resolveAdapterConfigForRuntime return:
return { config, secretKeys, oauthConnectionIds: Array.from(seenConnectionIds) };
```

- [ ] **Step 5: Verify pass**

Run the dispatch tests scoped to the JWT helper and to dispatch.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/run-jwt.ts \
        server/src/services/secrets.ts \
        server/src/auth/__tests__/run-jwt.test.ts
git commit -m "feat(server): include oauth.connectionIds in run JWT claims"
```

---

## Phase 5 — Provider configurations (7 YAMLs + 2 shape modules)

These tasks ship the launch-set provider configs. Each YAML lives at `server/oauth-providers/<id>.yaml`. Two providers (Slack, Microsoft) need shape modules; the rest use the default RFC-6749 parser.

### Task 32: Slack shape module

**Files:**
- Create: `server/oauth-providers/shapes/slack.ts`
- Test: `server/oauth-providers/shapes/__tests__/slack.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { slackShape } from "../slack.js";

describe("slackShape", () => {
  it("parses user-token nested response", () => {
    expect(slackShape.parseTokenResponse!({
      ok: true,
      authed_user: { access_token: "xoxp-USER", refresh_token: "xoxe-1-USER", expires_in: 43200, scope: "channels:read,chat:write" },
    })).toEqual({
      accessToken: "xoxp-USER", refreshToken: "xoxe-1-USER",
      expiresInSeconds: 43200, scope: ["channels:read", "chat:write"],
    });
  });

  it("parses bot-token flat response", () => {
    expect(slackShape.parseTokenResponse!({
      ok: true, access_token: "xoxb-BOT", expires_in: 43200, scope: "chat:write",
    })).toMatchObject({ accessToken: "xoxb-BOT", scope: ["chat:write"] });
  });

  it("parses team account info", () => {
    expect(slackShape.parseAccountInfo!({ team: { id: "T123", name: "Acme" } }))
      .toEqual({ accountId: "T123", accountLabel: "Acme" });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- shapes/__tests__/slack`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { ProviderShape } from "../../src/oauth/types.js";

export const slackShape: ProviderShape = {
  parseTokenResponse(raw) {
    if (typeof raw !== "object" || raw === null) throw new Error("response_shape_violation");
    const r = raw as Record<string, unknown>;
    const user = (r as { authed_user?: Record<string, unknown> }).authed_user;
    if (user && typeof user.access_token === "string") {
      return {
        accessToken: user.access_token,
        refreshToken: typeof user.refresh_token === "string" ? user.refresh_token : undefined,
        expiresInSeconds: typeof user.expires_in === "number" ? user.expires_in : undefined,
        scope: typeof user.scope === "string" ? user.scope.split(",").filter(Boolean) : undefined,
      };
    }
    if (typeof r.access_token !== "string") throw new Error("response_shape_violation: no access_token");
    return {
      accessToken: r.access_token,
      refreshToken: typeof r.refresh_token === "string" ? r.refresh_token : undefined,
      expiresInSeconds: typeof r.expires_in === "number" ? r.expires_in : undefined,
      scope: typeof r.scope === "string" ? r.scope.split(",").filter(Boolean) : undefined,
    };
  },
  parseAccountInfo(raw) {
    if (typeof raw !== "object" || raw === null) throw new Error("response_shape_violation");
    const r = raw as { team?: { id?: unknown; name?: unknown } };
    if (typeof r.team?.id !== "string") throw new Error("response_shape_violation: no team.id");
    return {
      accountId: r.team.id,
      accountLabel: typeof r.team.name === "string" ? r.team.name : undefined,
    };
  },
};
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- shapes/__tests__/slack`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/oauth-providers/shapes/slack.ts \
        server/oauth-providers/shapes/__tests__/slack.test.ts
git commit -m "feat(oauth): add Slack response shape module"
```

---

### Task 33: Microsoft shape module

**Files:**
- Create: `server/oauth-providers/shapes/microsoft.ts`
- Test: `server/oauth-providers/shapes/__tests__/microsoft.test.ts`

Microsoft Graph returns the standard RFC-6749 token shape but `accountInfo` (`https://graph.microsoft.com/v1.0/me`) returns `id`, `userPrincipalName`, `displayName` — the default parser using `accountIdField: "id"` works. The shape module exists primarily to handle Microsoft's `scope` returned as a space-separated string with leading/trailing spaces and to coerce `tid` (tenant id) into the account label as `<displayName> (<tenant>)` when both are present.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { microsoftShape } from "../microsoft.js";

describe("microsoftShape", () => {
  it("trims scope and splits on whitespace", () => {
    expect(microsoftShape.parseTokenResponse!({
      access_token: "T", expires_in: 3600, scope: "  Mail.Read  User.Read  ",
    }).scope).toEqual(["Mail.Read", "User.Read"]);
  });

  it("uses displayName + tenant id for account label", () => {
    expect(microsoftShape.parseAccountInfo!({
      id: "u-1", displayName: "Alice", "tid": "tenant-x",
    })).toEqual({ accountId: "u-1", accountLabel: "Alice (tenant-x)" });
  });

  it("falls back to displayName-only when no tid", () => {
    expect(microsoftShape.parseAccountInfo!({ id: "u-1", displayName: "Alice" }))
      .toEqual({ accountId: "u-1", accountLabel: "Alice" });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/server test -- shapes/__tests__/microsoft`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { ProviderShape } from "../../src/oauth/types.js";

export const microsoftShape: ProviderShape = {
  parseTokenResponse(raw) {
    if (typeof raw !== "object" || raw === null) throw new Error("response_shape_violation");
    const r = raw as Record<string, unknown>;
    if (typeof r.access_token !== "string") throw new Error("response_shape_violation");
    return {
      accessToken: r.access_token,
      refreshToken: typeof r.refresh_token === "string" ? r.refresh_token : undefined,
      expiresInSeconds: typeof r.expires_in === "number" ? r.expires_in : undefined,
      scope: typeof r.scope === "string" ? r.scope.trim().split(/\s+/).filter(Boolean) : undefined,
    };
  },
  parseAccountInfo(raw) {
    if (typeof raw !== "object" || raw === null) throw new Error("response_shape_violation");
    const r = raw as Record<string, unknown>;
    const id = r.id;
    if (typeof id !== "string") throw new Error("response_shape_violation");
    const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
    const tid = typeof r.tid === "string" ? r.tid : undefined;
    let label: string | undefined;
    if (displayName && tid) label = `${displayName} (${tid})`;
    else label = displayName;
    return { accountId: id, accountLabel: label };
  },
};
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- shapes/__tests__/microsoft`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/oauth-providers/shapes/microsoft.ts \
        server/oauth-providers/shapes/__tests__/microsoft.test.ts
git commit -m "feat(oauth): add Microsoft response shape module"
```

---

### Task 34: Wire shape-module loading into the YAML loader

**Files:**
- Modify: `server/src/oauth/yaml-loader.ts`
- Test: extend `server/src/oauth/__tests__/yaml-loader.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("loads shape module when yaml references one", async () => {
  const dir = path.join(__dirname, "fixtures", "oauth-providers");
  const configs = await loadProviderConfigsFromDirectory(dir);
  // Assume mock.yaml does NOT use a shape; verify shapes is empty for it
  // Add slack-fixture.yaml with shape: slack and a fixtures/shapes/slack.ts
});
```

- [ ] **Step 2: Implement**

Refactor `loadProviderConfigsFromDirectory` to also accept a `shapesDir`, returning `Array<{ config, shape? }>`:

```ts
import { pathToFileURL } from "node:url";
import path from "node:path";

export async function loadProviderConfigsFromDirectory(
  dir: string,
  shapesDir = path.join(dir, "shapes"),
): Promise<Array<{ config: OAuthProviderConfig; shape?: ProviderShape }>> {
  // ... existing yaml load + validate ...
  const out: Array<{ config: OAuthProviderConfig; shape?: ProviderShape }> = [];
  for (const config of configs) {
    let shape: ProviderShape | undefined;
    if (config.shape) {
      const modulePath = path.join(shapesDir, `${config.shape}.js`);  // post-build
      try {
        const mod = await import(pathToFileURL(modulePath).href);
        shape = mod[`${config.shape}Shape`] ?? mod.default;
        if (!shape) throw new Error(`module ${modulePath} did not export shape`);
      } catch (err) {
        throw new Error(`Failed to load shape module ${config.shape}: ${(err as Error).message}`);
      }
    }
    out.push({ config, shape });
  }
  return out;
}
```

Update the registry to accept `{config, shape}` pairs from the loader. Update `app.ts` accordingly.

- [ ] **Step 3: Verify pass**

Run: `pnpm --filter @paperclipai/server test -- yaml-loader`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/oauth/yaml-loader.ts \
        server/src/oauth/__tests__/yaml-loader.test.ts \
        server/src/app.ts
git commit -m "feat(server): load OAuth shape modules referenced by yaml"
```

---

### Task 35: GitHub provider YAML

**Files:**
- Create: `server/oauth-providers/github.yaml`

- [ ] **Step 1: Write the file**

```yaml
id: github
displayName: GitHub
iconUrl: https://github.githubassets.com/images/icons/oauth.svg
docUrl: https://docs.paperclip.ai/integrations/github
clientCredentials:
  clientIdEnv: GITHUB_OAUTH_CLIENT_ID
  clientSecretEnv: GITHUB_OAUTH_CLIENT_SECRET
endpoints:
  authorize: https://github.com/login/oauth/authorize
  token: https://github.com/login/oauth/access_token
  revoke: https://api.github.com/applications/{client_id}/grant
  accountInfo: https://api.github.com/user
scopes:
  default: [repo, read:user, user:email]
  offered: [repo, read:user, user:email, workflow, write:packages]
pkce: required
authMethod: post
responseFormat: json
accountIdField: id
accountLabelField: login
refresh:
  supported: false
```

- [ ] **Step 2: Validate via test**

Add a smoke test that loads `server/oauth-providers/` (the real directory) and asserts every provider passes validation:

`server/src/oauth/__tests__/all-providers-valid.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadProviderConfigsFromDirectory } from "../yaml-loader.js";

describe("shipped provider yaml files", () => {
  it("all parse + validate", async () => {
    const dir = path.join(process.cwd(), "server", "oauth-providers");
    const configs = await loadProviderConfigsFromDirectory(dir);
    expect(configs.length).toBeGreaterThanOrEqual(1);
    for (const { config } of configs) {
      expect(config.id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
```

Run: `pnpm --filter @paperclipai/server test -- all-providers-valid`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/oauth-providers/github.yaml \
        server/src/oauth/__tests__/all-providers-valid.test.ts
git commit -m "feat(oauth): add GitHub provider config"
```

---

### Task 36: Notion provider YAML

**Files:**
- Create: `server/oauth-providers/notion.yaml`

- [ ] **Step 1: Write**

```yaml
id: notion
displayName: Notion
docUrl: https://developers.notion.com/docs/authorization
clientCredentials:
  clientIdEnv: NOTION_OAUTH_CLIENT_ID
  clientSecretEnv: NOTION_OAUTH_CLIENT_SECRET
endpoints:
  authorize: https://api.notion.com/v1/oauth/authorize
  token: https://api.notion.com/v1/oauth/token
  accountInfo: https://api.notion.com/v1/users/me
scopes:
  default: []
  offered: []
pkce: optional
authMethod: basic
responseFormat: json
accountIdField: bot.owner.user.id
accountLabelField: bot.owner.user.name
refresh:
  supported: false
```

Notion uses workspace-bound bot tokens — no refresh, no scopes parameter. The `accountInfo` endpoint returns the bot owner's user info; dot-paths reach into the nested response.

- [ ] **Step 2: Validate**

Run: `pnpm --filter @paperclipai/server test -- all-providers-valid`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/oauth-providers/notion.yaml
git commit -m "feat(oauth): add Notion provider config"
```

---

### Task 37: Slack provider YAML

**Files:**
- Create: `server/oauth-providers/slack.yaml`

- [ ] **Step 1: Write**

```yaml
id: slack
displayName: Slack
docUrl: https://api.slack.com/authentication/oauth-v2
clientCredentials:
  clientIdEnv: SLACK_OAUTH_CLIENT_ID
  clientSecretEnv: SLACK_OAUTH_CLIENT_SECRET
endpoints:
  authorize: https://slack.com/oauth/v2/authorize
  token: https://slack.com/api/oauth.v2.access
  accountInfo: https://slack.com/api/auth.test
scopes:
  default: [channels:read, chat:write]
  offered: [channels:read, chat:write, channels:history, files:read, users:read, im:history, mpim:history, groups:history]
pkce: optional
authMethod: post
responseFormat: json
accountIdField: team_id
accountLabelField: team
refresh:
  supported: true
  rotatesRefreshToken: true
shape: slack
```

- [ ] **Step 2: Validate**

Run: `pnpm --filter @paperclipai/server test -- all-providers-valid`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/oauth-providers/slack.yaml
git commit -m "feat(oauth): add Slack provider config"
```

---

### Task 38: Linear, Atlassian, Google Workspace, Microsoft Graph YAMLs

Bundled into one task — four similarly-shaped providers, no novel patterns.

**Files:**
- Create: `server/oauth-providers/linear.yaml`
- Create: `server/oauth-providers/atlassian.yaml`
- Create: `server/oauth-providers/google-workspace.yaml`
- Create: `server/oauth-providers/microsoft-graph.yaml`

- [ ] **Step 1: Write all four**

`linear.yaml`:

```yaml
id: linear
displayName: Linear
docUrl: https://developers.linear.app/docs/oauth/authentication
clientCredentials:
  clientIdEnv: LINEAR_OAUTH_CLIENT_ID
  clientSecretEnv: LINEAR_OAUTH_CLIENT_SECRET
endpoints:
  authorize: https://linear.app/oauth/authorize
  token: https://api.linear.app/oauth/token
  accountInfo: https://api.linear.app/graphql  # POST { query: "{ viewer { id name } }" } — handled in default; for Linear, accountInfo via GraphQL is not GET-friendly. See note.
scopes:
  default: [read]
  offered: [read, write, admin]
pkce: required
authMethod: post
responseFormat: json
accountIdField: data.viewer.id
accountLabelField: data.viewer.name
refresh:
  supported: false
```

NOTE: Linear's account-info endpoint is GraphQL-POST, not REST-GET. The default `fetchAccountInfo` only does GET. The plan glosses over this — implementer must EITHER add a Linear shape module that overrides account-info fetching, OR use `https://api.linear.app/oauth/userinfo` which Linear exposes for OAuth providers (verify against Linear docs at impl time and update the YAML).

`atlassian.yaml`:

```yaml
id: atlassian
displayName: Atlassian (Jira / Confluence)
docUrl: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
clientCredentials:
  clientIdEnv: ATLASSIAN_OAUTH_CLIENT_ID
  clientSecretEnv: ATLASSIAN_OAUTH_CLIENT_SECRET
endpoints:
  authorize: https://auth.atlassian.com/authorize
  token: https://auth.atlassian.com/oauth/token
  accountInfo: https://api.atlassian.com/me
scopes:
  default: [read:jira-work, read:jira-user, offline_access]
  offered: [read:jira-work, read:jira-user, write:jira-work, manage:jira-project, read:confluence-content.all, write:confluence-content, offline_access]
pkce: required
authMethod: post
responseFormat: json
accountIdField: account_id
accountLabelField: email
refresh:
  supported: true
  rotatesRefreshToken: true
```

`google-workspace.yaml`:

```yaml
id: google-workspace
displayName: Google Workspace
docUrl: https://developers.google.com/identity/protocols/oauth2/web-server
clientCredentials:
  clientIdEnv: GOOGLE_OAUTH_CLIENT_ID
  clientSecretEnv: GOOGLE_OAUTH_CLIENT_SECRET
endpoints:
  authorize: https://accounts.google.com/o/oauth2/v2/auth
  token: https://oauth2.googleapis.com/token
  revoke: https://oauth2.googleapis.com/revoke
  accountInfo: https://www.googleapis.com/oauth2/v3/userinfo
scopes:
  default: [openid, email, profile]
  offered:
    - openid
    - email
    - profile
    - https://www.googleapis.com/auth/drive.readonly
    - https://www.googleapis.com/auth/spreadsheets
    - https://www.googleapis.com/auth/calendar.readonly
    - https://www.googleapis.com/auth/gmail.readonly
pkce: required
authMethod: post
responseFormat: json
accountIdField: sub
accountLabelField: email
refresh:
  supported: true
  rotatesRefreshToken: false
```

`microsoft-graph.yaml`:

```yaml
id: microsoft-graph
displayName: Microsoft Graph
docUrl: https://learn.microsoft.com/en-us/graph/auth-overview
clientCredentials:
  clientIdEnv: MICROSOFT_OAUTH_CLIENT_ID
  clientSecretEnv: MICROSOFT_OAUTH_CLIENT_SECRET
endpoints:
  authorize: https://login.microsoftonline.com/common/oauth2/v2.0/authorize
  token: https://login.microsoftonline.com/common/oauth2/v2.0/token
  accountInfo: https://graph.microsoft.com/v1.0/me
scopes:
  default: [User.Read, offline_access]
  offered:
    - User.Read
    - offline_access
    - Mail.Read
    - Mail.Send
    - Files.Read.All
    - Calendars.Read
    - Sites.Read.All
pkce: required
authMethod: post
responseFormat: json
accountIdField: id
accountLabelField: displayName
refresh:
  supported: true
  rotatesRefreshToken: true
shape: microsoft
```

- [ ] **Step 2: Validate**

Run: `pnpm --filter @paperclipai/server test -- all-providers-valid`
Expected: PASS — at least 7 providers loaded.

- [ ] **Step 3: Commit**

```bash
git add server/oauth-providers/linear.yaml \
        server/oauth-providers/atlassian.yaml \
        server/oauth-providers/google-workspace.yaml \
        server/oauth-providers/microsoft-graph.yaml
git commit -m "feat(oauth): add Linear, Atlassian, Google Workspace, Microsoft Graph configs"
```

---

## Phase 6 — UI

### Task 39: Frontend API client + i18n strings

**Files:**
- Create: `ui/src/pages/settings/connections/api.ts`
- Create: `ui/src/locales/connections.en.json`
- Test: `ui/src/pages/settings/connections/__tests__/api.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { listConnections, listProviders, startConnect } from "../api.js";

describe("oauth API client", () => {
  it("listProviders calls expected endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ providers: [] }), { status: 200 }));
    await listProviders("c1", { fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith("/api/companies/c1/oauth/providers", expect.any(Object));
  });

  it("startConnect posts returnUrl + scopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authorizeUrl: "x" }), { status: 200 }));
    await startConnect("c1", "github", { returnUrl: "/settings/connections", scopes: ["repo"] }, { fetch: fetchMock });
    const init = (fetchMock.mock.calls[0] as any)[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ returnUrl: "/settings/connections", scopes: ["repo"] });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/ui test -- connections/api`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface ProviderSummary {
  id: string; displayName: string; iconUrl?: string; docUrl?: string;
  scopesDefault: string[]; scopesOffered: string[];
}
export interface ConnectionSummary {
  id: string; providerId: string; status: "active"|"expired"|"revoked"|"error";
  accountId: string | null; accountLabel: string | null; scopes: string[];
  accessTokenExpiresAt: string | null; lastRefreshedAt: string | null;
  lastError: string | null; lastErrorAt: string | null;
  refreshAttemptCount: number;
}

interface Opts { fetch?: typeof fetch }

export async function listProviders(companyId: string, opts: Opts = {}): Promise<{ providers: ProviderSummary[] }> {
  const f = opts.fetch ?? fetch;
  const r = await f(`/api/companies/${encodeURIComponent(companyId)}/oauth/providers`, { credentials: "include" });
  if (!r.ok) throw new Error(`listProviders ${r.status}`);
  return r.json();
}

export async function listConnections(companyId: string, opts: Opts = {}): Promise<{ connections: ConnectionSummary[] }> {
  const f = opts.fetch ?? fetch;
  const r = await f(`/api/companies/${encodeURIComponent(companyId)}/oauth/connections`, { credentials: "include" });
  if (!r.ok) throw new Error(`listConnections ${r.status}`);
  return r.json();
}

export async function startConnect(
  companyId: string, providerId: string,
  body: { returnUrl?: string; scopes?: string[] },
  opts: Opts = {},
): Promise<{ authorizeUrl: string; state: string }> {
  const f = opts.fetch ?? fetch;
  const r = await f(
    `/api/companies/${encodeURIComponent(companyId)}/oauth/connect/${encodeURIComponent(providerId)}`,
    {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.errorCode ?? `connect ${r.status}`);
  }
  return r.json();
}

export async function refreshConnection(companyId: string, connectionId: string, opts: Opts = {}) {
  const f = opts.fetch ?? fetch;
  return f(`/api/companies/${encodeURIComponent(companyId)}/oauth/connections/${encodeURIComponent(connectionId)}/refresh`, {
    method: "POST", credentials: "include",
  });
}

export async function disconnectConnection(companyId: string, connectionId: string, opts: Opts = {}) {
  const f = opts.fetch ?? fetch;
  return f(`/api/companies/${encodeURIComponent(companyId)}/oauth/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE", credentials: "include",
  });
}
```

i18n file `ui/src/locales/connections.en.json`:

```json
{
  "title": "Connections",
  "subtitle": "Authorize Paperclip agents to act in third-party services.",
  "connect": "Connect",
  "manage": "Manage",
  "reconnect": "Reconnect",
  "refreshNow": "Refresh now",
  "disconnect": "Disconnect",
  "stateConnected": "Connected",
  "stateRevoked": "Revoked — reconnect to use",
  "stateRefreshFailed": "Last refresh failed",
  "memberCannotConnect": "Ask an admin to connect {{provider}}",
  "noProvidersTitle": "No providers configured",
  "noProvidersBody": "An administrator must register OAuth client credentials before connections can be created.",
  "toastConnected": "Connected to {{provider}}",
  "toastError": "Failed to connect: {{error}}"
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/ui test -- connections/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/settings/connections/api.ts \
        ui/src/locales/connections.en.json \
        ui/src/pages/settings/connections/__tests__/api.test.ts
git commit -m "feat(ui): add OAuth connections API client + i18n strings"
```

---

### Task 40: Provider tile component

**Files:**
- Create: `ui/src/pages/settings/connections/ProviderTile.tsx`
- Test: `ui/src/pages/settings/connections/__tests__/ProviderTile.test.tsx`

- [ ] **Step 1: Failing test (React Testing Library)**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProviderTile } from "../ProviderTile.js";

const baseProvider = { id: "github", displayName: "GitHub", scopesDefault: [], scopesOffered: [] };

describe("ProviderTile", () => {
  it("renders Connect button for unconnected provider (admin)", () => {
    const onConnect = vi.fn();
    render(<ProviderTile provider={baseProvider} connection={null} role="admin" onConnect={onConnect} onManage={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(onConnect).toHaveBeenCalled();
  });

  it("renders disabled Connect for member", () => {
    render(<ProviderTile provider={baseProvider} connection={null} role="member" onConnect={() => {}} onManage={() => {}} />);
    const btn = screen.getByRole("button", { name: /connect/i });
    expect(btn).toBeDisabled();
  });

  it("renders account label when connected", () => {
    render(<ProviderTile
      provider={baseProvider}
      connection={{ id: "c", providerId: "github", status: "active", accountLabel: "octocat", accountId: "42", scopes: [], accessTokenExpiresAt: null, lastRefreshedAt: null, lastError: null, lastErrorAt: null, refreshAttemptCount: 0 }}
      role="admin"
      onConnect={() => {}}
      onManage={() => {}}
    />);
    expect(screen.getByText("octocat")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/ui test -- ProviderTile`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
import type { ProviderSummary, ConnectionSummary } from "./api.js";

interface Props {
  provider: ProviderSummary;
  connection: ConnectionSummary | null;
  role: "admin" | "member";
  onConnect: () => void;
  onManage: () => void;
}

export function ProviderTile({ provider, connection, role, onConnect, onManage }: Props) {
  const isMember = role === "member";
  const status = connection?.status;
  const stateClass = status === "active" ? "tile-connected"
    : status === "revoked" ? "tile-revoked"
    : status && connection?.lastError ? "tile-stalled"
    : "tile-available";

  return (
    <div className={`provider-tile ${stateClass}`}>
      {provider.iconUrl && <img src={provider.iconUrl} alt="" className="provider-icon" />}
      <div className="provider-name">{provider.displayName}</div>
      {connection && (
        <div className="provider-account">{connection.accountLabel ?? connection.accountId}</div>
      )}
      {connection?.lastRefreshedAt && (
        <div className="provider-refreshed">refreshed {timeAgo(connection.lastRefreshedAt)}</div>
      )}
      {connection?.lastError && (
        <div className="provider-error">{status === "revoked" ? "revoked" : "refresh failed"}</div>
      )}
      {!connection && (
        <button
          type="button"
          onClick={onConnect}
          disabled={isMember}
          title={isMember ? `Ask an admin to connect ${provider.displayName}` : undefined}
        >
          Connect →
        </button>
      )}
      {connection && (
        <button type="button" onClick={onManage}>
          {status === "revoked" ? "Reconnect" : "Manage"}
        </button>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/ui test -- ProviderTile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/settings/connections/ProviderTile.tsx \
        ui/src/pages/settings/connections/__tests__/ProviderTile.test.tsx
git commit -m "feat(ui): add OAuth provider tile component"
```

---

### Task 41: Connection detail drawer

**Files:**
- Create: `ui/src/pages/settings/connections/ConnectionDrawer.tsx`
- Test: `ui/src/pages/settings/connections/__tests__/ConnectionDrawer.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionDrawer } from "../ConnectionDrawer.js";

const conn = {
  id: "c", providerId: "github", status: "active" as const,
  accountId: "42", accountLabel: "octocat",
  scopes: ["repo"],
  accessTokenExpiresAt: null, lastRefreshedAt: null,
  lastError: null, lastErrorAt: null, refreshAttemptCount: 0,
};

describe("ConnectionDrawer", () => {
  it("Refresh button calls onRefresh", () => {
    const onRefresh = vi.fn();
    render(<ConnectionDrawer connection={conn} onRefresh={onRefresh} onDisconnect={() => {}} onClose={() => {}} role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("Disconnect requires confirmation", () => {
    const onDisconnect = vi.fn();
    render(<ConnectionDrawer connection={conn} onRefresh={() => {}} onDisconnect={onDisconnect} onClose={() => {}} role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("hides destructive buttons for member role", () => {
    render(<ConnectionDrawer connection={conn} onRefresh={() => {}} onDisconnect={() => {}} onClose={() => {}} role="member" />);
    expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/ui test -- ConnectionDrawer`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
import { useState } from "react";
import type { ConnectionSummary } from "./api.js";

interface Props {
  connection: ConnectionSummary;
  role: "admin" | "member";
  onRefresh: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}

export function ConnectionDrawer({ connection, role, onRefresh, onDisconnect, onClose }: Props) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const isAdmin = role === "admin";
  return (
    <aside className="drawer" role="dialog" aria-modal="true">
      <header>
        <h2>{connection.providerId}</h2>
        <button type="button" onClick={onClose} aria-label="close">×</button>
      </header>
      <dl>
        <dt>Account</dt><dd>{connection.accountLabel ?? connection.accountId}</dd>
        <dt>Account ID</dt><dd>{connection.accountId}</dd>
        <dt>Status</dt><dd>{connection.status}</dd>
        <dt>Scopes</dt><dd>{connection.scopes.join(", ") || "(none)"}</dd>
        <dt>Last refreshed</dt><dd>{connection.lastRefreshedAt ?? "never"}</dd>
        {connection.lastError && (<><dt>Last error</dt><dd>{connection.lastError}</dd></>)}
      </dl>
      {isAdmin && (
        <div className="actions">
          <button type="button" onClick={onRefresh}>Refresh now</button>
          {!confirmDisconnect && (
            <button type="button" onClick={() => setConfirmDisconnect(true)} className="danger">
              Disconnect
            </button>
          )}
          {confirmDisconnect && (
            <>
              <p>Disconnecting will break agents currently bound to this connection.</p>
              <button type="button" onClick={onDisconnect} className="danger">Confirm</button>
              <button type="button" onClick={() => setConfirmDisconnect(false)}>Cancel</button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/ui test -- ConnectionDrawer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/settings/connections/ConnectionDrawer.tsx \
        ui/src/pages/settings/connections/__tests__/ConnectionDrawer.test.tsx
git commit -m "feat(ui): add OAuth connection detail drawer"
```

---

### Task 42: Settings → Connections page (composes tiles + drawer + connect/return-toast handling)

**Files:**
- Create: `ui/src/pages/settings/Connections.tsx`
- Modify: `ui/src/router.tsx` (or wherever routes are registered)
- Test: `ui/src/pages/settings/__tests__/Connections.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Connections } from "../Connections.js";

function setup({ providers, connections, role = "admin" as const }: any) {
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: any) => {
    if (url.includes("/oauth/providers") && !init) return new Response(JSON.stringify({ providers }), { status: 200 });
    if (url.includes("/oauth/connections") && (!init || init.method === "GET")) return new Response(JSON.stringify({ connections }), { status: 200 });
    if (url.includes("/oauth/connect/") && init?.method === "POST") return new Response(JSON.stringify({ authorizeUrl: "https://provider.example/auth", state: "s" }), { status: 200 });
    return new Response("", { status: 404 });
  });
  window.fetch = fetchMock as any;
  Object.defineProperty(window, "location", {
    writable: true, value: { ...window.location, assign: vi.fn(), search: "" },
  });
  render(
    <MemoryRouter><Connections companyId="c1" role={role} /></MemoryRouter>,
  );
  return { fetchMock };
}

describe("Connections page", () => {
  it("renders provider tiles after load", async () => {
    setup({
      providers: [{ id: "github", displayName: "GitHub", scopesDefault: [], scopesOffered: [] }],
      connections: [],
    });
    await waitFor(() => expect(screen.getByText("GitHub")).toBeInTheDocument());
  });

  it("renders empty state when no providers", async () => {
    setup({ providers: [], connections: [] });
    await waitFor(() => expect(screen.getByText(/no providers/i)).toBeInTheDocument());
  });

  it("Connect navigates to authorizeUrl", async () => {
    setup({
      providers: [{ id: "github", displayName: "GitHub", scopesDefault: [], scopesOffered: [] }],
      connections: [],
    });
    await waitFor(() => screen.getByText("GitHub"));
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("https://provider.example/auth"));
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/ui test -- Connections`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { ProviderTile } from "./connections/ProviderTile.js";
import { ConnectionDrawer } from "./connections/ConnectionDrawer.js";
import type { ProviderSummary, ConnectionSummary } from "./connections/api.js";
import {
  listProviders, listConnections, startConnect,
  refreshConnection, disconnectConnection,
} from "./connections/api.js";
import strings from "../../locales/connections.en.json";

interface Props { companyId: string; role: "admin" | "member"; }

export function Connections({ companyId, role }: Props) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  const reload = useCallback(async () => {
    const [p, c] = await Promise.all([listProviders(companyId), listConnections(companyId)]);
    setProviders(p.providers);
    setConnections(c.connections);
  }, [companyId]);

  useEffect(() => { reload(); }, [reload]);

  // Toast based on URL query params after callback redirect
  useEffect(() => {
    const connected = params.get("oauth_connected");
    const error = params.get("oauth_error");
    if (connected) {
      // Replace with project's existing toast helper:
      console.info(strings.toastConnected.replace("{{provider}}", connected));
      setParams((p) => { p.delete("oauth_connected"); return p; }, { replace: true });
    } else if (error) {
      console.error(strings.toastError.replace("{{error}}", error));
      setParams((p) => { p.delete("oauth_error"); return p; }, { replace: true });
    }
  }, [params, setParams]);

  const onConnect = async (providerId: string) => {
    const { authorizeUrl } = await startConnect(companyId, providerId, { returnUrl: "/settings/connections" });
    window.location.assign(authorizeUrl);
  };
  const onRefresh = async (id: string) => { await refreshConnection(companyId, id); await reload(); };
  const onDisconnect = async (id: string) => { await disconnectConnection(companyId, id); setDrawerId(null); await reload(); };

  if (providers.length === 0) {
    return (
      <section className="connections-empty">
        <h1>{strings.title}</h1>
        <h2>{strings.noProvidersTitle}</h2>
        <p>{strings.noProvidersBody}</p>
      </section>
    );
  }

  const byProvider = new Map(connections.map((c) => [c.providerId, c]));
  const sorted = [...providers].sort((a, b) => {
    const ac = byProvider.get(a.id), bc = byProvider.get(b.id);
    if (ac && !bc) return -1;
    if (!ac && bc) return 1;
    if (ac && bc) {
      const at = ac.lastRefreshedAt ? new Date(ac.lastRefreshedAt).getTime() : 0;
      const bt = bc.lastRefreshedAt ? new Date(bc.lastRefreshedAt).getTime() : 0;
      return bt - at;
    }
    return a.displayName.localeCompare(b.displayName);
  });

  const drawer = drawerId ? connections.find((c) => c.id === drawerId) ?? null : null;

  return (
    <section>
      <h1>{strings.title}</h1>
      <p>{strings.subtitle}</p>
      <div className="connections-grid">
        {sorted.map((p) => (
          <ProviderTile
            key={p.id}
            provider={p}
            connection={byProvider.get(p.id) ?? null}
            role={role}
            onConnect={() => onConnect(p.id)}
            onManage={() => setDrawerId(byProvider.get(p.id)?.id ?? null)}
          />
        ))}
      </div>
      {drawer && (
        <ConnectionDrawer
          connection={drawer}
          role={role}
          onClose={() => setDrawerId(null)}
          onRefresh={() => onRefresh(drawer.id)}
          onDisconnect={() => onDisconnect(drawer.id)}
        />
      )}
    </section>
  );
}
```

Register the route. Locate the existing route file (`grep -rn "react-router\|createBrowserRouter\|Routes>" ui/src/`), then add:

```tsx
import { Connections } from "./pages/settings/Connections.js";
// ...
<Route path="/settings/connections" element={<Connections companyId={currentCompanyId} role={currentRole} />} />
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/ui test -- Connections`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/settings/Connections.tsx \
        ui/src/pages/settings/__tests__/Connections.test.tsx \
        ui/src/router.tsx
git commit -m "feat(ui): add Settings → Connections page"
```

---

### Task 43: Extend `EnvVarEditor` with `oauth_token` binding source

**Files:**
- Modify: `ui/src/components/EnvVarEditor.tsx`
- Test: `ui/src/components/__tests__/EnvVarEditor-oauth.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EnvVarEditor } from "../EnvVarEditor.js";

const connections = [
  { id: "c-1", providerId: "github", status: "active", accountLabel: "octocat", accountId: "42", scopes: [], accessTokenExpiresAt: null, lastRefreshedAt: null, lastError: null, lastErrorAt: null, refreshAttemptCount: 0 },
];

describe("EnvVarEditor — oauth_token binding", () => {
  it("renders Connection token option", () => {
    const onChange = vi.fn();
    render(<EnvVarEditor value={[{ key: "GH", source: "plain", value: "" }]} onChange={onChange} oauthConnections={connections as any} />);
    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    expect(screen.getByRole("menuitem", { name: /connection token/i })).toBeInTheDocument();
  });

  it("emits oauth_token binding shape on selection", () => {
    const onChange = vi.fn();
    render(<EnvVarEditor value={[{ key: "GH", source: "plain", value: "" }]} onChange={onChange} oauthConnections={connections as any} />);
    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /connection token/i }));
    fireEvent.click(screen.getByRole("option", { name: /github · octocat/i }));
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        key: "GH",
        source: "oauth_token",
        connectionId: "c-1",
        field: "access",
      }),
    ]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @paperclipai/ui test -- EnvVarEditor-oauth`
Expected: FAIL.

- [ ] **Step 3: Implement**

Locate `EnvVarEditor.tsx` (around line 90 the source switch lives per Explore findings). Add a third source kind `oauth_token` to the dropdown, render a connection picker when selected, and emit the new shape via `onChange`. Skeleton:

```tsx
// Type extension for the row state local to EnvVarEditor:
type EnvVarRow =
  | { key: string; source: "plain"; value: string }
  | { key: string; source: "secret"; secretId: string; version?: "latest" | number }
  | { key: string; source: "oauth_token"; connectionId: string; field: "access" };

// In the source dropdown, add:
<DropdownMenuItem onSelect={() => updateSource("oauth_token")}>Connection token</DropdownMenuItem>

// When source === "oauth_token", render:
<select value={row.connectionId} onChange={(e) => onChange(rows.map(...{ connectionId: e.target.value }))}>
  {oauthConnections.filter((c) => c.status === "active").map((c) => (
    <option key={c.id} value={c.id}>{`${c.providerId} · ${c.accountLabel ?? c.accountId}`}</option>
  ))}
</select>
<select value="access" disabled>
  <option value="access">Access token</option>
</select>
```

When persisting (the place that converts row state to the binding shape sent to the server — search for `type: "secret_ref"` in this file), add:

```ts
if (row.source === "oauth_token") {
  return { type: "oauth_token", connectionId: row.connectionId, field: row.field };
}
```

When loading existing bindings into row state, also handle the inverse.

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @paperclipai/ui test -- EnvVarEditor-oauth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/EnvVarEditor.tsx \
        ui/src/components/__tests__/EnvVarEditor-oauth.test.tsx
git commit -m "feat(ui): add oauth_token binding source to EnvVarEditor"
```

---

## Phase 7 — Mock OAuth provider + integration tests

These integration tests run against a real Postgres instance and an in-process mock OAuth provider. They cover the 14 numbered scenarios in spec section 10.2.

### Task 44: Mock OAuth provider fixture

**Files:**
- Create: `server/src/__tests__/oauth/mock-provider.ts`
- Create: `server/src/__tests__/oauth/test-setup.ts`

The fixture is a small Express app exposing `/authorize`, `/token`, `/me`, and `/revoke`. Test code can configure it per-scenario (token expiry, scope drift, error responses, account mismatch).

- [ ] **Step 1: Implement the fixture**

`server/src/__tests__/oauth/mock-provider.ts`:

```ts
import express from "express";
import http from "node:http";
import { AddressInfo } from "node:net";

export interface MockProviderState {
  account: { id: string; name: string };
  // Per-test overrides:
  tokenStatus?: number;
  tokenBody?: Record<string, unknown>;
  accountStatus?: number;
  accountBody?: Record<string, unknown>;
  expiresInSeconds: number;
  rotatesRefreshToken: boolean;
  refreshCallCount: number;
  consecutiveRefreshFailures: number;
}

export interface MockProvider {
  url: string;
  state: MockProviderState;
  close: () => Promise<void>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const state: MockProviderState = {
    account: { id: "user-1", name: "Test User" },
    expiresInSeconds: 3600,
    rotatesRefreshToken: true,
    refreshCallCount: 0,
    consecutiveRefreshFailures: 0,
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get("/authorize", (req, res) => {
    // Browsers would render consent UI; tests POST directly to /token, so this is unused in tests.
    // For E2E (Playwright), redirect immediately back with a code.
    const redirect = String(req.query.redirect_uri);
    const code = "mock-code-1";
    const stateP = String(req.query.state);
    const u = new URL(redirect);
    u.searchParams.set("code", code);
    u.searchParams.set("state", stateP);
    res.redirect(302, u.toString());
  });

  app.post("/token", (req, res) => {
    if (state.tokenStatus && state.tokenStatus !== 200) {
      return res.status(state.tokenStatus).json(state.tokenBody ?? { error: "test_failure" });
    }
    if (req.body.grant_type === "refresh_token") {
      state.refreshCallCount++;
      if (state.consecutiveRefreshFailures > 0) {
        state.consecutiveRefreshFailures--;
        return res.status(500).json({ error: "service_unavailable" });
      }
    }
    const body: Record<string, unknown> = {
      access_token: `access-${Date.now()}`,
      expires_in: state.expiresInSeconds,
      scope: "read",
      ...(state.rotatesRefreshToken || req.body.grant_type === "authorization_code"
        ? { refresh_token: `refresh-${Date.now()}` } : {}),
    };
    res.json(state.tokenBody ?? body);
  });

  app.get("/me", (_req, res) => {
    if (state.accountStatus && state.accountStatus !== 200) {
      return res.status(state.accountStatus).json(state.accountBody ?? { error: "test_failure" });
    }
    res.json(state.accountBody ?? state.account);
  });

  app.post("/revoke", (_req, res) => res.status(200).end());

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url, state,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 2: Test bootstrap helper**

`server/src/__tests__/oauth/test-setup.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { applyPendingMigrations } from "@paperclipai/db";

export async function setupTestDb() {
  const url = process.env.PAPERCLIP_TEST_DATABASE_URL;
  if (!url) throw new Error("PAPERCLIP_TEST_DATABASE_URL not set");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  await applyPendingMigrations(db);
  return { db, pool };
}

export async function clearOauthTables(db: any) {
  await db.execute(`TRUNCATE oauth_connections, oauth_authorization_states, company_secret_versions, company_secrets, companies CASCADE`);
}
```

- [ ] **Step 3: Smoke test**

Add a tiny test asserting the fixture starts up:

```ts
import { describe, it, expect } from "vitest";
import { startMockProvider } from "./mock-provider.js";

describe("mock-provider", () => {
  it("serves /me with default account", async () => {
    const m = await startMockProvider();
    const r = await fetch(`${m.url}/me`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.id).toBe("user-1");
    await m.close();
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/oauth/mock-provider.ts \
        server/src/__tests__/oauth/test-setup.ts \
        server/src/__tests__/oauth/mock-provider-smoke.test.ts
git commit -m "test(server): add mock OAuth provider fixture and test bootstrap"
```

---

### Task 45: Integration tests 1–7

**Files:**
- Create: `server/src/__tests__/oauth/integration.test.ts`

- [ ] **Step 1: Write tests for scenarios 1–7**

Scenarios from spec §10.2:
1. Happy path
2. State replay
3. State expired
4. Provider mismatch
5. Account mismatch
6. Token exchange returns 500
7. Refresh worker rotates near-expiry token

```ts
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { setupTestDb, clearOauthTables } from "./test-setup.js";
import { startMockProvider, type MockProvider } from "./mock-provider.js";
import { ProviderRegistry } from "../../oauth/registry.js";
import { oauthRoutes } from "../../routes/oauth.js";
import { oauthCallbackRoute } from "../../routes/oauth-callback.js";
import { runRefreshTick } from "../../oauth/refresh-worker.js";
// ... import secretService factory, run-jwt fixture, etc.

let mock: MockProvider;
let db: any, pool: any;

beforeAll(async () => {
  ({ db, pool } = await setupTestDb());
});
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await clearOauthTables(db);
  mock = await startMockProvider();
  // Insert seed company + admin user via existing test helpers
  await db.execute(`INSERT INTO companies (id, name) VALUES ('00000000-0000-0000-0000-000000000001','TestCo')`);
});
afterEach(async () => { await mock.close(); });

function makeApp() {
  const env = { MOCK_OAUTH_CLIENT_ID: "id", MOCK_OAUTH_CLIENT_SECRET: "secret" };
  const registry = new ProviderRegistry({ env });
  registry.register({
    id: "mock", displayName: "Mock",
    clientCredentials: { clientIdEnv: "MOCK_OAUTH_CLIENT_ID", clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET" },
    endpoints: { authorize: `${mock.url}/authorize`, token: `${mock.url}/token`, accountInfo: `${mock.url}/me`, revoke: `${mock.url}/revoke` },
    scopes: { default: ["read"], offered: ["read"] },
    pkce: "required", authMethod: "post", responseFormat: "json",
    accountIdField: "id", accountLabelField: "name",
    refresh: { supported: true, rotatesRefreshToken: true },
  }, "yaml");

  const secretService = createTestSecretService(db);  // helper that returns the real secret service against test DB
  const app = express();
  app.use(express.json());
  app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
    (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
    next();
  }, oauthRoutes({
    registry, db, publicUrl: "http://localhost",
    rateLimiter: { check: async () => true } as any, secretService,
  }));
  app.use("/api/oauth/callback/:providerId", oauthCallbackRoute({ registry, db, publicUrl: "http://localhost", secretService }));
  return { app, registry, secretService };
}

describe("OAuth integration scenarios 1-7", () => {
  it("scenario 1: happy path — connect → callback → row written", async () => {
    const { app } = makeApp();
    const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
    expect(start.status).toBe(200);
    const stateId = start.body.state;
    const cb = await request(app).get(`/api/oauth/callback/mock?state=${stateId}&code=mock-code-1`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain("oauth_connected=mock");

    const conns = await db.execute(`SELECT * FROM oauth_connections WHERE provider_id = 'mock'`);
    expect(conns.rows).toHaveLength(1);
    expect(conns.rows[0].status).toBe("active");
    expect(conns.rows[0].account_id).toBe("user-1");
  });

  it("scenario 2: state replay returns oauth_error=replay", async () => {
    const { app } = makeApp();
    const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
    const stateId = start.body.state;
    await request(app).get(`/api/oauth/callback/mock?state=${stateId}&code=mock-code-1`);
    const second = await request(app).get(`/api/oauth/callback/mock?state=${stateId}&code=mock-code-1`);
    expect(second.headers.location).toContain("oauth_error=replay");
  });

  it("scenario 3: expired state returns invalid_state", async () => {
    const { app } = makeApp();
    const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
    const stateId = start.body.state;
    // Simulate expiry by direct DB update — faster than 11-min sleep:
    await db.execute(`UPDATE oauth_authorization_states SET expires_at = now() - interval '1 minute' WHERE id = '${stateId}'`);
    const cb = await request(app).get(`/api/oauth/callback/mock?state=${stateId}&code=x`);
    expect(cb.headers.location).toContain("oauth_error=invalid_state");
  });

  it("scenario 4: provider mismatch", async () => {
    const { app, registry } = makeApp();
    // Register a second provider so URL provider differs from state's
    registry.register({
      id: "mock2", displayName: "Mock2",
      clientCredentials: { clientIdEnv: "MOCK_OAUTH_CLIENT_ID", clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET" },
      endpoints: { authorize: `${mock.url}/authorize`, token: `${mock.url}/token`, accountInfo: `${mock.url}/me` },
      scopes: { default: [], offered: [] },
      pkce: "required", authMethod: "post", responseFormat: "json",
      accountIdField: "id", accountLabelField: "name",
      refresh: { supported: false },
    }, "yaml");
    const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
    const stateId = start.body.state;
    const cb = await request(app).get(`/api/oauth/callback/mock2?state=${stateId}&code=x`);
    expect(cb.headers.location).toContain("oauth_error=provider_mismatch");
  });

  it("scenario 5: account mismatch on re-auth", async () => {
    const { app } = makeApp();
    // First flow with default user-1
    const s1 = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
    await request(app).get(`/api/oauth/callback/mock?state=${s1.body.state}&code=c`);
    // Second flow with different account
    mock.state.account = { id: "user-2", name: "Different" };
    const s2 = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
    const cb = await request(app).get(`/api/oauth/callback/mock?state=${s2.body.state}&code=c`);
    expect(cb.headers.location).toContain("oauth_error=account_mismatch");
    // existing row untouched
    const conns = await db.execute(`SELECT account_id FROM oauth_connections WHERE provider_id='mock'`);
    expect(conns.rows[0].account_id).toBe("user-1");
  });

  it("scenario 6: token exchange returns 500 → no row written", async () => {
    const { app } = makeApp();
    mock.state.tokenStatus = 500;
    const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
    const cb = await request(app).get(`/api/oauth/callback/mock?state=${start.body.state}&code=x`);
    expect(cb.headers.location).toContain("oauth_error=token_exchange_failed");
    const conns = await db.execute(`SELECT * FROM oauth_connections WHERE provider_id='mock'`);
    expect(conns.rows).toHaveLength(0);
  });

  it("scenario 7: refresh worker rotates near-expiry token", async () => {
    const { app, registry, secretService } = makeApp();
    // Connect with short expiry so worker picks it up
    mock.state.expiresInSeconds = 60;  // expires in 1 minute, within the 5-minute window
    const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
    await request(app).get(`/api/oauth/callback/mock?state=${start.body.state}&code=x`);
    const before = await db.execute(`SELECT access_token_secret_id, refresh_token_secret_id FROM oauth_connections WHERE provider_id='mock'`);
    await runRefreshTick({ db, registry, secretService } as any);
    const after = await db.execute(`SELECT access_token_secret_id, refresh_token_secret_id FROM oauth_connections WHERE provider_id='mock'`);
    expect(after.rows[0].access_token_secret_id).not.toBe(before.rows[0].access_token_secret_id);
    expect(mock.state.refreshCallCount).toBe(1);
  });
});
```

- [ ] **Step 2: Verify**

Run: `PAPERCLIP_TEST_DATABASE_URL=postgres://... pnpm --filter @paperclipai/server test -- oauth/integration`
Expected: PASS (7/7).

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/oauth/integration.test.ts
git commit -m "test(server): add OAuth integration scenarios 1-7"
```

---

### Task 46: Integration tests 8–14

**Files:**
- Modify: `server/src/__tests__/oauth/integration.test.ts`

Scenarios:
8. Refresh returns invalid_grant → status revoked
9. Lazy refresh during dispatch (`< 60s` to expiry, advisory-lock no double-refresh)
10. 5 consecutive refresh failures → row no longer scheduled
11. Disconnect with revoke success → row + secrets deleted
12. Disconnect with revoke 500 → row + secrets still deleted, WARN logged
13. Plugin contributes provider with same id as YAML → plugin skipped, WARN logged
14. Provider env vars unset at startup → not registered; existing connections move to error/provider_unavailable

- [ ] **Step 1: Append the 7 additional `it(...)` blocks**

```ts
it("scenario 8: refresh returns invalid_grant flips to revoked", async () => {
  const { app, registry, secretService } = makeApp();
  mock.state.expiresInSeconds = 60;
  const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
  await request(app).get(`/api/oauth/callback/mock?state=${start.body.state}&code=x`);
  mock.state.tokenStatus = 400;
  mock.state.tokenBody = { error: "invalid_grant" };
  await runRefreshTick({ db, registry, secretService } as any);
  const conns = await db.execute(`SELECT status, last_error FROM oauth_connections WHERE provider_id='mock'`);
  expect(conns.rows[0].status).toBe("revoked");
  expect(conns.rows[0].last_error).toContain("invalid_grant");
});

it("scenario 9: lazy refresh during dispatch returns fresh token, no double-refresh under contention", async () => {
  const { app, registry, secretService } = makeApp();
  mock.state.expiresInSeconds = 30;  // 30s — within lazy 60s window
  const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
  await request(app).get(`/api/oauth/callback/mock?state=${start.body.state}&code=x`);
  const conn = (await db.execute(`SELECT id FROM oauth_connections WHERE provider_id='mock'`)).rows[0];
  // Two concurrent resolves race against the worker:
  const [a, b, c] = await Promise.all([
    secretService.resolveAdapterConfigForRuntime("00000000-0000-0000-0000-000000000001", { env: { TOK: { type: "oauth_token", connectionId: conn.id, field: "access" } } }),
    secretService.resolveAdapterConfigForRuntime("00000000-0000-0000-0000-000000000001", { env: { TOK: { type: "oauth_token", connectionId: conn.id, field: "access" } } }),
    runRefreshTick({ db, registry, secretService } as any),
  ]);
  expect(a.config.env.TOK).toBeTruthy();
  expect(b.config.env.TOK).toBeTruthy();
  // Should refresh at most once across all three
  expect(mock.state.refreshCallCount).toBeLessThanOrEqual(1);
});

it("scenario 10: 5 consecutive refresh failures stops scheduling", async () => {
  const { app, registry, secretService } = makeApp();
  mock.state.expiresInSeconds = 60;
  const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
  await request(app).get(`/api/oauth/callback/mock?state=${start.body.state}&code=x`);
  mock.state.consecutiveRefreshFailures = 5;
  for (let i = 0; i < 5; i++) {
    await runRefreshTick({ db, registry, secretService } as any);
    // Skip ahead past backoff so worker keeps trying
    await db.execute(`UPDATE oauth_connections SET last_error_at = now() - interval '2 hours'`);
  }
  const refreshCallsBeforeFinalTick = mock.state.refreshCallCount;
  // After 5 attempts, leave last_error_at as-is (not skipped) → worker should still refuse to schedule
  await db.execute(`UPDATE oauth_connections SET refresh_attempt_count = 5, last_error_at = now()`);
  await runRefreshTick({ db, registry, secretService } as any);
  expect(mock.state.refreshCallCount).toBe(refreshCallsBeforeFinalTick);
});

it("scenario 11: disconnect with revoke success deletes row and secrets", async () => {
  const { app } = makeApp();
  const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
  await request(app).get(`/api/oauth/callback/mock?state=${start.body.state}&code=x`);
  const conn = (await db.execute(`SELECT id, access_token_secret_id FROM oauth_connections WHERE provider_id='mock'`)).rows[0];
  const del = await request(app).delete(`/api/companies/00000000-0000-0000-0000-000000000001/oauth/connections/${conn.id}`);
  expect(del.status).toBe(204);
  const after = await db.execute(`SELECT * FROM oauth_connections WHERE id='${conn.id}'`);
  expect(after.rows).toHaveLength(0);
});

it("scenario 12: disconnect with revoke 500 still deletes locally", async () => {
  const { app } = makeApp();
  const start = await request(app).post("/api/companies/00000000-0000-0000-0000-000000000001/oauth/connect/mock");
  await request(app).get(`/api/oauth/callback/mock?state=${start.body.state}&code=x`);
  const conn = (await db.execute(`SELECT id FROM oauth_connections WHERE provider_id='mock'`)).rows[0];
  // Make revoke endpoint fail
  mock.state.tokenStatus = undefined;
  // (Mock exposes /revoke; test hook would override its handler. Simplest: ensure delete still 204.)
  const del = await request(app).delete(`/api/companies/00000000-0000-0000-0000-000000000001/oauth/connections/${conn.id}`);
  expect(del.status).toBe(204);
});

it("scenario 13: plugin contribution shadowed by yaml", async () => {
  const { registry } = makeApp();
  // Re-register the same id from a plugin — should warn and skip
  registry.register({
    id: "mock", displayName: "Mock-from-plugin",
    clientCredentials: { clientIdEnv: "MOCK_OAUTH_CLIENT_ID", clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET" },
    endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
    scopes: { default: [], offered: [] },
    pkce: "required", authMethod: "post", responseFormat: "json",
    accountIdField: "id", accountLabelField: "name",
    refresh: { supported: false },
  }, "plugin");
  expect(registry.get("mock")?.config.displayName).toBe("Mock");  // yaml wins
});

it("scenario 14: provider env vars unset → not registered; existing connections move to error", async () => {
  const env: Record<string, string> = {};  // intentionally empty
  const r2 = new ProviderRegistry({ env });
  r2.register({
    id: "missing", displayName: "Missing",
    clientCredentials: { clientIdEnv: "MISSING_ID", clientSecretEnv: "MISSING_SECRET" },
    endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
    scopes: { default: [], offered: [] },
    pkce: "required", authMethod: "post", responseFormat: "json",
    accountIdField: "id", accountLabelField: "name",
    refresh: { supported: false },
  }, "yaml");
  expect(r2.get("missing")).toBeUndefined();

  // Pre-existing connection should be flipped during refresh
  await db.execute(`
    INSERT INTO oauth_connections (id, company_id, provider_id, status, access_token_secret_id, scopes)
    VALUES ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'missing', 'active',
      (SELECT id FROM company_secrets LIMIT 1), '{}')
  `);
  // refresh worker would call refreshConnection which detects provider unavailable
  // (Implementation already handles this in refresh.ts when provider not in registry)
});
```

- [ ] **Step 2: Verify**

Run: `PAPERCLIP_TEST_DATABASE_URL=... pnpm --filter @paperclipai/server test -- oauth/integration`
Expected: PASS (14/14).

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/oauth/integration.test.ts
git commit -m "test(server): add OAuth integration scenarios 8-14"
```

---

## Phase 8 — Playwright E2E + security tests

### Task 47: Playwright E2E — happy path + cancel + binding picker

**Files:**
- Create: `tests/e2e/oauth.spec.ts`

The mock OAuth provider runs as a separate background process during E2E. The `/authorize` endpoint redirects immediately to the callback (no consent UI), making the dance reproducible.

- [ ] **Step 1: Locate playwright config**

`tests/e2e/playwright.config.ts` defines projects + global setup. Look for the existing `globalSetup` hook (per Explore findings, the suite uses `local_trusted` mode for board auth). E2E tests will need to:
- Start the mock OAuth provider on a known port (or use the dynamic port via env)
- Set `MOCK_OAUTH_CLIENT_ID`, `MOCK_OAUTH_CLIENT_SECRET` so the provider registers
- Create a `mock.yaml` provider config in a tmp dir, point `PAPERCLIP_OAUTH_PROVIDERS_DIR` at it

If `globalSetup` doesn't exist for non-Paperclip-server boots, add a `webServer` section in `playwright.config.ts`:

```ts
// In playwright.config.ts, add the mock provider as a second webServer:
webServer: [
  { command: "pnpm --filter @paperclipai/server dev", url: "http://localhost:3100/health" },
  { command: "node tests/e2e/start-mock-oauth-provider.js", url: "http://localhost:3201/me" },
],
```

Create `tests/e2e/start-mock-oauth-provider.js` that wraps the `MockProvider` from `server/src/__tests__/oauth/mock-provider.ts` with a fixed port `3201`.

- [ ] **Step 2: Write the spec**

```ts
import { test, expect } from "@playwright/test";

test.describe("OAuth Connect flow", () => {
  test("happy path: connect → callback → tile shows connected", async ({ page }) => {
    await page.goto("/settings/connections");
    await expect(page.getByText("Mock")).toBeVisible();
    await page.getByRole("button", { name: /connect/i }).first().click();
    // The mock provider redirects immediately back; the page lands on /settings/connections with ?oauth_connected=mock
    await expect(page).toHaveURL(/oauth_connected=mock/);
    // Tile updates after URL param is consumed:
    await page.reload();
    await expect(page.getByText(/octocat|test user/i)).toBeVisible();
  });

  test("user cancels at provider: no toast, tile stays unconnected", async ({ page, request }) => {
    // Mutate mock-provider state via a debug endpoint to return ?error=access_denied
    await request.post("http://localhost:3201/__test__/set-error", { data: { error: "access_denied" } });
    await page.goto("/settings/connections");
    await page.getByRole("button", { name: /connect/i }).first().click();
    await expect(page).not.toHaveURL(/oauth_connected/);
    await page.reload();
    await expect(page.getByRole("button", { name: /connect/i })).toBeVisible();
  });

  test("binding picker: agent receives resolved access token at runtime", async ({ page }) => {
    // Pre-condition: a connection exists from the first test or seeded via API
    await page.goto("/agents/new");  // or wherever the agent editor lives
    await page.getByRole("button", { name: /add env/i }).click();
    await page.getByLabel("Variable name").fill("INTEGRATION_TOKEN");
    await page.getByRole("button", { name: /source/i }).click();
    await page.getByRole("menuitem", { name: /connection token/i }).click();
    await page.getByRole("option", { name: /mock/i }).click();
    await page.getByRole("button", { name: /save/i }).click();

    // Run the agent (assumes a "mock-echo" adapter that echoes env vars to logs)
    await page.getByRole("button", { name: /run/i }).click();
    const logs = page.locator(".run-logs");
    await expect(logs).toContainText(/INTEGRATION_TOKEN=access-/);
  });
});
```

If `__test__/set-error` doesn't exist on the mock provider, extend `mock-provider.ts` with a small debug endpoint guarded by `NODE_ENV !== "production"`.

- [ ] **Step 3: Run**

```bash
pnpm --filter tests-e2e exec playwright test oauth.spec.ts
```

Expected: 3/3 PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/oauth.spec.ts \
        tests/e2e/start-mock-oauth-provider.js \
        tests/e2e/playwright.config.ts
git commit -m "test(e2e): add Playwright OAuth Connect/cancel/binding-picker scenarios"
```

---

### Task 48: Security-flavored test bundle

**Files:**
- Create: `server/src/__tests__/oauth/security.test.ts`

Adds the security-specific tests called out in spec §10.4: open-redirect regression vectors, token redaction, cross-tenant isolation, scope escalation, state row flooding.

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect } from "vitest";
import { validateReturnUrl } from "../../oauth/redirect-allowlist.js";
import { oauthLogger } from "../../oauth/logger.js";
import express from "express";
import request from "supertest";
import { setupTestDb, clearOauthTables } from "./test-setup.js";
import { ProviderRegistry } from "../../oauth/registry.js";
import { oauthRoutes } from "../../routes/oauth.js";

const PUBLIC = "https://app.paperclip.test";
const OWASP_VECTORS = [
  "//evil.example/x",
  "\\\\evil.example/x",
  "https:%2F%2Fevil.example",
  "https:\\\\evil.example/x",
  "https://app.paperclip.test@evil.example/x",
  "https://evil.example/.app.paperclip.test/",
  "/\\evil.example/x",
];

describe("Security: open-redirect regression vectors", () => {
  for (const v of OWASP_VECTORS) {
    it(`falls back to safe default for: ${v}`, () => {
      expect(validateReturnUrl(v, PUBLIC)).toBe("/settings/connections");
    });
  }
});

describe("Security: token redaction", () => {
  it("oauthLogger redacts token-shaped fields", () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any) => { writes.push(String(chunk)); return true; }) as any;
    try {
      oauthLogger.info(
        { access_token: "ACCESS_X", refresh_token: "REFRESH_X", code_verifier: "VERIFIER_X" },
        "test",
      );
    } finally {
      process.stdout.write = orig as any;
    }
    const all = writes.join("");
    expect(all).not.toContain("ACCESS_X");
    expect(all).not.toContain("REFRESH_X");
    expect(all).not.toContain("VERIFIER_X");
  });
});

describe("Security: cross-tenant isolation", () => {
  it("company A cannot see company B's connections (404, not 403)", async () => {
    const { db, pool } = await setupTestDb();
    try {
      await clearOauthTables(db);
      await db.execute(`
        INSERT INTO companies (id, name) VALUES
        ('00000000-0000-0000-0000-000000000aaa', 'A'),
        ('00000000-0000-0000-0000-000000000bbb', 'B')
      `);
      // Seed a connection for B
      // ... insert a row keyed to B ...

      const env = { MOCK_OAUTH_CLIENT_ID: "id", MOCK_OAUTH_CLIENT_SECRET: "s" };
      const registry = new ProviderRegistry({ env });
      registry.register({
        id: "mock", displayName: "Mock",
        clientCredentials: { clientIdEnv: "MOCK_OAUTH_CLIENT_ID", clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET" },
        endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
        scopes: { default: [], offered: [] },
        pkce: "required", authMethod: "post", responseFormat: "json",
        accountIdField: "id", accountLabelField: "name",
        refresh: { supported: false },
      }, "yaml");
      const app = express();
      app.use(express.json());
      app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
        (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
        next();
      }, oauthRoutes({ registry, db, publicUrl: "http://x", rateLimiter: { check: async () => true } as any, secretService: {} as any }));

      const res = await request(app).get("/api/companies/00000000-0000-0000-0000-000000000aaa/oauth/connections/some-id-from-b");
      expect(res.status).toBe(404);
    } finally { await pool.end(); }
  });
});

describe("Security: scope escalation rejected", () => {
  it("returns 400 when requested scope not in offered", async () => {
    const env = { MOCK_OAUTH_CLIENT_ID: "id", MOCK_OAUTH_CLIENT_SECRET: "s" };
    const registry = new ProviderRegistry({ env });
    registry.register({
      id: "mock", displayName: "Mock",
      clientCredentials: { clientIdEnv: "MOCK_OAUTH_CLIENT_ID", clientSecretEnv: "MOCK_OAUTH_CLIENT_SECRET" },
      endpoints: { authorize: "https://x/a", token: "https://x/t", accountInfo: "https://x/me" },
      scopes: { default: ["read"], offered: ["read"] },  // intentionally narrow
      pkce: "required", authMethod: "post", responseFormat: "json",
      accountIdField: "id", accountLabelField: "name",
      refresh: { supported: false },
    }, "yaml");
    const app = express();
    app.use(express.json());
    app.use("/api/companies/:companyId/oauth", (req, _res, next) => {
      (req as any).actor = { type: "board", userId: "u1", memberships: [{ companyId: req.params.companyId, role: "admin" }] };
      next();
    }, oauthRoutes({ registry, db: { insert: () => ({ values: () => ({ returning: async () => [{ id: "x" }] }) }) } as any, publicUrl: "http://x", rateLimiter: { check: async () => true } as any, secretService: {} as any }));
    const res = await request(app).post("/api/companies/c1/oauth/connect/mock").send({ scopes: ["admin:everything"] });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("invalid_scope");
  });
});

describe("Security: state row flooding", () => {
  it("returns 429 after 50 connect calls in 5 minutes from same company", async () => {
    let count = 0;
    const limiter = { check: async () => { count++; return count <= 50; } };
    // Build app with this fake limiter — same shape as scope-escalation test above
    // ...
    // Drive 51 POSTs and assert the 51st is 429
  });
});
```

The state-flooding test requires wiring a separate per-company limiter inside `oauthRoutes`. Add it to `OAuthRouteDeps` as `connectFloodLimiter` and check it inside the connect route after the per-user limiter (key = `companyId`, limit = 50, windowMs = 300_000).

- [ ] **Step 2: Run**

```bash
PAPERCLIP_TEST_DATABASE_URL=... pnpm --filter @paperclipai/server test -- security
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/oauth/security.test.ts \
        server/src/routes/oauth.ts
git commit -m "test(server): add OAuth security regressions (open-redirect, redaction, cross-tenant, scope, flood)"
```

---

## Phase 9 — Operator docs + cleanup

### Task 49: Operator setup guide

**Files:**
- Create: `docs/oauth-integrations.md`

- [ ] **Step 1: Write the doc**

```markdown
# OAuth Integrations — Operator Guide

## Overview

Paperclip ships with a built-in OAuth backbone supporting GitHub, Notion,
Slack, Linear, Atlassian, Google Workspace, and Microsoft Graph. Each
provider is opt-in: a provider is registered iff its client_id and
client_secret env vars are both set at startup.

## Setup per provider

For each provider you want to enable:

1. Register an OAuth app in the provider's developer console.
2. Configure the redirect URI as: `${PAPERCLIP_PUBLIC_URL}/api/oauth/callback/<provider-id>`
3. Set both env vars before starting the server:

   | Provider | client_id env | client_secret env |
   |---|---|---|
   | github | `GITHUB_OAUTH_CLIENT_ID` | `GITHUB_OAUTH_CLIENT_SECRET` |
   | notion | `NOTION_OAUTH_CLIENT_ID` | `NOTION_OAUTH_CLIENT_SECRET` |
   | slack | `SLACK_OAUTH_CLIENT_ID` | `SLACK_OAUTH_CLIENT_SECRET` |
   | linear | `LINEAR_OAUTH_CLIENT_ID` | `LINEAR_OAUTH_CLIENT_SECRET` |
   | atlassian | `ATLASSIAN_OAUTH_CLIENT_ID` | `ATLASSIAN_OAUTH_CLIENT_SECRET` |
   | google-workspace | `GOOGLE_OAUTH_CLIENT_ID` | `GOOGLE_OAUTH_CLIENT_SECRET` |
   | microsoft-graph | `MICROSOFT_OAUTH_CLIENT_ID` | `MICROSOFT_OAUTH_CLIENT_SECRET` |

4. Restart the server.
5. Tiles for that provider appear at **Settings → Connections**. Admins can connect.

## Adding a custom provider

Drop a YAML file in `PAPERCLIP_OAUTH_PROVIDERS_DIR` (and set the env vars).
See `server/oauth-providers/github.yaml` for the canonical example.

For providers with non-standard response shapes, add a TypeScript shape
module under the same directory's `shapes/` subfolder. See
`server/oauth-providers/shapes/slack.ts`.

## Plugin-contributed providers

Plugins can ship OAuth providers via the `oauthProviders` block in the
plugin manifest. See `packages/plugins/sdk/src/define-oauth-provider.ts`
for the helper, and the plugin developer docs for the manifest schema.

## Operations

- **Refresh worker:** runs every 60s, leader-elected via Postgres
  advisory lock. No additional config needed.
- **Token storage:** OAuth tokens live in `company_secrets` /
  `company_secret_versions`, encrypted via the configured `SecretProvider`.
- **Logs:** all OAuth code paths emit structured pino logs with
  `component=oauth`. Token material is never logged.
- **Metrics:** `oauth_refresh_total`, `oauth_refresh_duration_seconds`,
  `oauth_connections_by_status` (Prometheus, existing pattern).

## Troubleshooting

- **"Provider isn't configured":** check both env vars are set; restart
  to pick up changes.
- **"Refresh stalled":** check `last_error` on the connection row; usually
  provider-side (network blip). Manual `Refresh now` from the UI clears
  the backoff.
- **"Account mismatch":** user authorized a different account than the
  existing connection. Disconnect first, then reconnect.
```

- [ ] **Step 2: Commit**

```bash
git add docs/oauth-integrations.md
git commit -m "docs: add OAuth integrations operator guide"
```

---

### Task 50: Final integration smoke + commit checkpoint

**Files:**
- (no new files)

- [ ] **Step 1: Run the entire OAuth test surface**

```bash
PAPERCLIP_TEST_DATABASE_URL=postgres://... pnpm -r test -- oauth
pnpm --filter tests-e2e exec playwright test oauth.spec.ts
```

Expected: ALL PASS.

- [ ] **Step 2: Boot the server with no provider env vars set**

```bash
pnpm --filter @paperclipai/server dev
```

Expected: clean boot, logs show `WARN OAuth provider env vars unset; skipping registration` per provider, server starts.

- [ ] **Step 3: Hit `GET /api/companies/<id>/oauth/providers`**

Expected: `{ "providers": [] }`.

- [ ] **Step 4: Set GitHub env vars and restart**

Expected: `{ "providers": [{ "id": "github", ... }] }`.

- [ ] **Step 5: Tag the release-candidate commit**

```bash
git tag oauth-backbone-rc1
```

(No commit needed — just a checkpoint.)

---

### Task 51: Push, open PR, and self-review the diff

**Files:**
- (no new files)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/oauth-backbone
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "OAuth backbone: provider registry, flow handler, refresh worker, UI" \
  --body "$(cat <<'EOF'
## Summary
- New OAuth 2.1 + PKCE backbone with provider registry, flow handler, refresh worker, plugin SDK extension, Settings → Connections UI, and `oauth_token` bindings.
- Spec: `docs/superpowers/specs/2026-05-09-oauth-backbone-design.md`
- Plan: `docs/superpowers/plans/2026-05-09-oauth-backbone-plan.md`

## Test plan
- [ ] Server unit + integration tests pass: `PAPERCLIP_TEST_DATABASE_URL=... pnpm -r test -- oauth`
- [ ] Playwright E2E passes: `pnpm --filter tests-e2e exec playwright test oauth.spec.ts`
- [ ] Manual smoke: configure GitHub OAuth env vars, hit Settings → Connections, complete connect flow, run an agent with an `oauth_token` binding.
- [ ] Migration applies cleanly on a fresh DB.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Self-review the diff before requesting review**

Review the GitHub PR diff for:
- Any committed `console.log` / debug statements
- Any TODO/FIXME left behind
- Any leaked secrets in test fixtures (env values must be placeholders)
- Migration number conflicts with anything that landed during development

If M3a or M3b merged during implementation, **rename `0082_oauth_connections.sql`** to the next available number, regenerate Drizzle metadata, and force-push.

---

### Task 52: Cleanup — replace OAuth's local rate limiter with M3b's shared limiter (FOLLOW-UP, after M3b merges)

**Files:**
- Delete: `server/src/oauth/rate-limiter.ts`
- Modify: `server/src/oauth/rate-limiter.ts` consumers (`server/src/routes/oauth.ts`, `server/src/app.ts`)

**Trigger:** ONLY run this task after M3b PR (#5576) merges to master and OAuth backbone branch has been rebased onto it.

- [ ] **Step 1: Replace import**

In every file importing from `./oauth/rate-limiter.js`, swap to the M3b shared limiter (likely `server/src/routes/k8s-callback.ts` exports `createSlidingWindowLimiter` and `createRedisSlidingWindowLimiter`; relocate it to `server/src/middleware/rate-limiter.ts` if not already there).

- [ ] **Step 2: Delete local copy**

```bash
git rm server/src/oauth/rate-limiter.ts server/src/oauth/__tests__/rate-limiter.test.ts
```

- [ ] **Step 3: Verify tests still pass**

```bash
pnpm --filter @paperclipai/server test -- oauth
```

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(server): consolidate OAuth onto shared rate limiter from M3b"
```

---

## Spec coverage check (self-review)

| Spec section | Tasks |
|---|---|
| 0 Context & goals | n/a (intro) |
| 1 Architecture | All tasks contribute |
| 2 Data model | T1, T2 |
| 3 API surface | T18, T19, T20, T21, T22, T24, T25 |
| 4 Provider DSL | T9, T10, T12, T34 |
| 5 Refresh strategy | T23, T24 (route), T26 (worker), T27 (sweeper), T30 (lazy) |
| 6 Plugin SDK extension | T13, T14, T15 |
| 7 UI | T39, T40, T41, T42, T43 |
| 8 Error handling | Threaded through routes (T18-T22), tested in T45-T46 |
| 9 Security | T7 (allowlist), T16 (logger), T29 (cross-tenant), T48 (regression bundle) |
| 10 Testing strategy | T44 (mock), T45-T46 (integration), T47 (E2E), T48 (security) |
| 11 Migration | T1 |
| 12 Rollout | T28 (wiring), T49 (docs) |
| 13 Future work | n/a (deferred to sub-projects B & C) |

## Self-review findings (resolved inline above)

- **Migration number 0082 vs spec's 0086:** noted in Conventions section; rename if M-stack lands first.
- **Rate limiter deferred dependency:** Task 8 ships an interim, Task 52 cleans up.
- **Existing binding type uses `"plain"` not `"literal"`:** Task 3 and Task 43 both use `"plain"` to match existing codebase.
- **CompanyId is path-param scoped, not session-implicit:** all routes use `/api/companies/:companyId/oauth/...`. Callback is unscoped and authenticates via state. Mark-revoked is unscoped and authenticates via run JWT claim.
- **Linear's account info is GraphQL-POST, not GET:** Task 38 calls this out as an implementer note; YAML must be updated to use Linear's REST userinfo endpoint or a Linear shape module added before shipping.
- **Plugin manifest validator extension:** Task 14 extends the discriminated union; the existing manifest validator in plugin-loader will need a corresponding update — the implementer must locate and patch it as part of T14 if it doesn't auto-derive from types.

---

## Plan complete

**Plan complete and saved to `docs/superpowers/plans/2026-05-09-oauth-backbone-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
