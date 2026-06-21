# Go-Live Runbook: model-policy layer + Workers AI routing

Ordered checklist to take PR #8384 (model-policy layer, env deep-merge, Workers AI via OpenCode) to production. The feature is fail-safe: with no policy configured and no Workers AI profile, behavior is identical to today. Nothing activates until step 4.

## 0. Prerequisites (already satisfied)

- ✅ **OpenCode is in the runtime image** — `Dockerfile:59` installs `opencode-ai`, now **pinned to 1.17.8** (the version the Workers AI provider-config schema was verified against). Remote sandboxes install it via the adapter's `SANDBOX_INSTALL_COMMAND`.
- ✅ Policy config is read from the `PAPERCLIP_MODEL_POLICIES` env var (`server/src/services/model-policy-config.ts`).

## 1. Merge PR #8384 (human-gated)

The PR is open from the `adme-dev` fork; a maintainer with write access to `paperclipai/paperclip` must review and merge it with CI green. Review focus: override-precedence (explicit issue override > policy > agent default), the no-policy/no-Workers-AI equivalence, the env deep-merge, and OpenCode provider injection (local + remote).

## 2. Confirm the OpenCode pin survives the build

After merge, the release image must build with `opencode-ai@1.17.8`. If a future bump is wanted, re-run the verification spike (`docs/spikes/workers-ai-opencode-verification.md`) against the new version first — OpenCode's `provider` config schema is the contract that can break Workers AI routing silently.

## 3. Per-company configuration (does NOT activate routing yet)

**a. Cloudflare token → Paperclip secret.** Create a Cloudflare API token with Workers AI access; store it as a secret, e.g. id `cloudflare-workers-ai-token`.

**b. Agent `bulk` profile.** On an `opencode_local` agent, set `runtimeConfig.modelProfiles.bulk.adapterConfig` (see `docs/workers-ai-opencode.md` for the full recipe):

```json
{
  "model": "cloudflare/@cf/openai/gpt-oss-120b",
  "workersAiBaseUrl": "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1",
  "env": {
    "CLOUDFLARE_WORKERS_AI_TOKEN": { "type": "secret_ref", "secretId": "cloudflare-workers-ai-token" }
  }
}
```

> Use a model confirmed in your account's catalog (`wrangler ai models`). `@cf/openai/gpt-oss-120b` is a verified text-generation model. Note gpt-oss is a *reasoning* model — keep `max_tokens` generous or it can return empty `content` (output goes to `reasoning_content`); see the spike doc.

## 4. Activate the policy (the on-switch)

Set `PAPERCLIP_MODEL_POLICIES` on the server (company → rules). This is what makes the policy route tasks:

```json
{
  "<companyId>": [
    { "when": { "workMode": ["bulk"] }, "modelProfile": "bulk", "reason": "bulk -> Workers AI" },
    { "when": {}, "modelProfile": "cheap" }
  ]
}
```

> ⚠️ The value is parsed once at process start and cached (`model-policy-config.ts:40`) — **a change requires a server restart.**

## 5. Deploy

Ship via the existing release/Docker flow (`.github/workflows/release.yml`, `docker.yml`).

## 6. Validate in production (controlled rollout)

1. Run **one real `bulk` task** through the configured `opencode_local` agent. Confirm the run uses the `@cf/...` model and that cost/billing attribution looks right.
2. If you use **remote/SSH execution**, do the deferred **live remote-SSH run** — this is the one path verified only via mocked SSH so far.
3. Start narrow (one agent, low-priority bulk tasks), watch logs/cost, then widen.

## Known limitations / follow-ups

- **Config is env-var + restart** (coarse). Fine for first rollout; the deferred **DB-backed rules + UI editor** is the operational improvement to schedule once this proves out.
- **Live remote-SSH** not yet exercised against a real sandbox (step 6.2).
- **OpenCode version drift** is contained by the 1.17.8 pin; bumping requires re-verification.

## Rollback

Unset `PAPERCLIP_MODEL_POLICIES` (and restart) → policy layer becomes a no-op and dispatch reverts to prior behavior. The Workers AI provider block only injects when an agent profile explicitly requests a `cloudflare/...` model, so removing the profile (or the policy) fully disables Workers AI routing with no code change.
