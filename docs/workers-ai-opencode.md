# Workers AI + OpenCode Operator Recipe

Route bulk or low-priority tasks to a cheap Cloudflare Workers AI model through the
Paperclip model-policy layer and OpenCode. For the verification spike that validated
this mechanism, see [docs/spikes/workers-ai-opencode-verification.md](./spikes/workers-ai-opencode-verification.md).
Verified against **OpenCode 1.17.8**.

---

## One-time setup

1. **Create a Cloudflare API token** with *Workers AI* access (Account → My Profile →
   API Tokens → Create Token → use the "Workers AI" template or add the
   `account:read` + `AI Gateway:edit` + `Workers AI:read` permissions).

2. **Store the token as a Paperclip secret**, for example:

   ```
   Secret id:    cloudflare-workers-ai-token
   Secret value: <your CF API token>
   ```

3. **Note your Cloudflare account ID** (visible in the Cloudflare dashboard URL or
   under Account Home → right-hand sidebar).

4. **Workers AI endpoint** (replace `<ACCOUNT_ID>` with your value):

   ```
   https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
   ```

   This endpoint is OpenAI-compatible, so OpenCode treats it as a regular
   `openai`-flavoured provider under the hood.

---

## Configure an agent's `bulk` model profile

Add a `bulk` entry to the agent's `runtimeConfig.modelProfiles` in your Paperclip
agent configuration. The agent must be of type `opencode_local`.

```json
{
  "runtimeConfig": {
    "modelProfiles": {
      "bulk": {
        "adapterConfig": {
          "model": "cloudflare/@cf/moonshotai/kimi-k2.7-code",
          "workersAiBaseUrl": "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1",
          "env": {
            "CLOUDFLARE_WORKERS_AI_TOKEN": {
              "type": "secret_ref",
              "secretId": "cloudflare-workers-ai-token"
            }
          }
        }
      }
    }
  }
}
```

**How these fields work:**

- `model` — A provider-prefixed model id (`cloudflare/<model-path>`). The
  `cloudflare/` prefix tells `opencode-local` to build a `provider.cloudflare`
  block in the temporary `opencode.json`. OpenCode then strips the prefix and
  sends the bare `@cf/...` model name to the Cloudflare endpoint.
- `workersAiBaseUrl` — The account-scoped Cloudflare AI endpoint. Written into the
  `provider.cloudflare.options.baseURL` field of the injected opencode.json.
- `env.CLOUDFLARE_WORKERS_AI_TOKEN` — A secret reference. Paperclip resolves the
  secret at runtime, sets it as an environment variable, and `opencode-local` reads
  it to populate `provider.cloudflare.options.apiKey` in the injected config.

The `env` object deep-merges over the agent's base environment, so other variables
(e.g. `ANTHROPIC_API_KEY`) remain available for the agent's non-bulk work.

### Available Workers AI models (catalog)

| Model id | Label |
|---|---|
| `cloudflare/@cf/moonshotai/kimi-k2.7-code` | Kimi K2.7-Code (Workers AI) |
| `cloudflare/@cf/zhipu/glm-5.2` | GLM-5.2 (Workers AI) |
| `cloudflare/@cf/openai/gpt-oss-120b` | GPT-OSS-120B (Workers AI) |

These are exported from `@paperclipai/adapter-opencode-local` in the `models` array.

---

## Assign with a model policy rule

Add a policy entry for your company in `PAPERCLIP_MODEL_POLICIES`. The example
below routes `workMode=bulk` requests to the `bulk` profile and falls back to the
`cheap` profile for everything else:

```json
{
  "<companyId>": [
    {
      "when": { "workMode": ["bulk"] },
      "modelProfile": "bulk",
      "reason": "bulk -> Workers AI"
    },
    {
      "when": {},
      "modelProfile": "cheap"
    }
  ]
}
```

---

## How it works / verification

**Mechanism:**

1. A Paperclip run with `workMode=bulk` matches the first policy rule and selects
   the `bulk` model profile.
2. The profile's `adapterConfig` is merged over the agent's base config at runtime.
3. `opencode-local` detects that `model` starts with `cloudflare/` and
   `workersAiBaseUrl` is set, then injects a temporary `provider.cloudflare` block
   into the runtime `opencode.json` before launching OpenCode.
4. OpenCode routes the run through its Cloudflare provider at the given endpoint.

**Verification status:**

✅ **Verified end-to-end against the real Cloudflare Workers AI endpoint** (2026-06-21,
OpenCode 1.17.8). With a live token + account endpoint, OpenCode (`-m cloudflare/@cf/openai/gpt-oss-120b`)
returned a real completion from Cloudflare; the direct OpenAI-compatible endpoint also returned
`HTTP 200` with valid output. See the spike doc linked above (§ Real-token verification) for
evidence. The model catalog entries (`cloudflare/@cf/...`) and the
`WORKERS_AI_OPENAI_BASE_URL_TEMPLATE` constant are covered by unit tests in
`packages/adapters/opencode-local/src/server/workers-ai-models.test.ts`.

> **Note:** Remote/SSH execution targets are supported for `opencode_local`. The
> runtime `opencode.json` carrying the `provider.cloudflare` block is staged in a
> temp `XDG_CONFIG_HOME` and synced to the remote box's `XDG_CONFIG_HOME` as the
> `xdgConfig` runtime asset, so the Workers AI provider routing applies to remote
> runs just as it does locally. This path is verified via the mocked-SSH
> integration test in
> `packages/adapters/opencode-local/src/server/execute.remote.test.ts` (which
> asserts the synced config contains the provider block with the correct
> `baseURL`/`apiKey`/model). A true live remote-SSH run against a real sandbox was
> **not** exercised as part of this change.
