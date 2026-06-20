# Workers AI via OpenCode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model-policy layer route a task to a Cloudflare Workers AI model through the **OpenCode** CLI, by injecting a custom OpenAI-compatible provider (Workers AI endpoint + token) into the `opencode.json` that `opencode-local` already generates, and selecting it via a per-agent model profile.

**Architecture:** Supersedes the reverted `cursor-local` attempt. The prior live test proved `cursor-agent` ignores `OPENAI_BASE_URL` (Cursor-login auth, Cursor model catalog, no endpoint surface). **OpenCode is config-driven, not env-driven:** `opencode-local` writes a runtime `opencode.json` and points the CLI at it via `XDG_CONFIG_HOME` (`packages/adapters/opencode-local/src/server/runtime-config.ts:61-99`), and OpenCode requires `provider/model` ids (`.../server/models.ts:30`). So Workers AI routing means **adding a custom `cloudflare` provider block** (with `baseURL` = the Workers AI OpenAI-compatible endpoint and an API key) to that generated config, and using model ids like `cloudflare/@cf/moonshotai/kimi-k2.7-code`. Per-company credentials still live in the agent's runtime profile (built on the merged `env` deep-merge from PR #8384) — not adapter source.

**The hard dependency:** OpenCode's exact custom-provider config schema is OpenCode-version-specific and is **not verifiable from this repo**. Task 1 is a gating spike that pins the exact `opencode.json` provider shape and proves OpenCode actually routes to the custom `baseURL` **before** any Paperclip code is written. This is the explicit lesson from the cursor failure: do not wire an external CLI on the assumption it honors a routing knob — prove it first.

**Tech Stack:** TypeScript (ESM/NodeNext), pnpm workspaces, Vitest. Packages: `@paperclipai/opencode-local`. Depends on PR #8384's env deep-merge being present (this plan branches off `feat/model-policy-layer`).

**Out of scope (later):** dynamic Workers AI model discovery; UI editor; AI Gateway fronting; cost-aware signals; non-OpenCode adapters.

---

## File Structure

- `packages/adapters/opencode-local/src/server/runtime-config.ts` (modify) — extend the generated `opencode.json` (`nextConfig`, lines 84-91) with a custom provider block when the agent config requests Workers AI.
- `packages/adapters/opencode-local/src/index.ts` (modify) — Workers AI endpoint constant + curated `cloudflare/@cf/...` model ids in `models[]`.
- `packages/adapters/opencode-local/src/server/runtime-config.test.ts` (modify) — assert the provider block is injected into the written config.
- `docs/workers-ai-opencode.md` (create) — operator recipe (per-agent profile + policy rule) using OpenCode.
- `docs/spikes/workers-ai-opencode-verification.md` (create in Task 1) — the spike's findings, including the exact verified provider JSON.

---

### Task 1: Spike — prove OpenCode routes to a custom OpenAI-compatible provider (GATING)

**No Paperclip code.** Produce a written, reproducible findings doc. **Everything downstream depends on this passing.**

- [ ] **Step 1: Install/locate the OpenCode CLI**

In an environment where you can install it: `which opencode || npm i -g opencode-ai` (or the project's documented install). Record `opencode --version`. If OpenCode cannot be installed/run in your environment, STOP and report — this plan cannot be verified or safely implemented here, exactly as the cursor attempt should have been stopped.

- [ ] **Step 2: Stand up a local mock OpenAI-compatible endpoint**

Reuse this hermetic mock (logs any request, returns a minimal chat completion). Save as `/tmp/mock_openai.py` and run `python3 /tmp/mock_openai.py &`:

```python
import http.server, json, datetime
LOG="/tmp/mock_requests.log"
class H(http.server.BaseHTTPRequestHandler):
    def _log(self):
        body=self.rfile.read(int(self.headers.get('Content-Length',0) or 0))
        open(LOG,"a").write(f"{datetime.datetime.now().isoformat()} {self.command} {self.path} auth={self.headers.get('Authorization')} body={body[:300]!r}\n")
    def do_POST(self):
        self._log()
        out=json.dumps({"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}).encode()
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(out)
    def do_GET(self):
        self._log(); self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b'{"data":[{"id":"@cf/test"}]}')
    def log_message(self,*a): pass
http.server.HTTPServer(("127.0.0.1",8765),H).serve_forever()
```

- [ ] **Step 3: Write an `opencode.json` defining a custom `cloudflare` provider and run OpenCode against the mock**

Create a temp `XDG_CONFIG_HOME` with `opencode/opencode.json`. Use OpenCode's current custom-provider schema (consult `opencode` docs / `opencode --help` / the OpenCode repo for the exact keys — likely a top-level `provider` map whose entry carries `options.baseURL`, an api key, and a `models` map). Point `baseURL` at `http://127.0.0.1:8765/v1`. Then run a one-shot prompt with `--model cloudflare/@cf/test` (or the shape OpenCode expects) and a closed stdin and a hard timeout (`perl -e '$t=shift;alarm $t;exec @ARGV' 30 ...`, since macOS lacks `timeout`).

- [ ] **Step 4: Determine the verdict from the mock log**

- If `/tmp/mock_requests.log` shows a POST to the mock → **PASS**: OpenCode honors the custom provider `baseURL`. Record the EXACT `opencode.json` provider JSON that worked, the exact `--model` id shape, and how the API key is supplied (config field vs env).
- If zero requests reach the mock → **STOP**: OpenCode does not route to the custom provider with this config; capture the error and the config tried, and escalate — the Paperclip wiring below would not work, same failure mode as cursor.

- [ ] **Step 5: Record findings**

Create `docs/spikes/workers-ai-opencode-verification.md` with: OpenCode version, the verified provider JSON (verbatim), the model-id shape, the api-key mechanism, the mock-log evidence, and the PASS/STOP verdict. This verified provider JSON is the input to Task 2.

**Acceptance:** A reproduced request reaching the mock endpoint via a custom provider, with the exact working config captured. No PASS → do not proceed to Tasks 2–3.

---

### Task 2: Inject the Workers AI provider into the generated `opencode.json`

**Precondition:** Task 1 verdict is PASS, with the verified provider JSON recorded. Use that exact shape below where it says `<VERIFIED_PROVIDER_BLOCK>`.

**Files:**
- Modify: `packages/adapters/opencode-local/src/server/runtime-config.ts` (the `nextConfig` build at lines 84-91)
- Test: `packages/adapters/opencode-local/src/server/runtime-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add a case to `runtime-config.test.ts` asserting that when the prepared input carries a Workers AI request (base URL + token + provider name), the written `opencode.json` contains the custom provider with the correct `baseURL`. Model the new input field on however `prepareOpenCodeRuntimeConfig` currently receives config (read the existing test at lines 24-51 for the established harness — it writes a config, calls the prep fn, and re-reads the file). The assertion: parse the written `opencode.json` and expect `config.provider.cloudflare.options.baseURL` (or the verified key path from Task 1) to equal the supplied endpoint, and the model map to include the supplied `@cf/...` model.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/adapters/opencode-local/src/server/runtime-config.test.ts`
Expected: FAIL — no provider injection exists yet.

- [ ] **Step 3: Implement the provider injection**

In `runtime-config.ts`, thread a `workersAi?: { baseUrl: string; apiKey: string; models: string[] }` value from the adapter config into this helper (read how `prepareOpenCodeRuntimeConfig` is called from `execute.ts` to wire the input). Then extend `nextConfig` (currently lines 84-90) to add the provider block built from the Task-1-verified shape, e.g.:

```typescript
  const nextConfig = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
    ...(input.workersAi
      ? {
          provider: {
            ...(isPlainObject(existingConfig.provider) ? existingConfig.provider : {}),
            // <VERIFIED_PROVIDER_BLOCK> — exact shape from docs/spikes/workers-ai-opencode-verification.md
            cloudflare: {
              /* options.baseURL = input.workersAi.baseUrl, api key, models map from input.workersAi.models */
            },
          },
        }
      : {}),
  };
```

Replace `<VERIFIED_PROVIDER_BLOCK>` with the literal structure Task 1 proved. Do NOT guess the schema — if Task 1's doc is missing the exact shape, return to Task 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/adapters/opencode-local/src/server/runtime-config.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + existing opencode tests**

Run: `pnpm typecheck`
Run: `npx vitest run packages/adapters/opencode-local/src/server/runtime-config.test.ts packages/adapters/opencode-local/src/server/models.test.ts`
Expected: PASS (existing behavior unchanged when `workersAi` is absent).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/opencode-local/src/server/runtime-config.ts packages/adapters/opencode-local/src/server/runtime-config.test.ts docs/spikes/workers-ai-opencode-verification.md
git commit -m "feat(models): inject Workers AI provider into OpenCode runtime config"
```

---

### Task 3: Workers AI model catalog on opencode-local + operator recipe

**Files:**
- Modify: `packages/adapters/opencode-local/src/index.ts` (the `models` array, ~56-62)
- Create: `docs/workers-ai-opencode.md`
- Test: `packages/adapters/opencode-local/src/server/workers-ai-models.test.ts` (match the package's `src/server/*.test.ts` convention)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { models, WORKERS_AI_OPENAI_BASE_URL_TEMPLATE } from "../index.js";

describe("opencode-local Workers AI catalog", () => {
  it("exposes the Workers AI base URL template with an account placeholder", () => {
    expect(WORKERS_AI_OPENAI_BASE_URL_TEMPLATE).toBe(
      "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1",
    );
  });
  it("includes provider-prefixed Workers AI models", () => {
    expect(models.some((m) => m.id === "cloudflare/@cf/moonshotai/kimi-k2.7-code")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/adapters/opencode-local/src/server/workers-ai-models.test.ts`
Expected: FAIL — constant not exported, no `cloudflare/@cf/...` models.

- [ ] **Step 3: Implement**

In `packages/adapters/opencode-local/src/index.ts` add:

```typescript
/** Cloudflare Workers AI OpenAI-compatible base URL; substitute the account id
 * for {ACCOUNT_ID}. Configured as the `cloudflare` provider's baseURL. */
export const WORKERS_AI_OPENAI_BASE_URL_TEMPLATE =
  "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1";
```

Append to the existing `models` array (OpenCode needs `provider/model`, so prefix with `cloudflare/`):

```typescript
  { id: "cloudflare/@cf/moonshotai/kimi-k2.7-code", label: "Kimi K2.7-Code (Workers AI)" },
  { id: "cloudflare/@cf/zhipu/glm-5.2", label: "GLM-5.2 (Workers AI)" },
  { id: "cloudflare/@cf/openai/gpt-oss-120b", label: "GPT-OSS-120B (Workers AI)" },
```

Match the existing array element type. Use the exact provider-prefix + model shape Task 1 verified (if Task 1 found a different prefix than `cloudflare/`, use that).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/adapters/opencode-local/src/server/workers-ai-models.test.ts`
Expected: PASS

- [ ] **Step 5: Write the operator recipe**

Create `docs/workers-ai-opencode.md`: one-time CF token secret + account id; configure an agent's runtime `bulk` profile on an `opencode_local` agent with `adapterConfig` setting the `cloudflare/@cf/...` model and the `env`/config that Task 1 proved drives the provider (base URL + token); a `PAPERCLIP_MODEL_POLICIES` rule routing `bulk` work to that profile; and a "Verified against OpenCode vX" note linking `docs/spikes/workers-ai-opencode-verification.md`. Mirror the structure of the (reverted) cursor doc but with the OpenCode-verified mechanism.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` (expect PASS)

```bash
git add packages/adapters/opencode-local/src/index.ts packages/adapters/opencode-local/src/server/workers-ai-models.test.ts docs/workers-ai-opencode.md
git commit -m "feat(models): add Workers AI model catalog (opencode) + verified operator recipe"
```

---

## Self-Review

**Spec coverage:**
- Prove OpenCode honors a custom provider `baseURL` before any code → Task 1 (gating, with STOP). ✅
- Inject the Workers AI provider into the generated `opencode.json` → Task 2. ✅
- Surface `cloudflare/@cf/...` models + operator recipe → Task 3. ✅
- Policy assignment reuses the merged policy layer + env deep-merge — no new dispatch code.
- Out of scope stated (dynamic discovery, UI, AI Gateway, cost signals, other adapters).

**Placeholder scan:** The `<VERIFIED_PROVIDER_BLOCK>` in Task 2 is an explicit, named dependency on Task 1's output (the exact OpenCode provider schema, which is genuinely unknowable from this repo) — not a lazy placeholder. Every other step has concrete code/commands. The plan deliberately blocks Task 2 on Task 1 producing that shape.

**Type consistency:** `WORKERS_AI_OPENAI_BASE_URL_TEMPLATE` and `models` are referenced identically in adapter source and test. The `workersAi` input field name is used consistently in Task 2's helper and `nextConfig`. `isPlainObject`/`existingConfig` are existing helpers in `runtime-config.ts`.

**Risk note:** The load-bearing unknown is OpenCode's provider-config schema and whether it honors a custom `baseURL` — retired by Task 1 before any production code, with an explicit STOP. This is the same risk the cursor attempt failed to retire; here it gates the plan.
