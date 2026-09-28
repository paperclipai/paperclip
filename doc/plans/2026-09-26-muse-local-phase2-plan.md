# Muse Code AI connection (`meta` provider), Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Muse a first-class Paperclip AI-connection provider (`meta`), like Grok's `xai`. Users can then connect a Muse Code subscription (terminal sign-in) or a Meta API key per user or per company, and `muse_local` agents run on it.

**Architecture:** `meta` joins `AI_PROVIDERS` with `subscription` and `api_key` methods for `muse_local`. Both methods store the bare `LLM|…` key as the connection secret, and runs receive it as `META_API_KEY`. Unlike Codex/Grok, meta is **not** an auth-file provider, so there is no file staging and no refresh merge. The local terminal sign-in runs `muse login` with an isolated `XDG_CONFIG_HOME` and the file credential backend. The verifier reads `<loginHome>/xdg/muse/auth.json`, extracts `providers.meta.api_key`, and checks it against `GET https://api.meta.ai/v1/models`. A DB migration widens the two provider CHECK constraints. The Apps catalog gets a generated `meta.json` definition and brand artwork. Sandbox device login stays in Phase 3.

**Tech Stack:** TypeScript, Vitest (embedded Postgres for server DB tests), Drizzle migrations, React UI, Node scripts for catalog generation.

**Spec:** `doc/plans/2026-09-26-muse-local-adapter-design.md` (rev 2, "Phase 2"). Builds on Phase 1 (`doc/plans/2026-09-26-muse-local-phase1-plan.md`, implemented on this branch).

## Global Constraints

- Provider id `meta`, display name `Muse`, subscription label `Muse subscription`, API key label `Muse API key`. Adapter `muse_local`. Env key `META_API_KEY` for **both** methods.
- Key verification endpoint (fixed, `redirect: "error"`, 15 s timeout): `GET https://api.meta.ai/v1/models` with `Authorization: Bearer <key>`. Verified live on 2026-09-26: 200 for a valid subscription key, 401 for a bogus one.
- Stored secret = the bare key string (matches `^LLM\|`). Never the whole `auth.json` (it holds an OAuth access token and the user's name and email).
- Local sign-in command, exactly: `(export XDG_CONFIG_HOME=<home>/xdg XDG_DATA_HOME=<home>/xdg-data TBH_CREDENTIAL_BACKEND=file MUSE_NO_AUTO_UPDATE=1 && mkdir -p "$XDG_CONFIG_HOME" && muse login)`, where `<home>` is shell-quoted.
- Credential file read with `readLocalAiCredentialFile` (enforces an owned, 0600 regular file ≤ max size). Muse writes 0600, as verified in Phase 0.
- Error messages from providers and the CLI never reach the client (the existing redacted messages are reused).
- Sandbox device login for meta is **not** offered in Phase 2 (`canLogin` false for meta).
- Brand artwork: a PNG is allowed only when no official SVG exists (CONNECTOR-PLAYBOOK Phase 4). The Muse mark comes from the official `Muse.app` icon (`/Applications/Muse.app/Contents/Resources/AppIcon.icns`), and the provenance is recorded in `ui/public/brands/apps/README` / the review record, not the manifest.
- Telemetry contract untouched (privacy review required; deferred as in Phase 1).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A Muse subscription connection must never store or log the `auth.json` contents (email, OAuth token). Only the `LLM|` key is saved. Pinned in Task 4 ("stores only the api key").
2. The terminal sign-in's credential must come only from the attempt's isolated login home, never from the operator's own `~/.config/muse` or keychain. Pinned in Task 4 ("never clones the ambient meta login").
3. A run on a meta connection must receive `META_API_KEY` and must not keep a stale ambient `META_API_KEY` from agent config. Pinned in Task 3 (runtime test asserts value and that the ambient override was replaced).
4. A 401 from Meta during API-key entry or sign-in must show the generic redacted message, not the provider body. Pinned in Task 4 (`validateAiApiKey("meta", …)` test).
5. In a sandbox environment the Muse subscription tile must not offer a device-login button that would fail. Pinned in Task 6 (credential-step test).

---

## File Structure

Modified (by area):
- shared: `packages/shared/src/ai-connections.ts`, `packages/shared/src/validators/agent.ts`, `packages/shared/src/app-definitions.ts`, generated `packages/shared/src/app-definitions.generated.ts` + new `packages/shared/src/app-definitions/meta.json`
- db: `packages/db/src/schema/ai_provider_defaults.ts`, `packages/db/src/schema/ai_connection_defaults.ts`, new migration `packages/db/src/migrations/0285_*.sql` + meta snapshot/journal
- adapter: `packages/adapters/muse-local/src/server/muse-auth.ts` (new), `index.ts` export
- server: `services/ai-connection-runtime.ts`, `services/agent-ai-connection-default.ts`, `services/local-ai-credentials.ts`, `services/local-ai-login.ts`, `routes/ai-connections.ts`, `routes/agents.ts`
- catalog/branding: `scripts/ingest-app-definitions.mjs`, `ui/public/brands/apps/manifest.json`, `ui/public/brands/apps/meta.png`
- ui: `components/ai-connections/{model.ts,AiConnectionField.tsx,AiConnectionCredentialStep.tsx,ManagedAiConnectionDetails.tsx}`, `components/onboarding/SavedProviderKeySelect.tsx`, `lib/provider-credential.ts`, `components/new-agent/{AgentProviderConnection.tsx,NewAgentSetup.tsx}`, `components/AdapterLoginChrome.tsx`
- docs: `doc/connections/AI-CONNECTIONS.md`

---

### Task 1: Shared provider definition

**Files:**
- Modify: `packages/shared/src/ai-connections.ts` (`AI_PROVIDERS`, `AI_CONNECTION_CAPABILITIES`)
- Modify: `packages/shared/src/validators/agent.ts` (`testCredentials`: add `META_API_KEY: z.string().max(16384),` after `XAI_API_KEY`)
- Test: `packages/shared/src/ai-connections.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `AiProvider` includes `"meta"`; `AI_CONNECTION_CAPABILITIES.meta = { name: "Muse", methods: { subscription: { adapters: ["muse_local"], envKey: "META_API_KEY" }, api_key: { adapters: ["muse_local"], envKey: "META_API_KEY" } } }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { AI_CONNECTION_CAPABILITIES, AI_PROVIDERS, aiProviderSchema, isAiConnectionCompatible } from "./ai-connections.js";

describe("meta (Muse) AI provider", () => {
  it("is a provider with subscription and api_key methods for muse_local via META_API_KEY", () => {
    expect(AI_PROVIDERS).toContain("meta");
    expect(aiProviderSchema.parse("meta")).toBe("meta");
    expect(AI_CONNECTION_CAPABILITIES.meta).toEqual({
      name: "Muse",
      methods: {
        subscription: { adapters: ["muse_local"], envKey: "META_API_KEY" },
        api_key: { adapters: ["muse_local"], envKey: "META_API_KEY" },
      },
    });
  });

  it("is compatible only with muse_local", () => {
    const binding = { provider: "meta", method: "subscription", mode: "responsible_user" } as const;
    expect(isAiConnectionCompatible(binding, "muse_local")).toBe(true);
    expect(isAiConnectionCompatible(binding, "grok_local")).toBe(false);
    expect(isAiConnectionCompatible({ provider: "meta", method: "api_key" }, "muse_local")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and verify it fails** — `pnpm exec vitest run packages/shared/src/ai-connections.test.ts`. Expected: FAIL (`meta` not in `AI_PROVIDERS`).

- [ ] **Step 3: Implement.** Append `"meta",` to `AI_PROVIDERS` (after `"xai"`). Add after the `xai` capability:
```ts
  meta: {
    name: "Muse",
    methods: {
      subscription: { adapters: ["muse_local"], envKey: "META_API_KEY" },
      api_key: { adapters: ["muse_local"], envKey: "META_API_KEY" },
    },
  },
```
Add `META_API_KEY: z.string().max(16384),` to `testCredentials` in `validators/agent.ts`. Leave `aiSubscriptionNeedsIsolatedLogin` unchanged: it only flags preview-era openai/xai rows, and meta has none.

- [ ] **Step 4: Run it and verify it passes, then typecheck shared** — `pnpm exec vitest run packages/shared/src/ai-connections.test.ts && (cd packages/shared && pnpm exec tsc --noEmit)`. Expected: PASS, exit 0. Server and UI now fail to typecheck at every `Record<AiProvider, …>`. That's expected, and Tasks 3–6 fix them.

- [ ] **Step 5: Commit** — `git add packages/shared && git commit -m "feat(ai-connections): add meta (Muse) provider definition"` (with the Co-Authored-By trailer).

---

### Task 2: Muse auth-file parser in the adapter

**Files:**
- Create: `packages/adapters/muse-local/src/server/muse-auth.ts`, `muse-auth.test.ts`
- Modify: `packages/adapters/muse-local/src/server/index.ts` (export)

**Interfaces:**
- Produces: `parseMuseAuthApiKey(raw: string): string | null`. It returns `providers.meta.api_key` when that matches `/^LLM\|[A-Za-z0-9_\-|]{20,200}$/`, otherwise null. It never throws.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseMuseAuthApiKey } from "./muse-auth.js";

const KEY = "LLM|123456789012345|abcdefghijklmnopqrstuvwxyzAB";
const file = (meta: Record<string, unknown>) => JSON.stringify({ schema_version: 1, providers: { meta } });

describe("parseMuseAuthApiKey", () => {
  it("returns the api key from a file-backend device login", () => {
    expect(parseMuseAuthApiKey(file({ mechanism: "oauth", obtained_via: "device_code", api_base_url: "https://api.meta.ai/v1", api_key: KEY, access_token: "dca:secret", user_email: "a@b.c", user_full_name: "A B" }))).toBe(KEY);
  });
  it("accepts an api-key-only file (muse auth set)", () => {
    expect(parseMuseAuthApiKey(file({ api_key: KEY }))).toBe(KEY);
  });
  it.each([
    ["keychain pointer without key", file({ mechanism: "oauth", storage: "keychain" })],
    ["non-LLM key", file({ api_key: "sk-not-meta" })],
    ["invalid json", "{nope"],
    ["missing providers", JSON.stringify({ schema_version: 1 })],
    ["array", "[]"],
  ])("rejects %s", (_name, raw) => {
    expect(parseMuseAuthApiKey(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and verify it fails** — `pnpm exec vitest run packages/adapters/muse-local/src/server/muse-auth.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `muse-auth.ts`:
```ts
// Reads the Meta API key out of a Muse `auth.json` written with
// TBH_CREDENTIAL_BACKEND=file. Only the key is ever returned; the file's OAuth
// access token and identity fields are ignored.

const MUSE_API_KEY_RE = /^LLM\|[A-Za-z0-9_\-|]{20,200}$/;

export function parseMuseAuthApiKey(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const providers = (parsed as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null) return null;
  const meta = (providers as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return null;
  const key = (meta as Record<string, unknown>).api_key;
  return typeof key === "string" && MUSE_API_KEY_RE.test(key) ? key : null;
}
```
Add `export { parseMuseAuthApiKey } from "./muse-auth.js";` to `src/server/index.ts`.

- [ ] **Step 4: Run it and verify it passes** — the same command; Expected: PASS (7 tests). Then `pnpm --filter @paperclipai/adapter-muse-local typecheck` exits 0.

- [ ] **Step 5: Commit** — `feat(muse-local): parse the Meta API key from a Muse auth file`.

---

### Task 3: DB migration and run-time staging

**Files:**
- Modify: `packages/db/src/schema/ai_provider_defaults.ts:19` and `packages/db/src/schema/ai_connection_defaults.ts:45` (add `'meta'` to both CHECK lists)
- Generate: `packages/db/src/migrations/0285_*.sql` + `meta/0285_snapshot.json` + `meta/_journal.json`
- Modify: `server/src/services/ai-connection-runtime.ts` (`AI_AUTH_ENV_KEYS`, `subscriptionFile`)
- Modify: `server/src/services/agent-ai-connection-default.ts` (`PROVIDER_AUTH_ENV_KEYS.meta`)
- Test: `server/src/__tests__/ai-connections.test.ts` (new `it` in "managed AI connections")

**Interfaces:**
- Consumes: Task 1 capability.
- Produces: `prepareManagedAiRuntime` for a meta binding returns `config.env.META_API_KEY === <stored key>` and writes no `auth.json`.

- [ ] **Step 1: Write the failing test.** Add it inside `describe("managed AI connections", …)` after the first `it.each`:

```ts
  it("runs a muse_local agent with each responsible user's Muse subscription or API key as META_API_KEY", async () => {
    const subscriptionUser = "meta-subscription-user";
    const apiUser = "meta-api-user";
    await db.insert(companyMemberships).values([subscriptionUser, apiUser].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
    const subscriptionKey = "LLM|111111111111111|subscriptionfixturekey0000";
    await service.save(companyId, subscriptionUser, { provider: "meta", method: "subscription", ownership: "personal", name: "Muse subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, subscriptionKey);
    await service.save(companyId, apiUser, { provider: "meta", method: "api_key", ownership: "personal", name: "Muse API", apiKey: "fixture", allAgents: true, agentIds: [] }, "LLM|222222222222222|apifixturekey00000000000");
    const bot = { ...input, adapterType: "muse_local", binding: { provider: "meta", method: "subscription", mode: "responsible_user" } as const, config: { model: "muse-spark-1.3", env: { META_API_KEY: "ambient-override" } } };
    const [subRun, apiRun] = await Promise.all([subscriptionUser, apiUser].map(responsibleUserId => prepareManagedAiRuntime(db, { ...bot, responsibleUserId })));
    try {
      const subEnv = subRun.config.env as Record<string, string>;
      const apiEnv = apiRun.config.env as Record<string, string>;
      expect(subEnv.META_API_KEY).toBe(subscriptionKey);
      expect(apiEnv.META_API_KEY).toBe("LLM|222222222222222|apifixturekey00000000000");
      await expect(access(path.join(subRun.home!, "provider", "auth.json"))).rejects.toThrow();
    } finally { await Promise.all([subRun.cleanup(), apiRun.cleanup()]); }
  });
```

- [ ] **Step 2: Run it and verify it fails** — `pnpm exec vitest run server/src/__tests__/ai-connections.test.ts -t "Muse subscription"`. Expected: FAIL. Either the DB CHECK violation (`ai_connection_defaults_provider_check`) or `META_API_KEY` missing / `auth.json` present.

- [ ] **Step 3: Migration.** Edit both schema CHECK strings to `in ('anthropic','openai','openrouter','xai','meta')`. Run `pnpm db:generate`. Inspect the new SQL: it must only drop and re-add the two CHECK constraints. If drizzle emits anything else, stop and investigate. Run `pnpm --filter @paperclipai/db check:migrations` and expect "Migration safety check passed".

- [ ] **Step 4: Runtime.** In `ai-connection-runtime.ts`:
  - add `"META_API_KEY",` to `AI_AUTH_ENV_KEYS` (after `"GROK_API_KEY",`). This blanks any ambient value before staging;
  - change `subscriptionFile` to
```ts
  const subscriptionFile =
    selection.attribution.method === "subscription" &&
    input.binding.provider !== "anthropic" &&
    input.binding.provider !== "meta";
```
  so that meta subscriptions take the `env[capability.envKey] = value` path. In `agent-ai-connection-default.ts` add `meta: ["META_API_KEY"],` to `PROVIDER_AUTH_ENV_KEYS`.

- [ ] **Step 5: Run the test and verify it passes** — the same command; Expected: PASS. Then run the whole file: `pnpm exec vitest run server/src/__tests__/ai-connections.test.ts`. Expected: every test passes except any that also fail on the Phase 1 head (compare with `git stash` if something unrelated fails).

- [ ] **Step 6: Commit** — `feat(ai-connections): allow meta in provider defaults and stage META_API_KEY for runs`.

---

### Task 4: Local terminal sign-in, key validation, and agent wiring

**Files:**
- Modify: `server/src/services/local-ai-credentials.ts`, `server/src/services/local-ai-login.ts`, `server/src/routes/ai-connections.ts`, `server/src/routes/agents.ts`
- Test: `server/src/__tests__/local-ai-credentials.test.ts`, `server/src/__tests__/ai-connections.test.ts`

**Interfaces:**
- Consumes: `parseMuseAuthApiKey` (Task 2).
- Produces: `readVerifiedLocalAiCredential("meta", loginHome)` returns the bare key. `localAiLoginService.start(... { provider: "meta" })` returns a `command` matching the Global Constraints string. `validateAiApiKey("meta", key)` calls the fixed Meta endpoint.

- [ ] **Step 1: Write the failing tests.** In `local-ai-credentials.test.ts`, add `muse: vi.fn()` to the hoisted mocks and `vi.mock("@paperclipai/adapter-muse-local/server", () => ({ parseMuseAuthApiKey: mocks.muse }));` next to the other adapter mocks. Then add:
```ts
  it("verifies a Muse subscription from the isolated login's XDG config and stores only the api key", async () => {
    const raw = JSON.stringify({ providers: { meta: { api_key: "LLM|fixture", access_token: "dca:secret", user_email: "x@y.z" } } });
    mocks.credentialFile.mockResolvedValue(raw);
    mocks.muse.mockReturnValue("LLM|fixture");
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await expect(readVerifiedLocalAiCredential("meta", "/isolated/muse")).resolves.toBe("LLM|fixture");
    expect(mocks.credentialFile).toHaveBeenCalledWith("/isolated/muse/xdg/muse/auth.json");
    expect(mocks.muse).toHaveBeenCalledWith(raw);
    expect(fetch).toHaveBeenCalledWith("https://api.meta.ai/v1/models", expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer LLM|fixture" } }));
  });
  it("rejects a Muse login the provider refuses, without leaking the key", async () => {
    mocks.credentialFile.mockResolvedValue("{}");
    mocks.muse.mockReturnValue("LLM|fixture");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("key LLM|fixture rejected", { status: 401 })));
    const error = await readVerifiedLocalAiCredential("meta", "/isolated/muse").catch((e: Error) => e);
    expect(String(error)).toContain("sign-in command shown");
    expect(String(error)).not.toContain("LLM|fixture");
  });
```
Change the existing `it.each(["openai", "xai"] as const)("never clones the ambient rotating %s login"…` to `it.each(["openai", "xai", "meta"] as const)` and add `expect(mocks.credentialFile).not.toHaveBeenCalled();` to its body.

In `ai-connections.test.ts`, next to the "rejects invalid credentials without exposing the provider response" test, add:
```ts
  it("validates Muse API keys against the fixed Meta endpoint", async () => {
    const ok = vi.fn().mockResolvedValue(new Response("{}"));
    await validateAiApiKey("meta", "LLM|fixture", ok);
    expect(ok).toHaveBeenCalledWith("https://api.meta.ai/v1/models", expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer LLM|fixture" } }));
    const rejected = vi.fn().mockResolvedValue(new Response("secret-provider-body", { status: 401 }));
    await expect(validateAiApiKey("meta", "LLM|fixture", rejected)).rejects.toThrow("The provider rejected this API key.");
  });
```

- [ ] **Step 2: Run them and verify they fail** — `pnpm exec vitest run server/src/__tests__/local-ai-credentials.test.ts server/src/__tests__/ai-connections.test.ts -t "Muse|ambient"`. Expected: FAIL (meta falls through to the Grok branch / missing endpoint).

- [ ] **Step 3: Implement `local-ai-credentials.ts`.** Import `parseMuseAuthApiKey` from `@paperclipai/adapter-muse-local/server`. Change the isolated-home guard to `(provider === "openai" || provider === "xai" || provider === "meta") && !loginHome`. Insert before the Grok fallthrough:
```ts
    if (provider === "meta") {
      const raw = await readLocalAiCredentialFile(path.join(loginHome!, "xdg", "muse", "auth.json"));
      const key = parseMuseAuthApiKey(raw);
      if (!key) throw new Error("Missing login");
      const response = await fetch("https://api.meta.ai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error", signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Invalid login");
      return key;
    }
```
Add `"@paperclipai/adapter-muse-local": "workspace:*"` to `server/package.json` if it isn't already there (Phase 1 added it; verify).

- [ ] **Step 4: Implement `local-ai-login.ts`.** In `presentAttempt`, give meta its own branch before the Grok fallthrough:
```ts
      : provider === "meta"
        ? `(export XDG_CONFIG_HOME=${shellQuote(path.join(directory, "xdg"))} XDG_DATA_HOME=${shellQuote(path.join(directory, "xdg-data"))} TBH_CREDENTIAL_BACKEND=file MUSE_NO_AUTO_UPDATE=1 && mkdir -p "$XDG_CONFIG_HOME" && muse login)`
```
The command is a nested ternary: insert this arm between the `anthropic` arm and the final Grok arm, keeping the Grok string last. In `start`: extend the guard to allow `intent.provider !== "meta"`, and map the adapter type as `intent.provider === "openai" ? "codex_local" : intent.provider === "anthropic" ? "claude_local" : intent.provider === "meta" ? "muse_local" : "grok_local"`.

Add to `server/src/__tests__/local-ai-login-policy.test.ts` (read its setup first and follow it) a case asserting that the meta attempt's `command` equals the Global Constraints string for that attempt's directory.

- [ ] **Step 5: Implement routes.** `routes/ai-connections.ts`: add `meta: "https://api.meta.ai/v1/models",` to `validateAiApiKey` endpoints. Line ~305: `if (localSessionId || input.provider === "openai" || input.provider === "xai" || input.provider === "meta")`. `routes/agents.ts`: add `meta: "muse_local"` to the `providerAdapter` map (line ~3330) and `muse_local: ["META_API_KEY"],` to `INHERITABLE_AGENT_CREDENTIAL_ENV_KEYS` (line ~2538).

- [ ] **Step 6: Run the tests and typecheck the server** — `pnpm exec vitest run server/src/__tests__/local-ai-credentials.test.ts server/src/__tests__/ai-connections.test.ts server/src/__tests__/local-ai-login-policy.test.ts && (cd server && pnpm exec tsc --noEmit)`. Expected: PASS; exit 0 (all server `Record<AiProvider>` sites are now covered).

- [ ] **Step 7: Commit** — `feat(ai-connections): Muse terminal sign-in, key validation and agent wiring`.

---

### Task 5: Apps catalog entry and brand artwork

**Files:**
- Create: `ui/public/brands/apps/meta.png` (from the official Muse.app icon)
- Modify: `ui/public/brands/apps/manifest.json`, `scripts/ingest-app-definitions.mjs:1612-1614`, `packages/shared/src/app-definitions.ts:7`
- Generated: `packages/shared/src/app-definitions/meta.json`, `packages/shared/src/app-definitions.generated.ts`
- Test: `packages/shared/src/app-definitions.test.ts`

**Interfaces:**
- Produces: `APP_DEFINITIONS` contains slug `meta` with methods `ai-subscription` and `ai-api_key` (runtime_auth, provider meta), and `CONNECTABLE_APP_SLUGS.has("meta")`.

- [ ] **Step 1: Write the failing test.** Add next to the Anthropic runtime-auth assertion (~line 238):
```ts
  it("offers Muse as a runtime_auth AI provider", () => {
    const meta = APP_DEFINITIONS.find((definition) => definition.slug === "meta");
    expect(meta?.name).toBe("Muse");
    expect(meta?.methods.map((method) => method.key)).toEqual(["ai-subscription", "ai-api_key"]);
    expect(meta?.methods.every((method) => method.purpose === "ai" && method.transport === "runtime_auth" && method.ai?.provider === "meta")).toBe(true);
    expect(CONNECTABLE_APP_SLUGS.has("meta")).toBe(true);
  });
```
(Import `APP_DEFINITIONS` / `CONNECTABLE_APP_SLUGS` the way the file already does.) Run `pnpm exec vitest run packages/shared/src/app-definitions.test.ts -t Muse`. Expected: FAIL.

- [ ] **Step 2: Artwork.** Make a 256×256 transparent-cornered PNG from the official icon:
```bash
sips -s format png -Z 512 /Applications/Muse.app/Contents/Resources/AppIcon.icns --out /tmp/muse512.png
sips -c 416 416 /tmp/muse512.png --out /tmp/muse416.png && sips -Z 256 /tmp/muse416.png --out ui/public/brands/apps/meta.png
```
Add the manifest entry next to `xai`:
```json
{
  "slug": "meta",
  "provider": "Muse",
  "catalogVisible": true,
  "localAsset": "/brands/apps/meta.png"
}
```
There's no dark asset: the icon has its own light tile and works on both frames. Record provenance ("official Muse.app AppIcon.icns, Muse Code 1.4.0, no official SVG published") in the PR description / review record, not the manifest.

- [ ] **Step 3: Catalog source.** In `scripts/ingest-app-definitions.mjs`, append `["meta", "Muse", true, "META_API_KEY"]` to the AI provider tuple (line ~1612) and `"meta": "https://api.meta.ai/*"` to the URL map (line ~1614). Add `"meta"` to `CONNECTABLE_APP_SLUGS` after `"xai"` in `packages/shared/src/app-definitions.ts`. Run `node scripts/ingest-app-definitions.mjs --definitions-only`. Check the diff: only `app-definitions/meta.json` (new) and `app-definitions.generated.ts` should change. Revert any unrelated churn.

- [ ] **Step 4: Run the tests and brand checks** — `pnpm exec vitest run packages/shared/src/app-definitions.test.ts ui/src/lib/app-brand-assets.test.ts ui/src/pages/apps/AppLogo.brand-assets.test.tsx && node scripts/check-app-brand-assets.mjs && node --test scripts/app-brand-validation.test.mjs`. Expected: all pass.

- [ ] **Step 5: Commit** — `feat(apps): Muse AI provider catalog entry and artwork`.

---

### Task 6: UI provider surfaces

**Files:**
- Modify: `ui/src/components/ai-connections/model.ts`, `AiConnectionField.tsx` (map line ~32, name chain ~163), `AiConnectionCredentialStep.tsx` (~72 `canLogin`, ~86 adapter mapping), `ManagedAiConnectionDetails.tsx:18`, `ui/src/components/onboarding/SavedProviderKeySelect.tsx:20`, `ui/src/lib/provider-credential.ts`, `ui/src/components/new-agent/AgentProviderConnection.tsx` (49, 92-95), `ui/src/components/new-agent/NewAgentSetup.tsx` (121, 716, 925), `ui/src/components/AdapterLoginChrome.tsx` (52, 475-476)
- Test: `ui/src/components/ai-connections/AiConnectionCredentialStep.test.tsx` (create; follow the render/mocking pattern of the nearest existing `ui/src/components/ai-connections/*.test.tsx`)

**Interfaces:**
- Consumes: `AiProvider` with `meta` (Task 1).
- Produces: `AI_PROVIDERS.meta = { name: "Muse", subscriptionName: "Muse subscription", logo: "/brands/adapters/muse.png" }`; `aiProviderForAdapter("muse_local") === "meta"`.

- [ ] **Step 1: Write the failing test.** Render `SubscriptionConnectionStep` (or the exported step component used for subscriptions) with `provider="meta"` and a sandbox environment whose provider has `supportsLoginPty: true`. Assert `AgentProviderConnection` receives `adapterType="muse_local"` and `canLogin={false}`. Also render with `provider="xai"` in the same environment and assert `canLogin={true}` (that the guard is meta-specific). Mock `AgentProviderConnection` with `vi.mock` so the test reads its props. Run `pnpm exec vitest run ui/src/components/ai-connections/AiConnectionCredentialStep.test.tsx`. Expected: FAIL.

- [ ] **Step 2: Implement all UI arms.**
  - `model.ts`: add `meta: { name: "Muse", subscriptionName: "Muse subscription", logo: "/brands/adapters/muse.png" },`.
  - `AiConnectionField.tsx`: `muse_local: "meta",` in `aiProviderForAdapter`; the name chain gains `: provider === "meta" ? "Muse"` before `"OpenRouter"`.
  - `AiConnectionCredentialStep.tsx`: `const canLogin = provider !== "meta" && environment?.driver === "sandbox" && …` (sandbox device login is Phase 3); the adapter mapping becomes `provider === "anthropic" ? "claude_local" : provider === "xai" ? "grok_local" : provider === "meta" ? "muse_local" : "codex_local"`.
  - `ManagedAiConnectionDetails.tsx:18`: add `| "meta"`.
  - `SavedProviderKeySelect.tsx:20`: add `META_API_KEY: "meta"`.
  - `provider-credential.ts`: add `meta: "META_API_KEY",`.
  - `AgentProviderConnection.tsx`: widen the `adapterType` union with `| "muse_local"`; `provider` → `... : adapterType === "muse_local" ? "Muse" : "OpenAI"`; env key → `... : adapterType === "muse_local" ? "META_API_KEY" : "OPENAI_API_KEY"`; aiProvider → `... : adapterType === "muse_local" ? "meta" : "openai"`.
  - `NewAgentSetup.tsx`: line 121 include `|| brandType === "muse_local"`; line 716 lede `: connectionAdapter === "muse_local" ? "Muse"`; line 925 map add `meta: "Meta",`.
  - `AdapterLoginChrome.tsx`: `CONNECT_SOURCE_NAMES.muse_local = "Muse"`; `provider` chain `: adapterType === "muse_local" ? "Muse Code"`; `isolated` default includes `|| adapterType === "muse_local"`.

- [ ] **Step 3: Run the tests, typecheck and token gates** — `pnpm exec vitest run ui/src/components/ai-connections ui/src/components/new-agent ui/src/pages/NewAgent.test.tsx && (cd ui && pnpm run typecheck) && pnpm check:token-gates`. Expected: PASS / exit 0 / "All gates clean". When an existing test enumerates providers exhaustively, add `meta` next to `xai`.

- [ ] **Step 4: Commit** — `feat(ui): Muse AI connection provider surfaces`.

---

### Task 7: Verification, live smoke test, docs

**Files:**
- Modify: `doc/connections/AI-CONNECTIONS.md` (provider table: `| Muse / Meta | Muse Code subscription or Meta API key | Muse Code |`; the sentence "Codex and Grok start a separate terminal sign-in" becomes "Codex, Grok and Muse …")
- Modify: spec status line; vault note

- [ ] **Step 1: Targeted suites** — `pnpm exec vitest run packages/shared packages/adapters/muse-local server/src/__tests__/ai-connections.test.ts server/src/__tests__/local-ai-credentials.test.ts server/src/__tests__/local-ai-login-policy.test.ts server/src/__tests__/agent-hire-ai-connections.test.ts ui/src/components/ai-connections`, plus `tsc --noEmit` in shared/server/cli and `pnpm run typecheck` in ui. Expected: green. Compare any failures against the Phase 1 head.

- [ ] **Step 2: Live smoke test** (dev server: `PAPERCLIP_RUNNER_BINARY=/usr/bin/false pnpm dev`; applies migration 0285):
  1. In the UI, go to Connections → Muse → subscription → Start sign-in. Run the printed command in a terminal and approve the device code (**the user approves in the browser**). Then click Connect and expect a saved connection. The DB secret must equal a 48-char `LLM|` string, with no email or `access_token` (check via `select` on company_secrets ciphertext absence is not possible, so instead assert through the API that the connection summary shows no email, and grep server logs for `dca:`/`@` absence).
  2. Put the smoke agent (Phase 1, `muse_local`) on the new connection (responsible_user binding), wake it on a new issue, and expect a successful run whose env had `META_API_KEY` injected (run meta `env` shows the key redacted).
  3. API key path: Connections → Muse → API key with a bogus key. Expect "The provider rejected this API key." A valid key (the same `LLM|` key) is saved.
- [ ] **Step 3: Docs and commit** — update `AI-CONNECTIONS.md`, the spec status ("Phase 2 implemented"), and the vault note. Commit `docs: Muse AI connection provider (phase 2)`.
