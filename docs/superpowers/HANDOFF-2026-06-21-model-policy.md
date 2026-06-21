# Handoff: Model-Policy Layer + Workers AI (2026-06-21)

Resume doc for the per-task model-selection feature. Everything below is on branch
`feat/model-policy-layer`, surfaced in **PR #8384** (https://github.com/paperclipai/paperclip/pull/8384).

## TL;DR — where we are

A full per-task model-selection system is **built, verified, and in an open PR**. Two
follow-ups remain: a small go-live config step (human-gated) and a DB/UI editor (planned,
not yet built). The next concrete action is to **execute the backend plan**
`docs/superpowers/plans/2026-06-21-model-policies-db-backend.md` via the subagent loop,
then write + build the UI plan.

## What's done (shipped to PR #8384, all tests green)

1. **Model-policy layer** — per-company, signal-driven selection of a model profile per task
   (`server/src/services/model-policy.ts` rule engine; `model-policy-config.ts` env source;
   wired into dispatch at `heartbeat.ts` ~7202). Precedence: explicit per-issue override >
   policy > agent default. Fail-safe: no policy configured ⇒ identical to prior behavior.
2. **Env deep-merge** — a model profile can add `env` keys without wiping the agent's other
   env (`heartbeat.ts` `deepMergeAdapterEnv` + `mergeModelProfileAdapterConfig`).
3. **Workers AI routing via OpenCode** — `opencode-local` injects a `provider.cloudflare`
   block into the generated `opencode.json` (`runtime-config.ts` `buildWorkersAiProvider`);
   model ids `cloudflare/@cf/...`; catalog + `WORKERS_AI_OPENAI_BASE_URL_TEMPLATE` in the
   adapter `index.ts`. Works **local and remote** (remote ships the temp config as the
   `xdgConfig` asset).
4. **OpenCode pinned to 1.17.8** in `Dockerfile:59` (the version the provider-config schema
   was verified against).

## Verification status (what's proven vs not)

- ✅ **Real-token Cloudflare smoke test PASSED** end-to-end (direct endpoint + through
   OpenCode; `@cf/openai/gpt-oss-120b` returned `SMOKE_OK`). Account `a5b299b3…` via the
   existing wrangler OAuth session. Evidence: `docs/spikes/workers-ai-opencode-verification.md`.
- ✅ **Remote execution** verified via mocked-SSH integration test
   (`packages/adapters/opencode-local/src/server/execute.remote.test.ts`).
- ❌ **Live remote-SSH run** against a real sandbox — NOT done (no remote target available).
- 🧠 **Key lesson:** `cursor-agent` does NOT honor `OPENAI_BASE_URL` (Cursor-login auth, no
   endpoint surface) — a cursor attempt was built then reverted. OpenCode is the viable adapter.
   Don't wire an external CLI without proving it honors the routing knob first.

## Repo / PR mechanics (important)

- **No upstream write access.** Neither authenticated GitHub account (`adme-dev`, `Paul008`)
   can push to `paperclipai/paperclip`. The PR is from a **fork** (`adme-dev/paperclip`); the
   local `fork` git remote points at it. Update the PR with `git push fork feat/model-policy-layer`.
- **Merging PR #8384 requires a maintainer** with write access — cannot be self-merged here.
- Branch `feat/model-policy-layer` holds the whole feature (commits `89fe043`→`f8e600f`).

## Go-live (when PR merges) — see `docs/workers-ai-go-live.md`

Merge → confirm OpenCode pin → per-company config (CF token secret `cloudflare-workers-ai-token`
+ agent `bulk` profile + set `PAPERCLIP_MODEL_POLICIES` env, **server restart required**) →
deploy → prod smoke test (incl. the deferred live remote-SSH run). Rollback = unset the env var.

## What's LEFT to build: DB/UI editor (replaces env-var-+-restart config)

Split into two plans (backend first — the UI consumes its API):

### Plan A — Backend (WRITTEN & READY)
`docs/superpowers/plans/2026-06-21-model-policies-db-backend.md` — 5 TDD tasks:
1. `company_model_policies` DB table (one row/company, `rules` jsonb) + migration.
2. Reusable Zod `modelPolicyRulesSchema`.
3. `companyModelPolicyService(db)` — cached `getCompanyPolicy` (TTL + write-invalidation) with
   **env-var fallback**; `setCompanyPolicy` (upsert + invalidate).
4. CRUD routes (GET/PUT) mirroring `server/src/routes/company-skills.ts`.
5. Dispatch integration: `heartbeat.ts` ~7202 switches sync env read → `await
   companyModelPolicyService(db).getCompanyPolicy(...)` (call site already async; use a
   shared/module-level service instance so the cache persists).

Grounded facts already verified for Plan A:
- Best end-to-end template to mirror: **company_skills** (schema → service → routes → UI).
- Dispatch call site is **already async** (no blocker).
- **No real test DB needed:** route tests mock services via `vi.hoisted` (see
   `server/src/__tests__/agent-skills-routes.test.ts:1-45`); the service test mocks the
   Drizzle `db` query chain. Plan's test steps already updated to reflect this.
- Schema barrel: `packages/db/src/schema/index.ts`. Migrations via `pnpm db:generate` →
   `packages/db/src/migrations/`. Route registration: `server/src/app.ts` (next to
   `companySkillRoutes(db)`).

### Plan B — UI editor (NOT yet written)
A company-settings page to list/add/edit/delete/reorder rules. Mirror `ui/src/pages/
CompanySkills.tsx` (React + TanStack Router + React Query). Touch: `ui/src/api/modelPolicies.ts`,
`ui/src/pages/CompanyModelPolicies.tsx`, route in `ui/src/App.tsx` (`boardRoutes()`), nav in
`ui/src/components/CompanySettingsSidebar.tsx`. **Use the `design-guide` + `frontend-design`
skills.** Write this plan only after Plan A's API exists.

## How to resume (next session)

1. `git checkout feat/model-policy-layer` (or branch a new `feat/model-policies-db` off it).
2. Execute Plan A via **superpowers:subagent-driven-development**: fresh subagent per task,
   spec + quality review between each, continuous. The established loop in this project:
   create a branch off `feat/model-policy-layer`, run tasks, final whole-branch review, then
   merge into `feat/model-policy-layer` and `git push fork` to update PR #8384.
3. After Plan A is in, write Plan B (UI) with **writing-plans**, then run its loop (use
   `design-guide`/`frontend-design` for the page).
4. Keep the env-var fallback working; a company with a DB row ignores the env var.

## Verify current state quickly

```
git checkout feat/model-policy-layer
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/model-policy.test.ts src/__tests__/model-policy-config.test.ts \
  src/__tests__/heartbeat-model-profile.test.ts
npx vitest run packages/adapters/opencode-local/src/server/runtime-config.test.ts \
  packages/adapters/opencode-local/src/server/execute.remote.test.ts \
  packages/adapters/opencode-local/src/server/workers-ai-models.test.ts
pnpm typecheck
```
All should pass (model-policy + opencode adapter suites), typecheck clean.

## Key files

- Rule engine: `server/src/services/model-policy.ts`
- Env config source (becomes fallback): `server/src/services/model-policy-config.ts`
- Dispatch wiring + deep-merge: `server/src/services/heartbeat.ts` (~1199, ~7202)
- OpenCode provider injection: `packages/adapters/opencode-local/src/server/runtime-config.ts`
- OpenCode catalog: `packages/adapters/opencode-local/src/index.ts`
- Docs: `docs/workers-ai-opencode.md` (recipe), `docs/workers-ai-go-live.md` (runbook),
   `docs/spikes/workers-ai-opencode-verification.md` (real-token + mechanism evidence)
- Plans: `docs/superpowers/plans/2026-06-20-model-policy-layer.md`,
   `2026-06-21-workers-ai-opencode.md`, `2026-06-21-model-policies-db-backend.md` (Plan A)
