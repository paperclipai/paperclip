# Wish: CLI & Board Authentication for Paperclip API

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `cli-board-auth` |
| **Date** | 2026-03-17 |
| **Trace** | Inline trace from PM session — 95% confidence |

## Summary

Paperclip has no mechanism for human operators or CLI users to authenticate to the API in `authenticated` deployment mode. Bearer tokens always resolve to agent actors, session cookies are browser-only, and the CLI has no `auth login` command. This creates a chicken-and-egg problem on fresh instances (can't create agents without board auth, can't get board auth without agents) and blocks all CLI-driven board operations.

## Scope

### IN
- `paperclipai auth login` CLI command (email/password → session stored in context profile)
- User API keys (Personal Access Tokens) — DB table, CRUD endpoints, auth middleware resolution
- `paperclipai auth create-key` CLI command (generates PAT from authenticated session)
- `paperclipai auth whoami` CLI command (shows current auth identity)
- Auth middleware update: Bearer PATs resolve to `type: "board"` actor
- `boardMutationGuard` exempts PAT-authenticated board actors
- CLI `PaperclipApiClient` updated to attach stored session or PAT

### OUT
- OAuth2/OIDC flows (future work, not needed for personal/small-team instances)
- Agent API key changes (existing agent JWT/key system is fine)
- UI changes (browser auth already works via better-auth)
- Multi-factor authentication
- Rate limiting for PATs

## Decisions

| Decision | Rationale |
|----------|-----------|
| PATs over long-lived session tokens | PATs are explicit, revocable, and standard for CLI/CI auth. Session tokens expire and require cookie management. |
| Store PAT in CLI context profile | Consistent with existing `paperclipai context set` pattern. Profile already has `apiKeyEnvVarName` field. |
| Session login as bootstrap for PAT creation | User logs in once via email/password, creates a PAT, then uses the PAT for all subsequent CLI calls. |
| PAT resolves as `type: "board"` with `source: "user_api_key"` | Keeps the actor model clean. Board permissions flow from the user's company memberships. |
| Hash PATs server-side (SHA-256) | Same pattern as existing `agent_api_keys`. Never store plaintext. Show full key only once at creation. |
| Key format: `pclip_<random-32-hex>`, prefix = first 8 chars (`pclip_xx`) | Clear provenance, easy to identify in logs without exposing full key. |
| Precondition: user must exist (via UI sign-up or `onboard` wizard) | Fresh instance bootstrap starts with UI sign-up or `paperclipai onboard`, then CLI login. Not our problem to solve user creation here. |

## Success Criteria

- [ ] Precondition documented: user account must exist before `auth login` (created via UI or `paperclipai onboard`)
- [ ] `paperclipai auth login --email felipe@namastex.ai` authenticates and stores session in context
- [ ] `paperclipai auth create-key --name "cli"` creates a PAT and prints it once
- [ ] `paperclipai auth whoami` shows current identity (user name, email, companies, auth source)
- [ ] CLI commands using stored PAT can call board-only endpoints (`GET /api/companies`, `POST /api/companies/:id/agent-hires`)
- [ ] Fresh instance bootstrap works: login → create agent → local-cli → agent runs heartbeat
- [ ] PATs can be listed and revoked via `paperclipai auth list-keys` / `paperclipai auth revoke-key`
- [ ] Existing agent JWT and agent API key auth paths are unaffected
- [ ] `boardMutationGuard` allows PAT-authenticated mutations without Origin/Referer header
- [ ] `pnpm -r typecheck && pnpm test:run` pass

## Execution Groups

### Group 1: DB Schema — User API Keys Table

**Goal:** Add the `user_api_keys` table to the Drizzle schema.

**Deliverables:**
1. New schema file `packages/db/src/schema/user-api-keys.ts` with columns: `id` (uuid), `userId` (text, FK to user), `companyId` (uuid, FK to companies, nullable — null means all companies), `name` (text), `keyPrefix` (text, first 8 chars for identification), `keyHash` (text, SHA-256), `lastUsedAt` (timestamptz), `revokedAt` (timestamptz), `expiresAt` (timestamptz, nullable), `createdAt` (timestamptz)
2. Export from `packages/db/src/schema/index.ts`
3. Migration generated via `pnpm --filter @paperclipai/db generate`

**Acceptance criteria:**
- Table exists in schema with proper indexes (`keyHash` unique, `userId` index)
- Foreign keys reference `user` and `companies` tables
- Migration applies cleanly

**Validation:**
```bash
cd /home/genie/prod/paperclip && pnpm --filter @paperclipai/db generate && pnpm -r typecheck
```

**depends-on:** none

---

### Group 2: Auth Middleware — PAT Resolution

**Goal:** Extend `actorMiddleware` to resolve Bearer PATs as board actors.

**Deliverables:**
1. In `server/src/middleware/auth.ts`, after agent key/JWT checks fail, check `user_api_keys` table for matching `keyHash` (SHA-256 of full key)
2. If found: check `revokedAt` is null AND (`expiresAt` is null OR `expiresAt > now()`) — reject with 401 if either fails
3. If valid: resolve actor as `{ type: "board", userId, companyIds: [...], isInstanceAdmin, source: "user_api_key" }`
4. Update `lastUsedAt` on the key (async, non-blocking)
5. In `server/src/middleware/board-mutation-guard.ts` line ~47, add `source: "user_api_key"` to the exemption alongside `local_implicit`:
   ```ts
   if (actor.source === "local_implicit" || actor.source === "user_api_key") return next();
   ```

**Acceptance criteria:**
- A valid PAT in `Authorization: Bearer <pat>` header resolves to a board actor
- Revoked PATs (`revokedAt` set) are rejected with 401
- Expired PATs (`expiresAt < now()`) are rejected with 401
- PATs with `expiresAt: null` never expire (until revoked)
- Board mutations work without Origin header when using PAT
- Existing agent auth paths are unaffected (agent keys checked first)
- Unit test for each rejection case (revoked, expired, valid)

**Validation:**
```bash
cd /home/genie/prod/paperclip && pnpm test:run -- --grep "auth|middleware"
```

**depends-on:** Group 1

---

### Group 3: PAT CRUD API Endpoints

**Goal:** Add endpoints for creating, listing, and revoking user API keys.

**Deliverables:**
1. `POST /api/users/me/api-keys` — creates PAT, returns `{ id, name, key, keyPrefix, createdAt }` (key shown only once)
2. `GET /api/users/me/api-keys` — lists all PATs for current user (without key, with keyPrefix)
3. `DELETE /api/users/me/api-keys/:keyId` — revokes a PAT (sets `revokedAt`)
4. All endpoints require `assertBoard` (session or PAT auth)
5. New route file `server/src/routes/user-api-keys.ts`, registered in server

**Acceptance criteria:**
- Creating a key returns the full key exactly once
- Listing keys never returns the full key
- Revoking a key prevents future auth with that key
- Only the key owner can list/revoke their own keys

**Validation:**
```bash
cd /home/genie/prod/paperclip && pnpm test:run -- --grep "user-api-key"
```

**depends-on:** Group 1, Group 2

---

### Group 4: CLI Auth Commands

**Goal:** Add `paperclipai auth login`, `auth create-key`, `auth whoami`, `auth list-keys`, `auth revoke-key`.

**Deliverables:**
1. `paperclipai auth login --email <email>` — prompts for password (or takes `--password` flag), calls `POST /api/auth/sign-in/email` with JSON body `{"email","password"}`, extracts `better-auth.session_token` from `Set-Cookie` response header, stores in context profile as `sessionToken`. Output: `Logged in as <name> (<email>)`
2. `paperclipai auth create-key --name <name>` — calls `POST /api/users/me/api-keys` using session auth (cookie header), stores returned PAT in context profile as `apiKey`, prints key once. Output:
   ```
   Created API key: pclip_a1b2c3d4e5f6...
   Key stored in profile 'default'. This key will not be shown again.
   ```
3. `paperclipai auth whoami` — calls `GET /api/users/me` (new endpoint, see below), prints identity. Output:
   ```
   User: Felipe Rosa (felipe@namastex.ai)
   Companies: Namastex Labs (owner)
   Auth: user_api_key (pclip_a1b2...)
   ```
4. `paperclipai auth list-keys` — calls `GET /api/users/me/api-keys`, prints table with columns: ID, Name, Prefix, Created, Last Used, Status
5. `paperclipai auth revoke-key <keyId>` — calls `DELETE /api/users/me/api-keys/:keyId`
6. New server endpoint `GET /api/users/me` — returns `{ id, name, email, companies: [{id, name, role}], authSource }` for the current board actor
7. Update `PaperclipApiClient` (`cli/src/client/http.ts`): check `apiKey` in context → send as `Authorization: Bearer`; fallback to `sessionToken` → send as `Cookie: better-auth.session_token=<token>`

**Acceptance criteria:**
- Full flow works: `auth login` → `auth create-key` → use key for all CLI commands
- `auth whoami` works with both session and PAT auth
- Keys persist across CLI invocations via context profile
- Password prompt uses `readline` with hidden input (no echo)
- Error messages are clear: "Invalid credentials", "Session expired, run `auth login` again"

**Validation:**
```bash
cd /home/genie/prod/paperclip && pnpm -r typecheck && pnpm test:run -- --grep "cli.*auth|auth.*command"
```

**depends-on:** Group 3

---

### Group 5: Integration Test — Fresh Bootstrap Flow

**Goal:** Verify the complete fresh-instance bootstrap path works end-to-end.

**Deliverables:**
1. Integration test that: creates a user, logs in via CLI, creates a PAT, uses PAT to call `POST /api/companies/:id/agent-hires`, verifies agent creation
2. Update any existing E2E tests that mock auth to also cover PAT path

**Acceptance criteria:**
- Test proves the chicken-and-egg problem is resolved
- All existing tests still pass

**Validation:**
```bash
cd /home/genie/prod/paperclip && pnpm -r typecheck && pnpm test:run && pnpm build
```

**depends-on:** Group 4

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| better-auth session extraction may be complex from CLI | Medium | Inspect `Set-Cookie` response headers directly; better-auth uses standard cookies |
| PAT lookup adds a DB query to every request | Low | Check agent keys first (existing fast path); PAT check only when agent keys miss. Add index on `keyHash`. |
| Storing PAT in context file is plaintext on disk | Medium | Same security model as `ANTHROPIC_API_KEY` in env. Document that context file should be `chmod 600`. Future: OS keychain integration. |
| Migration on running instance | Low | Additive schema change only (new table). No existing tables modified. |
| User must exist before `auth login` | Low | Users are created via UI sign-up or `paperclipai onboard`. Document this as a prerequisite. |
| Key prefix collision | Very Low | `pclip_` prefix + 32 hex chars = 128-bit entropy. Collision astronomically unlikely. |
