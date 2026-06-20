# Spike: Workers AI via OpenCode — verification findings

**Date:** 2026-06-21
**OpenCode version:** 1.17.8 (installed via `npm i -g opencode-ai`)
**Verdict:** ✅ PASS — OpenCode honors a custom OpenAI-compatible provider `baseURL` and routes inference there.

## Method

1. Local mock OpenAI-compatible endpoint on `http://127.0.0.1:8765/v1` logging every request (`POST /v1/chat/completions`, `GET /v1/models`).
2. Wrote `$XDG_CONFIG_HOME/opencode/opencode.json` defining a custom `cloudflare` provider pointing at the mock (see Verified config below).
3. `opencode models cloudflare` → listed `cloudflare/@cf/test` (provider recognized).
4. `opencode run -m "cloudflare/@cf/test" "Reply with the single word OK"` (headless, stdin closed, perl-alarm timeout).

## Evidence

The mock received real chat-completion traffic from OpenCode:

```
POST /v1/chat/completions  auth=Bearer sk-localtest  body={"model":"@cf/test","max_tokens":32000,"messages":[{"role":"system","content":"You are a title generator..."}]}
POST /v1/chat/completions  auth=Bearer sk-localtest  body={"model":"@cf/test","max_tokens":32000,"messages":[{"role":"system","content":"You are opencode, an interactive CLI tool..."}]}
```

Key facts confirmed:
- **OpenCode routes to the custom `baseURL`** (vs. cursor-agent, which sent zero requests and demanded Cursor login).
- **The model id sent to the endpoint is the bare `@cf/test`** — OpenCode strips the `cloudflare/` provider prefix, so the endpoint receives exactly Cloudflare's expected `@cf/...` id.
- **Auth is `Authorization: Bearer <options.apiKey>`** — supply the Cloudflare API token as `options.apiKey`.
- Custom-provider package is `@ai-sdk/openai-compatible` (OpenCode auto-installs it).

## Verified config (the exact shape Task 2 must inject)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cloudflare": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cloudflare Workers AI",
      "options": {
        "baseURL": "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1",
        "apiKey": "<CLOUDFLARE_API_TOKEN>"
      },
      "models": {
        "@cf/moonshotai/kimi-k2.7-code": { "name": "Kimi K2.7-Code (Workers AI)" }
      }
    }
  }
}
```

- **Model selection in Paperclip:** `adapterConfig.model = "cloudflare/@cf/moonshotai/kimi-k2.7-code"` (OpenCode `provider/model` format).
- **Provider block** merges alongside the existing `permission` block in `runtime-config.ts`'s `nextConfig` (lines 84-91); only the `provider.cloudflare` entry is added.
- **Credentials per company:** `baseURL` (account-scoped) and `apiKey` (CF token) come from the agent's runtime profile config, resolved via Paperclip secrets — not adapter source.

## Caveats / notes

- Not yet tested against the *real* Cloudflare endpoint with a live token — the mock proves OpenCode's routing/auth/model-id behavior, which was the unknown. A single real-token smoke test is still worthwhile before production.
- The exact `models` map value shape (`{ "name": ... }`) was accepted by OpenCode 1.17.8; pin OpenCode's config version in the recipe doc.

## Conclusion

OpenCode is a viable adapter for Workers AI routing. The OpenCode follow-up plan (`docs/superpowers/plans/2026-06-21-workers-ai-opencode.md`) Task 1 gate is satisfied; Tasks 2–3 are unblocked, using the verified config above.
